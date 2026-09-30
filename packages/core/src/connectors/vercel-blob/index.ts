import { get, put } from '@vercel/blob';
import type { FileStore } from '../../files/store.js';

/**
 * Document bytes in a private Vercel Blob store (ADR 0006). On Vercel the
 * SDK authenticates with the project's OIDC token and `BLOB_STORE_ID`;
 * elsewhere with `BLOB_READ_WRITE_TOKEN`. Private blobs have no public URL:
 * the API streams them to a signed-in caller.
 */
export class VercelBlobFileStore implements FileStore {
  readonly name = 'vercel-blob';

  private path(key: string): string {
    return `documents/${key}`;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    // Content-addressed: an existing blob at this key already has these bytes.
    await put(this.path(key), Buffer.from(bytes), {
      access: 'private',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await get(this.path(key), { access: 'private' });
    if (res?.statusCode !== 200) return null;
    return new Uint8Array(await new Response(res.stream).arrayBuffer());
  }
}

/** True when the environment has credentials for a Blob store. */
export function vercelBlobConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.BLOB_STORE_ID || env.BLOB_READ_WRITE_TOKEN);
}
