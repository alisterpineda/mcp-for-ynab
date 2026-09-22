import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MonthlySpending } from "../cache/db.js";
import type { BudgetStore } from "../cache/store.js";
import { currentMonth, dateRange, MAX_MONTHS, monthWindow } from "./dates.js";
import { respond, SHARED_NOTES, ToolError, type Report, type ToolContext } from "./envelope.js";
import { resolveFilters } from "./filters.js";

const description = `Is it creeping up? A month-by-month series of spending for the categories or category groups you name, with the average, the lowest month and the highest. This is the tool for "how has dining out gone over the last six months?" and "are we spending more on groceries than we used to?".

Ask for at least one \`categories\` or \`groups\` entry, by id or exact name — an ambiguous name comes back as an error listing the candidates. Each one becomes its own series in the order you asked, a group series being the sum of every category in it. The window is the last six months ending at the current month; \`months\` changes how many, and \`start\` and \`end\` as \`YYYY-MM\` win over it. The window cannot run past the current month, since a month that has not started has no spending to trend. Every month of the window is present in chronological order, and a month with no activity reads \`spent: 0\` rather than going missing.

\`spent\` is positive for spending and negative for a month that netted a refund. The same rule as \`spending_breakdown\` decides what counts: lines on on-budget accounts with a non-internal category, so a categorized transfer to a tracking account counts, transfers between budget accounts and income do not, and each line of a split lands in its own category. The current month is still being lived in, so it is flagged \`partial\` and left out of \`average\`, \`min\` and \`max\`; \`include_partial: true\` counts it, and when the window holds no complete month those three keys are absent rather than guessed.

${SHARED_NOTES}`;

export function registerSpendingTrend(server: McpServer, store: BudgetStore): void {
  server.registerTool(
    "spending_trend",
    {
      title: "Trend YNAB spending by month",
      description,
      inputSchema: {
        categories: z.array(z.string()).optional().describe("Categories to trend, one series each, by id or exact name."),
        groups: z.array(z.string()).optional().describe("Category groups to trend, one series each summing the group's categories, by id or exact name."),
        months: z.number().int().positive().max(MAX_MONTHS).optional().describe(`How many months the window covers, ending at the current month. Defaults to 6, at most ${MAX_MONTHS}.`),
        start: z.string().optional().describe("First month of the window, `YYYY-MM`. Wins over `months`."),
        end: z.string().optional().describe("Last month of the window, `YYYY-MM`, inclusive. Wins over `months`; defaults to the current month."),
        include_partial: z.boolean().optional().describe("Count the current, unfinished month in `average`, `min` and `max`. Off by default."),
        refresh: z.boolean().optional().describe("Pull the latest changes from YNAB before reporting, even if the cache is recent."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ refresh, ...args }) => respond(store, { force: refresh === true }, (context) => buildTrend(context, args)),
  );
}

interface TrendArgs {
  categories?: string[];
  groups?: string[];
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
  const [categories, groups] = [args.categories ?? [], args.groups ?? []];
  // Trending the whole budget is `spending_breakdown` with `group_by: "month"`; asking here with
  // nothing named is a question that has no series in it, so say that rather than answer something else.
  if (categories.length + groups.length === 0) {
    throw new ToolError("Name at least one category or category group to trend, by id or exact name.");
  }

  const budgetId = context.budget.id;
  const resolved = resolveFilters(context, { categories, groups });
  const categoryIds = resolved.categoryIds ?? [];
  const groupIds = resolved.groupIds ?? [];
  const categoryNames = context.db.entityLabels(budgetId, "categories", categoryIds);
  const groupNames = context.db.entityLabels(budgetId, "groups", groupIds);
  const specs: SeriesSpec[] = [
    ...categoryIds.map((id) => ({ id, name: categoryNames.get(id) ?? id, kind: "category" as const })),
    ...groupIds.map((id) => ({ id, name: groupNames.get(id) ?? id, kind: "category_group" as const })),
  ];

  const months = monthWindow(args.months, args.start, args.end);
  const [first, last] = [months[0], months[months.length - 1]];
  // A month that has not started has no spending to trend, and a zero for it would read as a
  // month of spending nothing — so a window past the current month is refused, not zero-filled.
  if (last > currentMonth()) {
    throw new ToolError(`The window ends at ${last}, after the current month ${currentMonth()}; there is no spending to trend there yet.`);
  }
  // The months are whole, so the range is the first day of the first to the last day of the last.
  const { from, to } = dateRange(first, last);
  const partialMonth = months.includes(currentMonth()) ? currentMonth() : null;

  // One pass over the lines per kind, however many series were asked for: the flatten and the
  // spending rule cost the same for one category as for twenty.
  const found = new Map<string, Map<string, number>>();
  if (categoryIds.length > 0) index(found, context.db.spendingByMonth(budgetId, "category", { from, to, categoryIds }));
  if (groupIds.length > 0) index(found, context.db.spendingByMonth(budgetId, "category_group", { from, to, groupIds }));

  const body: Report = { start: first, end: last };
  if (partialMonth) body.partial_month = partialMonth;
  body.series = specs.map((spec) =>
    buildSeries(context, spec, found.get(spec.id) ?? new Map(), months, partialMonth, args.include_partial === true),
  );
  return body;
}

/** The monthly sums keyed by entity, then by month, so each series reads its own without a scan. */
function index(into: Map<string, Map<string, number>>, rows: MonthlySpending[]): void {
  for (const row of rows) {
    let byMonth = into.get(row.key);
    if (!byMonth) {
      byMonth = new Map();
      into.set(row.key, byMonth);
    }
    byMonth.set(row.month, row.spent);
  }
}

function buildSeries(
  context: ToolContext,
  spec: SeriesSpec,
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

  const series: Report = { id: spec.id, name: spec.name, kind: spec.kind, months: points };
  if (counted.length > 0) {
    series.average = context.money(counted.reduce((sum, value) => sum + value, 0) / counted.length);
    series.min = context.money(Math.min(...counted));
    series.max = context.money(Math.max(...counted));
  }
  return series;
}
