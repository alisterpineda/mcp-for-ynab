import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { monthFromNow, spendingBudget, transaction } from "./fixtures.js";
import { harness } from "./mcp.js";

interface Row {
  id: string;
  parent_id?: string;
  date: string;
  account: string;
  payee?: string;
  category?: string;
  group?: string;
  memo?: string;
  amount: number;
  cleared: string;
  approved: boolean;
  flag?: string;
}

const rowsOf = (body: Record<string, unknown>): Row[] => body.rows as Row[];
const idsOf = (body: Record<string, unknown>): string[] => rowsOf(body).map((r) => r.id).sort();

const spending = () => harness({ budget: spendingBudget() });

describe("search_transactions", () => {
  it("returns a line the way the register shows it, dropping what the line does not have", async () => {
    await using h = await spending();
    const body = await h.json("search_transactions", { start: "2026-09-12", end: "2026-09-12" });
    assert.deepEqual(rowsOf(body), [
      {
        id: "t44",
        date: "2026-09-12",
        account: "Chequing",
        payee: "Hardware Depot",
        category: "Household",
        group: "Everyday",
        amount: -40,
        cleared: "uncleared",
        approved: false,
      },
    ]);
  });

  it("leaves out the keys a line has nothing for, rather than sending them empty", async () => {
    await using h = await spending();
    // t8 has no payee and a category that no longer exists, so no group either.
    const orphan = await h.json("search_transactions", { start: "2026-07-24", end: "2026-07-24" });
    assert.deepEqual(rowsOf(orphan), [
      { id: "t8", date: "2026-07-24", account: "Chequing", category: "(deleted category)", amount: -5, cleared: "cleared", approved: true },
    ]);
    // t4 and t5 are the two sides of a transfer between budget accounts: a payee, no category.
    const transfer = await h.json("search_transactions", { start: "2026-07-15", end: "2026-07-15" });
    assert.deepEqual(rowsOf(transfer), [
      { id: "t4", date: "2026-07-15", account: "Chequing", payee: "Transfer : Visa", amount: -50, cleared: "cleared", approved: true },
      { id: "t5", date: "2026-07-15", account: "Visa", payee: "Transfer : Chequing", amount: 50, cleared: "cleared", approved: true },
    ]);
  });

  it("gives a split line its parent's id, so the line can be traced back", async () => {
    await using h = await spending();
    const body = await h.json("search_transactions", { start: "2026-07-05", end: "2026-07-05" });
    assert.equal(rowsOf(body).length, 3, "the split's three lines, not the parent");
    const household = rowsOf(body).find((r) => r.category === "Household")!;
    assert.deepEqual(household, {
      id: "s2",
      parent_id: "t1",
      date: "2026-07-05",
      account: "Chequing",
      payee: "Costco",
      category: "Household",
      group: "Everyday",
      memo: "paper towels",
      amount: -30,
      cleared: "cleared",
      approved: true,
    });
  });

  it("sorts the rows newest first", async () => {
    await using h = await spending();
    const body = await h.json("search_transactions", { start: "2026-09", end: "2026-09" });
    const dates = rowsOf(body).map((r) => r.date);
    assert.equal(dates[0], "2026-09-18");
    assert.deepEqual(dates, [...dates].sort().reverse());
  });

  it("reaches the lines the spending rule drops: tracking accounts, transfers and inflows", async () => {
    await using h = await spending();
    const tracking = await h.json("search_transactions", { start: "2026-07", end: "2026-09", accounts: ["Mortgage"] });
    assert.deepEqual(idsOf(tracking), ["t24", "t3", "t43", "t9"].sort());

    const inflows = await h.json("search_transactions", { start: "2026-07", end: "2026-09", categories: ["Inflow: Ready to Assign"] });
    assert.deepEqual(idsOf(inflows), ["t10", "t28", "t45"].sort());

    const transfers = await h.json("search_transactions", { start: "2026-07-15", end: "2026-07-15" });
    assert.deepEqual(idsOf(transfers), ["t4", "t5"], "both sides of a budget-to-budget transfer");
  });

  it("filters on the absolute amount, inclusively at both ends", async () => {
    await using h = await spending();
    const body = await h.json("search_transactions", { start: "2026-07", end: "2026-09", min_amount: 20, max_amount: 60 });
    // 20 (t11) and 60 (s1, t25, t26) sit exactly on the bounds; 18 (t22) and 70 (t46) sit outside.
    assert.deepEqual(idsOf(body), ["s1", "s2", "t11", "t21", "t25", "t26", "t27", "t29", "t4", "t44", "t5", "t6"].sort());
    assert.equal(body.count, 12);
  });

  it("picks a direction while keeping YNAB's sign on the rows", async () => {
    await using h = await spending();
    const args = { start: "2026-07", end: "2026-09", min_amount: 20, max_amount: 60 };

    const inflow = await h.json("search_transactions", { ...args, direction: "inflow" });
    assert.deepEqual(idsOf(inflow), ["t26", "t27", "t5"].sort());
    // 50 + 60 + 20 back in.
    assert.equal(inflow.sum, 130);
    assert.ok(rowsOf(inflow).every((r) => r.amount > 0));

    const outflow = await h.json("search_transactions", { ...args, direction: "outflow" });
    assert.equal(outflow.count, 9);
    // 60 + 30 + 50 + 20 + 25 + 45 + 60 + 30 + 40 out.
    assert.equal(outflow.sum, -360);
    assert.ok(rowsOf(outflow).every((r) => r.amount < 0));
  });

  it("matches text against the memo or the payee, ignoring case", async () => {
    await using h = await spending();
    const range = { start: "2026-07", end: "2026-09" };
    const payee = await h.json("search_transactions", { ...range, text: "CORNER" });
    assert.deepEqual(idsOf(payee), ["t12", "t41", "t6"].sort(), "Corner Store and Corner Diner");

    const memo = await h.json("search_transactions", { ...range, text: "blender" });
    assert.deepEqual(idsOf(memo), ["s3"]);
    assert.equal(rowsOf(memo)[0].memo, "returned blender");
  });

  it("counts and sums every match, even the rows the limit cut", async () => {
    await using h = await spending();
    const body = await h.json("search_transactions", { start: "2026-09", end: "2026-09", limit: 2 });
    assert.equal(rowsOf(body).length, 2);
    assert.equal(body.count, 8, "September's eight lines, two of them returned");
    // 500 in, 80 + 14 + 150 + 40 + 70 out, 150 + 70 back in from the transfer mirrors.
    assert.equal(body.sum, 366);
  });

  it("never returns more than 200 rows, however high the limit", async () => {
    const extras = Array.from({ length: 210 }, (_, i) => transaction(`x${i}`, "2026-06-15", -1_000, { category_id: "c1" }));
    await using h = await harness({ budget: spendingBudget({ transactions: extras, subtransactions: [] }) });
    const body = await h.json("search_transactions", { start: "2026-06", end: "2026-06", limit: 1_000 });
    assert.equal(rowsOf(body).length, 200);
    assert.equal(body.count, 210);
    assert.equal(body.sum, -210);
  });

  it("returns 50 rows by default", async () => {
    const extras = Array.from({ length: 60 }, (_, i) => transaction(`x${i}`, "2026-06-15", -1_000, { category_id: "c1" }));
    await using h = await harness({ budget: spendingBudget({ transactions: extras, subtransactions: [] }) });
    const body = await h.json("search_transactions", { start: "2026-06", end: "2026-06" });
    assert.equal(rowsOf(body).length, 50);
    assert.equal(body.count, 60);
  });

  it("takes filters as ids or names, ORing inside a parameter and ANDing across them", async () => {
    await using h = await spending();
    const range = { start: "2026-07", end: "2026-09" };
    const ored = await h.json("search_transactions", { ...range, payees: ["Costco", "café luna"] });
    assert.deepEqual(idsOf(ored), ["s1", "s2", "s3", "t11", "t20", "t22", "t40"].sort());

    const anded = await h.json("search_transactions", { ...range, payees: ["p1"], accounts: ["Chequing"], categories: ["c1"] });
    assert.deepEqual(idsOf(anded), ["s1", "s3", "t20", "t40"].sort());
  });

  it("reports an unknown or ambiguous name as a tool error listing what it could mean", async () => {
    await using h = await spending();
    const unknown = await h.call("search_transactions", { accounts: ["Chequeing"] });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.text, 'No account named "Chequeing".');

    const ambiguous = await h.call("search_transactions", { payees: ["Corner Store"] });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.text, /matches several payees/);
    assert.match(ambiguous.text, /Corner Store \(p6\)/);
  });

  it("defaults the range to the current month", async () => {
    const month = monthFromNow(0);
    await using h = await harness({
      budget: spendingBudget({
        transactions: [transaction("tx1", `${month}-01`, -12_000, { payee_id: "p1", category_id: "c1" })],
        subtransactions: [],
      }),
    });
    const body = await h.json("search_transactions");
    assert.equal(body.start, `${month}-01`);
    assert.equal(String(body.end).slice(0, 7), month);
    assert.deepEqual(idsOf(body), ["tx1"]);
  });

  it("refuses a date it cannot read, naming the forms it takes", async () => {
    await using h = await spending();
    const { text, isError } = await h.call("search_transactions", { start: "march" });
    assert.equal(isError, true);
    assert.match(text, /YYYY-MM-DD/);
    assert.match(text, /YYYY-MM/);
  });

  it("pulls from YNAB once when asked to refresh", async () => {
    await using h = await spending();
    await h.json("search_transactions", { start: "2026-08", end: "2026-08" });
    const before = h.source.calls.length;
    await h.json("search_transactions", { start: "2026-08", end: "2026-08", refresh: true });
    assert.equal(h.source.calls.length, before + 1);
    await h.json("search_transactions", { start: "2026-08", end: "2026-08" });
    assert.equal(h.source.calls.length, before + 1, "without refresh the cache is still fresh");
  });
});
