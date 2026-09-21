import type {
  Account,
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
export const CACHE_SCHEMA_VERSION = 1;

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
  /** ISO timestamp of the last full (non-delta) sync. */
  lastFullSyncAt: string;
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

const ENTITY_COLLECTIONS = [
  "accounts",
  "payees",
  "categoryGroups",
  "categories",
  "months",
  "transactions",
  "subtransactions",
  "scheduledTransactions",
  "scheduledSubtransactions",
] as const;

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
