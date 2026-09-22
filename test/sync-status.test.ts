import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BudgetDb } from "../src/cache/db.js";
import { BudgetStore } from "../src/cache/store.js";
import { renderStatus } from "../src/tools/sync-status.js";
import { BUDGET_ID, FakeBudgetSource } from "./fixtures.js";

describe("renderStatus", () => {
  function makeStore(client: FakeBudgetSource, budgetId: string | null = null) {
    return new BudgetStore({ client, db: new BudgetDb(":memory:"), configuredBudgetId: budgetId, ttlMs: 0 });
  }

  it("describes a fresh full sync", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client);
    const budget = await store.ensureFresh();
    const lines = renderStatus(store, budget, store.lastSync);
    assert.equal(lines[0], "Budget: Household");
    assert.match(lines[2], /^Last sync this session: full \(full download, \d+ records/);
    assert.ok(lines.includes("Transactions: 3 (1 splits, 3 split lines)"), lines.join("\n"));
    assert.ok(lines.includes("Date range: 2026-08-01 to 2026-09-12"));
    assert.ok(lines.includes("Budget months: 2024-01 to 2026-09 (1 cached)"));
    assert.ok(lines.includes("Accounts: 2 (1 open) · Categories: 2 · Payees: 2"));
    assert.ok(lines.includes("Currency: USD"));
    assert.ok(lines.includes("Cache file: :memory: (server knowledge 10)"));
    assert.ok(lines.includes("YNAB API usage this hour: 1/200"));
    assert.ok(!lines.some((l) => l.startsWith("Last sync attempt failed")));
    assert.ok(!lines.some((l) => l.startsWith("Other budgets")));
  });

  it("reports an empty delta as no changes", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client);
    await store.ensureFresh();
    const budget = await store.ensureFresh();
    const lines = renderStatus(store, budget, store.lastSync);
    assert.match(lines[2], /^Last sync this session: delta \(no changes, \d+ ms\)$/);
  });

  it("surfaces the failure reason when the latest sync failed", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client);
    await store.ensureFresh();
    await new Promise((resolve) => setTimeout(resolve, 5)); // so the failure is strictly after the sync
    client.fail = new Error("offline");
    const budget = await store.ensureFresh();
    const lines = renderStatus(store, budget, store.lastSync);
    assert.ok(lines.includes("Last sync attempt failed: offline"), lines.join("\n"));
  });

  it("lists the other budgets on the account", async () => {
    const client = new FakeBudgetSource();
    client.budgetList = {
      budgets: [
        { id: BUDGET_ID, name: "Household" },
        { id: "budget-2", name: "Business" },
      ],
      defaultBudget: null,
    };
    const store = makeStore(client, BUDGET_ID);
    const budget = await store.ensureFresh();
    const lines = renderStatus(store, budget, store.lastSync);
    assert.equal(lines.at(-1), 'Other budgets: "Business" (budget-2, not synced) — set Budget ID to switch', lines.join("\n"));
  });
});
