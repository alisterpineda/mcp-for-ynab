import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MonthCategoryRangeRow } from "../cache/db.js";
import type { BudgetStore } from "../cache/store.js";
import { byName } from "../format/text.js";
import { currentMonth, MAX_MONTHS, monthWindow } from "./dates.js";
import { REFRESH, respond, SHARED_NOTES, type Report, type ToolContext } from "./envelope.js";
import { BY_ID_OR_NAME, resolveFilters } from "./filters.js";

const description = `Which categories do we keep overspending? Assigned against actual, category by category, over a window of months, read from YNAB's own per-month figures, so it cannot disagree with the budget screen.

Each row sums \`assigned\` and \`activity\` over the window, carries \`available\` as the balance at the end of the last month (absent when YNAB has no figures for it yet), and counts the months that ended in the red (\`overspent_months\`, with \`overspent\` how far in total) and the months where spending ran past the assignment (\`over_assigned_months\`). The two differ: a category can be overspent because last month's balance was already gone, and can outrun its assignment while a carried-over balance keeps it black. \`activity\` keeps YNAB's sign, so spending is negative.

The window is the last six months ending at the current one. Rows come most-overspent first, by amount, then biggest spender; categories that are zero throughout are counted in \`categories_omitted\`. Hidden categories are kept and marked \`hidden\`. Credit card payment categories are kept and marked \`credit_card_payment\`: their activity is card spending moved onto them minus payments, not spending. The current month is \`partial_month\`, left out of both counts unless \`include_partial\` is set, though its figures still add into the totals. \`filters\` names what \`categories\` and \`groups\` resolved to.

${SHARED_NOTES}`;

export function registerBudgetVsActual(server: McpServer, store: BudgetStore): void {
  server.registerTool(
    "budget_vs_actual",
    {
      title: "Compare YNAB assignments against activity",
      description,
      inputSchema: {
        months: z.number().int().positive().max(MAX_MONTHS).optional().describe(`How many months the window covers, ending at the current month. Defaults to 6, at most ${MAX_MONTHS}.`),
        start: z.string().optional().describe("First month of the window, `YYYY-MM`. Wins over `months`."),
        end: z.string().optional().describe("Last month of the window, `YYYY-MM`, inclusive. Wins over `months`; defaults to the current month."),
        categories: z.array(z.string()).optional().describe(`Only these categories. ${BY_ID_OR_NAME}`),
        groups: z.array(z.string()).optional().describe(`Only the categories in these category groups. ${BY_ID_OR_NAME}`),
        include_months: z.boolean().optional().describe("Add each category's month-by-month assigned, activity and available. Off by default."),
        include_partial: z.boolean().optional().describe("Count the current, unfinished month in `overspent_months`, `overspent` and `over_assigned_months`. Off by default."),
        refresh: z.boolean().optional().describe(REFRESH),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ refresh, ...args }) => respond(store, { force: refresh === true }, (context) => buildComparison(context, args)),
  );
}

interface ComparisonArgs {
  months?: number;
  start?: string;
  end?: string;
  categories?: string[];
  groups?: string[];
  include_months?: boolean;
  include_partial?: boolean;
}

/** One category's months, gathered before anything is counted or rendered. */
interface Bucket {
  rows: MonthCategoryRangeRow[];
}

function buildComparison(context: ToolContext, args: ComparisonArgs): Report {
  const resolved = resolveFilters(context, { categories: args.categories, groups: args.groups });
  const filter = resolved.ids;
  const months = monthWindow(args.months, args.start, args.end);
  const partialMonth = months.includes(currentMonth()) ? currentMonth() : null;
  const countPartial = args.include_partial === true;

  const buckets = new Map<string, Bucket>();
  for (const row of context.db.monthCategoryRange(context.budget.id, months, filter)) {
    let bucket = buckets.get(row.categoryId);
    if (!bucket) {
      bucket = { rows: [] };
      buckets.set(row.categoryId, bucket);
    }
    bucket.rows.push(row);
  }

  let omitted = 0;
  // The milliunit figures travel beside the rendered row: the sort is on the figures, not their rendering.
  const ranked: { row: Report; overspent: number; activity: number }[] = [];
  for (const bucket of buckets.values()) {
    // A category that was never assigned to, never spent in and never carried a balance has
    // nothing to compare; padding the report with its zeroes would only bury the rest.
    if (bucket.rows.every((row) => row.budgeted === 0 && row.activity === 0 && row.balance === 0)) {
      omitted += 1;
      continue;
    }
    // The rows arrive in month order, but only for the months YNAB has filled in: the last row is
    // the latest this category has, which names it, while `available` is promised as the balance
    // at the end of the window and so comes only from that month's own row.
    const last = bucket.rows[bucket.rows.length - 1];
    const endRow = bucket.rows.find((row) => row.month === months[months.length - 1]);
    const counted = bucket.rows.filter((row) => countPartial || row.month !== partialMonth);
    const assigned = sum(bucket.rows.map((row) => row.budgeted));
    const activity = sum(bucket.rows.map((row) => row.activity));

    const report: Report = {
      id: last.categoryId,
      name: last.name,
      group: last.groupName,
      // Rendered once from the milliunit sums: a sum of rounded months drifts from the months it claims.
      assigned: context.money(assigned),
      activity: context.money(activity),
    };
    if (endRow) report.available = context.money(endRow.balance);
    const inTheRed = counted.filter((row) => row.balance < 0);
    report.overspent_months = inTheRed.length;
    // How far into the red, summed over those months: three months a little over and one month far
    // over are different answers, and the count alone cannot tell them apart.
    const overspent = -sum(inTheRed.map((row) => row.balance));
    if (overspent > 0) report.overspent = context.money(overspent);
    report.over_assigned_months = counted.filter((row) => -row.activity > row.budgeted).length;
    if (last.hidden) report.hidden = true;
    if (last.creditCardPayment) report.credit_card_payment = true;
    if (args.include_months === true) {
      report.months = bucket.rows.map((row) => {
        const point: Report = {
          month: row.month,
          assigned: context.money(row.budgeted),
          activity: context.money(row.activity),
          available: context.money(row.balance),
        };
        if (row.month === partialMonth) point.partial = true;
        return point;
      });
    }
    ranked.push({ row: report, overspent, activity });
  }

  // Most overspent first — by how far into the red, then how often — then the biggest spender:
  // activity is negative for spending, so ascending.
  const byCategoryName = byName<Report>((row) => row.name as string);
  ranked.sort(
    (a, b) =>
      b.overspent - a.overspent ||
      (b.row.overspent_months as number) - (a.row.overspent_months as number) ||
      a.activity - b.activity ||
      byCategoryName(a.row, b.row),
  );

  const body: Report = { start: months[0], end: months[months.length - 1] };
  if (partialMonth) body.partial_month = partialMonth;
  if (resolved.echo) body.filters = resolved.echo;
  body.categories_omitted = omitted;
  body.rows = ranked.map((entry) => entry.row);
  return body;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
