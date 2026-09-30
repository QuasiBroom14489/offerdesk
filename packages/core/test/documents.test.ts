import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnavailableError } from '../src/errors.js';
import { DiskFileStore, fileStoreFromEnv, MemoryFileStore } from '../src/files/index.js';
import { Offerdesk } from '../src/offerdesk.js';

const bytes = (s: string) => new TextEncoder().encode(s);
/** The first item, failing the test if there is none. */
function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error('expected at least one item');
  return item;
}
const pdf = (filename: string) => ({ filename, contentType: 'application/pdf' });

describe('documents library', () => {
  let clock: number;
  let files: MemoryFileStore;
  let desk: Offerdesk;

  beforeEach(async () => {
    clock = Date.UTC(2026, 9, 1, 12);
    files = new MemoryFileStore();
    desk = await Offerdesk.open(':memory:', { now: () => clock++, files });
  });

  it('stores a document with its first version and reads the bytes back', async () => {
    const doc = await desk.documents.create(
      { name: 'Resume — data', kind: 'resume' },
      bytes('v1'),
      pdf('resume.pdf'),
    );
    expect(doc).toMatchObject({ name: 'Resume — data', kind: 'resume', archivedAt: null });
    expect(doc.versions.map((v) => [v.version, v.filename, v.size])).toEqual([
      [1, 'resume.pdf', 2],
    ]);
    const { bytes: back } = await desk.documents.read(first(doc.versions).id);
    expect(new TextDecoder().decode(back)).toBe('v1');
  });

  it('adds versions newest first and stores identical bytes once', async () => {
    const doc = await desk.documents.create({ name: 'Resume' }, bytes('same'), pdf('a.pdf'));
    await desk.documents.addVersion(doc.id, bytes('same'), pdf('b.pdf'));
    const v3 = await desk.documents.addVersion(doc.id, bytes('new'), {
      ...pdf('c.pdf'),
      note: 'Added the SQL project',
    });
    expect(v3.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(first(v3.versions).note).toBe('Added the SQL project');
    expect(files.files.size).toBe(2);
  });

  it('refuses empty and oversized files', async () => {
    await expect(desk.documents.create({ name: 'x' }, bytes(''), pdf('x.pdf'))).rejects.toThrow(
      /empty/,
    );
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    await expect(desk.documents.create({ name: 'x' }, big, pdf('x.pdf'))).rejects.toThrow(/4 MB/);
    expect(await desk.documents.list()).toEqual([]);
  });

  it('never lets a version be edited or deleted', async () => {
    await desk.documents.create({ name: 'Resume' }, bytes('v1'), pdf('r.pdf'));
    await expect(desk.db.exec("UPDATE document_versions SET filename = 'x'")).rejects.toThrow(
      /immutable/,
    );
    await expect(desk.db.exec('DELETE FROM document_versions')).rejects.toThrow(/immutable/);
  });

  it('attaches a pinned version, re-pins, and detaches through events', async () => {
    const app = await desk.addApplication({ company: 'Acme', role: 'Data Intern' });
    const doc = await desk.documents.create(
      { name: 'Resume', kind: 'resume' },
      bytes('v1'),
      pdf('r.pdf'),
    );
    const v1 = first(doc.versions);

    await desk.attachDocument(app.id, doc.id);
    await desk.attachDocument(app.id, doc.id); // same version: no-op
    await desk.documents.addVersion(doc.id, bytes('v2'), pdf('r2.pdf'));

    let detail = await desk.getApplicationDetail(app.id);
    expect(detail.documents.map((d) => d.version.id)).toEqual([v1.id]);
    expect((await desk.documents.get(doc.id)).applicationIds).toEqual([app.id]);

    await desk.attachDocument(app.id, doc.id); // latest is now v2
    detail = await desk.getApplicationDetail(app.id);
    expect(first(detail.documents).version.version).toBe(2);

    await desk.detachDocument(app.id, doc.id);
    await desk.detachDocument(app.id, doc.id); // already gone: no-op
    detail = await desk.getApplicationDetail(app.id);
    expect(detail.documents).toEqual([]);
    expect(detail.timeline.map((e) => e.kind)).toEqual([
      'application.created',
      'document.attached',
      'document.attached',
      'document.detached',
    ]);
  });

  it('archives without losing versions', async () => {
    const doc = await desk.documents.create({ name: 'Old resume' }, bytes('v1'), pdf('r.pdf'));
    await desk.documents.update(doc.id, { archived: true });
    expect(await desk.documents.list()).toEqual([]);
    const [archived] = await desk.documents.list({ archived: true });
    expect(archived?.versions).toHaveLength(1);
    await desk.documents.update(doc.id, { archived: false, name: 'Resume 2025' });
    expect((await desk.documents.list())[0]?.name).toBe('Resume 2025');
  });

  it('keeps workspaces apart, down to the file keys', async () => {
    const other = desk.forWorkspace('someone-else');
    const mine = await desk.documents.create({ name: 'Mine' }, bytes('same'), pdf('m.pdf'));
    await other.documents.create({ name: 'Theirs' }, bytes('same'), pdf('t.pdf'));
    expect((await other.documents.list()).map((d) => d.name)).toEqual(['Theirs']);
    await expect(other.documents.get(mine.id)).rejects.toThrow(/not found/);
    await expect(other.documents.read(first(mine.versions).id)).rejects.toThrow(/not found/);
    const app = await other.addApplication({ company: 'Acme', role: 'Intern' });
    await expect(other.attachDocument(app.id, mine.id)).rejects.toThrow(/not found/);
    expect(files.files.size).toBe(2);
  });

  it('says so when no file store is configured', async () => {
    const bare = await Offerdesk.open(':memory:');
    await expect(bare.documents.create({ name: 'x' }, bytes('x'), pdf('x.pdf'))).rejects.toThrow(
      UnavailableError,
    );
    expect(await bare.documents.list()).toEqual([]);
  });
});

describe('file stores', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'offerdesk-files-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes to disk once per key and rejects path tricks', async () => {
    const store = new DiskFileStore(dir);
    await store.put('local/abc', bytes('one'), 'text/plain');
    await store.put('local/abc', bytes('two'), 'text/plain');
    expect(new TextDecoder().decode((await store.get('local/abc')) ?? new Uint8Array())).toBe(
      'one',
    );
    expect(await store.get('local/missing')).toBeNull();
    await expect(store.get('../etc/passwd')).rejects.toThrow(/bad file key/);
  });

  it('picks Blob when connected, disk beside a local database, and nothing otherwise', () => {
    const local = { filesDir: dir, dbUrl: join(dir, 'x.db') };
    expect(fileStoreFromEnv(local, {})?.name).toBe('disk');
    expect(fileStoreFromEnv(local, { BLOB_STORE_ID: 'store_1' })?.name).toBe('vercel-blob');
    expect(fileStoreFromEnv(local, { VERCEL: '1' })).toBeNull();
    expect(fileStoreFromEnv({ filesDir: dir, dbUrl: 'libsql://x.turso.io' }, {})).toBeNull();
  });
});
