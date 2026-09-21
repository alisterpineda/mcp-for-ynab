import type {
  Account,
  BudgetDetail,
  Category,
  CategoryGroup,
  CurrencyFormat,
  DateFormat,
  Month,
  Payee,
  ScheduledSubTransaction,
  ScheduledTransaction,
  SubTransaction,
  Transaction,
} from "../ynab/types.js";

/** Bump when the on-disk shape changes; older files are discarded and rebuilt with a full sync. */
export const CACHE_SCHEMA_VERSION = 2;

export interface BudgetMeta {
  id: string;
  name: string;
  firstMonth: string;
  lastMonth: string;
  lastModifiedOn: string;
  currencyFormat: CurrencyFormat | null;
  dateFormat: DateFormat | null;
}

/** Everything persisted to disk. Entities are keyed by id (months by their "YYYY-MM-01" date). */
export interface CacheData {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  budget: BudgetMeta;
  serverKnowledge: number;
  /** ISO timestamp of the last successful sync (delta or full). */
  lastSyncedAt: string;
  accounts: Record<string, Account>;
  payees: Record<string, Payee>;
  categoryGroups: Record<string, CategoryGroup>;
  categories: Record<string, Category>;
  months: Record<string, Month>;
  transactions: Record<string, Transaction>;
  subtransactions: Record<string, SubTransaction>;
  scheduledTransactions: Record<string, ScheduledTransaction>;
  scheduledSubtransactions: Record<string, ScheduledSubTransaction>;
}

/**
 * Cache collections that hold id-keyed entities, paired with the budget-response list they come
 * from. `buildCache`, `applyDelta`, validation, and `countEntities` all iterate this table, so
 * adding a collection means adding it to the `CacheData` interface and this table only.
 * Months are handled separately: they are keyed by date and merged per category.
 */
export const ID_KEYED_COLLECTIONS = [
  ["accounts", "accounts"],
  ["payees", "payees"],
  ["categoryGroups", "category_groups"],
  ["categories", "categories"],
  ["transactions", "transactions"],
  ["subtransactions", "subtransactions"],
  ["scheduledTransactions", "scheduled_transactions"],
  ["scheduledSubtransactions", "scheduled_subtransactions"],
] as const satisfies ReadonlyArray<readonly [keyof CacheData, keyof BudgetDetail]>;

export type IdKeyedCollection = (typeof ID_KEYED_COLLECTIONS)[number][0];
export type EntityCollection = IdKeyedCollection | "months";

export const ENTITY_COLLECTIONS: readonly EntityCollection[] = [...ID_KEYED_COLLECTIONS.map(([key]) => key), "months"];

export function emptyCollections(): Pick<CacheData, EntityCollection> {
  const collections: Partial<Record<EntityCollection, Record<string, unknown>>> = {};
  for (const key of ENTITY_COLLECTIONS) collections[key] = {};
  return collections as Pick<CacheData, EntityCollection>;
}

/** Total number of entities across every collection. */
export function countEntities(cache: CacheData): number {
  return ENTITY_COLLECTIONS.reduce((total, key) => total + Object.keys(cache[key]).length, 0);
}

/** Why `value` is not a usable CacheData, or null when it is. */
export function cacheDataProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "not an object";
  const v = value as Partial<CacheData>;
  if (v.schemaVersion !== CACHE_SCHEMA_VERSION) {
    return `schema mismatch (file has version ${String(v.schemaVersion)}, expected ${CACHE_SCHEMA_VERSION})`;
  }
  if (typeof v.budget?.id !== "string") return "missing budget.id";
  for (const key of ["name", "firstMonth", "lastMonth"] as const) {
    if (typeof v.budget[key] !== "string") return `missing budget.${key}`;
  }
  if (typeof v.serverKnowledge !== "number") return "missing serverKnowledge";
  if (typeof v.lastSyncedAt !== "string" || Number.isNaN(Date.parse(v.lastSyncedAt))) return "invalid lastSyncedAt";
  for (const key of ENTITY_COLLECTIONS) {
    const collection = v[key];
    if (typeof collection !== "object" || collection === null) return `missing ${key}`;
  }
  return null;
}

export function isCacheData(value: unknown): value is CacheData {
  return cacheDataProblem(value) === null;
}
