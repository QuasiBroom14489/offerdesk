#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, Offerdesk, REPO_ROOT, seedDemo } from '@offerdesk/core';
import { buildServer } from './app.js';

const USAGE = `offerdesk <command>

  serve            start the API and dashboard
  read-screenshots read screenshots queued by the hosted dashboard, on this
                   computer's Claude login (ADR 0009); runs until stopped
  migrate          bring the configured database up to date (e.g. a hosted one)
  seed-demo        reset $OFFERDESK_DB (default data/demo.db) with fictional data
`;

async function main(argv: string[]): Promise<void> {
  // Local secrets (Google OAuth client, credentials key) live in a gitignored
  // .env at the repo root; on Vercel they come from the project's environment.
  const envFile = resolve(REPO_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const [command] = argv;
  switch (command) {
    case 'serve': {
      const cfg = loadConfig();
      // A hosted database (`start:hosted`) is opened in the owner's workspace.
      const desk = await Offerdesk.fromConfig(cfg, { workspaceId: cfg.workspaceId });
      const app = buildServer(desk, {
        webRoot: resolve(REPO_ROOT, 'apps/web/dist'),
        logger: true,
        // Signing in is on only when Clerk is configured; locally it's one workspace.
        auth: process.env.CLERK_SECRET_KEY ? 'clerk' : undefined,
      });
      const close = async () => {
        await app.close();
        desk.close();
        process.exit(0);
      };
      process.on('SIGINT', close);
      process.on('SIGTERM', close);
      await app.listen({ port: cfg.port, host: '127.0.0.1' });
      return;
    }
    case 'read-screenshots': {
      await readScreenshots();
      return;
    }
    case 'migrate': {
      // Opening a database migrates it.
      const cfg = loadConfig();
      const desk = await Offerdesk.open(cfg.dbUrl, { authToken: cfg.dbAuthToken });
      desk.close();
      console.log(`migrated ${describeDb(cfg.dbUrl)}`);
      return;
    }
    case 'seed-demo': {
      // Demo data never touches the real database unless explicitly pointed at it.
      const cfg = loadConfig({
        ...process.env,
        OFFERDESK_DB: process.env.OFFERDESK_DB ?? 'data/demo.db',
      });
      if (cfg.dbPath === loadConfig({}).dbPath) {
        throw new Error(`refusing to seed demo data into the main database at ${cfg.dbPath}`);
      }
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(cfg.dbPath + suffix)) rmSync(cfg.dbPath + suffix);
      }
      const desk = await Offerdesk.open(cfg.dbPath);
      await seedDemo(desk);
      desk.close();
      console.log(`seeded demo data into ${cfg.dbPath}`);
      return;
    }
    default:
      process.stdout.write(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

/** How often an idle reader looks for work, and how often it checks in. */
const POLL_MS = 2000;
const HEARTBEAT_MS = 30_000;

/**
 * Read screenshots the hosted dashboard queued (ADR 0009), with the Claude
 * login on this computer. Run with the hosted database's env file
 * (`pnpm reader`), so it works on the owner's workspace.
 */
async function readScreenshots(): Promise<void> {
  const cfg = loadConfig();
  const desk = await Offerdesk.fromConfig(cfg, { workspaceId: cfg.workspaceId });
  if (desk.screenshotMode !== 'here' || !desk.screenshotQueue) {
    desk.close();
    throw new Error(
      'the reader needs a file store (BLOB_READ_WRITE_TOKEN) and Claude Code on this computer',
    );
  }
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
  log(`reading screenshots for ${cfg.workspaceId} on ${describeDb(cfg.dbUrl)}`);

  let lastBeat = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastBeat >= HEARTBEAT_MS) {
        await desk.screenshotQueue.heartbeat();
        lastBeat = Date.now();
      }
      const done = await desk.readQueuedScreenshots();
      if (done) {
        log(`${done.status} ${done.id}`);
        continue;
      }
    } catch (err) {
      // A network blip shouldn't stop the reader; it tries again next poll.
      log(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  desk.close();
  log('stopped');
}

/** A hosted URL without credentials, or the file path. */
function describeDb(url: string): string {
  return /^[a-z]+:\/\//.test(url) ? new URL(url).host : url;
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
