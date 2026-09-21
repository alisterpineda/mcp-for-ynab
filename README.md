# ynab-mcp

MCP server for YNAB, packaged as a Claude Desktop extension.

- Install: `npm install`
- Build: `npm run build`
- Inspect: `npm run inspect`
- Test: `npm test`
- Pack: `npm run pack`

## Configuration

| Env var | Required | Purpose |
| --- | --- | --- |
| `YNAB_ACCESS_TOKEN` | yes | Personal access token from https://app.ynab.com/settings/developer |
| `YNAB_BUDGET_ID` | no | Budget to sync. Defaults to YNAB's default (last-used) budget. |
| `YNAB_MCP_CACHE_DIR` | no | Where `cache.json` lives. Defaults to `~/Library/Application Support/ynab-mcp` on macOS. |

## How data flows

The server keeps a local copy of the whole budget (accounts, payees, categories, months,
transactions, split lines, scheduled transactions) in one JSON file and syncs it with YNAB's
delta API: each sync sends the stored `server_knowledge` and receives only what changed since.

- On startup the cache is loaded from disk and a delta sync runs in the background.
- Every tool call syncs first if the cache is older than 5 minutes, then answers from memory.
- If a sync fails and a cache exists, tools answer from the cache and say so.
- A missing, corrupt, older-schema, or wrong-budget cache file is discarded and rebuilt with a full sync.
- The cache file is written atomically (temp file + rename).

Data is as current as YNAB is. Bank imports happen inside YNAB, usually when the app is opened,
and cannot be triggered from the API.

## Tools

- `sync_status` — budget name, last sync time, transaction count, date range, and sync health.
  `refresh: true` forces a delta sync; `full_resync: true` discards the cache and re-downloads everything.

## Tests

`npm test` runs the unit tests (delta merging, split flattening, sync policy, cache recovery)
against an in-memory fake of the YNAB API. They need no credentials.

The live test in `test/integration/` runs only when `YNAB_ACCESS_TOKEN` is set. It is read-only,
uses a temporary cache directory, and costs three API requests. Copy `.env.example` to `.env`
and fill in your token; `npm test` loads it automatically. `.env` is git-ignored. Set
`YNAB_BUDGET_ID` as well to test a budget other than your default one.
