import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  Account,
  BudgetDetail,
  BudgetSummary,
  Category,
  CategoryGroup,
  ClearedStatus,
  CurrencyFormat,
  DateFormat,
  Deletable,
  Payee,
  PayeeLocation,
  ScheduledSubTransaction,
  ScheduledTransaction,
  SubTransaction,
  Transaction,
} from "../ynab/types.js";
import { byName, fold, searchable } from "../format/text.js";
import { defaultDbPath } from "./paths.js";

export interface DeltaStats {
  upserted: number;
  deleted: number;
}

/** One row of `budgets`. The synced fields stay null until the budget's first full sync. */
export interface BudgetRow {
  id: string;
  name: string;
  firstMonth: string | null;
  lastMonth: string | null;
  lastModifiedOn: string | null;
  currencyFormat: CurrencyFormat | null;
  dateFormat: DateFormat | null;
  isDefault: boolean;
  serverKnowledge: number | null;
  lastSyncedAt: string | null;
}

export interface SyncedBudget extends BudgetRow {
  serverKnowledge: number;
  lastSyncedAt: string;
}

export function isSynced(row: BudgetRow | null): row is SyncedBudget {
  return row !== null && row.serverKnowledge !== null && row.lastSyncedAt !== null;
}

/**
 * One spending line. A plain transaction is one line; a split transaction is expanded into one
 * line per subtransaction (the parent's payee/memo fill in where the split leaves them blank).
 */
export interface TransactionLine {
  id: string;
  /** Set on lines that came from a split; the parent transaction's id. */
  parentId: string | null;
  date: string;
  amount: number;
  accountId: string;
  accountName: string;
  payeeId: string | null;
  payeeName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryGroupName: string | null;
  memo: string | null;
  cleared: ClearedStatus;
  approved: boolean;
  flagColor: string | null;
  /** The flag's custom name, when the owner gave its colour one. */
  flagName: string | null;
  /** The payee as the bank sent it, when the line was imported. */
  importedPayee: string | null;
  transferAccountId: string | null;
}

export interface TransactionFilter {
  /** Inclusive ISO dates. */
  from?: string;
  to?: string;
  accountId?: string;
  categoryId?: string;
  payeeId?: string;
  limit?: number;
}

/**
 * Which lines a spending query looks at. `from`/`to` are inclusive ISO dates; the id lists are ORed
 * within a list and ANDed across lists, and an empty or absent list constrains nothing.
 */
export interface SpendingFilter {
  from?: string;
  to?: string;
  categoryIds?: string[];
  groupIds?: string[];
  payeeIds?: string[];
  accountIds?: string[];
}

/** A date range and nothing else: the cash flow is the whole budget's, so it takes no entity filters. */
export type DateFilter = Pick<SpendingFilter, "from" | "to">;

/**
 * Which lines a search looks at: the spending filter plus the things only a drill-down asks for.
 * `minAmount`/`maxAmount` are inclusive milliunit bounds on the line's absolute amount, so "between
 * 20 and 50" reads the way a person says it whichever way the money went; `direction` then picks a
 * side. `text` is a substring of the memo, the payee's name or the payee the bank sent, ignoring
 * case and accents.
 */
export interface SearchFilter extends SpendingFilter {
  minAmount?: number;
  maxAmount?: number;
  direction?: "outflow" | "inflow";
  text?: string;
  /**
   * True keeps only the lines YNAB would ask to have categorized: on an on-budget account, with no
   * category, and not a transfer to another on-budget account (which never needs one). False keeps
   * only the lines that carry a category.
   */
  uncategorized?: boolean;
  approved?: boolean;
  cleared?: ClearedStatus;
  /** How many lines to return; the totals are unaffected. */
  limit?: number;
}

/** One bucket of spending. `spent` is the raw milliunit sum, so ordinary spending is negative. */
/** One entity's spending in one month, from `spendingByMonth`. */
export interface MonthlySpending {
  /** The category or category group id; null for a line with none (Uncategorized, a deleted category). */
  key: string | null;
  /** `YYYY-MM`. */
  month: string;
  /** Milliunits, negative for spending. */
  spent: number;
}

export interface SpendingAggregate {
  /**
   * The grouping entity's id, the `YYYY-MM` when grouping by month, and null for the buckets that
   * have no entity behind them: Uncategorized, `(deleted category)`, `(unknown group)`, `(no payee)`.
   */
  key: string | null;
  name: string;
  /** Category grouping only. */
  groupName?: string;
  /** Category grouping only: the category, or its group, is hidden. */
  hidden?: boolean;
  count: number;
  spent: number;
}

export type SpendingGroupBy = "category" | "category_group" | "payee" | "account" | "month";

/** Flattened lines in range that the spending rule dropped, counted once each. */
export interface SpendingExclusions {
  /** On a budget account, no category, transferring to another budget account. */
  transfers: number;
  /** On a tracking (off-budget) account. */
  tracking: number;
  /** In an internal category (`Inflow: Ready to Assign`). */
  inflows: number;
}

/**
 * One month of the budget's cash flow, from `cashFlowByMonth`. Milliunits with YNAB's sign, so
 * `income` is positive and `spent` negative; `toTracking` is the part of `spent` that moved to a
 * tracking account.
 */
export interface CashFlowMonth {
  /** `YYYY-MM`. */
  month: string;
  income: number;
  spent: number;
  toTracking: number;
}

/** One source of income, or one tracking account money moved to, summed over a range. */
export interface FlowAggregate {
  /** The payee or account id; null for income with no payee. */
  key: string | null;
  name: string;
  count: number;
  /** Milliunits with YNAB's sign. */
  amount: number;
  /** How many distinct months have a line. */
  months: number;
}

/** Names or ids the caller wants turned into ids, one list per kind. */
export interface EntityNames {
  categories?: string[];
  groups?: string[];
  payees?: string[];
  accounts?: string[];
}

/** The resolved ids. A key is present only when its list was present in the input. */
export interface ResolvedEntities {
  categoryIds?: string[];
  groupIds?: string[];
  payeeIds?: string[];
  accountIds?: string[];
}

/** A name that matched no entity, or more than one. The message is written for the user to read. */
export class NameResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NameResolutionError";
  }
}

/** One row of `months`: the month's own totals, without its categories. Amounts are milliunits. */
export interface MonthRow {
  month: string;
  income: number;
  budgeted: number;
  activity: number;
  toBeBudgeted: number;
  ageOfMoney: number | null;
  note: string | null;
}

export interface MonthCategoryRow {
  categoryId: string;
  budgeted: number;
  activity: number;
  balance: number;
  goalUnderFunded: number | null;
}

/** One category as `list_categories` sees it: structure and goal definition, never money. */
export interface CategoryTreeCategory {
  id: string;
  name: string;
  note: string | null;
  goalType: string | null;
  goalTarget: number | null;
  goalTargetDate: string | null;
  goalSnoozedAt: string | null;
  /** YNAB's cadence code: how often the target repeats, read with `goalCadenceFrequency`. */
  goalCadence: number | null;
  goalCadenceFrequency: number | null;
  /** Plan-your-spending goals only: true asks for the whole target each period, false refills up to it. */
  goalNeedsWholeAmount: boolean | null;
  /** True when the category is hidden, or sits in a hidden group. */
  hidden: boolean;
}

export interface CategoryTreeGroup {
  name: string;
  categories: CategoryTreeCategory[];
}

export interface CategoryTreeOptions {
  /** Substring of a category name or of its group's name, matched case- and accent-insensitively. */
  search?: string;
  /** Return hidden categories too, rather than leaving them out. */
  includeHidden?: boolean;
}

export interface AccountRow {
  id: string;
  name: string;
  type: string;
  onBudget: boolean;
  closed: boolean;
  balance: number;
  clearedBalance: number;
  unclearedBalance: number;
  lastReconciledAt: string | null;
  note: string | null;
}

export interface AccountListing {
  accounts: AccountRow[];
  /** Closed accounts left out of `accounts`; zero when they were included. */
  closedOmitted: number;
}

/** One category's figures for a month, with the names needed to report it. */
export interface MonthCategoryDetail extends MonthCategoryRow {
  name: string;
  groupName: string;
  /** True when the category is hidden, or sits in a hidden group. */
  hidden: boolean;
}

export interface MonthDetail extends MonthRow {
  categories: MonthCategoryDetail[];
}

/** Which categories a month-range report covers; both lists are ORed inside and ANDed across. */
export interface MonthCategoryFilter {
  categoryIds?: string[];
  groupIds?: string[];
}

/** One category's figures for one month of a range, with the markers a report has to carry. */
export interface MonthCategoryRangeRow {
  /** `YYYY-MM`, the way a monthly report keys its months. */
  month: string;
  categoryId: string;
  name: string;
  groupName: string;
  /** True when the category is hidden, or sits in a hidden group. */
  hidden: boolean;
  /** True when the category is one of YNAB's credit card payment categories. */
  creditCardPayment: boolean;
  budgeted: number;
  activity: number;
  balance: number;
}

/**
 * One scheduled transaction as YNAB will post it, with the names a report needs. A split carries
 * its lines; a plain one has none. `transferAccountOnBudget` says what kind of account a transfer
 * lands in, which is what decides whether the amount leaves the budget.
 */
export interface ScheduledRow {
  id: string;
  dateFirst: string;
  dateNext: string;
  frequency: string;
  amount: number;
  accountId: string;
  accountName: string;
  accountOnBudget: boolean;
  payeeName: string | null;
  categoryName: string | null;
  categoryGroupName: string | null;
  transferAccountId: string | null;
  transferAccountName: string | null;
  transferAccountOnBudget: boolean | null;
  memo: string | null;
  flagColor: string | null;
  lines: ScheduledLine[];
}

export interface ScheduledLine {
  id: string;
  amount: number;
  payeeName: string | null;
  categoryName: string | null;
  categoryGroupName: string | null;
  transferAccountId: string | null;
  transferAccountName: string | null;
  transferAccountOnBudget: boolean | null;
  memo: string | null;
}

