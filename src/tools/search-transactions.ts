import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SearchFilter, TransactionLine } from "../cache/db.js";
import type { BudgetStore } from "../cache/store.js";
import { dateRange } from "./dates.js";
import { respond, SHARED_NOTES, type Report, type ToolContext } from "./envelope.js";
import { resolveFilters } from "./filters.js";

/** How many lines come back when nothing was asked for, and the most that ever do. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** YNAB stores money in thousandths of a currency unit, whatever the currency's own precision is. */
const MILLIUNITS = 1000;

const description = `The transactions behind a number: individual lines filtered by date, category, category group, payee, account, amount, direction and memo text. This is the tool for "what were those grocery charges?", "what did I move into the brokerage this year?" and "find the $43 charge I do not recognise".

Unlike \`spending_breakdown\` this applies no spending rule: it reaches every line in the cache, tracking accounts, transfers and income included, so a search can find any transaction the register shows. A split transaction is returned as one row per split line, each with its own category and a \`parent_id\` pointing at the transaction it came from.

Each row carries \`id\`, \`date\`, \`account\`, \`amount\`, \`cleared\` and \`approved\`, plus \`parent_id\`, \`payee\`, \`category\`, \`group\`, \`memo\` and \`flag\` when the line has them — a key the line has nothing for is left out rather than sent as an empty value. \`amount\` keeps YNAB's own sign: money out is negative and money in, a refund or a paycheque, is positive. Rows come newest first.

\`min_amount\` and \`max_amount\` are absolute values in currency units (\`20\` is twenty, not twenty thousand) and both bounds are inclusive, so "between 20 and 50" matches a 20 outflow and a 50 refund alike; \`direction\` narrows that to \`outflow\` or \`inflow\`. \`text\` matches part of the memo or the payee's name, ignoring case. \`start\` and \`end\` accept \`YYYY-MM-DD\` or \`YYYY-MM\` and are inclusive, defaulting to the first of the current month and today. \`categories\`, \`groups\`, \`payees\` and \`accounts\` take ids or exact names — an ambiguous name comes back as an error listing the candidates — and are ORed inside a list, ANDed across lists.

At most 50 rows come back (\`limit\` raises that to 200 at most), but \`count\` and \`sum\` always cover every matching line, so a broad search still reports the whole picture.

${SHARED_NOTES}`;

export function registerSearchTransactions(server: McpServer, store: BudgetStore): void {
  server.registerTool(
    "search_transactions",
    {
      title: "Search YNAB transactions",
      description,
      inputSchema: {
        start: z.string().optional().describe("First day of the range, `YYYY-MM-DD` or `YYYY-MM` (the whole month). Defaults to the first of the current month."),
        end: z.string().optional().describe("Last day of the range, `YYYY-MM-DD` or `YYYY-MM` (the whole month), inclusive. Defaults to today."),
        categories: z.array(z.string()).optional().describe("Only these categories, by id or exact name."),
        groups: z.array(z.string()).optional().describe("Only categories in these category groups, by id or exact name."),
        payees: z.array(z.string()).optional().describe("Only these payees, by id or exact name."),
        accounts: z.array(z.string()).optional().describe("Only these accounts, by id or exact name; tracking accounts are allowed."),
        min_amount: z.number().nonnegative().optional().describe("Smallest absolute amount to match, in currency units (`20` is twenty). Inclusive."),
        max_amount: z.number().nonnegative().optional().describe("Largest absolute amount to match, in currency units. Inclusive."),
        direction: z.enum(["outflow", "inflow"]).optional().describe("`outflow` keeps money going out, `inflow` money coming in. Both by default."),
        text: z.string().optional().describe("Substring of the memo or the payee's name, matched ignoring case."),
        limit: z.number().int().positive().optional().describe("How many rows to return. Defaults to 50, capped at 200; `count` and `sum` still cover every match."),
        refresh: z.boolean().optional().describe("Pull the latest changes from YNAB before reporting, even if the cache is recent."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ refresh, ...args }) => respond(store, { force: refresh === true }, (context) => buildSearch(context, args)),
  );
}

interface SearchArgs {
  start?: string;
  end?: string;
  categories?: string[];
  groups?: string[];
  payees?: string[];
  accounts?: string[];
  min_amount?: number;
  max_amount?: number;
  direction?: "outflow" | "inflow";
  text?: string;
  limit?: number;
}

function buildSearch(context: ToolContext, args: SearchArgs): Report {
  const { from, to } = dateRange(args.start, args.end);
  const filter: SearchFilter = {
    from,
    to,
    ...resolveFilters(context, args),
    // The cap is applied here rather than in the schema so a caller who asks for a thousand rows
    // gets the most we will send instead of a validation error about a number they guessed.
    limit: Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
  };
  if (args.min_amount !== undefined) filter.minAmount = milliunits(args.min_amount);
  if (args.max_amount !== undefined) filter.maxAmount = milliunits(args.max_amount);
  if (args.direction !== undefined) filter.direction = args.direction;
  if (args.text !== undefined) filter.text = args.text;

  const budgetId = context.budget.id;
  // Counted separately from the page: a capped answer that reported only what it showed would
  // understate the very thing the search was asked to size up.
  const totals = context.db.searchTotal(budgetId, filter);
  return {
    start: from,
    end: to,
    count: totals.count,
    sum: context.money(totals.sum),
    rows: context.db.searchLines(budgetId, filter).map((line) => render(context, line)),
  };
}

/** What a user says — 20, meaning twenty of their currency — in the milliunits YNAB stores. */
function milliunits(value: number): number {
  return Math.round(value * MILLIUNITS);
}

function render(context: ToolContext, line: TransactionLine): Report {
  const row: Report = { id: line.id };
  // Every key below is absent rather than null when the line has nothing for it: a null payee or
  // memo says nothing a missing key does not, and invites Claude to report "payee: none".
  if (line.parentId) row.parent_id = line.parentId;
  row.date = line.date;
  row.account = line.accountName;
  if (line.payeeName) row.payee = line.payeeName;
  if (line.categoryName) row.category = line.categoryName;
  if (line.categoryGroupName) row.group = line.categoryGroupName;
  if (line.memo) row.memo = line.memo;
  row.amount = context.money(line.amount);
  row.cleared = line.cleared;
  row.approved = line.approved;
  if (line.flagColor) row.flag = line.flagColor;
  return row;
}
