import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildCache } from "../src/cache/delta.js";
import { BudgetStore } from "../src/cache/store.js";
import { CacheStorage } from "../src/cache/storage.js";
import { YnabApiError } from "../src/ynab/client.js";
import { FakeBudgetSource, BUDGET_ID, budgetDetail, transaction } from "./fixtures.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ynab-mcp-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeStore(client: FakeBudgetSource, options: { ttlMs?: number; budgetId?: string | null } = {}) {
  return new BudgetStore({
    client,
    storage: new CacheStorage(dir),
    configuredBudgetId: options.budgetId ?? null,
    ttlMs: options.ttlMs ?? 60_000,
  });
}

describe("BudgetStore.ensureFresh", () => {
  it("does a full sync when there is no cache, resolving the default budget", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client);
    const cache = await store.ensureFresh();
    assert.deepEqual(client.calls, [{ budgetId: BUDGET_ID, knowledge: undefined }]);
    assert.equal(store.lastSync?.kind, "full");
    assert.equal(cache.serverKnowledge, 10);
    assert.equal(Object.keys(cache.transactions).length, 3);
  });

  it("answers from memory within the TTL and syncs a delta once stale", async () => {
    const client = new FakeBudgetSource();
    client.delta = budgetDetail({ transactions: [transaction("t9", "2026-09-21", -1_000)] });
    const store = makeStore(client, { ttlMs: 60_000 });
    await store.ensureFresh();
    await store.ensureFresh();
    assert.equal(client.calls.length, 1, "second call inside TTL does not hit the network");

    const stale = makeStore(client, { ttlMs: 0 });
    const cache = await stale.ensureFresh();
    assert.equal(client.calls.length, 2);
    assert.deepEqual(client.calls[1], { budgetId: BUDGET_ID, knowledge: 10 });
    assert.equal(stale.lastSync?.kind, "delta");
    assert.equal(cache.serverKnowledge, 11);
    assert.ok("t9" in cache.transactions);
  });

  it("forces a sync with { force: true }", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client);
    await store.ensureFresh();
    await store.ensureFresh({ force: true });
    assert.equal(client.calls.length, 2);
  });

  it("fails soft when a sync fails and a cache exists", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client, { ttlMs: 0 });
    await store.ensureFresh();
    client.fail = new YnabApiError("YNAB API 429: Too Many Requests", 429);
    const cache = await store.ensureFresh();
    assert.equal(cache.serverKnowledge, 10, "stale cache is returned");
    assert.equal(store.lastFailure?.rateLimited, true);
    assert.match(store.lastFailure!.message, /429/);
  });

  it("clears the recorded failure after the next successful sync", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client, { ttlMs: 0 });
    await store.ensureFresh();
    client.fail = new Error("offline");
    await store.ensureFresh();
    assert.ok(store.lastFailure);
    client.fail = null;
    await store.ensureFresh();
    assert.equal(store.lastFailure, null);
  });

  it("throws when there is no cache and YNAB is unreachable", async () => {
    const client = new FakeBudgetSource();
    client.fail = new Error("offline");
    await assert.rejects(() => makeStore(client).ensureFresh(), /offline/);
  });

  it("shares one in-flight sync between concurrent callers", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client);
    await Promise.all([store.ensureFresh(), store.ensureFresh(), store.sync()]);
    assert.equal(client.calls.length, 1);
  });
});

