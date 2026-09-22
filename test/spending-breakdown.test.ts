import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUDGET_ID, monthFromNow, spendingBudget, transaction } from "./fixtures.js";
import { harness } from "./mcp.js";

interface Row {
  id?: string;
  name: string;
  group?: string;
  hidden?: boolean;
  spent: number;
  count: number;
  share: number;
}

const rowsOf = (body: Record<string, unknown>): Row[] => body.rows as Row[];
const byName = (body: Record<string, unknown>, name: string): Row => {
  const row = rowsOf(body).find((r) => r.name === name);
  assert.ok(row, `a row named ${name}, got ${rowsOf(body).map((r) => r.name).join(", ")}`);
  return row;
};

const spending = () => harness({ budget: spendingBudget() });

describe("spending_breakdown", () => {
  it("totals a month the way the fixture's arithmetic says, and names its scope", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-08", end: "2026-08" });
    assert.equal(body.start, "2026-08-01");
    assert.equal(body.end, "2026-08-31");
    assert.equal(body.group_by, "category");
    // 2026-08 by hand: Groceries 135,000 + Household 30,000 + Dining Out 18,000 + Mortgage 150,000.
    assert.equal(body.total, 333);
    assert.equal(body.lines, 5);
    assert.match(String(body.scope), /on-budget/);
    assert.match(String(body.scope), /refunds/);
    assert.match(String(body.scope), /transfers/);
  });

  it("equals YNAB's own month figures: the total is minus the month's category activity", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-08", end: "2026-08" });
    // The credit card payment category is left out: its YNAB activity is card spending moved in
    // minus payments out, not spending, and the breakdown never counts it.
    const rows = h.db.monthCategoryRange(BUDGET_ID, ["2026-08"]).filter((c) => !c.creditCardPayment);
    const activity = rows.reduce((sum, c) => sum + c.activity, 0);
    assert.equal(body.total, -activity / 1000);
  });

  it("gives each category row its group, count and share of the total", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-08", end: "2026-08" });
    assert.deepEqual(rowsOf(body), [
      { id: "c4", name: "Mortgage", group: "Housing", spent: 150, count: 1, share: 45 },
      { id: "c1", name: "Groceries", group: "Everyday", spent: 135, count: 2, share: 40.5 },
      { id: "c2", name: "Household", group: "Everyday", spent: 30, count: 1, share: 9 },
      { id: "c3", name: "Dining Out", group: "Everyday", spent: 18, count: 1, share: 5.4 },
    ]);
    assert.ok(!("other" in body), "nothing was cut, so there is no remainder row");
  });

  it("nets a refund against its own category and against the total", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-07", end: "2026-07" });
    // July's split: 60,000 groceries and 30,000 household out, 10,000 groceries back.
    const groceries = byName(body, "Groceries");
    assert.equal(groceries.spent, 50);
    assert.equal(groceries.count, 2, "both groceries split lines are counted, the refund included");
    assert.equal(body.total, 307);
  });

  it("attributes each split line to its own category", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-07-05", end: "2026-07-05" });
    assert.deepEqual(rowsOf(body), [
      { id: "c1", name: "Groceries", group: "Everyday", spent: 50, count: 2, share: 62.5 },
      { id: "c2", name: "Household", group: "Everyday", spent: 30, count: 1, share: 37.5 },
    ]);
  });

  it("keeps uncategorized, deleted and hidden spending visible rather than silently dropping it", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-07", end: "2026-07" });

    const uncategorized = byName(body, "Uncategorized");
    assert.equal(uncategorized.spent, 25);
    assert.ok(!("id" in uncategorized), "no category to carry an id");

    const gone = byName(body, "(deleted category)");
    assert.equal(gone.spent, 5);
    assert.ok(!("id" in gone), "the category row is gone, so there is no id to hand back");

    const hobby = byName(body, "Old hobby");
    assert.equal(hobby.spent, 15);
    assert.equal(hobby.hidden, true);
    assert.equal(byName(body, "Groceries").hidden, undefined, "a visible category says nothing about hiding");
  });

  it("puts uncategorized spending in its own group row when grouping by group", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-07", end: "2026-07", group_by: "category_group" });
    assert.equal(byName(body, "Uncategorized").spent, 25);
    // Everyday: groceries 50,000 + household 30,000 + dining 32,000 + the hidden hobby 15,000.
    assert.equal(byName(body, "Everyday").spent, 127);
    assert.equal(byName(body, "Housing").spent, 150);
  });

  it("groups by payee", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-08", end: "2026-08", group_by: "payee" });
    assert.deepEqual(
      rowsOf(body).map((r) => [r.name, r.spent]),
      [
        ["Transfer : Mortgage", 150],
        ["Costco", 90],
        ["Farm Market", 45],
        ["Hardware Depot", 30],
        ["Café Luna", 18],
      ],
    );
  });

  it("groups by account", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-08", end: "2026-08", group_by: "account" });
    assert.deepEqual(
      rowsOf(body).map((r) => [r.id, r.name, r.spent, r.count]),
      [
        ["a1", "Chequing", 288, 4],
        ["a2", "Visa", 45, 1],
      ],
    );
  });

  it("groups by month chronologically, with a zero row for a month that had nothing", async () => {
    // The budget starts in June here, so June is a month it lived through without spending.
    await using h = await harness({ budget: spendingBudget({ first_month: "2026-06-01" }) });
    const body = await h.json("spending_breakdown", { start: "2026-06", end: "2026-09", group_by: "month" });
    assert.ok(!("history_starts" in body), "the range sits inside the budget's history");
    assert.deepEqual(
      rowsOf(body).map((r) => [r.name, r.spent, r.count]),
      [
        ["2026-06", 0, 0],
        ["2026-07", 307, 9],
        ["2026-08", 333, 5],
        ["2026-09", 284, 4],
      ],
    );
  });

  it("ignores the cap when grouping by month, because a series with holes is a lie", async () => {
    await using h = await harness({ budget: spendingBudget({ first_month: "2026-06-01" }) });
    const body = await h.json("spending_breakdown", { start: "2026-06", end: "2026-09", group_by: "month", limit: 2 });
    assert.equal(rowsOf(body).length, 4);
    assert.ok(!("other" in body));
  });

  it("starts a month series at the budget's first month rather than zero-filling months before it", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-04", end: "2026-08", group_by: "month" });
    assert.equal(body.start, "2026-04-01", "the range asked for is still the range the lines were read over");
    assert.equal(body.history_starts, "2026-07");
    assert.deepEqual(
      rowsOf(body).map((r) => [r.name, r.spent]),
      [
        ["2026-07", 307],
        ["2026-08", 333],
      ],
    );
    assert.equal(body.total, 640);

    const before = await h.json("spending_breakdown", { start: "2026-01", end: "2026-03", group_by: "month" });
    assert.deepEqual(before.rows, [], "a range wholly before the budget has no months to show");
    assert.equal(before.total, 0);
  });

  it("caps the rows and sums the remainder into an `other` row", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-08", end: "2026-08", limit: 2 });
    assert.deepEqual(
      rowsOf(body).map((r) => r.name),
      ["Mortgage", "Groceries"],
    );
    // The two cut rows: Household 30,000 and Dining Out 18,000.
    assert.deepEqual(body.other, { count: 2, spent: 48, share: 14.4 });
    assert.equal(body.total, 333, "the total still covers every line, cut or not");
  });

  it("lets a raised cap bring the whole list back", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-08", end: "2026-08", limit: 100 });
    assert.equal(rowsOf(body).length, 4);
    assert.ok(!("other" in body));
  });

  it("filters by name, ORing inside a parameter", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-08", end: "2026-08", categories: ["Groceries", "dining out"] });
    assert.deepEqual(
      rowsOf(body).map((r) => [r.name, r.spent]),
      [
        ["Groceries", 135],
        ["Dining Out", 18],
      ],
    );
    assert.equal(body.total, 153);
    assert.equal(body.lines, 3);
  });

  it("filters by id, ANDing across parameters", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-08", end: "2026-08", categories: ["c1"], accounts: ["Visa"] });
    assert.deepEqual(
      rowsOf(body).map((r) => [r.name, r.spent, r.count]),
      [["Groceries", 45, 1]],
    );
  });

  it("echoes what each filter resolved to, so a partial name is visible next to the numbers", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-08", end: "2026-08", payees: ["costco"], groups: ["every"] });
    assert.deepEqual(body.filters, { groups: [{ id: "g1", name: "Everyday" }], payees: [{ id: "p1", name: "Costco" }] });
    assert.equal(body.total, 90);
    const plain = await h.json("spending_breakdown", { start: "2026-08", end: "2026-08" });
    assert.ok(!("filters" in plain));
  });

  it("reports an unknown name as a tool error rather than an empty answer", async () => {
    await using h = await spending();
    const { text, isError } = await h.call("spending_breakdown", { categories: ["Grocery"] });
    assert.equal(isError, true);
    assert.equal(text, 'No category named "Grocery".');
  });

  it("lists the candidates when a name matches more than one entity", async () => {
    await using h = await spending();
    const { text, isError } = await h.call("spending_breakdown", { payees: ["Corner Store"] });
    assert.equal(isError, true);
    assert.match(text, /matches several payees/);
    assert.match(text, /Corner Store \(p6\)/);
    assert.match(text, /corner store \(p10\)/);
  });

  it("counts what the rule dropped, so the difference from the register is explainable", async () => {
    await using h = await spending();
    const body = await h.json("spending_breakdown", { start: "2026-08", end: "2026-08" });
    // t24 and t27 are on tracking accounts, t25/t26 are the two sides of a credit card payment,
    // t28 is the paycheque.
    assert.deepEqual(body.excluded, { transfers: 2, tracking: 2, inflows: 1 });
  });

  it("counts a transfer to a tracking account left without a category as Uncategorized, the way the search's chores do", async () => {
    // u1 moves money out of the budget into the brokerage with no category yet; u2 is its tracking side.
    await using h = await harness({
      budget: spendingBudget({
        transactions: [
          ...spendingBudget().transactions!,
          transaction("u1", "2026-08-30", -25_000, { payee_id: "pt4", category_id: null, transfer_account_id: "a4" }),
          transaction("u2", "2026-08-30", 25_000, { account_id: "a4", payee_id: "pt1", category_id: null, transfer_account_id: "a1" }),
        ],
      }),
    });
    const body = await h.json("spending_breakdown", { start: "2026-08", end: "2026-08" });
    assert.equal(byName(body, "Uncategorized").spent, 25);
    assert.equal(body.total, 358, "the fixture's 333 plus u1");
    assert.deepEqual(body.excluded, { transfers: 2, tracking: 3, inflows: 1 }, "u1 is not a budget-to-budget transfer; u2 is tracking");

    const chores = await h.json("search_transactions", { start: "2026-08", end: "2026-08", uncategorized: true });
    assert.equal(byName(body, "Uncategorized").spent, -Number(chores.sum), "the Uncategorized row is exactly the lines waiting for a category");
  });

  it("defaults the range to the current month", async () => {
    const month = monthFromNow(0);
    await using h = await harness({
      budget: spendingBudget({
        transactions: [transaction("tx1", `${month}-01`, -12_000, { payee_id: "p1", category_id: "c1" })],
        subtransactions: [],
      }),
    });
    const body = await h.json("spending_breakdown");
    assert.equal(body.start, `${month}-01`);
    assert.equal(String(body.end).slice(0, 7), month);
    assert.equal(body.total, 12);
    assert.deepEqual(
      rowsOf(body).map((r) => r.name),
      ["Groceries"],
    );
  });

  it("refuses a date it cannot read, naming the forms it takes", async () => {
    await using h = await spending();
    const { text, isError } = await h.call("spending_breakdown", { start: "march" });
    assert.equal(isError, true);
    assert.match(text, /YYYY-MM-DD/);
    assert.match(text, /YYYY-MM/);
  });

  it("refuses a start after the end", async () => {
    await using h = await spending();
    const { text, isError } = await h.call("spending_breakdown", { start: "2026-08-10", end: "2026-08-01" });
    assert.equal(isError, true);
    assert.match(text, /2026-08-10/);
  });

  it("pulls from YNAB once when asked to refresh", async () => {
    await using h = await spending();
    await h.json("spending_breakdown", { start: "2026-08", end: "2026-08" });
    const before = h.source.calls.length;
    await h.json("spending_breakdown", { start: "2026-08", end: "2026-08", refresh: true });
    assert.equal(h.source.calls.length, before + 1);
  });

  it("reports a zero share, not a division by zero, when refunds cancel the spending", async () => {
    await using h = await harness({
      budget: spendingBudget({
        transactions: [
          transaction("tx1", "2026-08-01", -10_000, { payee_id: "p1", category_id: "c1" }),
          transaction("tx2", "2026-08-02", 10_000, { payee_id: "p1", category_id: "c2" }),
        ],
        subtransactions: [],
      }),
    });
    const { text } = await h.call("spending_breakdown", { start: "2026-08", end: "2026-08", limit: 1 });
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.equal(body.total, 0);
    assert.deepEqual(rowsOf(body), [{ id: "c1", name: "Groceries", group: "Everyday", spent: 10, count: 1, share: 0 }]);
    assert.deepEqual(body.other, { count: 1, spent: -10, share: 0 });
    assert.ok(!text.includes("null"), text);
  });

  it("answers a budget with no spending at all without a single null", async () => {
    await using h = await harness();
    const { text, isError } = await h.call("spending_breakdown", {});
    assert.equal(isError, false);
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.equal(body.total, 0);
    assert.equal(body.lines, 0);
    assert.deepEqual(body.rows, []);
    assert.deepEqual(body.excluded, { transfers: 0, tracking: 0, inflows: 0 });
    assert.ok(!text.includes("null"), text);
  });
});
