import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig, Offerdesk } from '@offerdesk/core';
import { buildServer } from './app.js';

/**
 * Vercel entry point (ADR 0005). Vercel calls the default export with Node's
 * request and response; Fastify handles them through its own HTTP server once
 * it's ready. The web UI is a separate service, so no webRoot here. The
 * database and Clerk keys come from the environment the Marketplace
 * integrations inject: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, CLERK_*.
 */
const cfg = loadConfig();
const desk = await Offerdesk.open(cfg.dbUrl, {
  authToken: cfg.dbAuthToken,
  followUpAfterDays: cfg.followUpAfterDays,
});
const app = buildServer(desk, { logger: true, auth: 'clerk' });
const ready = app.ready();

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await ready;
  app.server.emit('request', req, res);
}
