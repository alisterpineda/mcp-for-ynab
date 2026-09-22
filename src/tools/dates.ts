import { ToolError } from "./envelope.js";

/**
 * The date vocabulary every spending tool shares. A user says "March" or "March 3 to 17" and means
 * the same kind of thing; both ends are always inclusive, and "today" is the machine's local date,
 * because that is the day the person asking is living in.
 */

const FORMS = "Use YYYY-MM-DD for a day or YYYY-MM for a whole month";

/**
 * The most months one report covers. A window is materialised month by month, and each month
 * becomes rows in the response, so an unbounded one is a way to fill memory from a single call.
 */
export const MAX_MONTHS = 120;

/** An inclusive ISO date range: what every spending query filters on. */
export interface DateRange {
  from: string;
  to: string;
}

/**
 * `start` and `end` as the user gave them, widened to whole days. A month `start` becomes its first
 * day and a month `end` its last, so "2026-03" on either end covers all of March. `end` defaults to
 * today and `start` to the first of today's month — the common question, asked with no parameters.
 */
export function dateRange(start?: string, end?: string, today: Date = new Date()): DateRange {
  const from = start === undefined ? `${localMonth(today)}-01` : edge(start, "start", "first");
  const to = end === undefined ? localDate(today) : edge(end, "end", "last");
  if (from > to) throw new ToolError(`The start ${from} is after the end ${to}.`);
  return { from, to };
}

/** Today's month, `YYYY-MM`, read locally: the month whose figures are still moving. */
export function currentMonth(today: Date = new Date()): string {
  return localMonth(today);
}

/**
 * The `YYYY-MM` keys a monthly report covers, chronologically. An explicit `start` or `end` wins
 * over `months`, which otherwise counts back from the end (default six, ending at this month).
 */
export function monthWindow(months?: number, start?: string, end?: string, today: Date = new Date()): string[] {
  const last = end === undefined ? localMonth(today) : monthKey(end, "end");
  const span = months !== undefined && months > 0 ? Math.floor(months) : 6;
  if (span > MAX_MONTHS) throw new ToolError(`${span} months is more than one report covers; ask for at most ${MAX_MONTHS}.`);
  const first = start === undefined ? shiftMonth(last, 1 - span) : monthKey(start, "start");
  if (first > last) throw new ToolError(`The start ${first} is after the end ${last}.`);

  // Counted, not compared: a string comparison runs past a five-digit year, and the cap has to be
  // known before anything is built.
  const length = monthIndex(last) - monthIndex(first) + 1;
  if (length > MAX_MONTHS) {
    throw new ToolError(`${first} to ${last} is ${length} months, more than one report covers; ask for at most ${MAX_MONTHS}.`);
  }
  const keys: string[] = [];
  for (let key = first, i = 0; i < length; key = shiftMonth(key, 1), i += 1) keys.push(key);
  return keys;
}

/**
 * The first month the budget has anything in, `YYYY-MM`: its first budget month, or the month of an
 * earlier transaction when one predates it. Null for a budget with neither. A monthly series starts
 * here at the earliest, because a month before it would read as spending nothing when it is really
 * a month with no budget at all — and a zero like that drags an average down.
 */
export function historyStart(firstMonth: string | null, earliestDate: string | null): string | null {
  const months = [firstMonth, earliestDate].filter((value): value is string => value !== null).map((value) => value.slice(0, 7));
  return months.length === 0 ? null : months.reduce((a, b) => (a < b ? a : b));
}

/** A window of months a monthly report can show: begun, and inside the budget's history. */
export interface HistoryWindow {
  /** `YYYY-MM` keys, chronologically, never empty. */
  months: string[];
  /** The first day of the first month and the last day of the last: the range the lines are read over. */
  from: string;
  to: string;
  /** True when the window asked for reached back before the budget and was cut at its first month. */
  cut: boolean;
  /** The current month when the window holds it, since its figures are still moving. */
  partialMonth: string | null;
}

/**
 * The months asked for, cut to the ones a report can show without inventing any. A window past the
 * current month is refused: a month that has not started would read as a month of zeroes. For the
 * same reason one reaching back before `floor` — the budget's first month, from `historyStart` —
 * starts there instead and says so through `cut`, and one wholly before it is refused, naming where
 * the history starts.
 */
export function historyWindow(asked: string[], floor: string | null, today: Date = new Date()): HistoryWindow {
  const last = asked[asked.length - 1];
  const current = currentMonth(today);
  if (last > current) {
    throw new ToolError(`The window ends at ${last}, after the current month ${current}; nothing has happened there yet.`);
  }
  const months = floor === null ? asked : asked.filter((month) => month >= floor);
  if (months.length === 0) {
    throw new ToolError(`The budget's history starts at ${floor}, after the window's end ${last}; there is nothing to report there.`);
  }
  // The months are whole, so the range is the first day of the first to the last day of the last.
  const { from, to } = dateRange(months[0], last, today);
  return { months, from, to, cut: months.length < asked.length, partialMonth: months.includes(current) ? current : null };
}

/** One end of a range, as a full ISO day. A month widens outwards, to the edge the end asks for. */
function edge(input: string, which: "start" | "end", side: "first" | "last"): string {
  const value = input.trim();
  const asMonth = /^(\d{4})-(\d{2})$/.exec(value);
  if (asMonth) {
    const [year, month] = [Number(asMonth[1]), Number(asMonth[2])];
    checkMonth(input, which, month);
    return side === "first" ? `${asMonth[1]}-${asMonth[2]}-01` : `${asMonth[1]}-${asMonth[2]}-${String(daysIn(year, month)).padStart(2, "0")}`;
  }

  const asDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!asDay) throw new ToolError(`"${input}" is not a ${which} date. ${FORMS}.`);
  const [year, month, day] = [Number(asDay[1]), Number(asDay[2]), Number(asDay[3])];
  checkMonth(input, which, month);
  if (day < 1 || day > daysIn(year, month)) {
    throw new ToolError(`"${input}" is not a real date: ${asDay[1]}-${asDay[2]} has ${daysIn(year, month)} days. ${FORMS}.`);
  }
  return value;
}

/** A `YYYY-MM` key for a month-granular parameter; a full date is accepted and truncated. */
function monthKey(input: string, which: "start" | "end"): string {
  const value = input.trim();
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value);
  if (!match) throw new ToolError(`"${input}" is not a ${which} month. Use YYYY-MM, for example 2026-09.`);
  checkMonth(input, which, Number(match[2]));
  return `${match[1]}-${match[2]}`;
}

function checkMonth(input: string, which: "start" | "end", month: number): void {
  if (month < 1 || month > 12) throw new ToolError(`"${input}" is not a real ${which} date: there is no month ${month}. ${FORMS}.`);
}

function daysIn(year: number, month: number): number {
  // Day zero of the next month is the last day of this one, and the Date constructor knows leap years.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A month's position on one number line, so two keys can be subtracted. */
function monthIndex(key: string): number {
  const [year, month] = key.split("-").map(Number);
  return year * 12 + month;
}

function shiftMonth(key: string, by: number): string {
  const [year, month] = key.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + by, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function localMonth(today: Date): string {
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
}

function localDate(today: Date): string {
  return `${localMonth(today)}-${String(today.getDate()).padStart(2, "0")}`;
}
