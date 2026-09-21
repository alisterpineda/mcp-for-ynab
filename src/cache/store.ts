import { YnabApiError, type BudgetSource } from "../ynab/client.js";
import { applyDelta, buildCache, type DeltaStats } from "./delta.js";
import { countEntities, type CacheData } from "./schema.js";
import { CacheStorage } from "./storage.js";

export const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface SyncResult {
  kind: "full" | "delta";
  stats: DeltaStats;
  durationMs: number;
}

export interface SyncFailure {
  at: Date;
  message: string;
  rateLimited: boolean;
}

export interface StoreOptions {
  client: BudgetSource;
  storage: CacheStorage;
  /** Budget id to sync. When null, YNAB's default (last-used) budget is resolved on first sync. */
  configuredBudgetId: string | null;
  ttlMs?: number;
  log?: (message: string) => void;
}

/**
 * Owns the in-memory cache and the sync policy:
 * - `ensureFresh()` syncs only when the cache is older than the TTL, and fails soft when a cache exists.
 * - `sync()` always talks to YNAB (delta when possible, full otherwise).
 * - Concurrent callers share one in-flight sync.
 */
export class BudgetStore {
  private cache: CacheData | null = null;
  private loading: Promise<void> | null = null;
  private inFlight: Promise<SyncResult> | null = null;
  private resolvedBudgetId: string | null;
  private readonly ttlMs: number;
  private readonly log: (message: string) => void;
  private readonly client: BudgetSource;
  private readonly storage: CacheStorage;

  lastFailure: SyncFailure | null = null;
  lastSync: SyncResult | null = null;

  constructor(options: StoreOptions) {
    this.client = options.client;
    this.storage = options.storage;
    this.resolvedBudgetId = options.configuredBudgetId;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.log = options.log ?? (() => {});
  }

  get cacheFilePath(): string {
    return this.storage.filePath;
  }

  get rateLimit() {
    return this.client.lastRateLimit;
  }

  /** Age of the cached data in milliseconds, or null when there is no cache. */
  ageMs(now = new Date()): number | null {
    if (!this.cache) return null;
    return now.getTime() - Date.parse(this.cache.lastSyncedAt);
  }

  /**
   * Return a cache no older than the TTL, syncing first if needed. If the sync fails and a cache
   * exists, the stale cache is returned and the failure is recorded in `lastFailure`.
   * Throws only when there is no cache at all and YNAB cannot be reached.
   */
  async ensureFresh(options: { force?: boolean } = {}): Promise<CacheData> {
    await this.loadFromDisk();
    const age = this.ageMs();
    const stale = age === null || age >= this.ttlMs;
    if (options.force || stale) {
      try {
        await this.sync();
      } catch (error) {
        if (!this.cache) throw error;
        // Fail soft: answer from the last successful sync. The failure is already recorded.
      }
    }
    return this.cache!;
  }

  /** True when the most recent sync attempt failed after the last successful one, i.e. the cache is stale because of it. */
  get failedSinceLastSync(): SyncFailure | null {
    const failure = this.lastFailure;
    if (!failure || !this.cache) return null;
    return failure.at.getTime() > Date.parse(this.cache.lastSyncedAt) ? failure : null;
  }

  /** Discard the cache on disk and in memory, then pull the full budget again. */
  async fullResync(): Promise<SyncResult> {
    await this.loadFromDisk();
    // A sync started against the old cache would write into it after we drop it; let it settle first.
    if (this.inFlight) await this.inFlight.catch(() => {});
    this.cache = null;
    await this.storage.remove();
    return this.sync();
  }

  /** Talk to YNAB now: delta if a cache exists, otherwise full. Shares an in-flight sync. */
  sync(): Promise<SyncResult> {
    if (!this.inFlight) {
      this.inFlight = this.runSync().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async runSync(): Promise<SyncResult> {
    const started = Date.now();
    try {
      await this.loadFromDisk();
      const budgetId = await this.resolveBudgetId();
      const now = new Date();
      let result: SyncResult;

      if (this.cache) {
        const { budget, serverKnowledge } = await this.client.getBudget(budgetId, this.cache.serverKnowledge);
        const stats = applyDelta(this.cache, budget, serverKnowledge, now);
        result = { kind: "delta", stats, durationMs: Date.now() - started };
      } else {
        const { budget, serverKnowledge } = await this.client.getBudget(budgetId);
        this.cache = buildCache(budget, serverKnowledge, now);
        const stats = { upserted: countEntities(this.cache), deleted: 0 };
        result = { kind: "full", stats, durationMs: Date.now() - started };
      }

      // An empty delta only moves lastSyncedAt; skip rewriting the whole file for that.
      if (result.kind === "full" || result.stats.upserted + result.stats.deleted > 0) {
        await this.storage.save(this.cache);
      }
      this.lastSync = result;
      this.lastFailure = null;
      this.log(
        `${result.kind} sync ok: +${result.stats.upserted} -${result.stats.deleted} in ${result.durationMs}ms (knowledge ${this.cache.serverKnowledge})`,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rateLimited = error instanceof YnabApiError && error.isRateLimited;
      this.lastFailure = { at: new Date(), message, rateLimited };
      this.log(`sync failed: ${message}`);
      throw error;
    }
  }

  /** Load the on-disk cache once. Concurrent callers await the same read, so none sees an empty cache mid-load. */
  private loadFromDisk(): Promise<void> {
    this.loading ??= this.readCacheFile();
    return this.loading;
  }

  private async readCacheFile(): Promise<void> {
    const result = await this.storage.load(this.resolvedBudgetId);
    switch (result.kind) {
      case "loaded":
        this.cache = result.data;
        this.resolvedBudgetId ??= result.data.budget.id;
        this.log(`loaded cache for "${result.data.budget.name}" (knowledge ${result.data.serverKnowledge})`);
        break;
      case "missing":
        this.log("no cache on disk; first sync will pull the full budget");
        break;
      case "discarded":
        this.log(`discarding cache: ${result.reason}`);
        await this.storage.remove();
        break;
    }
  }

  private async resolveBudgetId(): Promise<string> {
    if (this.resolvedBudgetId) return this.resolvedBudgetId;
    const { budgets, defaultBudget } = await this.client.listBudgets();
    const chosen = defaultBudget ?? (budgets.length === 1 ? budgets[0] : null);
    if (!chosen) {
      const names = budgets.map((b) => `"${b.name}" (${b.id})`).join(", ");
      throw new Error(`Multiple budgets found and none is default; set YNAB_BUDGET_ID to one of: ${names}`);
    }
    this.resolvedBudgetId = chosen.id;
    this.log(`using budget "${chosen.name}" (${chosen.id})`);
    return chosen.id;
  }
}
