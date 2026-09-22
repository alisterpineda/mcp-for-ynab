import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ScheduledLine, ScheduledRow } from "../cache/db.js";
import type { BudgetStore } from "../cache/store.js";
import { respond, SHARED_NOTES, type Report, type ToolContext } from "./envelope.js";

/** A YNAB frequency code in words a person uses, and how many times a year it fires. */
interface Frequency {
  words: string;
  /** Absent for `never`, a one-off with no rate. */
  perYear?: number;
}

/**
 * Every frequency YNAB schedules, in one table so the words and the rate cannot drift apart. A
 * month is a twelfth of `perYear`, so a weekly bill is 52/12 of itself a month: the calendar's own
 * count, not an average month of 4.33 weeks rounded somewhere else.
 */
export const FREQUENCIES: Record<string, Frequency> = {
  never: { words: "once" },
  daily: { words: "daily", perYear: 365 },
  weekly: { words: "weekly", perYear: 52 },
  everyOtherWeek: { words: "every other week", perYear: 26 },
  twiceAMonth: { words: "twice a month", perYear: 24 },
  every4Weeks: { words: "every 4 weeks", perYear: 13 },
  monthly: { words: "monthly", perYear: 12 },
  everyOtherMonth: { words: "every other month", perYear: 6 },
  every3Months: { words: "every 3 months", perYear: 4 },
  every4Months: { words: "every 4 months", perYear: 3 },
  twiceAYear: { words: "twice a year", perYear: 2 },
  yearly: { words: "yearly", perYear: 1 },
  everyOtherYear: { words: "every other year", perYear: 0.5 },
};

const RATES = Object.values(FREQUENCIES)
  .filter((f) => f.perYear !== undefined)
  .map((f) => `${f.words} ${f.perYear}`)
  .join(", ");

const SCOPE = `\`per_month\` is the amount times the frequency's occurrences a year (${RATES}) divided by twelve; a one-off has none. \`outflow_per_month\` adds up the recurring outflows on on-budget accounts, leaving out transfers to another on-budget account, which move money rather than spend it; a split is counted line by line, so only its lines that move money are left out. \`inflow_per_month\` does the same for money coming in. YNAB keeps a scheduled transfer on one account only, so one entered on a tracking account is not counted even when it moves money into the budget.`;

const description = `What is coming up: every scheduled transaction in the budget, soonest first, with what it will cost a month. This is the tool for "what bills are due before payday?", "what are my fixed monthly costs?" and "when is the next mortgage payment?".

Each row carries \`id\`, \`date_next\`, \`frequency\` in words (monthly, every other week, once…), \`account\`, \`amount\` with YNAB's sign (a bill is negative, a paycheque positive), and \`payee\`, \`category\`, \`group\`, \`memo\` and \`flag\` when it has them. A transfer names the account it moves money to as \`transfer_to\`. A split carries its \`lines\`, each with its own category and amount, and the row's \`amount\` is the whole. A recurring row carries \`per_month\`. ${SCOPE} Rows are ordered by \`date_next\` ascending, so the first rows are what is due soonest.

This lists what YNAB will post, not what it has posted: once a scheduled transaction's date arrives it becomes an ordinary transaction and \`search_transactions\` finds it. The list is short enough to return whole, so filter it by reading it.

${SHARED_NOTES}`;

export function registerListScheduled(server: McpServer, store: BudgetStore): void {
  server.registerTool(
    "list_scheduled",
    {
      title: "List scheduled YNAB transactions",
      description,
      inputSchema: {
        refresh: z.boolean().optional().describe("Pull the latest changes from YNAB before reporting, even if the cache is recent."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ refresh }) => respond(store, { force: refresh === true }, (context) => buildScheduled(context)),
  );
}

function buildScheduled(context: ToolContext): Report {
  const rows = context.db.scheduledRows(context.budget.id);
  // Summed in milliunits and rendered once, so the totals cannot drift from the rows.
  let outflow = 0;
  let inflow = 0;
  for (const row of rows) {
    const perYear = FREQUENCIES[row.frequency]?.perYear;
    if (perYear === undefined || !row.accountOnBudget) continue;
    // A split's transfers live on its lines, not on the parent, so a split is counted line by line.
    const parts = row.lines.length > 0 ? row.lines : [row];
    for (const part of parts) {
      if (part.transferAccountOnBudget === true) continue;
      const monthly = (part.amount * perYear) / 12;
      if (monthly < 0) outflow -= monthly;
      else inflow += monthly;
    }
  }
  return {
    count: rows.length,
    scope: SCOPE,
    outflow_per_month: context.money(outflow),
    inflow_per_month: context.money(inflow),
    rows: rows.map((row) => render(context, row)),
  };
}

/** The row's monthly rate in milliunits, signed like the amount; null for a one-off. */
function perMonth(row: ScheduledRow): number | null {
  const perYear = FREQUENCIES[row.frequency]?.perYear;
  return perYear === undefined ? null : (row.amount * perYear) / 12;
}

function render(context: ToolContext, row: ScheduledRow): Report {
  const rendered: Report = { id: row.id, date_next: row.dateNext, frequency: FREQUENCIES[row.frequency]?.words ?? row.frequency };
  rendered.account = row.accountName;
  if (row.payeeName) rendered.payee = row.payeeName;
  if (row.categoryName) rendered.category = row.categoryName;
  if (row.categoryGroupName) rendered.group = row.categoryGroupName;
  if (row.transferAccountName) rendered.transfer_to = row.transferAccountName;
  if (row.memo) rendered.memo = row.memo;
  if (row.flagColor) rendered.flag = row.flagColor;
  rendered.amount = context.money(row.amount);
  const monthly = perMonth(row);
  if (monthly !== null) rendered.per_month = context.money(monthly);
  if (row.lines.length > 0) rendered.lines = row.lines.map((line) => renderLine(context, line));
  return rendered;
}

function renderLine(context: ToolContext, line: ScheduledLine): Report {
  const rendered: Report = { id: line.id };
  if (line.payeeName) rendered.payee = line.payeeName;
  if (line.categoryName) rendered.category = line.categoryName;
  if (line.categoryGroupName) rendered.group = line.categoryGroupName;
  if (line.transferAccountName) rendered.transfer_to = line.transferAccountName;
  if (line.memo) rendered.memo = line.memo;
  rendered.amount = context.money(line.amount);
  return rendered;
}
