import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MonthCategoryDetail, MonthDetail } from "../cache/db.js";
import type { BudgetStore } from "../cache/store.js";
import { ALPHABETICAL_ORDER, REFRESH, respond, SHARED_NOTES, ToolError, type Report, type ToolContext } from "./envelope.js";

const description = `Report one month of the budget: how much came in, how much was assigned, what was spent, and what is still available in each category. This is the tool for "how are we doing this month?" and for "how much is left for groceries?".

The header carries \`income\`, \`assigned\`, \`activity\` (spending, so normally negative), \`ready_to_assign\` (money with no job yet), \`age_of_money\` and the month's \`note\` when it has one. Categories nest under their group, and each group carries its own \`assigned\`, \`activity\` and \`available\` subtotals, already added up: the rows sum to the subtotals and the subtotals to the header, so an answer reconciles without doing the arithmetic. \`underfunded\` on a category is what YNAB still wants assigned to it this month to stay on track with its goal.

Categories that are zero on all three figures are left out and counted in \`categories_omitted\`; a category hidden in YNAB still appears when it has figures, marked \`hidden\`. Past and future months both work: a month outside the budget's history is an error naming the range, and one YNAB has not filled in yet reports zeroes with a \`status\` saying so.

${SHARED_NOTES} ${ALPHABETICAL_ORDER}`;

export function registerGetMonth(server: McpServer, store: BudgetStore): void {
  server.registerTool(
    "get_month",
    {
      title: "Get a YNAB month",
      description,
      inputSchema: {
        month: z.string().optional().describe("The month as `YYYY-MM` (a `YYYY-MM-01` date is accepted too). Defaults to the current month."),
        refresh: z.boolean().optional().describe(REFRESH),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ month, refresh }) => respond(store, { force: refresh === true }, (context) => buildMonth(context, month)),
  );
}

/** `YYYY-MM-01`, the key months are stored under. Throws a `ToolError` on anything unreadable. */
function monthKey(input: string | undefined): string {
  if (input === undefined) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  }
  const match = /^(\d{4})-(\d{2})(?:-01)?$/.exec(input.trim());
  const monthNumber = match ? Number(match[2]) : 0;
  if (!match || monthNumber < 1 || monthNumber > 12) {
    throw new ToolError(`"${input}" is not a month. Use YYYY-MM, for example 2026-09.`);
  }
  return `${match[1]}-${match[2]}-01`;
}

async function buildMonth(context: ToolContext, requested: string | undefined): Promise<Report> {
  const key = monthKey(requested);
  let detail = context.db.monthDetail(context.budget.id, key);
  if (!detail) {
    // A month before the budget's first is a mistake worth naming straight away: that bound never
    // moves earlier. A month past its last is what a rollover looks like — the cached `lastMonth`
    // predates the sync — so pull from YNAB once and only then judge the range, against the
    // bounds that sync returned. Judging first would refuse the very month the retry exists for.
    if (context.budget.firstMonth && key < context.budget.firstMonth) outOfRange(context, key);
    await context.resync();
    detail = context.db.monthDetail(context.budget.id, key);
    if (!detail && context.budget.lastMonth && key > context.budget.lastMonth) outOfRange(context, key);
  }
  return detail ? render(context, detail) : empty(context, key);
}

/** Names the budget's real range, so "no data" is never mistaken for "you asked wrong". */
function outOfRange(context: ToolContext, key: string): never {
  const { firstMonth, lastMonth } = context.budget;
  throw new ToolError(
    `No data for ${key.slice(0, 7)}. This budget covers ${firstMonth?.slice(0, 7) ?? "?"} to ${lastMonth?.slice(0, 7) ?? "?"}.`,
  );
}

/**
 * A month YNAB has not filled in yet: real zeroes, said out loud, never a silent empty report.
 * The sentence goes under `status`, not `note`: `note` is the budget owner's own month note, and
 * one key cannot mean both their words and ours.
 */
function empty(context: ToolContext, key: string): Report {
  return {
    month: key.slice(0, 7),
    income: context.money(0),
    assigned: context.money(0),
    activity: context.money(0),
    ready_to_assign: context.money(0),
    status: `YNAB has no data for ${key.slice(0, 7)} yet.`,
    categories_omitted: 0,
    groups: [],
  };
}

function render(context: ToolContext, detail: MonthDetail): Report {
  const shown = detail.categories.filter((c) => c.budgeted !== 0 || c.activity !== 0 || c.balance !== 0);

  // Subtotals are summed in milliunits and rendered once, so they cannot drift from the rows.
  const groups: { name: string; rows: MonthCategoryDetail[] }[] = [];
  for (const category of shown) {
    const last = groups.at(-1);
    if (last?.name === category.groupName) last.rows.push(category);
    else groups.push({ name: category.groupName, rows: [category] });
  }

  const body: Report = {
    month: detail.month.slice(0, 7),
    income: context.money(detail.income),
    assigned: context.money(detail.budgeted),
    activity: context.money(detail.activity),
    ready_to_assign: context.money(detail.toBeBudgeted),
  };
  if (detail.ageOfMoney !== null) body.age_of_money = detail.ageOfMoney;
  if (detail.note) body.note = detail.note;
  body.categories_omitted = detail.categories.length - shown.length;
  body.groups = groups.map((group) => ({
    name: group.name,
    assigned: context.money(sum(group.rows, (c) => c.budgeted)),
    activity: context.money(sum(group.rows, (c) => c.activity)),
    available: context.money(sum(group.rows, (c) => c.balance)),
    categories: group.rows.map((category) => renderCategory(context, category)),
  }));
  return body;
}

function renderCategory(context: ToolContext, category: MonthCategoryDetail): Report {
  const rendered: Report = {
    name: category.name,
    assigned: context.money(category.budgeted),
    activity: context.money(category.activity),
    available: context.money(category.balance),
  };
  if (category.goalUnderFunded) rendered.underfunded = context.money(category.goalUnderFunded);
  if (category.hidden) rendered.hidden = true;
  return rendered;
}

function sum(rows: MonthCategoryDetail[], pick: (row: MonthCategoryDetail) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}
