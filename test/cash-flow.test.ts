import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUDGET_ID, category, monthFromNow, payee, spendingBudget, transaction } from "./fixtures.js";
import { harness } from "./mcp.js";

interface Flow {
  income: number;
  spent: number;
  to_tracking_accounts: number;
  saved: number;
  savings_rate?: number;
}

interface Month extends Flow {
  month: string;
  partial?: true;
}

interface Aggregate {
  id?: string;
  name: string;
  income?: number;
  spent?: number;
  count: number;
  months_active: number;
}

const monthsOf = (body: Record<string, unknown>): Month[] => body.months as Month[];

const spending = () => harness({ budget: spendingBudget() });

/**
 * Three complete months and the current one, with income and spending chosen so the median month
 * is not the average month: incomes 100, 100 and 400, spending 40, 60 and 50, then 5 spent so far.
 */
function aroundToday(): ReturnType<typeof spendingBudget> {
  const [third, second, first, current] = [-3, -2, -1, 0].map(monthFromNow);
  return spendingBudget({
    first_month: `${third}-01`,
    last_month: `${current}-01`,
    months: [],
    transactions: [
      transaction("i3", `${third}-01`, 100_000, { payee_id: "p4", category_id: "c6" }),
      transaction("x3", `${third}-05`, -40_000, { category_id: "c1" }),
      transaction("i2", `${second}-01`, 100_000, { payee_id: "p4", category_id: "c6" }),
      transaction("x2", `${second}-05`, -60_000, { category_id: "c1" }),
      transaction("i1", `${first}-01`, 400_000, { payee_id: "p4", category_id: "c6" }),
      transaction("x1", `${first}-05`, -50_000, { category_id: "c1" }),
      transaction("x0", `${current}-01`, -5_000, { category_id: "c1" }),
    ],
    subtransactions: [],
  });
}

