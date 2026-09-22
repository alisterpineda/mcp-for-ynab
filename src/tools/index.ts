import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BudgetStore } from "../cache/store.js";
import { registerBudgetVsActual } from "./budget-vs-actual.js";
import { registerCashFlow } from "./cash-flow.js";
import { registerGetMonth } from "./get-month.js";
import { registerListAccounts } from "./list-accounts.js";
import { registerListCategories } from "./list-categories.js";
import { registerListScheduled } from "./list-scheduled.js";
import { registerSearchTransactions } from "./search-transactions.js";
import { registerSpendingBreakdown } from "./spending-breakdown.js";
import { registerSpendingTrend } from "./spending-trend.js";
import { registerSyncStatus } from "./sync-status.js";

/** Every tool this server exposes, in the order a new conversation tends to need them. */
export function registerTools(server: McpServer, store: BudgetStore): void {
  registerListCategories(server, store);
  registerListAccounts(server, store);
  registerGetMonth(server, store);
  registerCashFlow(server, store);
  registerSpendingBreakdown(server, store);
  registerSpendingTrend(server, store);
  registerSearchTransactions(server, store);
  registerListScheduled(server, store);
  registerBudgetVsActual(server, store);
  registerSyncStatus(server, store);
}
