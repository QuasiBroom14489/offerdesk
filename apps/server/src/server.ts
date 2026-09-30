import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig, Offerdesk } from '@offerdesk/core';
import { buildServer } from './app.js';

/**
 * Vercel entry point (ADR 0005). Vercel calls the default export with Node's
 * request and response; Fastify handles them through its own HTTP server once
 * it's ready. The web UI is a separate service, so no webRoot here. The
 * database and Clerk keys come from the environment the Marketplace
 * integrations inject: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, CLERK_*, and
 * BLOB_STORE_ID once a private Blob store is connected (ADR 0006), and the
 * Google client plus OFFERDESK_CREDENTIALS_KEY set by hand (ADR 0007).
 */
const desk = await Offerdesk.fromConfig(loadConfig());
const app = buildServer(desk, { logger: true, auth: 'clerk' });
const ready = app.ready();

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await ready;
  app.server.emit('request', req, res);
}
