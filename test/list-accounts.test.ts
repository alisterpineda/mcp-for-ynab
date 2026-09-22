import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUDGET_ID, orientationBudget } from "./fixtures.js";
import { YnabApiError } from "../src/ynab/client.js";
import { harness } from "./mcp.js";

interface Section {
  total: number;
  accounts: Record<string, unknown>[];
}

describe("list_accounts", () => {
  it("splits open accounts into on-budget and tracking with their own totals", async () => {
    await using h = await harness();
    const body = await h.json("list_accounts");
    const onBudget = body.on_budget as Section;
    const tracking = body.tracking as Section;

    assert.deepEqual(
      onBudget.accounts.map((a) => a.name),
      ["Chequing", "Visa"],
    );
    assert.deepEqual(
      tracking.accounts.map((a) => a.name),
      ["Mortgage"],
    );
    assert.equal(onBudget.total, 734.56, "1234.56 + -500.00");
    assert.equal(tracking.total, -98765.43);
    assert.equal(body.net_worth, -98030.87, "the two section totals added up");
  });

  it("returns each account's id, raw type and balances", async () => {
    await using h = await harness();
    const body = await h.json("list_accounts");
    const [chequing] = (body.on_budget as Section).accounts;
    assert.deepEqual(chequing, {
      id: "a1",
      name: "Chequing",
      type: "checking",
      balance: 1234.56,
      cleared_balance: 1200,
      uncleared_balance: 34.56,
      last_reconciled_at: "2026-09-01T12:00:00+00:00",
      note: "joint",
    });
  });

  it("omits an uncleared balance of zero, and a note or reconcile date that is not set", async () => {
    await using h = await harness();
    const body = await h.json("list_accounts");
    const visa = (body.on_budget as Section).accounts[1];
    assert.deepEqual(visa, { id: "a2", name: "Visa", type: "creditCard", balance: -500, cleared_balance: -500 });
  });

  it("carries no direct-import or debt fields", async () => {
    await using h = await harness();
    const { text, isError } = await h.call("list_accounts");
    assert.equal(isError, false, "an error result would satisfy every assertion below");
    for (const field of ["direct_import", "debt_", "transfer_payee_id"]) {
      assert.ok(!text.includes(field), `${field} is not part of the response`);
    }
  });

  it("leaves closed accounts out by default and counts them", async () => {
    await using h = await harness();
    const body = await h.json("list_accounts");
    assert.equal(body.closed_omitted, 1);
    const names = [...(body.on_budget as Section).accounts, ...(body.tracking as Section).accounts].map((a) => a.name);
    assert.ok(!names.includes("Old savings"));
  });

  it("returns closed accounts on request, while the totals stay open-accounts-only", async () => {
    await using h = await harness();
    const body = await h.json("list_accounts", { include_closed: true });
    const onBudget = body.on_budget as Section;
    assert.deepEqual(
      onBudget.accounts.map((a) => a.name),
      ["Chequing", "Visa", "Old savings"],
      "ordered by type then name: checking, creditCard, savings",
    );
    assert.equal(onBudget.accounts[2].closed, true, "the closed one is marked");
    assert.equal(onBudget.accounts[2].balance, 111, "a closed account with money in it, so the totals have something to exclude");
    assert.equal(body.closed_omitted, 0);
    assert.equal(onBudget.total, 734.56, "the total still covers open accounts only");
    assert.equal(body.net_worth, -98030.87);
  });

  it("reports the same totals whether or not the closed accounts are listed", async () => {
    await using h = await harness();
    const open = await h.json("list_accounts");
    const all = await h.json("list_accounts", { include_closed: true });
    assert.equal(all.net_worth, open.net_worth, "listing a closed account must not move net worth");
    assert.equal((all.on_budget as Section).total, (open.on_budget as Section).total);
    assert.equal((all.tracking as Section).total, (open.tracking as Section).total);
  });
});

describe("the shared response envelope", () => {
  it("names the budget, currency, precision and last successful sync, before the tool's own keys", async () => {
    await using h = await harness();
    const { text } = await h.call("list_accounts");
    const syncedAt = h.db.budgetRow(BUDGET_ID)!.lastSyncedAt;
    assert.ok(
      text.startsWith(`{"budget":"Household","currency":"USD","decimals":2,"as_of":"${syncedAt}",`),
      `envelope leads the response: ${text.slice(0, 120)}`,
    );
    assert.equal(text.includes("\n"), false, "the JSON is minified");
  });

  it("omits the currency and assumes two decimals when the budget has no currency format", async () => {
    await using h = await harness({ budget: orientationBudget({ currency_format: undefined }) });
    const body = await h.json("list_accounts");
    assert.ok(!("currency" in body), "a guessed currency code would be a wrong statement about someone's money");
    assert.equal(body.decimals, 2);
    assert.equal((body.on_budget as Section).total, 734.56);
  });

  it("renders whole numbers for a zero-decimal currency", async () => {
    const yen = orientationBudget({
      currency_format: {
        iso_code: "JPY",
        example_format: "123,457",
        decimal_digits: 0,
        decimal_separator: ".",
        symbol_first: true,
        group_separator: ",",
        currency_symbol: "¥",
        display_symbol: true,
      },
    });
    await using h = await harness({ budget: yen });
    const body = await h.json("list_accounts");
    assert.equal(body.currency, "JPY");
    assert.equal(body.decimals, 0);
    assert.equal((body.on_budget as Section).accounts[0].balance, 1235, "1234.56 rounds half away from zero");
    assert.equal((body.on_budget as Section).total, 735);
  });

  it("carries no warning while syncing is healthy", async () => {
    await using h = await harness();
    assert.ok(!("warning" in (await h.json("list_accounts"))));
  });

  it("warns that the figures come from the last good sync when the latest attempt failed", async () => {
    await using h = await harness({ ttlMs: 0 });
    await h.json("list_accounts");
    await new Promise((resolve) => setTimeout(resolve, 5)); // so the failure is strictly after the sync
    h.source.fail = new Error("offline");
    const body = await h.json("list_accounts");
    assert.match(String(body.warning), /^The latest sync failed/, "a plain failure is not reported as a rate limit");
    assert.match(String(body.warning), /offline/);
    assert.equal((body.on_budget as Section).total, 734.56, "the cached figures are still returned");
  });

  it("names a rate limit as the reason, because waiting and retrying are different advice", async () => {
    await using h = await harness({ ttlMs: 0 });
    await h.json("list_accounts");
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.source.fail = new YnabApiError("429 Too Many Requests", 429);
    const body = await h.json("list_accounts");
    assert.match(String(body.warning), /^YNAB rate limit hit/);
    assert.match(String(body.warning), /last successful sync/);
    assert.equal((body.on_budget as Section).total, 734.56, "the cached figures are still returned");
  });

  it("reports an error rather than an empty budget when there is no cache and YNAB is unreachable, from every tool", async () => {
    for (const tool of ["list_accounts", "list_categories", "get_month", "sync_status"]) {
      await using h = await harness();
      h.source.fail = new Error("offline");
      const { text, isError } = await h.call(tool);
      assert.equal(isError, true, tool);
      assert.match(text, /^No cached data and YNAB could not be reached: /, tool);
    }
  });
});
