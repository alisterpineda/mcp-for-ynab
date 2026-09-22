import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MonthlySpending } from "../cache/db.js";
import type { BudgetStore } from "../cache/store.js";
import { BUCKET_RULES, bucketEcho, bucketsParameter, resolveBuckets, UNCLAIMED, type BucketInput } from "./buckets.js";
import { historyStart, historyWindow, MAX_MONTHS, monthWindow } from "./dates.js";
import { REFRESH, respond, SHARED_NOTES, ToolError, type Report, type ToolContext } from "./envelope.js";
import { BY_ID_OR_NAME, resolveFilters } from "./filters.js";

const description = `Is it creeping up? A month-by-month series of spending for the categories or category groups you name, with the average, the lowest month and the highest. This is the tool for "how has dining out gone over the last six months?" and "are we spending more on groceries than we used to?".

Name at least one of \`categories\`, \`groups\` or \`buckets\`. Each category or group is a series in the order asked, named by \`id\` and \`name\` so a partial name shows what it landed on; a group series sums its categories. Bucket series follow, with no \`id\`. The window is the last six months ending at the current one, and never runs past it. Nor does it reach back before the budget: a window that would starts at the budget's first month, named by \`history_starts\`, so the series is shorter than asked and the statistics cover only months the budget existed in. Every month is present in chronological order, and one with no activity reads \`spent: 0\`.

\`spent\` is positive for spending and negative for a month that netted a refund, counted by the same rule as \`spending_breakdown\`: a categorized transfer to a tracking account counts, transfers between budget accounts and income do not, and each split line lands in its own category. The current month is flagged \`partial\` and left out of \`average\`, \`min\` and \`max\` unless \`include_partial\` is set; with no complete month in the window those keys are absent rather than guessed.

${SHARED_NOTES}`;

export function registerSpendingTrend(server: McpServer, store: BudgetStore): void {
  server.registerTool(
    "spending_trend",
    {
      title: "Trend YNAB spending by month",
      description,
      inputSchema: {
        categories: z.array(z.string()).optional().describe(`Categories to trend, one series each. ${BY_ID_OR_NAME}`),
        groups: z.array(z.string()).optional().describe(`Category groups to trend, one series each summing the group's categories. ${BY_ID_OR_NAME}`),
        buckets: bucketsParameter(
          `Your own grouping of categories: each bucket becomes a series, after any \`categories\` and \`groups\` series, summing the categories it names directly or through their groups. ${BUCKET_RULES} ${UNCLAIMED} goes to an \`unassigned\` series of its own, so the bucket series and \`unassigned\` add up to all spending, month by month.`,
        ),
        months: z.number().int().positive().max(MAX_MONTHS).optional().describe(`How many months the window covers, ending at the current month. Defaults to 6, at most ${MAX_MONTHS}.`),
        start: z.string().optional().describe("First month of the window, `YYYY-MM`. Wins over `months`."),
        end: z.string().optional().describe("Last month of the window, `YYYY-MM`, inclusive. Wins over `months`; defaults to the current month and cannot be later."),
        include_partial: z.boolean().optional().describe("Count the current, unfinished month in `average`, `min` and `max`. Off by default."),
        refresh: z.boolean().optional().describe(REFRESH),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ refresh, ...args }) => respond(store, { force: refresh === true }, (context) => buildTrend(context, args)),
  );
}

interface TrendArgs {
  categories?: string[];
  groups?: string[];
  buckets?: BucketInput[];
  months?: number;
  start?: string;
  end?: string;
  include_partial?: boolean;
}

/** One series before its numbers: what it is called and which lines belong to it. */
interface SeriesSpec {
  id: string;
  name: string;
  kind: "category" | "category_group";
}

