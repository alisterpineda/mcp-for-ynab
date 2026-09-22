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
| `YNAB_MCP_CACHE_DIR` | no | Where `ynab.sqlite` lives. Defaults to `~/Library/Application Support/ynab-mcp` on macOS. |

## How data flows

The server keeps a local copy of the whole budget (accounts, payees, payee locations, categories,
months, transactions, split lines, scheduled transactions) in one SQLite file (`node:sqlite`, WAL mode)
and syncs it with YNAB's delta API: each sync sends the stored `server_knowledge` and receives
only what changed since.

- On startup the cache is opened from disk and a delta sync runs in the background.
- Every tool call syncs first if the cache is older than 5 minutes, then answers from the local database.
- A delta is applied in one database transaction and rolled back if anything fails, so the cache
  is never left half-updated.
- If a sync fails and a cache exists, tools answer from the cache and say so.
- Several budgets can live in the same file, each with its own `server_knowledge`, so switching
  `YNAB_BUDGET_ID` keeps the other budget delta-synced. The account's budget list is cached too;
  `sync_status` shows the other budgets.
- A file with a different schema version is rebuilt: all tables are dropped and a full sync refills them.

Data is as current as YNAB is. Bank imports happen inside YNAB, usually when the app is opened,
and cannot be triggered from the API.

## Tools

- `sync_status` — budget name, last sync time, transaction count, date range, and sync health.
  `refresh: true` forces a delta sync; `full_resync: true` discards the cache and re-downloads everything.

## Tests

`npm test` runs the unit tests (delta application, split flattening, sync policy, budget selection)
against an in-memory fake of the YNAB API. They need no credentials.

The live test in `test/integration/` runs only when `YNAB_ACCESS_TOKEN` is set. It is read-only,
uses an in-memory database, and costs four API requests (budget list, full sync, delta sync, and
an invalid-token check). Copy `.env.example` to `.env`
and fill in your token; `npm test` loads it automatically. `.env` is git-ignored. Set
`YNAB_BUDGET_ID` as well to test a budget other than your default one.
