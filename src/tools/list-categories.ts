import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CategoryTreeCategory } from "../cache/db.js";
import type { BudgetStore } from "../cache/store.js";
import { ALPHABETICAL_ORDER, respond, SHARED_NOTES, type Report, type ToolContext } from "./envelope.js";

/** YNAB's goal codes are opaque enough that a silent misreading is plausible; spell them out. */
const GOAL_TYPES: Record<string, string> = {
  TB: "target balance",
  TBD: "target balance by date",
  MF: "monthly funding",
  NEED: "plan your spending",
  DEBT: "debt payoff",
};

const description = `List the budget's category groups and the categories inside them: what exists, and what each one is for. This is how you turn what someone says ("groceries", "the car") into the real category YNAB holds, and it is where category ids come from. Call it before any question about a particular category.

Each category carries its \`id\`, its \`name\`, the owner's own \`note\` when there is one, and its \`goal\` when it has one — a humanized \`type\` (target balance, target balance by date, monthly funding, plan your spending, debt payoff), the \`target\` amount, a \`target_date\` where the goal has one, and \`snoozed: true\` when YNAB is not currently asking for the goal to be funded.

Use \`search\` to narrow the list: it matches part of a category name or part of a group name, ignoring case and accents, and a group-name match returns that whole group (so "subscriptions" gets every subscription in one call). Notes are not searched. If a search finds nothing, try a shorter stem.

This tool is deliberately month-independent: no assigned, available, activity or goal-progress figures appear here. Ask \`get_month\` for those. Hidden categories are left out unless \`include_hidden\` is set, and YNAB's internal categories ("Inflow: Ready to Assign", "Uncategorized") are never listed.

${SHARED_NOTES} ${ALPHABETICAL_ORDER}`;

export function registerListCategories(server: McpServer, store: BudgetStore): void {
  server.registerTool(
    "list_categories",
    {
      title: "List YNAB categories",
      description,
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Part of a category or group name, case- and accent-insensitive. A group match returns that group's whole list."),
        include_hidden: z.boolean().optional().describe("Include categories hidden in YNAB, marked `hidden`."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ search, include_hidden }) =>
      respond(store, {}, (context) => buildCategories(context, { search, includeHidden: include_hidden === true })),
  );
}

function buildCategories(context: ToolContext, options: { search?: string; includeHidden: boolean }): Report {
  const groups = context.db.categoryTree(context.budget.id, options);
  return {
    groups: groups.map((group) => ({
      name: group.name,
      categories: group.categories.map((category) => renderCategory(context, category)),
    })),
  };
}

function renderCategory(context: ToolContext, category: CategoryTreeCategory): Report {
  const rendered: Report = { id: category.id, name: category.name };
  if (category.note) rendered.note = category.note;
  if (category.goalType) {
    const goal: Report = { type: GOAL_TYPES[category.goalType] ?? category.goalType };
    if (category.goalTarget !== null) goal.target = context.money(category.goalTarget);
    if (category.goalTargetDate) goal.target_date = category.goalTargetDate;
    if (category.goalSnoozedAt) goal.snoozed = true;
    rendered.goal = goal;
  }
  if (category.hidden) rendered.hidden = true;
  return rendered;
}
