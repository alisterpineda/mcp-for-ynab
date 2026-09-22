import { YnabApiError, type BudgetSource } from "../ynab/client.js";
import type { BudgetSummary } from "../ynab/types.js";
import { isSynced, type BudgetDb, type DeltaStats, type SyncedBudget } from "./db.js";

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
  db: BudgetDb;
  /** Budget id to sync. When null, YNAB's default (last-used) budget is resolved on first sync. */
  configuredBudgetId: string | null;
  ttlMs?: number;
  log?: (message: string) => void;
}

/**
 * Owns the sync policy for the active budget:
 * - `ensureFresh()` syncs only when the cache is older than the TTL, and fails soft when a cache exists.
 * - `sync()` always talks to YNAB (delta when the budget has been synced before, full otherwise).
 * - `fullResync()` is the only way to force a full download over an existing cache.
 * - Concurrent callers share one in-flight sync.
 * Tools read the data through `db`.
 */
export class BudgetStore {
  readonly db: BudgetDb;
  private activeBudgetId: string | null;
  private readonly configuredBudgetId: string | null;
  private resolving: Promise<string> | null = null;
  /** YNAB's new default budget, adopted as active only once its first sync succeeds. */
  private pendingDefault: string | null = null;
  private budgetList: Promise<void> | null = null;
  private lastList: { budgets: BudgetSummary[]; defaultBudget: BudgetSummary | null } | null = null;
  private inFlight: Promise<SyncResult> | null = null;
  private readonly ttlMs: number;
  private readonly log: (message: string) => void;
  private readonly client: BudgetSource;

  lastFailure: SyncFailure | null = null;
  lastSync: SyncResult | null = null;

  constructor(options: StoreOptions) {
    this.client = options.client;
    this.db = options.db;
    this.configuredBudgetId = options.configuredBudgetId;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.log = options.log ?? (() => {});

    // A configured id wins. Otherwise a previously chosen budget that is already synced keeps an
    // offline start purely local; anything else is resolved against YNAB on the first sync.
    const remembered = this.db.activeBudgetId();
    this.activeBudgetId = options.configuredBudgetId ?? (remembered && isSynced(this.db.budgetRow(remembered)) ? remembered : null);
    const current = this.current();
    if (current) this.log(`loaded cache for "${current.name}" (knowledge ${current.serverKnowledge})`);
    else this.log("no cached budget; first sync will pull the full budget");
  }

  get dbPath(): string {
    return this.db.path;
  }

  get rateLimit() {
    return this.client.lastRateLimit;
  }

  /** Age of the active budget's cached data in milliseconds, or null when it has not been synced. */
  ageMs(now = new Date()): number | null {
    const current = this.current();
    return current ? now.getTime() - Date.parse(current.lastSyncedAt) : null;
  }

  /**
   * Return the active budget, synced no longer ago than the TTL if possible. `force` syncs whatever
   * the cache's age, and `full` re-downloads the whole budget instead of asking for changes. If the
   * sync fails and the budget has been synced before, the stale row is returned and the failure is
   * recorded in `lastFailure`. Throws only when there is no cache at all and YNAB cannot be reached.
   */
  async ensureFresh(options: { force?: boolean; full?: boolean } = {}): Promise<SyncedBudget> {
    const age = this.ageMs();
    const stale = age === null || age >= this.ttlMs;
    if (options.full || options.force || stale) {
      try {
        await (options.full ? this.fullResync() : this.sync());
      } catch (error) {
        if (!this.current()) throw error;
        // Fail soft: answer from the last successful sync. The failure is already recorded.
      }
    }
    return this.current()!;
  }

  /**
   * True when the most recent sync attempt failed after the last successful one, i.e. the cache is
   * stale because of it. A success here clears `lastFailure`, so the times only decide against a sync
   * another process sharing the cache file wrote. A tie counts as a failure: both are millisecond
   * times, and a failure this process still holds came after every success it had.
   */
  get failedSinceLastSync(): SyncFailure | null {
    const failure = this.lastFailure;
    const current = this.current();
    if (!failure || !current) return null;
    return failure.at.getTime() >= Date.parse(current.lastSyncedAt) ? failure : null;
  }

  /**
   * Pull the whole budget again and replace the cached copy with it. The old copy is dropped in the
   * transaction that writes the new one, so a download that fails leaves it answering.
   */
  async fullResync(): Promise<SyncResult> {
    // A delta already under way would be joined rather than replaced, or land on top of the new copy;
    // let it settle first. Nothing is awaited between the loop and `sync`, so no other sync slips in.
    while (this.inFlight) await this.inFlight.catch(() => {});
    return this.startSync(true);
  }

