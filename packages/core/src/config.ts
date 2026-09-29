import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { z } from 'zod';

/** Repo root, resolved from this file (packages/core/{src,dist}/config.*). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const ConfigFile = z.object({
  paths: z
    .object({
      data_dir: z.string().default('./data'),
      vault_root: z.string().default(''),
      vault_applications_dir: z.string().default('04 Areas/Career/Applications'),
    })
    .default({
      data_dir: './data',
      vault_root: '',
      vault_applications_dir: '04 Areas/Career/Applications',
    }),
  followups: z
    .object({ after_days: z.number().int().positive().default(7) })
    .default({ after_days: 7 }),
  server: z.object({ port: z.number().int().default(4417) }).default({ port: 4417 }),
});

export interface OfferdeskConfig {
  dataDir: string;
  dbPath: string;
  filesDir: string;
  vaultRoot: string | null;
  vaultApplicationsDir: string;
  followUpAfterDays: number;
  port: number;
}

/**
 * Load `config.toml` from the repo root (or `$OFFERDESK_CONFIG`). Every field
 * has a default, so a fresh clone runs with no config at all. `$OFFERDESK_DB`
 * overrides the database path — the demo scripts use it to stay away from
 * real data.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): OfferdeskConfig {
  const file = env.OFFERDESK_CONFIG ?? resolve(REPO_ROOT, 'config.toml');
  const raw = existsSync(file) ? parse(readFileSync(file, 'utf8')) : {};
  const cfg = ConfigFile.parse(raw);
  const fromRoot = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));
  const dataDir = fromRoot(cfg.paths.data_dir);
  return {
    dataDir,
    dbPath: env.OFFERDESK_DB ? fromRoot(env.OFFERDESK_DB) : resolve(dataDir, 'offerdesk.db'),
    filesDir: resolve(dataDir, 'files'),
    vaultRoot: cfg.paths.vault_root ? fromRoot(cfg.paths.vault_root) : null,
    vaultApplicationsDir: cfg.paths.vault_applications_dir,
    followUpAfterDays: cfg.followups.after_days,
    port: env.PORT ? Number(env.PORT) : cfg.server.port,
  };
}
