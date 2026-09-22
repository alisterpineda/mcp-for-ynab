import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BudgetStore } from "../cache/store.js";
import { registerGetMonth } from "./get-month.js";
import { registerListAccounts } from "./list-accounts.js";
import { registerListCategories } from "./list-categories.js";
import { registerSyncStatus } from "./sync-status.js";

/** Every tool this server exposes, in the order a new conversation tends to need them. */
export function registerTools(server: McpServer, store: BudgetStore): void {
  registerListCategories(server, store);
  registerListAccounts(server, store);
  registerGetMonth(server, store);
  registerSyncStatus(server, store);
}
