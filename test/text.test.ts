import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { byName, fold } from "../src/format/text.js";

describe("fold", () => {
  it("lower-cases and drops accents, so a search reaches an accented name", () => {
    assert.equal(fold("Café"), "cafe");
    assert.equal(fold("CAFÉ"), "cafe");
    assert.equal(fold("Crème Brûlée"), "creme brulee");
  });

  it("drops emoji and the joiners that glue them together", () => {
    assert.equal(fold("🥘 Food"), "food");
    assert.equal(fold("🏠 Housing"), "housing");
    assert.equal(fold("👨‍👩‍👧 Family"), "family", "a ZWJ-joined sequence leaves nothing behind but the word");
    assert.equal(fold("🇨🇦 Canada"), "canada", "regional indicators are a flag, not letters");
    assert.equal(fold("👍🏽 Wins"), "wins", "a skin-tone modifier goes with its pictograph");
  });

  it("keeps digits, because a category can be named after one", () => {
    assert.equal(fold("401k"), "401k", "`\\p{Emoji_Component}` would have eaten the digits");
    assert.equal(fold("2026 Taxes"), "2026 taxes");
    assert.equal(fold("#1 Priority"), "#1 priority");
  });

  it("collapses runs of whitespace and trims the ends", () => {
    assert.equal(fold("  Groceries  "), "groceries");
    assert.equal(fold("Car\tInsurance"), "car insurance");
    assert.equal(fold("Gifts    and   Giving"), "gifts and giving");
  });

  it("folds a name made only of emoji or space away to nothing", () => {
    assert.equal(fold("🥘"), "", "callers must decide what an empty term means rather than ignoring it");
    assert.equal(fold("   "), "");
  });
});

describe("byName", () => {
  const sorted = (names: string[]): string[] => [...names].sort(byName((n) => n));

  it("orders by the folded name, so an emoji does not decide where a row sorts", () => {
    assert.deepEqual(sorted(["🥘 Food", "Apples", "🏠 Housing"]), ["Apples", "🥘 Food", "🏠 Housing"]);
  });

  it("ignores case and accents when ordering", () => {
    assert.deepEqual(sorted(["banana", "Ápple", "Cherry"]), ["Ápple", "banana", "Cherry"]);
  });

  it("breaks a fold tie on the raw name, so the order is total rather than whatever the database returned", () => {
    assert.deepEqual(sorted(["Café", "Cafe"]), ["Cafe", "Café"]);
    assert.deepEqual(sorted(["Cafe", "Café"]), ["Cafe", "Café"], "the same order from either starting arrangement");
    assert.notEqual(byName<string>((n) => n)("Cafe", "Café"), 0, "two names that fold alike still have an order");
  });
});