export interface CacheSummary {
  transactions: number;
  /** Transactions that have at least one split line. */
  splitParents: number;
  splitLines: number;
  earliest: string | null;
  latest: string | null;
  accounts: number;
  openAccounts: number;
  visibleCategories: number;
  payees: number;
  months: number;
}

type SqlValue = null | number | string;

/** Keys of `BudgetDetail` that hold an entity list (months are handled separately). */
type EntityListKey = Exclude<
  { [K in keyof BudgetDetail]-?: NonNullable<BudgetDetail[K]> extends readonly unknown[] ? K : never }[keyof BudgetDetail],
  "months"
>;

interface EntityTable<E extends Deletable = Deletable> {
  table: string;
  list: EntityListKey;
  /** Indexed/queryable columns besides `budget_id` and `id`. */
  columns: ReadonlyArray<readonly [name: string, ddl: string, pick: (e: E) => SqlValue]>;
  /** Column lists, e.g. "(budget_id, date)". */
  indexes?: readonly string[];
}

const b = (flag: boolean): number => (flag ? 1 : 0);

function entityTable<E extends Deletable>(def: EntityTable<E>): EntityTable {
  // Each `pick` only ever receives entities from its own list; erase the type for the shared loops.
  return def as unknown as EntityTable;
}

/**
 * The one table that drives DDL, upsert, delete and drop for every id-keyed entity. Each table has
 * `budget_id`, `id` and the columns listed here; the full entity JSON goes to `raw`. No foreign keys
 * between entity tables: a delta can reference rows that arrive later or are already gone.
 */
const ENTITY_TABLES: readonly EntityTable[] = [
  entityTable<Account>({
    table: "accounts",
    list: "accounts",
    columns: [
      ["name", "TEXT NOT NULL", (e) => e.name],
      ["type", "TEXT NOT NULL", (e) => e.type],
      ["on_budget", "INTEGER NOT NULL", (e) => b(e.on_budget)],
      ["closed", "INTEGER NOT NULL", (e) => b(e.closed)],
      ["balance", "INTEGER NOT NULL", (e) => e.balance],
      ["cleared_balance", "INTEGER NOT NULL", (e) => e.cleared_balance],
      ["uncleared_balance", "INTEGER NOT NULL", (e) => e.uncleared_balance],
      ["last_reconciled_at", "TEXT", (e) => e.last_reconciled_at ?? null],
      ["note", "TEXT", (e) => e.note ?? null],
    ],
  }),
  entityTable<Payee>({
    table: "payees",
    list: "payees",
    columns: [
      ["name", "TEXT NOT NULL", (e) => e.name],
      ["transfer_account_id", "TEXT", (e) => e.transfer_account_id ?? null],
    ],
  }),
  entityTable<CategoryGroup>({
    table: "category_groups",
    list: "category_groups",
    columns: [
      ["name", "TEXT NOT NULL", (e) => e.name],
      ["hidden", "INTEGER NOT NULL", (e) => b(e.hidden)],
    ],
  }),
  entityTable<Category>({
    table: "categories",
    list: "categories",
    columns: [
      ["category_group_id", "TEXT NOT NULL", (e) => e.category_group_id],
      ["category_group_name", "TEXT", (e) => e.category_group_name ?? null],
      ["name", "TEXT NOT NULL", (e) => e.name],
      ["hidden", "INTEGER NOT NULL", (e) => b(e.hidden)],
      ["internal", "INTEGER NOT NULL", (e) => b(e.internal)],
      ["note", "TEXT", (e) => e.note ?? null],
      ["goal_type", "TEXT", (e) => e.goal_type ?? null],
      ["goal_target", "INTEGER", (e) => e.goal_target ?? null],
      ["goal_target_date", "TEXT", (e) => e.goal_target_date ?? null],
      ["goal_snoozed_at", "TEXT", (e) => e.goal_snoozed_at ?? null],
      ["goal_cadence", "INTEGER", (e) => e.goal_cadence ?? null],
      ["goal_cadence_frequency", "INTEGER", (e) => e.goal_cadence_frequency ?? null],
      ["goal_needs_whole_amount", "INTEGER", (e) => (typeof e.goal_needs_whole_amount === "boolean" ? b(e.goal_needs_whole_amount) : null)],
    ],
    indexes: ["(budget_id, category_group_id)"],
  }),
  entityTable<Transaction>({
    table: "transactions",
    list: "transactions",
    columns: [
      ["date", "TEXT NOT NULL", (e) => e.date],
      ["amount", "INTEGER NOT NULL", (e) => e.amount],
      ["account_id", "TEXT NOT NULL", (e) => e.account_id],
      ["payee_id", "TEXT", (e) => e.payee_id ?? null],
      ["category_id", "TEXT", (e) => e.category_id ?? null],
      ["transfer_account_id", "TEXT", (e) => e.transfer_account_id ?? null],
      ["cleared", "TEXT NOT NULL", (e) => e.cleared],
      ["approved", "INTEGER NOT NULL", (e) => b(e.approved)],
      ["flag_color", "TEXT", (e) => e.flag_color ?? null],
      ["flag_name", "TEXT", (e) => e.flag_name ?? null],
      ["memo", "TEXT", (e) => e.memo ?? null],
      // The payee as the bank statement had it, before YNAB's cleanup and the owner's rename rules:
      // the name to search when a charge is not recognised under the name YNAB shows.
      ["imported_payee", "TEXT", (e) => e.import_payee_name_original ?? e.import_payee_name ?? null],
    ],
    indexes: ["(budget_id, date)", "(budget_id, category_id, date)", "(budget_id, payee_id, date)", "(budget_id, account_id, date)"],
  }),
  entityTable<SubTransaction>({
    table: "subtransactions",
    list: "subtransactions",
    columns: [
      ["transaction_id", "TEXT NOT NULL", (e) => e.transaction_id],
      ["amount", "INTEGER NOT NULL", (e) => e.amount],
      ["payee_id", "TEXT", (e) => e.payee_id ?? null],
      ["category_id", "TEXT", (e) => e.category_id ?? null],
      ["transfer_account_id", "TEXT", (e) => e.transfer_account_id ?? null],
      ["memo", "TEXT", (e) => e.memo ?? null],
    ],
    indexes: ["(budget_id, transaction_id)", "(budget_id, category_id)"],
  }),
  entityTable<ScheduledTransaction>({
    table: "scheduled_transactions",
    list: "scheduled_transactions",
    columns: [
      ["date_first", "TEXT NOT NULL", (e) => e.date_first],
      ["date_next", "TEXT NOT NULL", (e) => e.date_next],
      ["frequency", "TEXT NOT NULL", (e) => e.frequency],
      ["amount", "INTEGER NOT NULL", (e) => e.amount],
      ["account_id", "TEXT NOT NULL", (e) => e.account_id],
      ["payee_id", "TEXT", (e) => e.payee_id ?? null],
      ["category_id", "TEXT", (e) => e.category_id ?? null],
      ["transfer_account_id", "TEXT", (e) => e.transfer_account_id ?? null],
      ["memo", "TEXT", (e) => e.memo ?? null],
      ["flag_color", "TEXT", (e) => e.flag_color ?? null],
    ],
    indexes: ["(budget_id, date_next)"],
  }),
  entityTable<ScheduledSubTransaction>({
    table: "scheduled_subtransactions",
    list: "scheduled_subtransactions",
    columns: [
      ["scheduled_transaction_id", "TEXT NOT NULL", (e) => e.scheduled_transaction_id],
      ["amount", "INTEGER NOT NULL", (e) => e.amount],
      ["payee_id", "TEXT", (e) => e.payee_id ?? null],
      ["category_id", "TEXT", (e) => e.category_id ?? null],
      ["transfer_account_id", "TEXT", (e) => e.transfer_account_id ?? null],
      ["memo", "TEXT", (e) => e.memo ?? null],
    ],
    indexes: ["(budget_id, scheduled_transaction_id)"],
  }),
  entityTable<PayeeLocation>({
    table: "payee_locations",
    list: "payee_locations",
    columns: [["payee_id", "TEXT NOT NULL", (e) => e.payee_id]],
  }),
];

/** Tables holding one budget's rows; a replacing `applyBudget` empties exactly these. */
const BUDGET_SCOPED_TABLES: readonly string[] = [...ENTITY_TABLES.map((t) => t.table), "months", "month_categories", "raw"];

/** `raw.kind` values: an entity table name, or one of these for the month rows. */
export type RawKind = string;
const RAW_MONTH = "months";
const RAW_MONTH_CATEGORY = "month_categories";
const monthCategoryKey = (month: string, categoryId: string): string => `${month}/${categoryId}`;

const ALL_TABLES: readonly string[] = ["meta", "budgets", ...BUDGET_SCOPED_TABLES];

const BUDGET_ROW_SQL = `id, name, first_month, last_month, last_modified_on, currency_format, date_format, is_default, server_knowledge, last_synced_at`;

/** The `budgets` columns both upserts write, in `budgetValues` order. */
const BUDGET_UPSERT_COLUMNS = ["id", "name", "first_month", "last_month", "last_modified_on", "currency_format", "date_format"] as const;

