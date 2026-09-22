import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MonthCategoryRangeRow } from "../cache/db.js";
import type { BudgetStore } from "../cache/store.js";
import { byName } from "../format/text.js";
import { currentMonth, MAX_MONTHS, monthWindow } from "./dates.js";
import { respond, SHARED_NOTES, type Report, type ToolContext } from "./envelope.js";
import { resolveFilters } from "./filters.js";

const description = `Which categories do we keep overspending? Assigned against actual, category by category, over a window of months, read from YNAB's own per-month figures rather than recomputed from transactions — so it cannot disagree with the budget screen.

Each row sums \`assigned\` and \`activity\` over the window, carries \`available\` as the category's balance at the end of the last month (absent when YNAB has no figures for that month yet), and counts the months that ended in the red (\`overspent_months\`) and the months where spending ran past the assignment (\`over_assigned_months\`). Those two answer different questions: a category can be overspent because last month's balance was already gone, and it can outrun its assignment while a carried-over balance keeps it black. \`activity\` keeps YNAB's sign, so spending is negative and a net refund is positive.

The window is the last six months ending at the current month; \`months\` changes how many, and \`start\` and \`end\` as \`YYYY-MM\` win over it. Categories with nothing assigned, no activity and no balance in every month are left out and counted in \`categories_omitted\`. Rows come most-overspent first, then biggest spender. \`include_months: true\` adds the per-month figures to each row. Hidden categories are included and marked \`hidden\`; credit card payment categories are included and marked \`credit_card_payment\`, and their activity is payments made, not spending. The current month is still being lived in, so it is reported as \`partial_month\` and left out of both counts — \`include_partial: true\` counts it — while its assigned and activity still add into the totals. \`categories\` and \`groups\` narrow the report, by id or exact name.

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
        categories: z.array(z.string()).optional().describe("Only these categories, by id or exact name."),
        groups: z.array(z.string()).optional().describe("Only the categories in these category groups, by id or exact name."),
        include_months: z.boolean().optional().describe("Add each category's month-by-month assigned, activity and available. Off by default."),
        include_partial: z.boolean().optional().describe("Count the current, unfinished month in `overspent_months` and `over_assigned_months`. Off by default."),
        refresh: z.boolean().optional().describe("Pull the latest changes from YNAB before reporting, even if the cache is recent."),
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
  const filter = resolveFilters(context, { categories: args.categories, groups: args.groups });
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
  // The milliunit activity travels beside the rendered row: the sort is on the figure, not its rendering.
  const ranked: { row: Report; activity: number }[] = [];
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
    report.overspent_months = counted.filter((row) => row.balance < 0).length;
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
    ranked.push({ row: report, activity });
  }

  // Most overspent first, then the biggest spender: activity is negative for spending, so ascending.
  const byCategoryName = byName<Report>((row) => row.name as string);
  ranked.sort(
    (a, b) =>
      (b.row.overspent_months as number) - (a.row.overspent_months as number) ||
      a.activity - b.activity ||
      byCategoryName(a.row, b.row),
  );

  const body: Report = { start: months[0], end: months[months.length - 1] };
  if (partialMonth) body.partial_month = partialMonth;
  body.categories_omitted = omitted;
  body.rows = ranked.map((entry) => entry.row);
  return body;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
