import type { BudgetDetail, Deletable, Month } from "../ynab/types.js";
import { CACHE_SCHEMA_VERSION, ID_KEYED_COLLECTIONS, emptyCollections, type CacheData } from "./schema.js";

export interface DeltaStats {
  upserted: number;
  deleted: number;
}

/** Build a fresh cache from a full (non-delta) budget response. */
export function buildCache(budget: BudgetDetail, serverKnowledge: number, now: Date): CacheData {
  const cache: CacheData = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    budget: toMeta(budget),
    serverKnowledge,
    lastSyncedAt: now.toISOString(),
    ...emptyCollections(),
  };
  applyDelta(cache, budget, serverKnowledge, now);
  return cache;
}

/**
 * Merge a budget response into the cache in place. Works for both full and delta payloads:
 * every entity is upserted by id, and entities flagged `deleted` are removed.
 */
export function applyDelta(cache: CacheData, budget: BudgetDetail, serverKnowledge: number, now: Date): DeltaStats {
  const stats: DeltaStats = { upserted: 0, deleted: 0 };

  cache.budget = toMeta(budget);
  cache.serverKnowledge = serverKnowledge;
  cache.lastSyncedAt = now.toISOString();

  for (const [cacheKey, budgetKey] of ID_KEYED_COLLECTIONS) {
    mergeById(cache[cacheKey], budget[budgetKey], stats);
  }
  mergeMonths(cache.months, budget.months, stats);

  return stats;
}

function toMeta(budget: BudgetDetail): CacheData["budget"] {
  return {
    id: budget.id,
    name: budget.name,
    firstMonth: budget.first_month ?? "",
    lastMonth: budget.last_month ?? "",
    lastModifiedOn: budget.last_modified_on ?? "",
    currencyFormat: budget.currency_format ?? null,
    dateFormat: budget.date_format ?? null,
  };
}

function mergeById(target: Record<string, Deletable>, incoming: readonly Deletable[] | undefined, stats: DeltaStats): void {
  for (const entity of incoming ?? []) {
    if (entity.deleted) {
      if (entity.id in target) stats.deleted++;
      delete target[entity.id];
    } else {
      target[entity.id] = entity;
      stats.upserted++;
    }
  }
}

/**
 * Months are keyed by date, and a delta month carries only the categories that changed within it,
 * so category rows are merged into the stored month rather than replacing its list wholesale.
 */
function mergeMonths(target: Record<string, Month>, incoming: Month[] | undefined, stats: DeltaStats): void {
  for (const month of incoming ?? []) {
    if (month.deleted) {
      if (month.month in target) stats.deleted++;
      delete target[month.month];
      continue;
    }
    const existing = target[month.month];
    const categories: Record<string, Month["categories"][number]> = {};
    for (const c of existing?.categories ?? []) categories[c.id] = c;
    for (const c of month.categories ?? []) {
      if (c.deleted) delete categories[c.id];
      else categories[c.id] = c;
    }
    target[month.month] = { ...month, categories: Object.values(categories) };
    stats.upserted++;
  }
}
