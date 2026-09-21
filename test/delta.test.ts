import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyDelta, buildCache } from "../src/cache/delta.js";
import { CACHE_SCHEMA_VERSION } from "../src/cache/schema.js";
import { category, fullPlan, month, planDetail, subtransaction, transaction } from "./fixtures.js";

const NOW = new Date("2026-09-21T14:00:00Z");

describe("buildCache", () => {
  it("indexes every entity list by id and months by date", () => {
    const cache = buildCache(fullPlan(), 10, NOW);
    assert.equal(cache.schemaVersion, CACHE_SCHEMA_VERSION);
    assert.equal(cache.budget.name, "Household");
    assert.equal(cache.budget.currencyFormat?.iso_code, "USD");
    assert.equal(cache.serverKnowledge, 10);
    assert.equal(cache.lastSyncedAt, NOW.toISOString());
    assert.equal(cache.lastFullSyncAt, NOW.toISOString());
    assert.deepEqual(Object.keys(cache.transactions).sort(), ["t1", "t2", "t3"]);
    assert.deepEqual(Object.keys(cache.subtransactions).sort(), ["s1", "s2", "s3"]);
    assert.deepEqual(Object.keys(cache.months), ["2026-09-01"]);
    assert.equal(Object.keys(cache.accounts).length, 2);
  });

  it("tolerates a plan with no lists at all", () => {
    const cache = buildCache(planDetail(), 1, NOW);
    assert.deepEqual(cache.transactions, {});
    assert.deepEqual(cache.months, {});
  });
});

describe("applyDelta", () => {
  it("upserts changed entities and removes deleted ones", () => {
    const cache = buildCache(fullPlan(), 10, NOW);
    const later = new Date("2026-09-21T15:00:00Z");
    const stats = applyDelta(
      cache,
      planDetail({
        transactions: [
          transaction("t3", "2026-08-01", -5_000, { deleted: true }),
          transaction("t1", "2026-09-10", -12_000),
          transaction("t4", "2026-09-20", -7_000),
        ],
        subtransactions: [subtransaction("s1", "t2", 0, { deleted: true })],
      }),
      11,
      later,
    );

    assert.deepEqual(stats, { upserted: 2, deleted: 2 });
    assert.equal(cache.serverKnowledge, 11);
    assert.equal(cache.lastSyncedAt, later.toISOString());
    assert.equal(cache.lastFullSyncAt, NOW.toISOString(), "full-sync time is untouched by a delta");
    assert.ok(!("t3" in cache.transactions));
    assert.ok(!("s1" in cache.subtransactions));
    assert.equal(cache.transactions.t1.amount, -12_000);
    assert.equal(cache.transactions.t4.date, "2026-09-20");
  });

  it("does not count deleting an unknown entity", () => {
    const cache = buildCache(fullPlan(), 10, NOW);
    const stats = applyDelta(cache, planDetail({ transactions: [transaction("never", "2026-01-01", 0, { deleted: true })] }), 11, NOW);
    assert.deepEqual(stats, { upserted: 0, deleted: 0 });
  });

  it("merges a delta month's categories into the stored month", () => {
    const cache = buildCache(fullPlan(), 10, NOW);
    applyDelta(
      cache,
      planDetail({
        months: [month("2026-09-01", [category("c1", "Groceries", { budgeted: 120_000 })], { to_be_budgeted: 5_000 })],
      }),
      11,
      NOW,
    );
    const stored = cache.months["2026-09-01"];
    assert.equal(stored.to_be_budgeted, 5_000);
    assert.equal(stored.categories.length, 2, "untouched category survives the merge");
    assert.equal(stored.categories.find((c) => c.id === "c1")?.budgeted, 120_000);
    assert.equal(stored.categories.find((c) => c.id === "c2")?.budgeted, 50_000);
  });

  it("removes a category from a month and removes whole months", () => {
    const cache = buildCache(fullPlan(), 10, NOW);
    applyDelta(cache, planDetail({ months: [month("2026-09-01", [category("c2", "Household", { deleted: true })])] }), 11, NOW);
    assert.deepEqual(cache.months["2026-09-01"].categories.map((c) => c.id), ["c1"]);

    applyDelta(cache, planDetail({ months: [month("2026-09-01", [], { deleted: true })] }), 12, NOW);
    assert.deepEqual(cache.months, {});
  });

  it("updates budget metadata such as a renamed budget", () => {
    const cache = buildCache(fullPlan(), 10, NOW);
    applyDelta(cache, planDetail({ name: "Household 2027", last_month: "2027-01-01" }), 11, NOW);
    assert.equal(cache.budget.name, "Household 2027");
    assert.equal(cache.budget.lastMonth, "2027-01-01");
  });
});
