import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { YnabApiError, YnabClient } from "../src/ynab/client.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

afterEach(() => mock.restoreAll());

describe("YnabClient", () => {
  it("calls the plans endpoint with the delta parameter and records the rate limit", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      jsonResponse(200, { data: { plan: { id: "plan-1", name: "Household" }, server_knowledge: 42 } }, { "x-rate-limit": "7/200" }),
    );
    const client = new YnabClient("token");
    const result = await client.getBudget("plan-1", 41);

    const url = String(fetchMock.mock.calls[0].arguments[0]);
    assert.match(url, /\/v1\/plans\/plan-1\?last_knowledge_of_server=41$/);
    const init = fetchMock.mock.calls[0].arguments[1] as RequestInit;
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer token");
    assert.equal(result.serverKnowledge, 42);
    assert.equal(result.budget.name, "Household");
    assert.deepEqual(client.lastRateLimit, { used: 7, limit: 200 });
  });

  it("omits the delta parameter for a full sync", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      jsonResponse(200, { data: { plan: { id: "plan-1", name: "Household" }, server_knowledge: 1 } }),
    );
    await new YnabClient("token").getBudget("plan-1");
    assert.doesNotMatch(String(fetchMock.mock.calls[0].arguments[0]), /last_knowledge_of_server/);
  });

  it("maps YNAB's JSON error body to a YnabApiError with the HTTP status", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse(401, { error: { id: "401", name: "unauthorized", detail: "Unauthorized" } }));
    await assert.rejects(
      () => new YnabClient("bad").listBudgets(),
      (error: unknown) => error instanceof YnabApiError && error.status === 401 && /401: Unauthorized/.test(error.message),
    );
  });

  it("flags a 429 as rate limited", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse(429, { error: { id: "429", name: "too_many_requests", detail: "Too many requests" } }));
    await assert.rejects(
      () => new YnabClient("token").listBudgets(),
      (error: unknown) => error instanceof YnabApiError && error.isRateLimited,
    );
  });

  it("maps a network failure to a YnabApiError with status 0", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(
      () => new YnabClient("token").listBudgets(),
      (error: unknown) => error instanceof YnabApiError && error.status === 0 && /Could not reach YNAB/.test(error.message),
    );
  });

  it("returns the default plan from listBudgets", async () => {
    const plan = { id: "plan-1", name: "Household" };
    mock.method(globalThis, "fetch", async () => jsonResponse(200, { data: { plans: [plan], default_plan: plan } }));
    const result = await new YnabClient("token").listBudgets();
    assert.equal(result.defaultBudget?.id, "plan-1");
    assert.equal(result.budgets.length, 1);
  });
});