  /**
   * Talk to YNAB now: delta if the budget was synced before, otherwise full. Shares an in-flight
   * sync, so a full download goes through `fullResync`, which waits one out instead of joining it.
   */
  sync(): Promise<SyncResult> {
    return this.startSync(false);
  }

  /** Start a sync, or join the one in flight — whose kind, not `full`, then decides what runs. */
  private startSync(full: boolean): Promise<SyncResult> {
    if (!this.inFlight) {
      this.inFlight = this.runSync(full).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private current(): SyncedBudget | null {
    if (!this.activeBudgetId) return null;
    const row = this.db.budgetRow(this.activeBudgetId);
    return isSynced(row) ? row : null;
  }

  private async runSync(full: boolean): Promise<SyncResult> {
    const started = Date.now();
    try {
      await this.resolveActive();
      // The list may switch the active budget, so the target is read only after it.
      await this.refreshBudgetList();
      const budgetId = this.syncTarget();
      const knowledge = full ? undefined : (this.db.budgetRow(budgetId)?.serverKnowledge ?? undefined);
      const { budget, serverKnowledge } = await this.client.getBudget(budgetId, knowledge);
      // A full download is the whole budget, so it replaces what was cached rather than merging into it.
      const stats = this.db.applyBudget(budgetId, budget, serverKnowledge, new Date(), { replace: knowledge === undefined });
      if (budgetId !== this.activeBudgetId) {
        // Only now is the new default usable offline; until here the previous budget kept serving.
        this.activeBudgetId = budgetId;
        this.pendingDefault = null;
        this.db.setActiveBudgetId(budgetId);
      }
      const result: SyncResult = { kind: knowledge === undefined ? "full" : "delta", stats, durationMs: Date.now() - started };
      this.lastSync = result;
      this.lastFailure = null;
      this.log(`${result.kind} sync ok: +${stats.upserted} -${stats.deleted} in ${result.durationMs}ms (knowledge ${serverKnowledge})`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rateLimited = error instanceof YnabApiError && error.isRateLimited;
      this.lastFailure = { at: new Date(), message, rateLimited };
      this.log(`sync failed: ${message}`);
      throw error;
    }
  }

  /** The budget the next sync downloads: a pending new default, otherwise the active budget. */
  private syncTarget(): string {
    return this.pendingDefault ?? this.activeBudgetId!;
  }

  /** The active budget id, picking one from YNAB's list when neither config nor the cache names one. */
  private resolveActive(): Promise<string> {
    if (this.activeBudgetId) return Promise.resolve(this.activeBudgetId);
    this.resolving ??= this.pickBudget().catch((error: unknown) => {
      this.resolving = null;
      throw error;
    });
    return this.resolving;
  }

  private async pickBudget(): Promise<string> {
    await this.refreshBudgetList();
    const { budgets, defaultBudget } = this.lastList!;
    const chosen = defaultBudget ?? (budgets.length === 1 ? budgets[0] : null);
    if (!chosen) {
      const names = budgets.map((b) => `"${b.name}" (${b.id})`).join(", ");
      throw new Error(`Multiple budgets found and none is default; set YNAB_BUDGET_ID to one of: ${names}`);
    }
    this.activeBudgetId = chosen.id;
    this.db.setActiveBudgetId(chosen.id);
    this.log(`using budget "${chosen.name}" (${chosen.id})`);
    return chosen.id;
  }

  /**
   * Fetch the account's budget list once per process and record it, so `sync_status` can show the
   * other budgets. Without a configured id, a changed YNAB default is queued to become the active
   * budget once it has synced (see `runSync`), so a failed download never loses the current cache.
   */
  private refreshBudgetList(): Promise<void> {
    this.budgetList ??= this.fetchBudgetList().catch((error: unknown) => {
      this.budgetList = null;
      throw error;
    });
    return this.budgetList;
  }

  private async fetchBudgetList(): Promise<void> {
    const list = await this.client.listBudgets();
    this.lastList = list;
    this.db.upsertBudgetList(list.budgets, list.defaultBudget?.id ?? null, new Date());
    const newDefault = list.defaultBudget;
    if (this.configuredBudgetId === null && this.activeBudgetId && newDefault && newDefault.id !== this.activeBudgetId) {
      this.log(`YNAB default budget is now "${newDefault.name}" (${newDefault.id}); switching from ${this.activeBudgetId}`);
      this.pendingDefault = newDefault.id;
    }
  }
}
