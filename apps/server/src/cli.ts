#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, Offerdesk, REPO_ROOT, seedDemo } from '@offerdesk/core';
import { buildServer } from './app.js';

const USAGE = `offerdesk <command>

  serve        start the API and dashboard
  seed-demo    reset $OFFERDESK_DB (default data/demo.db) with fictional data
`;

async function main(argv: string[]): Promise<void> {
  const [command] = argv;
  switch (command) {
    case 'serve': {
      const cfg = loadConfig();
      const desk = Offerdesk.open(cfg.dbPath, { followUpAfterDays: cfg.followUpAfterDays });
      const app = buildServer(desk, {
        webRoot: resolve(REPO_ROOT, 'apps/web/dist'),
        logger: true,
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
      const desk = Offerdesk.open(cfg.dbPath);
      seedDemo(desk);
      desk.close();
      console.log(`seeded demo data into ${cfg.dbPath}`);
      return;
    }
    default:
      process.stdout.write(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
