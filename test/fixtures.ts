import type { Account, Category, CategoryGroup, Month, Payee, PlanDetail, SubTransaction, Transaction } from "../src/ynab/types.js";
import type { BudgetSource, RateLimit } from "../src/ynab/client.js";

export const PLAN_ID = "plan-1";

export function planDetail(overrides: Partial<PlanDetail> = {}): PlanDetail {
  return {
    id: PLAN_ID,
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
export function fullPlan(): PlanDetail {
  return planDetail({
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
 * In-memory stand-in for the YNAB API. A call without knowledge returns `full`; a call with
 * knowledge returns `delta`. Set `fail` to make the next calls throw.
 */
export class FakeBudgetSource implements BudgetSource {
  lastRateLimit: RateLimit | null = { used: 1, limit: 200 };
  calls: FakeCall[] = [];
  fail: Error | null = null;
  /** Override what `listBudgets` reports; by default the full plan is the only budget and the default. */
  budgetList: { budgets: { id: string; name: string }[]; defaultBudget: { id: string; name: string } | null } | null = null;

  constructor(
    public full: PlanDetail = fullPlan(),
    public delta: PlanDetail = planDetail(),
    public fullKnowledge = 10,
    public deltaKnowledge = 11,
  ) {}

  async listBudgets() {
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
