import type { BudgetStore } from "./cache/store.js";
import type { SyncedBudget } from "./cache/db.js";

export function formatLocalTime(date: Date, now = new Date()): string {
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${time} on ${day}`;
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * Trailing line for `sync_status`, the one tool that answers in prose, e.g. "Data as of 2:14 PM."
 * If the most recent sync attempt failed, the line says so, so the reader knows the numbers come
 * from the last good sync. The JSON tools say the same thing through `stalenessWarning`.
 */
export function freshnessLine(store: BudgetStore, budget: SyncedBudget, now = new Date()): string {
  const syncedAt = new Date(budget.lastSyncedAt);
  let line = `Data as of ${formatLocalTime(syncedAt, now)}`;
  const cause = staleCause(store);
  if (cause) line += ` (${cause.short}; showing the last successful sync)`;
  return `${line}.`;
}

/**
 * The JSON tools' `warning` key: why these figures are older than they look, or null when the
 * most recent sync attempt succeeded. Shares `staleCause` with `freshnessLine` so the two
 * renderings cannot start describing the same cache state differently.
 */
export function stalenessWarning(store: BudgetStore): string | null {
  const cause = staleCause(store);
  if (!cause) return null;
  return `${cause.long} (${cause.message}); these figures come from the last successful sync.`;
}

/** The one reading of a failed sync: null when the last attempt succeeded. */
function staleCause(store: BudgetStore): { short: string; long: string; message: string } | null {
  const failure = store.failedSinceLastSync;
  if (!failure) return null;
  return failure.rateLimited
    ? { short: "YNAB rate limit hit", long: "YNAB rate limit hit", message: failure.message }
    : { short: "latest sync failed", long: "The latest sync failed", message: failure.message };
}
