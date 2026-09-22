// Runs only when YNAB_ACCESS_TOKEN is set. Read-only: it never writes to the budget.
// Costs four API requests per run against the 200/hour limit (budget list, full, delta, 401 check).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BudgetDb } from "../../src/cache/db.js";
import { BudgetStore } from "../../src/cache/store.js";
import { YnabApiError, YnabClient } from "../../src/ynab/client.js";

const token = process.env.YNAB_ACCESS_TOKEN;
const budgetId = process.env.YNAB_BUDGET_ID?.trim() || null;

describe("YNAB API (live)", { skip: token ? false : "YNAB_ACCESS_TOKEN not set" }, () => {
  it("full sync, then a delta sync that returns the same or newer knowledge", async () => {
    const db = new BudgetDb(":memory:");
    try {
      const client = new YnabClient(token!);
      const store = new BudgetStore({ client, db, configuredBudgetId: budgetId, ttlMs: 0 });

      const budget = await store.ensureFresh();
      assert.equal(store.lastSync?.kind, "full");
      assert.ok(budget.name.length > 0);
      assert.ok(budget.serverKnowledge > 0);
      const summary = db.summary(budget.id);
      assert.ok(summary.accounts > 0, "a real budget has at least one account");
      assert.ok(db.budgetRows().some((b) => b.id === budget.id), "the budget list includes the synced budget");

      const lines = db.transactionLines(budget.id, { limit: 50 });
      for (const line of lines) {
        assert.match(line.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.notEqual(line.accountName, "(unknown account)", "every transaction's account is in the cache");
        if (line.parentId !== null) assert.notEqual(line.parentId, line.id, "a split line points at its parent, not itself");
      }
      if (summary.splitLines > 0) assert.ok(summary.splitParents > 0, "split lines have their parents cached");

      const delta = await store.sync();
      assert.equal(delta.kind, "delta");
      assert.ok(db.budgetRow(budget.id)!.serverKnowledge! >= budget.serverKnowledge);
    } finally {
      db.close();
    }
  });

  it("maps an invalid token to a YnabApiError with status 401", async () => {
    await assert.rejects(
      () => new YnabClient("not-a-real-token").listBudgets(),
      (error: unknown) => error instanceof YnabApiError && error.status === 401,
    );
  });
});
