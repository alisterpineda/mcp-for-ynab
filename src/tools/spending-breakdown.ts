import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SpendingAggregate, SpendingFilter, SpendingGroupBy } from "../cache/db.js";
import type { BudgetStore } from "../cache/store.js";
import { dateRange, historyStart, monthWindow } from "./dates.js";
import { REFRESH, respond, SHARED_NOTES, type Report, type ToolContext } from "./envelope.js";
import { BY_ID_OR_NAME, resolveFilters } from "./filters.js";

/** How many rows a breakdown shows before the rest is summed into `other`. */
const DEFAULT_LIMIT = 25;

/**
 * What "spending" means here, said in the response itself: a number the user compares against
 * YNAB is only trustworthy when the rule behind it is on the page.
 */
const SCOPE =
  "Spending is every line on an on-budget account with a non-internal category, or with no category unless it is a transfer to another on-budget account, net of refunds; transfers between budget accounts, tracking-account activity and inflows are excluded and counted in `excluded`.";

const description = `Where the money went: spending over a date range, grouped by category, category group, payee, account or month. This is the tool for "where did the money go last month?", "which shops take the most?" and "what did we spend in March?".

${SCOPE} It matches YNAB's Spending report: a transfer to a tracking account (a mortgage payment) counts in its category, or as \`Uncategorized\` until it has one; refunds net against their category; each split line lands in its own category. A deleted category shows as \`(deleted category)\`, so the rows always add up to \`total\`.

Rows are sorted by \`spent\` descending and carry \`spent\` (negative for a net refund), a \`count\` of lines and a \`share\` of \`total\` in percent. Category rows carry their \`group\`, and a hidden category is marked \`hidden\`, not dropped. Rows past the first 25 (\`limit\`) are summed into \`other\`. \`group_by: "month"\` gives one row per month in chronological order, zero-filled and never capped, from the budget's first month on (\`history_starts\` says when that cut the range). The filter lists are ORed inside and ANDed across, and \`filters\` names what each resolved to.

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
        limit: z.number().int().positive().optional().describe("How many rows before the rest is summed into `other`. Defaults to 25; ignored when grouping by month."),
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
  limit?: number;
}

function buildBreakdown(context: ToolContext, args: BreakdownArgs): Report {
  const { from, to } = dateRange(args.start, args.end);
  const groupBy = args.group_by ?? "category";
  const resolved = resolveFilters(context, args);
  const filter: SpendingFilter = { from, to, ...resolved.ids };

  const budgetId = context.budget.id;
  const total = context.db.spendingTotal(budgetId, filter);
  const aggregates = context.db.spendingBy(budgetId, groupBy, filter);
  const floor = groupBy === "month" ? historyStart(context.budget.firstMonth, context.db.earliestDate(budgetId)) : null;
  const rows = groupBy === "month" ? gapFill(aggregates, from, to, floor) : aggregates;

  const body: Report = { start: from, end: to, group_by: groupBy };
  // Said only when it cut months off: the rows then start later than `start`, and that has to read as
  // "the budget did not exist yet", not as months that went missing.
  if (floor !== null && floor > from.slice(0, 7)) body.history_starts = floor;
  if (resolved.echo) body.filters = resolved.echo;
  body.total = context.money(-total.spent);
  body.lines = total.count;
  body.scope = SCOPE;
  body.excluded = context.db.spendingExclusions(budgetId, filter);

  // The cap exists to keep a year of payees out of the context window; a month series has one row
  // per month by construction, and cutting it would turn a series into a hole.
  const limit = groupBy === "month" ? rows.length : (args.limit ?? DEFAULT_LIMIT);
  body.rows = rows.slice(0, limit).map((row) => render(context, row, groupBy, total.spent));

  const cut = rows.slice(limit);
  if (cut.length > 0) {
    const spent = cut.reduce((sum, row) => sum + row.spent, 0);
    body.other = {
      count: cut.reduce((sum, row) => sum + row.count, 0),
      spent: context.money(-spent),
      share: share(spent, total.spent),
    };
  }
  return body;
}

function render(context: ToolContext, row: SpendingAggregate, groupBy: SpendingGroupBy, total: number): Report {
  const rendered: Report = {};
  // A bucket with no entity behind it — Uncategorized, a deleted category, a line with no payee —
  // has no id to hand back, and an id key holding null would only invite a lookup that cannot work.
  if (row.key !== null) rendered.id = row.key;
  rendered.name = row.name;
  if (groupBy === "category" && row.groupName) rendered.group = row.groupName;
  rendered.spent = context.money(-row.spent);
  rendered.count = row.count;
  rendered.share = share(row.spent, total);
  if (row.hidden) rendered.hidden = true;
  return rendered;
}

/** A percentage of the total to one decimal. Both figures are negative, so the sign cancels. */
function share(spent: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((spent / total) * 1000) / 10;
}

/**
 * Every month of the range, in order, so a month with no spending reads as a zero and not a gap —
 * starting no earlier than `floor`, the budget's first month, since a month before the budget is
 * not a month of spending nothing.
 */
function gapFill(aggregates: SpendingAggregate[], from: string, to: string, floor: string | null): SpendingAggregate[] {
  const found = new Map(aggregates.map((row) => [row.key, row]));
  const [first, last] = [floor !== null && floor > from.slice(0, 7) ? floor : from.slice(0, 7), to.slice(0, 7)];
  // A range that ends before the budget begins has no months to show, and no spending either.
  if (first > last) return [];
  return monthWindow(undefined, first, last).map((month) => found.get(month) ?? { key: month, name: month, count: 0, spent: 0 });
}
