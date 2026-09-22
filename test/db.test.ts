import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BudgetDb, NameResolutionError, digestSchema, schemaDdl, schemaFingerprint } from "../src/cache/db.js";
import {
  BUDGET_ID,
  budgetDetail,
  category,
  fullBudget,
  month,
  orientationBudget,
  scheduledBudget,
  spendingBudget,
  subtransaction,
  transaction,
} from "./fixtures.js";

const NOW = new Date("2026-09-21T14:00:00Z");
const LATER = new Date("2026-09-21T15:00:00Z");

function synced(): BudgetDb {
  const db = new BudgetDb(":memory:");
  db.applyBudget(BUDGET_ID, fullBudget(), 10, NOW);
  return db;
}

describe("BudgetDb.applyBudget (full payload)", () => {
  it("stores every entity list and the budget row", () => {
    const db = synced();
    const row = db.budgetRow(BUDGET_ID)!;
    assert.equal(row.name, "Household");
    assert.equal(row.currencyFormat?.iso_code, "USD");
    assert.equal(row.serverKnowledge, 10);
    assert.equal(row.lastSyncedAt, NOW.toISOString());
    assert.equal(row.firstMonth, "2024-01-01");
    const summary = db.summary(BUDGET_ID);
    assert.equal(summary.transactions, 3);
    assert.equal(summary.splitLines, 3);
    assert.equal(summary.splitParents, 1);
    assert.equal(summary.months, 1);
    assert.equal(summary.accounts, 2);
    assert.equal(summary.openAccounts, 1);
    assert.equal(summary.payees, 2);
    assert.equal(summary.visibleCategories, 2);
  });

  it("counts every stored entity as upserted", () => {
    const db = new BudgetDb(":memory:");
    // 2 accounts + 2 payees + 1 group + 2 categories + 3 transactions + 3 subtransactions + 1 month
    assert.deepEqual(db.applyBudget(BUDGET_ID, fullBudget(), 10, NOW), { upserted: 14, deleted: 0 });
  });

  it("tolerates a budget with no lists at all", () => {
    const db = new BudgetDb(":memory:");
    db.applyBudget(BUDGET_ID, budgetDetail(), 1, NOW);
    assert.equal(db.summary(BUDGET_ID).transactions, 0);
    assert.equal(db.summary(BUDGET_ID).months, 0);
    assert.deepEqual(db.transactionLines(BUDGET_ID), []);
  });
});

describe("BudgetDb.applyBudget (delta payload)", () => {
  it("upserts changed entities and removes deleted ones", () => {
    const db = synced();
    const stats = db.applyBudget(
      BUDGET_ID,
      budgetDetail({
        transactions: [
          transaction("t3", "2026-08-01", -5_000, { deleted: true }),
          transaction("t1", "2026-09-10", -12_000),
          transaction("t4", "2026-09-20", -7_000),
        ],
        subtransactions: [subtransaction("s1", "t2", 0, { deleted: true })],
      }),
      11,
      LATER,
    );

    assert.deepEqual(stats, { upserted: 2, deleted: 2 });
    const row = db.budgetRow(BUDGET_ID)!;
    assert.equal(row.serverKnowledge, 11);
    assert.equal(row.lastSyncedAt, LATER.toISOString());
    const lines = db.transactionLines(BUDGET_ID);
    assert.ok(!lines.some((l) => l.id === "t3"));
    assert.ok(!lines.some((l) => l.id === "s1"));
    assert.equal(lines.find((l) => l.id === "t1")?.amount, -12_000);
    assert.equal(lines.find((l) => l.id === "t4")?.date, "2026-09-20");
  });

  it("does not count deleting an unknown entity", () => {
    const db = synced();
    const stats = db.applyBudget(BUDGET_ID, budgetDetail({ transactions: [transaction("never", "2026-01-01", 0, { deleted: true })] }), 11, NOW);
    assert.deepEqual(stats, { upserted: 0, deleted: 0 });
  });

  it("merges a delta month's categories into the stored month", () => {
    const db = synced();
    db.applyBudget(
      BUDGET_ID,
      budgetDetail({ months: [month("2026-09-01", [category("c1", "Groceries", { budgeted: 120_000 })], { to_be_budgeted: 5_000 })] }),
      11,
      NOW,
    );
    const categories = db.monthCategories(BUDGET_ID, "2026-09-01");
    assert.equal(categories.length, 2, "untouched category survives the merge");
    assert.equal(db.month(BUDGET_ID, "2026-09-01")?.toBeBudgeted, 5_000, "the month's own totals are replaced");
    assert.equal(categories.find((c) => c.categoryId === "c1")?.budgeted, 120_000);
    assert.equal(categories.find((c) => c.categoryId === "c2")?.budgeted, 50_000);
  });

  it("removes a category from a month and removes whole months", () => {
    const db = synced();
    db.applyBudget(BUDGET_ID, budgetDetail({ months: [month("2026-09-01", [category("c2", "Household", { deleted: true })])] }), 11, NOW);
    assert.deepEqual(
      db.monthCategories(BUDGET_ID, "2026-09-01").map((c) => c.categoryId),
      ["c1"],
    );

    const stats = db.applyBudget(BUDGET_ID, budgetDetail({ months: [month("2026-09-01", [], { deleted: true })] }), 12, NOW);
    assert.equal(stats.deleted, 1);
    assert.equal(db.summary(BUDGET_ID).months, 0);
    assert.deepEqual(db.monthCategories(BUDGET_ID, "2026-09-01"), []);
  });

  it("updates budget metadata such as a renamed budget", () => {
    const db = synced();
    db.applyBudget(BUDGET_ID, budgetDetail({ name: "Household 2027", last_month: "2027-01-01" }), 11, NOW);
    const row = db.budgetRow(BUDGET_ID)!;
    assert.equal(row.name, "Household 2027");
    assert.equal(row.lastMonth, "2027-01-01");
  });

  it("rolls back the whole payload when a row cannot be stored", () => {
    const db = synced();
    const bad = budgetDetail({
      transactions: [transaction("t9", "2026-09-21", -1), { ...transaction("t10", "2026-09-21", -1), date: null as unknown as string }],
    });
    assert.throws(() => db.applyBudget(BUDGET_ID, bad, 11, LATER), /NOT NULL/);
    assert.equal(db.budgetRow(BUDGET_ID)?.serverKnowledge, 10, "knowledge is unchanged");
    assert.equal(db.budgetRow(BUDGET_ID)?.lastSyncedAt, NOW.toISOString());
    assert.ok(!db.transactionLines(BUDGET_ID).some((l) => l.id === "t9"), "the good row from the same payload is gone too");
    // The database is usable afterwards.
    assert.deepEqual(db.applyBudget(BUDGET_ID, budgetDetail(), 11, LATER), { upserted: 0, deleted: 0 });
  });
});

