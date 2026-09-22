/**
 * Print the spending breakdown per month, straight from the on-disk cache, so the maintainer can
 * compare the numbers to YNAB's own Spending report by hand. This is not a test and asserts
 * nothing: it is the manual half of "the total equals what YNAB shows", run after changes to the
 * spending rule. It never syncs and never writes, so it is safe to run against the real cache.
 *
 *   node --import tsx scripts/reconcile-spending.ts [--from YYYY-MM] [--to YYYY-MM] [--budget <id>]
 *
 * The range defaults to the last three months ending at the current month, and the budget to the
 * active one. `YNAB_MCP_CACHE_DIR` moves the cache, exactly as it does for the server.
 *
 * One caveat the reader should know: opening the cache is what every entry point does, and a cache
 * written by a different schema is dropped and refilled rather than migrated. So running this
 * against a stale cache empties it, and the next server sync refills it — nothing is lost that a
 * sync cannot fetch again, but the script cannot report numbers until that sync has happened.
 */

import { BudgetDb, isSynced } from "../src/cache/db.js";
import { decimalsOf, moneyFormatter } from "../src/format/money.js";
import { dateRange, monthWindow } from "../src/tools/dates.js";

main();

function main(): void {
  const options = attempt(() => parseArguments(process.argv.slice(2)));

  const db = new BudgetDb();
  try {
    const budgetId = options.budgetId ?? db.activeBudgetId();
    if (!budgetId) {
      const known = db.budgetRows().filter(isSynced);
      const hint = known.length === 0
        ? `The cache at ${db.path} holds no synced budget. Run the server once so it syncs.`
        : `Pass --budget <id>: ${known.map((row) => `${row.name} (${row.id})`).join(", ")}.`;
      fail(`No active budget in the cache. ${hint}`);
    }
    const budget = db.budgetRow(budgetId);
    if (!budget) fail(`No budget ${budgetId} in the cache at ${db.path}.`);
    if (!isSynced(budget)) fail(`The budget ${budget.name} (${budgetId}) has never been synced, so there is nothing to reconcile.`);

    const months = attempt(() => monthWindow(3, options.from, options.to));
    const money = moneyFormatter(decimalsOf(budget.currencyFormat));
    const decimals = decimalsOf(budget.currencyFormat);
    const amount = (milliunits: number): string => money(milliunits).toFixed(decimals);

    console.log(`Budget: ${budget.name} (${budgetId})`);
    console.log(`Cache:  ${db.path}, last synced ${budget.lastSyncedAt}`);
    console.log(`Months: ${months[0]} to ${months[months.length - 1]} (amounts are spending, so a refund shows negative)`);

    for (const month of months) {
      const range = dateRange(month, month);
      const rows = db.spendingBy(budgetId, "category", range);
      const total = db.spendingTotal(budgetId, range);
      const excluded = db.spendingExclusions(budgetId, range);

      console.log(`\n${month}  (${range.from} to ${range.to})`);
      if (rows.length === 0) console.log("  (no spending lines)");
      for (const row of rows) {
        const name = `${row.groupName ?? "(unknown group)"} / ${row.name}${row.hidden ? " [hidden]" : ""}`;
        console.log(`  ${name.padEnd(48)} ${amount(-row.spent).padStart(12)}  (${row.count})`);
      }
      console.log(`  ${"TOTAL".padEnd(48)} ${amount(-total.spent).padStart(12)}  (${total.count} lines)`);
      console.log(`  excluded: ${excluded.transfers} transfers, ${excluded.tracking} tracking, ${excluded.inflows} inflows`);
    }
  } finally {
    db.close();
  }
}

interface Options {
  from?: string;
  to?: string;
  budgetId?: string;
}

function parseArguments(argv: string[]): Options {
  const options: Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--from" || flag === "--to" || flag === "--budget") {
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
      if (flag === "--from") options.from = value;
      else if (flag === "--to") options.to = value;
      else options.budgetId = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument "${flag}". Usage: reconcile-spending.ts [--from YYYY-MM] [--to YYYY-MM] [--budget <id>]`);
    }
  }
  return options;
}

/** A bad argument is a mistake at the keyboard, so report it as a sentence rather than a stack. */
function attempt<T>(produce: () => T): T {
  try {
    return produce();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