/** `INSERT ... ON CONFLICT` for `budgets` writing the upsert columns plus `extra`, all placeholders counted from the lists. */
function budgetUpsertSql(extra: readonly string[]): string {
  const columns = [...BUDGET_UPSERT_COLUMNS, ...extra];
  const updates = columns.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`);
  return `INSERT INTO budgets (${columns.join(", ")}) VALUES (${placeholders(columns.length)})
          ON CONFLICT(id) DO UPDATE SET ${updates.join(", ")}`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** SQLite primary result codes for a file that is not a usable database. */
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

function isUnusableDatabase(error: unknown): boolean {
  const code = (error as { errcode?: unknown }).errcode;
  if (typeof code !== "number") return false;
  const primary = code & 0xff;
  return primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB;
}

function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    // The file holds whole budgets; keep it owner-only. SQLite gives the WAL sidecars the same mode.
    if (dbPath !== ":memory:") chmodSync(dbPath, 0o600);
    db.exec("PRAGMA journal_mode = WAL");
    // The text search's folding, run in SQL so the comparison happens where the rows are. SQLite's
    // own LOWER and LIKE fold ASCII only, which would leave "cafe" unable to find "Café".
    db.function("search_fold", { deterministic: true }, (value) => (typeof value === "string" ? searchable(value) : value));
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * The SQLite file holding every cached budget. Each budget keeps its own `server_knowledge`, so
 * several budgets stay delta-synced side by side. `applyBudget` applies a full or delta payload in
 * one transaction, so a failure part-way leaves the previous state intact.
 */
export class BudgetDb {
  readonly path: string;
  /** True when the file on disk was not a usable database and was discarded on open. */
  readonly discardedCorruptFile: boolean = false;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(dbPath: string = defaultDbPath()) {
    this.path = dbPath;
    if (dbPath !== ":memory:") {
      // The file holds whole budgets; keep the directory owner-only wherever it ends up.
      mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    try {
      this.db = openDatabase(dbPath);
    } catch (error) {
      if (dbPath === ":memory:" || !isUnusableDatabase(error)) throw error;
      // A truncated or foreign file: it is only a cache, so start over rather than refuse to start.
      for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
      this.db = openDatabase(dbPath);
      this.discardedCorruptFile = true;
    }
    this.ensureSchema();
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  // ---- budgets --------------------------------------------------------------------------------

  /** Record the account's budget list from `GET /plans`. Never touches a budget's synced fields. */
  upsertBudgetList(budgets: BudgetSummary[], defaultId: string | null, now: Date): void {
    this.transaction(() => {
      const upsert = this.stmt(budgetUpsertSql(["is_default"]));
      for (const budget of budgets) {
        upsert.run(...budgetValues(budget), b(budget.id === defaultId));
      }
      this.stmt("UPDATE budgets SET is_default = 0 WHERE id IS NOT ?").run(defaultId);
      this.setMeta("budgets_fetched_at", now.toISOString());
    });
  }

  budgetRow(id: string): BudgetRow | null {
    const row = this.stmt(`SELECT ${BUDGET_ROW_SQL} FROM budgets WHERE id = ?`).get(id);
    return row ? toBudgetRow(row) : null;
  }

  /** Every budget YNAB has listed or this server has synced, by name. */
  budgetRows(): BudgetRow[] {
    return this.stmt(`SELECT ${BUDGET_ROW_SQL} FROM budgets ORDER BY name, id`).all().map(toBudgetRow);
  }

  activeBudgetId(): string | null {
    return this.getMeta("active_budget_id");
  }

  setActiveBudgetId(id: string): void {
    this.setMeta("active_budget_id", id);
  }

  // ---- sync -----------------------------------------------------------------------------------

  /**
   * Apply a full or delta budget payload: every entity is upserted by id, entities flagged
   * `deleted` are removed, and the budget row takes the new knowledge and sync time. Runs in one
   * transaction; any failure rolls the whole payload back. Month-category rows are not counted.
   *
   * `replace` drops the budget's cached rows first, inside the same transaction, for a full
   * download that is the whole budget rather than changes to merge. Until the new copy commits the
   * old one is still there, so a sync that fails before this point never leaves the budget empty.
   */
  applyBudget(budgetId: string, budget: BudgetDetail, serverKnowledge: number, now: Date, options: { replace?: boolean } = {}): DeltaStats {
    const stats: DeltaStats = { upserted: 0, deleted: 0 };
    this.transaction(() => {
      if (options.replace) {
        for (const table of BUDGET_SCOPED_TABLES) this.stmt(`DELETE FROM ${table} WHERE budget_id = ?`).run(budgetId);
      }
      this.stmt(budgetUpsertSql(["server_knowledge", "last_synced_at"])).run(
        ...budgetValues({ ...budget, id: budgetId }),
        serverKnowledge,
        now.toISOString(),
      );

      for (const t of ENTITY_TABLES) {
        const entities = (budget[t.list] ?? []) as Deletable[];
        if (entities.length === 0) continue;
        const del = this.stmt(`DELETE FROM ${t.table} WHERE budget_id = ? AND id = ?`);
        const upsert = this.stmt(
          `INSERT OR REPLACE INTO ${t.table} (budget_id, id, ${t.columns.map((c) => c[0]).join(", ")})
           VALUES (${placeholders(t.columns.length + 2)})`,
        );
        for (const entity of entities) {
          if (entity.deleted) {
            stats.deleted += Number(del.run(budgetId, entity.id).changes);
            this.deleteRaw(budgetId, t.table, entity.id);
          } else {
            upsert.run(budgetId, entity.id, ...t.columns.map((c) => c[2](entity)));
            this.putRaw(budgetId, t.table, entity.id, entity);
            stats.upserted++;
          }
        }
      }

      this.applyMonths(budgetId, budget, stats);
    });
    return stats;
  }

  /**
   * Months are keyed by date, and a delta month carries only the categories that changed within
   * it, so month-category rows are upserted individually rather than replacing the month's list.
   */
  private applyMonths(budgetId: string, budget: BudgetDetail, stats: DeltaStats): void {
    const months = budget.months ?? [];
    if (months.length === 0) return;
    const delMonth = this.stmt("DELETE FROM months WHERE budget_id = ? AND month = ?");
    const delMonthCategories = this.stmt("DELETE FROM month_categories WHERE budget_id = ? AND month = ?");
    const upsertMonth = this.stmt(
      `INSERT OR REPLACE INTO months (budget_id, month, income, budgeted, activity, to_be_budgeted, age_of_money, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const delCategory = this.stmt("DELETE FROM month_categories WHERE budget_id = ? AND month = ? AND category_id = ?");
    const upsertCategory = this.stmt(
      `INSERT OR REPLACE INTO month_categories (budget_id, month, category_id, budgeted, activity, balance, goal_under_funded)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const delMonthCategoryRaw = this.stmt("DELETE FROM raw WHERE budget_id = ? AND kind = ? AND id GLOB ?");
    for (const month of months) {
      if (month.deleted) {
        stats.deleted += Number(delMonth.run(budgetId, month.month).changes);
        delMonthCategories.run(budgetId, month.month);
        this.deleteRaw(budgetId, RAW_MONTH, month.month);
        delMonthCategoryRaw.run(budgetId, RAW_MONTH_CATEGORY, `${month.month}/*`);
        continue;
      }
      const { categories, ...rest } = month;
      upsertMonth.run(
        budgetId,
        month.month,
        month.income,
        month.budgeted,
        month.activity,
        month.to_be_budgeted,
        month.age_of_money ?? null,
        month.note ?? null,
      );
      this.putRaw(budgetId, RAW_MONTH, month.month, rest);
      stats.upserted++;
      for (const c of categories ?? []) {
        if (c.deleted) {
          delCategory.run(budgetId, month.month, c.id);
          this.deleteRaw(budgetId, RAW_MONTH_CATEGORY, monthCategoryKey(month.month, c.id));
        } else {
          upsertCategory.run(budgetId, month.month, c.id, c.budgeted, c.activity, c.balance, c.goal_under_funded ?? null);
          this.putRaw(budgetId, RAW_MONTH_CATEGORY, monthCategoryKey(month.month, c.id), c);
        }
      }
    }
  }

  /**
   * The entity exactly as YNAB sent it, for fields that are not columns. `kind` is an entity table
   * name (`transactions`, `categories`, ...), or `months` / `month_categories` keyed by month and
   * `"<month>/<category id>"`.
   */
  raw<T = unknown>(budgetId: string, kind: RawKind, id: string): T | null {
    const row = this.stmt("SELECT data FROM raw WHERE budget_id = ? AND kind = ? AND id = ?").get(budgetId, kind, id);
    return row ? (JSON.parse(row.data as string) as T) : null;
  }

  private putRaw(budgetId: string, kind: RawKind, id: string, entity: unknown): void {
    this.stmt("INSERT OR REPLACE INTO raw (budget_id, kind, id, data) VALUES (?, ?, ?, ?)").run(budgetId, kind, id, JSON.stringify(entity));
  }

  private deleteRaw(budgetId: string, kind: RawKind, id: string): void {
    this.stmt("DELETE FROM raw WHERE budget_id = ? AND kind = ? AND id = ?").run(budgetId, kind, id);
  }

  // ---- queries --------------------------------------------------------------------------------

  transactionLines(budgetId: string, filter: TransactionFilter = {}): TransactionLine[] {
    const params: Record<string, SqlValue> = { b: budgetId };
    const where: string[] = [];
    const add = (clause: string, name: string, value: SqlValue | undefined) => {
      if (value === undefined) return;
      where.push(clause);
      params[name] = value;
    };
    add("l.date >= $from", "from", filter.from);
    add("l.date <= $to", "to", filter.to);
    add("l.account_id = $account", "account", filter.accountId);
    add("l.category_id = $category", "category", filter.categoryId);
    add("l.payee_id = $payee", "payee", filter.payeeId);
    // Bound, never interpolated: the SQL text keys the statement cache. -1 is SQLite's "no limit".
    params.limit = filter.limit !== undefined && Number.isFinite(filter.limit) ? Math.max(0, Math.floor(filter.limit)) : -1;

    // Filter, order and limit the lines first so the name lookups run only for the page returned.
    const sql = `
      WITH lines AS (${LINES_CTE}),
      page AS (
        SELECT * FROM lines l
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY l.date DESC, l.parent_id, l.id
        LIMIT $limit
      )
      SELECT l.*, COALESCE(a.name, '(unknown account)') AS account_name, p.name AS payee_name,
             c.name AS category_name, COALESCE(g.name, c.category_group_name) AS category_group_name
      FROM page l
      LEFT JOIN accounts a        ON a.budget_id = $b AND a.id = l.account_id
      LEFT JOIN payees p          ON p.budget_id = $b AND p.id = l.payee_id
      LEFT JOIN categories c      ON c.budget_id = $b AND c.id = l.category_id
      LEFT JOIN category_groups g ON g.budget_id = $b AND g.id = c.category_group_id
      ORDER BY l.date DESC, l.parent_id, l.id`;

    return this.stmt(sql).all(params).map(toTransactionLine);
  }

  /**
   * The spending lines in range: every flattened line on an on-budget account that either carries a
   * non-internal category, or carries no category and is not a transfer to another on-budget
   * account. A transfer to a tracking account stays, in its category or as Uncategorized until it
   * has one (YNAB counts it as spending either way); a transfer between budget accounts, a line on a
   * tracking account and an inflow all drop out. A line whose category id no longer
   * resolves stays too, named `(deleted category)`, so the total still reconciles.
   */
  spendingLines(budgetId: string, filter: SpendingFilter = {}): TransactionLine[] {
    const { where, params } = spendingWhere(budgetId, filter);
    const sql = `
      WITH lines AS (${LINES_CTE})
      SELECT l.*, a.name AS account_name, p.name AS payee_name,
             ${CATEGORY_NAME} AS category_name, ${CATEGORY_GROUP_NAME} AS category_group_name
      ${SPENDING_FROM}
      WHERE ${[SPENDING_RULE, ...where].join(" AND ")}
      ORDER BY l.date DESC, l.parent_id, l.id`;
    return this.stmt(sql).all(params).map(toTransactionLine);
  }

  /**
   * The spending lines in range, bucketed. Entity buckets come most-spent first (the sums are
   * negative, so ascending), months chronologically.
   */
  spendingBy(budgetId: string, groupBy: SpendingGroupBy, filter: SpendingFilter = {}): SpendingAggregate[] {
    const { where, params } = spendingWhere(budgetId, filter);
    const grouping = SPENDING_GROUPINGS[groupBy];
    const sql = `
      WITH lines AS (${LINES_CTE})
      SELECT ${grouping.key} AS key, ${grouping.name} AS name, ${grouping.extra}
             COUNT(*) AS count, SUM(l.amount) AS spent
      ${SPENDING_FROM}
      WHERE ${[SPENDING_RULE, ...where].join(" AND ")}
      GROUP BY ${grouping.key}, ${grouping.name}
      ORDER BY ${groupBy === "month" ? "key ASC" : "spent ASC, name ASC"}`;
    return this.stmt(sql)
      .all(params)
      .map((r) => {
        const row: SpendingAggregate = {
          key: (r.key as string | null) ?? null,
          name: r.name as string,
          count: Number(r.count),
          spent: Number(r.spent),
        };
        if (groupBy === "category") {
          row.groupName = r.group_name as string;
          row.hidden = Number(r.hidden) === 1;
        }
        return row;
      });
  }

  /**
   * The spending lines in range summed per month per category (or per category group), so a trend
   * over several series is one pass over the lines rather than one per series. A line whose
   * entity is missing — no category, a deleted one, a group that is gone — comes back under a null
   * key, so an unfiltered call still adds up to all spending; a filter by id never reaches one.
   */
  spendingByMonth(budgetId: string, splitBy: "category" | "category_group", filter: SpendingFilter = {}): MonthlySpending[] {
    const { where, params } = spendingWhere(budgetId, filter);
    const key = splitBy === "category" ? "c.id" : "g.id";
    const sql = `
      WITH lines AS (${LINES_CTE})
      SELECT ${key} AS key, SUBSTR(l.date, 1, 7) AS month, SUM(l.amount) AS spent
      ${SPENDING_FROM}
      WHERE ${[SPENDING_RULE, ...where].join(" AND ")}
      GROUP BY ${key}, month
      ORDER BY ${key}, month`;
    return this.stmt(sql)
      .all(params)
      .map((r) => ({ key: (r.key as string | null) ?? null, month: r.month as string, spent: Number(r.spent) }));
  }

  /** The line count and milliunit sum of every spending line the filter selects. */
  spendingTotal(budgetId: string, filter: SpendingFilter = {}): { count: number; spent: number } {
    const { where, params } = spendingWhere(budgetId, filter);
    const sql = `
      WITH lines AS (${LINES_CTE})
      SELECT COUNT(*) AS count, COALESCE(SUM(l.amount), 0) AS spent
      ${SPENDING_FROM}
      WHERE ${[SPENDING_RULE, ...where].join(" AND ")}`;
    const r = this.stmt(sql).get(params)!;
    return { count: Number(r.count), spent: Number(r.spent) };
  }

  /**
   * Why the spending total is not the register total: the lines the same filter reached that the
   * rule dropped. Each line falls in exactly one bucket, tracking first, so the three counts can be
   * added up without double counting.
   */
  spendingExclusions(budgetId: string, filter: SpendingFilter = {}): SpendingExclusions {
    const { where, params } = spendingWhere(budgetId, filter);
    const sql = `
      WITH lines AS (${LINES_CTE})
      SELECT
        SUM(CASE WHEN COALESCE(a.on_budget, 0) = 0 THEN 1 ELSE 0 END) AS tracking,
        SUM(CASE WHEN COALESCE(a.on_budget, 0) = 1 AND ${INCOME_RULE} THEN 1 ELSE 0 END) AS inflows,
        SUM(CASE WHEN COALESCE(a.on_budget, 0) = 1 AND l.category_id IS NULL AND ${BUDGET_TRANSFER}
                 THEN 1 ELSE 0 END) AS transfers
      FROM lines l
      LEFT JOIN accounts a   ON a.budget_id = $b AND a.id = l.account_id
      LEFT JOIN categories c ON c.budget_id = $b AND c.id = l.category_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    const r = this.stmt(sql).get(params)!;
    return { transfers: Number(r.transfers ?? 0), tracking: Number(r.tracking ?? 0), inflows: Number(r.inflows ?? 0) };
  }

  /**
   * What came in and what went out, per month that has either in range. `income` is the income
   * lines' sum, which is Inflow: Ready to Assign's own activity; `spent` is the spending rule's;
   * `toTracking` is the part of `spent` that moved to a tracking account. Income plus spending is
   * exactly what the on-budget accounts grew by: the only other lines on them are transfers between
   * them, and those cancel out.
   */
  cashFlowByMonth(budgetId: string, filter: DateFilter = {}): CashFlowMonth[] {
    const { where, params } = spendingWhere(budgetId, filter);
    const sql = `
      WITH lines AS (${LINES_CTE})
      SELECT SUBSTR(l.date, 1, 7) AS month,
             COALESCE(SUM(CASE WHEN ${INCOME_RULE} THEN l.amount END), 0) AS income,
             COALESCE(SUM(CASE WHEN ${SPENDING_RULE} THEN l.amount END), 0) AS spent,
             COALESCE(SUM(CASE WHEN ${SPENDING_RULE} AND ${TRACKING_TRANSFER} THEN l.amount END), 0) AS to_tracking
      ${SPENDING_FROM}
      WHERE ${[`(${INCOME_RULE} OR ${SPENDING_RULE})`, ...where].join(" AND ")}
      GROUP BY month
      ORDER BY month`;
    return this.stmt(sql)
      .all(params)
      .map((r) => ({ month: r.month as string, income: Number(r.income), spent: Number(r.spent), toTracking: Number(r.to_tracking) }));
  }

  /**
   * The income lines in range summed per payee, largest first: who the money came from. Lines with
   * no payee share one `(no payee)` bucket.
   */
  incomeBySource(budgetId: string, filter: DateFilter = {}): FlowAggregate[] {
    const { where, params } = spendingWhere(budgetId, filter);
    const sql = `
      WITH lines AS (${LINES_CTE})
      SELECT p.id AS key, COALESCE(p.name, '(no payee)') AS name, COUNT(*) AS count, SUM(l.amount) AS amount,
             COUNT(DISTINCT SUBSTR(l.date, 1, 7)) AS months
      ${SPENDING_FROM}
      WHERE ${[INCOME_RULE, ...where].join(" AND ")}
      GROUP BY p.id, p.name
      ORDER BY amount DESC, name ASC`;
    return this.stmt(sql).all(params).map(toFlowAggregate);
  }

  /**
   * The spending lines in range that moved money to a tracking account, summed per account, most
   * moved first (the sums are negative, so ascending).
   */
  trackingTransfers(budgetId: string, filter: DateFilter = {}): FlowAggregate[] {
    const { where, params } = spendingWhere(budgetId, filter);
    const sql = `
      WITH lines AS (${LINES_CTE})
      SELECT l.transfer_account_id AS key, dest.name AS name, COUNT(*) AS count, SUM(l.amount) AS amount,
             COUNT(DISTINCT SUBSTR(l.date, 1, 7)) AS months
      ${SPENDING_FROM}
      JOIN accounts dest ON dest.budget_id = $b AND dest.id = l.transfer_account_id
      WHERE ${[SPENDING_RULE, TRACKING_TRANSFER, ...where].join(" AND ")}
      GROUP BY l.transfer_account_id, dest.name
      ORDER BY amount ASC, name ASC`;
    return this.stmt(sql).all(params).map(toFlowAggregate);
  }

  /**
   * The lines a search matches, newest first. Unlike the spending queries this applies no rule at
   * all: tracking accounts, transfers between budget accounts and inflows are all reachable,
   * because a drill-down is about finding a transaction, not about reconciling a report.
   */
  searchLines(budgetId: string, filter: SearchFilter = {}): TransactionLine[] {
    const { where, params } = searchWhere(budgetId, filter);
    // Bound, never interpolated: the SQL text keys the statement cache. -1 is SQLite's "no limit".
    params.limit = filter.limit !== undefined && Number.isFinite(filter.limit) ? Math.max(0, Math.floor(filter.limit)) : -1;
    const sql = `
      WITH lines AS (${LINES_CTE})
      SELECT l.*, COALESCE(a.name, '(unknown account)') AS account_name, p.name AS payee_name,
             ${SEARCH_CATEGORY_NAME} AS category_name, ${SEARCH_GROUP_NAME} AS category_group_name
      ${SEARCH_FROM}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY l.date DESC, l.parent_id, l.id
      LIMIT $limit`;
    return this.stmt(sql).all(params).map(toTransactionLine);
  }

  /**
   * How many lines the search matched and what they add up to, signed as YNAB stores them. Counted
   * separately from `searchLines` so a capped page still reports the whole picture.
   */
  searchTotal(budgetId: string, filter: SearchFilter = {}): { count: number; sum: number } {
    const { where, params } = searchWhere(budgetId, filter);
    const sql = `
      WITH lines AS (${LINES_CTE})
      SELECT COUNT(*) AS count, COALESCE(SUM(l.amount), 0) AS sum
      ${SEARCH_FROM}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    const r = this.stmt(sql).get(params)!;
    return { count: Number(r.count), sum: Number(r.sum) };
  }

  /**
   * Turn what a user said into ids. Each string is tried as an id first, then as a whole name, then
   * as a part of a name that exactly one entity contains, all compared with `fold()` so case,
   * accents, emoji and surrounding whitespace do not matter. A string that matches nothing, or
   * more than one entity at the step it stops at, throws `NameResolutionError` naming the input
   * and every candidate.
   */
  resolveEntities(budgetId: string, input: EntityNames): ResolvedEntities {
    const resolved: ResolvedEntities = {};
    for (const kind of Object.keys(RESOLVABLE) as (keyof EntityNames)[]) {
      const values = input[kind];
      if (values === undefined) continue;
      const table = RESOLVABLE[kind];
      // The table name comes from RESOLVABLE, never from the caller.
      const rows = this.stmt(`SELECT id, name FROM ${table.table} WHERE budget_id = ?`)
        .all(budgetId)
        .map((r) => ({ id: r.id as string, name: r.name as string }));
      const index = indexEntities(rows);
      resolved[table.key] = values.map((value) => resolveOne(value, index, table));
    }
    return resolved;
  }

  /**
   * The display names of ids the caller already holds — the other direction from `resolveEntities`,
   * for a report that filtered by id and must still label its rows with something a person reads.
   * Unlike `categoryTree` this hides nothing: a hidden or internal entity has a name too, and an id
   * with no row simply has no entry.
   */
  entityLabels(budgetId: string, kind: keyof EntityNames, ids: string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const table = RESOLVABLE[kind];
    // The table name comes from RESOLVABLE, never from the caller.
    const rows = this.stmt(`SELECT id, name FROM ${table.table} WHERE budget_id = ?`).all(budgetId);
    const names = new Map(rows.map((r) => [r.id as string, r.name as string]));
    return new Map(ids.filter((id) => names.has(id)).map((id) => [id, names.get(id)!]));
  }

  /**
   * Every scheduled transaction, soonest first, each with its split lines by id. A split's line
   * inherits nothing here — the tool reports the parent and its lines side by side — so a line
   * names only what it carries.
   */
  scheduledRows(budgetId: string): ScheduledRow[] {
    const rows = this.stmt(
      `SELECT st.id, st.date_first, st.date_next, st.frequency, st.amount, st.account_id, st.transfer_account_id,
              st.memo, st.flag_color,
              COALESCE(a.name, '(unknown account)') AS account_name, COALESCE(a.on_budget, 0) AS account_on_budget,
              p.name AS payee_name, ${lineCategoryName("st")} AS category_name, ${lineGroupName("st")} AS category_group_name,
              ta.name AS transfer_account_name, ta.on_budget AS transfer_account_on_budget
       FROM scheduled_transactions st
       LEFT JOIN accounts a        ON a.budget_id = $b AND a.id = st.account_id
       LEFT JOIN accounts ta       ON ta.budget_id = $b AND ta.id = st.transfer_account_id
       LEFT JOIN payees p          ON p.budget_id = $b AND p.id = st.payee_id
       LEFT JOIN categories c      ON c.budget_id = $b AND c.id = st.category_id
       LEFT JOIN category_groups g ON g.budget_id = $b AND g.id = c.category_group_id
       WHERE st.budget_id = $b
       ORDER BY st.date_next, st.id`,
    ).all({ b: budgetId });

    const lines = this.stmt(
      `SELECT s.id, s.scheduled_transaction_id, s.amount, s.memo, s.transfer_account_id,
              p.name AS payee_name, ${lineCategoryName("s")} AS category_name, ${lineGroupName("s")} AS category_group_name,
              ta.name AS transfer_account_name, ta.on_budget AS transfer_account_on_budget
       FROM scheduled_subtransactions s
       LEFT JOIN accounts ta       ON ta.budget_id = $b AND ta.id = s.transfer_account_id
       LEFT JOIN payees p          ON p.budget_id = $b AND p.id = s.payee_id
       LEFT JOIN categories c      ON c.budget_id = $b AND c.id = s.category_id
       LEFT JOIN category_groups g ON g.budget_id = $b AND g.id = c.category_group_id
       WHERE s.budget_id = $b
       ORDER BY s.id`,
    ).all({ b: budgetId });

    const byParent = new Map<string, ScheduledLine[]>();
    for (const r of lines) {
      const parent = r.scheduled_transaction_id as string;
      const list = byParent.get(parent) ?? [];
      list.push(toScheduledLine(r));
      byParent.set(parent, list);
    }

    return rows.map((r) => ({
      ...toScheduledLine(r),
      dateFirst: r.date_first as string,
      dateNext: r.date_next as string,
      frequency: r.frequency as string,
      accountId: r.account_id as string,
      accountName: r.account_name as string,
      accountOnBudget: Number(r.account_on_budget) === 1,
      flagColor: (r.flag_color as string | null) ?? null,
      lines: byParent.get(r.id as string) ?? [],
    }));
  }

  /**
   * Every category's group id, hidden and internal categories included: what naming a group
   * expands to when a report groups categories its own way.
   */
  categoryGroupIds(budgetId: string): Map<string, string> {
    const rows = this.stmt(`SELECT id, category_group_id FROM categories WHERE budget_id = ?`).all(budgetId);
    return new Map(rows.map((r) => [r.id as string, r.category_group_id as string]));
  }

  /** The ids of YNAB's own categories (`Inflow: Ready to Assign`, `Uncategorized`), which the spending rule never counts. */
  internalCategoryIds(budgetId: string): Set<string> {
    const rows = this.stmt(`SELECT id FROM categories WHERE budget_id = ? AND internal = 1`).all(budgetId);
    return new Set(rows.map((r) => r.id as string));
  }

  /** The date of the earliest cached transaction, or null for an empty budget: the register's lower edge. */
  earliestDate(budgetId: string): string | null {
    const r = this.stmt(`SELECT MIN(date) AS earliest FROM transactions WHERE budget_id = ?`).get(budgetId);
    return (r?.earliest as string | null) ?? null;
  }

  month(budgetId: string, month: string): MonthRow | null {
    const r = this.stmt(
      "SELECT month, income, budgeted, activity, to_be_budgeted, age_of_money, note FROM months WHERE budget_id = ? AND month = ?",
    ).get(budgetId, month);
    return r ? toMonthRow(r) : null;
  }

  monthCategories(budgetId: string, month: string): MonthCategoryRow[] {
    return this.stmt(
      `SELECT category_id, budgeted, activity, balance, goal_under_funded FROM month_categories
       WHERE budget_id = ? AND month = ? ORDER BY category_id`,
    )
      .all(budgetId, month)
      .map(toMonthCategoryRow);
  }

  /**
   * Category groups with their categories, ordered alphabetically and nested. Internal categories
   * (`Inflow: Ready to Assign`, `Uncategorized`) are always left out — the filter is the category's
   * own flag, never the group's, because YNAB marks the `Credit Card Payments` group internal while
   * its five categories are not. Groups left with no categories are dropped.
   */
  categoryTree(budgetId: string, options: CategoryTreeOptions = {}): CategoryTreeGroup[] {
    const rows = this.stmt(
      `SELECT c.id, c.name, c.note, c.goal_type, c.goal_target, c.goal_target_date, c.goal_snoozed_at,
              c.goal_cadence, c.goal_cadence_frequency, c.goal_needs_whole_amount, c.hidden,
              ${GROUP_COLUMNS}
       FROM categories c
       ${GROUP_JOIN}
       WHERE c.budget_id = ? AND c.internal = 0`,
    ).all(budgetId);

    const term = options.search === undefined ? null : fold(options.search);
    // A term that folds away to nothing — an emoji or whitespace on its own — matches nothing.
    // Falling through to the unfiltered list would hand back the whole budget as "search results".
    if (term === "") return [];
    // A group-name hit returns that group's whole list, so the matching groups are settled first.
    const matchedGroups = new Set<string>();
    if (term) {
      for (const r of rows) {
        const group = r.group_name as string;
        if (fold(group).includes(term)) matchedGroups.add(group);
      }
    }

    const groups = new Map<string, CategoryTreeGroup>();
    for (const r of rows) {
      const hidden = isHidden(r);
      if (hidden && !options.includeHidden) continue;
      const groupName = r.group_name as string;
      const name = r.name as string;
      if (term && !matchedGroups.has(groupName) && !fold(name).includes(term)) continue;
      let group = groups.get(groupName);
      if (!group) {
        group = { name: groupName, categories: [] };
        groups.set(groupName, group);
      }
      group.categories.push({
        id: r.id as string,
        name,
        note: (r.note as string | null) ?? null,
        goalType: (r.goal_type as string | null) ?? null,
        goalTarget: r.goal_target === null ? null : Number(r.goal_target),
        goalTargetDate: (r.goal_target_date as string | null) ?? null,
        goalSnoozedAt: (r.goal_snoozed_at as string | null) ?? null,
        goalCadence: r.goal_cadence === null ? null : Number(r.goal_cadence),
        goalCadenceFrequency: r.goal_cadence_frequency === null ? null : Number(r.goal_cadence_frequency),
        goalNeedsWholeAmount: r.goal_needs_whole_amount === null ? null : Number(r.goal_needs_whole_amount) === 1,
        hidden,
      });
    }

    const ordered = [...groups.values()].sort(byName((g) => g.name));
    for (const group of ordered) group.categories.sort(byName((c) => c.name));
    return ordered;
  }

  /** Accounts ordered by type then name, with the closed ones counted whether or not they are returned. */
  accountRows(budgetId: string, options: { includeClosed?: boolean } = {}): AccountListing {
    const rows = this.stmt(
      `SELECT id, name, type, on_budget, closed, balance, cleared_balance, uncleared_balance, last_reconciled_at, note
       FROM accounts WHERE budget_id = ?`,
    )
      .all(budgetId)
      .map(
        (r): AccountRow => ({
          id: r.id as string,
          name: r.name as string,
          type: r.type as string,
          onBudget: Number(r.on_budget) === 1,
          closed: Number(r.closed) === 1,
          balance: Number(r.balance),
          clearedBalance: Number(r.cleared_balance),
          unclearedBalance: Number(r.uncleared_balance),
          lastReconciledAt: (r.last_reconciled_at as string | null) ?? null,
          note: (r.note as string | null) ?? null,
        }),
      );

    const closed = rows.filter((a) => a.closed).length;
    const accounts = options.includeClosed ? rows : rows.filter((a) => !a.closed);
    const byAccountName = byName<AccountRow>((a) => a.name);
    accounts.sort((a, b) => a.type.localeCompare(b.type) || byAccountName(a, b));
    return { accounts, closedOmitted: options.includeClosed ? 0 : closed };
  }

  /**
   * The same per-month category figures across a window of months, one row per category per month
   * it has a row in, ordered by category then month. Internal categories are left out, as in
   * `monthDetail`, and a category whose row no longer resolves keeps its figures under
   * `(deleted category)` rather than disappearing from a range the header still counts.
   */
  monthCategoryRange(budgetId: string, months: string[], filter: MonthCategoryFilter = {}): MonthCategoryRangeRow[] {
    if (months.length === 0) return [];
    const params: Record<string, SqlValue> = { b: budgetId };
    const where: string[] = [];
    // Months are stored as the first day of the month; the caller speaks in `YYYY-MM` keys.
    inList(where, params, "mc.month", "months", months.map((month) => `${month}-01`));
    inList(where, params, "mc.category_id", "cat", filter.categoryIds);
    inList(where, params, "c.category_group_id", "grp", filter.groupIds);

    return this.stmt(
      `SELECT mc.month, mc.category_id, mc.budgeted, mc.activity, mc.balance,
              COALESCE(c.name, '(deleted category)') AS name, COALESCE(c.hidden, 0) AS hidden,
              ${GROUP_COLUMNS}
       FROM month_categories mc
       LEFT JOIN categories c ON c.budget_id = mc.budget_id AND c.id = mc.category_id
       ${GROUP_JOIN}
       WHERE mc.budget_id = $b AND COALESCE(c.internal, 0) = 0 AND ${where.join(" AND ")}
       ORDER BY mc.category_id, mc.month`,
    )
      .all(params)
      .map((r): MonthCategoryRangeRow => {
        const groupName = r.group_name as string;
        return {
          month: (r.month as string).slice(0, 7),
          categoryId: r.category_id as string,
          name: r.name as string,
          groupName,
          hidden: isHidden(r),
          // YNAB names this group itself and does not let anyone rename it, and the cache keeps no
          // internal flag for groups, so the name is what tells a payment apart from spending.
          creditCardPayment: groupName === CREDIT_CARD_PAYMENTS,
          budgeted: Number(r.budgeted),
          activity: Number(r.activity),
          balance: Number(r.balance),
        };
      });
  }

  /**
   * One month's own totals with its category rows joined to their names and groups, ordered by
   * group then category. Internal categories are left out here too, so the rows still add up to
   * the month's totals: YNAB excludes `Inflow: Ready to Assign` from a month's `activity`.
   * Null when the month is not cached.
   */
  monthDetail(budgetId: string, month: string): MonthDetail | null {
    const monthRow = this.month(budgetId, month);
    if (!monthRow) return null;
    const categories = this.stmt(
      // The category join is outer on purpose: deleting a category drops its `categories` row but
      // leaves its rows in months already cached, and an inner join would silently swallow those
      // figures while the header above still counts them — subtotals that cannot be reconciled.
      `SELECT mc.category_id, mc.budgeted, mc.activity, mc.balance, mc.goal_under_funded,
              COALESCE(c.name, '(deleted category)') AS name, COALESCE(c.hidden, 0) AS hidden,
              ${GROUP_COLUMNS}
       FROM month_categories mc
       LEFT JOIN categories c ON c.budget_id = mc.budget_id AND c.id = mc.category_id
       ${GROUP_JOIN}
       WHERE mc.budget_id = ? AND mc.month = ? AND COALESCE(c.internal, 0) = 0`,
    )
      .all(budgetId, month)
      .map(
        (r): MonthCategoryDetail => ({
          ...toMonthCategoryRow(r),
          name: r.name as string,
          groupName: r.group_name as string,
          hidden: isHidden(r),
        }),
      );

    const byCategory = byName<MonthCategoryDetail>((c) => c.name);
    const byGroup = byName<MonthCategoryDetail>((c) => c.groupName);
    categories.sort((a, b) => byGroup(a, b) || byCategory(a, b));
    return { ...monthRow, categories };
  }

  summary(budgetId: string): CacheSummary {
    const r = this.stmt(
      `SELECT
         (SELECT COUNT(*) FROM transactions WHERE budget_id = $b) AS transactions,
         (SELECT COUNT(*) FROM transactions t WHERE t.budget_id = $b
            AND EXISTS (SELECT 1 FROM subtransactions s WHERE s.budget_id = t.budget_id AND s.transaction_id = t.id)) AS split_parents,
         (SELECT COUNT(*) FROM subtransactions WHERE budget_id = $b) AS split_lines,
         (SELECT MIN(date) FROM transactions WHERE budget_id = $b) AS earliest,
         (SELECT MAX(date) FROM transactions WHERE budget_id = $b) AS latest,
         (SELECT COUNT(*) FROM accounts WHERE budget_id = $b) AS accounts,
         (SELECT COUNT(*) FROM accounts WHERE budget_id = $b AND closed = 0) AS open_accounts,
         (SELECT COUNT(*) FROM categories WHERE budget_id = $b AND hidden = 0) AS visible_categories,
         (SELECT COUNT(*) FROM payees WHERE budget_id = $b) AS payees,
         (SELECT COUNT(*) FROM months WHERE budget_id = $b) AS months`,
    ).get({ b: budgetId })!;
    return {
      transactions: Number(r.transactions),
      splitParents: Number(r.split_parents),
      splitLines: Number(r.split_lines),
      earliest: (r.earliest as string | null) ?? null,
      latest: (r.latest as string | null) ?? null,
      accounts: Number(r.accounts),
      openAccounts: Number(r.open_accounts),
      visibleCategories: Number(r.visible_categories),
      payees: Number(r.payees),
      months: Number(r.months),
    };
  }

  // ---- internals ------------------------------------------------------------------------------

  private getMeta(key: string): string | null {
    const row = this.stmt("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? (row.value as string) : null;
  }

  private setMeta(key: string, value: string): void {
    this.stmt("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      // `isTransaction` only exists from Node 22.16; a bare ROLLBACK works on every supported version.
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Nothing to roll back: the failure already ended the transaction.
      }
      throw error;
    }
  }

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /**
   * Create the schema, or rebuild it when the file does not match this build. Tables are dropped
   * rather than the file deleted so `:memory:` and file databases behave the same and the WAL
   * sidecars are never raced.
   */
  private ensureSchema(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    if (this.schemaMatches()) return;

    this.transaction(() => {
      // Another process may have rebuilt the file while we waited for the write lock; BEGIN
      // IMMEDIATE reads the state it committed, so a second rebuild would only discard its work.
      if (this.schemaMatches()) return;
      // Children before `budgets`: foreign keys are on, and DROP TABLE enforces them.
      for (const table of [...ALL_TABLES].reverse()) this.db.exec(`DROP TABLE IF EXISTS ${table}`);
      this.db.exec(schemaDdl());
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_fingerprint', ?)").run(schemaFingerprint());
    });
  }

  /** True when the file carries this build's schema and every table it expects is present. */
  private schemaMatches(): boolean {
    const stored = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_fingerprint'").get();
    if (stored?.value !== schemaFingerprint()) return false;
    const existing = new Set(
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name as string),
    );
    return ALL_TABLES.every((t) => existing.has(t));
  }
}

let fingerprint: string | null = null;

/**
 * Bump when a change alters what is written into columns whose DDL is unchanged: a reworked value
 * extractor, row key or flattening rule. Those live outside `schemaDdl()`, so nothing else can
 * invalidate a cache still holding rows the old logic wrote.
 */
const CACHE_EPOCH = 1;

/**
 * A digest of the DDL this build generates, plus `CACHE_EPOCH`. Every change to a table, column or
 * index changes this too, and a file that does not carry it is rebuilt (all tables dropped) and
 * refilled by a full sync. Only a change to how rows are populated needs the epoch bumped by hand.
 */
export function schemaFingerprint(): string {
  fingerprint ??= digestSchema(schemaDdl());
  return fingerprint;
}

/** The digest of one schema. Exported so a test can pin `schemaFingerprint` to the DDL it claims to cover. */
export function digestSchema(ddl: string): string {
  return createHash("sha256").update(ddl).update(String(CACHE_EPOCH)).digest("hex").slice(0, 16);
}

export function schemaDdl(): string {
  const ddl: string[] = [
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    `CREATE TABLE budgets (
       id TEXT PRIMARY KEY, name TEXT NOT NULL,
       first_month TEXT, last_month TEXT, last_modified_on TEXT,
       currency_format TEXT, date_format TEXT,
       is_default INTEGER NOT NULL DEFAULT 0,
       server_knowledge INTEGER, last_synced_at TEXT
     )`,
  ];
  const budgetFk = "budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE";
  for (const t of ENTITY_TABLES) {
    ddl.push(
      `CREATE TABLE ${t.table} (
         ${budgetFk}, id TEXT NOT NULL,
         ${t.columns.map(([name, type]) => `${name} ${type}`).join(", ")},
         PRIMARY KEY (budget_id, id)
       )`,
    );
    for (const index of t.indexes ?? []) {
      const name = index.replace(/[()\s]/g, "").replace(/,/g, "_");
      ddl.push(`CREATE INDEX ${t.table}_by_${name} ON ${t.table} ${index}`);
    }
  }
  ddl.push(
    `CREATE TABLE months (
       ${budgetFk}, month TEXT NOT NULL,
       income INTEGER NOT NULL, budgeted INTEGER NOT NULL, activity INTEGER NOT NULL, to_be_budgeted INTEGER NOT NULL,
       age_of_money INTEGER, note TEXT,
       PRIMARY KEY (budget_id, month)
     )`,
    `CREATE TABLE month_categories (
       ${budgetFk}, month TEXT NOT NULL, category_id TEXT NOT NULL,
       budgeted INTEGER NOT NULL, activity INTEGER NOT NULL, balance INTEGER NOT NULL,
       goal_under_funded INTEGER,
       PRIMARY KEY (budget_id, month, category_id)
     )`,
    "CREATE INDEX month_categories_by_category ON month_categories (budget_id, category_id, month)",
    // The full JSON of every entity, kept out of the queried tables so their B-trees stay small.
    `CREATE TABLE raw (
       ${budgetFk}, kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
       PRIMARY KEY (budget_id, kind, id)
     )`,
  );
  return ddl.join(";\n") + ";";
}

function budgetValues(budget: BudgetSummary | BudgetDetail): [string, string, SqlValue, SqlValue, SqlValue, SqlValue, SqlValue] {
  return [
    budget.id,
    budget.name,
    budget.first_month ?? null,
    budget.last_month ?? null,
    budget.last_modified_on ?? null,
    budget.currency_format ? JSON.stringify(budget.currency_format) : null,
    budget.date_format ? JSON.stringify(budget.date_format) : null,
  ];
}

function toMonthRow(r: Record<string, unknown>): MonthRow {
  return {
    month: r.month as string,
    income: Number(r.income),
    budgeted: Number(r.budgeted),
    activity: Number(r.activity),
    toBeBudgeted: Number(r.to_be_budgeted),
    ageOfMoney: r.age_of_money === null ? null : Number(r.age_of_money),
    note: (r.note as string | null) ?? null,
  };
}

function toMonthCategoryRow(r: Record<string, unknown>): MonthCategoryRow {
  return {
    categoryId: r.category_id as string,
    budgeted: Number(r.budgeted),
    activity: Number(r.activity),
    balance: Number(r.balance),
    goalUnderFunded: r.goal_under_funded === null ? null : Number(r.goal_under_funded),
  };
}

/**
 * The flattening every line query starts from: one row per plain transaction, plus one row per
 * subtransaction inheriting its parent's date, account, cleared, approved, flag, imported payee and —
 * where the split leaves them blank — payee and memo. `$b` is the budget id.
 */
const LINES_CTE = `
        SELECT t.id, NULL AS parent_id, t.date, t.amount, t.account_id, t.payee_id, t.category_id,
               t.memo, t.transfer_account_id, t.cleared, t.approved, t.flag_color, t.flag_name, t.imported_payee
        FROM transactions t
        WHERE t.budget_id = $b
          AND NOT EXISTS (SELECT 1 FROM subtransactions s WHERE s.budget_id = t.budget_id AND s.transaction_id = t.id)
        UNION ALL
        SELECT s.id, t.id, t.date, s.amount, t.account_id, COALESCE(s.payee_id, t.payee_id), s.category_id,
               COALESCE(s.memo, t.memo), s.transfer_account_id, t.cleared, t.approved, t.flag_color, t.flag_name,
               t.imported_payee
        FROM subtransactions s
        JOIN transactions t ON t.budget_id = s.budget_id AND t.id = s.transaction_id
        WHERE s.budget_id = $b`;

/** The joins every spending query shares; the inner account join is what drops tracking accounts. */
const SPENDING_FROM = `
      FROM lines l
      JOIN accounts a             ON a.budget_id = $b AND a.id = l.account_id AND a.on_budget = 1
      LEFT JOIN categories c      ON c.budget_id = $b AND c.id = l.category_id
      LEFT JOIN category_groups g ON g.budget_id = $b AND g.id = c.category_group_id
      LEFT JOIN payees p          ON p.budget_id = $b AND p.id = l.payee_id`;

/**
 * A line that moves money to another on-budget account: it never needs a category and is never
 * spending. A transfer to a tracking account is not one of these — that money leaves the budget, so
 * YNAB asks for a category and counts the line as Uncategorized until it has one. The spending rule,
 * its exclusions and the uncategorized chore all read this one test, so they cannot disagree about
 * which transfers are which.
 */
const BUDGET_TRANSFER = `EXISTS (SELECT 1 FROM accounts ta WHERE ta.budget_id = $b AND ta.id = l.transfer_account_id AND ta.on_budget = 1)`;

/**
 * The rule itself, in one place: a real non-internal category, or no category and no transfer to
 * another on-budget account, or a category id that no longer resolves (the line is still spending,
 * and still has to reconcile).
 */
const SPENDING_RULE = `((c.id IS NOT NULL AND c.internal = 0)
        OR (l.category_id IS NULL AND NOT ${BUDGET_TRANSFER})
        OR (l.category_id IS NOT NULL AND c.id IS NULL))`;

/**
 * A line of income: one in an internal category, which on a budget account means Inflow: Ready to
 * Assign, since an uncategorized line carries no category at all rather than YNAB's internal
 * `Uncategorized`. The spending rule's `inflows` exclusion reads this same test, so what the
 * spending reports drop as an inflow is exactly what the cash flow counts as income.
 */
const INCOME_RULE = `COALESCE(c.internal, 0) = 1`;

/**
 * A line that moves money to a tracking account: a loan or mortgage payment, an investment
 * contribution. It is spending, since the money leaves the budget, but it stays in net worth, which
 * is why the cash flow names it apart.
 */
const TRACKING_TRANSFER = `EXISTS (SELECT 1 FROM accounts ta WHERE ta.budget_id = $b AND ta.id = l.transfer_account_id AND ta.on_budget = 0)`;

/**
 * A spending line always has a category name to show. Note the budget's own internal `Uncategorized`
 * category is not this bucket — a line carrying it is an inflow-style internal line and never gets
 * here; this is for `category_id IS NULL`.
 */
const CATEGORY_NAME = `CASE WHEN l.category_id IS NULL THEN 'Uncategorized' ELSE COALESCE(c.name, '(deleted category)') END`;
const CATEGORY_GROUP_NAME = `CASE WHEN l.category_id IS NULL THEN 'Uncategorized'
                  ELSE COALESCE(g.name, c.category_group_name, '(unknown group)') END`;

/** The key, label and extra columns each `spendingBy` grouping selects. */
const SPENDING_GROUPINGS: Record<SpendingGroupBy, { key: string; name: string; extra: string }> = {
  category: {
    key: "c.id",
    name: CATEGORY_NAME,
    extra: `${CATEGORY_GROUP_NAME} AS group_name, MAX(CASE WHEN c.hidden = 1 OR g.hidden = 1 THEN 1 ELSE 0 END) AS hidden,`,
  },
  category_group: { key: "g.id", name: CATEGORY_GROUP_NAME, extra: "" },
  payee: { key: "p.id", name: "COALESCE(p.name, '(no payee)')", extra: "" },
  account: { key: "a.id", name: "a.name", extra: "" },
  month: { key: "SUBSTR(l.date, 1, 7)", name: "SUBSTR(l.date, 1, 7)", extra: "" },
};

/**
 * The filter clauses shared by every spending query. Only placeholder names are interpolated — the
 * values are bound, so there are at most a few dozen distinct SQL texts to key the statement cache.
 */
function spendingWhere(budgetId: string, filter: SpendingFilter): { where: string[]; params: Record<string, SqlValue> } {
  const params: Record<string, SqlValue> = { b: budgetId };
  const where: string[] = [];
  if (filter.from !== undefined) {
    where.push("l.date >= $from");
    params.from = filter.from;
  }
  if (filter.to !== undefined) {
    where.push("l.date <= $to");
    params.to = filter.to;
  }
  inList(where, params, "l.category_id", "cat", filter.categoryIds);
  inList(where, params, "c.category_group_id", "grp", filter.groupIds);
  inList(where, params, "l.payee_id", "pay", filter.payeeIds);
  inList(where, params, "l.account_id", "acc", filter.accountIds);
  return { where, params };
}

/**
 * `column IN (...)` over a caller's list of ids. The list is bound as one JSON array and unpacked
 * by SQLite, so the SQL text is the same however many ids there are — a statement per list length
 * would grow the statement cache without bound. An absent or empty list constrains nothing; the
 * values inside one list are ORed. Only the placeholder name is interpolated.
 */
function inList(where: string[], params: Record<string, SqlValue>, column: string, name: string, values: string[] | undefined): void {
  if (!values || values.length === 0) return;
  params[name] = JSON.stringify(values);
  where.push(`${column} IN (SELECT value FROM json_each($${name}))`);
}

/** Search joins everything outer: a line on a tracking account or with no payee is still a match. */
const SEARCH_FROM = `
      FROM lines l
      LEFT JOIN accounts a        ON a.budget_id = $b AND a.id = l.account_id
      LEFT JOIN categories c      ON c.budget_id = $b AND c.id = l.category_id
      LEFT JOIN category_groups g ON g.budget_id = $b AND g.id = c.category_group_id
      LEFT JOIN payees p          ON p.budget_id = $b AND p.id = l.payee_id`;

/**
 * A line — searched or scheduled — names its category only when it carries one: an uncategorized
 * line and a transfer have nothing to name, and a row saying `Uncategorized` would be a claim
 * about the budget rather than about the line. A category id that no longer resolves is still
 * named. The query must join `categories` as `c` and `category_groups` as `g`; only the line's
 * own alias varies.
 */
const lineCategoryName = (line: string): string =>
  `CASE WHEN ${line}.category_id IS NULL THEN NULL ELSE COALESCE(c.name, '(deleted category)') END`;
const lineGroupName = (line: string): string =>
  `CASE WHEN ${line}.category_id IS NULL THEN NULL ELSE COALESCE(g.name, c.category_group_name) END`;
const SEARCH_CATEGORY_NAME = lineCategoryName("l");
const SEARCH_GROUP_NAME = lineGroupName("l");

/** The fields a scheduled transaction and its split lines share, read from either query's row. */
function toScheduledLine(r: Record<string, unknown>): ScheduledLine {
  return {
    id: r.id as string,
    amount: Number(r.amount),
    payeeName: (r.payee_name as string | null) ?? null,
    categoryName: (r.category_name as string | null) ?? null,
    categoryGroupName: (r.category_group_name as string | null) ?? null,
    transferAccountId: (r.transfer_account_id as string | null) ?? null,
    transferAccountName: (r.transfer_account_name as string | null) ?? null,
    transferAccountOnBudget: r.transfer_account_on_budget === null ? null : Number(r.transfer_account_on_budget) === 1,
    memo: (r.memo as string | null) ?? null,
  };
}

/**
 * The lines YNAB flags as needing a category, in one place: an on-budget account (a tracking
 * account never asks for one), no category, and not a transfer to another on-budget account (which
 * never needs one either). A transfer to a tracking account does need a category, so one without it
 * is here. `a` is the search's outer-joined accounts row.
 */
const UNCATEGORIZED_RULE = `(l.category_id IS NULL AND COALESCE(a.on_budget, 0) = 1 AND NOT ${BUDGET_TRANSFER})`;

/**
 * The spending filter's clauses plus the search-only ones. The amount bounds are on `ABS(amount)`
 * and inclusive, so a range reads the same whichever way the money went, and `direction` picks the
 * side. `text` is matched with `LIKE` on the memo, the payee's name and the imported payee, each
 * put through `search_fold` (accents and case folded, emoji kept) along with the term itself.
 * `%` and `_` in the input are escaped so they match themselves.
 */
function searchWhere(budgetId: string, filter: SearchFilter): { where: string[]; params: Record<string, SqlValue> } {
  const { where, params } = spendingWhere(budgetId, filter);
  if (filter.minAmount !== undefined) {
    where.push("ABS(l.amount) >= $minAmount");
    params.minAmount = filter.minAmount;
  }
  if (filter.maxAmount !== undefined) {
    where.push("ABS(l.amount) <= $maxAmount");
    params.maxAmount = filter.maxAmount;
  }
  if (filter.direction !== undefined) where.push(filter.direction === "inflow" ? "l.amount > 0" : "l.amount < 0");
  if (filter.uncategorized === true) where.push(UNCATEGORIZED_RULE);
  if (filter.uncategorized === false) where.push("l.category_id IS NOT NULL");
  if (filter.approved !== undefined) {
    where.push("l.approved = $approved");
    params.approved = filter.approved ? 1 : 0;
  }
  if (filter.cleared !== undefined) {
    where.push("l.cleared = $cleared");
    params.cleared = filter.cleared;
  }
  if (filter.text !== undefined && filter.text.trim() !== "") {
    const term = searchable(filter.text).trim();
    // A term that folds away to nothing ("^" or "´" on its own is all diacritic) matches nothing,
    // rather than becoming `%%` and handing back every line as a match.
    if (term === "") {
      where.push("0");
    } else {
      const like = (column: string) => `search_fold(COALESCE(${column}, '')) LIKE $text ESCAPE '\\'`;
      where.push(`(${[like("l.memo"), like("p.name"), like("l.imported_payee")].join(" OR ")})`);
      params.text = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    }
  }
  return { where, params };
}

interface ResolvableKind {
  table: string;
  key: keyof ResolvedEntities;
  singular: string;
  plural: string;
}

/**
 * The four kinds a name can be resolved against; the table names come from here, never from input.
 * Exported so a caller that walks every kind — the filter echo — reads the same list.
 */
export const RESOLVABLE: Record<keyof EntityNames, ResolvableKind> = {
  categories: { table: "categories", key: "categoryIds", singular: "category", plural: "categories" },
  groups: { table: "category_groups", key: "groupIds", singular: "category group", plural: "category groups" },
  payees: { table: "payees", key: "payeeIds", singular: "payee", plural: "payees" },
  accounts: { table: "accounts", key: "accountIds", singular: "account", plural: "accounts" },
};

interface EntityRow {
  id: string;
  name: string;
}

/** One kind's rows, folded once: an id set and every row under its comparable name. */
interface EntityIndex {
  ids: Set<string>;
  byName: Map<string, EntityRow[]>;
}

/** Folding is the expensive part of a name match, so it happens once per row, not once per input. */
function indexEntities(rows: EntityRow[]): EntityIndex {
  const byName = new Map<string, EntityRow[]>();
  for (const row of rows) {
    const folded = fold(row.name);
    const bucket = byName.get(folded);
    if (bucket) bucket.push(row);
    else byName.set(folded, [row]);
  }
  return { ids: new Set(rows.map((row) => row.id)), byName };
}

function resolveOne(value: string, index: EntityIndex, kind: ResolvableKind): string {
  const wanted = value.trim();
  if (index.ids.has(wanted)) return wanted;
  const folded = fold(wanted);
  if (folded === "") throw new NameResolutionError(`No ${kind.singular} named "${wanted}".`);

  const exact = index.byName.get(folded) ?? [];
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) {
    // Every match folds to the same name, so the id is the only thing left to order by.
    throw new NameResolutionError(`"${wanted}" matches several ${kind.plural}: ${candidates(exact)}. Use the id.`);
  }

  // No whole name matched: a part of a name is accepted when only one entity contains it, which
  // is what "costco" means when the payee is "Costco Wholesale". Two containing it is a question
  // back, with the candidates, since guessing between them would narrow the numbers silently.
  const partial = [...index.byName.entries()].filter(([name]) => name.includes(folded)).flatMap(([, rows]) => rows);
  if (partial.length === 1) return partial[0].id;
  if (partial.length === 0) throw new NameResolutionError(`No ${kind.singular} named "${wanted}".`);
  throw new NameResolutionError(
    `No ${kind.singular} named "${wanted}"; ${partial.length} ${kind.plural} contain it: ${candidates(partial)}. Use the whole name or the id.`,
  );
}

