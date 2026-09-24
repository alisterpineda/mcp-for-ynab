import { homedir } from "node:os";
import path from "node:path";

/** Namespaced by author, since other YNAB servers share the project's generic name. */
const APP_DIR = path.join("alisterpineda", "mcp-for-ynab");

export function defaultCacheDir(): string {
  const override = process.env.MCP_FOR_YNAB_CACHE_DIR;
  if (override) return override;
  if (process.platform === "darwin") return path.join(homedir(), "Library", "Application Support", APP_DIR);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), APP_DIR);
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), APP_DIR);
}

/** The single SQLite file holding every cached budget. */
export function defaultDbPath(): string {
  return path.join(defaultCacheDir(), "ynab.sqlite");
}
