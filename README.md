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
- A file built from a different schema is rebuilt: all tables are dropped and a full sync refills them.

Data is as current as YNAB is. Bank imports happen inside YNAB, usually when the app is opened,
and cannot be triggered from the API.

## Tools

All three orientation tools answer from the local cache and return compact JSON: amounts are bare
numbers in the currency named once in the response envelope, the keys use YNAB's own words
(`assigned`, `available`, `ready_to_assign`), and everything is ordered alphabetically rather than
in YNAB's on-screen order, which the API does not expose. The one exception is `list_accounts`,
which groups accounts by type first and orders by name inside each group.

- `list_categories` — what exists and what it is for: category groups and categories with their
  ids, notes and goal definitions. `search` matches part of a category or group name, ignoring
  case and accents, and a group match returns that group's whole list. Hidden categories are left
  out unless `include_hidden` is set; YNAB's internal categories are never listed. No money and
  nothing month-dependent: this is where category ids come from.
- `list_accounts` — where the money is: open accounts split into `on_budget` and `tracking`, each
  section with its own total, plus `net_worth`. Balances come with their cleared and uncleared
  parts and the last reconcile date. Closed accounts are counted in `closed_omitted` and returned
  by `include_closed`; the totals always cover open accounts only.
- `get_month` — how a month is going: income, assigned, activity, Ready to Assign and age of
  money, plus categories nested under their group with subtotals that add up to the header.
  Categories that are zero on all three figures are counted in `categories_omitted` instead of
  listed. `month` is `YYYY-MM` and defaults to the current month; `refresh: true` pulls from YNAB
  first. Deliberately carries no ids.
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
