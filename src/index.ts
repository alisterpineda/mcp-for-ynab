import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../package.json" with { type: "json" };
import { BudgetStore } from "./cache/store.js";
import { BudgetDb } from "./cache/db.js";
import { registerTools } from "./tools/index.js";
import { YnabClient } from "./ynab/client.js";

// stdout carries the MCP protocol; all logging goes to stderr.
const log = (message: string): void => console.error(`[ynab-mcp] ${message}`);

const token = process.env.YNAB_ACCESS_TOKEN;
if (!token) {
  log("YNAB_ACCESS_TOKEN is not set. Configure it in the extension settings and restart.");
  process.exit(1);
}

const version: string = pkg.version;

const db = new BudgetDb();
if (db.discardedCorruptFile) log(`discarded an unreadable cache file at ${db.path}; the next sync pulls the full budget`);
process.on("exit", () => db.close());

const store = new BudgetStore({
  client: new YnabClient(token),
  db,
  configuredBudgetId: process.env.YNAB_BUDGET_ID?.trim() || null,
  log,
});

const server = new McpServer({ name: "ynab-mcp", version });
registerTools(server, store);

await server.connect(new StdioServerTransport());
log(`started v${version}`);

// Warm the cache in the background so the first tool call answers from memory.
void store.ensureFresh().catch(() => {
  // Already logged by the store; the first tool call will retry or fail soft.
});
