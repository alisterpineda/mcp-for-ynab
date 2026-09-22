import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BudgetStore, SyncResult } from "../cache/store.js";
import { isSynced, type SyncedBudget } from "../cache/db.js";
import { freshBudget } from "./envelope.js";
import { formatAge, formatLocalTime, freshnessLine } from "../freshness.js";

const description = `Report the state of the local YNAB budget cache: budget name, when the data was last synced from YNAB, how many transactions are cached and the date range they cover, and any recent sync problem.

Data is refreshed automatically whenever it is more than a few minutes old, so this tool is rarely needed just to keep numbers current. Use \`refresh: true\` when the user says they just entered or changed something in YNAB and wants it reflected now, or when numbers look stale. Use \`full_resync: true\` only for troubleshooting a cache that seems wrong: it re-downloads the entire budget and replaces the local cache with it. If the download fails, the cache is kept and the failure is reported.

Note: this reflects what YNAB has. Bank imports happen inside YNAB (usually when the YNAB app is opened), so a recent purchase can be missing from YNAB itself; refreshing here cannot pull it from the bank.`;

export function registerSyncStatus(server: McpServer, store: BudgetStore): void {
  server.registerTool(
    "sync_status",
    {
      title: "YNAB sync status",
      description,
      inputSchema: {
        refresh: z.boolean().optional().describe("Pull the latest changes from YNAB before reporting, even if the cache is recent."),
        full_resync: z
          .boolean()
          .optional()
          .describe("Download the full budget again and replace the local cache with it; a failed download keeps the cache. Troubleshooting only."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ refresh, full_resync }) => {
      const fresh = await freshBudget(store, { force: refresh === true, fullResync: full_resync === true });
      if (fresh.error) return fresh.error;
      const text = [...renderStatus(store, fresh.budget, store.lastSync), "", freshnessLine(store, fresh.budget)].join("\n");
      return { content: [{ type: "text", text }] };
    },
  );
}

/** The body of the sync_status response, one line per entry. Exported for tests. */
export function renderStatus(store: BudgetStore, budget: SyncedBudget, lastSync: SyncResult | null): string[] {
  const now = new Date();
  const syncedAt = new Date(budget.lastSyncedAt);
  const summary = store.db.summary(budget.id);

  const lines = [
    `Budget: ${budget.name}`,
    `Last synced: ${formatLocalTime(syncedAt, now)} (${formatAge(now.getTime() - syncedAt.getTime())})`,
  ];
  if (lastSync) {
    const change =
      lastSync.kind === "full"
        ? `full download, ${lastSync.stats.upserted} records`
        : lastSync.stats.upserted + lastSync.stats.deleted === 0
          ? "no changes"
          : `${lastSync.stats.upserted} changed, ${lastSync.stats.deleted} deleted`;
    lines.push(`Last sync this session: ${lastSync.kind} (${change}, ${lastSync.durationMs} ms)`);
  }
  // The freshness trailer already says the latest sync failed; this line adds the reason.
  const failure = store.failedSinceLastSync;
  if (failure) lines.push(`Last sync attempt failed: ${failure.message}`);

  lines.push(
    `Transactions: ${summary.transactions}` +
      (summary.splitParents > 0 ? ` (${summary.splitParents} splits, ${summary.splitLines} split lines)` : ""),
    `Date range: ${summary.earliest && summary.latest ? `${summary.earliest} to ${summary.latest}` : "no transactions"}`,
    `Budget months: ${(budget.firstMonth ?? "").slice(0, 7)} to ${(budget.lastMonth ?? "").slice(0, 7)} (${summary.months} cached)`,
    `Accounts: ${summary.accounts} (${summary.openAccounts} open)` +
      ` · Categories: ${summary.visibleCategories}` +
      ` · Payees: ${summary.payees}`,
    `Currency: ${budget.currencyFormat?.iso_code ?? "unknown"}`,
    `Cache file: ${store.dbPath} (server knowledge ${budget.serverKnowledge})`,
  );
  if (store.rateLimit) lines.push(`YNAB API usage this hour: ${store.rateLimit.used}/${store.rateLimit.limit}`);

  const others = store.db.budgetRows().filter((b) => b.id !== budget.id);
  if (others.length > 0) {
    const described = others.map((b) => {
      const state = isSynced(b) ? `synced ${formatAge(now.getTime() - Date.parse(b.lastSyncedAt))}` : "not synced";
      return `"${b.name}" (${b.id}, ${state})`;
    });
    lines.push(`Other budgets: ${described.join("; ")} — set Budget ID to switch`);
  }
  return lines;
}
