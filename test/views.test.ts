import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCache } from "../src/cache/delta.js";
import { flattenTransactions, transactionDateRange } from "../src/cache/views.js";
import { category, fullPlan, planDetail, transaction } from "./fixtures.js";

const NOW = new Date("2026-09-21T14:00:00Z");

describe("flattenTransactions", () => {
  const lines = flattenTransactions(buildCache(fullPlan(), 10, NOW));

  it("emits one line per plain transaction and one per split line", () => {
    assert.equal(lines.length, 5);
    assert.ok(!lines.some((l) => l.id === "t2"), "the split parent itself is not a line");
  });

  it("sorts newest first", () => {
    assert.deepEqual(
      lines.map((l) => l.date),
      ["2026-09-12", "2026-09-12", "2026-09-12", "2026-09-10", "2026-08-01"],
    );
  });

  it("resolves account, payee, and category names", () => {
    const rent = lines.find((l) => l.id === "t3")!;
    assert.equal(rent.accountName, "Checking");
    assert.equal(rent.payeeName, "Landlord");
    assert.equal(rent.categoryName, "Groceries");
    assert.equal(rent.categoryGroupName, "Everyday");
    assert.equal(rent.parentId, null);
  });

  it("split lines inherit payee and memo from the parent unless set on the line", () => {
    const paper = lines.find((l) => l.id === "s1")!;
    const other = lines.find((l) => l.id === "s2")!;
    assert.equal(paper.parentId, "t2");
    assert.equal(paper.amount, -20_000);
    assert.equal(paper.payeeName, "Costco");
    assert.equal(paper.memo, "paper towels");
    assert.equal(paper.categoryName, "Household");
    assert.equal(other.memo, "big shop", "falls back to the parent memo");
    assert.equal(other.categoryName, "Groceries");
    assert.equal(paper.transferAccountId, null, "a plain split line has no transfer account");
  });

  it("split lines keep their own payee and transfer account over the parent's", () => {
    const leg = lines.find((l) => l.id === "s3")!;
    assert.equal(leg.payeeId, "p2");
    assert.equal(leg.payeeName, "Landlord");
    assert.equal(leg.transferAccountId, "a2");
  });

  it("falls back to the category's own group name when the group is not cached", () => {
    const plan = planDetail({
      categories: [category("c9", "Orphan", { category_group_id: "missing", category_group_name: "From category" })],
      transactions: [transaction("x", "2026-01-01", -1, { category_id: "c9" })],
    });
    const [line] = flattenTransactions(buildCache(plan, 1, NOW));
    assert.equal(line.categoryGroupName, "From category");
  });

  it("handles missing lookups without throwing", () => {
    const cache = buildCache(planDetail({ transactions: [transaction("x", "2026-01-01", -1, { account_id: "gone", payee_id: "gone", category_id: "gone" })] }), 1, NOW);
    const [line] = flattenTransactions(cache);
    assert.equal(line.accountName, "(unknown account)");
    assert.equal(line.payeeName, null);
    assert.equal(line.categoryName, null);
  });
});

describe("transactionDateRange", () => {
  it("returns the earliest and latest transaction dates", () => {
    assert.deepEqual(transactionDateRange(buildCache(fullPlan(), 10, NOW)), { earliest: "2026-08-01", latest: "2026-09-12" });
  });

  it("returns null with no transactions", () => {
    assert.equal(transactionDateRange(buildCache(planDetail(), 1, NOW)), null);
  });
});
