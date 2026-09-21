// Runs only when YNAB_ACCESS_TOKEN is set. Read-only: it never writes to the budget.
// Costs three API requests per run against the 200/hour limit.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { BudgetStore } from "../../src/cache/store.js";
import { CacheStorage } from "../../src/cache/storage.js";
import { flattenTransactions } from "../../src/cache/views.js";
import { YnabApiError, YnabClient } from "../../src/ynab/client.js";

const token = process.env.YNAB_ACCESS_TOKEN;
const budgetId = process.env.YNAB_BUDGET_ID?.trim() || null;

describe("YNAB API (live)", { skip: token ? false : "YNAB_ACCESS_TOKEN not set" }, () => {
  it("full sync, then a delta sync that returns the same or newer knowledge", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ynab-mcp-live-"));
    try {
      const client = new YnabClient(token!);
      const store = new BudgetStore({ client, storage: new CacheStorage(dir), configuredBudgetId: budgetId, ttlMs: 0 });

      const cache = await store.ensureFresh();
      assert.equal(store.lastSync?.kind, "full");
      assert.ok(cache.budget.name.length > 0);
      assert.ok(cache.serverKnowledge > 0);
      assert.ok(Object.keys(cache.accounts).length > 0, "a real budget has at least one account");

      const lines = flattenTransactions(cache);
      for (const line of lines.slice(0, 50)) {
        assert.match(line.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.notEqual(line.accountName, "(unknown account)", "every transaction's account is in the cache");
      }
      for (const sub of Object.values(cache.subtransactions)) {
        assert.ok(sub.transaction_id in cache.transactions, "every split line has its parent cached");
      }

      const before = cache.serverKnowledge;
      const delta = await store.sync();
      assert.equal(delta.kind, "delta");
      assert.ok(cache.serverKnowledge >= before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps an invalid token to a YnabApiError with status 401", async () => {
    await assert.rejects(
      () => new YnabClient("not-a-real-token").listBudgets(),
      (error: unknown) => error instanceof YnabApiError && error.status === 401,
    );
  });
});
