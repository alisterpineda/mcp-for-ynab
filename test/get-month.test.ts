import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { budgetDetail, month, monthCategory, orientationBudget } from "./fixtures.js";
import { harness } from "./mcp.js";

interface Group {
  name: string;
  assigned: number;
  activity: number;
  available: number;
  categories: Record<string, unknown>[];
}

const groupsOf = (body: Record<string, unknown>): Group[] => body.groups as Group[];

describe("get_month", () => {
  it("reports the month's header totals in YNAB's own words", async () => {
    await using h = await harness();
    const body = await h.json("get_month", { month: "2026-09" });
    assert.equal(body.month, "2026-09");
    assert.equal(body.income, 5086);
    assert.equal(body.assigned, 900);
    assert.equal(body.activity, -412.31);
    assert.equal(body.ready_to_assign, 5086);
    assert.equal(body.age_of_money, 108);
    assert.equal(body.note, "tight month");
  });

  it("nests categories under groups with subtotals that add up to the header", async () => {
    await using h = await harness();
    const body = await h.json("get_month", { month: "2026-09" });
    const groups = groupsOf(body);
    assert.deepEqual(
      groups.map((g) => g.name),
      ["🥘 Food", "🏠 Housing"],
    );

    const food = groups[0];
    assert.equal(food.assigned, 900);
    assert.equal(food.activity, -412.31);
    assert.equal(food.available, 532.69);
    assert.deepEqual(food.categories, [
      { name: "Café", assigned: 300, activity: 0, available: 300 },
      { name: "Groceries", assigned: 600, activity: -412.31, available: 187.69, underfunded: 12.5 },
      { name: "Old hobby", assigned: 0, activity: 0, available: 45, hidden: true },
    ]);

    for (const key of ["assigned", "activity"] as const) {
      const fromRows = groups.flatMap((g) => g.categories).reduce((sum, c) => sum + Number(c[key]), 0);
      const fromGroups = groups.reduce((sum, g) => sum + g[key], 0);
      assert.equal(round(fromRows), round(fromGroups), `rows sum to the group subtotals for ${key}`);
      assert.equal(round(fromGroups), body[key], `group subtotals sum to the header for ${key}`);
    }
  });

  it("keeps a row with only a carried balance, and suppresses the all-zero rows it counts", async () => {
    await using h = await harness();
    const body = await h.json("get_month", { month: "2026-09" });
    const housing = groupsOf(body)[1];
    assert.deepEqual(housing.categories, [{ name: "Rent", assigned: 0, activity: 0, available: 100 }]);
    assert.equal(body.categories_omitted, 2, "Visa and Retired thing are zero on all three figures");
  });

  it("carries underfunded only when there is something to fund", async () => {
    await using h = await harness();
    const food = groupsOf(await h.json("get_month", { month: "2026-09" }))[0];
    assert.equal(food.categories[1].underfunded, 12.5, "Groceries is short");
    assert.ok(!("underfunded" in food.categories[0]), "Café's goal is fully funded");
    assert.ok(!("underfunded" in food.categories[2]), "Old hobby has no goal");
  });

  it("leaves YNAB's internal categories out, so the rows still reconcile with the header", async () => {
    await using h = await harness();
    const { text, isError } = await h.call("get_month", { month: "2026-09" });
    assert.equal(isError, false, "an error result would satisfy every assertion below");
    assert.ok(!text.includes("Inflow: Ready to Assign"));
    assert.ok(!text.includes("Uncategorized"));
  });

  it("emits no ids at all", async () => {
    await using h = await harness();
    const { text, isError } = await h.call("get_month", { month: "2026-09" });
    assert.equal(isError, false, "an error result would satisfy every assertion below");
    assert.ok(!text.includes('"id"'), "get_month is a report, not a lookup table");
    for (const id of ["c1", "c2", "c8", "g1", "g5"]) assert.ok(!text.includes(`"${id}"`), `${id} is not in the response`);
  });

  it("accepts a first-of-month date and reports the month back as YYYY-MM", async () => {
    await using h = await harness();
    assert.deepEqual(await h.json("get_month", { month: "2026-09-01" }), await h.json("get_month", { month: "2026-09" }));
  });

  it("reports a past month", async () => {
    await using h = await harness();
    const body = await h.json("get_month", { month: "2026-08" });
    assert.equal(body.month, "2026-08");
    assert.equal(body.income, 4000);
    assert.equal(body.assigned, 500);
    assert.equal(body.activity, -300);
    assert.ok(!("age_of_money" in body), "the fixture month has none");
    assert.ok(!("note" in body));
    assert.deepEqual(groupsOf(body)[0].categories, [{ name: "Groceries", assigned: 500, activity: -300, available: 200 }]);
  });

  it("reports a future month that has already been assigned to", async () => {
    await using h = await harness();
    const body = await h.json("get_month", { month: "2026-10" });
    assert.equal(body.assigned, 250);
    assert.equal(body.ready_to_assign, 100);
    assert.equal(body.activity, 0);
  });

  it("defaults to the current month", async () => {
    const now = new Date();
    const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const budget = orientationBudget({
      last_month: `${current}-01`,
      months: [month(`${current}-01`, [monthCategory("c1", { budgeted: 111_000, balance: 111_000 })], { budgeted: 111_000 })],
    });
    await using h = await harness({ budget });
    const body = await h.json("get_month");
    assert.equal(body.month, current);
    assert.equal(body.assigned, 111);
  });
});

