import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import manifest from "../manifest.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };
import { harness } from "./mcp.js";

const ORIENTATION_TOOLS = ["get_month", "list_accounts", "list_categories"];
/** The analysis tools, which answer from the spending rule rather than describing the budget. */
const SPENDING_TOOLS = ["spending_breakdown", "spending_trend", "search_transactions", "budget_vs_actual", "list_scheduled"];
const DATA_TOOLS = [...ORIENTATION_TOOLS, ...SPENDING_TOOLS];

/** What a tool is called with when the bare `{}` of the default sets is not a question it can answer. */
const ARGUMENTS: Record<string, Record<string, unknown>[]> = {
  // A trend of nothing in particular is not a trend, so the tool insists on a category or a group.
  spending_trend: [{ categories: ["Groceries"] }],
};
const DEFAULT_ARGUMENTS = [{}, { include_hidden: true }, { include_closed: true }];

/** Where Claude Code cuts an MCP tool description, appending "… [truncated]". */
const CLAUDE_CODE_DESCRIPTION_LIMIT = 2048;

/** The row order each tool promises, in its own words; the shared note only says the order is its own. */
const ORDERING: Record<string, RegExp> = {
  get_month: /ordered alphabetically, which is not YNAB's on-screen order/,
  list_accounts: /ordered alphabetically, which is not YNAB's on-screen order/,
  list_categories: /ordered alphabetically, which is not YNAB's on-screen order/,
  spending_breakdown: /sorted by `spent` descending/,
  spending_trend: /in chronological order/,
  search_transactions: /Rows come newest first/,
  budget_vs_actual: /Rows come most-overspent first/,
  list_scheduled: /ordered by `date_next` ascending/,
};

describe("the registered tools", () => {
  it("registers the orientation and spending tools alongside sync_status", async () => {
    await using h = await harness();
    const names = (await h.client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...DATA_TOOLS, "sync_status"].sort());
  });

  it("annotates every tool as read-only against an open world", async () => {
    await using h = await harness();
    for (const tool of (await h.client.listTools()).tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations?.openWorldHint, true, tool.name);
    }
  });

  it("states in each description the four things that are wrong when left unsaid", async () => {
    await using h = await harness();
    const tools = (await h.client.listTools()).tools.filter((tool) => DATA_TOOLS.includes(tool.name));
    assert.equal(tools.length, DATA_TOOLS.length);
    for (const { name, description = "" } of tools) {
      assert.match(description, /plain numbers in the currency named by `currency`/, `${name}: what the amounts are`);
      assert.match(description, /`assigned` is Assigned, `available` is Available, `ready_to_assign` is Ready to Assign/, `${name}: the vocabulary`);
      assert.match(
        description,
        /Filters take names as well as ids; the ids come from `list_categories` and `list_accounts`, since `get_month` carries none/,
        `${name}: where ids come from, and that get_month is not one of them`,
      );
      assert.match(description, /states its own row order/, `${name}: that the order is the tool's own`);
      assert.match(description, ORDERING[name], `${name}: the ordering`);
      assert.ok(description.length > 500, `${name}: a full description, not a one-liner`);
    }
  });

  it("keeps every description within the 2,048 characters Claude Code passes on", async () => {
    // Claude Code cuts a longer description there without a word (anthropics/claude-code#87650),
    // and the shared notes come last, so they would be the first thing the model never sees.
    await using h = await harness();
    for (const { name, description = "" } of (await h.client.listTools()).tools) {
      assert.ok(description.length <= CLAUDE_CODE_DESCRIPTION_LIMIT, `${name}: ${description.length} characters`);
    }
  });

  it("never emits a null, because an absent value drops its key instead", async () => {
    await using h = await harness();
    for (const tool of DATA_TOOLS) {
      for (const args of ARGUMENTS[tool] ?? DEFAULT_ARGUMENTS) {
        const { text, isError } = await h.call(tool, args);
        assert.equal(isError, false, `${tool} ${JSON.stringify(args)}: an error result carries no nulls either`);
        assert.ok(!text.includes("null"), `${tool} ${JSON.stringify(args)}: ${text.slice(0, 200)}`);
      }
    }
  });
});

describe("the tool modules", () => {
  it("contain no SQL, so queries stay in one testable place", async () => {
    const dir = path.join(import.meta.dirname, "..", "src", "tools");
    const files = (await readdir(dir)).filter((file) => file.endsWith(".ts"));
    assert.ok(files.length >= 5, "every tool module is checked");
    for (const file of files) {
      const source = await readFile(path.join(dir, file), "utf8");
      for (const keyword of ["SELECT ", "INSERT ", "DELETE FROM", "UPDATE "]) {
        assert.ok(!source.includes(keyword), `${file} contains ${keyword.trim()}`);
      }
    }
  });
});

describe("the published version", () => {
  it("is the same in the package manifest and the extension manifest", () => {
    assert.equal(manifest.version, pkg.version, "the server reports one and the packaged extension displays the other");
  });

  it("lists every registered tool in the extension manifest", async () => {
    await using h = await harness();
    const registered = (await h.client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(manifest.tools.map((tool) => tool.name).sort(), registered);
    for (const tool of manifest.tools) assert.ok(tool.description.length > 0, tool.name);
  });

  it("documents every registered tool in the README", async () => {
    const readme = await readFile(path.join(import.meta.dirname, "..", "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("\n## Tools\n"));
    for (const name of [...DATA_TOOLS, "sync_status"]) {
      assert.ok(section.includes(`\`${name}\``), `the README's Tools section covers ${name}`);
    }
  });
});
