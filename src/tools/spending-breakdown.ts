import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SpendingAggregate, SpendingFilter, SpendingGroupBy } from "../cache/db.js";
import type { BudgetStore } from "../cache/store.js";
import { dateRange, monthWindow } from "./dates.js";
import { respond, SHARED_NOTES, type Report, type ToolContext } from "./envelope.js";
import { resolveFilters } from "./filters.js";

/** How many rows a breakdown shows before the rest is summed into `other`. */
const DEFAULT_LIMIT = 25;

/**
 * What "spending" means here, said in the response itself: a number the user compares against
 * YNAB is only trustworthy when the rule behind it is on the page.
 */
const SCOPE =
  "Spending is every line on an on-budget account with a non-internal category or no category and no transfer, net of refunds; transfers between budget accounts, tracking-account activity and inflows are excluded and counted in `excluded`.";

const description = `Where the money went: spending over a date range, grouped by category, category group, payee, account or month. This is the tool for "where did the money go last month?", "which shops take the most?" and "what did we spend in March?".

${SCOPE} It matches YNAB's own Spending report: a categorized transfer to a tracking account (a mortgage payment, a brokerage contribution) counts as spending in its category, refunds net against the category they were returned to, and each line of a split lands in its own category. Uncategorized lines show up as \`Uncategorized\` and lines in a category that no longer exists as \`(deleted category)\`, so the rows always add up to \`total\`.

Rows are sorted by \`spent\` descending — the biggest first, not alphabetically — and each carries \`spent\` (positive for spending, negative for a category that netted a refund), \`count\` of lines and \`share\` as a percentage of \`total\` to one decimal. Category rows also carry their \`group\`, and a category hidden in YNAB is marked \`hidden\` rather than dropped. Only the first 25 rows come back; the rest are summed into \`other\`, and \`limit\` raises or lowers that. \`group_by: "month"\` returns one row per month of the range in chronological order, zero-filled and never capped.

\`start\` and \`end\` accept \`YYYY-MM-DD\` or \`YYYY-MM\` (a month widens to its whole span) and are both inclusive; they default to the first of the current month and today. \`categories\`, \`groups\`, \`payees\` and \`accounts\` narrow the range and take ids or names — a whole name first, else a part that only one entity contains, so "costco" finds "Costco Wholesale" — with no need to look an id up first; an ambiguous name comes back as an error listing the candidates. Values inside one list are ORed, and the lists are ANDed together. \`filters\` in the response names what each list resolved to, so a partial name that landed somewhere unexpected is visible next to the numbers.

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
        categories: z.array(z.string()).optional().describe("Only these categories, by id or name."),
        groups: z.array(z.string()).optional().describe("Only categories in these category groups, by id or name."),
        payees: z.array(z.string()).optional().describe("Only these payees, by id or name."),
        accounts: z.array(z.string()).optional().describe("Only these accounts, by id or name."),
        limit: z.number().int().positive().optional().describe("How many rows before the rest is summed into `other`. Defaults to 25; ignored when grouping by month."),
        refresh: z.boolean().optional().describe("Pull the latest changes from YNAB before reporting, even if the cache is recent."),
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
  const rows = groupBy === "month" ? gapFill(aggregates, from, to) : aggregates;

  const body: Report = { start: from, end: to, group_by: groupBy };
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

/** Every month of the range, in order, so a month with no spending reads as a zero and not a gap. */
function gapFill(aggregates: SpendingAggregate[], from: string, to: string): SpendingAggregate[] {
  const found = new Map(aggregates.map((row) => [row.key, row]));
  return monthWindow(undefined, from.slice(0, 7), to.slice(0, 7)).map(
    (month) => found.get(month) ?? { key: month, name: month, count: 0, spent: 0 },
  );
}
