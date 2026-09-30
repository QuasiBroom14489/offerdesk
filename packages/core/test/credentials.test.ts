import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  credentialStoreFromEnv,
  EncryptedDbCredentialStore,
  parseCredentialsKey,
} from '../src/connectors/index.js';
import { type Db, openDb } from '../src/db.js';

const tokens = { access_token: 'ya29.secret', refresh_token: '1//refresh', expires_at: 1 };

interface Row {
  workspace_id: string;
  provider: string;
  ciphertext: string;
  iv: string;
  tag: string;
}

describe('EncryptedDbCredentialStore', () => {
  let db: Db;
  let key: Buffer;
  let store: EncryptedDbCredentialStore;

  beforeEach(async () => {
    db = await openDb(':memory:');
    key = randomBytes(32);
    store = new EncryptedDbCredentialStore(db, key);
  });
  afterEach(() => db.close());

  it('round-trips a secret and never stores it in plaintext', async () => {
    await store.set('ws1', 'google', tokens);
    expect(await store.get('ws1', 'google')).toEqual(tokens);

    const rows = await db.all<Row>('SELECT * FROM credentials');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('ya29');
    expect(JSON.stringify(rows)).not.toContain('refresh');
  });

  it('uses a fresh IV on every write', async () => {
    await store.set('ws1', 'google', tokens);
    const a = await db.get<Row>('SELECT * FROM credentials');
    await store.set('ws1', 'google', tokens);
    const b = await db.get<Row>('SELECT * FROM credentials');
    expect(b?.iv).not.toBe(a?.iv);
    expect(b?.ciphertext).not.toBe(a?.ciphertext);
    expect(await db.all('SELECT * FROM credentials')).toHaveLength(1);
  });

  it('keeps workspaces and providers apart', async () => {
    await store.set('ws1', 'google', tokens);
    expect(await store.get('ws2', 'google')).toBeNull();
    expect(await store.get('ws1', 'gmail')).toBeNull();
  });

  it('refuses a row moved to another workspace', async () => {
    await store.set('ws1', 'google', tokens);
    await db.run("UPDATE credentials SET workspace_id = 'ws2'");
    await expect(store.get('ws2', 'google')).rejects.toThrow(/could not decrypt/);
  });

  it('refuses the wrong key without leaking the row', async () => {
    await store.set('ws1', 'google', tokens);
    const other = new EncryptedDbCredentialStore(db, randomBytes(32));
    await expect(other.get('ws1', 'google')).rejects.toThrow(/wrong OFFERDESK_CREDENTIALS_KEY/);
  });

  it('deletes', async () => {
    await store.set('ws1', 'google', tokens);
    await store.delete('ws1', 'google');
    expect(await store.get('ws1', 'google')).toBeNull();
  });
});

describe('parseCredentialsKey', () => {
  it('accepts 32 base64 bytes and rejects anything else', () => {
    expect(parseCredentialsKey(randomBytes(32).toString('base64'))).toHaveLength(32);
    expect(() => parseCredentialsKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('credentialStoreFromEnv', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb(':memory:');
  });
  afterEach(() => db.close());

  const hosted = { dataDir: '/tmp/x', dbUrl: 'libsql://example.turso.io' };
  const local = { dataDir: '/tmp/x', dbUrl: '/tmp/x/offerdesk.db' };
  const KEY = randomBytes(32).toString('base64');

  it('encrypts into the database beside a hosted database', () => {
    const store = credentialStoreFromEnv(db, hosted, { OFFERDESK_CREDENTIALS_KEY: KEY });
    expect(store).toBeInstanceOf(EncryptedDbCredentialStore);
  });

  it('has no store on Vercel or a hosted database without a key', () => {
    expect(credentialStoreFromEnv(db, hosted, {})).toBeNull();
    expect(credentialStoreFromEnv(db, local, { VERCEL: '1' })).toBeNull();
  });

  it('keeps a local database on the local store, even with a key set', () => {
    const store = credentialStoreFromEnv(db, local, { OFFERDESK_CREDENTIALS_KEY: KEY });
    expect(store).not.toBeNull();
    expect(store).not.toBeInstanceOf(EncryptedDbCredentialStore);
  });
});
