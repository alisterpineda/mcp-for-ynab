import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BudgetDb } from "../src/cache/db.js";
import { BudgetStore } from "../src/cache/store.js";
import { YnabApiError } from "../src/ynab/client.js";
import { FakeBudgetSource, BUDGET_ID, budgetDetail, transaction } from "./fixtures.js";

function makeStore(client: FakeBudgetSource, options: { ttlMs?: number; budgetId?: string | null; db?: BudgetDb } = {}) {
  return new BudgetStore({
    client,
    db: options.db ?? new BudgetDb(":memory:"),
    configuredBudgetId: options.budgetId ?? null,
    ttlMs: options.ttlMs ?? 60_000,
  });
}

describe("BudgetStore.ensureFresh", () => {
  it("does a full sync when there is no cache, resolving the default budget", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client);
    const budget = await store.ensureFresh();
    assert.deepEqual(client.calls, [{ budgetId: BUDGET_ID, knowledge: undefined }]);
    assert.equal(store.lastSync?.kind, "full");
    assert.equal(budget.id, BUDGET_ID);
    assert.equal(budget.name, "Household");
    assert.equal(budget.serverKnowledge, 10);
    assert.equal(store.db.summary(BUDGET_ID).transactions, 3);
    assert.equal(store.db.activeBudgetId(), BUDGET_ID, "the chosen budget is remembered");
  });

  it("answers from the cache within the TTL and syncs a delta once stale", async () => {
    const client = new FakeBudgetSource();
    client.delta = budgetDetail({ transactions: [transaction("t9", "2026-09-21", -1_000)] });
    const store = makeStore(client, { ttlMs: 60_000 });
    await store.ensureFresh();
    await store.ensureFresh();
    assert.equal(client.calls.length, 1, "second call inside TTL does not hit the network");

    const stale = makeStore(client, { ttlMs: 0, db: store.db });
    const budget = await stale.ensureFresh();
    assert.equal(client.calls.length, 2);
    assert.deepEqual(client.calls[1], { budgetId: BUDGET_ID, knowledge: 10 });
    assert.equal(stale.lastSync?.kind, "delta");
    assert.equal(budget.serverKnowledge, 11);
    assert.ok(stale.db.transactionLines(BUDGET_ID).some((l) => l.id === "t9"));
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
    const budget = await store.ensureFresh();
    assert.equal(budget.serverKnowledge, 10, "stale cache is returned");
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

  it("throws when there is no cache and YNAB is unreachable, then retries once it is back", async () => {
    const client = new FakeBudgetSource();
    client.fail = new Error("offline");
    const store = makeStore(client);
    await assert.rejects(() => store.ensureFresh(), /offline/);
    assert.match(store.lastFailure!.message, /offline/);

    client.fail = null;
    const budget = await store.ensureFresh();
    assert.equal(budget.id, BUDGET_ID, "the failed budget resolution is not memoized");
    assert.equal(client.listCalls, 2);
    assert.equal(store.lastFailure, null);
  });

  it("shares one in-flight sync between concurrent callers", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client);
    await Promise.all([store.ensureFresh(), store.ensureFresh(), store.sync()]);
    assert.equal(client.calls.length, 1);
  });
});

