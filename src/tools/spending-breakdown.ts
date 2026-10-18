import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MonthlySpending, SpendingAggregate, SpendingFilter, SpendingGroupBy } from "../cache/db.js";
import type { BudgetStore } from "../cache/store.js";
import { BUCKET_RULES, bucketEcho, bucketsParameter, resolveBuckets, UNCLAIMED, type BucketInput, type Bucketing } from "./buckets.js";
import { currentMonth, dateRange, historyStart, lastDayOf, MAX_MONTHS, monthSpan, today } from "./dates.js";
import { REFRESH, respond, SHARED_NOTES, ToolError, type Report, type ToolContext } from "./envelope.js";
import { BY_ID_OR_NAME, resolveFilters } from "./filters.js";
import { renderSpread } from "./stats.js";

/** How many rows a breakdown shows before the rest is summed into `other`. */
const DEFAULT_LIMIT = 25;

/**
 * What "spending" means here, said in the response itself: a number the user compares against
 * YNAB is only trustworthy when the rule behind it is on the page.
 */
const SCOPE =
  "Spending is every line on an on-budget account with a non-internal category, or with no category unless it is a transfer to another on-budget account, net of refunds; transfers between budget accounts, tracking-account activity and inflows are excluded and counted in `excluded`.";

const description = `Where the money went: spending over a date range, grouped by category, category group, payee, account, month or \`buckets\` of your own. This is the tool for "where did the money go last month?".

${SCOPE} It matches YNAB's Spending report: a transfer to a tracking account counts in its category, or as \`Uncategorized\` until it has one; each split line lands in its own category; a deleted one shows as \`(deleted category)\`. Rows add up to \`total\`.

Rows are sorted by \`spent\` descending and carry \`spent\` (negative for a net refund), \`count\` of lines, \`months_active\` and \`share\` of \`total\` in percent. Over several months each row adds \`monthly\`: its \`average\`, \`median\`, \`min\` and \`max\` month, zero-filled, over the \`months_counted\` whole months the range covers inside the budget's history (\`history_starts\`); the current month is \`partial_month\`, left out unless \`include_partial\` is set. Category rows carry their \`group\`; hidden ones are marked. Rows past \`limit\` (25) sum into \`other\`. \`group_by: "month"\` gives a zero-filled, uncapped row per month. Filters OR inside a list and AND across; \`filters\` echoes what resolved.

${SHARED_NOTES}`;

export function registerSpendingBreakdown(server: McpServer, store: BudgetStore): void {
  server.registerTool(
    "spending_breakdown",
    {
      title: "Break down YNAB spending",
      description,
      inputSchema: {
        start: z.string().optional().describe("First day of the range, `YYYY-MM-DD` or `YYYY-MM` (the whole month). Defaults to the first of the current month."),
        end: z.string().optional().describe("Last day of the range, `YYYY-MM-DD` or `YYYY-MM` (the whole month), inclusive. Defaults to today."),
        group_by: z
          .enum(["category", "category_group", "payee", "account", "month"])
          .optional()
          .describe("What each row is. Defaults to `category`."),
        categories: z.array(z.string()).optional().describe(`Only these categories. ${BY_ID_OR_NAME}`),
        groups: z.array(z.string()).optional().describe(`Only categories in these category groups. ${BY_ID_OR_NAME}`),
        payees: z.array(z.string()).optional().describe(`Only these payees. ${BY_ID_OR_NAME}`),
        accounts: z.array(z.string()).optional().describe(`Only these accounts. ${BY_ID_OR_NAME}`),
        buckets: bucketsParameter(
          `Your own grouping of categories, in place of \`group_by\`: each bucket becomes a row summing the categories it names, directly or through their groups. ${BUCKET_RULES} ${UNCLAIMED} goes to \`unassigned\`, listed category by category, so the rows and \`unassigned\` add up to \`total\`. \`limit\` does not apply.`,
        ),
        limit: z.number().int().positive().optional().describe("How many rows before the rest is summed into `other`. Defaults to 25; ignored when grouping by month or by `buckets`."),
        include_partial: z.boolean().optional().describe("Count the current, unfinished month in each row's `monthly` figures. Off by default, so `min` is a complete month the budget has already lived on once: a floor, not a month cut short."),
        refresh: z.boolean().optional().describe(REFRESH),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ refresh, ...args }) => respond(store, { force: refresh === true }, (context) => buildBreakdown(context, args)),
  );
}

