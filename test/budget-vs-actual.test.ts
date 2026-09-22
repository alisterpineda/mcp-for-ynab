import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { month, monthCategory, monthFromNow, spendingBudget } from "./fixtures.js";
import { harness } from "./mcp.js";

interface MonthPoint {
  month: string;
  assigned: number;
  activity: number;
  available: number;
  partial?: true;
}

interface Row {
  id: string;
  name: string;
  group: string;
  assigned: number;
  activity: number;
  available: number;
  overspent_months: number;
  over_assigned_months: number;
  hidden?: true;
  credit_card_payment?: true;
  months?: MonthPoint[];
}

const rowsOf = (body: Record<string, unknown>): Row[] => body.rows as Row[];

const spending = () => harness({ budget: spendingBudget() });

/** The window every fixed-window test uses: two months that are over whenever the suite runs. */
const PAST = { start: "2026-07", end: "2026-08" };

/**
 * A budget whose only budget figures sit in the current month and the one before it, so the
 * partial-month rules can be observed without the test knowing what today is. Groceries goes
 * negative and over its assignment in both months.
 */
function aroundToday(): ReturnType<typeof spendingBudget> {
  const [previous, current] = [monthFromNow(-1), monthFromNow(0)];
  return spendingBudget({
    first_month: `${previous}-01`,
    last_month: `${current}-01`,
    months: [
      month(`${previous}-01`, [monthCategory("c1", { budgeted: 40_000, activity: -50_000, balance: -10_000 })]),
      month(`${current}-01`, [monthCategory("c1", { budgeted: 60_000, activity: -70_000, balance: -20_000 })]),
    ],
    transactions: [],
    subtransactions: [],
  });
}

describe("budget_vs_actual", () => {
  it("sums assigned and activity over the window and reads available from its last month", async () => {
    await using h = await spending();
    const body = await h.json("budget_vs_actual", PAST);
    assert.equal(body.start, "2026-07");
    assert.equal(body.end, "2026-08");
    // Groceries by hand: assigned 40,000 + 60,000; activity -50,000 + -135,000; August ends at -55,000.
    // August is the overspent month; July (50 > 40) and August (135 > 60) both went over the assignment.
    assert.deepEqual(rowsOf(body)[0], {
      id: "c1",
      name: "Groceries",
      group: "Everyday",
      assigned: 100,
      activity: -185,
      available: -55,
      overspent_months: 1,
      over_assigned_months: 2,
    });
  });

  it("puts the most overspent categories first, then the ones that spent the most", async () => {
    await using h = await spending();
    const body = await h.json("budget_vs_actual", PAST);
    assert.deepEqual(
      rowsOf(body).map((row) => row.name),
      ["Groceries", "(deleted category)", "Mortgage", "Household", "Dining Out", "Visa", "Old hobby"],
    );
    // The deleted category was overspent in July too, and it spent less than Groceries did.
    assert.deepEqual(
      rowsOf(body).map((row) => row.overspent_months),
      [1, 1, 0, 0, 0, 0, 0],
    );
  });

  it("omits the categories that are zero all the way through and counts them", async () => {
    await using h = await spending();
    const body = await h.json("budget_vs_actual", PAST);
    // `c9 Retired` has no assignment, no activity and no balance in any month of the window.
    assert.ok(!rowsOf(body).some((row) => row.name === "Retired"), "a row of zeroes says nothing");
    assert.equal(body.categories_omitted, 1);
  });

  it("marks the hidden categories and the credit card payment categories", async () => {
    await using h = await spending();
    const rows = rowsOf(await h.json("budget_vs_actual", PAST));
    const hobby = rows.find((row) => row.name === "Old hobby")!;
    assert.equal(hobby.hidden, true);
    assert.ok(!("credit_card_payment" in hobby));
    const visa = rows.find((row) => row.name === "Visa")!;
    assert.deepEqual(visa, {
      id: "c5",
      name: "Visa",
      group: "Credit Card Payments",
      // Card spending moved in minus payments out: July -23,000, August -15,000.
      assigned: 100,
      activity: -38,
      available: 62,
      overspent_months: 0,
      over_assigned_months: 0,
      credit_card_payment: true,
    });
  });

  it("adds the month-by-month figures when asked for them", async () => {
    await using h = await spending();
    const body = await h.json("budget_vs_actual", { ...PAST, include_months: true });
    assert.deepEqual(rowsOf(body)[0].months, [
      { month: "2026-07", assigned: 40, activity: -50, available: 20 },
      { month: "2026-08", assigned: 60, activity: -135, available: -55 },
    ]);
  });

  it("leaves the month-by-month figures out by default", async () => {
    await using h = await spending();
    const body = await h.json("budget_vs_actual", PAST);
    assert.ok(!("months" in rowsOf(body)[0]), "a forty-category budget over a year has to stay readable");
  });

  it("covers the last six months ending at the current one when asked for no window", async () => {
    await using h = await spending();
    const body = await h.json("budget_vs_actual", {});
    assert.equal(body.start, monthFromNow(-5));
    assert.equal(body.end, monthFromNow(0));
  });
});

