// Runs against the built server/index.js, so it is not part of `npm test`; `npm run check` runs it
// after the build. The npm package ships only server/ and lists its runtime libraries as
// devDependencies, so the bundle has to start on its own with no node_modules beside it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import pkg from "../package.json" with { type: "json" };

const bin = path.resolve(import.meta.dirname, "..", pkg.bin["mcp-for-ynab"]);

describe("published bin", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-for-ynab-smoke-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("is shipped by the package's files list", () => {
    assert.ok(pkg.files.some((entry) => !path.relative(entry, pkg.bin["mcp-for-ynab"]).startsWith("..")));
  });

  it("starts with a node shebang", () => {
    assert.equal(readFileSync(bin, "utf8").split("\n")[0], "#!/usr/bin/env node");
  });

  it("loads with no node_modules and stops on the missing token", () => {
    const copy = path.join(dir, "index.js");
    copyFileSync(bin, copy);
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: pkg.type }));
    const env = { ...process.env };
    delete env.YNAB_ACCESS_TOKEN;
    const run = spawnSync(process.execPath, [copy], { cwd: dir, env, encoding: "utf8" });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /YNAB_ACCESS_TOKEN is not set/);
  });
});