describe("BudgetDb with several budgets", () => {
  it("keeps separate rows and knowledge per budget", () => {
    const db = synced();
    db.applyBudget("budget-2", budgetDetail({ id: "budget-2", name: "Business", transactions: [transaction("b1", "2026-09-01", -1)] }), 3, LATER);
    assert.equal(db.summary(BUDGET_ID).transactions, 3);
    assert.equal(db.summary("budget-2").transactions, 1);
    assert.equal(db.budgetRow(BUDGET_ID)?.serverKnowledge, 10);
    assert.equal(db.budgetRow("budget-2")?.serverKnowledge, 3);
    assert.deepEqual(
      db.budgetRows().map((b) => b.name),
      ["Business", "Household"],
    );
  });

  it("a replacing apply swaps one budget's rows for the new copy and leaves the other budget alone", () => {
    const db = synced();
    db.applyBudget("budget-2", budgetDetail({ id: "budget-2", name: "Business", transactions: [transaction("b1", "2026-09-01", -1)] }), 3, LATER);
    db.applyBudget(BUDGET_ID, budgetDetail({ transactions: [transaction("t9", "2026-09-20", -1)] }), 20, LATER, { replace: true });
    const replaced = db.budgetRow(BUDGET_ID)!;
    assert.equal(replaced.name, "Household");
    assert.equal(replaced.serverKnowledge, 20);
    assert.equal(replaced.lastSyncedAt, LATER.toISOString());
    assert.equal(db.summary(BUDGET_ID).transactions, 1, "only what the new copy holds");
    assert.equal(db.summary(BUDGET_ID).months, 0);
    assert.deepEqual(db.monthCategories(BUDGET_ID, "2026-09-01"), []);
    assert.equal(db.summary("budget-2").transactions, 1);
    assert.equal(db.budgetRow("budget-2")?.serverKnowledge, 3);
  });

  it("a replacing apply that fails keeps the copy it was replacing", () => {
    const db = synced();
    // A payload that breaks part-way through the write: after the old rows are deleted, before commit.
    const broken = budgetDetail({ transactions: [{ ...transaction("t9", "2026-09-20", -1), date: null as unknown as string }] });
    assert.throws(() => db.applyBudget(BUDGET_ID, broken, 20, LATER, { replace: true }), /NOT NULL/);
    assert.equal(db.summary(BUDGET_ID).transactions, 3, "the old rows are back");
    assert.equal(db.budgetRow(BUDGET_ID)?.serverKnowledge, 10);
  });

  it("upsertBudgetList records the default flag and preserves synced fields", () => {
    const db = synced();
    db.upsertBudgetList(
      [
        { id: BUDGET_ID, name: "Household (renamed)" },
        { id: "budget-2", name: "Business", first_month: "2025-01-01" },
      ],
      "budget-2",
      LATER,
    );
    const household = db.budgetRow(BUDGET_ID)!;
    assert.equal(household.name, "Household (renamed)");
    assert.equal(household.isDefault, false);
    assert.equal(household.serverKnowledge, 10, "listing never touches knowledge");
    assert.equal(household.lastSyncedAt, NOW.toISOString());
    const business = db.budgetRow("budget-2")!;
    assert.equal(business.isDefault, true);
    assert.equal(business.firstMonth, "2025-01-01");
    assert.equal(business.serverKnowledge, null);

    db.upsertBudgetList([{ id: BUDGET_ID, name: "Household" }], BUDGET_ID, LATER);
    assert.equal(db.budgetRow(BUDGET_ID)?.isDefault, true);
    assert.equal(db.budgetRow("budget-2")?.isDefault, false, "a budget that left the list loses the default flag");
    assert.equal(db.budgetRow("budget-2")?.name, "Business", "but its row is kept");
  });

  it("remembers the active budget id", () => {
    const db = new BudgetDb(":memory:");
    assert.equal(db.activeBudgetId(), null);
    db.setActiveBudgetId(BUDGET_ID);
    assert.equal(db.activeBudgetId(), BUDGET_ID);
  });
});

describe("BudgetDb.transactionLines", () => {
  const lines = synced().transactionLines(BUDGET_ID);

  it("emits one line per plain transaction and one per split line", () => {
    assert.equal(lines.length, 5);
    assert.ok(!lines.some((l) => l.id === "t2"), "the split parent itself is not a line");
  });

  it("sorts newest first", () => {
    assert.deepEqual(
      lines.map((l) => l.date),
      ["2026-09-12", "2026-09-12", "2026-09-12", "2026-09-10", "2026-08-01"],
    );
  });

  it("resolves account, payee, and category names", () => {
    const rent = lines.find((l) => l.id === "t3")!;
    assert.equal(rent.accountName, "Checking");
    assert.equal(rent.payeeName, "Landlord");
    assert.equal(rent.categoryName, "Groceries");
    assert.equal(rent.categoryGroupName, "Everyday");
    assert.equal(rent.parentId, null);
    assert.equal(rent.cleared, "cleared");
    assert.equal(rent.approved, true);
  });

  it("split lines inherit payee and memo from the parent unless set on the line", () => {
    const paper = lines.find((l) => l.id === "s1")!;
    const other = lines.find((l) => l.id === "s2")!;
    assert.equal(paper.parentId, "t2");
    assert.equal(paper.amount, -20_000);
    assert.equal(paper.payeeName, "Costco");
    assert.equal(paper.memo, "paper towels");
    assert.equal(paper.categoryName, "Household");
    assert.equal(other.memo, "big shop", "falls back to the parent memo");
    assert.equal(other.categoryName, "Groceries");
    assert.equal(paper.transferAccountId, null, "a plain split line has no transfer account");
  });

  it("split lines keep their own payee and transfer account over the parent's", () => {
    const leg = lines.find((l) => l.id === "s3")!;
    assert.equal(leg.payeeId, "p2");
    assert.equal(leg.payeeName, "Landlord");
    assert.equal(leg.transferAccountId, "a2");
  });

  it("falls back to the category's own group name when the group is not cached", () => {
    const db = new BudgetDb(":memory:");
    db.applyBudget(
      BUDGET_ID,
      budgetDetail({
        categories: [category("c9", "Orphan", { category_group_id: "missing", category_group_name: "From category" })],
        transactions: [transaction("x", "2026-01-01", -1, { category_id: "c9" })],
      }),
      1,
      NOW,
    );
    const [line] = db.transactionLines(BUDGET_ID);
    assert.equal(line.categoryGroupName, "From category");
  });

  it("handles missing lookups without throwing", () => {
    const db = new BudgetDb(":memory:");
    db.applyBudget(
      BUDGET_ID,
      budgetDetail({ transactions: [transaction("x", "2026-01-01", -1, { account_id: "gone", payee_id: "gone", category_id: "gone" })] }),
      1,
      NOW,
    );
    const [line] = db.transactionLines(BUDGET_ID);
    assert.equal(line.accountName, "(unknown account)");
    assert.equal(line.payeeName, null);
    assert.equal(line.categoryName, null);
  });

  it("filters by date range, account, category, payee and limit", () => {
    const db = synced();
    assert.deepEqual(
      db.transactionLines(BUDGET_ID, { from: "2026-09-01", to: "2026-09-10" }).map((l) => l.id),
      ["t1"],
    );
    assert.deepEqual(
      db.transactionLines(BUDGET_ID, { from: "2026-09-10" }).map((l) => l.id),
      ["s1", "s2", "s3", "t1"],
      "from is inclusive",
    );
    assert.deepEqual(db.transactionLines(BUDGET_ID, { to: "2026-08-01" }).map((l) => l.id), ["t3"], "to is inclusive");
    assert.equal(db.transactionLines(BUDGET_ID, { categoryId: "c1" }).length, 3);
    assert.equal(db.transactionLines(BUDGET_ID, { payeeId: "p2" }).length, 2);
    assert.equal(db.transactionLines(BUDGET_ID, { accountId: "a1" }).length, 5);
    assert.deepEqual(db.transactionLines(BUDGET_ID, { limit: 2 }).map((l) => l.id), ["s1", "s2"], "limit keeps the newest lines");
    assert.deepEqual(db.transactionLines(BUDGET_ID, { limit: 0 }), []);
    assert.deepEqual(db.transactionLines(BUDGET_ID, { limit: -5 }), [], "a negative limit is clamped, not 'no limit'");
    assert.equal(db.transactionLines(BUDGET_ID, { limit: 2.9, from: "2026-09-12" }).length, 2);
    assert.equal(db.transactionLines("budget-2").length, 0, "another budget's lines are not returned");
  });

  it("stores each month's totals", () => {
    const db = new BudgetDb(":memory:");
    db.applyBudget(
      BUDGET_ID,
      budgetDetail({
        months: [
          month("2026-09-01", [], { income: 1_000, budgeted: 2_000, activity: -3_000, to_be_budgeted: 4_000, age_of_money: 12, note: "September" }),
          month("2026-08-01", [], { income: 10, budgeted: 20, activity: -30, to_be_budgeted: 40 }),
        ],
      }),
      1,
      NOW,
    );
    assert.deepEqual(db.month(BUDGET_ID, "2026-09-01"), {
      month: "2026-09-01",
      income: 1_000,
      budgeted: 2_000,
      activity: -3_000,
      toBeBudgeted: 4_000,
      ageOfMoney: 12,
      note: "September",
    });
    assert.equal(db.month(BUDGET_ID, "2026-08-01")?.ageOfMoney, null, "age of money is optional");
    assert.equal(db.month(BUDGET_ID, "2026-08-01")?.note, null, "so is the month note");
    assert.equal(db.month(BUDGET_ID, "2026-07-01"), null);
    assert.equal(db.month("budget-2", "2026-09-01"), null);
  });
});