interface BreakdownArgs {
  start?: string;
  end?: string;
  group_by?: SpendingGroupBy;
  categories?: string[];
  groups?: string[];
  payees?: string[];
  accounts?: string[];
  buckets?: BucketInput[];
  limit?: number;
  include_partial?: boolean;
}

function buildBreakdown(context: ToolContext, args: BreakdownArgs): Report {
  const { from, to } = dateRange(args.start, args.end);
  // An empty list groups nothing, the way an empty filter constrains nothing.
  const bucketInputs = args.buckets ?? [];
  if (bucketInputs.length > 0 && args.group_by !== undefined) {
    throw new ToolError("`buckets` is a grouping of its own; leave out `group_by`.");
  }
  const bucketing = bucketInputs.length > 0 ? resolveBuckets(context, bucketInputs) : null;
  const groupBy = args.group_by ?? "category";
  const resolved = resolveFilters(context, args);
  const filter: SpendingFilter = { from, to, ...resolved.ids };

  const budgetId = context.budget.id;
  const total = context.db.spendingTotal(budgetId, filter);
  const floor = historyStart(context.budget.firstMonth, context.db.earliestDate(budgetId));
  // The calendar months the range touches, inside the budget's history: the month rows, and the
  // months the `monthly` figures are drawn from.
  const months = monthsOf(from, to, floor);
  // A month series is materialised row by row, so its span is capped; the other groupings only
  // take statistics over the months, which the budget's own history bounds.
  if (groupBy === "month" && !bucketing && months.length > MAX_MONTHS) {
    throw new ToolError(`${months[0]} to ${months[months.length - 1]} is ${months.length} months, more than one report covers; ask for at most ${MAX_MONTHS}.`);
  }

  const body: Report = { start: from, end: to, group_by: bucketing ? "bucket" : groupBy };
  // Said only when it cut months off: the month rows, and the months behind `monthly`, then start
  // later than `start`, and that has to read as "the budget did not exist yet", not as months
  // that went missing.
  if (floor !== null && floor > from.slice(0, 7)) body.history_starts = floor;
  if (resolved.echo) body.filters = resolved.echo;

  // One month has nothing to average over, and a month series is the figures themselves; otherwise
  // the figures cover the whole months, and the response says how many that is and which month is
  // still moving, so an average is read against the right number of months.
  let monthly: string[] | null = null;
  if (months.length > 1 && (bucketing || groupBy !== "month")) {
    const { whole, partial } = wholeMonths(months, from, to);
    const counted = whole.filter((month) => month !== partial || args.include_partial === true);
    if (counted.length > 0) {
      monthly = counted;
      body.months_counted = counted.length;
      if (partial) body.partial_month = partial;
    }
  }

  body.total = context.money(-total.spent);
  body.lines = total.count;
  body.scope = SCOPE;
  body.excluded = context.db.spendingExclusions(budgetId, filter);

  if (bucketing) {
    const categories = context.db.spendingBy(budgetId, "category", filter);
    const perMonth = context.db.spendingByMonth(budgetId, "category", filter);
    return { ...body, ...bucketRows(context, bucketing, categories, perMonth, total.spent, monthly) };
  }

  const aggregates = context.db.spendingBy(budgetId, groupBy, filter);
  const rows = groupBy === "month" ? gapFill(aggregates, months) : aggregates;
  const stats = monthly && groupBy !== "month" ? new MonthlyFigures(context, context.db.spendingByMonth(budgetId, groupBy, filter), monthly) : null;

  // The cap exists to keep a year of payees out of the context window; a month series has one row
  // per month by construction, and cutting it would turn a series into a hole.
  const limit = groupBy === "month" ? rows.length : (args.limit ?? DEFAULT_LIMIT);
  body.rows = rows.slice(0, limit).map((row) => render(context, row, groupBy, total.spent, stats));

  const cut = rows.slice(limit);
  if (cut.length > 0) {
    const { count, spent } = summed(cut);
    body.other = { count, spent: context.money(-spent), share: share(spent, total.spent) };
  }
  return body;
}

