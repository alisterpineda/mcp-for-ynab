# MCP for YNAB

[![npm](https://img.shields.io/npm/v/mcp-for-ynab)](https://www.npmjs.com/package/mcp-for-ynab)
[![CI](https://github.com/alisterpineda/mcp-for-ynab/actions/workflows/ci.yml/badge.svg)](https://github.com/alisterpineda/mcp-for-ynab/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/mcp-for-ynab)](LICENSE)

An unofficial MCP server for YNAB: read-only spending, cash flow and budget analysis from a local
cache of your budget.

## Install

Create a personal access token at https://app.ynab.com/settings/developer. The npx installs
need Node 22.13 or later.

**Claude Desktop:** download `mcp-for-ynab.mcpb` from the
[latest release](https://github.com/alisterpineda/mcp-for-ynab/releases/latest), open it, and
paste your token when asked.

**Claude Code:**

```sh
claude mcp add --transport stdio --env YNAB_ACCESS_TOKEN=<your-token> ynab -- npx -y mcp-for-ynab
```

**Other MCP clients:**

```json
{
  "mcpServers": {
    "ynab": {
      "command": "npx",
      "args": ["-y", "mcp-for-ynab"],
      "env": { "YNAB_ACCESS_TOKEN": "<your-token>" }
    }
  }
}
```

## Configuration

| Env var | Required | Purpose |
| --- | --- | --- |
| `YNAB_ACCESS_TOKEN` | yes | Personal access token |
| `YNAB_BUDGET_ID` | no | Budget to sync. Defaults to your last-used budget. |
| `MCP_FOR_YNAB_CACHE_DIR` | no | Where the SQLite cache lives. |

## Tools

- `list_categories` — category groups and categories, with ids, notes and goals
- `list_accounts` — account balances and net worth
- `get_month` — a month's budget summary by category
- `cash_flow` — income, spending and savings rate by month
- `spending_breakdown` — spending over a date range, grouped your way
- `spending_trend` — month-by-month spending for chosen categories
- `search_transactions` — find individual transactions
- `list_scheduled` — upcoming scheduled transactions
- `budget_vs_actual` — assigned versus spent by category
- `sync_status` — cache freshness; force a sync

## Development

```sh
npm install
npm run build
npm test      # set YNAB_ACCESS_TOKEN in .env to also run the live test
npm run inspect
```

To release, bump the version in `package.json` and `manifest.json`, commit, and push a `vX.Y.Z` tag.

## Disclaimer

We are not affiliated, associated, or in any way officially connected with YNAB or any of its
subsidiaries or affiliates. The official YNAB website can be found at https://www.ynab.com. The
names YNAB and You Need A Budget, as well as related names, tradenames, marks, trademarks,
emblems, and images are registered trademarks of YNAB.
