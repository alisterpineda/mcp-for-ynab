import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CategoryTreeCategory } from "../cache/db.js";
import type { BudgetStore } from "../cache/store.js";
import { ALPHABETICAL_ORDER, respond, SHARED_NOTES, type Report, type ToolContext } from "./envelope.js";
import { GOAL_NOTE, renderGoal } from "./goals.js";

const description = `List the budget's category groups and the categories inside them: what exists, and what each one is for. Call it when what someone says ("the car", "fun money") may not be a category's name; the other tools already take names, whole or a unique part.

Each category carries its \`id\`, \`name\`, the owner's \`note\` when there is one, and its \`goal\` when it has one. ${GOAL_NOTE}

No money appears here and nothing month-dependent; ask \`get_month\` for assigned, available and activity. Hidden categories need \`include_hidden\`, and YNAB's internal ones ("Inflow: Ready to Assign", "Uncategorized") are never listed.

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
          .describe(
            "Part of a category or group name, case- and accent-insensitive. A group match returns that group's whole list (\"subscriptions\" gets every subscription). Notes are not searched; if nothing matches, try a shorter stem.",
          ),
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
  const goal = renderGoal(context, category);
  if (goal) rendered.goal = goal;
  if (category.hidden) rendered.hidden = true;
  return rendered;
}
