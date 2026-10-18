import type { GoalFields } from "../cache/db.js";
import type { Report, ToolContext } from "./envelope.js";

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

/** What a `goal` key says, worded once for every tool that carries one. */
export const GOAL_NOTE = `\`goal\` is the category's target when it has one: a humanized \`type\` (target balance, target balance by date, monthly funding, plan your spending, debt payoff), the \`target\` amount, a \`target_date\` where it has one, and \`snoozed: true\` when YNAB is not asking for it to be funded. A target that repeats carries its \`cadence\` (weekly, monthly, yearly, every 3 months…) and is per that period: 1,200 yearly is 100 a month, not 1,200. A plan-your-spending goal also carries \`next_period\`: \`set aside another\` asks for the whole target again each period, \`refill up to\` only for what tops the balance back up.`;

/**
 * A category's goal as the response shows it, or null when it has none. One rendering for every
 * tool, so a target reads the same beside a category's definition and beside its months.
 */
export function renderGoal(context: ToolContext, category: GoalFields): Report | null {
  if (!category.goalType) return null;
  const goal: Report = { type: GOAL_TYPES[category.goalType] ?? category.goalType };
  if (category.goalTarget !== null) goal.target = context.money(category.goalTarget);
  const cadence = goalCadence(category.goalCadence, category.goalCadenceFrequency);
  if (cadence) goal.cadence = cadence;
  if (category.goalNeedsWholeAmount !== null) goal.next_period = category.goalNeedsWholeAmount ? "set aside another" : "refill up to";
  if (category.goalTargetDate) goal.target_date = category.goalTargetDate;
  if (category.goalSnoozedAt) goal.snoozed = true;
  return goal;
}
