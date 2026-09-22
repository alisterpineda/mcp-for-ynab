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
/** The month `by` months away from today, `YYYY-MM`, read locally the way the tools read it. */
export function monthFromNow(by: number): string {
  const now = new Date();
  const shifted = new Date(now.getFullYear(), now.getMonth() + by, 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}`;
}

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

/**
 * A budget shaped for the spending rule: every edge case the rule has to decide, with
 * `month_categories` hand-computed so each category's `activity` equals the sum of that category's
 * spending lines in the month.
 *
 * Accounts: `a1` Chequing and `a2` Visa are on budget, `a3` Mortgage and `a4` Brokerage are
 * tracking. Categories: `c1` Groceries, `c2` Household, `c3` Dining Out (two payees), `c4`
 * Mortgage, `c5` Visa (the credit-card payment category), `c6` Inflow: Ready to Assign and `c7`
 * Uncategorized (both internal), `c8` Old hobby (hidden), `c9` Retired (in the hidden group).
 * `c-gone` is carried by one transaction and has no category row at all.
 *
 * Spending lines per month, worked out by hand (milliunits, YNAB's sign):
 *
 *   2026-07  c1 -60,000 (s1) +10,000 (s3 refund) = -50,000   c2 -30,000 (s2)
 *            c3 -20,000 (t11) -12,000 (t12) = -32,000        c4 -150,000 (t2, transfer to tracking)
 *            c8 -15,000 (t7)                                 c-gone -5,000 (t8)
 *            Uncategorized -25,000 (t6)          9 lines, -307,000
 *            excluded: tracking t3, t9 (2); transfers t4, t5 (2); inflows t10 (1)
 *
 *   2026-08  c1 -90,000 (t20) -45,000 (t21) = -135,000       c2 -30,000 (t29)
 *            c3 -18,000 (t22)                                c4 -150,000 (t23)
 *                                                 5 lines, -333,000
 *            excluded: tracking t24, t27 (2); transfers t25, t26 (2); inflows t28 (1)
 *
 *   2026-09  c1 -80,000 (t40)   c2 -40,000 (t44)   c3 -14,000 (t41)   c4 -150,000 (t42)
 *                                                 4 lines, -284,000
 *            excluded: tracking t43 (1); transfers t46, t47 (2); inflows t45 (1)
 *
 *   Whole range: 18 lines, -924,000.
 *
 * Two deliberate simplifications keep the per-category reconciliation exact: the uncategorized line
 * is only in July (YNAB would post it to the internal `Uncategorized` category, which the fixture
 * leaves at zero, so July's total is 25,000 more than its non-internal `month_categories` sum —
 * use August or September for a reconciliation assertion), and the credit-card payment category
 * `c5` carries the activity YNAB would compute for it — card spending moved in minus payments out
 * (July 27,000 - 50,000, August 45,000 - 60,000, September 14,000 - 70,000) — which no spending
 * line carries, so every reconciliation leaves that category out.
 *
 * Balances follow `budgeted + activity` carried forward, with an overspent balance reset to zero
 * at the next month's start. Groceries is over-assigned in July (50,000 spent against 40,000
 * assigned, balance still 20,000 thanks to 30,000 carried in from June) and overspent in August
 * (20,000 + 60,000 - 135,000 = -55,000).
 */
export function spendingBudget(overrides: Partial<BudgetDetail> = {}): BudgetDetail {
  return budgetDetail({
    first_month: "2026-07-01",
    last_month: "2026-09-01",
    accounts: [
      account("a1", "Chequing", { balance: 1_000_000 }),
      account("a2", "Visa", { type: "creditCard", balance: -104_000 }),
      account("a3", "Mortgage", { type: "mortgage", on_budget: false, balance: -50_000_000 }),
      account("a4", "Brokerage", { type: "otherAsset", on_budget: false, balance: 20_000 }),
    ],
    payees: [
      payee("p1", "Costco"),
      payee("p2", "Café Luna"),
      payee("p3", "Corner Diner"),
      payee("p4", "Employer"),
      payee("p6", "Corner Store"),
      payee("p7", "Hobby Shop"),
      payee("p8", "Farm Market"),
      payee("p9", "Hardware Depot"),
      // A duplicate of p6, so a name that matches more than one payee has somewhere to come from.
      payee("p10", "corner store"),
      payee("pt1", "Transfer : Chequing", { transfer_account_id: "a1" }),
      payee("pt2", "Transfer : Visa", { transfer_account_id: "a2" }),
      payee("pt3", "Transfer : Mortgage", { transfer_account_id: "a3" }),
      payee("pt4", "Transfer : Brokerage", { transfer_account_id: "a4" }),
    ],
    category_groups: [
      categoryGroup("g1", "Everyday"),
      categoryGroup("g2", "Housing"),
      categoryGroup("g3", "Credit Card Payments", { internal: true }),
      categoryGroup("g4", "Internal Master Category", { internal: true }),
      categoryGroup("g5", "Hidden", { hidden: true }),
    ],
    categories: [
      category("c1", "Groceries"),
      category("c2", "Household"),
      category("c3", "Dining Out"),
      category("c4", "Mortgage", { category_group_id: "g2" }),
      category("c5", "Visa", { category_group_id: "g3" }),
      category("c6", "Inflow: Ready to Assign", { category_group_id: "g4", internal: true }),
      category("c7", "Uncategorized", { category_group_id: "g4", internal: true }),
      category("c8", "Old hobby", { hidden: true }),
      category("c9", "Retired", { category_group_id: "g5" }),
    ],
    months: [
      month(
        "2026-07-01",
        [
          monthCategory("c1", { budgeted: 40_000, activity: -50_000, balance: 20_000 }),
          monthCategory("c2", { budgeted: 30_000, activity: -30_000, balance: 0 }),
          monthCategory("c3", { budgeted: 40_000, activity: -32_000, balance: 8_000 }),
          monthCategory("c4", { budgeted: 150_000, activity: -150_000, balance: 0 }),
          monthCategory("c5", { budgeted: 50_000, activity: -23_000, balance: 27_000 }),
          monthCategory("c6", { activity: 500_000 }),
          monthCategory("c7"),
          monthCategory("c8", { budgeted: 15_000, activity: -15_000, balance: 0 }),
          monthCategory("c9"),
          monthCategory("c-gone", { activity: -5_000, balance: -5_000 }),
        ],
        { income: 500_000, budgeted: 325_000, activity: -307_000, to_be_budgeted: 175_000 },
      ),
      month(
        "2026-08-01",
        [
          monthCategory("c1", { budgeted: 60_000, activity: -135_000, balance: -55_000 }),
          monthCategory("c2", { budgeted: 30_000, activity: -30_000, balance: 0 }),
          monthCategory("c3", { budgeted: 20_000, activity: -18_000, balance: 10_000 }),
          monthCategory("c4", { budgeted: 150_000, activity: -150_000, balance: 0 }),
          monthCategory("c5", { budgeted: 50_000, activity: -15_000, balance: 62_000 }),
          monthCategory("c6", { activity: 500_000 }),
          monthCategory("c7"),
          monthCategory("c8"),
          monthCategory("c9"),
          monthCategory("c-gone"),
        ],
        { income: 500_000, budgeted: 310_000, activity: -333_000, to_be_budgeted: 190_000 },
      ),
      month(
        "2026-09-01",
        [
          monthCategory("c1", { budgeted: 100_000, activity: -80_000, balance: 20_000 }),
          monthCategory("c2", { budgeted: 40_000, activity: -40_000, balance: 0 }),
          monthCategory("c3", { budgeted: 20_000, activity: -14_000, balance: 16_000 }),
          monthCategory("c4", { budgeted: 150_000, activity: -150_000, balance: 0 }),
          monthCategory("c5", { budgeted: 50_000, activity: -56_000, balance: 56_000 }),
          monthCategory("c6", { activity: 500_000 }),
          monthCategory("c7"),
          monthCategory("c8"),
          monthCategory("c9"),
          monthCategory("c-gone"),
        ],
        { income: 500_000, budgeted: 360_000, activity: -284_000, to_be_budgeted: 140_000 },
      ),
    ],
    transactions: [
      // --- 2026-07 -------------------------------------------------------------------------
      transaction("t10", "2026-07-01", 500_000, { payee_id: "p4", category_id: "c6", memo: "pay" }),
      transaction("t1", "2026-07-05", -80_000, { payee_id: "p1", category_id: null }),
      transaction("t2", "2026-07-10", -150_000, { payee_id: "pt3", category_id: "c4", transfer_account_id: "a3" }),
      transaction("t3", "2026-07-10", 150_000, { account_id: "a3", payee_id: "pt1", category_id: null, transfer_account_id: "a1" }),
      transaction("t4", "2026-07-15", -50_000, { payee_id: "pt2", category_id: null, transfer_account_id: "a2" }),
      transaction("t5", "2026-07-15", 50_000, { account_id: "a2", payee_id: "pt1", category_id: null, transfer_account_id: "a1" }),
      transaction("t11", "2026-07-18", -20_000, { payee_id: "p2", category_id: "c3" }),
      transaction("t12", "2026-07-19", -12_000, { account_id: "a2", payee_id: "p3", category_id: "c3" }),
      transaction("t6", "2026-07-20", -25_000, { payee_id: "p6", category_id: null, memo: "cash, no idea" }),
      transaction("t7", "2026-07-22", -15_000, { account_id: "a2", payee_id: "p7", category_id: "c8" }),
      transaction("t8", "2026-07-24", -5_000, { payee_id: null, category_id: "c-gone" }),
      transaction("t9", "2026-07-28", -400_000, { account_id: "a3", payee_id: null, category_id: null, memo: "interest" }),
      // --- 2026-08 -------------------------------------------------------------------------
      transaction("t28", "2026-08-01", 500_000, { payee_id: "p4", category_id: "c6" }),
      transaction("t20", "2026-08-03", -90_000, { payee_id: "p1", category_id: "c1" }),
      transaction("t22", "2026-08-09", -18_000, { payee_id: "p2", category_id: "c3" }),
      transaction("t23", "2026-08-10", -150_000, { payee_id: "pt3", category_id: "c4", transfer_account_id: "a3" }),
      transaction("t24", "2026-08-10", 150_000, { account_id: "a3", payee_id: "pt1", category_id: null, transfer_account_id: "a1" }),
      transaction("t21", "2026-08-14", -45_000, { account_id: "a2", payee_id: "p8", category_id: "c1" }),
      transaction("t25", "2026-08-20", -60_000, { payee_id: "pt2", category_id: null, transfer_account_id: "a2" }),
      transaction("t26", "2026-08-20", 60_000, { account_id: "a2", payee_id: "pt1", category_id: null, transfer_account_id: "a1" }),
      transaction("t27", "2026-08-25", 20_000, { account_id: "a4", payee_id: null, category_id: null, memo: "dividend" }),
      transaction("t29", "2026-08-28", -30_000, { payee_id: "p9", category_id: "c2" }),
      // --- 2026-09 -------------------------------------------------------------------------
      transaction("t45", "2026-09-01", 500_000, { payee_id: "p4", category_id: "c6" }),
      transaction("t40", "2026-09-02", -80_000, { payee_id: "p1", category_id: "c1" }),
      transaction("t41", "2026-09-05", -14_000, { account_id: "a2", payee_id: "p3", category_id: "c3" }),
      transaction("t42", "2026-09-08", -150_000, { payee_id: "pt3", category_id: "c4", transfer_account_id: "a3" }),
      transaction("t43", "2026-09-08", 150_000, { account_id: "a3", payee_id: "pt1", category_id: null, transfer_account_id: "a1" }),
      transaction("t44", "2026-09-12", -40_000, { payee_id: "p9", category_id: "c2", approved: false, cleared: "uncleared" }),
      transaction("t46", "2026-09-18", -70_000, { payee_id: "pt2", category_id: null, transfer_account_id: "a2" }),
      transaction("t47", "2026-09-18", 70_000, { account_id: "a2", payee_id: "pt1", category_id: null, transfer_account_id: "a1" }),
    ],
    subtransactions: [
      subtransaction("s1", "t1", -60_000, { category_id: "c1" }),
      subtransaction("s2", "t1", -30_000, { category_id: "c2", memo: "paper towels" }),
      subtransaction("s3", "t1", 10_000, { category_id: "c1", memo: "returned blender" }),
    ],
    ...overrides,
  });
}
