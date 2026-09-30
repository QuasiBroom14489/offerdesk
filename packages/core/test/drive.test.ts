import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Fetch, MemoryCredentialStore } from '../src/connectors/index.js';
import { MemoryFileStore } from '../src/files/index.js';
import { Offerdesk } from '../src/offerdesk.js';

interface DriveFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  trashed?: boolean;
  appProperties?: Record<string, string>;
  parents?: string[];
}

const text = (s: string) => new TextEncoder().encode(s);
const RESUME_ID = 'resumeFile0001';
const DOC_ID = 'coverGoogleDoc01';

/** Drive metadata, downloads, exports, uploads and appProperties queries, in memory. */
class FakeDrive {
  files = new Map<string, DriveFile>();
  uploads: { metadata: Record<string, unknown>; body: string }[] = [];
  private n = 0;

  fetch: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname === '/upload/drive/v3/files') {
      const body = Buffer.from(init?.body as Uint8Array).toString('latin1');
      const metadata = JSON.parse(body.match(/\r\n\r\n(\{.*\})\r\n/)?.[1] ?? '{}');
      this.uploads.push({ metadata, body });
      const id = `upload${String(++this.n).padStart(8, '0')}`;
      this.files.set(id, { ...metadata, mimeType: 'application/pdf', bytes: new Uint8Array() });
      return json(200, { id, webViewLink: `https://drive.google.com/file/d/${id}/view` });
    }
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const prop = q.match(/key='(\w+)' and value='([\w-]+)'/);
      const hits = [...this.files.entries()].filter(([, f]) => {
        if (f.trashed) return false;
        if (prop) return f.appProperties?.[prop[1] as string] === prop[2];
        return q.includes(`'${f.name}'`) && q.includes(f.mimeType);
      });
      return json(200, {
        files: hits.map(([id]) => ({
          id,
          webViewLink: `https://drive.google.com/file/d/${id}/view`,
        })),
      });
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      const id = `folder${String(++this.n).padStart(8, '0')}`;
      this.files.set(id, { ...body, bytes: new Uint8Array() });
      return json(200, { id });
    }
    const m = url.pathname.match(/^\/drive\/v3\/files\/([\w-]+)(\/export)?$/);
    const file = m ? this.files.get(m[1] as string) : undefined;
    if (!m || !file) return json(404, { error: { message: 'File not found' } });
    if (m[2]) {
      return new Response(text(`%PDF export of ${file.name}`), { status: 200 });
    }
    if (url.searchParams.get('alt') === 'media') return new Response(file.bytes, { status: 200 });
    return json(200, {
      name: file.name,
      mimeType: file.mimeType,
      size: String(file.bytes.byteLength),
      trashed: file.trashed ?? false,
    });
  };
}

