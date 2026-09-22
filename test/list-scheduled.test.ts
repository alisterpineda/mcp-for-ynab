import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ScheduledTransaction } from "../src/ynab/types.js";
import { FREQUENCIES } from "../src/tools/list-scheduled.js";
import { BUDGET_ID, scheduledBudget, scheduledSubtransaction, scheduledTransaction, spendingBudget } from "./fixtures.js";
import { harness } from "./mcp.js";

interface Row {
  id: string;
  date_next: string;
  frequency: string;
  account: string;
  payee?: string;
  category?: string;
  group?: string;
  transfer_to?: string;
  memo?: string;
  flag?: string;
  amount: number;
  per_month?: number;
  lines?: Record<string, unknown>[];
}

const rowsOf = (body: Record<string, unknown>): Row[] => body.rows as Row[];
const byId = (body: Record<string, unknown>, id: string): Row => {
  const row = rowsOf(body).find((r) => r.id === id);
  assert.ok(row, `a row ${id}, got ${rowsOf(body).map((r) => r.id).join(", ")}`);
  return row;
};

const scheduled = () => harness({ budget: scheduledBudget() });

describe("list_scheduled", () => {
  it("returns every scheduled transaction soonest first", async () => {
    await using h = await scheduled();
    const body = await h.json("list_scheduled");
    assert.equal(body.count, 7);
    const dates = rowsOf(body).map((r) => r.date_next);
    assert.deepEqual(dates, [...dates].sort());
    assert.equal(rowsOf(body)[0].id, "sch-groceries");
  });

  it("renders a row the way YNAB will post it, in words, dropping what it does not have", async () => {
    await using h = await scheduled();
    const body = await h.json("list_scheduled");
    assert.deepEqual(byId(body, "sch-groceries"), {
      id: "sch-groceries",
      date_next: "2026-09-26",
      frequency: "weekly",
      account: "Chequing",
      payee: "Costco",
      category: "Groceries",
      group: "Everyday",
      memo: "weekly shop",
      flag: "blue",
      amount: -80,
      // 80 × 52 / 12.
      per_month: -346.67,
    });
    assert.deepEqual(byId(body, "sch-mortgage"), {
      id: "sch-mortgage",
      date_next: "2026-10-01",
      frequency: "monthly",
      account: "Chequing",
      payee: "Transfer : Mortgage",
      category: "Mortgage",
      group: "Housing",
      transfer_to: "Mortgage",
      amount: -150,
      per_month: -150,
    });
  });

  it("gives a one-off no per_month, because it has no rate", async () => {
    await using h = await scheduled();
    const once = byId(await h.json("list_scheduled"), "sch-once");
    assert.equal(once.frequency, "once");
    assert.ok(!("per_month" in once));
  });

  it("carries a split's lines beside the whole amount", async () => {
    await using h = await scheduled();
    const insurance = byId(await h.json("list_scheduled"), "sch-insurance");
    assert.equal(insurance.amount, -120);
    assert.equal(insurance.per_month, -10);
    assert.ok(!("category" in insurance), "the parent of a split has no category of its own");
    assert.deepEqual(insurance.lines, [
      { id: "ss1", category: "Household", group: "Everyday", memo: "home", amount: -100 },
      { id: "ss2", category: "Dining Out", group: "Everyday", amount: -20 },
    ]);
  });

  it("totals the recurring outflow and inflow the fixture's arithmetic says, and names its scope", async () => {
    await using h = await scheduled();
    const body = await h.json("list_scheduled");
    // Mortgage 150 + groceries 346.67 + insurance 10; the card payment moves money between budget
    // accounts and the interest is on the tracking mortgage, so neither is counted.
    assert.equal(body.outflow_per_month, 506.67);
    assert.equal(body.inflow_per_month, 1000);
    assert.match(String(body.scope), /on-budget/);
    assert.match(String(body.scope), /divided by twelve/);
  });

  it("agrees with the rows: the totals are the rows' per_month figures added up", async () => {
    await using h = await scheduled();
    const body = await h.json("list_scheduled");
    const counted = h.db.scheduledRows(BUDGET_ID).filter((r) => r.accountOnBudget && r.transferAccountOnBudget !== true && r.frequency !== "never");
    const outflow = counted.filter((r) => r.amount < 0).reduce((sum, r) => sum - byId(body, r.id).per_month!, 0);
    assert.equal(Math.round(outflow * 100) / 100, body.outflow_per_month);
  });

  it("counts a split line by line, so only its lines that move money between budget accounts are left out", async () => {
    // A monthly bill payment on Chequing: 800 of household, 200 paid onto the Visa (an on-budget
    // transfer, not spending) and 100 sent to the tracking mortgage (money leaving the budget).
    const budget = scheduledBudget();
    budget.scheduled_transactions!.push(scheduledTransaction("sch-bills", "2026-10-15", -1_100_000, { payee_id: "p9", category_id: null }));
    budget.scheduled_subtransactions!.push(
      scheduledSubtransaction("sb1", "sch-bills", -800_000, { category_id: "c2" }),
      scheduledSubtransaction("sb2", "sch-bills", -200_000, { payee_id: "pt2", transfer_account_id: "a2" }),
      scheduledSubtransaction("sb3", "sch-bills", -100_000, { payee_id: "pt3", transfer_account_id: "a3" }),
    );
    await using h = await harness({ budget });
    const body = await h.json("list_scheduled");
    const bills = byId(body, "sch-bills");
    assert.equal(bills.per_month, -1100, "the row's own rate is the whole amount");
    assert.deepEqual(
      bills.lines!.map((l) => [l.id, l.transfer_to, l.amount]),
      [
        ["sb1", undefined, -800],
        ["sb2", "Visa", -200],
        ["sb3", "Mortgage", -100],
      ],
    );
    // The fixture's 506.67 plus 800 + 100; the 200 onto the Visa is not spending.
    assert.equal(body.outflow_per_month, 1406.67);
    assert.equal(body.inflow_per_month, 1000);
  });

  it("rates every frequency YNAB schedules, and puts each one in words", async () => {
    // Twelve a year at 12 a time makes per_month equal to the yearly count, so the table below is
    // the pin: a mistyped code or count changes a number here.
    const expected: [code: string, words: string, perYear: number | undefined][] = [
      ["never", "once", undefined],
      ["daily", "daily", 365],
      ["weekly", "weekly", 52],
      ["everyOtherWeek", "every other week", 26],
      ["twiceAMonth", "twice a month", 24],
      ["every4Weeks", "every 4 weeks", 13],
      ["monthly", "monthly", 12],
      ["everyOtherMonth", "every other month", 6],
      ["every3Months", "every 3 months", 4],
      ["every4Months", "every 4 months", 3],
      ["twiceAYear", "twice a year", 2],
      ["yearly", "yearly", 1],
      ["everyOtherYear", "every other year", 0.5],
    ];
    assert.deepEqual(Object.keys(FREQUENCIES).sort(), expected.map(([code]) => code).sort(), "the table covers exactly these codes");
    await using h = await harness({
      budget: spendingBudget({
        scheduled_transactions: expected.map(([code]) =>
          scheduledTransaction(`sch-${code}`, "2026-10-01", -12_000, { frequency: code as ScheduledTransaction["frequency"] }),
        ),
      }),
    });
    const body = await h.json("list_scheduled");
    for (const [code, words, perYear] of expected) {
      const row = byId(body, `sch-${code}`);
      assert.equal(row.frequency, words, code);
      assert.equal(row.per_month, perYear === undefined ? undefined : -perYear, code);
    }
    assert.equal(body.outflow_per_month, expected.reduce((sum, [, , perYear]) => sum + (perYear ?? 0), 0));
  });

  it("answers a budget with no schedule at all without a single null", async () => {
    await using h = await harness({ budget: spendingBudget() });
    const { text, isError } = await h.call("list_scheduled");
    assert.equal(isError, false);
    assert.ok(!text.includes("null"));
    assert.deepEqual(JSON.parse(text).rows, []);
  });

  it("pulls from YNAB once when asked to refresh", async () => {
    await using h = await scheduled();
    await h.json("list_scheduled");
    const before = h.source.calls.length;
    await h.json("list_scheduled", { refresh: true });
    assert.equal(h.source.calls.length, before + 1);
  });
});
