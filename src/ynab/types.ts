// Entity types come from the official SDK (generated from YNAB's OpenAPI spec), so field names
// track the API. These aliases name the shapes the plan-detail endpoint returns: flat lists of
// summaries, with split lines in a separate `subtransactions` list keyed by `transaction_id`.
// Amounts are milliunits (1000 = 1.00). Dates are ISO "YYYY-MM-DD".
export type {
  AccountBase as Account,
  CategoryBase as Category,
  CategoryGroup,
  CurrencyFormat,
  DateFormat,
  MonthDetailBase as Month,
  Payee,
  PlanDetail,
  PlanSummary,
  ScheduledSubTransactionBase as ScheduledSubTransaction,
  ScheduledTransactionSummaryBase as ScheduledTransaction,
  SubTransactionBase as SubTransaction,
  TransactionClearedStatus as ClearedStatus,
  TransactionSummaryBase as Transaction,
} from "ynab";

/** Every entity the delta endpoint can return carries an id and a deletion flag. */
export interface Deletable {
  id: string;
  deleted: boolean;
}
