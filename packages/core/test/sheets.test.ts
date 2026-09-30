import type { Report } from '@offerdesk/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Fetch, MemoryCredentialStore, sheetRequests } from '../src/connectors/index.js';
import { NotFoundError } from '../src/errors.js';
import { Offerdesk } from '../src/offerdesk.js';

interface FakeFile {
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  tabs: { sheetId: number; title: string }[];
}

/** The parts of a Sheets batchUpdate request the fake understands. */
interface SheetsRequest {
  addSheet?: { properties: { title: string } };
  updateSheetProperties?: { properties: { sheetId: number; title?: string } };
  updateCells?: { rows?: { values: unknown[] }[] };
}

/** Drive files + Sheets metadata and batchUpdate, in memory. */
class FakeDrive {
  files = new Map<string, FakeFile>();
  batches: { id: string; requests: SheetsRequest[] }[] = [];
  private n = 0;

  fetch: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const files = [...this.files.entries()]
        .filter(([, f]) => q.includes(`'${f.name}'`) && q.includes(f.mimeType) && !f.trashed)
        .map(([id]) => ({ id }));
      return json(200, { files });
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const id = `file-${++this.n}`;
      const isSheet = body.mimeType === 'application/vnd.google-apps.spreadsheet';
      this.files.set(id, {
        name: body.name,
        mimeType: body.mimeType,
        parents: body.parents ?? ['root'],
        trashed: false,
        tabs: isSheet ? [{ sheetId: 0, title: 'Sheet1' }] : [],
      });
      return json(200, { id });
    }
    const driveFile = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (driveFile) {
      const f = this.files.get(decodeURIComponent(driveFile[1] as string));
      return f
        ? json(200, { trashed: f.trashed })
        : json(404, { error: { message: 'File not found' } });
    }
    const batch = url.pathname.match(/^\/v4\/spreadsheets\/([^/:]+):batchUpdate$/);
    if (batch) {
      const id = decodeURIComponent(batch[1] as string);
      const f = this.files.get(id);
      if (!f) return json(404, {});
      this.batches.push({ id, requests: body.requests });
      const replies = (body.requests as SheetsRequest[]).map((r) => {
        if (r.addSheet) {
          const sheetId = 100 + f.tabs.length;
          f.tabs.unshift({ sheetId, title: r.addSheet.properties.title });
          return { addSheet: { properties: { sheetId } } };
        }
        const props = r.updateSheetProperties?.properties;
        if (props?.title) {
          const tab = f.tabs.find((t) => t.sheetId === props.sheetId);
          if (tab) tab.title = props.title;
        }
        return {};
      });
      return json(200, { replies });
    }
    const meta = url.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)$/);
    if (meta) {
      const id = decodeURIComponent(meta[1] as string);
      const f = this.files.get(id);
      if (!f) return json(404, {});
      return json(200, {
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`,
        sheets: f.tabs.map((t) => ({ properties: t })),
      });
    }
    return json(404, { error: { message: `unexpected ${method} ${url}` } });
  };

  lastWrite() {
    const b = this.batches.at(-1);
    const rows = b?.requests.find((r) => r.updateCells?.rows)?.updateCells?.rows ?? [];
    return { id: b?.id, rows };
  }
}

describe('pushing views to Google Sheets', () => {
  let clock: number;
  let drive: FakeDrive;
  let desk: Offerdesk;

  beforeEach(async () => {
    clock = Date.UTC(2026, 9, 1, 12);
    drive = new FakeDrive();
    const credentials = new MemoryCredentialStore();
    await credentials.set('local', 'google', {
      accessToken: 'live',
      refreshToken: 'r',
      expiresAt: Date.UTC(2030, 0, 1),
      scope: 'https://www.googleapis.com/auth/drive.file',
    });
    desk = await Offerdesk.open(':memory:', {
      now: () => clock++,
      credentials,
      google: { clientId: 'c', clientSecret: 's' },
      fetch: drive.fetch,
    });
    await desk.addApplication({ company: 'Acme', role: 'Data Intern', deadline: '2026-11-01' });
    await desk.addApplication({ company: '=HYPERLINK("evil")', role: 'Analyst' });
  });
  afterEach(() => desk.close());

  it('creates the sheet in an OfferDesk folder on first push and writes typed rows', async () => {
    const pushed = await desk.pushViewToSheet('everything');
    expect(pushed).toMatchObject({ viewId: 'everything', rows: 2, created: true, changesSince: 0 });
    expect(pushed.url).toMatch(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/file-2\//);

    const [folder, sheet] = [...drive.files.values()];
    expect(folder).toMatchObject({
      name: 'OfferDesk',
      mimeType: 'application/vnd.google-apps.folder',
    });
    expect(sheet).toMatchObject({ name: 'OfferDesk · Everything', parents: ['file-1'] });
    expect(sheet?.tabs).toEqual([{ sheetId: 0, title: 'OfferDesk' }]);

    const { rows } = drive.lastWrite();
    expect(rows[0]?.values[0]).toMatchObject({
      userEnteredValue: { stringValue: 'Company' },
      userEnteredFormat: { textFormat: { bold: true } },
    });
    const values = rows.slice(1).flatMap((r) => r.values);
    // A formula-looking company name is written as a literal string, never a formula.
    expect(values).toContainEqual({ userEnteredValue: { stringValue: '=HYPERLINK("evil")' } });
    expect(JSON.stringify(rows)).not.toContain('formulaValue');
    // Deadline 2026-11-01 as a real date serial.
    expect(values).toContainEqual({
      userEnteredValue: { numberValue: 46327 },
      userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } },
    });
  });

  it('rewrites the same sheet on later pushes and counts changes in between', async () => {
    const first = await desk.pushViewToSheet('everything');
    const [app] = await desk.listApplications();
    await desk.setStatus(app?.id as string, 'applied');
    await desk.addNote(app?.id as string, 'Sent it');
    expect((await desk.viewSheet('everything'))?.changesSince).toBe(2);

    const second = await desk.pushViewToSheet('everything');
    expect(second).toMatchObject({
      spreadsheetId: first.spreadsheetId,
      created: false,
      changesSince: 0,
    });
    expect([...drive.files.values()].filter((f) => f.name.startsWith('OfferDesk ·'))).toHaveLength(
      1,
    );
    expect(drive.lastWrite().id).toBe(first.spreadsheetId);
  });

  it('recreates a sheet that was trashed or deleted', async () => {
    const first = await desk.pushViewToSheet('everything');
    (drive.files.get(first.spreadsheetId) as FakeFile).trashed = true;
    const second = await desk.pushViewToSheet('everything');
    expect(second.created).toBe(true);
    expect(second.spreadsheetId).not.toBe(first.spreadsheetId);

    drive.files.delete(second.spreadsheetId);
    expect((await desk.pushViewToSheet('everything')).created).toBe(true);
  });

  it('adds its own tab back without touching tabs the user made', async () => {
    const first = await desk.pushViewToSheet('everything');
    const file = drive.files.get(first.spreadsheetId) as FakeFile;
    file.tabs = [{ sheetId: 7, title: 'My pivot' }];
    await desk.pushViewToSheet('everything');
    expect(file.tabs.map((t) => t.title)).toEqual(['OfferDesk', 'My pivot']);
    const ours = file.tabs.find((t) => t.title === 'OfferDesk')?.sheetId;
    const written = JSON.stringify(drive.batches.at(-1)?.requests);
    expect(written).toContain(`"sheetId":${ours}`);
    expect(written).not.toContain('"sheetId":7');
  });

  it('reuses the OfferDesk folder across views', async () => {
    await desk.pushViewToSheet('everything');
    await desk.pushViewToSheet('waiting');
    const folders = [...drive.files.values()].filter((f) => f.name === 'OfferDesk');
    expect(folders).toHaveLength(1);
  });

  it('unlinks without deleting, and forgets the link when a saved view is deleted', async () => {
    await desk.pushViewToSheet('everything');
    await desk.unlinkViewSheet('everything');
    expect(await desk.viewSheet('everything')).toBeNull();
    expect(drive.files.size).toBe(2);

    const mine = await desk.views.create({ name: 'Mine', spec: { columns: ['company'] } });
    await desk.pushViewToSheet(mine.id);
    await desk.views.remove(mine.id);
    expect(await desk.viewSheets.get(mine.id)).toBeNull();
  });

  it('rejects unknown views and keeps workspaces apart', async () => {
    await expect(desk.pushViewToSheet('nope')).rejects.toThrow(NotFoundError);
    await desk.pushViewToSheet('everything');
    expect(await desk.forWorkspace('other').viewSheet('everything')).toBeNull();
  });
});

describe('sheetRequests', () => {
  it('sizes the grid to the report so rows from a longer past push disappear', () => {
    const report = {
      view: null,
      spec: { columns: ['company'] },
      columns: [{ id: 'company', label: 'Company', type: 'text', description: '' }],
      rows: [{ id: 'a', cells: ['Acme'] }],
      generatedAt: 0,
    } as unknown as Report;
    const [resize, clear] = sheetRequests(report, 5) as [
      { updateSheetProperties: { properties: { gridProperties: unknown } } },
      unknown,
    ];
    expect(resize.updateSheetProperties.properties.gridProperties).toEqual({
      rowCount: 2,
      columnCount: 1,
      frozenRowCount: 1,
    });
    expect(clear).toEqual({
      updateCells: { range: { sheetId: 5 }, fields: 'userEnteredValue,userEnteredFormat' },
    });
  });
});
