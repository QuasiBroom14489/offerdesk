#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, Offerdesk, REPO_ROOT, seedDemo } from '@offerdesk/core';
import { buildServer } from './app.js';

const USAGE = `offerdesk <command>

  serve        start the API and dashboard
  migrate      bring the configured database up to date (e.g. a hosted one)
  seed-demo    reset $OFFERDESK_DB (default data/demo.db) with fictional data
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
      const desk = await Offerdesk.fromConfig(cfg);
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

/** A hosted URL without credentials, or the file path. */
function describeDb(url: string): string {
  return /^[a-z]+:\/\//.test(url) ? new URL(url).host : url;
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
