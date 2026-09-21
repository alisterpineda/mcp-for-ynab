import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BudgetStore } from "../src/cache/store.js";
import { CacheStorage } from "../src/cache/storage.js";
import { renderStatus } from "../src/tools/sync-status.js";
import { FakeBudgetSource } from "./fixtures.js";

describe("renderStatus", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ynab-mcp-status-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeStore(client: FakeBudgetSource) {
    return new BudgetStore({ client, storage: new CacheStorage(dir), configuredBudgetId: null, ttlMs: 0 });
  }

  it("describes a fresh full sync", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client);
    const cache = await store.ensureFresh();
    const lines = renderStatus(store, cache, store.lastSync);
    assert.equal(lines[0], "Budget: Household");
    assert.match(lines[2], /^Last sync this session: full \(full download, \d+ records/);
    assert.ok(lines.includes("Transactions: 3 (1 splits, 3 split lines)"), lines.join("\n"));
    assert.ok(lines.includes("Date range: 2026-08-01 to 2026-09-12"));
    assert.ok(lines.includes("Accounts: 2 (1 open) · Categories: 2 · Payees: 2"));
    assert.ok(lines.includes("YNAB API usage this hour: 1/200"));
    assert.ok(!lines.some((l) => l.startsWith("Last sync attempt failed")));
  });

  it("reports an empty delta as no changes", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client);
    await store.ensureFresh();
    const cache = await store.ensureFresh();
    const lines = renderStatus(store, cache, store.lastSync);
    assert.match(lines[2], /^Last sync this session: delta \(no changes, \d+ ms\)$/);
  });

  it("surfaces the failure reason when the latest sync failed", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client);
    await store.ensureFresh();
    await new Promise((resolve) => setTimeout(resolve, 5)); // so the failure is strictly after the sync
    client.fail = new Error("offline");
    const cache = await store.ensureFresh();
    const lines = renderStatus(store, cache, store.lastSync);
    assert.ok(lines.includes("Last sync attempt failed: offline"), lines.join("\n"));
  });
});