describe("BudgetStore persistence and budget selection", () => {
  it("a new store resumes from the stored knowledge", async () => {
    const db = new BudgetDb(":memory:");
    const client = new FakeBudgetSource();
    await makeStore(client, { db }).ensureFresh();

    const client2 = new FakeBudgetSource();
    const store2 = makeStore(client2, { ttlMs: 0, db });
    const budget = await store2.ensureFresh();
    assert.deepEqual(client2.calls, [{ budgetId: BUDGET_ID, knowledge: 10 }]);
    assert.equal(budget.serverKnowledge, 11);
  });

  it("concurrent first calls on a fresh process sync one delta, never a full download", async () => {
    const db = new BudgetDb(":memory:");
    await makeStore(new FakeBudgetSource(), { db }).ensureFresh();

    // Mirrors startup: a background ensureFresh() and a forced tool-call sync racing on a cold store.
    const client = new FakeBudgetSource();
    const store = makeStore(client, { ttlMs: 0, db });
    await Promise.all([store.ensureFresh(), store.ensureFresh({ force: true })]);
    assert.deepEqual(client.calls, [{ budgetId: BUDGET_ID, knowledge: 10 }]);
    assert.equal(store.lastSync?.kind, "delta");
  });

  it("syncs the configured budget in full and keeps the other budget's cache", async () => {
    const db = new BudgetDb(":memory:");
    await makeStore(new FakeBudgetSource(), { db }).ensureFresh();
    const client = new FakeBudgetSource();
    const budget = await makeStore(client, { budgetId: "another-budget", db }).ensureFresh();
    assert.deepEqual(client.calls, [{ budgetId: "another-budget", knowledge: undefined }]);
    assert.equal(budget.id, "another-budget");
    assert.equal(db.budgetRow(BUDGET_ID)?.serverKnowledge, 10, "the other budget keeps its knowledge");
    assert.equal(db.summary(BUDGET_ID).transactions, 3);
  });

  it("fullResync downloads everything again and replaces the cache with it", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client);
    await store.ensureFresh();
    // YNAB's copy has lost a transaction without a delta ever saying so: only a replacement drops it.
    client.full = { ...client.full, transactions: client.full.transactions!.filter((t) => t.id !== "t3") };
    const result = await store.fullResync();
    assert.equal(result.kind, "full");
    assert.deepEqual(
      client.calls.map((c) => c.knowledge),
      [undefined, undefined],
    );
    assert.equal(store.db.summary(BUDGET_ID).transactions, 2);
  });

  it("counts a failure in the same millisecond as the last sync as a failure", async () => {
    const store = makeStore(new FakeBudgetSource());
    const budget = await store.ensureFresh();
    // A fast failure right after a success can share its millisecond; it still came after it.
    store.lastFailure = { at: new Date(budget.lastSyncedAt), message: "offline", rateLimited: false };
    assert.equal(store.failedSinceLastSync?.message, "offline");
    // A sync time written later, by another process sharing the file, does outrank it.
    store.lastFailure = { at: new Date(Date.parse(budget.lastSyncedAt) - 1), message: "offline", rateLimited: false };
    assert.equal(store.failedSinceLastSync, null);
  });

  it("a fullResync that cannot reach YNAB keeps the cache it was going to replace", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client);
    await store.ensureFresh();
    client.fail = new YnabApiError("YNAB API 429: Too Many Requests", 429);
    await assert.rejects(store.fullResync(), /429/);
    assert.equal(store.db.summary(BUDGET_ID).transactions, 3);
    assert.equal(store.db.budgetRow(BUDGET_ID)?.serverKnowledge, 10, "and it can still be delta-synced");

    const budget = await store.ensureFresh({ full: true });
    assert.equal(budget.id, BUDGET_ID, "ensureFresh fails soft on a full resync like on any other sync");
    assert.equal(store.lastFailure?.rateLimited, true);
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
    const store = makeStore(client);
    await assert.rejects(store.ensureFresh(), /YNAB_BUDGET_ID.*budget-1.*budget-2/);
    assert.equal(client.calls.length, 0);
    assert.equal(store.db.budgetRows().length, 2, "the list is still recorded");
  });

  it("switches to YNAB's new default budget when none is configured", async () => {
    const db = new BudgetDb(":memory:");
    await makeStore(new FakeBudgetSource(), { db }).ensureFresh();

    const client = new FakeBudgetSource(budgetDetail({ id: "budget-2", name: "Business" }));
    const business = { id: "budget-2", name: "Business" };
    client.budgetList = { budgets: [{ id: BUDGET_ID, name: "Household" }, business], defaultBudget: business };
    const store = makeStore(client, { ttlMs: 0, db });
    const budget = await store.ensureFresh();
    assert.deepEqual(client.calls, [{ budgetId: "budget-2", knowledge: undefined }]);
    assert.equal(budget.name, "Business");
    assert.equal(db.activeBudgetId(), "budget-2");
    assert.equal(db.budgetRow(BUDGET_ID)?.serverKnowledge, 10, "the previous budget stays cached");
  });

  it("keeps serving the previous budget when the new default cannot be downloaded", async () => {
    const db = new BudgetDb(":memory:");
    await makeStore(new FakeBudgetSource(), { db }).ensureFresh();

    const business = { id: "budget-2", name: "Business" };
    class ListOnlySource extends FakeBudgetSource {
      override async getBudget(budgetId: string, knowledge?: number) {
        if (budgetId !== business.id) return super.getBudget(budgetId, knowledge);
        this.calls.push({ budgetId, knowledge });
        throw new YnabApiError("YNAB API 429: Too Many Requests", 429);
      }
    }
    const client = new ListOnlySource();
    client.budgetList = { budgets: [{ id: BUDGET_ID, name: "Household" }, business], defaultBudget: business };
    const store = makeStore(client, { ttlMs: 0, db });
    const budget = await store.ensureFresh();
    assert.equal(budget.id, BUDGET_ID, "fails soft on the budget that is still cached");
    assert.equal(budget.serverKnowledge, 10);
    assert.equal(store.lastFailure?.rateLimited, true);
    assert.equal(db.activeBudgetId(), BUDGET_ID, "the switch is not persisted until the new budget has synced");
    assert.deepEqual(client.calls, [{ budgetId: "budget-2", knowledge: undefined }], "the new default is what gets tried");
  });

  it("fullResync replaces the budget it downloads when YNAB's default changed", async () => {
    const db = new BudgetDb(":memory:");
    await makeStore(new FakeBudgetSource(), { db }).ensureFresh();

    const client = new FakeBudgetSource(budgetDetail({ id: "budget-2", name: "Business" }));
    const business = { id: "budget-2", name: "Business" };
    client.budgetList = { budgets: [{ id: BUDGET_ID, name: "Household" }, business], defaultBudget: business };
    const store = makeStore(client, { ttlMs: 0, db });
    const result = await store.fullResync();
    assert.equal(result.kind, "full");
    assert.deepEqual(client.calls, [{ budgetId: "budget-2", knowledge: undefined }]);
    assert.equal(db.budgetRow(BUDGET_ID)?.serverKnowledge, 10, "the previous budget is not the one replaced");
    assert.equal(db.summary(BUDGET_ID).transactions, 3);
    assert.equal(db.activeBudgetId(), "budget-2");
  });

  it("keeps the pinned budget when the list request fails but it is already synced", async () => {
    const db = new BudgetDb(":memory:");
    await makeStore(new FakeBudgetSource(), { db, budgetId: BUDGET_ID }).ensureFresh();

    const client = new FakeBudgetSource();
    client.fail = new Error("offline");
    const store = makeStore(client, { ttlMs: 0, db, budgetId: BUDGET_ID });
    const budget = await store.ensureFresh();
    assert.equal(budget.serverKnowledge, 10);
    assert.equal(client.listCalls, 1);
    assert.equal(client.calls.length, 0, "the budget request is never made when the list fails");
    assert.match(store.lastFailure!.message, /offline/);

    client.fail = null;
    await store.ensureFresh();
    assert.equal(client.listCalls, 2, "the list is retried once YNAB is back");
    assert.equal(store.lastSync?.kind, "delta");
  });

  it("fetches the budget list once per process across several syncs", async () => {
    const client = new FakeBudgetSource();
    const store = makeStore(client, { ttlMs: 0 });
    await store.ensureFresh();
    await store.ensureFresh();
    await store.sync();
    await store.fullResync();
    assert.equal(client.calls.length, 4);
    assert.equal(client.listCalls, 1);
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
});
