import type { BudgetDb, SyncedBudget } from "../cache/db.js";
import type { BudgetStore } from "../cache/store.js";
import { decimalsOf, moneyFormatter } from "../format/money.js";
import { stalenessWarning } from "../freshness.js";

/** What a tool body gets: the synced budget, the cache, money rendering, and a way to resync. */
export interface ToolContext {
  /**
   * The budget this response is about. Read it through the context every time rather than
   * destructuring it once: `resync` can re-point it, because a sync may adopt a new YNAB default
   * budget, and the id and currency precision change with it.
   */
  readonly budget: SyncedBudget;
  readonly db: BudgetDb;
  /** Milliunits rendered at the budget's precision. Re-made whenever `resync` changes the budget. */
  money(milliunits: number): number;
  /**
   * Force one sync now, so a rollover-shaped miss can be retried. Fails soft, like every sync,
   * and does nothing when this request has already been to YNAB.
   */
  resync(): Promise<void>;
}

/** What a tool body returns: the keys that go behind the envelope, and nothing else. */
export type Report = Record<string, unknown>;

/** A failure the tool itself diagnoses, reported as an `isError` result rather than thrown. */
export class ToolError extends Error {}

export interface TextResult {
  // The SDK's result type is an open record; the index signature keeps this assignable to it.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/**
 * The one decision about when to sync and how to fail: every tool goes through here, so the
 * "sync failed but a cache exists" behaviour cannot drift between them. A cache, however stale,
 * always wins over an error; only having neither is a failure worth reporting.
 */
export async function freshBudget(
  store: BudgetStore,
  options: { force?: boolean; fullResync?: boolean } = {},
): Promise<{ budget: SyncedBudget; error?: never } | { budget?: never; error: TextResult }> {
  try {
    return { budget: await store.ensureFresh({ force: options.force === true, full: options.fullResync === true }) };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { error: { isError: true, content: [{ type: "text", text: `No cached data and YNAB could not be reached: ${message}` }] } };
  }
}

/**
 * The shared shell around every data tool: it takes the budget from `freshBudget`, hands the body
 * a context, and merges what the body returns behind the envelope — budget name, currency,
 * precision, last successful sync, and a `warning` only when the most recent attempt failed.
 */
export async function respond(
  store: BudgetStore,
  options: { force?: boolean },
  body: (context: ToolContext) => Report | Promise<Report>,
): Promise<TextResult> {
  // One round-trip to YNAB per request: `freshBudget` above may already have synced (or just
  // failed to), and a body that then misses must not pay for a second identical attempt.
  const syncOnEntry = store.lastSync;
  const failureOnEntry = store.lastFailure;
  const fresh = await freshBudget(store, options);
  if (fresh.error) return fresh.error;
  let budget = fresh.budget;

  let money = moneyFormatter(decimalsOf(budget.currencyFormat));
  const context: ToolContext = {
    // A getter, not a value: `resync` below can replace the budget mid-request.
    get budget() {
      return budget;
    },
    db: store.db,
    money: (milliunits) => money(milliunits),
    resync: async () => {
      if (store.lastSync !== syncOnEntry || store.lastFailure !== failureOnEntry) return;
      const retried = await freshBudget(store, { force: true });
      // A failed resync is not fatal here: the cache that got us this far still answers.
      if (retried.budget) budget = retried.budget;
      money = moneyFormatter(decimalsOf(budget.currencyFormat));
    },
  };

  let result: Report;
  try {
    result = await body(context);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }

  const envelope: Record<string, unknown> = { budget: budget.name };
  const currency = budget.currencyFormat?.iso_code;
  if (currency) envelope.currency = currency;
  envelope.decimals = decimalsOf(budget.currencyFormat);
  envelope.as_of = budget.lastSyncedAt;
  const warning = stalenessWarning(store);
  if (warning) envelope.warning = warning;

  return { content: [{ type: "text", text: JSON.stringify({ ...envelope, ...result }) }] };
}

/**
 * The four facts every tool's description must state, because unsaid each one produces a
 * confidently wrong answer: what the numbers are, what the keys mean, where ids come from, and
 * that the row order is the tool's own. The ordering itself is stated per tool, since the
 * analysis tools each sort by something other than the name.
 *
 * Every description has to fit in 2,048 characters: Claude Code cuts a tool description there
 * without a word, and these notes come last, so they are the first thing lost. The server's
 * `instructions` would say them once, but Claude Desktop does not read that field. What belongs
 * to one parameter goes in that parameter's own description instead, which is not cut.
 */
export const SHARED_NOTES = `Amounts are plain numbers in the currency named by \`currency\` in the envelope, at its precision, with no symbol. Keys use YNAB's own words: \`assigned\` is Assigned, \`available\` is Available, \`ready_to_assign\` is Ready to Assign. Filters take names as well as ids; the ids come from \`list_categories\` and \`list_accounts\`, since \`get_month\` carries none. Each tool states its own row order, and none is YNAB's on-screen order, so never describe a row by its position unless that order gives it a meaning. \`as_of\` is the last sync from YNAB; a \`warning\` key means the latest sync failed and the figures come from the one before.`;

/** The `refresh` parameter of every report whose figures an edit in YNAB can move, worded once. */
export const REFRESH = "Pull the latest changes from YNAB before reporting, even if the cache is recent. Use it when the user says they just changed something in YNAB.";

/** The ordering the orientation tools share, appended after `SHARED_NOTES` by each of them. */
export const ALPHABETICAL_ORDER = `Everything is ordered alphabetically, which is not YNAB's on-screen order (\`list_accounts\` groups accounts by type first).`;