describe('Drive documents', () => {
  let drive: FakeDrive;
  let desk: Offerdesk;

  beforeEach(async () => {
    drive = new FakeDrive();
    drive.files.set(RESUME_ID, {
      name: 'Jane Doe Resume.pdf',
      mimeType: 'application/pdf',
      bytes: text('%PDF resume v1'),
    });
    drive.files.set(DOC_ID, {
      name: 'Acme cover letter',
      mimeType: 'application/vnd.google-apps.document',
      bytes: new Uint8Array(),
    });
    const credentials = new MemoryCredentialStore();
    await credentials.set('local', 'google', {
      accessToken: 'live',
      refreshToken: 'r',
      expiresAt: Date.UTC(2030, 0, 1),
      scope: 'https://www.googleapis.com/auth/drive.file',
    });
    desk = await Offerdesk.open(':memory:', {
      credentials,
      google: { clientId: 'c', clientSecret: 's' },
      fetch: drive.fetch,
      files: new MemoryFileStore(),
    });
  });
  afterEach(() => desk.close());

  it('imports picked files as documents, exporting Google Docs as PDF', async () => {
    const results = await desk.importFromDrive({ fileIds: [RESUME_ID, DOC_ID] });
    expect(results.map((r) => r.outcome)).toEqual(['created', 'created']);

    const [resume, cover] = results.map((r) => r.document);
    expect(resume).toMatchObject({ name: 'Jane Doe Resume', kind: 'resume' });
    expect(resume?.versions[0]).toMatchObject({
      filename: 'Jane Doe Resume.pdf',
      source: 'drive',
      sourceRef: RESUME_ID,
    });
    expect(cover).toMatchObject({ name: 'Acme cover letter', kind: 'cover-letter' });
    expect(cover?.versions[0]).toMatchObject({
      filename: 'Acme cover letter.pdf',
      contentType: 'application/pdf',
    });
    const { bytes } = await desk.documents.read(cover?.versions[0]?.id as string);
    expect(new TextDecoder().decode(bytes)).toBe('%PDF export of Acme cover letter');
  });

  it('re-importing adds a version only when the file changed', async () => {
    await desk.importFromDrive({ fileIds: [RESUME_ID] });
    const again = await desk.importFromDrive({ fileIds: [RESUME_ID] });
    expect(again[0]?.outcome).toBe('unchanged');

    (drive.files.get(RESUME_ID) as DriveFile).bytes = text('%PDF resume v2');
    const edited = await desk.importFromDrive({ fileIds: [RESUME_ID] });
    expect(edited[0]?.outcome).toBe('new-version');
    expect(edited[0]?.document.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(await desk.documents.list()).toHaveLength(1);
  });

  it('attaches imports to an application, marked as from Drive', async () => {
    const app = await desk.addApplication({ company: 'Acme', role: 'Data Intern' });
    await desk.importFromDrive({ fileIds: [RESUME_ID], applicationId: app.id, kind: 'other' });
    const detail = await desk.getApplicationDetail(app.id);
    expect(detail.documents.map((d) => d.document.kind)).toEqual(['other']);
    const attached = detail.timeline.find((e) => e.kind === 'document.attached');
    expect(attached?.source).toBe('drive');
  });

  it('refuses files over 4 MB, folders, trashed files and odd ids', async () => {
    drive.files.set('bigFile000001', {
      name: 'huge.pdf',
      mimeType: 'application/pdf',
      bytes: new Uint8Array(5 * 1024 * 1024),
    });
    await expect(desk.importFromDrive({ fileIds: ['bigFile000001'] })).rejects.toThrow(/4 MB/);
    drive.files.set('aFolder000001', {
      name: 'Stuff',
      mimeType: 'application/vnd.google-apps.folder',
      bytes: new Uint8Array(),
    });
    await expect(desk.importFromDrive({ fileIds: ['aFolder000001'] })).rejects.toThrow(/folder/);
    (drive.files.get(RESUME_ID) as DriveFile).trashed = true;
    await expect(desk.importFromDrive({ fileIds: [RESUME_ID] })).rejects.toThrow(/trash/);
    await expect(desk.importFromDrive({ fileIds: ["x' or name != '"] })).rejects.toThrow(
      /not a valid id/,
    );
  });

  it('saves a version to the OfferDesk folder once, then returns the same copy', async () => {
    const [imported] = await desk.importFromDrive({ fileIds: [RESUME_ID] });
    const versionId = imported?.document.versions[0]?.id as string;

    const first = await desk.saveVersionToDrive(versionId);
    expect(first.created).toBe(true);
    const [upload] = drive.uploads;
    expect(upload?.metadata).toMatchObject({
      name: 'Jane Doe Resume (v1).pdf',
      appProperties: { offerdeskVersion: versionId },
    });
    expect(upload?.body).toContain('%PDF resume v1');
    const folder = [...drive.files.values()].find((f) => f.name === 'OfferDesk');
    expect(folder).toBeDefined();

    const second = await desk.saveVersionToDrive(versionId);
    expect(second).toEqual({ url: first.url, created: false });
    expect(drive.uploads).toHaveLength(1);
  });
});
