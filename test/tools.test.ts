import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import manifest from "../manifest.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };
import { harness } from "./mcp.js";

const ORIENTATION_TOOLS = ["get_month", "list_accounts", "list_categories"];

describe("the registered tools", () => {
  it("registers the three orientation tools alongside sync_status", async () => {
    await using h = await harness();
    const names = (await h.client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...ORIENTATION_TOOLS, "sync_status"]);
  });

  it("annotates every orientation tool as read-only against an open world", async () => {
    await using h = await harness();
    for (const tool of (await h.client.listTools()).tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations?.openWorldHint, true, tool.name);
    }
  });

  it("states in each description the four things that are wrong when left unsaid", async () => {
    await using h = await harness();
    const tools = (await h.client.listTools()).tools.filter((tool) => ORIENTATION_TOOLS.includes(tool.name));
    assert.equal(tools.length, 3);
    for (const { name, description = "" } of tools) {
      assert.match(description, /plain numbers in the currency named by `currency`/, `${name}: what the amounts are`);
      assert.match(description, /`assigned` is Assigned, `available` is Available, `ready_to_assign` is Ready to Assign/, `${name}: the vocabulary`);
      assert.match(description, /ids come from `list_categories`[\s\S]*`get_month` deliberately carries no ids/, `${name}: where ids come from`);
      assert.match(description, /alphabetically, which is not YNAB's on-screen order/, `${name}: the ordering`);
      assert.ok(description.length > 500, `${name}: a full description, not a one-liner`);
    }
  });

  it("never emits a null, because an absent value drops its key instead", async () => {
    await using h = await harness();
    for (const tool of ORIENTATION_TOOLS) {
      for (const args of [{}, { include_hidden: true }, { include_closed: true }]) {
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
    for (const name of [...ORIENTATION_TOOLS, "sync_status"]) {
      assert.ok(section.includes(`\`${name}\``), `the README's Tools section covers ${name}`);
    }
  });
});
