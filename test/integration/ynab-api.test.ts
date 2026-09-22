// Runs only when YNAB_ACCESS_TOKEN is set. Read-only: it never writes to the budget.
// Costs four API requests per run against the 200/hour limit (budget list, full, delta, 401 check).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BudgetDb, type SyncedBudget } from "../../src/cache/db.js";
import { BudgetStore } from "../../src/cache/store.js";
import { isKnownCadence } from "../../src/tools/list-categories.js";
import { FREQUENCIES } from "../../src/tools/list-scheduled.js";
import { YnabApiError, YnabClient } from "../../src/ynab/client.js";

const token = process.env.YNAB_ACCESS_TOKEN;
const budgetId = process.env.YNAB_BUDGET_ID?.trim() || null;

describe("YNAB API (live)", { skip: token ? false : "YNAB_ACCESS_TOKEN not set" }, () => {
  it("full sync, then a delta sync that returns the same or newer knowledge", async () => {
    const db = new BudgetDb(":memory:");
    try {
      const client = new YnabClient(token!);
      const store = new BudgetStore({ client, db, configuredBudgetId: budgetId, ttlMs: 0 });

      const budget = await store.ensureFresh();
      assert.equal(store.lastSync?.kind, "full");
      assert.ok(budget.name.length > 0);
      assert.ok(budget.serverKnowledge > 0);
      const summary = db.summary(budget.id);
      assert.ok(summary.accounts > 0, "a real budget has at least one account");
      assert.ok(db.budgetRows().some((b) => b.id === budget.id), "the budget list includes the synced budget");

      const lines = db.transactionLines(budget.id, { limit: 50 });
      for (const line of lines) {
        assert.match(line.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.notEqual(line.accountName, "(unknown account)", "every transaction's account is in the cache");
        if (line.parentId !== null) assert.notEqual(line.parentId, line.id, "a split line points at its parent, not itself");
      }
      if (summary.splitLines > 0) assert.ok(summary.splitParents > 0, "split lines have their parents cached");

      const delta = await store.sync();
      assert.equal(delta.kind, "delta");
      assert.ok(db.budgetRow(budget.id)!.serverKnowledge! >= budget.serverKnowledge);

      assertOrientation(db, budget);
      assertSpending(db, budget);
    } finally {
      db.close();
    }
  });

  it("maps an invalid token to a YnabApiError with status 401", async () => {
    await assert.rejects(
      () => new YnabClient("not-a-real-token").listBudgets(),
      (error: unknown) => error instanceof YnabApiError && error.status === 401,
    );
  });
});

/**
 * What the orientation tools read, checked against a real budget on the sync the test above has
 * already paid for. This catches the class of thing hand-built fixtures cannot: how YNAB actually
 * sets the internal and hidden flags, and whether a real month's rows still add up.
 */
function assertOrientation(db: BudgetDb, budget: SyncedBudget): void {
  const groups = db.categoryTree(budget.id, { includeHidden: true });
  const categories = groups.flatMap((group) => group.categories);
  assert.ok(categories.length > 0, "a real budget has categories");
  for (const name of ["Inflow: Ready to Assign", "Uncategorized"]) {
    assert.ok(!categories.some((c) => c.name === name), `${name} is YNAB's plumbing, not a budget line`);
  }
  assert.ok(
    groups.every((g) => g.name.length > 0 && g.name !== "(unknown group)" && g.categories.length > 0),
    "every category resolves to a named group, and no group comes back empty",
  );
  // Every goal period the real budget uses has words, so no target reaches Claude without its period.
  for (const c of categories) {
    assert.ok(isKnownCadence(c.goalCadence), `${c.name}: goal cadence ${c.goalCadence} has words`);
  }

  const accounts = db.accountRows(budget.id, { includeClosed: true }).accounts;
  assert.ok(accounts.length > 0, "a real budget has accounts");
  if (accounts.some((a) => a.type === "creditCard" && !a.closed)) {
    // YNAB marks the Credit Card Payments group internal while its categories are not; filtering
    // on the group's flag instead of the category's own would hide every one of them.
    const payments = groups.find((g) => /credit card/i.test(g.name));
    assert.ok(payments, "a budget with a credit card has a Credit Card Payments group");
    assert.ok(payments.categories.length > 0, "and its categories survive the internal filter");
  }

  const now = new Date();
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const detail = db.monthDetail(budget.id, current) ?? db.monthDetail(budget.id, budget.lastMonth!);
  assert.ok(detail, "the current month is cached");

  const subtotals = new Map<string, { budgeted: number; activity: number }>();
  for (const row of detail.categories) {
    assert.ok(row.groupName.length > 0 && row.groupName !== "(unknown group)", `${row.name} resolves to a group`);
    const group = subtotals.get(row.groupName) ?? { budgeted: 0, activity: 0 };
    subtotals.set(row.groupName, { budgeted: group.budgeted + row.budgeted, activity: group.activity + row.activity });
  }
  const summed = [...subtotals.values()].reduce((a, g) => ({ budgeted: a.budgeted + g.budgeted, activity: a.activity + g.activity }), {
    budgeted: 0,
    activity: 0,
  });
  assert.equal(summed.budgeted, detail.budgeted, "group subtotals add up to the month's assigned");
  assert.equal(summed.activity, detail.activity, "and to the month's activity");
}

/**
 * The spending rule, checked against YNAB's own arithmetic on a real budget: what the spending
 * queries add up per category and month must be exactly the `activity` YNAB reports for that
 * category and month, every line must land in exactly one bucket (spending, transfer, tracking or
 * inflow), and every real name must resolve back to its own id. The synthetic fixture proves the
 * rule on each edge case; this proves it on the cases the fixture did not think of.
 */
function assertSpending(db: BudgetDb, budget: SyncedBudget): void {
  const months = cachedMonths(db, budget.id);
  assert.ok(months.length > 0, "a real budget has cached months");
  const [readyToAssignId] = db.resolveEntities(budget.id, { categories: ["Inflow: Ready to Assign"] }).categoryIds!;
  const onBudget = db.accountRows(budget.id, { includeClosed: true }).accounts.filter((a) => a.onBudget).map((a) => a.id);

  for (const month of months) {
    const range = { from: `${month}-01`, to: `${month}-31` };

    // Per category: the lines add up to what YNAB says the category did. Credit card payment
    // categories are the one exception by construction: YNAB computes their activity as card
    // spending moved in minus payments out, which no transaction line carries.
    const byCategory = new Map<string, number>();
    let uncategorizedSpending = 0; // YNAB carries these in its own internal row, checked below.
    for (const line of db.spendingLines(budget.id, range)) {
      if (line.categoryId === null) uncategorizedSpending += line.amount;
      else byCategory.set(line.categoryId, (byCategory.get(line.categoryId) ?? 0) + line.amount);
    }
    for (const row of db.monthCategoryRange(budget.id, [month])) {
      if (row.creditCardPayment) {
        byCategory.delete(row.categoryId);
        continue;
      }
      assert.equal(byCategory.get(row.categoryId) ?? 0, row.activity, `${month} ${row.name}: spending lines vs YNAB activity`);
      byCategory.delete(row.categoryId);
    }
    assert.deepEqual([...byCategory.keys()], [], `${month}: spending in categories the month does not report`);

    // The aggregates agree with the lines, and with each other.
    const total = db.spendingTotal(budget.id, range);
    for (const groupBy of ["category", "category_group", "payee", "account", "month"] as const) {
      const rows = db.spendingBy(budget.id, groupBy, range);
      assert.equal(sum(rows.map((r) => r.spent)), total.spent, `${month} by ${groupBy}: rows sum to the total`);
      assert.equal(sum(rows.map((r) => r.count)), total.count, `${month} by ${groupBy}: counts sum to the total`);
    }

    // Every flattened line is exactly one of: spending, transfer, tracking, inflow.
    const excluded = db.spendingExclusions(budget.id, range);
    const all = db.searchTotal(budget.id, range).count;
    assert.equal(total.count + excluded.transfers + excluded.tracking + excluded.inflows, all, `${month}: every line lands in one bucket`);

    // The lines the search calls uncategorized are the ones YNAB posts to its own internal
    // Uncategorized category, so their sum is that category's activity for the month — and so is
    // the spending report's Uncategorized bucket, or the report comes in under YNAB's.
    const uncategorized = db.searchTotal(budget.id, { ...range, uncategorized: true });
    const [uncategorizedId] = db.resolveEntities(budget.id, { categories: ["Uncategorized"] }).categoryIds!;
    const reported = db.monthCategories(budget.id, `${month}-01`).find((row) => row.categoryId === uncategorizedId)?.activity ?? 0;
    assert.equal(uncategorized.sum, reported, `${month}: uncategorized lines vs YNAB's Uncategorized activity`);
    assert.equal(uncategorizedSpending, reported, `${month}: the Uncategorized spending bucket vs YNAB's Uncategorized activity`);

    // The cash flow: its income is Ready to Assign's own activity, its spending is the spending
    // total, and the two together are exactly what the on-budget accounts grew by, since transfers
    // between them cancel out. Its breakdowns add up to the figures they break down.
    const flow = db.cashFlowByMonth(budget.id, range)[0] ?? { income: 0, spent: 0, toTracking: 0 };
    const readyToAssign = db.monthCategories(budget.id, `${month}-01`).find((row) => row.categoryId === readyToAssignId)?.activity ?? 0;
    assert.equal(flow.income, readyToAssign, `${month}: income lines vs Ready to Assign's activity`);
    assert.equal(flow.spent, total.spent, `${month}: the cash flow's spending is the spending total`);
    const grown = db.searchTotal(budget.id, { ...range, accountIds: onBudget }).sum;
    assert.equal(flow.income + flow.spent, grown, `${month}: saved vs what the on-budget accounts grew by`);
    assert.equal(sum(db.incomeBySource(budget.id, range).map((r) => r.amount)), flow.income, `${month}: income sources sum to the income`);
    assert.equal(sum(db.trackingTransfers(budget.id, range).map((r) => r.amount)), flow.toTracking, `${month}: tracking accounts sum to their share`);
  }

  // Every scheduled transaction lands on a cached account with a frequency the tool can rate.
  for (const row of db.scheduledRows(budget.id)) {
    assert.notEqual(row.accountName, "(unknown account)", `scheduled ${row.id} has its account cached`);
    assert.match(row.dateNext, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(row.frequency in FREQUENCIES, `scheduled ${row.id} carries a frequency the tool knows: ${row.frequency}`);
  }

  // Every real name resolves back to its own id, so the tools' name filters reach every entity.
  for (const [kind, rows] of [
    ["categories", db.categoryTree(budget.id, { includeHidden: true }).flatMap((g) => g.categories)],
    ["accounts", db.accountRows(budget.id, { includeClosed: true }).accounts],
  ] as const) {
    for (const row of rows) {
      const ids = db.entityLabels(budget.id, kind, [row.id]);
      assert.equal(ids.get(row.id), row.name, `${kind}: ${row.id} is labelled by its own name`);
      const resolved = db.resolveEntities(budget.id, { [kind]: [row.id] });
      assert.deepEqual(Object.values(resolved)[0], [row.id], `${kind}: ${row.id} resolves to itself`);
    }
  }
}

/** The `YYYY-MM` keys of every month the cache holds for a budget, oldest first. */
function cachedMonths(db: BudgetDb, budgetId: string): string[] {
  const keys: string[] = [];
  const row = db.budgetRow(budgetId)!;
  for (let month = row.firstMonth!.slice(0, 7); month <= row.lastMonth!.slice(0, 7); month = next(month)) {
    if (db.month(budgetId, `${month}-01`)) keys.push(month);
  }
  return keys;
}

function next(month: string): string {
  const [year, m] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, m, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
