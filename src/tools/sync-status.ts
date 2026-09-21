import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BudgetStore, SyncResult } from "../cache/store.js";
import type { CacheData } from "../cache/schema.js";
import { transactionDateRange } from "../cache/views.js";
import { formatAge, formatLocalTime, freshnessLine } from "../freshness.js";

const description = `Report the state of the local YNAB budget cache: budget name, when the data was last synced from YNAB, how many transactions are cached and the date range they cover, and any recent sync problem.

Data is refreshed automatically whenever it is more than a few minutes old, so this tool is rarely needed just to keep numbers current. Use \`refresh: true\` when the user says they just entered or changed something in YNAB and wants it reflected now, or when numbers look stale. Use \`full_resync: true\` only for troubleshooting a cache that seems wrong: it discards the local cache and re-downloads the entire budget.

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
          .describe("Discard the local cache and download the full budget again. Troubleshooting only."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ refresh, full_resync }) => {
      let cache: CacheData;
      try {
        if (full_resync) {
          await store.fullResync();
          cache = await store.ensureFresh();
        } else {
          cache = await store.ensureFresh({ force: refresh === true });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `No cached data and YNAB could not be reached: ${message}` }],
        };
      }
      const text = [...renderStatus(store, cache, store.lastSync), "", freshnessLine(store, cache)].join("\n");
      return { content: [{ type: "text", text }] };
    },
  );
}

/** The body of the sync_status response, one line per entry. Exported for tests. */
export function renderStatus(store: BudgetStore, cache: CacheData, lastSync: SyncResult | null): string[] {
  const now = new Date();
  const syncedAt = new Date(cache.lastSyncedAt);
  const transactions = Object.values(cache.transactions);
  const splitParents = new Set(Object.values(cache.subtransactions).map((s) => s.transaction_id));
  const splitCount = transactions.filter((t) => splitParents.has(t.id)).length;
  const accounts = Object.values(cache.accounts);
  const range = transactionDateRange(cache);

  const lines = [
    `Budget: ${cache.budget.name}`,
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
    `Transactions: ${transactions.length}` +
      (splitCount > 0 ? ` (${splitCount} splits, ${Object.keys(cache.subtransactions).length} split lines)` : ""),
    `Date range: ${range ? `${range.earliest} to ${range.latest}` : "no transactions"}`,
    `Budget months: ${cache.budget.firstMonth.slice(0, 7)} to ${cache.budget.lastMonth.slice(0, 7)} (${Object.keys(cache.months).length} cached)`,
    `Accounts: ${accounts.length} (${accounts.filter((a) => !a.closed).length} open)` +
      ` · Categories: ${Object.values(cache.categories).filter((c) => !c.hidden).length}` +
      ` · Payees: ${Object.keys(cache.payees).length}`,
    `Currency: ${cache.budget.currencyFormat?.iso_code ?? "unknown"}`,
    `Cache file: ${store.cacheFilePath} (server knowledge ${cache.serverKnowledge})`,
  );
  if (store.rateLimit) lines.push(`YNAB API usage this hour: ${store.rateLimit.used}/${store.rateLimit.limit}`);
  return lines;
}
