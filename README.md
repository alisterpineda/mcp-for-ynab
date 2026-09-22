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

All the tools answer from the local cache and return compact JSON: amounts are bare
numbers in the currency named once in the response envelope, the keys use YNAB's own words
(`assigned`, `available`, `ready_to_assign`), and the listings are ordered alphabetically rather
than in YNAB's on-screen order, which the API does not expose. Five exceptions: `list_accounts`
groups accounts by type first and orders by name inside each group, `cash_flow` lists its months
in order and its income sources by amount, `spending_breakdown` sorts its rows by amount spent, `search_transactions` returns its rows newest first, and
`budget_vs_actual` puts the most overspent categories first, by amount.

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
- `cash_flow` — are we saving: one row per month with `income`, `spent`, `saved` (income minus
  spent) and `savings_rate`, followed by `total`, `average` and `median` over the complete months.
  `income` is every line on an on-budget account in Inflow: Ready to Assign, which is that
  category's own activity; it can exceed `get_month`'s `income`, which leaves out some inflows
  that land on credit cards. YNAB files a new account's positive starting balance there too, so
  an account opened in the window counts its balance as income and as saved; for a budget's first
  month that can be most of its net worth. `spent` is `spending_breakdown`'s total, so money received into a
  spending category (a tax refund kept in its own category) lowers `spent` rather than raising
  `income`. `to_tracking_accounts` is the part of `spent` that moved to tracking accounts (loan
  and mortgage payments, investment contributions), so a reader who counts those as saving adds
  it back. `saved` is exactly what the on-budget accounts grew by. The averages add up; each median is its own column's.
  `income_sources` sums the income by payee, largest first, with `months_active` to tell a
  paycheque from a one-off (past 25, the rest is summed in `income_sources_other`), and
  `tracking_accounts` does the same for the money moved to each tracking account. The window
  works like `spending_trend`'s: six months ending at the current one, `months` or `start`/`end`
  to change it, cut at the budget's first month, and the current month flagged `partial` and
  left out of the summaries unless `include_partial` is set.
- `spending_breakdown` — where the money went: spending over a date range grouped by `category` (the
  default), `category_group`, `payee`, `account` or `month`. Each row carries `spent`, the line
  `count` and its `share` of the total; rows past the cap (25, or `limit`) are summed into `other`,
  and a month grouping is zero-filled from the budget's first month on and never capped. `start` and
  `end` take `YYYY-MM-DD` or `YYYY-MM` and default to the current month to date. The `categories`,
  `groups`, `payees` and `accounts` filters take ids or names — a whole name first, else a part that
  only one entity contains — and the response echoes what each resolved to under `filters`. The
  response states its `scope` — the spending rule it applied — and counts what that rule dropped
  under `excluded`. `buckets` groups the categories your own way instead of `group_by`: each
  bucket is a name plus the `categories` and `groups` it gathers, by id or name. A category named
  directly stays in its bucket even when another bucket names its group, a category or group
  claimed by two buckets is an error, and whatever no bucket claims (Uncategorized included) is
  listed category by category under `unassigned`, so the rows and `unassigned` add up to the
  total. The buckets travel with every call; the server stores none of them.
- `spending_trend` — whether it is creeping up: a month-by-month series of spending for the
  `categories` and `groups` you name (ids or names, whole or a unique part), one series each in the order asked,
  a group series summing its categories. The window is the last six months ending at the current
  one; `months` changes how many and `start`/`end` as `YYYY-MM` win over it. A window reaching back
  before the budget's history is cut at its first month and says so under `history_starts`. Months
  with no activity read as zero, and each series carries `average`, `min` and `max` over the complete
  months — the current month is flagged `partial` and left out unless `include_partial` is set.
  `buckets` works as it does for `spending_breakdown`: each bucket becomes a series after the ones
  named, and what no bucket claims becomes an `unassigned` series, so the bucket series and
  `unassigned` add up to each month's spending.
- `search_transactions` — the lines behind a number: transactions filtered by date, `categories`,
  `groups`, `payees`, `accounts`, an absolute amount range (`min_amount`/`max_amount` in currency
  units), `direction` and `text` (part of a memo, a payee name or the payee as the bank sent it,
  ignoring case and accents). No spending rule applies, so tracking accounts, transfers and income
  are all reachable; a split comes back as one row per line with its `parent_id`. A row names the
  bank's payee as `imported_payee` when YNAB shows another, and a custom flag name as `flag_name`.
  Rows keep YNAB's sign, come newest first and stop at `limit` (50 by default, 200 at most), while
  `count` and `sum` always cover every match. It is also where the register's chores are:
  `uncategorized: true` finds the lines YNAB wants categorized (on-budget, no category, not a
  transfer to another on-budget account), `approved: false` the imports waiting for approval, and
  `cleared` picks a cleared state. When `uncategorized` is given (either way) or `approved` is false
  and no `start` is, the search covers the whole history rather than the current month.
- `list_scheduled` — what is coming up: every scheduled transaction, soonest first, with its
  frequency in words, `date_next`, amount with YNAB's sign, payee, category, account, the account a
  transfer goes to, and a split's `lines`. A recurring row carries `per_month` (the amount times the
  frequency's occurrences a year, divided by twelve), and the response totals the recurring
  `outflow_per_month` and `inflow_per_month` on on-budget accounts, leaving out transfers to another
  on-budget account. No parameters besides `refresh`; the list is short enough to return whole.
- `budget_vs_actual` — where the plan and the spending disagree: one row per category over a window
  of months with `assigned` and `activity` summed, `available` at the end of the last month, and
  counts of the months that ended in the red (`overspent_months`, with `overspent` the shortfall
  summed) and the months where spending ran past the assignment (`over_assigned_months`). It reads
  YNAB's own per-month figures, so it cannot disagree with the budget screen. The window is the last
  six months ending at the current one; `months` changes how many and `start`/`end` as `YYYY-MM` win
  over it. Categories that are zero throughout are counted in `categories_omitted`; hidden and
  credit card payment categories are kept and marked. `include_months` adds the per-month figures,
  and the current month is flagged `partial_month` and left out of both counts unless
  `include_partial` is set. `categories` and `groups` take ids or names, whole or a unique part.
- `sync_status` — budget name, last sync time, transaction count, date range, and sync health.
  `refresh: true` forces a delta sync; `full_resync: true` re-downloads everything and replaces the
  cache with it, keeping the old copy if the download fails.

## Tests

`npm test` runs the unit tests (delta application, split flattening, sync policy, budget selection)
against an in-memory fake of the YNAB API. They need no credentials.

The live test in `test/integration/` runs only when `YNAB_ACCESS_TOKEN` is set. It is read-only,
uses an in-memory database, and costs four API requests (budget list, full sync, delta sync, and
an invalid-token check). On that sync it also proves the spending rule against the real budget:
for every cached month and category, the spending lines add up to the `activity` YNAB reports,
every line lands in exactly one of spending, transfer, tracking or inflow, the uncategorized lines
add up to YNAB's own Uncategorized activity, the cash flow's income is Ready to Assign's activity
and its income plus spending is what the on-budget accounts grew by, and every real name resolves
back to its own id. Copy `.env.example` to `.env`
and fill in your token; `npm test` loads it automatically. `.env` is git-ignored. Set
`YNAB_BUDGET_ID` as well to test a budget other than your default one.