/**
 * The breakdown by the caller's buckets: each bucket's category rows summed in milliunits and
 * rendered once, and the rows no bucket claims listed category by category under `unassigned`.
 * A bucket's `months_active` cannot be added up from its categories' — two categories active in
 * the same month make one active month — so it counts the months in the per-month rows instead.
 * The category rows add up to the total and each lands in exactly one bucket or in `unassigned`,
 * so the bucket rows and `unassigned` add up to it as well. Every bucket gets a row, even one
 * that spent nothing, because a missing row would read as a bucket that was never asked for.
 */
function bucketRows(
  context: ToolContext,
  bucketing: Bucketing,
  categories: SpendingAggregate[],
  perMonth: MonthlySpending[],
  total: number,
  monthly: string[] | null,
): Report {
  const { assigned, unassigned } = bucketing.partition(categories);
  const monthsByBucket = bucketing.partition(perMonth).assigned;
  const active = monthsByBucket.map((rows) => new Set(rows.map((row) => row.month)).size);
  const sums = bucketing.buckets.map((bucket, index) => ({ bucket, index, monthsActive: active[index], ...summed(assigned[index]) }));
  // Most spent first, as every grouping is; the sums are negative, so ascending. The sort is
  // stable, so buckets that spent the same keep the order they were given in.
  sums.sort((a, b) => a.spent - b.spent);

  const stats = monthly ? new MonthlyFigures(context, perMonth, monthly) : null;
  const result: Report = {
    rows: sums.map(({ bucket, index, count, spent, monthsActive }) => {
      const row: Report = {
        name: bucket.name,
        spent: context.money(-spent),
        count,
        months_active: monthsActive,
        share: share(spent, total),
      };
      // A bucket's month is its categories' months added up, the way its total is.
      if (stats) row.monthly = stats.ofRows(monthsByBucket[index]);
      return { ...row, ...bucketEcho(bucket) };
    }),
  };
  if (unassigned.length > 0) {
    const { count, spent } = summed(unassigned);
    result.unassigned = {
      spent: context.money(-spent),
      count,
      share: share(spent, total),
      categories: unassigned.map((row) => render(context, row, "category", total, stats)),
    };
  }
  return result;
}

/**
 * Each row's spending month by month, so a breakdown can say how a row's months spread out and
 * not only what they add up to. Rows are told apart the way `spendingBy` tells them apart — by
 * id, or by name when there is none — so Uncategorized and a deleted category each get their own
 * months. The figures are over the months given, a month with nothing reading zero: a category
 * that spent in three months of six averages over six, which is what it costs a month.
 */
class MonthlyFigures {
  private readonly byRow = new Map<string, Map<string, number>>();

  constructor(
    private readonly context: ToolContext,
    rows: MonthlySpending[],
    private readonly months: string[],
  ) {
    for (const row of rows) {
      const id = rowKey(row);
      let byMonth = this.byRow.get(id);
      if (!byMonth) {
        byMonth = new Map();
        this.byRow.set(id, byMonth);
      }
      byMonth.set(row.month, (byMonth.get(row.month) ?? 0) + row.spent);
    }
  }

