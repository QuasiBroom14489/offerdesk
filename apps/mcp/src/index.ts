#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, Offerdesk } from '@offerdesk/core';
import { createServer } from './server.js';

/**
 * stdio entry point. Register with:
 *   claude mcp add offerdesk -- node ~/offerdesk/apps/mcp/dist/index.js
 * Uses the same database as the web app (config.toml / $OFFERDESK_DB).
 * stdout is the protocol channel, so diagnostics go to stderr only.
 */
const cfg = loadConfig();
const desk = Offerdesk.open(cfg.dbPath, { followUpAfterDays: cfg.followUpAfterDays });
const server = createServer(desk);

const shutdown = async () => {
  await server.close();
  desk.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
console.error(`offerdesk mcp: serving ${cfg.dbPath}`);