describe("get_month when the month has no cached row", () => {
  it("errors with the available range for a month outside the budget's history", async () => {
    await using h = await harness();
    const { text, isError } = await h.call("get_month", { month: "2023-05" });
    assert.equal(isError, true);
    assert.match(text, /2023-05/);
    assert.match(text, /2024-01/);
    assert.match(text, /2026-10/);
  });

  it("rejects a month it cannot read", async () => {
    await using h = await harness();
    for (const month of ["September", "2026-13", "2026-00", "26-09"]) {
      const { text, isError } = await h.call("get_month", { month });
      assert.equal(isError, true, month);
      assert.match(text, /YYYY-MM/, month);
    }
  });

  it("forces one resync and retries, which is what a month rollover looks like", async () => {
    await using h = await harness();
    await h.json("get_month", { month: "2026-09" });
    const before = h.source.calls.length;
    h.source.delta = budgetDetail({
      months: [month("2025-05-01", [monthCategory("c1", { budgeted: 70_000, balance: 70_000 })], { budgeted: 70_000 })],
    });

    const body = await h.json("get_month", { month: "2025-05" });
    assert.equal(h.source.calls.length, before + 1, "exactly one extra request to YNAB");
    assert.equal(body.month, "2025-05");
    assert.equal(body.assigned, 70);
    assert.deepEqual(groupsOf(body)[0].categories, [{ name: "Groceries", assigned: 70, activity: 0, available: 70 }]);
  });

  it("still answers for an uncached in-range month when the resync itself fails", async () => {
    await using h = await harness();
    await h.json("get_month", { month: "2026-09" });
    await new Promise((resolve) => setTimeout(resolve, 5)); // so the failure is strictly after the sync
    h.source.fail = new Error("offline");

    const body = await h.json("get_month", { month: "2025-05" });
    assert.equal(body.month, "2025-05");
    assert.match(String(body.status), /no data/i, "a failed retry is not an error, it is an empty month");
    assert.match(String(body.warning), /offline/, "and the envelope says why the figures may be behind");
  });

  it("retries a month past the cached last_month, which is exactly what a rollover is", async () => {
    await using h = await harness();
    await h.json("get_month", { month: "2026-09" });
    const before = h.source.calls.length;
    // The budget grows a month after the cache was written: the cached bound must not refuse it.
    h.source.delta = budgetDetail({
      first_month: "2024-01-01",
      last_month: "2026-11-01",
      months: [month("2026-11-01", [monthCategory("c1", { budgeted: 80_000, balance: 80_000 })], { budgeted: 80_000 })],
    });

    const body = await h.json("get_month", { month: "2026-11" });
    assert.equal(h.source.calls.length, before + 1, "exactly one extra request to YNAB");
    assert.equal(body.month, "2026-11");
    assert.equal(body.assigned, 80);
  });

  it("says plainly that YNAB has no data yet rather than showing a page of zeroes as an answer", async () => {
    await using h = await harness();
    const body = await h.json("get_month", { month: "2025-05" });
    assert.equal(body.month, "2025-05");
    assert.equal(body.income, 0);
    assert.equal(body.assigned, 0);
    assert.equal(body.activity, 0);
    assert.equal(body.ready_to_assign, 0);
    assert.equal(body.categories_omitted, 0);
    assert.deepEqual(body.groups, []);
    assert.match(String(body.status), /no data/i);
    assert.ok(!("note" in body), "`note` is the owner's month note, never our own sentence");
  });
});

describe("get_month refresh", () => {
  it("pulls from YNAB before answering", async () => {
    await using h = await harness();
    await h.json("get_month", { month: "2026-09" });
    const before = h.source.calls.length;
    await h.json("get_month", { month: "2026-09", refresh: true });
    assert.equal(h.source.calls.length, before + 1);
    await h.json("get_month", { month: "2026-09" });
    assert.equal(h.source.calls.length, before + 1, "without refresh the cache is still fresh");
  });

  it("does not sync twice when the month it then misses is uncached", async () => {
    await using h = await harness();
    await h.json("get_month", { month: "2026-09" });
    const before = h.source.calls.length;
    await h.json("get_month", { month: "2025-05", refresh: true });
    assert.equal(h.source.calls.length, before + 1, "the forced sync already happened; the miss must not force a second");
  });

  it("is offered by no other tool", async () => {
    await using h = await harness();
    const tools = (await h.client.listTools()).tools;
    const refreshable = tools
      .filter((tool) => Object.hasOwn((tool.inputSchema.properties ?? {}) as object, "refresh"))
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(refreshable, ["get_month", "sync_status"], "sync_status is a health report, not an orientation tool");
  });
});

/** Cents, to compare a sum of rendered amounts against a rendered total without float noise. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
