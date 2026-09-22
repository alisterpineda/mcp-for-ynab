import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { defaultCacheDir, defaultDbPath } from "../src/cache/paths.js";

describe("defaultCacheDir", () => {
  const saved = process.env.YNAB_MCP_CACHE_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.YNAB_MCP_CACHE_DIR;
    else process.env.YNAB_MCP_CACHE_DIR = saved;
  });

  it("honours YNAB_MCP_CACHE_DIR", () => {
    process.env.YNAB_MCP_CACHE_DIR = "/somewhere/else";
    assert.equal(defaultCacheDir(), "/somewhere/else");
    assert.equal(defaultDbPath(), path.join("/somewhere/else", "ynab.sqlite"));
  });

  it("falls back to a per-platform directory named ynab-mcp", () => {
    delete process.env.YNAB_MCP_CACHE_DIR;
    const dir = defaultCacheDir();
    assert.equal(path.basename(dir), "ynab-mcp");
    assert.ok(path.isAbsolute(dir));
  });
});