describe("BudgetDb.summary date range", () => {
  it("returns the earliest and latest transaction dates", () => {
    const summary = synced().summary(BUDGET_ID);
    assert.equal(summary.earliest, "2026-08-01");
    assert.equal(summary.latest, "2026-09-12");
  });

  it("returns null dates with no transactions", () => {
    const db = new BudgetDb(":memory:");
    db.applyBudget(BUDGET_ID, budgetDetail(), 1, NOW);
    assert.equal(db.summary(BUDGET_ID).earliest, null);
    assert.equal(db.summary(BUDGET_ID).latest, null);
  });
});

function oriented(): BudgetDb {
  const db = new BudgetDb(":memory:");
  db.applyBudget(BUDGET_ID, orientationBudget(), 10, NOW);
  return db;
}

describe("BudgetDb.categoryTree", () => {
  it("stores the fields these tools report as real columns, not as raw JSON", () => {
    const [food] = oriented().categoryTree(BUDGET_ID).filter((g) => g.name === "🥘 Food");
    assert.deepEqual(food.categories.find((c) => c.name === "Groceries"), {
      id: "c1",
      name: "Groceries",
      note: "costco run monthly",
      goalType: "MF",
      goalTarget: 800_000,
      goalTargetDate: null,
      goalSnoozedAt: null,
      goalCadence: null,
      goalCadenceFrequency: null,
      goalNeedsWholeAmount: null,
      hidden: false,
    });
    assert.equal(food.categories.find((c) => c.name === "Café")?.goalSnoozedAt, "2026-09-01T00:00:00+00:00");
  });

  it("filters on the category's own internal flag, never the group's", () => {
    const groups = oriented().categoryTree(BUDGET_ID);
    assert.ok(!groups.some((g) => g.name === "Internal Master Category"));
    assert.deepEqual(
      groups.find((g) => g.name === "Credit Card Payments")?.categories.map((c) => c.name),
      ["Visa"],
      "the group is internal; its categories are not",
    );
  });

  it("treats a hidden group's members as hidden", () => {
    const withHidden = oriented().categoryTree(BUDGET_ID, { includeHidden: true });
    const retired = withHidden.find((g) => g.name === "Hidden Stuff")!.categories[0];
    assert.equal(retired.hidden, true, "its own flag is false, but its group is hidden");
    assert.ok(!oriented().categoryTree(BUDGET_ID).some((g) => g.name === "Hidden Stuff"));
  });

  it("falls back to the category's own group name when the group is not cached", () => {
    const db = new BudgetDb(":memory:");
    db.applyBudget(
      BUDGET_ID,
      budgetDetail({ categories: [category("c9", "Orphan", { category_group_id: "missing", category_group_name: "From category" })] }),
      1,
      NOW,
    );
    assert.deepEqual(db.categoryTree(BUDGET_ID).map((g) => g.name), ["From category"]);
  });
});

describe("BudgetDb.accountRows", () => {
  it("returns the balance detail as columns, ordered by type then name", () => {
    const listing = oriented().accountRows(BUDGET_ID);
    assert.deepEqual(listing.accounts.map((a) => a.name), ["Chequing", "Visa", "Mortgage"]);
    assert.equal(listing.closedOmitted, 1);
    assert.deepEqual(listing.accounts[0], {
      id: "a1",
      name: "Chequing",
      type: "checking",
      onBudget: true,
      closed: false,
      balance: 1_234_560,
      clearedBalance: 1_200_000,
      unclearedBalance: 34_560,
      lastReconciledAt: "2026-09-01T12:00:00+00:00",
      note: "joint",
    });
  });

  it("includes closed accounts on request and then omits none", () => {
    const listing = oriented().accountRows(BUDGET_ID, { includeClosed: true });
    assert.deepEqual(listing.accounts.map((a) => a.name), ["Chequing", "Visa", "Mortgage", "Old savings"], "by type: checking, creditCard, mortgage, savings");
    assert.equal(listing.closedOmitted, 0);
  });
});

