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
    const onlyBuckets = await h.call("spending_trend", { buckets: [] });
    assert.equal(onlyBuckets.isError, true, "an empty bucket list asks for no series either");
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

interface BucketSeries extends Omit<Series, "id" | "kind"> {
  kind: "bucket";
  groups?: { id: string; name: string }[];
  categories?: { id: string; name: string }[];
}

describe("spending_trend with buckets", () => {
  it("gives each bucket a series summing its categories, and unassigned the rest", async () => {
    await using h = await spending();
    const body = await h.json("spending_trend", {
      start: "2026-07",
      end: "2026-08",
      buckets: [
        { name: "Food", categories: ["Groceries", "Dining Out"] },
        { name: "Home", groups: ["Housing"] },
      ],
    });
    assert.deepEqual(body.series, [
      {
        name: "Food",
        kind: "bucket",
        categories: [
          { id: "c1", name: "Groceries" },
          { id: "c3", name: "Dining Out" },
        ],
        // July: groceries 50,000 net of the refund and dining 32,000. August: 135,000 and 18,000.
        months: [
          { month: "2026-07", spent: 82 },
          { month: "2026-08", spent: 153 },
        ],
        average: 117.5,
        min: 82,
        max: 153,
      },
      {
        name: "Home",
        kind: "bucket",
        groups: [{ id: "g2", name: "Housing" }],
        months: [
          { month: "2026-07", spent: 150 },
          { month: "2026-08", spent: 150 },
        ],
        average: 150,
        min: 150,
        max: 150,
      },
    ]);
    // July: household 30,000, the hidden hobby 15,000, the uncategorized 25,000 and the deleted
    // category's 5,000. August: household 30,000.
    assert.deepEqual(body.unassigned, {
      months: [
        { month: "2026-07", spent: 75 },
        { month: "2026-08", spent: 30 },
      ],
      average: 52.5,
      min: 30,
      max: 75,
    });
  });

  it("adds up, bucket series and unassigned together, to each month's spending", async () => {
    await using h = await spending();
    const body = await h.json("spending_trend", {
      start: "2026-07",
      end: "2026-09",
      buckets: [
        { name: "Groceries", categories: ["Groceries"] },
        { name: "Everyday rest", groups: ["Everyday"] },
      ],
    });
    const monthTotals = await h.json("spending_breakdown", { start: "2026-07", end: "2026-09", group_by: "month" });
    const unassigned = (body.unassigned as { months: Point[] }).months;
    for (const [i, row] of (monthTotals.rows as { name: string; spent: number }[]).entries()) {
      const buckets = (body.series as BucketSeries[]).reduce((sum, series) => sum + series.months[i].spent, 0);
      assert.equal(buckets + unassigned[i].spent, row.spent, `${row.name}: buckets and unassigned vs the month's spending`);
    }
  });

  it("puts bucket series after the category and group series asked for", async () => {
    await using h = await spending();
    const body = await h.json("spending_trend", {
      start: "2026-07",
      end: "2026-08",
      categories: ["Groceries"],
      buckets: [{ name: "Everyday", groups: ["Everyday"] }],
    });
    assert.deepEqual(
      (body.series as { name: string; kind: string }[]).map((s) => [s.name, s.kind]),
      [
        ["Groceries", "category"],
        ["Everyday", "bucket"],
      ],
    );
    // The bucket still reads all spending, not only the categories trended beside it: Everyday is
    // groceries, household, dining and the hidden hobby (127,000 in July, 183,000 in August), and
    // unassigned keeps the mortgage, the uncategorized and the deleted category's lines.
    assert.deepEqual((body.series as BucketSeries[])[1].months, [
      { month: "2026-07", spent: 127 },
      { month: "2026-08", spent: 183 },
    ]);
    assert.deepEqual((body.unassigned as { months: Point[] }).months, [
      { month: "2026-07", spent: 180 },
      { month: "2026-08", spent: 150 },
    ]);
  });

  it("sums a bucket's month in milliunits, so cents do not drift", async () => {
    await using h = await harness({
      budget: spendingBudget({
        months: [],
        subtransactions: [],
        transactions: [
          transaction("x1", "2026-07-05", -12_340, { category_id: "c1" }),
          transaction("x2", "2026-07-06", -5_670, { category_id: "c3" }),
          transaction("x3", "2026-07-07", -100, { category_id: "c2" }),
          transaction("x4", "2026-07-08", -200, { category_id: "c8" }),
        ],
      }),
    });
    const body = await h.json("spending_trend", { start: "2026-07", end: "2026-07", buckets: [{ name: "Food", categories: ["Groceries", "Dining Out"] }] });
    // Added as rendered decimals these would be 18.009999999999998 and 0.30000000000000004.
    assert.equal((body.series as BucketSeries[])[0].months[0].spent, 18.01);
    assert.equal((body.unassigned as { months: Point[] }).months[0].spent, 0.3);
  });

  it("leaves unassigned out when the buckets claim every line", async () => {
    await using h = await spending();
    const body = await h.json("spending_trend", { start: "2026-08", end: "2026-08", buckets: [{ name: "All", groups: ["Everyday", "Housing"] }] });
    assert.equal((body.series as BucketSeries[])[0].average, 333);
    assert.ok(!("unassigned" in body));
  });

  it("flags the partial month in bucket and unassigned series alike", async () => {
    const [previous, current] = [monthFromNow(-1), monthFromNow(0)];
    await using h = await harness({
      budget: spendingBudget({
        first_month: `${previous}-01`,
        months: [],
        subtransactions: [],
        transactions: [
          transaction("x1", `${previous}-05`, -20_000, { category_id: "c1" }),
          transaction("x2", `${current}-01`, -5_000, { category_id: "c1" }),
          transaction("x3", `${current}-01`, -7_000, { category_id: "c2" }),
        ],
      }),
    });
    const body = await h.json("spending_trend", { months: 2, buckets: [{ name: "Food", categories: ["Groceries"] }] });
    assert.deepEqual((body.series as BucketSeries[])[0].months, [
      { month: previous, spent: 20 },
      { month: current, spent: 5, partial: true },
    ]);
    assert.equal((body.series as BucketSeries[])[0].average, 20, "the partial month stays out of the statistics");
    assert.deepEqual(body.unassigned, {
      months: [
        { month: previous, spent: 0 },
        { month: current, spent: 7, partial: true },
      ],
      average: 0,
      min: 0,
      max: 0,
    });
  });

  it("refuses buckets it cannot honour with the same errors as spending_breakdown", async () => {
    await using h = await spending();
    const { text, isError } = await h.call("spending_trend", {
      buckets: [
        { name: "A", categories: ["Groceries"] },
        { name: "B", categories: ["Groceries"] },
      ],
    });
    assert.equal(isError, true);
    assert.equal(text, 'The category Groceries (c1) is in both "A" and "B"; name it in one bucket only.');
  });
});
