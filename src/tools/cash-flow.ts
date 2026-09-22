import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CashFlowMonth, FlowAggregate } from "../cache/db.js";
import type { BudgetStore } from "../cache/store.js";
import { dateRange, historyStart, historyWindow, MAX_MONTHS, monthWindow } from "./dates.js";
import { REFRESH, respond, SHARED_NOTES, type Report, type ToolContext } from "./envelope.js";

/** How many income sources are listed before the rest is summed into `income_sources_other`. */
const SOURCE_LIMIT = 25;

// Each figure's rule, worded once: `SCOPE` states them in the response, as `spending_breakdown` does
// for spending, and the description repeats them (it cannot carry `SCOPE` whole within 2,048
// characters), so the two cannot drift apart.
const INCOME = "every line on an on-budget account in Inflow: Ready to Assign";
const OPENING_BALANCES = "YNAB files a new account's positive starting balance there too, so an account opened in the window counts its balance as income and as saved";
const SPENT = "`spending_breakdown`'s total";
const SAVED = "income minus spent";

const SCOPE = `Income is ${INCOME}; ${OPENING_BALANCES}. Spent is ${SPENT}. Saved is ${SAVED}, which is exactly what the on-budget accounts grew by: transfers between them cancel out.`;

const description = `Are we saving, and how much? Month by month: \`income\`, \`spent\`, \`saved\` (${SAVED}) and \`savings_rate\` (saved as a percent of income). This is the tool for "what do we earn, spend and save in a typical month?".

\`income\` is ${INCOME}, so it can exceed \`get_month\`'s \`income\`, which leaves out some inflows that land on credit cards; ${OPENING_BALANCES}. \`spent\` is ${SPENT}, so money received into a spending category — a tax refund kept in its own category — lowers \`spent\` rather than raising \`income\`; \`saved\` is right either way. \`to_tracking_accounts\` is the part of \`spent\` that moved to tracking accounts — loan and mortgage payments, investment contributions — which stays in net worth: add it to \`saved\` for that reading.

Months come in chronological order, the current one flagged \`partial\`. \`total\`, \`average\` and \`median\` cover the complete months, as do \`income_sources\` (by payee, largest first; past 25 summed in \`income_sources_other\`) and \`tracking_accounts\` (most moved first). The averages add up; each median is its own column's, so the medians need not. The window is the last six months ending at the current one, starting no earlier than the budget (\`history_starts\`).

${SHARED_NOTES}`;

export function registerCashFlow(server: McpServer, store: BudgetStore): void {
  server.registerTool(
    "cash_flow",
    {
      title: "Compare YNAB income and spending",
      description,
      inputSchema: {
        months: z.number().int().positive().max(MAX_MONTHS).optional().describe(`How many months the window covers, ending at the current month. Defaults to 6, at most ${MAX_MONTHS}. For six complete months, set \`end\` to last month.`),
        start: z.string().optional().describe("First month of the window, `YYYY-MM`. Wins over `months`."),
        end: z.string().optional().describe("Last month of the window, `YYYY-MM`, inclusive. Wins over `months`; defaults to the current month and cannot be later."),
        include_partial: z.boolean().optional().describe("Count the current, unfinished month in `total`, `average`, `median`, `income_sources` and `tracking_accounts`. Off by default."),
        refresh: z.boolean().optional().describe(REFRESH),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ refresh, ...args }) => respond(store, { force: refresh === true }, (context) => buildCashFlow(context, args)),
  );
}

interface CashFlowArgs {
  months?: number;
  start?: string;
  end?: string;
  include_partial?: boolean;
}

/** One row's figures in milliunits, YNAB's sign: what every rendered row, total and statistic is made from. */
type Flow = Omit<CashFlowMonth, "month">;

