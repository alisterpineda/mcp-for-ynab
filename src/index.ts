import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../package.json" with { type: "json" };

// stdout carries the MCP protocol; all logging goes to stderr.
const log = (message: string): void => console.error(`[ynab-mcp] ${message}`);

const token = process.env.YNAB_ACCESS_TOKEN;
if (!token) {
  log("YNAB_ACCESS_TOKEN is not set. Configure it in the extension settings and restart.");
  process.exit(1);
}

const version: string = pkg.version;

const server = new McpServer({ name: "ynab-mcp", version });

await server.connect(new StdioServerTransport());
log(`started v${version}`);
