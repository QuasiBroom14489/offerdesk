import { VercelBlobFileStore, vercelBlobConfigured } from '../connectors/vercel-blob/index.js';
import { DiskFileStore, type FileStore } from './store.js';

export { DiskFileStore, type FileStore, fileKey, MemoryFileStore, sha256 } from './store.js';
export { VercelBlobFileStore };

/**
 * Pick the store for this process: a Blob store when one is connected, else
 * local disk — but only next to a local database. A serverless disk vanishes
 * after the request, and a laptop disk paired with the hosted database would
 * leave rows whose bytes the hosted app can't read, so both get no store and
 * the documents API says so instead.
 */
export function fileStoreFromEnv(
  cfg: { filesDir: string; dbUrl: string },
  env: NodeJS.ProcessEnv = process.env,
): FileStore | null {
  if (vercelBlobConfigured(env)) return new VercelBlobFileStore();
  const hostedDb = /^(libsql|https?|wss?):/.test(cfg.dbUrl);
  if (env.VERCEL || hostedDb) return null;
  return new DiskFileStore(cfg.filesDir);
}
