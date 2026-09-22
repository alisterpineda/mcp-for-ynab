import type { Account, Category, CategoryGroup, Month, Payee, BudgetDetail, SubTransaction, Transaction } from "../src/ynab/types.js";
import type { BudgetSource, RateLimit } from "../src/ynab/client.js";

export const BUDGET_ID = "budget-1";

export function budgetDetail(overrides: Partial<BudgetDetail> = {}): BudgetDetail {
  return {
    id: BUDGET_ID,
    name: "Household",
    last_modified_on: "2026-09-21T12:00:00Z",
    first_month: "2024-01-01",
    last_month: "2026-09-01",
    currency_format: {
      iso_code: "USD",
      example_format: "123,456.78",
      decimal_digits: 2,
      decimal_separator: ".",
      symbol_first: true,
      group_separator: ",",
      currency_symbol: "$",
      display_symbol: true,
    },
    ...overrides,
  };
}

export function account(id: string, name: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    name,
    type: "checking",
    on_budget: true,
    closed: false,
    balance: 0,
    cleared_balance: 0,
    uncleared_balance: 0,
    transfer_payee_id: null,
    deleted: false,
    ...overrides,
  };
}

export function payee(id: string, name: string, overrides: Partial<Payee> = {}): Payee {
  return { id, name, deleted: false, ...overrides };
}

export function categoryGroup(id: string, name: string, overrides: Partial<CategoryGroup> = {}): CategoryGroup {
  return { id, name, hidden: false, internal: false, deleted: false, ...overrides };
}

export function category(id: string, name: string, overrides: Partial<Category> = {}): Category {
  return {
    id,
    category_group_id: "g1",
    name,
    hidden: false,
    internal: false,
    budgeted: 0,
    activity: 0,
    balance: 0,
    deleted: false,
    ...overrides,
  };
}

export function month(date: string, categories: Category[], overrides: Partial<Month> = {}): Month {
  return { month: date, income: 0, budgeted: 0, activity: 0, to_be_budgeted: 0, deleted: false, categories, ...overrides };
}

export function transaction(id: string, date: string, amount: number, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    date,
    amount,
    cleared: "cleared",
    approved: true,
    account_id: "a1",
    payee_id: "p1",
    category_id: "c1",
    deleted: false,
    ...overrides,
  };
}

export function subtransaction(id: string, transactionId: string, amount: number, overrides: Partial<SubTransaction> = {}): SubTransaction {
  return { id, transaction_id: transactionId, amount, deleted: false, ...overrides };
}

/** A small but complete budget: two accounts, two categories, one split transaction. */
export function fullBudget(): BudgetDetail {
  return budgetDetail({
    accounts: [account("a1", "Checking"), account("a2", "Old savings", { closed: true })],
    payees: [payee("p1", "Costco"), payee("p2", "Landlord")],
    category_groups: [categoryGroup("g1", "Everyday")],
    categories: [category("c1", "Groceries"), category("c2", "Household")],
    months: [month("2026-09-01", [category("c1", "Groceries", { budgeted: 100_000 }), category("c2", "Household", { budgeted: 50_000 })])],
    transactions: [
      transaction("t1", "2026-09-10", -10_000),
      transaction("t2", "2026-09-12", -30_000, { category_id: null, memo: "big shop" }),
      transaction("t3", "2026-08-01", -5_000, { payee_id: "p2" }),
    ],
    subtransactions: [
      subtransaction("s1", "t2", -20_000, { category_id: "c2", memo: "paper towels" }),
      subtransaction("s2", "t2", -10_000, { category_id: "c1" }),
      subtransaction("s3", "t2", 0, { payee_id: "p2", transfer_account_id: "a2" }),
    ],
  });
}

export interface FakeCall {
  budgetId: string;
  knowledge: number | undefined;
}

/**
 * In-memory stand-in for the YNAB API. A budget call without knowledge returns `full`; a call with
 * knowledge returns `delta`. Set `fail` to make every call throw.
 */
export class FakeBudgetSource implements BudgetSource {
  lastRateLimit: RateLimit | null = { used: 1, limit: 200 };
  calls: FakeCall[] = [];
  /** Number of `listBudgets` calls so far. */
  listCalls = 0;
  /** When set, every request (budget list and budget) throws it. */
  fail: Error | null = null;
  /** Override what `listBudgets` reports; by default the full plan is the only budget and the default. */
  budgetList: { budgets: { id: string; name: string }[]; defaultBudget: { id: string; name: string } | null } | null = null;

  constructor(
    public full: BudgetDetail = fullBudget(),
    public delta: BudgetDetail = budgetDetail(),
    public fullKnowledge = 10,
    public deltaKnowledge = 11,
  ) {}