/** The most candidates an error names: a short fragment can match most of a budget's payees. */
const MAX_CANDIDATES = 10;

function candidates(rows: EntityRow[]): string {
  const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const named = sorted.slice(0, MAX_CANDIDATES).map((m) => `${m.name} (${m.id})`);
  if (sorted.length > MAX_CANDIDATES) named.push(`and ${sorted.length - MAX_CANDIDATES} more`);
  return named.join(", ");
}

function toFlowAggregate(r: Record<string, unknown>): FlowAggregate {
  return {
    key: (r.key as string | null) ?? null,
    name: r.name as string,
    count: Number(r.count),
    amount: Number(r.amount),
    months: Number(r.months),
  };
}

function toTransactionLine(r: Record<string, unknown>): TransactionLine {
  return {
    id: r.id as string,
    parentId: (r.parent_id as string | null) ?? null,
    date: r.date as string,
    amount: Number(r.amount),
    accountId: r.account_id as string,
    accountName: r.account_name as string,
    payeeId: (r.payee_id as string | null) ?? null,
    payeeName: (r.payee_name as string | null) ?? null,
    categoryId: (r.category_id as string | null) ?? null,
    categoryName: (r.category_name as string | null) ?? null,
    categoryGroupName: (r.category_group_name as string | null) ?? null,
    memo: (r.memo as string | null) ?? null,
    cleared: r.cleared as ClearedStatus,
    approved: Number(r.approved) === 1,
    flagColor: (r.flag_color as string | null) ?? null,
    flagName: (r.flag_name as string | null) ?? null,
    importedPayee: (r.imported_payee as string | null) ?? null,
    transferAccountId: (r.transfer_account_id as string | null) ?? null,
  };
}

