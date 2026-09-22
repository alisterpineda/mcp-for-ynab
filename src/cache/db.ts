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
import { byName, fold } from "../format/text.js";
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
      ["memo", "TEXT", (e) => e.memo ?? null],
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
    ],
    indexes: ["(budget_id, scheduled_transaction_id)"],
  }),
  entityTable<PayeeLocation>({
    table: "payee_locations",
    list: "payee_locations",
    columns: [["payee_id", "TEXT NOT NULL", (e) => e.payee_id]],
  }),
];

/** Tables holding one budget's rows; `clearBudget` empties exactly these. */
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
   */
  applyBudget(budgetId: string, budget: BudgetDetail, serverKnowledge: number, now: Date): DeltaStats {
    const stats: DeltaStats = { upserted: 0, deleted: 0 };
    this.transaction(() => {
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

  /** Drop one budget's cached data and forget its knowledge, so the next sync is a full download. */
  clearBudget(budgetId: string): void {
    this.transaction(() => {
      for (const table of BUDGET_SCOPED_TABLES) {
        this.stmt(`DELETE FROM ${table} WHERE budget_id = ?`).run(budgetId);
      }
      this.stmt("UPDATE budgets SET server_knowledge = NULL, last_synced_at = NULL WHERE id = ?").run(budgetId);
    });
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
      WITH lines AS (
        SELECT t.id, NULL AS parent_id, t.date, t.amount, t.account_id, t.payee_id, t.category_id,
               t.memo, t.transfer_account_id, t.cleared, t.approved, t.flag_color
        FROM transactions t
        WHERE t.budget_id = $b
          AND NOT EXISTS (SELECT 1 FROM subtransactions s WHERE s.budget_id = t.budget_id AND s.transaction_id = t.id)
        UNION ALL
        SELECT s.id, t.id, t.date, s.amount, t.account_id, COALESCE(s.payee_id, t.payee_id), s.category_id,
               COALESCE(s.memo, t.memo), s.transfer_account_id, t.cleared, t.approved, t.flag_color
        FROM subtransactions s
        JOIN transactions t ON t.budget_id = s.budget_id AND t.id = s.transaction_id
        WHERE s.budget_id = $b
      ),
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

    return this.stmt(sql)
      .all(params)
      .map((r) => ({
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
        transferAccountId: (r.transfer_account_id as string | null) ?? null,
      }));
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
      `SELECT c.id, c.name, c.note, c.goal_type, c.goal_target, c.goal_target_date, c.goal_snoozed_at, c.hidden,
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
