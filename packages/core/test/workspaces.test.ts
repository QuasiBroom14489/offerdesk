import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { FileCredentialStore, MemoryCredentialStore } from '../src/connectors/credentials.js';
import { MIGRATIONS, openDb } from '../src/db.js';
import { Offerdesk } from '../src/offerdesk.js';

describe('workspaces', () => {
  it('never shows one workspace the data of another', () => {
    const db = openDb(':memory:');
    const mine = new Offerdesk(db, { workspaceId: 'zane' });
    const theirs = new Offerdesk(db, { workspaceId: 'other' });

    const app = mine.addApplication({ company: 'Acme', role: 'Intern', status: 'applied' });
    const contact = mine.addContact({ name: 'Jordan Lee', company: 'Acme' });
    theirs.addApplication({ company: 'Acme', role: 'Analyst' });

    expect(mine.listApplications().map((a) => a.role)).toEqual(['Intern']);
    expect(theirs.listApplications().map((a) => a.role)).toEqual(['Analyst']);
    expect(theirs.listContacts()).toEqual([]);
    expect(theirs.events.all()).toHaveLength(1);
    expect(theirs.stats().total).toBe(1);
    expect(() => theirs.getApplication(app.id)).toThrow(/not found/);
    expect(() => theirs.logOutreach({ contactId: contact.id, channel: 'email' })).toThrow(
      /not found/,
    );
    // Same company name is allowed once per workspace.
    expect(mine.getApplication(app.id).companyId).not.toBe(theirs.listApplications()[0]?.companyId);
  });

  it('records provenance on events, defaulting to manual', () => {
    const desk = Offerdesk.open(':memory:');
    const app = desk.addApplication({ company: 'Acme', role: 'Intern' });
    const ev = desk.events.append({
      kind: 'note.added',
      applicationId: app.id,
      payload: { text: 'from the screen' },
      source: 'vesper',
    });
    expect(ev.source).toBe('vesper');
    expect(desk.events.forApplication(app.id).map((e) => e.source)).toEqual(['manual', 'vesper']);
  });
});

describe('migration v1 → v2', () => {
  it('upgrades an existing database without losing data', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'offerdesk-')), 'v1.db');
    const v1 = new DatabaseSync(path);
    v1.exec(MIGRATIONS[0] as string);
    v1.exec('PRAGMA user_version = 1');
    v1.exec(`INSERT INTO companies (id, name, created_at) VALUES ('c1', 'Acme', 1)`);
    v1.exec(
      `INSERT INTO applications (id, company_id, role, created_at) VALUES ('a1', 'c1', 'Intern', 1)`,
    );
    v1.exec(
      `INSERT INTO events (id, ts, kind, application_id, payload)
       VALUES ('e1', 1, 'application.created', 'a1', '{"status":"applied"}')`,
    );
    v1.close();

    const desk = Offerdesk.open(path);
    const [app] = desk.listApplications();
    expect(app).toMatchObject({ id: 'a1', companyName: 'Acme', role: 'Intern', status: 'applied' });
    expect(desk.events.all()[0]?.source).toBe('manual');
    expect(
      (desk.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(MIGRATIONS.length);
    // Foreign keys are back on after the rebuild.
    expect(() =>
      desk.db.exec(
        `INSERT INTO applications (id, company_id, role, created_at) VALUES ('x', 'nope', 'r', 1)`,
      ),
    ).toThrow(/FOREIGN KEY/);
    desk.close();
  });
});

describe('connections', () => {
  it('upserts per provider and records sync outcomes', () => {
    let clock = 1000;
    const desk = Offerdesk.open(':memory:', { now: () => clock });
    desk.connections.upsert('obsidian', { vaultRoot: '/tmp/vault' }, 'connected');
    desk.connections.upsert('obsidian', { vaultRoot: '/tmp/other' }, 'connected');
    expect(desk.connections.list()).toHaveLength(1);
    expect(desk.connections.get('obsidian')?.config).toEqual({ vaultRoot: '/tmp/other' });

    clock = 2000;
    desk.connections.recordSync('obsidian', { ok: true });
    expect(desk.connections.get('obsidian')).toMatchObject({
      status: 'connected',
      lastSyncedAt: 2000,
    });

    desk.connections.recordSync('obsidian', { ok: false, error: 'vault not found' });
    expect(desk.connections.get('obsidian')).toMatchObject({
      status: 'error',
      lastError: 'vault not found',
      lastSyncedAt: 2000,
    });

    const other = new Offerdesk(desk.db, { workspaceId: 'other' });
    expect(other.connections.list()).toEqual([]);
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
