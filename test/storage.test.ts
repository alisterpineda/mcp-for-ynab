import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildCache } from "../src/cache/delta.js";
import { CacheStorage, defaultCacheDir } from "../src/cache/storage.js";
import { planDetail } from "./fixtures.js";

describe("defaultCacheDir", () => {
  const saved = process.env.YNAB_MCP_CACHE_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.YNAB_MCP_CACHE_DIR;
    else process.env.YNAB_MCP_CACHE_DIR = saved;
  });

  it("honours YNAB_MCP_CACHE_DIR", () => {
    process.env.YNAB_MCP_CACHE_DIR = "/somewhere/else";
    assert.equal(defaultCacheDir(), "/somewhere/else");
  });

  it("falls back to a per-platform directory named ynab-mcp", () => {
    delete process.env.YNAB_MCP_CACHE_DIR;
    const dir = defaultCacheDir();
    assert.equal(path.basename(dir), "ynab-mcp");
    assert.ok(path.isAbsolute(dir));
  });
});

describe("CacheStorage.load", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ynab-mcp-storage-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function saveThenMutate(mutate: (saved: Record<string, unknown>) => void) {
    const storage = new CacheStorage(dir);
    await storage.save(buildCache(planDetail(), 1, new Date()));
    const saved = JSON.parse(await readFile(storage.filePath, "utf8"));
    mutate(saved);
    await writeFile(storage.filePath, JSON.stringify(saved));
    return storage.load(null);
  }

  it("discards a file missing an entity collection and names it", async () => {
    const result = await saveThenMutate((saved) => delete saved.accounts);
    assert.deepEqual(result, { kind: "discarded", reason: "missing accounts" });
  });

  it("discards a file whose lastSyncedAt does not parse", async () => {
    const result = await saveThenMutate((saved) => (saved.lastSyncedAt = "yesterday"));
    assert.deepEqual(result, { kind: "discarded", reason: "invalid lastSyncedAt" });
  });

  it("names the version in a schema mismatch", async () => {
    const result = await saveThenMutate((saved) => (saved.schemaVersion = 0));
    assert.equal(result.kind, "discarded");
    assert.match((result as { reason: string }).reason, /schema mismatch \(file has version 0/);
  });
});
