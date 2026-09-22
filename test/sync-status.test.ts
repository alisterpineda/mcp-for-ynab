import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BudgetDb } from "../src/cache/db.js";
import { BudgetStore } from "../src/cache/store.js";
import { renderStatus } from "../src/tools/sync-status.js";
import { YnabApiError } from "../src/ynab/client.js";
import { BUDGET_ID, FakeBudgetSource } from "./fixtures.js";
import { harness } from "./mcp.js";

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

describe("the sync_status tool", () => {
  it("re-downloads the whole budget on full_resync, rather than asking for a delta", async () => {
    await using h = await harness();
    h.source.delta = h.source.full;
    await h.json("list_accounts"); // the first sync is the full download
    await h.call("sync_status", { refresh: true }); // from here an ordinary sync is a delta
    assert.notEqual(h.source.calls.at(-1)?.knowledge, undefined, "the next ordinary sync would be a delta");

    const { isError } = await h.call("sync_status", { full_resync: true });
    assert.equal(isError, false);
    assert.equal(h.source.calls.at(-1)?.knowledge, undefined, "full_resync must ask YNAB for everything, not for changes");
    assert.equal(h.db.summary(BUDGET_ID).accounts, 4, "and the cache is rebuilt, not left empty");
  });

  it("keeps answering from the cache when full_resync cannot reach YNAB, and says so", async () => {
    await using h = await harness();
    await h.json("list_accounts");
    h.source.fail = new YnabApiError("YNAB API 429: Too Many Requests", 429);

    const { text, isError } = await h.call("sync_status", { full_resync: true });
    assert.equal(isError, false, text);
    assert.match(text, /Last sync attempt failed: YNAB API 429/);
    assert.match(text, /showing the last successful sync/);

    const accounts = await h.json("list_accounts");
    assert.match(String(accounts.warning), /rate limit/, "the other tools still answer, flagged stale");
    assert.equal(h.db.summary(BUDGET_ID).accounts, 4);
  });

  it("asks only for the changes on a plain refresh", async () => {
    await using h = await harness();
    await h.json("list_accounts");
    const { isError } = await h.call("sync_status", { refresh: true });
    assert.equal(isError, false);
    assert.notEqual(h.source.calls.at(-1)?.knowledge, undefined);
  });
});
