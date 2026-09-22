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

/** The cadences that repeat every `frequency` of one unit; 0 is YNAB's "none". */
const CADENCE_UNITS: Record<number, "week" | "month" | "year"> = { 1: "month", 2: "week", 13: "year" };

/**
 * How often a goal's target comes round, in the words `list_scheduled` uses for a schedule, or null
 * when it does not repeat. Without it a target is unreadable: 1,200 a year and 1,200 a month are the
 * same number. YNAB packs the period into two fields: cadence 1 (monthly), 2 (weekly) and 13
 * (yearly) repeat every `frequency` of that unit, 3 to 12 are every 2 to 11 months with the
 * frequency ignored, and 14 is every other year.
 */
export function goalCadence(cadence: number | null, frequency: number | null): string | null {
  const words = cadenceWords(cadence, frequency);
  // A code YNAB added after this was written: say so rather than drop the period without a word.
  return words === undefined ? `unrecognised cadence ${cadence}` : words;
}

/**
 * Whether `goalCadence` has words for a cadence code. Exported so the live test can check that every
 * cadence a real budget carries is known here, without depending on how the fallback is worded.
 */
export function isKnownCadence(cadence: number | null): boolean {
  return cadenceWords(cadence, null) !== undefined;
}

/** `goalCadence`'s words: null when the target does not repeat, undefined for a code not known here. */
function cadenceWords(cadence: number | null, frequency: number | null): string | null | undefined {
  if (cadence === null || cadence === 0) return null;
  if (cadence >= 3 && cadence <= 12) return every(cadence - 1, "month");
  if (cadence === 14) return every(2, "year");
  const unit = CADENCE_UNITS[cadence];
  return unit ? every(Math.max(1, frequency ?? 1), unit) : undefined;
}

function every(count: number, unit: "week" | "month" | "year"): string {
  if (count === 1) return { week: "weekly", month: "monthly", year: "yearly" }[unit];
  if (count === 2) return `every other ${unit}`;
  return `every ${count} ${unit}s`;
}

const description = `List the budget's category groups and the categories inside them: what exists, and what each one is for. Call it when what someone says ("the car", "fun money") may not be a category's name; the other tools already take names, whole or a unique part.

Each category carries its \`id\`, \`name\`, the owner's \`note\` when there is one, and its \`goal\` when it has one: a humanized \`type\` (target balance, target balance by date, monthly funding, plan your spending, debt payoff), the \`target\` amount, a \`target_date\` where it has one, and \`snoozed: true\` when YNAB is not asking for it to be funded. A target that repeats carries its \`cadence\` (weekly, monthly, yearly, every 3 months…) and is per that period: 1,200 yearly is 100 a month, not 1,200. A plan-your-spending goal also carries \`next_period\`: \`set aside another\` asks for the whole target again each period, \`refill up to\` only for what tops the balance back up.

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
  if (category.goalType) {
    const goal: Report = { type: GOAL_TYPES[category.goalType] ?? category.goalType };
    if (category.goalTarget !== null) goal.target = context.money(category.goalTarget);
    const cadence = goalCadence(category.goalCadence, category.goalCadenceFrequency);
    if (cadence) goal.cadence = cadence;
    if (category.goalNeedsWholeAmount !== null) goal.next_period = category.goalNeedsWholeAmount ? "set aside another" : "refill up to";
    if (category.goalTargetDate) goal.target_date = category.goalTargetDate;
    if (category.goalSnoozedAt) goal.snoozed = true;
    rendered.goal = goal;
  }
  if (category.hidden) rendered.hidden = true;
  return rendered;
}
