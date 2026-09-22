import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { category, monthFromNow, spendingBudget, transaction } from "./fixtures.js";
import { harness } from "./mcp.js";

interface Point {
  month: string;
  spent: number;
  partial?: true;
}

interface Series {
  id: string;
  name: string;
  kind: "category" | "category_group";
  months: Point[];
  average?: number;
  min?: number;
  max?: number;
}

const seriesOf = (body: Record<string, unknown>): Series[] => body.series as Series[];

const spending = () => harness({ budget: spendingBudget() });

/**
 * A budget whose only spending sits in the current month and the one before it, so the partial
 * month rules can be observed without the test knowing what today is.
 */
function aroundToday(): ReturnType<typeof spendingBudget> {
  const [previous, current] = [monthFromNow(-1), monthFromNow(0)];
  return spendingBudget({
    first_month: `${previous}-01`,
    last_month: `${current}-01`,
    months: [],
    transactions: [
      transaction("x1", `${previous}-05`, -20_000, { category_id: "c1" }),
      transaction("x2", `${current}-05`, -5_000, { category_id: "c1" }),
    ],
    subtransactions: [],
  });
}

describe("spending_trend", () => {
  it("refuses a window that runs past the current month, rather than trending zeroes", async () => {
    await using h = await harness({ budget: aroundToday() });
    const { text, isError } = await h.call("spending_trend", { categories: ["Groceries"], start: monthFromNow(0), end: monthFromNow(1) });
    assert.equal(isError, true);
    assert.match(text, new RegExp(`ends at ${monthFromNow(1)}`));
  });

  it("gives one series per category in the order asked, a month at a time", async () => {
    await using h = await spending();
    const body = await h.json("spending_trend", { categories: ["Groceries", "Dining Out"], start: "2026-07", end: "2026-08" });
    assert.equal(body.start, "2026-07");
    assert.equal(body.end, "2026-08");
    // 2026-07 Groceries: a 60,000 split line less a 10,000 refund. 2026-08: 90,000 + 45,000.
    assert.deepEqual(seriesOf(body)[0], {
      id: "c1",
      name: "Groceries",
      kind: "category",
      months: [
        { month: "2026-07", spent: 50 },
        { month: "2026-08", spent: 135 },
      ],
      average: 92.5,
      min: 50,
      max: 135,
    });
    assert.deepEqual(seriesOf(body)[1], {
      id: "c3",
      name: "Dining Out",
      kind: "category",
      months: [
        { month: "2026-07", spent: 32 },
        { month: "2026-08", spent: 18 },
      ],
      average: 25,
      min: 18,
      max: 32,
    });
  });

  it("reads a month with no activity as a zero rather than a gap", async () => {
    await using h = await spending();
    const body = await h.json("spending_trend", { categories: ["Old hobby"], start: "2026-07", end: "2026-08" });
    // The hobby shop trip is in 2026-07 only; 2026-08 has nothing in that category.
    assert.deepEqual(seriesOf(body)[0].months, [
      { month: "2026-07", spent: 15 },
      { month: "2026-08", spent: 0 },
    ]);
    assert.equal(seriesOf(body)[0].average, 7.5);
    assert.equal(seriesOf(body)[0].min, 0);
    assert.equal(seriesOf(body)[0].max, 15);
  });

  it("sums a group's categories into one series, after the categories asked for", async () => {
    await using h = await spending();
    const body = await h.json("spending_trend", { categories: ["Groceries"], groups: ["Everyday"], start: "2026-07", end: "2026-08" });
    assert.deepEqual(
      seriesOf(body).map((s) => [s.id, s.kind]),
      [
        ["c1", "category"],
        ["g1", "category_group"],
      ],
    );
    // Everyday is Groceries, Household, Dining Out and the hidden Old hobby.
    assert.deepEqual(seriesOf(body)[1], {
      id: "g1",
      name: "Everyday",
      kind: "category_group",
      months: [
        { month: "2026-07", spent: 127 },
        { month: "2026-08", spent: 183 },
      ],
      average: 155,
      min: 127,
      max: 183,
    });
  });

  it("takes a name whatever its case, and an id just as well", async () => {
    await using h = await spending();
    const body = await h.json("spending_trend", { categories: ["  groceries ", "c3"], start: "2026-07", end: "2026-08" });
    assert.deepEqual(
      seriesOf(body).map((s) => s.name),
      ["Groceries", "Dining Out"],
    );
  });

  it("covers six months ending at the current one by default", async () => {
    // A budget old enough that the default window sits wholly inside its history.
    await using h = await harness({ budget: spendingBudget({ first_month: "2020-01-01" }) });
    const body = await h.json("spending_trend", { categories: ["Groceries"] });
    assert.equal(body.start, monthFromNow(-5));
    assert.equal(body.end, monthFromNow(0));
    assert.equal(seriesOf(body)[0].months.length, 6);
  });

  it("lets an explicit start and end win over months", async () => {
    await using h = await spending();
    const body = await h.json("spending_trend", { categories: ["Groceries"], months: 5, start: "2026-07", end: "2026-08" });
    assert.equal(seriesOf(body)[0].months.length, 2);
  });

  it("counts back the months asked for", async () => {
    await using h = await spending();
    const body = await h.json("spending_trend", { categories: ["Groceries"], months: 2, end: "2026-08" });
    assert.equal(body.start, "2026-07");
    assert.equal(seriesOf(body)[0].months.length, 2);
  });
});

