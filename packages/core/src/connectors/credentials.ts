import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Db } from '../db.js';
import { EncryptedDbCredentialStore, parseCredentialsKey } from './encrypted-credentials.js';
import type { CredentialStore, Provider, Secret } from './types.js';

const SERVICE_PREFIX = 'offerdesk';

function key(workspaceId: string, provider: Provider): string {
  return `${SERVICE_PREFIX}:${workspaceId}:${provider}`;
}

/**
 * macOS Keychain via the `security` CLI. Commands are fed on stdin through
 * `security -i` so secrets never appear in the process list, and values are
 * base64-encoded so no quoting can break the command.
 */
export class KeychainCredentialStore implements CredentialStore {
  private run(command: string): { ok: boolean; out: string } {
    const r = spawnSync('/usr/bin/security', ['-i'], { input: `${command}\n`, encoding: 'utf8' });
    return { ok: r.status === 0 && !/error|could not be found/i.test(r.stderr), out: r.stdout };
  }

  async get(workspaceId: string, provider: Provider): Promise<Secret | null> {
    const r = spawnSync(
      '/usr/bin/security',
      ['find-generic-password', '-a', SERVICE_PREFIX, '-s', key(workspaceId, provider), '-w'],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) return null;
    return JSON.parse(Buffer.from(r.stdout.trim(), 'base64').toString('utf8')) as Secret;
  }

  async set(workspaceId: string, provider: Provider, secret: Secret): Promise<void> {
    const value = Buffer.from(JSON.stringify(secret)).toString('base64');
    const r = this.run(
      `add-generic-password -U -a ${SERVICE_PREFIX} -s ${key(workspaceId, provider)} -w ${value}`,
    );
    if (!r.ok) throw new Error(`could not save ${provider} credentials to the Keychain`);
  }

  async delete(workspaceId: string, provider: Provider): Promise<void> {
    spawnSync(
      '/usr/bin/security',
      ['delete-generic-password', '-a', SERVICE_PREFIX, '-s', key(workspaceId, provider)],
      { encoding: 'utf8' },
    );
  }
}

/** A JSON file readable only by the owner. For Linux, CI, and machines without a Keychain. */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly path: string) {}

  private read(): Record<string, Secret> {
    if (!existsSync(this.path)) return {};
    return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, Secret>;
  }

  private write(all: Record<string, Secret>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  async get(workspaceId: string, provider: Provider): Promise<Secret | null> {
    return this.read()[key(workspaceId, provider)] ?? null;
  }

  async set(workspaceId: string, provider: Provider, secret: Secret): Promise<void> {
    this.write({ ...this.read(), [key(workspaceId, provider)]: secret });
  }

  async delete(workspaceId: string, provider: Provider): Promise<void> {
    const all = this.read();
    delete all[key(workspaceId, provider)];
    this.write(all);
  }
}

/** For tests. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly map = new Map<string, Secret>();
  async get(workspaceId: string, provider: Provider) {
    return this.map.get(key(workspaceId, provider)) ?? null;
  }
  async set(workspaceId: string, provider: Provider, secret: Secret) {
    this.map.set(key(workspaceId, provider), secret);
  }
  async delete(workspaceId: string, provider: Provider) {
    this.map.delete(key(workspaceId, provider));
  }
}

/** Keychain on macOS, otherwise a 0600 file under the data directory. */
export function defaultCredentialStore(dataDir: string): CredentialStore {
  return process.platform === 'darwin'
    ? new KeychainCredentialStore()
    : new FileCredentialStore(`${dataDir}/credentials.json`);
}

/**
 * Where this process keeps connector secrets (ADR 0007). Beside a hosted
 * database, on Vercel or on a laptop pointed at Turso (the MCP server), secrets
 * go in the shared database, encrypted with `OFFERDESK_CREDENTIALS_KEY`; with no
 * key there is no store, and connectors report themselves unavailable. Beside a
 * local database, the Keychain or a 0600 file.
 */
export function credentialStoreFromEnv(
  db: Db,
  cfg: { dataDir: string; dbUrl: string },
  env: NodeJS.ProcessEnv = process.env,
): CredentialStore | null {
  const hostedDb = /^(libsql|https?|wss?):/.test(cfg.dbUrl);
  if (!env.VERCEL && !hostedDb) return defaultCredentialStore(cfg.dataDir);
  if (!env.OFFERDESK_CREDENTIALS_KEY) return null;
  return new EncryptedDbCredentialStore(db, parseCredentialsKey(env.OFFERDESK_CREDENTIALS_KEY));
}