describe("BudgetDb.monthDetail", () => {
  it("joins each month category to its name and group, ordered by group then category", () => {
    const detail = oriented().monthDetail(BUDGET_ID, "2026-09-01")!;
    assert.equal(detail.note, "tight month");
    assert.equal(detail.ageOfMoney, 108);
    assert.deepEqual(
      detail.categories.map((c) => [c.groupName, c.name]),
      [
        ["Credit Card Payments", "Visa"],
        ["🥘 Food", "Café"],
        ["🥘 Food", "Groceries"],
        ["🥘 Food", "Old hobby"],
        ["Hidden Stuff", "Retired thing"],
        ["🏠 Housing", "Rent"],
      ],
    );
    const groceries = detail.categories.find((c) => c.name === "Groceries")!;
    assert.equal(groceries.goalUnderFunded, 12_500);
    assert.equal(detail.categories.find((c) => c.name === "Old hobby")?.hidden, true);
  });

  it("leaves internal categories out so the rows still add up to the month's totals", () => {
    const detail = oriented().monthDetail(BUDGET_ID, "2026-09-01")!;
    assert.ok(!detail.categories.some((c) => c.name === "Inflow: Ready to Assign"));
    assert.equal(detail.categories.reduce((sum, c) => sum + c.budgeted, 0), detail.budgeted);
    assert.equal(detail.categories.reduce((sum, c) => sum + c.activity, 0), detail.activity);
  });

  it("is null for a month that is not cached", () => {
    assert.equal(oriented().monthDetail(BUDGET_ID, "2025-05-01"), null);
  });

  it("keeps a month row whose category has since been deleted, so the rows still add up", () => {
    const db = oriented();
    const before = db.monthDetail(BUDGET_ID, "2026-09-01")!;
    // A delta drops the category row but leaves the figures it already has in cached months.
    db.applyBudget(BUDGET_ID, budgetDetail({ categories: [category("c1", "Groceries", { deleted: true })] }), 11, LATER);

    const after = db.monthDetail(BUDGET_ID, "2026-09-01")!;
    assert.equal(after.categories.length, before.categories.length, "an inner join would have swallowed the orphan");
    assert.equal(
      after.categories.reduce((sum, c) => sum + c.activity, 0),
      after.activity,
      "the rows must still reconcile with the month header, which still counts them",
    );
    const orphan = after.categories.find((c) => c.categoryId === "c1")!;
    assert.equal(orphan.name, "(deleted category)", "named rather than dropped");
    assert.equal(orphan.activity, before.categories.find((c) => c.categoryId === "c1")!.activity);
  });
});