describe("cash_flow", () => {
  it("gives each month its income, spending and savings, the way the fixture's arithmetic says", async () => {
    await using h = await spending();
    const body = await h.json("cash_flow", { start: "2026-07", end: "2026-08" });
    assert.equal(body.start, "2026-07");
    assert.equal(body.end, "2026-08");
    // Each month: the 500,000 paycheque in, the spending rule's total out (the fixture's 307,000
    // and 333,000), of which the 150,000 mortgage transfer went to a tracking account.
    assert.deepEqual(monthsOf(body), [
      { month: "2026-07", income: 500, spent: 307, to_tracking_accounts: 150, saved: 193, savings_rate: 38.6 },
      { month: "2026-08", income: 500, spent: 333, to_tracking_accounts: 150, saved: 167, savings_rate: 33.4 },
    ]);
    assert.ok(!("partial_month" in body), "the window is over; no month in it is still moving");
    assert.match(String(body.scope), /Ready to Assign/);
    assert.match(String(body.scope), /starting balance/, "the scope warns that an opening balance reads as income");
  });

  it("counts as saved exactly what the on-budget accounts grew by", async () => {
    await using h = await spending();
    const body = await h.json("cash_flow", { start: "2026-07", end: "2026-08" });
    const onBudget = h.db.accountRows(BUDGET_ID).accounts.filter((a) => a.onBudget).map((a) => a.id);
    for (const row of monthsOf(body)) {
      // Every line on a budget account, transfers between them included: they cancel out.
      const range = { from: `${row.month}-01`, to: `${row.month}-31`, accountIds: onBudget };
      assert.equal(row.saved, h.db.searchTotal(BUDGET_ID, range).sum / 1000, `${row.month}: saved vs the accounts' growth`);
    }
  });

  it("counts as income exactly what YNAB puts in Ready to Assign", async () => {
    await using h = await spending();
    const body = await h.json("cash_flow", { start: "2026-07", end: "2026-08" });
    for (const row of monthsOf(body)) {
      const readyToAssign = h.db.monthCategories(BUDGET_ID, `${row.month}-01`).find((c) => c.categoryId === "c6")!;
      assert.equal(row.income, readyToAssign.activity / 1000, `${row.month}: income vs Ready to Assign's activity`);
    }
  });

  it("totals and averages the complete months, and the average row adds up", async () => {
    await using h = await spending();
    const body = await h.json("cash_flow", { start: "2026-07", end: "2026-08" });
    assert.deepEqual(body.total, { income: 1000, spent: 640, to_tracking_accounts: 300, saved: 360, savings_rate: 36 });
    assert.deepEqual(body.average, { income: 500, spent: 320, to_tracking_accounts: 150, saved: 180, savings_rate: 36 });
    // Two months, so each median is the mean of the two: spending, and the tracked part of it, positive.
    assert.deepEqual(body.median, { income: 500, spent: 320, to_tracking_accounts: 150, saved: 180, savings_rate: 36 });
  });

  it("names where the income came from and where the tracked money went", async () => {
    const budget = spendingBudget();
    // A second paycheque in August, so the lines (3) and the months they fall in (2) differ.
    budget.transactions = [...budget.transactions!, transaction("b1", "2026-08-15", 50_000, { payee_id: "p4", category_id: "c6", memo: "bonus" })];
    await using h = await harness({ budget });
    const body = await h.json("cash_flow", { start: "2026-07", end: "2026-08" });
    assert.deepEqual(body.income_sources, [{ id: "p4", name: "Employer", income: 1050, count: 3, months_active: 2 }]);
    assert.deepEqual(body.tracking_accounts, [{ id: "a3", name: "Mortgage", spent: 300, count: 2, months_active: 2 }]);
  });

  it("lists each tracking account the spending reached, most moved first, uncategorized transfers included", async () => {
    const budget = spendingBudget();
    budget.categories = [...budget.categories!, category("c10", "Investing")];
    budget.transactions = [
      ...budget.transactions!,
      // A categorized contribution to the brokerage, and an extra mortgage payment left uncategorized.
      transaction("v1", "2026-08-12", -200_000, { payee_id: "pt4", category_id: "c10", transfer_account_id: "a4" }),
      transaction("v2", "2026-08-12", 200_000, { account_id: "a4", payee_id: "pt1", category_id: null, transfer_account_id: "a1" }),
      transaction("u1", "2026-08-16", -70_000, { payee_id: "pt3", category_id: null, transfer_account_id: "a3" }),
      transaction("u2", "2026-08-16", 70_000, { account_id: "a3", payee_id: "pt1", category_id: null, transfer_account_id: "a1" }),
    ];
    await using h = await harness({ budget });
    const body = await h.json("cash_flow", { start: "2026-07", end: "2026-08" });
    // August: the fixture's 333 plus both transfers is spent, and all three transfers went to tracking.
    assert.deepEqual(monthsOf(body)[1], { month: "2026-08", income: 500, spent: 603, to_tracking_accounts: 420, saved: -103, savings_rate: -20.6 });
    assert.deepEqual(body.tracking_accounts, [
      { id: "a3", name: "Mortgage", spent: 370, count: 3, months_active: 2 },
      { id: "a4", name: "Brokerage", spent: 200, count: 1, months_active: 1 },
    ]);
    const listed = (body.tracking_accounts as Aggregate[]).reduce((sum, account) => sum + account.spent!, 0);
    assert.equal(listed, (body.total as Flow).to_tracking_accounts, "the accounts add up to the tracked total");
  });

  it("lists income with no payee under its own name and no id", async () => {
    const budget = spendingBudget();
    budget.transactions = [...budget.transactions!, transaction("n1", "2026-08-21", 12_000, { payee_id: null, category_id: "c6" })];
    await using h = await harness({ budget });
    const body = await h.json("cash_flow", { start: "2026-08", end: "2026-08" });
    assert.deepEqual(body.income_sources, [
      { id: "p4", name: "Employer", income: 500, count: 1, months_active: 1 },
      { name: "(no payee)", income: 12, count: 1, months_active: 1 },
    ]);
  });

  it("counts an inflow to Ready to Assign on a credit card, and one from a tracking account, as income", async () => {
    const budget = spendingBudget();
    budget.payees = [...budget.payees!, payee("p11", "Card Rewards")];
    budget.transactions = [
      ...budget.transactions!,
      transaction("cb", "2026-08-20", 5_000, { account_id: "a2", payee_id: "p11", category_id: "c6" }),
      // A withdrawal from the brokerage, sent to Ready to Assign, and its tracking-account side.
      transaction("w1", "2026-08-22", 100_000, { payee_id: "pt4", category_id: "c6", transfer_account_id: "a4" }),
      transaction("w2", "2026-08-22", -100_000, { account_id: "a4", payee_id: "pt1", category_id: null, transfer_account_id: "a1" }),
    ];
    await using h = await harness({ budget });
    const body = await h.json("cash_flow", { start: "2026-08", end: "2026-08" });
    assert.deepEqual(monthsOf(body)[0], {
      month: "2026-08",
      income: 605,
      spent: 333,
      to_tracking_accounts: 150,
      saved: 272,
      savings_rate: 45,
    });
    assert.deepEqual(body.income_sources, [
      { id: "p4", name: "Employer", income: 500, count: 1, months_active: 1 },
      { id: "pt4", name: "Transfer : Brokerage", income: 100, count: 1, months_active: 1 },
      { id: "p11", name: "Card Rewards", income: 5, count: 1, months_active: 1 },
    ]);
    // The withdrawal is income, not spending, so the brokerage is not among the tracking accounts.
    assert.deepEqual(body.tracking_accounts, [{ id: "a3", name: "Mortgage", spent: 150, count: 1, months_active: 1 }]);
  });

  it("reads a month with no lines as zeroes, with no rate", async () => {
    // The budget now opens in June, a month before its first transaction.
    await using h = await harness({ budget: spendingBudget({ first_month: "2026-06-01" }) });
    const body = await h.json("cash_flow", { start: "2026-06", end: "2026-07" });
    assert.deepEqual(monthsOf(body)[0], { month: "2026-06", income: 0, spent: 0, to_tracking_accounts: 0, saved: 0 });
  });

  it("sums the sources past the first 25 into income_sources_other", async () => {
    const budget = spendingBudget();
    const extra = Array.from({ length: 30 }, (_, i) => i + 1);
    budget.payees = [...budget.payees!, ...extra.map((i) => payee(`q${i}`, `Source ${i}`))];
    budget.transactions = [
      ...budget.transactions!,
      ...extra.map((i) => transaction(`q${i}`, "2026-08-15", i * 1_000, { payee_id: `q${i}`, category_id: "c6" })),
      // Source 1 pays twice, so the rest's lines (7) outnumber its sources (6).
      transaction("q1b", "2026-08-16", 1_000, { payee_id: "q1", category_id: "c6" }),
    ];
    await using h = await harness({ budget });
    const body = await h.json("cash_flow", { start: "2026-08", end: "2026-08" });
    const sources = body.income_sources as Aggregate[];
    assert.equal(sources.length, 25);
    // Employer's 500 and Sources 30 down to 7 are listed; Sources 1 to 6 are the smallest.
    assert.deepEqual(body.income_sources_other, { sources: 6, count: 7, income: 22 });
    const listed = sources.reduce((sum, source) => sum + source.income!, 0);
    assert.equal(listed + 22, (body.total as Flow).income, "the listed sources and the rest add up to the income");
  });

  it("covers six months ending at the current one by default", async () => {
    await using h = await harness({ budget: spendingBudget({ first_month: "2020-01-01" }) });
    const body = await h.json("cash_flow");
    assert.equal(body.start, monthFromNow(-5));
    assert.equal(body.end, monthFromNow(0));
    assert.equal(monthsOf(body).length, 6);
  });
});