describe("spending_trend and the month still being lived in", () => {
  it("flags the current month partial and leaves it out of the statistics", async () => {
    await using h = await harness({ budget: aroundToday() });
    const body = await h.json("spending_trend", { categories: ["Groceries"], months: 2 });
    assert.equal(body.partial_month, monthFromNow(0));
    assert.deepEqual(seriesOf(body)[0].months, [
      { month: monthFromNow(-1), spent: 20 },
      { month: monthFromNow(0), spent: 5, partial: true },
    ]);
    // Only the complete month counts: a half-finished month must not drag the average down.
    assert.equal(seriesOf(body)[0].average, 20);
    assert.equal(seriesOf(body)[0].min, 20);
    assert.equal(seriesOf(body)[0].max, 20);
  });

  it("counts the partial month in the statistics when asked to", async () => {
    await using h = await harness({ budget: aroundToday() });
    const body = await h.json("spending_trend", { categories: ["Groceries"], months: 2, include_partial: true });
    assert.equal(seriesOf(body)[0].average, 12.5);
    assert.equal(seriesOf(body)[0].min, 5);
    assert.equal(seriesOf(body)[0].max, 20);
  });

  it("omits the statistics altogether when the window is only the partial month", async () => {
    await using h = await harness({ budget: aroundToday() });
    const body = await h.json("spending_trend", { categories: ["Groceries"], months: 1 });
    const series = seriesOf(body)[0];
    assert.deepEqual(series.months, [{ month: monthFromNow(0), spent: 5, partial: true }]);
    for (const key of ["average", "min", "max"]) {
      assert.ok(!(key in series), `${key} has no honest value here, so it has no key either`);
    }
  });

  it("says nothing about a partial month when the window has ended", async () => {
    await using h = await spending();
    const body = await h.json("spending_trend", { categories: ["Groceries"], start: "2026-07", end: "2026-08" });
    assert.ok(!("partial_month" in body), "the window is over; no month in it is still moving");
    assert.ok(seriesOf(body)[0].months.every((point) => !("partial" in point)));
  });
});

describe("spending_trend and the budget's history", () => {
  it("cuts a window that reaches back before the budget, so the average is over real months", async () => {
    await using h = await spending();
    // The fixture's budget starts in 2026-07; April to June would be three zeroes it never lived.
    const body = await h.json("spending_trend", { categories: ["Groceries"], start: "2026-04", end: "2026-08" });
    assert.equal(body.start, "2026-07");
    assert.equal(body.history_starts, "2026-07");
    assert.deepEqual(seriesOf(body)[0].months, [
      { month: "2026-07", spent: 50 },
      { month: "2026-08", spent: 135 },
    ]);
    assert.equal(seriesOf(body)[0].average, 92.5, "not 37, which is 185 spread over five months");
  });

  it("says nothing about history when the window sits inside it", async () => {
    await using h = await spending();
    const body = await h.json("spending_trend", { categories: ["Groceries"], start: "2026-07", end: "2026-08" });
    assert.ok(!("history_starts" in body));
  });

  it("counts a transaction dated before the first budget month as history", async () => {
    await using h = await harness({
      budget: spendingBudget({
        transactions: [...spendingBudget().transactions!, transaction("early", "2026-05-20", -40_000, { category_id: "c1" })],
      }),
    });
    const body = await h.json("spending_trend", { categories: ["Groceries"], start: "2026-04", end: "2026-07" });
    assert.equal(body.history_starts, "2026-05");
    assert.deepEqual(seriesOf(body)[0].months, [
      { month: "2026-05", spent: 40 },
      { month: "2026-06", spent: 0 },
      { month: "2026-07", spent: 50 },
    ]);
  });

  it("refuses a window that ends before the budget begins, naming where it does", async () => {
    await using h = await spending();
    const { text, isError } = await h.call("spending_trend", { categories: ["Groceries"], start: "2026-01", end: "2026-03" });
    assert.equal(isError, true);
    assert.match(text, /history starts at 2026-07/);
  });
});

describe("spending_trend when it cannot answer", () => {
  it("asks for a category or a group rather than trending the whole budget", async () => {
    await using h = await spending();
    const { text, isError } = await h.call("spending_trend", {});
    assert.equal(isError, true);
    assert.match(text, /categor/i);
  });

  it("treats empty lists as nothing asked for", async () => {
    await using h = await spending();
    const { isError } = await h.call("spending_trend", { categories: [], groups: [] });
    assert.equal(isError, true);
  });

  it("names the input it could not resolve", async () => {
    await using h = await spending();
    const { text, isError } = await h.call("spending_trend", { categories: ["Groserys"] });
    assert.equal(isError, true);
    assert.match(text, /No category named "Groserys"/);
  });

  it("lists the candidates when a name matches several categories", async () => {
    const budget = spendingBudget();
    budget.categories = [...(budget.categories ?? []), category("c10", "Groceries", { category_group_id: "g2" })];
    await using h = await harness({ budget });
    const { text, isError } = await h.call("spending_trend", { categories: ["Groceries"] });
    assert.equal(isError, true);
    assert.match(text, /Groceries \(c1\)/);
    assert.match(text, /Groceries \(c10\)/);
  });

  it("reports an unresolvable group the same way", async () => {
    await using h = await spending();
    const { text, isError } = await h.call("spending_trend", { groups: ["Everydey"] });
    assert.equal(isError, true);
    assert.match(text, /No category group named "Everydey"/);
  });
});

describe("spending_trend refresh", () => {
  it("pulls from YNAB before answering", async () => {
    await using h = await spending();
    await h.json("spending_trend", { categories: ["Groceries"] });
    const before = h.source.calls.length;
    await h.json("spending_trend", { categories: ["Groceries"], refresh: true });
    assert.equal(h.source.calls.length, before + 1);
    await h.json("spending_trend", { categories: ["Groceries"] });
    assert.equal(h.source.calls.length, before + 1, "without refresh the cache is still fresh");
  });
});