describe("budget_vs_actual and the end of the window", () => {
  it("leaves `available` out when YNAB has no figures for the last month yet", async () => {
    await using h = await spending();
    // The fixture's months end at 2026-09, so the window's last month has no row for anyone.
    const body = await h.json("budget_vs_actual", { start: "2026-08", end: "2026-10", categories: ["Groceries"] });
    assert.equal(body.end, "2026-10");
    const [groceries] = rowsOf(body);
    assert.equal(groceries.name, "Groceries");
    assert.equal(groceries.assigned, 160);
    assert.equal(groceries.activity, -215);
    assert.equal(groceries.overspent_months, 1);
    assert.equal(groceries.over_assigned_months, 1);
    assert.equal(groceries.available, undefined, "a balance from an earlier month is not the end of the window");
  });

  it("accepts a full date for either end and truncates it to the month", async () => {
    await using h = await spending();
    const body = await h.json("budget_vs_actual", { start: "2026-07-15", end: "2026-08-03" });
    assert.equal(body.start, "2026-07");
    assert.equal(body.end, "2026-08");
  });

  it("refuses a month it cannot read", async () => {
    await using h = await spending();
    const { text, isError } = await h.call("budget_vs_actual", { start: "July" });
    assert.equal(isError, true);
    assert.match(text, /YYYY-MM/);
  });
});

describe("budget_vs_actual filters", () => {
  it("takes categories and groups by id or by exact name", async () => {
    await using h = await spending();
    const byName = await h.json("budget_vs_actual", { ...PAST, categories: ["groceries", "Dining Out"] });
    assert.deepEqual(rowsOf(byName).map((row) => row.name), ["Groceries", "Dining Out"]);
    const byId = await h.json("budget_vs_actual", { ...PAST, groups: ["g2"] });
    assert.deepEqual(rowsOf(byId).map((row) => row.name), ["Mortgage"]);
  });

  it("reports an unknown name rather than answering about everything", async () => {
    await using h = await spending();
    const { text, isError } = await h.call("budget_vs_actual", { ...PAST, categories: ["Groserys"] });
    assert.equal(isError, true);
    assert.match(text, /Groserys/);
  });
});

describe("budget_vs_actual and the month still being lived in", () => {
  it("flags the current month and keeps it out of the counts", async () => {
    await using h = await harness({ budget: aroundToday() });
    const body = await h.json("budget_vs_actual", { months: 2, include_months: true });
    assert.equal(body.partial_month, monthFromNow(0));
    const row = rowsOf(body)[0];
    // Both months still count toward the totals; only the counts hold back on the unfinished one.
    assert.equal(row.assigned, 100);
    assert.equal(row.activity, -120);
    assert.equal(row.available, -20);
    assert.equal(row.overspent_months, 1);
    assert.equal(row.over_assigned_months, 1);
    assert.deepEqual(row.months, [
      { month: monthFromNow(-1), assigned: 40, activity: -50, available: -10 },
      { month: monthFromNow(0), assigned: 60, activity: -70, available: -20, partial: true },
    ]);
  });

  it("counts the current month when asked to", async () => {
    await using h = await harness({ budget: aroundToday() });
    const row = rowsOf(await h.json("budget_vs_actual", { months: 2, include_partial: true }))[0];
    assert.equal(row.overspent_months, 2);
    assert.equal(row.over_assigned_months, 2);
  });

  it("says nothing about a partial month when the window has ended", async () => {
    await using h = await spending();
    const body = await h.json("budget_vs_actual", PAST);
    assert.ok(!("partial_month" in body), "the window is over; no month in it is still moving");
  });
});

describe("budget_vs_actual refresh", () => {
  it("pulls from YNAB before answering", async () => {
    await using h = await spending();
    await h.json("budget_vs_actual", PAST);
    const before = h.source.calls.length;
    await h.json("budget_vs_actual", { ...PAST, refresh: true });
    assert.equal(h.source.calls.length, before + 1);
    await h.json("budget_vs_actual", PAST);
    assert.equal(h.source.calls.length, before + 1, "without refresh the cache is still fresh");
  });
});