describe("cash_flow statistics", () => {
  it("takes each column's median on its own, so the medians need not add up", async () => {
    await using h = await harness({ budget: aroundToday() });
    const body = await h.json("cash_flow", { months: 4 });
    // Saved per month is 60, 40 and 350: its median is 60, not the 100 - 50 of the other two medians.
    assert.deepEqual(body.median, { income: 100, spent: 50, to_tracking_accounts: 0, saved: 60, savings_rate: 60 });
    assert.deepEqual(body.average, { income: 200, spent: 50, to_tracking_accounts: 0, saved: 150, savings_rate: 75 });
  });

  it("rounds the average's parts before deriving saved, so it adds up to the cent", async () => {
    const [third, second, first] = [-3, -2, -1].map(monthFromNow);
    // Income 100.01 and spending 49.99 over three months: 33.33667 and 16.66333 a month, which
    // round to 33.34 and 16.66, while their exact difference 16.67333 would round to 16.67.
    const budget = spendingBudget({
      first_month: `${third}-01`,
      months: [],
      subtransactions: [],
      transactions: [
        transaction("i3", `${third}-01`, 33_340, { payee_id: "p4", category_id: "c6" }),
        transaction("i2", `${second}-01`, 33_340, { payee_id: "p4", category_id: "c6" }),
        transaction("i1", `${first}-01`, 33_330, { payee_id: "p4", category_id: "c6" }),
        transaction("x3", `${third}-02`, -16_660, { category_id: "c1" }),
        transaction("x2", `${second}-02`, -16_660, { category_id: "c1" }),
        transaction("x1", `${first}-02`, -16_670, { category_id: "c1" }),
      ],
    });
    await using h = await harness({ budget });
    const average = (await h.json("cash_flow", { months: 3, end: first })).average as Flow;
    assert.equal(average.income, 33.34);
    assert.equal(average.spent, 16.66);
    assert.equal(average.saved, 16.68);
  });
});