function buildTrend(context: ToolContext, args: TrendArgs): Report {
  const [categories, groups, bucketInputs] = [args.categories ?? [], args.groups ?? [], args.buckets ?? []];
  // Trending the whole budget is `spending_breakdown` with `group_by: "month"`; asking here with
  // nothing named is a question that has no series in it, so say that rather than answer something else.
  if (categories.length + groups.length + bucketInputs.length === 0) {
    throw new ToolError("Name at least one category, category group or bucket to trend, by id or name.");
  }

  const budgetId = context.budget.id;
  // The resolver already named what it matched, so the series are labelled the way the echo is.
  const resolved = resolveFilters(context, { categories, groups });
  const categoryIds = resolved.ids.categoryIds ?? [];
  const groupIds = resolved.ids.groupIds ?? [];
  const specs: SeriesSpec[] = [
    ...(resolved.echo?.categories ?? []).map(({ id, name }) => ({ id, name, kind: "category" as const })),
    ...(resolved.echo?.groups ?? []).map(({ id, name }) => ({ id, name, kind: "category_group" as const })),
  ];
  const bucketing = bucketInputs.length > 0 ? resolveBuckets(context, bucketInputs) : null;

  // A window cut at the budget's first month says where the history starts, so a shorter series is
  // not read as the one asked for.
  const window = historyWindow(
    monthWindow(args.months, args.start, args.end),
    historyStart(context.budget.firstMonth, context.db.earliestDate(budgetId)),
  );
  const { months, from, to, partialMonth } = window;

  // One pass over the lines per kind, however many series were asked for: the flatten and the
  // spending rule cost the same for one category as for twenty.
  const found = new Map<string, Map<string, number>>();
  if (categoryIds.length > 0) index(found, context.db.spendingByMonth(budgetId, "category", { from, to, categoryIds }));
  if (groupIds.length > 0) index(found, context.db.spendingByMonth(budgetId, "category_group", { from, to, groupIds }));

  const includePartial = args.include_partial === true;
  const figuresOf = (byMonth: Map<string, number>) => figures(context, byMonth, months, partialMonth, includePartial);
  const series: Report[] = specs.map((spec) => ({ id: spec.id, name: spec.name, kind: spec.kind, ...figuresOf(found.get(spec.id) ?? new Map()) }));

  let unassigned: Report | undefined;
  if (bucketing) {
    // Every spending line in the window by category, the uncategorized and deleted ones under a
    // null key, so the bucket series and `unassigned` between them account for all of it.
    const partition = bucketing.partition(context.db.spendingByMonth(budgetId, "category", { from, to }));
    bucketing.buckets.forEach((bucket, index) => {
      series.push({ name: bucket.name, kind: "bucket", ...bucketEcho(bucket), ...figuresOf(monthly(partition.assigned[index])) });
    });
    if (partition.unassigned.length > 0) unassigned = figuresOf(monthly(partition.unassigned));
  }

  const body: Report = { start: months[0], end: months[months.length - 1] };
  if (window.cut) body.history_starts = months[0];
  if (partialMonth) body.partial_month = partialMonth;
  body.series = series;
  if (unassigned) body.unassigned = unassigned;
  return body;
}

/** The monthly sums keyed by entity, then by month, so each series reads its own without a scan. */
function index(into: Map<string, Map<string, number>>, rows: MonthlySpending[]): void {
  for (const row of rows) {
    // A filter by id never reaches a line with no entity, but the type allows one.
    if (row.key === null) continue;
    let byMonth = into.get(row.key);
    if (!byMonth) {
      byMonth = new Map();
      into.set(row.key, byMonth);
    }
    byMonth.set(row.month, row.spent);
  }
}

/** Several categories' rows summed per month: a bucket's series, or what no bucket claimed. */
function monthly(rows: MonthlySpending[]): Map<string, number> {
  const byMonth = new Map<string, number>();
  for (const row of rows) byMonth.set(row.month, (byMonth.get(row.month) ?? 0) + row.spent);
  return byMonth;
}

/** A series' months and statistics, from its milliunit sums by month. */
function figures(
  context: ToolContext,
  found: Map<string, number>,
  months: string[],
  partialMonth: string | null,
  includePartial: boolean,
): Report {
  const points: Report[] = [];
  // The statistics are kept in milliunits and rendered once at the end: an average of already
  // rounded months would drift away from the months it claims to summarise.
  const counted: number[] = [];
  for (const month of months) {
    // Spending is stored negative; the series reports it the way a person says it, positive.
    const spent = -(found.get(month) ?? 0);
    const point: Report = { month, spent: context.money(spent) };
    if (month === partialMonth) point.partial = true;
    if (month !== partialMonth || includePartial) counted.push(spent);
    points.push(point);
  }

  const series: Report = { months: points };
  if (counted.length > 0) {
    series.average = context.money(counted.reduce((sum, value) => sum + value, 0) / counted.length);
    series.min = context.money(Math.min(...counted));
    series.max = context.money(Math.max(...counted));
  }
  return series;
}
