// Runs only when YNAB_ACCESS_TOKEN is set. Read-only: it never writes to the budget.
// Costs four API requests per run against the 200/hour limit (budget list, full, delta, 401 check).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BudgetDb, type SyncedBudget } from "../../src/cache/db.js";
import { BudgetStore } from "../../src/cache/store.js";
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
