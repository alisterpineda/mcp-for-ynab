import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AccountRow } from "../cache/db.js";
import type { BudgetStore } from "../cache/store.js";
import { ALPHABETICAL_ORDER, respond, SHARED_NOTES, type Report, type ToolContext } from "./envelope.js";

const description = `List the budget's accounts and what is in them: where the money actually sits. Accounts are split the way YNAB splits them — \`on_budget\` for the accounts whose money is being budgeted (chequing, savings, cash, credit cards) and \`tracking\` for the ones that are only watched (loans, mortgages, investments). Each section carries its own \`total\`, and \`net_worth\` is the two added together.

Each account carries \`balance\` (what YNAB shows), \`cleared_balance\` (what has actually settled) and \`uncleared_balance\` (recent activity that has not, omitted when it is zero), plus \`last_reconciled_at\` and a \`note\` when they are set. Use the difference between cleared and uncleared to answer whether recent spending has hit the bank yet.

Closed accounts are left out and counted in \`closed_omitted\`; pass \`include_closed: true\` to see them, marked \`closed\`. The section totals and \`net_worth\` always cover open accounts only, whether or not the closed ones are listed.

${SHARED_NOTES} ${ALPHABETICAL_ORDER}`;

export function registerListAccounts(server: McpServer, store: BudgetStore): void {
  server.registerTool(
    "list_accounts",
    {
      title: "List YNAB accounts",
      description,
      inputSchema: {
        include_closed: z.boolean().optional().describe("Include closed accounts, marked `closed`. They never count towards the totals."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ include_closed }) => respond(store, {}, (context) => buildAccounts(context, { includeClosed: include_closed === true })),
  );
}

function buildAccounts(context: ToolContext, options: { includeClosed: boolean }): Report {
  const { accounts, closedOmitted } = context.db.accountRows(context.budget.id, { includeClosed: options.includeClosed });
  const onBudget = accounts.filter((a) => a.onBudget);
  const tracking = accounts.filter((a) => !a.onBudget);
  // Totals are summed in milliunits and rendered once, so rounding cannot drift from the rows.
  const total = (rows: AccountRow[]): number => rows.reduce((sum, a) => (a.closed ? sum : sum + a.balance), 0);

  const section = (rows: AccountRow[]) => ({
    total: context.money(total(rows)),
    accounts: rows.map((account) => renderAccount(context, account)),
  });

  return {
    on_budget: section(onBudget),
    tracking: section(tracking),
    net_worth: context.money(total(accounts)),
    closed_omitted: closedOmitted,
  };
}

function renderAccount(context: ToolContext, account: AccountRow): Report {
  const rendered: Report = {
    id: account.id,
    name: account.name,
    type: account.type,
    balance: context.money(account.balance),
    cleared_balance: context.money(account.clearedBalance),
  };
  if (account.unclearedBalance !== 0) rendered.uncleared_balance = context.money(account.unclearedBalance);
  if (account.lastReconciledAt) rendered.last_reconciled_at = account.lastReconciledAt;
  if (account.note) rendered.note = account.note;
  if (account.closed) rendered.closed = true;
  return rendered;
}
