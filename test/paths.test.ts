import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { defaultCacheDir, defaultDbPath } from "../src/cache/paths.js";

describe("defaultCacheDir", () => {
  const saved = process.env.MCP_FOR_YNAB_CACHE_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.MCP_FOR_YNAB_CACHE_DIR;
    else process.env.MCP_FOR_YNAB_CACHE_DIR = saved;
  });

  it("honours MCP_FOR_YNAB_CACHE_DIR", () => {
    process.env.MCP_FOR_YNAB_CACHE_DIR = "/somewhere/else";
    assert.equal(defaultCacheDir(), "/somewhere/else");
    assert.equal(defaultDbPath(), path.join("/somewhere/else", "ynab.sqlite"));
  });

  it("falls back to a per-platform directory namespaced by author", () => {
    delete process.env.MCP_FOR_YNAB_CACHE_DIR;
    const dir = defaultCacheDir();
    assert.equal(path.basename(dir), "mcp-for-ynab");
    assert.equal(path.basename(path.dirname(dir)), "alisterpineda");
    assert.ok(path.isAbsolute(dir));
  });
});
