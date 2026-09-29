import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { FileCredentialStore, MemoryCredentialStore } from '../src/connectors/credentials.js';
import { MIGRATIONS, openDb } from '../src/db.js';
import { Offerdesk } from '../src/offerdesk.js';

describe('workspaces', () => {
  it('never shows one workspace the data of another', async () => {
    const db = await openDb(':memory:');
    const mine = new Offerdesk(db, { workspaceId: 'zane' });
    const theirs = new Offerdesk(db, { workspaceId: 'other' });

    const app = await mine.addApplication({ company: 'Acme', role: 'Intern', status: 'applied' });
    const contact = await mine.addContact({ name: 'Jordan Lee', company: 'Acme' });
    await theirs.addApplication({ company: 'Acme', role: 'Analyst' });

    expect((await mine.listApplications()).map((a) => a.role)).toEqual(['Intern']);
    expect((await theirs.listApplications()).map((a) => a.role)).toEqual(['Analyst']);
    expect(await theirs.listContacts()).toEqual([]);
    expect(await theirs.events.all()).toHaveLength(1);
    expect((await theirs.stats()).total).toBe(1);
    await expect(() => theirs.getApplication(app.id)).rejects.toThrow(/not found/);
    await expect(() =>
      theirs.logOutreach({ contactId: contact.id, channel: 'email' }),
    ).rejects.toThrow(/not found/);
    // Same company name is allowed once per workspace.
    expect((await mine.getApplication(app.id)).companyId).not.toBe(
      (await theirs.listApplications())[0]?.companyId,
    );
  });

  it('records provenance on events, defaulting to manual', async () => {
    const desk = await Offerdesk.open(':memory:');
    const app = await desk.addApplication({ company: 'Acme', role: 'Intern' });
    const ev = await desk.events.append({
      kind: 'note.added',
      applicationId: app.id,
      payload: { text: 'from the screen' },
      source: 'vesper',
    });
    expect(ev.source).toBe('vesper');
    expect((await desk.events.forApplication(app.id)).map((e) => e.source)).toEqual([
      'manual',
      'vesper',
    ]);
  });
});

describe('migration v1 → v2', () => {
  it('upgrades an existing database without losing data', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'offerdesk-')), 'v1.db');
    // A v1 file as the first release wrote it: version kept in user_version.
    const v1 = createClient({ url: `file:${path}` });
    await v1.executeMultiple(`
      ${MIGRATIONS[0]}
      PRAGMA user_version = 1;
      INSERT INTO companies (id, name, created_at) VALUES ('c1', 'Acme', 1);
      INSERT INTO applications (id, company_id, role, created_at) VALUES ('a1', 'c1', 'Intern', 1);
      INSERT INTO events (id, ts, kind, application_id, payload)
        VALUES ('e1', 1, 'application.created', 'a1', '{"status":"applied"}');
    `);
    v1.close();

    const desk = await Offerdesk.open(path);
    const [app] = await desk.listApplications();
    expect(app).toMatchObject({ id: 'a1', companyName: 'Acme', role: 'Intern', status: 'applied' });
    expect((await desk.events.all())[0]?.source).toBe('manual');
    const applied = await desk.db.all<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(applied.map((r) => r.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    // Foreign keys are back on after the rebuild.
    await expect(() =>
      desk.db.exec(
        `INSERT INTO applications (id, company_id, role, created_at) VALUES ('x', 'nope', 'r', 1)`,
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
    desk.close();
  });
});

describe('connections', () => {
  it('upserts per provider and records sync outcomes', async () => {
    let clock = 1000;
    const desk = await Offerdesk.open(':memory:', { now: () => clock });
    await desk.connections.upsert('obsidian', { vaultRoot: '/tmp/vault' }, 'connected');
    await desk.connections.upsert('obsidian', { vaultRoot: '/tmp/other' }, 'connected');
    expect(await desk.connections.list()).toHaveLength(1);
    expect((await desk.connections.get('obsidian'))?.config).toEqual({ vaultRoot: '/tmp/other' });

    clock = 2000;
    await desk.connections.recordSync('obsidian', { ok: true });
    expect(await desk.connections.get('obsidian')).toMatchObject({
      status: 'connected',
      lastSyncedAt: 2000,
    });

    await desk.connections.recordSync('obsidian', { ok: false, error: 'vault not found' });
    expect(await desk.connections.get('obsidian')).toMatchObject({
      status: 'error',
      lastError: 'vault not found',
      lastSyncedAt: 2000,
    });

    const other = new Offerdesk(desk.db, { workspaceId: 'other' });
    expect(await other.connections.list()).toEqual([]);
  });
});

describe('credential stores', () => {
  it('keeps secrets in an owner-only file, scoped by workspace', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'offerdesk-')), 'credentials.json');
    const store = new FileCredentialStore(path);
    await store.set('local', 'google', { refreshToken: 'r1' });
    await store.set('other', 'google', { refreshToken: 'r2' });
    expect(await store.get('local', 'google')).toEqual({ refreshToken: 'r1' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await store.delete('local', 'google');
    expect(await store.get('local', 'google')).toBeNull();
    expect(await store.get('other', 'google')).toEqual({ refreshToken: 'r2' });
  });

  it('memory store round-trips', async () => {
    const store = new MemoryCredentialStore();
    await store.set('local', 'gmail', { token: 't' });
    expect(await store.get('local', 'gmail')).toEqual({ token: 't' });
    expect(await store.get('local', 'google')).toBeNull();
  });
});