/** The group YNAB creates for credit card payments, under a name it does not let anyone change. */
const CREDIT_CARD_PAYMENTS = "Credit Card Payments";

/**
 * How a category resolves its group, stated once: `categoryTree` and `monthDetail` must agree
 * about which group a category is in and whether it counts as hidden, or the two tools disagree
 * about the same budget. The group row wins, the category's cached group name is the fallback,
 * and a category whose group is gone is named rather than dropped.
 */
const GROUP_COLUMNS = `COALESCE(g.name, c.category_group_name, '(unknown group)') AS group_name,
              COALESCE(g.hidden, 0) AS group_hidden`;
const GROUP_JOIN = `LEFT JOIN category_groups g ON g.budget_id = c.budget_id AND g.id = c.category_group_id`;

/** Hidden in YNAB's sense: the category's own flag, or its whole group being hidden. */
function isHidden(r: Record<string, unknown>): boolean {
  return Number(r.hidden) === 1 || Number(r.group_hidden) === 1;
}

function toBudgetRow(r: Record<string, unknown>): BudgetRow {
  return {
    id: r.id as string,
    name: r.name as string,
    firstMonth: (r.first_month as string | null) ?? null,
    lastMonth: (r.last_month as string | null) ?? null,
    lastModifiedOn: (r.last_modified_on as string | null) ?? null,
    currencyFormat: r.currency_format ? (JSON.parse(r.currency_format as string) as CurrencyFormat) : null,
    dateFormat: r.date_format ? (JSON.parse(r.date_format as string) as DateFormat) : null,
    isDefault: Number(r.is_default) === 1,
    serverKnowledge: r.server_knowledge === null ? null : Number(r.server_knowledge),
    lastSyncedAt: (r.last_synced_at as string | null) ?? null,
  };
}
