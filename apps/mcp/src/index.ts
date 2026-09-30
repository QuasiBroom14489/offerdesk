#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileStoreFromEnv, loadConfig, Offerdesk } from '@offerdesk/core';
import { createServer } from './server.js';

/**
 * stdio entry point. Register with:
 *   claude mcp add offerdesk -- node ~/offerdesk/apps/mcp/dist/index.js
 * Uses the same database as the web app (config.toml / $OFFERDESK_DB). For the
 * hosted tracker, pass an env file holding OFFERDESK_DB_URL, TURSO_AUTH_TOKEN
 * and OFFERDESK_WORKSPACE:  node dist/index.js ~/offerdesk/.env.mcp  (ADR 0005).
 * stdout is the protocol channel, so diagnostics go to stderr only.
 */
// Optional argument: an env file to load, e.g. ~/offerdesk/.env.mcp for the
// hosted tracker. A path rather than a node flag, because launchers (Vesper)
// resolve every argument as a path.
const envFile = process.argv[2];
if (envFile) process.loadEnvFile(envFile);

const cfg = loadConfig();
const desk = await Offerdesk.open(cfg.dbUrl, {
  authToken: cfg.dbAuthToken,
  followUpAfterDays: cfg.followUpAfterDays,
  workspaceId: cfg.workspaceId,
  files: fileStoreFromEnv(cfg),
});
const server = createServer(desk);

const shutdown = async () => {
  await server.close();
  desk.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
console.error(`offerdesk mcp: serving ${cfg.dbAuthToken ? 'the hosted database' : cfg.dbUrl}`);