  /** The figures for one of `spendingBy`'s rows. */
  of(row: SpendingAggregate): Report {
    return this.figures(this.byRow.get(rowKey(row)) ?? new Map());
  }

  /** The figures for several rows' months added up: a bucket. */
  ofRows(rows: MonthlySpending[]): Report {
    const byMonth = new Map<string, number>();
    for (const row of rows) byMonth.set(row.month, (byMonth.get(row.month) ?? 0) + row.spent);
    return this.figures(byMonth);
  }

  private figures(byMonth: Map<string, number>): Report {
    // Spending is stored negative and reported positive. The months are never empty here: a range
    // with no whole month in it asks for no figures at all.
    return renderSpread(this.context, this.months.map((month) => -(byMonth.get(month) ?? 0))) ?? {};
  }
}

/** What tells one row from another: its id, or its name for the rows with no entity behind them. */
function rowKey(row: { key: string | null; name: string }): string {
  return row.key ?? `\u0000${row.name}`;
}

function summed(rows: SpendingAggregate[]): { count: number; spent: number } {
  return { count: rows.reduce((sum, row) => sum + row.count, 0), spent: rows.reduce((sum, row) => sum + row.spent, 0) };
}

function render(context: ToolContext, row: SpendingAggregate, groupBy: SpendingGroupBy, total: number, stats: MonthlyFigures | null): Report {
  const rendered: Report = {};
  // A row with no entity behind it — Uncategorized, a deleted category, a line with no payee —
  // has no id to hand back, and an id key holding null would only invite a lookup that cannot work.
  if (row.key !== null) rendered.id = row.key;
  rendered.name = row.name;
  if (groupBy === "category" && row.groupName) rendered.group = row.groupName;
  rendered.spent = context.money(-row.spent);
  rendered.count = row.count;
  // A month row is one month by definition, so the count would say nothing.
  if (groupBy !== "month") rendered.months_active = row.months;
  rendered.share = share(row.spent, total);
  if (stats) rendered.monthly = stats.of(row);
  if (row.hidden) rendered.hidden = true;
  return rendered;
}

/** A percentage of the total to one decimal. Both figures are negative, so the sign cancels. */
function share(spent: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((spent / total) * 1000) / 10;
}

/**
 * The calendar months of the range, in order, starting no earlier than `floor`, the budget's first
 * month: a month before the budget is not a month of spending nothing. Empty for a range that ends
 * before the budget begins, which has no months to show and no spending either.
 */
function monthsOf(from: string, to: string, floor: string | null): string[] {
  const [first, last] = [floor !== null && floor > from.slice(0, 7) ? floor : from.slice(0, 7), to.slice(0, 7)];
  return monthSpan(first, last);
}

/**
 * The months of `months` the range covers in full — every day of the month that has happened lies
 * inside it — which are the only months a figure per month can be taken from. A month the range
 * cuts into on either side is not a month of spending that little, and a month that has not come
 * is not a month of spending nothing, so both are left out without a word: they are not months the
 * figures could have covered. The current month counts when the range runs through today, and is
 * named `partial`, since it is still moving.
 */
function wholeMonths(months: string[], from: string, to: string): { whole: string[]; partial: string | null } {
  const [current, now] = [currentMonth(), today()];
  let partial: string | null = null;
  const whole = months.filter((month) => {
    if (`${month}-01` < from || month > current) return false;
    if (month === current) {
      if (to < now) return false;
      partial = month;
      return true;
    }
    return lastDayOf(month) <= to;
  });
  return { whole, partial };
}

/** One row per month, so a month with no spending reads as a zero and not a gap. */
function gapFill(aggregates: SpendingAggregate[], months: string[]): SpendingAggregate[] {
  const found = new Map(aggregates.map((row) => [row.key, row]));
  return months.map((month) => found.get(month) ?? { key: month, name: month, count: 0, spent: 0, months: 0 });
}
