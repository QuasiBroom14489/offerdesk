import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Db } from '../db.js';
import type { CredentialStore, Provider, Secret } from './types.js';

interface CredentialRow {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** Reads a 32-byte key given as base64, e.g. from `openssl rand -base64 32`. */
export function parseCredentialsKey(encoded: string): Buffer {
  const key = Buffer.from(encoded.trim(), 'base64');
  if (key.length !== 32) {
    throw new Error('OFFERDESK_CREDENTIALS_KEY must be 32 bytes, base64 (openssl rand -base64 32)');
  }
  return key;
}

/**
 * Secrets in the database, for hosted deployments with no Keychain (ADR 0007).
 * Each value is AES-256-GCM encrypted with a fresh IV, and the workspace and
 * provider are bound in as associated data, so a row copied to another
 * workspace or provider fails to decrypt. The key never touches the database.
 */
export class EncryptedDbCredentialStore implements CredentialStore {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
    private readonly now: () => number = Date.now,
  ) {
    if (key.length !== 32) throw new Error('credentials key must be 32 bytes');
  }

  private aad(workspaceId: string, provider: Provider): Buffer {
    return Buffer.from(`offerdesk:${workspaceId}:${provider}`);
  }

  async get(workspaceId: string, provider: Provider): Promise<Secret | null> {
    const row = await this.db.get<CredentialRow>(
      'SELECT ciphertext, iv, tag FROM credentials WHERE workspace_id = ? AND provider = ?',
      workspaceId,
      provider,
    );
    if (!row) return null;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'base64'));
    decipher.setAAD(this.aad(workspaceId, provider));
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    let plain: Buffer;
    try {
      plain = Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, 'base64')),
        decipher.final(),
      ]);
    } catch {
      // Never echo the row: a wrong key is the likely cause, and the fix is reconnecting.
      throw new Error(
        `could not decrypt ${provider} credentials (wrong OFFERDESK_CREDENTIALS_KEY?)`,
      );
    }
    return JSON.parse(plain.toString('utf8')) as Secret;
  }

  async set(workspaceId: string, provider: Provider, secret: Secret): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(workspaceId, provider));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(secret), 'utf8'),
      cipher.final(),
    ]);
    await this.db.run(
      `INSERT INTO credentials (workspace_id, provider, ciphertext, iv, tag, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, provider) DO UPDATE SET
         ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
         updated_at = excluded.updated_at`,
      workspaceId,
      provider,
      ciphertext.toString('base64'),
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      this.now(),
    );
  }

  async delete(workspaceId: string, provider: Provider): Promise<void> {
    await this.db.run(
      'DELETE FROM credentials WHERE workspace_id = ? AND provider = ?',
      workspaceId,
      provider,
    );
  }
}
