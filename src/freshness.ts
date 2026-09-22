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
 * Trailing line for every tool response, e.g. "Data as of 2:14 PM." If the most recent sync
 * attempt failed, the line says so, so the reader knows the numbers come from the last good sync.
 */
export function freshnessLine(store: BudgetStore, budget: SyncedBudget, now = new Date()): string {
  const syncedAt = new Date(budget.lastSyncedAt);
  let line = `Data as of ${formatLocalTime(syncedAt, now)}`;
  const failure = store.failedSinceLastSync;
  if (failure) {
    line += failure.rateLimited
      ? " (YNAB rate limit hit; showing the last successful sync)"
      : " (latest sync failed; showing the last successful sync)";
  }
  return `${line}.`;
}