describe("the cache schema", () => {
  it("carries the orientation columns", () => {
    const ddl = schemaDdl();
    for (const column of [
      "internal INTEGER NOT NULL",
      "goal_type TEXT",
      "goal_target INTEGER",
      "goal_target_date TEXT",
      "goal_snoozed_at TEXT",
      "goal_cadence INTEGER",
      "goal_cadence_frequency INTEGER",
      "goal_needs_whole_amount INTEGER",
    ]) {
      assert.ok(ddl.includes(column), `categories has ${column}`);
    }
    for (const column of ["cleared_balance INTEGER NOT NULL", "uncleared_balance INTEGER NOT NULL", "last_reconciled_at TEXT"]) {
      assert.ok(ddl.includes(column), `accounts has ${column}`);
    }
    assert.ok(ddl.includes("age_of_money INTEGER, note TEXT"), "months has a note");
    assert.ok(ddl.includes("goal_under_funded INTEGER"), "month_categories has the underfunded amount");
  });

  it("leaves category_groups alone, because the group's internal flag is never read", () => {
    const statement = schemaDdl().split(";").find((part) => part.includes("CREATE TABLE category_groups"))!;
    const columns = statement
      .replace(/REFERENCES [^,]*/, "")
      .replace(/PRIMARY KEY \([^)]*\)/, "")
      .replace(/^[^(]*\(/, "")
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter((name) => /^[a-z_]+$/.test(name));
    assert.deepEqual(columns, ["budget_id", "id", "name", "hidden"]);
  });
});

describe("schemaFingerprint", () => {
  it("changes when any column or index in the generated schema changes", () => {
    const ddl = schemaDdl();
    assert.equal(digestSchema(ddl), schemaFingerprint(), "the build's digest is taken over the generated DDL");

    assert.ok(ddl.includes("cleared TEXT NOT NULL"), "the DDL still spells the column this test mutates");
    assert.notEqual(
      digestSchema(ddl.replace("cleared TEXT NOT NULL", "cleared TEXT")),
      schemaFingerprint(),
      "a changed column changes the digest",
    );

    assert.ok(ddl.includes("CREATE INDEX month_categories_by_category"), "the DDL still spells the index this test mutates");
    assert.notEqual(
      digestSchema(ddl.replace("CREATE INDEX month_categories_by_category", "CREATE INDEX mc_by_category")),
      schemaFingerprint(),
      "a changed index changes the digest",
    );
  });
});

describe("BudgetDb on disk", () => {
  it("persists across reopen and rebuilds when the file does not carry this build's schema", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ynab-mcp-db-"));
    const file = path.join(dir, "nested", "ynab.sqlite");
    try {
      const db = new BudgetDb(file);
      db.applyBudget(BUDGET_ID, fullBudget(), 10, NOW);
      db.setActiveBudgetId(BUDGET_ID);
      db.close();

      const reopened = new BudgetDb(file);
      assert.equal(reopened.budgetRow(BUDGET_ID)?.serverKnowledge, 10);
      assert.equal(reopened.activeBudgetId(), BUDGET_ID);
      assert.equal(reopened.summary(BUDGET_ID).transactions, 3);
      reopened.close();

      const stored = new DatabaseSync(file);
      const fingerprint = stored.prepare("SELECT value FROM meta WHERE key = 'schema_fingerprint'").get();
      assert.equal(fingerprint?.value, schemaFingerprint(), "the file records the schema it was built from");
      // Stand in for a build whose DDL differs from this one's.
      stored.exec("UPDATE meta SET value = 'stale' WHERE key = 'schema_fingerprint'");
      stored.close();

      const rebuilt = new BudgetDb(file);
      assert.equal(rebuilt.budgetRow(BUDGET_ID), null, "old data is dropped");
      assert.equal(rebuilt.activeBudgetId(), null);
      rebuilt.applyBudget(BUDGET_ID, fullBudget(), 12, NOW);
      assert.equal(rebuilt.summary(BUDGET_ID).transactions, 3);
      rebuilt.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the file owner-only", { skip: process.platform === "win32" }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ynab-mcp-db-"));
    const file = path.join(dir, "ynab.sqlite");
    try {
      const db = new BudgetDb(file);
      db.applyBudget(BUDGET_ID, fullBudget(), 10, NOW);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(`${file}-wal`)).mode & 0o777, 0o600, "the WAL holds recent pages too");
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("discards a file that is not a database instead of failing to open", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ynab-mcp-db-"));
    const file = path.join(dir, "ynab.sqlite");
    try {
      await writeFile(file, "this is not a SQLite file; a half-written or foreign cache must not wedge startup");
      const db = new BudgetDb(file);
      assert.equal(db.discardedCorruptFile, true);
      db.applyBudget(BUDGET_ID, fullBudget(), 10, NOW);
      assert.equal(db.summary(BUDGET_ID).transactions, 3);
      db.close();

      const reopened = new BudgetDb(file);
      assert.equal(reopened.discardedCorruptFile, false, "a good file is never discarded");
      assert.equal(reopened.summary(BUDGET_ID).transactions, 3);
      reopened.close();
      assert.match((await readFile(file)).subarray(0, 15).toString(), /^SQLite format 3/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("BudgetDb.raw", () => {
  it("returns every entity as YNAB sent it, including fields that are not columns", () => {
    const db = new BudgetDb(":memory:");
    const payload = fullBudget();
    payload.transactions![0] = { ...payload.transactions![0], import_id: "YNAB:-10000:2026-09-10:1" };
    payload.months![0] = { ...payload.months![0], note: "September" };
    db.applyBudget(BUDGET_ID, payload, 10, NOW);

    assert.equal(db.raw<{ import_id?: string }>(BUDGET_ID, "transactions", "t1")?.import_id, "YNAB:-10000:2026-09-10:1");
    assert.equal(db.raw<{ name: string }>(BUDGET_ID, "accounts", "a2")?.name, "Old savings");
    const month = db.raw<{ note?: string; categories?: unknown }>(BUDGET_ID, "months", "2026-09-01")!;
    assert.equal(month.note, "September");
    assert.equal(month.categories, undefined, "the month's categories live in their own rows");
    assert.equal(db.raw<{ budgeted: number }>(BUDGET_ID, "month_categories", "2026-09-01/c1")?.budgeted, 100_000);
    assert.equal(db.raw(BUDGET_ID, "transactions", "missing"), null);
    assert.equal(db.raw("budget-2", "transactions", "t1"), null);
  });

  it("follows deletes, month removal and replacement", () => {
    const db = synced();
    db.applyBudget(
      BUDGET_ID,
      budgetDetail({
        transactions: [transaction("t1", "2026-09-10", 0, { deleted: true })],
        months: [month("2026-09-01", [category("c2", "Household", { deleted: true })])],
      }),
      11,
      NOW,
    );
    assert.equal(db.raw(BUDGET_ID, "transactions", "t1"), null);
    assert.equal(db.raw(BUDGET_ID, "month_categories", "2026-09-01/c2"), null);
    assert.ok(db.raw(BUDGET_ID, "month_categories", "2026-09-01/c1"), "the untouched category keeps its JSON");

    db.applyBudget(BUDGET_ID, budgetDetail({ months: [month("2026-09-01", [], { deleted: true })] }), 12, NOW);
    assert.equal(db.raw(BUDGET_ID, "months", "2026-09-01"), null);
    assert.equal(db.raw(BUDGET_ID, "month_categories", "2026-09-01/c1"), null, "a removed month takes its category JSON with it");

    assert.ok(db.raw(BUDGET_ID, "payees", "p1"));
    db.applyBudget(BUDGET_ID, budgetDetail(), 13, NOW, { replace: true });
    assert.equal(db.raw(BUDGET_ID, "payees", "p1"), null);
  });
});

// ---- the spending rule ------------------------------------------------------------------------

/** The `spendingBudget()` fixture, synced. Its hand-computed totals are in the fixture's comment. */
function spending(): BudgetDb {
  const db = new BudgetDb(":memory:");
  db.applyBudget(BUDGET_ID, spendingBudget(), 10, NOW);
  return db;
}

const ALL = { from: "2026-07-01", to: "2026-09-30" };
const JULY = { from: "2026-07-01", to: "2026-07-31" };

describe("BudgetDb.spendingLines", () => {
  const ids = (db: BudgetDb, filter = {}) =>
    db
      .spendingLines(BUDGET_ID, filter)
      .map((l) => l.id)
      .sort();

  it("is every flattened line on an on-budget account that carries a category or none at all", () => {
    assert.deepEqual(
      ids(spending()),
      ["s1", "s2", "s3", "t11", "t12", "t2", "t20", "t21", "t22", "t23", "t29", "t40", "t41", "t42", "t44", "t6", "t7", "t8"].sort(),
    );
  });

  it("drops a transfer between two budget accounts and keeps a categorized transfer to tracking", () => {
    const lines = spending().spendingLines(BUDGET_ID);
    for (const id of ["t4", "t5", "t25", "t26", "t46", "t47"]) {
      assert.ok(!lines.some((l) => l.id === id), `${id} is a budget-to-budget transfer`);
    }
    const mortgage = lines.find((l) => l.id === "t2")!;
    assert.equal(mortgage.categoryName, "Mortgage");
    assert.equal(mortgage.transferAccountId, "a3");
  });

  it("never returns a line on a tracking account", () => {
    const lines = spending().spendingLines(BUDGET_ID);
    for (const id of ["t3", "t9", "t24", "t27", "t43"]) assert.ok(!lines.some((l) => l.id === id), `${id} is on a tracking account`);
  });

  it("never returns a line in an internal category", () => {
    const lines = spending().spendingLines(BUDGET_ID);
    for (const id of ["t10", "t28", "t45"]) assert.ok(!lines.some((l) => l.id === id), `${id} is an inflow`);
  });

  it("keeps a refund as a positive line in its own category", () => {
    const refund = spending()
      .spendingLines(BUDGET_ID)
      .find((l) => l.id === "s3")!;
    assert.equal(refund.amount, 10_000);
    assert.equal(refund.categoryId, "c1");
    assert.equal(refund.categoryName, "Groceries");
  });

  it("names the uncategorized and the dangling-category buckets", () => {
    const lines = spending().spendingLines(BUDGET_ID);
    const uncategorized = lines.find((l) => l.id === "t6")!;
    assert.equal(uncategorized.categoryId, null);
    assert.equal(uncategorized.categoryName, "Uncategorized");
    assert.equal(uncategorized.categoryGroupName, "Uncategorized");
    const dangling = lines.find((l) => l.id === "t8")!;
    assert.equal(dangling.categoryId, "c-gone");
    assert.equal(dangling.categoryName, "(deleted category)");
    assert.equal(dangling.categoryGroupName, "(unknown group)");
  });

  it("includes a line in a hidden category", () => {
    const hidden = spending()
      .spendingLines(BUDGET_ID)
      .find((l) => l.id === "t7")!;
    assert.equal(hidden.categoryName, "Old hobby");
    assert.equal(hidden.amount, -15_000);
  });

  it("ORs the values inside one filter list and ANDs the lists", () => {
    const db = spending();
    assert.deepEqual(ids(db, { ...JULY, categoryIds: ["c1", "c2"] }), ["s1", "s2", "s3"]);
    assert.deepEqual(ids(db, { ...ALL, categoryIds: ["c1"], accountIds: ["a2"] }), ["t21"]);
    assert.deepEqual(ids(db, { ...ALL, groupIds: ["g2"] }), ["t2", "t23", "t42"]);
    assert.deepEqual(ids(db, { ...JULY, payeeIds: ["p1"] }), ["s1", "s2", "s3"], "split lines inherit the parent's payee");
    assert.deepEqual(ids(db, { from: "2026-08-01", to: "2026-08-31", accountIds: ["a2"] }), ["t21"]);
  });
});

describe("BudgetDb.spendingBy", () => {
  const db = spending();

  it("groups by category, most spent first, with the group, the hidden flag and null-keyed buckets", () => {
    assert.deepEqual(
      db.spendingBy(BUDGET_ID, "category", ALL),
      [
        { key: "c4", name: "Mortgage", groupName: "Housing", hidden: false, count: 3, spent: -450_000, months: 3 },
        { key: "c1", name: "Groceries", groupName: "Everyday", hidden: false, count: 5, spent: -265_000, months: 3 },
        { key: "c2", name: "Household", groupName: "Everyday", hidden: false, count: 3, spent: -100_000, months: 3 },
        { key: "c3", name: "Dining Out", groupName: "Everyday", hidden: false, count: 4, spent: -64_000, months: 3 },
        { key: null, name: "Uncategorized", groupName: "Uncategorized", hidden: false, count: 1, spent: -25_000, months: 1 },
        { key: "c8", name: "Old hobby", groupName: "Everyday", hidden: true, count: 1, spent: -15_000, months: 1 },
        { key: null, name: "(deleted category)", groupName: "(unknown group)", hidden: false, count: 1, spent: -5_000, months: 1 },
      ],
    );
  });

  it("groups by category group", () => {
    assert.deepEqual(db.spendingBy(BUDGET_ID, "category_group", ALL), [
      { key: "g2", name: "Housing", count: 3, spent: -450_000, months: 3 },
      { key: "g1", name: "Everyday", count: 13, spent: -444_000, months: 3 },
      { key: null, name: "Uncategorized", count: 1, spent: -25_000, months: 1 },
      { key: null, name: "(unknown group)", count: 1, spent: -5_000, months: 1 },
    ]);
  });

  it("groups by payee, with a bucket for lines that have none", () => {
    assert.deepEqual(db.spendingBy(BUDGET_ID, "payee", ALL), [
      { key: "pt3", name: "Transfer : Mortgage", count: 3, spent: -450_000, months: 3 },
      { key: "p1", name: "Costco", count: 5, spent: -250_000, months: 3 },
      { key: "p9", name: "Hardware Depot", count: 2, spent: -70_000, months: 2 },
      { key: "p8", name: "Farm Market", count: 1, spent: -45_000, months: 1 },
      { key: "p2", name: "Café Luna", count: 2, spent: -38_000, months: 2 },
      { key: "p3", name: "Corner Diner", count: 2, spent: -26_000, months: 2 },
      { key: "p6", name: "Corner Store", count: 1, spent: -25_000, months: 1 },
      { key: "p7", name: "Hobby Shop", count: 1, spent: -15_000, months: 1 },
      { key: null, name: "(no payee)", count: 1, spent: -5_000, months: 1 },
    ]);
  });

  it("groups by account", () => {
    assert.deepEqual(db.spendingBy(BUDGET_ID, "account", ALL), [
      { key: "a1", name: "Chequing", count: 14, spent: -838_000, months: 3 },
      { key: "a2", name: "Visa", count: 4, spent: -86_000, months: 3 },
    ]);
  });

  it("groups by month, chronologically", () => {
    assert.deepEqual(db.spendingBy(BUDGET_ID, "month", ALL), [
      { key: "2026-07", name: "2026-07", count: 9, spent: -307_000, months: 1 },
      { key: "2026-08", name: "2026-08", count: 5, spent: -333_000, months: 1 },
      { key: "2026-09", name: "2026-09", count: 4, spent: -284_000, months: 1 },
    ]);
  });

  it("applies the same filters as spendingLines", () => {
    assert.deepEqual(db.spendingBy(BUDGET_ID, "category", { ...JULY, categoryIds: ["c1"] }), [
      { key: "c1", name: "Groceries", groupName: "Everyday", hidden: false, count: 2, spent: -50_000, months: 1 },
    ]);
  });
});

describe("BudgetDb.spendingTotal and spendingExclusions", () => {
  const db = spending();

  it("totals the spending lines over the range", () => {
    assert.deepEqual(db.spendingTotal(BUDGET_ID, ALL), { count: 18, spent: -924_000 });
    assert.deepEqual(db.spendingTotal(BUDGET_ID, JULY), { count: 9, spent: -307_000 });
    assert.deepEqual(db.spendingTotal(BUDGET_ID, { ...ALL, groupIds: ["g2"] }), { count: 3, spent: -450_000 });
  });

  it("counts each dropped line once, as a transfer, tracking or inflow line", () => {
    assert.deepEqual(db.spendingExclusions(BUDGET_ID, ALL), { transfers: 6, tracking: 5, inflows: 3 });
    assert.deepEqual(db.spendingExclusions(BUDGET_ID, JULY), { transfers: 2, tracking: 2, inflows: 1 });
  });

  it("counts only the dropped lines the same entity filter reaches", () => {
    // Visa's side of each credit card payment is a transfer; the account is on budget, so nothing is tracking.
    assert.deepEqual(db.spendingExclusions(BUDGET_ID, { ...ALL, accountIds: ["a2"] }), { transfers: 3, tracking: 0, inflows: 0 });
    // "Transfer : Chequing" is the payee on the far side of every transfer out of Chequing.
    assert.deepEqual(db.spendingExclusions(BUDGET_ID, { ...ALL, payeeIds: ["pt1"] }), { transfers: 3, tracking: 3, inflows: 0 });
    // A category filter reaches no transfer or tracking line, since those carry no category.
    assert.deepEqual(db.spendingExclusions(BUDGET_ID, { ...ALL, categoryIds: ["c1"] }), { transfers: 0, tracking: 0, inflows: 0 });
  });
});

describe("the spending rule against YNAB's own month figures", () => {
  it("sums to month_categories.activity for every category and month of the fixture", () => {
    const db = spending();
    for (const month of ["2026-07", "2026-08", "2026-09"]) {
      const range = { from: `${month}-01`, to: `${month}-31` };
      const lines = db.spendingLines(BUDGET_ID, range);
      const summed = new Map<string, number>();
      for (const line of lines) {
        if (line.categoryId === null) continue; // YNAB has no month row for the uncategorized bucket.
        summed.set(line.categoryId, (summed.get(line.categoryId) ?? 0) + line.amount);
      }
      // `monthCategoryRange` already leaves the internal categories out, which is exactly what the
      // rule does. Credit card payment categories are excluded by construction: YNAB computes their
      // activity as card spending moved in minus payments out, which no transaction line carries.
      for (const row of db.monthCategoryRange(BUDGET_ID, [month])) {
        if (row.creditCardPayment) {
          summed.delete(row.categoryId);
          continue;
        }
        assert.equal(row.activity, summed.get(row.categoryId) ?? 0, `${month} ${row.name} activity`);
        summed.delete(row.categoryId);
      }
      assert.deepEqual([...summed.keys()], [], `${month} has spending in categories the month does not report`);
    }
  });
});

describe("BudgetDb.scheduledRows", () => {
  it("stores what the tool reports as real columns, joined to names, soonest first", () => {
    const db = new BudgetDb(":memory:");
    db.applyBudget(BUDGET_ID, scheduledBudget(), 10, NOW);
    const rows = db.scheduledRows(BUDGET_ID);
    assert.deepEqual(
      rows.map((r) => r.id),
      ["sch-groceries", "sch-mortgage", "sch-pay", "sch-card", "sch-interest", "sch-once", "sch-insurance"],
    );
    const mortgage = rows.find((r) => r.id === "sch-mortgage")!;
    assert.deepEqual(mortgage, {
      id: "sch-mortgage",
      dateFirst: "2026-10-01",
      dateNext: "2026-10-01",
      frequency: "monthly",
      amount: -150_000,
      accountId: "a1",
      accountName: "Chequing",
      accountOnBudget: true,
      payeeName: "Transfer : Mortgage",
      categoryName: "Mortgage",
      categoryGroupName: "Housing",
      transferAccountId: "a3",
      transferAccountName: "Mortgage",
      transferAccountOnBudget: false,
      memo: null,
      flagColor: null,
      lines: [],
    });
    const interest = rows.find((r) => r.id === "sch-interest")!;
    assert.equal(interest.accountOnBudget, false);
    assert.equal(interest.payeeName, null);
    assert.equal(interest.transferAccountOnBudget, null);
    db.close();
  });

  it("attaches a split's lines to their parent", () => {
    const db = new BudgetDb(":memory:");
    db.applyBudget(BUDGET_ID, scheduledBudget(), 10, NOW);
    const insurance = db.scheduledRows(BUDGET_ID).find((r) => r.id === "sch-insurance")!;
    assert.equal(insurance.categoryName, null);
    assert.deepEqual(
      insurance.lines.map((l) => [l.id, l.amount, l.categoryName, l.memo]),
      [
        ["ss1", -100_000, "Household", "home"],
        ["ss2", -20_000, "Dining Out", null],
      ],
    );
    db.close();
  });
});

describe("BudgetDb.resolveEntities", () => {
  const db = spending();

  it("returns a list only for the kinds it was given, matching an id first", () => {
    assert.deepEqual(db.resolveEntities(BUDGET_ID, { categories: ["c1"] }), { categoryIds: ["c1"] });
    assert.deepEqual(db.resolveEntities(BUDGET_ID, { categories: ["c1", "Household"], accounts: ["Chequing"] }), {
      categoryIds: ["c1", "c2"],
      accountIds: ["a1"],
    });
  });

  it("matches a name exactly, ignoring case, accents and surrounding whitespace", () => {
    assert.deepEqual(db.resolveEntities(BUDGET_ID, { categories: ["  groceries "] }), { categoryIds: ["c1"] });
    assert.deepEqual(db.resolveEntities(BUDGET_ID, { payees: ["cafe luna"] }), { payeeIds: ["p2"] });
    assert.deepEqual(db.resolveEntities(BUDGET_ID, { groups: ["EVERYDAY"] }), { groupIds: ["g1"] });
  });

  it("falls back to a part of a name when exactly one entity contains it", () => {
    assert.deepEqual(db.resolveEntities(BUDGET_ID, { categories: ["Groc"] }), { categoryIds: ["c1"] });
    assert.deepEqual(db.resolveEntities(BUDGET_ID, { payees: ["luna"] }), { payeeIds: ["p2"] });
    assert.deepEqual(db.resolveEntities(BUDGET_ID, { accounts: ["broker"] }), { accountIds: ["a4"] });
  });

  it("prefers a whole name over the names that merely contain it", () => {
    // "Corner" is a part of Corner Diner and both Corner Stores, but "Corner Diner" is exactly one name.
    assert.deepEqual(db.resolveEntities(BUDGET_ID, { payees: ["corner diner"] }), { payeeIds: ["p3"] });
  });

  it("asks back when a part of a name is in more than one entity, naming them", () => {
    assert.throws(
      () => db.resolveEntities(BUDGET_ID, { payees: ["Corner"] }),
      (error: Error) =>
        error instanceof NameResolutionError &&
        error.message ===
          'No payee named "Corner"; 3 payees contain it: Corner Diner (p3), corner store (p10), Corner Store (p6). Use the whole name or the id.',
    );
  });

  it("never matches a name that folds away to nothing", () => {
    assert.throws(() => db.resolveEntities(BUDGET_ID, { payees: ["  "] }), (error: Error) => error.message === 'No payee named "".');
  });

  it("resolves a transfer payee like any other payee", () => {
    assert.deepEqual(db.resolveEntities(BUDGET_ID, { payees: ["Transfer : Mortgage"] }), { payeeIds: ["pt3"] });
  });

  it("names the input when nothing matches", () => {
    assert.throws(
      () => db.resolveEntities(BUDGET_ID, { categories: ["Nope"] }),
      (error: Error) => error instanceof NameResolutionError && error.message === 'No category named "Nope".',
    );
    assert.throws(
      () => db.resolveEntities(BUDGET_ID, { accounts: ["Nope"] }),
      (error: Error) => error.message === 'No account named "Nope".',
    );
  });

  it("lists every candidate when a name matches more than one", () => {
    assert.throws(
      () => db.resolveEntities(BUDGET_ID, { payees: ["Corner Store"] }),
      (error: Error) =>
        error instanceof NameResolutionError &&
        error.message === '"Corner Store" matches several payees: corner store (p10), Corner Store (p6). Use the id.',
    );
  });
});

describe("BudgetDb.entityLabels", () => {
  const db = spending();

  it("gives back the name of each id it was handed, in that order", () => {
    assert.deepEqual([...db.entityLabels(BUDGET_ID, "categories", ["c3", "c1"])], [
      ["c3", "Dining Out"],
      ["c1", "Groceries"],
    ]);
    assert.deepEqual([...db.entityLabels(BUDGET_ID, "groups", ["g2"])], [["g2", "Housing"]]);
  });

  it("names a hidden or internal entity too, which the category tree leaves out", () => {
    assert.deepEqual([...db.entityLabels(BUDGET_ID, "categories", ["c8", "c6"])], [
      ["c8", "Old hobby"],
      ["c6", "Inflow: Ready to Assign"],
    ]);
  });

  it("has no entry for an id no row carries, and asks nothing for an empty list", () => {
    assert.deepEqual([...db.entityLabels(BUDGET_ID, "categories", ["c-gone"])], []);
    assert.deepEqual([...db.entityLabels(BUDGET_ID, "categories", [])], []);
  });
});

describe("BudgetDb.searchLines", () => {
  const db = spending();

  it("reaches every flattened line, spending rule or not", () => {
    // t9 is on a tracking account, t4/t5 are the two sides of a budget-to-budget transfer and t10
    // is an inflow: the spending rule drops all four, and search must still find them.
    assert.deepEqual(
      db.searchLines(BUDGET_ID, JULY).map((l) => l.id).sort(),
      ["s1", "s2", "s3", "t10", "t11", "t12", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"].sort(),
    );
  });

  it("returns the newest line first", () => {
    const dates = db.searchLines(BUDGET_ID, JULY).map((l) => l.date);
    assert.equal(dates[0], "2026-07-28");
    assert.deepEqual(dates, [...dates].sort().reverse());
  });

  it("bounds the absolute amount at both ends, inclusively", () => {
    // 20,000 (t11) and 60,000 (s1, t25, t26) sit exactly on the bounds and are kept.
    assert.deepEqual(
      db.searchLines(BUDGET_ID, { ...ALL, minAmount: 20_000, maxAmount: 60_000 }).map((l) => l.id).sort(),
      ["s1", "s2", "t11", "t21", "t25", "t26", "t27", "t29", "t4", "t44", "t5", "t6"].sort(),
    );
  });

  it("keeps one direction when asked", () => {
    assert.deepEqual(
      db.searchLines(BUDGET_ID, { ...ALL, minAmount: 20_000, maxAmount: 60_000, direction: "inflow" }).map((l) => l.id).sort(),
      ["t26", "t27", "t5"].sort(),
    );
    assert.deepEqual(
      db.searchLines(BUDGET_ID, { ...JULY, direction: "outflow" }).map((l) => l.id).sort(),
      ["s1", "s2", "t11", "t12", "t2", "t4", "t6", "t7", "t8", "t9"].sort(),
    );
  });

  it("matches text against the memo or the payee name, ignoring case", () => {
    // Corner Store paid t6, Corner Diner paid t12 and t41.
    assert.deepEqual(db.searchLines(BUDGET_ID, { ...ALL, text: "CORNER" }).map((l) => l.id).sort(), ["t12", "t41", "t6"].sort());
    assert.deepEqual(db.searchLines(BUDGET_ID, { ...ALL, text: "blender" }).map((l) => l.id), ["s3"]);
  });

  it("takes a LIKE wildcard in the text as a literal character", () => {
    const db = new BudgetDb(":memory:");
    db.applyBudget(
      BUDGET_ID,
      spendingBudget({
        transactions: [
          transaction("w1", "2026-07-02", -1_000, { memo: "50% off" }),
          transaction("w2", "2026-07-03", -2_000, { memo: "50 percent off" }),
          transaction("w3", "2026-07-04", -3_000, { memo: "row a_b" }),
          transaction("w4", "2026-07-05", -4_000, { memo: "row axb" }),
        ],
        subtransactions: [],
      }),
      10,
      NOW,
    );
    assert.deepEqual(db.searchLines(BUDGET_ID, { text: "50%" }).map((l) => l.id), ["w1"]);
    assert.deepEqual(db.searchLines(BUDGET_ID, { text: "a_b" }).map((l) => l.id), ["w3"]);
  });

  it("applies the same id filters as the spending queries", () => {
    assert.deepEqual(db.searchLines(BUDGET_ID, { ...ALL, accountIds: ["a3"] }).map((l) => l.id).sort(), ["t24", "t3", "t43", "t9"].sort());
    assert.deepEqual(db.searchLines(BUDGET_ID, { ...JULY, categoryIds: ["c1"], payeeIds: ["p1"] }).map((l) => l.id).sort(), ["s1", "s3"].sort());
  });
});

describe("BudgetDb.searchTotal", () => {
  const db = spending();

  it("counts and sums every match, signed as YNAB stores it", () => {
    // July by hand: 500,000 in, 400,000 of tracking interest out, and the rest nets to -157,000.
    assert.deepEqual(db.searchTotal(BUDGET_ID, JULY), { count: 14, sum: -57_000 });
    assert.deepEqual(db.searchTotal(BUDGET_ID, ALL), { count: 32, sum: 646_000 });
  });

  it("covers every match even when the lines themselves are limited", () => {
    assert.equal(db.searchLines(BUDGET_ID, { ...JULY, limit: 3 }).length, 3);
    assert.deepEqual(db.searchTotal(BUDGET_ID, { ...JULY, limit: 3 }), { count: 14, sum: -57_000 });
  });
});

describe("BudgetDb.monthCategoryRange", () => {
  const db = spending();
  const rows = db.monthCategoryRange(BUDGET_ID, ["2026-07", "2026-08"]);

  it("returns every non-internal category's figures for each month asked, keyed by YYYY-MM", () => {
    // c6 Inflow: Ready to Assign and c7 Uncategorized are internal; the other eight have rows in both months.
    assert.deepEqual(
      [...new Set(rows.map((r) => r.categoryId))].sort(),
      ["c-gone", "c1", "c2", "c3", "c4", "c5", "c8", "c9"],
    );
    assert.equal(rows.length, 16);
    assert.deepEqual(rows.filter((r) => r.categoryId === "c1").map((r) => r.month), ["2026-07", "2026-08"]);
  });

  it("carries the figures and the names a report needs", () => {
    assert.deepEqual(rows.find((r) => r.categoryId === "c1" && r.month === "2026-07"), {
      month: "2026-07",
      categoryId: "c1",
      name: "Groceries",
      groupName: "Everyday",
      hidden: false,
      creditCardPayment: false,
      budgeted: 40_000,
      activity: -50_000,
      balance: 20_000,
    });
  });

  it("marks the hidden, the credit-card-payment and the deleted categories", () => {
    assert.equal(rows.find((r) => r.categoryId === "c8")!.hidden, true, "c8 is hidden itself");
    assert.equal(rows.find((r) => r.categoryId === "c9")!.hidden, true, "c9 sits in a hidden group");
    const visa = rows.find((r) => r.categoryId === "c5")!;
    assert.equal(visa.groupName, "Credit Card Payments");
    assert.equal(visa.creditCardPayment, true);
    assert.equal(rows.find((r) => r.categoryId === "c1")!.creditCardPayment, false);
    const gone = rows.find((r) => r.categoryId === "c-gone")!;
    assert.equal(gone.name, "(deleted category)");
    assert.equal(gone.groupName, "(unknown group)");
  });

  it("filters by category and by group", () => {
    assert.deepEqual(
      db.monthCategoryRange(BUDGET_ID, ["2026-07", "2026-08"], { categoryIds: ["c3"] }).map((r) => `${r.categoryId} ${r.month}`),
      ["c3 2026-07", "c3 2026-08"],
    );
    assert.deepEqual(
      [...new Set(db.monthCategoryRange(BUDGET_ID, ["2026-07"], { groupIds: ["g1"] }).map((r) => r.categoryId))].sort(),
      ["c1", "c2", "c3", "c8"],
    );
  });

  it("has nothing to say about an empty window", () => {
    assert.deepEqual(db.monthCategoryRange(BUDGET_ID, []), []);
  });
});
