import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCache } from "../src/cache/delta.js";
import type { BudgetStore, SyncFailure } from "../src/cache/store.js";
import { formatAge, freshnessLine } from "../src/freshness.js";
import { budgetDetail } from "./fixtures.js";

const SYNCED = new Date("2026-09-21T14:00:00Z");
const NOW = new Date("2026-09-21T14:05:00Z");

/** A stand-in for the store: `freshnessLine` only reads `failedSinceLastSync`. */
function storeWith(failure: SyncFailure | null): BudgetStore {
  const cache = buildCache(budgetDetail(), 1, SYNCED);
  const stale = failure && failure.at.getTime() > Date.parse(cache.lastSyncedAt) ? failure : null;
  return { failedSinceLastSync: stale } as unknown as BudgetStore;
}

describe("freshnessLine", () => {
  const cache = buildCache(budgetDetail(), 1, SYNCED);

  it("reports the sync time when the latest sync succeeded", () => {
    assert.match(freshnessLine(storeWith(null), cache, NOW), /^Data as of .*\.$/);
    assert.doesNotMatch(freshnessLine(storeWith(null), cache, NOW), /failed|rate limit/);
  });

  it("says the latest sync failed when the failure is newer than the data", () => {
    const failure = { at: new Date("2026-09-21T14:04:00Z"), message: "offline", rateLimited: false };
    assert.match(freshnessLine(storeWith(failure), cache, NOW), /latest sync failed; showing the last successful sync/);
  });

  it("distinguishes a rate-limited failure", () => {
    const failure = { at: new Date("2026-09-21T14:04:00Z"), message: "429", rateLimited: true };
    assert.match(freshnessLine(storeWith(failure), cache, NOW), /rate limit hit/);
  });

  it("ignores a failure older than the last successful sync", () => {
    const failure = { at: new Date("2026-09-21T13:00:00Z"), message: "offline", rateLimited: false };
    assert.doesNotMatch(freshnessLine(storeWith(failure), cache, NOW), /failed/);
  });
});

describe("formatAge", () => {
  it("switches units at 60 s, 60 min and 48 h", () => {
    assert.equal(formatAge(59_000), "59s ago");
    assert.equal(formatAge(60_000), "1 min ago");
    assert.equal(formatAge(59 * 60_000), "59 min ago");
    assert.equal(formatAge(60 * 60_000), "1 h ago");
    assert.equal(formatAge(47 * 3_600_000), "47 h ago");
    assert.equal(formatAge(48 * 3_600_000), "2 days ago");
  });
});