describe("cash_flow and the month still being lived in", () => {
  it("flags the current month partial and leaves it out of every summary", async () => {
    await using h = await harness({ budget: aroundToday() });
    const body = await h.json("cash_flow", { months: 4 });
    assert.equal(body.partial_month, monthFromNow(0));
    // Nothing came in yet, so there is no rate to give.
    assert.deepEqual(monthsOf(body)[3], { month: monthFromNow(0), income: 0, spent: 5, to_tracking_accounts: 0, saved: -5, partial: true });
    assert.deepEqual(body.total, { income: 600, spent: 150, to_tracking_accounts: 0, saved: 450, savings_rate: 75 });
    assert.deepEqual(body.income_sources, [{ id: "p4", name: "Employer", income: 600, count: 3, months_active: 3 }]);
  });

  it("leaves the partial month's income and tracking transfers out of the listings too", async () => {
    const budget = aroundToday();
    const current = monthFromNow(0);
    budget.transactions = [
      ...budget.transactions!,
      transaction("i0", `${current}-01`, 70_000, { payee_id: "p4", category_id: "c6" }),
      transaction("m0", `${current}-01`, -9_000, { payee_id: "pt3", category_id: "c4", transfer_account_id: "a3" }),
      transaction("m0b", `${current}-01`, 9_000, { account_id: "a3", payee_id: "pt1", category_id: null, transfer_account_id: "a1" }),
    ];
    await using h = await harness({ budget });
    const without = await h.json("cash_flow", { months: 4 });
    assert.deepEqual(without.income_sources, [{ id: "p4", name: "Employer", income: 600, count: 3, months_active: 3 }]);
    assert.deepEqual(without.tracking_accounts, []);

    const withPartial = await h.json("cash_flow", { months: 4, include_partial: true });
    assert.deepEqual(withPartial.income_sources, [{ id: "p4", name: "Employer", income: 670, count: 4, months_active: 4 }]);
    assert.deepEqual(withPartial.tracking_accounts, [{ id: "a3", name: "Mortgage", spent: 9, count: 1, months_active: 1 }]);
  });

  it("counts the partial month everywhere when asked to", async () => {
    await using h = await harness({ budget: aroundToday() });
    const body = await h.json("cash_flow", { months: 4, include_partial: true });
    assert.deepEqual(body.total, { income: 600, spent: 155, to_tracking_accounts: 0, saved: 445, savings_rate: 74.2 });
    assert.deepEqual(body.average, { income: 150, spent: 38.75, to_tracking_accounts: 0, saved: 111.25, savings_rate: 74.2 });
    // The month with no income has no rate, so the rate's median is over the other three.
    assert.deepEqual(body.median, { income: 100, spent: 45, to_tracking_accounts: 0, saved: 50, savings_rate: 60 });
  });

  it("omits every summary when the window is only the partial month", async () => {
    await using h = await harness({ budget: aroundToday() });
    const body = await h.json("cash_flow", { months: 1 });
    assert.equal(monthsOf(body).length, 1);
    for (const key of ["total", "average", "median", "income_sources", "tracking_accounts"]) {
      assert.ok(!(key in body), `${key} has no honest value here, so it has no key either`);
    }
  });
});

describe("cash_flow and the budget's history", () => {
  it("cuts a window that reaches back before the budget, so the average is over real months", async () => {
    await using h = await spending();
    const body = await h.json("cash_flow", { start: "2026-04", end: "2026-08" });
    assert.equal(body.start, "2026-07");
    assert.equal(body.history_starts, "2026-07");
    assert.equal(monthsOf(body).length, 2);
    assert.equal((body.average as Flow).income, 500, "not 200, which is 1,000 spread over five months");
  });

  it("refuses a window that runs past the current month", async () => {
    await using h = await harness({ budget: aroundToday() });
    const { text, isError } = await h.call("cash_flow", { start: monthFromNow(0), end: monthFromNow(1) });
    assert.equal(isError, true);
    assert.match(text, new RegExp(`ends at ${monthFromNow(1)}`));
  });

  it("refuses a window that ends before the budget begins, naming where it does", async () => {
    await using h = await spending();
    const { text, isError } = await h.call("cash_flow", { start: "2026-01", end: "2026-03" });
    assert.equal(isError, true);
    assert.match(text, /history starts at 2026-07/);
  });
});