  async listBudgets() {
    this.listCalls++;
    if (this.fail) throw this.fail;
    if (this.budgetList) return this.budgetList;
    const summary = { id: this.full.id, name: this.full.name };
    return { budgets: [summary], defaultBudget: summary };
  }

  async getBudget(budgetId: string, knowledge?: number) {
    this.calls.push({ budgetId, knowledge });
    if (this.fail) throw this.fail;
    return knowledge === undefined
      ? { budget: this.full, serverKnowledge: this.fullKnowledge }
      : { budget: this.delta, serverKnowledge: this.deltaKnowledge };
  }
}

/** The goal fields a category carries, as overrides for `category`. */
export function goal(type: "TB" | "TBD" | "MF" | "NEED" | "DEBT", target: number, overrides: Partial<Category> = {}): Partial<Category> {
  return { goal_type: type, goal_target: target, ...overrides };
}

/**
 * A budget shaped for the orientation tools: an internal group whose categories are not internal,
 * a hidden group, a hidden category, goals of several types including a snoozed one, accented and
 * emoji names, on-budget/tracking/closed accounts, and three months.
 *
 * The 2026-09 month's non-internal categories sum to its own totals, so a test can check that the
 * rows `get_month` returns reconcile with the header.
 */
export function orientationBudget(overrides: Partial<BudgetDetail> = {}): BudgetDetail {
  return budgetDetail({
    first_month: "2024-01-01",
    last_month: "2026-10-01",
    accounts: [
      account("a1", "Chequing", {
        balance: 1_234_560,
        cleared_balance: 1_200_000,
        uncleared_balance: 34_560,
        last_reconciled_at: "2026-09-01T12:00:00+00:00",
        note: "joint",
      }),
      account("a2", "Visa", { type: "creditCard", balance: -500_000, cleared_balance: -500_000 }),
      account("a3", "Mortgage", { type: "mortgage", on_budget: false, balance: -98_765_430, cleared_balance: -98_765_430 }),
      account("a4", "Old savings", { type: "savings", closed: true, balance: 111_000, cleared_balance: 111_000 }),
    ],
    category_groups: [
      categoryGroup("g1", "🥘 Food"),
      categoryGroup("g2", "Credit Card Payments", { internal: true }),
      categoryGroup("g3", "Hidden Stuff", { hidden: true }),
      categoryGroup("g4", "Internal Master Category", { internal: true }),
      categoryGroup("g5", "🏠 Housing"),
    ],
    categories: [
      category("c1", "Groceries", { note: "costco run monthly", ...goal("MF", 800_000) }),
      category("c2", "Café", { ...goal("TB", 200_000, { goal_snoozed_at: "2026-09-01T00:00:00+00:00" }) }),
      category("c3", "Visa", { category_group_id: "g2" }),
      category("c4", "Retired thing", { category_group_id: "g3" }),
      category("c5", "Old hobby", { hidden: true }),
      category("c6", "Inflow: Ready to Assign", { category_group_id: "g4", internal: true }),
      category("c7", "Uncategorized", { category_group_id: "g4", internal: true }),
      category("c8", "Rent", { category_group_id: "g5", ...goal("TBD", 2_000_000, { goal_target_date: "2026-12-31" }) }),
    ],
    months: [
      month(
        "2026-09-01",
        [
          monthCategory("c1", { budgeted: 600_000, activity: -412_310, balance: 187_690, goal_under_funded: 12_500 }),
          monthCategory("c2", { budgeted: 300_000, balance: 300_000, goal_under_funded: 0 }),
          monthCategory("c3"),
          monthCategory("c4"),
          monthCategory("c5", { balance: 45_000 }),
          monthCategory("c6", { activity: 5_086_000 }),
          monthCategory("c8", { balance: 100_000 }),
        ],
        { income: 5_086_000, budgeted: 900_000, activity: -412_310, to_be_budgeted: 5_086_000, age_of_money: 108, note: "tight month" },
      ),
      month("2026-08-01", [monthCategory("c1", { budgeted: 500_000, activity: -300_000, balance: 200_000 })], {
        income: 4_000_000,
        budgeted: 500_000,
        activity: -300_000,
      }),
      month("2026-10-01", [monthCategory("c1", { budgeted: 250_000, balance: 250_000 })], {
        budgeted: 250_000,
        to_be_budgeted: 100_000,
      }),
    ],
    transactions: [],
    ...overrides,
  });
}

/** A month's figures for one already-declared category; the name and group come from `categories`. */
export function monthCategory(id: string, overrides: Partial<Category> = {}): Category {
  return category(id, id, overrides);
}