function buildCashFlow(context: ToolContext, args: CashFlowArgs): Report {
  const budgetId = context.budget.id;
  const window = historyWindow(
    monthWindow(args.months, args.start, args.end),
    historyStart(context.budget.firstMonth, context.db.earliestDate(budgetId)),
  );
  const found = new Map(context.db.cashFlowByMonth(budgetId, { from: window.from, to: window.to }).map((row) => [row.month, row]));
  // A month with no lines is a month of zeroes, not a gap: the window is inside the budget's history.
  const rows = window.months.map((month) => found.get(month) ?? { month, income: 0, spent: 0, toTracking: 0 });
  const counted = rows.filter((row) => row.month !== window.partialMonth || args.include_partial === true);

  const body: Report = { start: window.months[0], end: window.months[window.months.length - 1] };
  if (window.cut) body.history_starts = window.months[0];
  if (window.partialMonth) body.partial_month = window.partialMonth;
  body.months = rows.map((row) => {
    const rendered: Report = { month: row.month, ...render(context, row) };
    if (row.month === window.partialMonth) rendered.partial = true;
    return rendered;
  });

  // With no complete month there is nothing honest to summarise, so the keys are absent, not zero.
  if (counted.length > 0) {
    const total = sumFlows(counted);
    body.total = render(context, total);
    body.average = render(context, averageOf(context, total, counted.length));
    body.median = medians(context, counted);

    // The partial month is always the window's last, so the counted months are one unbroken range.
    const { from, to } = dateRange(counted[0].month, counted[counted.length - 1].month);
    const sources = context.db.incomeBySource(budgetId, { from, to });
    body.income_sources = sources.slice(0, SOURCE_LIMIT).map((source) => renderAggregate(source, { income: context.money(source.amount) }));
    const cut = sources.slice(SOURCE_LIMIT);
    if (cut.length > 0) {
      body.income_sources_other = {
        sources: cut.length,
        count: cut.reduce((sum, source) => sum + source.count, 0),
        income: context.money(cut.reduce((sum, source) => sum + source.amount, 0)),
      };
    }
    body.tracking_accounts = context.db
      .trackingTransfers(budgetId, { from, to })
      .map((account) => renderAggregate(account, { spent: context.money(-account.amount) }));
  }
  body.scope = SCOPE;
  return body;
}

/**
 * A row as the response reads it: spending positive, the way a person says it, and `saved` derived
 * from the two figures shown beside it, so the row adds up exactly as printed.
 */
function render(context: ToolContext, flow: Flow): Report {
  const rendered = figures(context, { ...flow, saved: savedOf(flow) });
  // A rate of nothing earned is not zero or infinity; it is no rate, so the key is left out.
  if (flow.income > 0) rendered.savings_rate = percent(savingsRatio(flow));
  return rendered;
}

/** The four money figures under their response keys, spending turned positive for every row alike. */
function figures(context: ToolContext, flow: Flow & { saved: number }): Report {
  return {
    income: context.money(flow.income),
    spent: context.money(-flow.spent),
    to_tracking_accounts: context.money(-flow.toTracking),
    saved: context.money(flow.saved),
  };
}

/** What a row saved, in milliunits: its income less its spending. */
function savedOf(flow: Flow): number {
  return flow.income + flow.spent;
}

/** Saved as a fraction of income, unrounded. Only for a row with income. */
function savingsRatio(flow: Flow): number {
  return savedOf(flow) / flow.income;
}

/** An income source or a tracking account, with its figure under the key that says which it is. */
function renderAggregate(aggregate: FlowAggregate, figure: Report): Report {
  const rendered: Report = {};
  // Income with no payee has no entity behind it, so it has no id to hand back.
  if (aggregate.key !== null) rendered.id = aggregate.key;
  rendered.name = aggregate.name;
  Object.assign(rendered, figure);
  rendered.count = aggregate.count;
  rendered.months_active = aggregate.months;
  return rendered;
}

function sumFlows(rows: Flow[]): Flow {
  return rows.reduce(
    (sum, row) => ({ income: sum.income + row.income, spent: sum.spent + row.spent, toTracking: sum.toTracking + row.toTracking }),
    { income: 0, spent: 0, toTracking: 0 },
  );
}

/**
 * The average month. Each figure is rounded to the currency's precision before `saved` is derived
 * from them, so the average row adds up to the cent as printed: rounding the three separately could
 * leave `saved` a cent away from `income` minus `spent`.
 */
function averageOf(context: ToolContext, total: Flow, count: number): Flow {
  return {
    income: atPrecision(context, total.income / count),
    spent: atPrecision(context, total.spent / count),
    toTracking: atPrecision(context, total.toTracking / count),
  };
}

/**
 * Each column's own median over the counted months. Unlike the averages these do not add up — the
 * median month for income need not be the median month for spending — so `saved` is the median of
 * the months' savings, not the medians' difference, and `savings_rate` the median of their rates.
 */
function medians(context: ToolContext, rows: Flow[]): Report {
  const ratios = rows.filter((row) => row.income > 0).map(savingsRatio);
  const result = figures(context, {
    income: median(rows.map((row) => row.income)),
    spent: median(rows.map((row) => row.spent)),
    toTracking: median(rows.map((row) => row.toTracking)),
    saved: median(rows.map(savedOf)),
  });
  if (ratios.length > 0) result.savings_rate = percent(median(ratios));
  return result;
}

/** The middle value, or the mean of the two middle values. Never called with an empty list. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A ratio as a percentage to one decimal, rounded once from the unrounded ratio. */
function percent(ratio: number): number {
  return Math.round(ratio * 1000) / 10;
}

/** Milliunits rounded the way `money` renders them, so sums of them render exactly. */
function atPrecision(context: ToolContext, milliunits: number): number {
  return Math.round(context.money(milliunits) * 1000);
}