describe("BudgetStore persistence", () => {
  it("writes the cache to disk and a new store resumes from the stored knowledge", async () => {
    const client = new FakeBudgetSource();
    await makeStore(client).ensureFresh();

    const client2 = new FakeBudgetSource();
    const store2 = makeStore(client2, { ttlMs: 0 });
    const cache = await store2.ensureFresh();
    assert.deepEqual(client2.calls, [{ budgetId: BUDGET_ID, knowledge: 10 }]);
    assert.equal(cache.serverKnowledge, 11);
  });

  it("concurrent first calls on a fresh process both wait for the disk load and sync a delta", async () => {
    await makeStore(new FakeBudgetSource()).ensureFresh();

    // Mirrors startup: a background ensureFresh() and a forced tool-call sync racing on a cold store.
    const client = new FakeBudgetSource();
    const store = makeStore(client, { ttlMs: 0 });
    await Promise.all([store.ensureFresh(), store.ensureFresh({ force: true })]);
    assert.deepEqual(client.calls, [{ budgetId: BUDGET_ID, knowledge: 10 }], "one delta sync, never a full download");
    assert.equal(store.lastSync?.kind, "delta");
  });

  it("discards a corrupt cache file and does a full sync", async () => {
    await writeFile(path.join(dir, "cache.json"), "{not json");
    const client = new FakeBudgetSource();
    const cache = await makeStore(client).ensureFresh();
    assert.deepEqual(client.calls, [{ budgetId: BUDGET_ID, knowledge: undefined }]);
    assert.equal(cache.serverKnowledge, 10);
  });

  it("discards a cache with an older schema version", async () => {
    await makeStore(new FakeBudgetSource()).ensureFresh();
    const file = path.join(dir, "cache.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    saved.schemaVersion = saved.schemaVersion - 1;
    await writeFile(file, JSON.stringify(saved));

    const client = new FakeBudgetSource();
    await makeStore(client).ensureFresh();
    assert.deepEqual(client.calls, [{ budgetId: BUDGET_ID, knowledge: undefined }]);
  });

  it("discards a cache for a different budget than the one configured", async () => {
    await makeStore(new FakeBudgetSource()).ensureFresh();
    const client = new FakeBudgetSource();
    await makeStore(client, { budgetId: "another-budget" }).ensureFresh();
    assert.deepEqual(client.calls, [{ budgetId: "another-budget", knowledge: undefined }]);
  });

  it("fullResync discards the cache and downloads everything again", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client);
    await store.ensureFresh();
    const result = await store.fullResync();
    assert.equal(result.kind, "full");
    assert.deepEqual(
      client.calls.map((c) => c.knowledge),
      [undefined, undefined],
    );
  });

  it("uses the only budget when YNAB reports no default", async () => {
    const client = new FakeBudgetSource();
    client.budgetList = { budgets: [{ id: BUDGET_ID, name: "Household" }], defaultBudget: null };
    await makeStore(client).ensureFresh();
    assert.deepEqual(client.calls, [{ budgetId: BUDGET_ID, knowledge: undefined }]);
  });

  it("refuses to guess between several budgets when none is default", async () => {
    const client = new FakeBudgetSource();
    client.budgetList = {
      budgets: [
        { id: BUDGET_ID, name: "Household" },
        { id: "budget-2", name: "Business" },
      ],
      defaultBudget: null,
    };
    await assert.rejects(makeStore(client).ensureFresh(), /YNAB_BUDGET_ID.*budget-1.*budget-2/);
    assert.equal(client.calls.length, 0);
  });

  it("fullResync waits for an in-flight delta instead of joining it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class SlowSource extends FakeBudgetSource {
      override async getBudget(budgetId: string, knowledge?: number) {
        if (knowledge !== undefined) await gate;
        return super.getBudget(budgetId, knowledge);
      }
    }
    const client = new SlowSource();
    const store = makeStore(client, { ttlMs: 0 });
    await store.ensureFresh();
    const warmup = store.ensureFresh(); // delta, blocked on the gate
    const resync = store.fullResync();
    release();
    await warmup;
    const result = await resync;
    assert.equal(result.kind, "full");
    assert.deepEqual(
      client.calls.map((c) => c.knowledge),
      [undefined, 10, undefined],
    );
  });

  it("does not rewrite the cache file after an empty delta", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client, { ttlMs: 0 });
    await store.ensureFresh();
    const file = path.join(dir, "cache.json");
    const { mtimeMs } = await stat(file);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.ensureFresh();
    assert.equal(store.lastSync?.kind, "delta");
    assert.equal((await stat(file)).mtimeMs, mtimeMs);
  });

  it("leaves no temp files behind after saving", async () => {
    await makeStore(new FakeBudgetSource()).ensureFresh();
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(dir), ["cache.json"]);
  });

  it("cleans up its temp file when the rename fails", async () => {
    await mkdir(path.join(dir, "cache.json")); // a directory in the way makes the rename fail
    await assert.rejects(new CacheStorage(dir).save(buildCache(budgetDetail(), 1, new Date())));
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(dir), ["cache.json"], "no *.tmp left behind");
  });
});
