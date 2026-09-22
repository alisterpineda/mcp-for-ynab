import { homedir } from "node:os";
import path from "node:path";

export function defaultCacheDir(): string {
  const override = process.env.YNAB_MCP_CACHE_DIR;
  if (override) return override;
  if (process.platform === "darwin") return path.join(homedir(), "Library", "Application Support", "ynab-mcp");
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "ynab-mcp");
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "ynab-mcp");
}

/** The single SQLite file holding every cached budget. */
export function defaultDbPath(): string {
  return path.join(defaultCacheDir(), "ynab.sqlite");
}
