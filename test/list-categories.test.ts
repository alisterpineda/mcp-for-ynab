import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { category, goal, orientationBudget } from "./fixtures.js";
import { harness } from "./mcp.js";

interface Group {
  name: string;
  categories: Record<string, unknown>[];
}

const groupsOf = (body: Record<string, unknown>): Group[] => body.groups as Group[];
const names = (groups: Group[]): Record<string, string[]> =>
  Object.fromEntries(groups.map((g) => [g.name, g.categories.map((c) => String(c.name))]));

describe("list_categories", () => {
  it("nests categories under their group, alphabetically, with ids", async () => {
    await using h = await harness();
    const groups = groupsOf(await h.json("list_categories"));
    assert.deepEqual(
      groups.map((g) => g.name),
      ["Credit Card Payments", "🥘 Food", "🏠 Housing"],
      "folded alphabetical order: emoji do not decide where a group sorts",
    );
    assert.deepEqual(names(groups), {
      "Credit Card Payments": ["Visa"],
      "🥘 Food": ["Café", "Groceries"],
      "🏠 Housing": ["Rent"],
    });
    assert.deepEqual(groups[0].categories[0], { id: "c3", name: "Visa" });
  });

  it("carries the note and the goal definition, and omits both when absent", async () => {
    await using h = await harness();
    const food = groupsOf(await h.json("list_categories")).find((g) => g.name === "🥘 Food")!;
    const [cafe, groceries] = food.categories;
    assert.deepEqual(groceries, {
      id: "c1",
      name: "Groceries",
      note: "costco run monthly",
      goal: { type: "monthly funding", target: 800 },
    });
    assert.deepEqual(cafe, { id: "c2", name: "Café", goal: { type: "target balance", target: 200, snoozed: true } });
  });

  it("carries a goal's target date when it has one", async () => {
    await using h = await harness();
    const housing = groupsOf(await h.json("list_categories")).find((g) => g.name === "🏠 Housing")!;
    assert.deepEqual(housing.categories[0], {
      id: "c8",
      name: "Rent",
      goal: { type: "target balance by date", target: 2000, target_date: "2026-12-31" },
    });
  });

  it("humanizes every goal type, because the API's codes are opaque", async () => {
    const budget = orientationBudget({
      categories: [
        category("tb", "A", goal("TB", 1_000)),
        category("tbd", "B", goal("TBD", 1_000)),
        category("mf", "C", goal("MF", 1_000)),
        category("need", "D", goal("NEED", 1_000)),
        category("debt", "E", goal("DEBT", 1_000)),
      ],
    });
    await using h = await harness({ budget });
    const [group] = groupsOf(await h.json("list_categories"));
    assert.deepEqual(
      group.categories.map((c) => (c.goal as { type: string }).type),
      ["target balance", "target balance by date", "monthly funding", "plan your spending", "debt payoff"],
    );
  });

  it("carries no money and nothing month-dependent", async () => {
    await using h = await harness();
    const { text, isError } = await h.call("list_categories");
    assert.equal(isError, false, "an error result would satisfy every assertion below");
    for (const field of ["assigned", "available", "activity", "balance", "underfunded", "month"]) {
      assert.ok(!text.includes(`"${field}"`), `${field} belongs to get_month, not here`);
    }
  });

  it("excludes internal categories but keeps the Credit Card Payment ones", async () => {
    await using h = await harness();
    const groups = groupsOf(await h.json("list_categories"));
    const all = groups.flatMap((g) => g.categories.map((c) => c.name));
    assert.ok(!all.includes("Inflow: Ready to Assign"), "YNAB's plumbing is not part of the budget");
    assert.ok(!all.includes("Uncategorized"));
    assert.ok(!groups.some((g) => g.name === "Internal Master Category"), "a group left with nothing is dropped");
    assert.deepEqual(
      groups.find((g) => g.name === "Credit Card Payments")?.categories.map((c) => c.name),
      ["Visa"],
      "the group is internal but its categories are not",
    );
  });

  it("leaves hidden categories and hidden groups out by default", async () => {
    await using h = await harness();
    const groups = groupsOf(await h.json("list_categories"));
    assert.ok(!groups.some((g) => g.name === "Hidden Stuff"), "a group that is itself hidden");
    assert.ok(!groups.flatMap((g) => g.categories).some((c) => c.name === "Old hobby"), "a category that is itself hidden");
  });

  it("returns hidden categories on request, marked, including members of a hidden group", async () => {
    await using h = await harness();
    const groups = groupsOf(await h.json("list_categories", { include_hidden: true }));
    assert.deepEqual(names(groups), {
      "Credit Card Payments": ["Visa"],
      "🥘 Food": ["Café", "Groceries", "Old hobby"],
      "Hidden Stuff": ["Retired thing"],
      "🏠 Housing": ["Rent"],
    });
    const food = groups.find((g) => g.name === "🥘 Food")!;
    assert.deepEqual(food.categories[2], { id: "c5", name: "Old hobby", hidden: true });
    assert.equal(groups.find((g) => g.name === "Hidden Stuff")!.categories[0].hidden, true, "its own flag is false, but it is hidden in YNAB");
    assert.ok(!("hidden" in food.categories[0]), "a visible category is not marked");
  });
});

describe("list_categories search", () => {
  const search = async (term: string) => {
    await using h = await harness();
    return names(groupsOf(await h.json("list_categories", { search: term })));
  };

  it("matches a substring of the category name, ignoring case", async () => {
    assert.deepEqual(await search("groc"), { "🥘 Food": ["Groceries"] });
    assert.deepEqual(await search("GROC"), { "🥘 Food": ["Groceries"] });
  });

  it("ignores accents", async () => {
    assert.deepEqual(await search("cafe"), { "🥘 Food": ["Café"] });
    assert.deepEqual(await search("café"), { "🥘 Food": ["Café"] });
  });

  it("returns a matched group's whole category list", async () => {
    assert.deepEqual(await search("food"), { "🥘 Food": ["Café", "Groceries"] }, "the emoji does not stop the group name matching");
    assert.deepEqual(await search("card payments"), { "Credit Card Payments": ["Visa"] });
  });

  it("does not match notes", async () => {
    assert.deepEqual(await search("costco"), {}, "a hit whose name lacks the term would read as a bug");
  });

  it("returns nothing rather than everything when there is no match", async () => {
    assert.deepEqual(await search("nothing here"), {});
  });

  it("returns nothing rather than everything for a term that folds away to nothing", async () => {
    assert.deepEqual(await search("\u{1f959}"), {}, "an emoji on its own: folding strips it, and an empty term must not mean no filter");
    assert.deepEqual(await search("   "), {}, "whitespace on its own");
  });
});
