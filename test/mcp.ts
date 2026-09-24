import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BudgetDb } from "../src/cache/db.js";
import { BudgetStore } from "../src/cache/store.js";
import { registerTools } from "../src/tools/index.js";
import { FakeBudgetSource, orientationBudget } from "./fixtures.js";
import type { BudgetDetail } from "../src/ynab/types.js";

export interface Harness extends AsyncDisposable {
  client: Client;
  store: BudgetStore;
  source: FakeBudgetSource;
  db: BudgetDb;
  /** Call a tool and parse its single text block as JSON. Throws if the tool reported an error. */
  json(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Call a tool and return its text, asserting nothing about success. */
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

/**
 * A server with every tool registered, a real store over an in-memory database and the fake YNAB
 * source, and a client linked to it in process. This is the seam the tool tests observe: input
 * validation, the shared envelope, error paths and the sync policy are all inside it.
 */
export async function harness(options: { budget?: BudgetDetail; ttlMs?: number } = {}): Promise<Harness> {
  const source = new FakeBudgetSource(options.budget ?? orientationBudget());
  const db = new BudgetDb(":memory:");
  const store = new BudgetStore({ client: source, db, configuredBudgetId: null, ttlMs: options.ttlMs ?? 60_000 });

  const server = new McpServer({ name: "mcp-for-ynab", version: "test" });
  registerTools(server, store);
  const client = new Client({ name: "test", version: "test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { text: content.map((c) => c.text).join("\n"), isError: result.isError === true };
  };

  return {
    client,
    store,
    source,
    db,
    call,
    async json(name, args) {
      const { text, isError } = await call(name, args);
      if (isError) throw new Error(`${name} reported an error: ${text}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
    async [Symbol.asyncDispose]() {
      await client.close();
      await server.close();
      db.close();
    },
  };
}
