import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Where document bytes live (ADR 0006). Keys are content addresses,
 * `<workspace>/<sha256>`: the same bytes always get the same key, and a key
 * never changes meaning, so `put` is idempotent and nothing is ever
 * overwritten with different content.
 */
export interface FileStore {
  /** Short name for logs and the health check, e.g. `disk` or `vercel-blob`. */
  readonly name: string;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** The bytes, or null when nothing is stored under the key. */
  get(key: string): Promise<Uint8Array | null>;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function fileKey(workspaceId: string, hash: string): string {
  return `${encodeURIComponent(workspaceId)}/${hash}`;
}

/** Local files under `data/files/`. Writes land in a temp file first, then rename. */
export class DiskFileStore implements FileStore {
  readonly name = 'disk';

  constructor(private readonly root: string) {}

  private path(key: string): string {
    if (key.split('/').some((part) => part === '..' || part === '')) {
      throw new Error(`bad file key: ${key}`);
    }
    return join(this.root, key);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.path(key);
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, path);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const path = this.path(key);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }
}

/** For tests. */
export class MemoryFileStore implements FileStore {
  readonly name = 'memory';
  readonly files = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    if (!this.files.has(key)) this.files.set(key, { bytes, contentType });
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.files.get(key)?.bytes ?? null;
  }
}
