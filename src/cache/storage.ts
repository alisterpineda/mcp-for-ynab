import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { cacheDataProblem, type CacheData } from "./schema.js";

export function defaultCacheDir(): string {
  const override = process.env.YNAB_MCP_CACHE_DIR;
  if (override) return override;
  if (process.platform === "darwin") return path.join(homedir(), "Library", "Application Support", "ynab-mcp");
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "ynab-mcp");
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "ynab-mcp");
}

export type LoadResult =
  | { kind: "loaded"; data: CacheData }
  | { kind: "missing" }
  | { kind: "discarded"; reason: string };

/** Persists the cache as a single JSON file, written atomically (temp file + rename). */
export class CacheStorage {
  readonly filePath: string;

  constructor(dir: string = defaultCacheDir()) {
    this.filePath = path.join(dir, "cache.json");
  }

  /** Load the cache. Corrupt, unreadable, or mismatched files are reported as discarded, never thrown. */
  async load(expectedBudgetId: string | null): Promise<LoadResult> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return { kind: "missing" };
      return { kind: "discarded", reason: `unreadable: ${describe(error)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { kind: "discarded", reason: `corrupt JSON: ${describe(error)}` };
    }

    const problem = cacheDataProblem(parsed);
    if (problem !== null) return { kind: "discarded", reason: problem };
    const data = parsed as CacheData;
    if (expectedBudgetId !== null && data.budget.id !== expectedBudgetId) {
      return { kind: "discarded", reason: `cached budget ${data.budget.id} differs from configured ${expectedBudgetId}` };
    }
    return { kind: "loaded", data };
  }

  async save(data: CacheData): Promise<void> {
    // The file holds the whole budget; keep it owner-only wherever the directory ends up.
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.filePath);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  async remove(): Promise<void> {
    await rm(this.filePath, { force: true });
  }

  async sizeBytes(): Promise<number | null> {
    try {
      return (await stat(this.filePath)).size;
    } catch {
      return null;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
