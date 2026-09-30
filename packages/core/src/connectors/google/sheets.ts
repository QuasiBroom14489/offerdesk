import { type Cell, type ColumnMeta, cellText, type Report } from '@offerdesk/shared';
import { headerText, SIGNAL_FILL, signalOf } from '../../reports/export.js';
import { GoogleApiError, type GoogleClient } from './client.js';
import { DRIVE_FILES, offerdeskFolder } from './drive.js';

/**
 * Views as Google Sheets (ADR 0007). A pushed view is one spreadsheet in an
 * `OfferDesk` Drive folder; each push rewrites its `OfferDesk` tab from the
 * same `Report` the table and the Excel export use. Other tabs are the user's
 * and are never touched.
 */

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
export const TAB_NAME = 'OfferDesk';

export interface PushedSheet {
  spreadsheetId: string;
  url: string;
}

interface Color {
  red: number;
  green: number;
  blue: number;
}

/** "FFEAF7EF" (ARGB, as the xlsx palette stores it) → Sheets' 0–1 floats. */
function rgb(argb: string): Color {
  const n = (i: number) => Number.parseInt(argb.slice(i, i + 2), 16) / 255;
  return { red: n(2), green: n(4), blue: n(6) };
}

const INK = rgb('FF1D1D1F');
const LINE = rgb('FFEBEBED');
const DAY_MS = 86_400_000;
/** Day zero of spreadsheet serial dates. */
const SERIAL_EPOCH = Date.UTC(1899, 11, 30);

/**
 * One cell as Sheets `CellData`. Text goes in `stringValue`, which Sheets never
 * parses, so a captured "=IMPORTXML(…)" stays text: no formula injection.
 */
function cellData(column: ColumnMeta, cell: Cell): Record<string, unknown> {
  if (cell === null) return {};
  switch (column.type) {
    case 'number':
      return {
        userEnteredValue: { numberValue: Number(cell) },
        userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0' } },
      };
    case 'date': {
      const [y, m, d] = String(cell).split('-').map(Number) as [number, number, number];
      return {
        userEnteredValue: { numberValue: (Date.UTC(y, m - 1, d) - SERIAL_EPOCH) / DAY_MS },
        userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } },
      };
    }
    case 'url': {
      const url = String(cell);
      return {
        userEnteredValue: { stringValue: url },
        ...(/^https?:\/\//i.test(url) && {
          userEnteredFormat: { textFormat: { link: { uri: url } } },
        }),
      };
    }
    default: {
      const tone = SIGNAL_FILL[signalOf(column, cell)];
      return {
        userEnteredValue: { stringValue: cellText(column, cell) },
        ...(tone && {
          userEnteredFormat: {
            backgroundColor: rgb(tone.fill),
            textFormat: { foregroundColor: rgb(tone.font) },
          },
        }),
      };
    }
  }
}

/**
 * The single `batchUpdate` that makes a tab show a report: size the grid to
 * fit, clear it, write header and rows, then filter, freeze and fit columns.
 * Pure, so tests check the exact payload.
 */
export function sheetRequests(report: Report, sheetId: number): unknown[] {
  const cols = Math.max(1, report.columns.length);
  const rowCount = report.rows.length + 1;
  const header = {
    values: report.columns.map((c) => ({
      userEnteredValue: { stringValue: headerText(c) },
      userEnteredFormat: {
        textFormat: { bold: true, foregroundColor: INK },
        borders: { bottom: { style: 'SOLID', color: LINE } },
      },
    })),
  };
  const rows = report.rows.map((r) => ({
    values: report.columns.map((c, i) => cellData(c, r.cells[i] ?? null)),
  }));
  return [
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          // A grid exactly this size: shrinking drops any rows from a longer past push.
          gridProperties: { rowCount: Math.max(2, rowCount), columnCount: cols, frozenRowCount: 1 },
        },
        fields: 'gridProperties(rowCount,columnCount,frozenRowCount)',
      },
    },
    { updateCells: { range: { sheetId }, fields: 'userEnteredValue,userEnteredFormat' } },
    {
      updateCells: {
        start: { sheetId, rowIndex: 0, columnIndex: 0 },
        rows: [header, ...rows],
        fields: 'userEnteredValue,userEnteredFormat',
      },
    },
    {
      setBasicFilter: {
        filter: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: rowCount,
            startColumnIndex: 0,
            endColumnIndex: cols,
          },
        },
      },
    },
    {
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: cols },
      },
    },
  ];
}

interface SpreadsheetMeta {
  spreadsheetUrl: string;
  sheets: { properties: { sheetId: number; title: string } }[];
}

export class GoogleSheets {
  constructor(private readonly client: GoogleClient) {}

  /** A new spreadsheet in the folder. */
  async create(title: string): Promise<PushedSheet> {
    const folder = await offerdeskFolder(this.client);
    const file = await this.client.json<{ id: string }>(`${DRIVE_FILES}?fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: title, mimeType: SHEET_MIME, parents: [folder] }),
    });
    const meta = await this.meta(file.id);
    return { spreadsheetId: file.id, url: meta?.spreadsheetUrl ?? sheetUrl(file.id) };
  }

  /** The spreadsheet if it still exists and isn't in the trash, else null. */
  async find(spreadsheetId: string): Promise<PushedSheet | null> {
    try {
      const file = await this.client.json<{ trashed?: boolean }>(
        `${DRIVE_FILES}/${encodeURIComponent(spreadsheetId)}?fields=trashed`,
      );
      if (file.trashed) return null;
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404) return null;
      throw err;
    }
    return { spreadsheetId, url: sheetUrl(spreadsheetId) };
  }

  /** Rewrite the `OfferDesk` tab (creating it, or renaming a new file's only tab). */
  async write(spreadsheetId: string, report: Report): Promise<void> {
    const meta = await this.meta(spreadsheetId);
    if (!meta) throw new GoogleApiError(404, 'spreadsheet not found');
    const sheetId = await this.tab(spreadsheetId, meta);
    await this.batch(spreadsheetId, sheetRequests(report, sheetId));
  }

  private async tab(spreadsheetId: string, meta: SpreadsheetMeta): Promise<number> {
    const ours = meta.sheets.find((s) => s.properties.title === TAB_NAME);
    if (ours) return ours.properties.sheetId;
    const only = meta.sheets.length === 1 ? meta.sheets[0] : undefined;
    if (only && /^Sheet1$/.test(only.properties.title)) {
      // A spreadsheet we just created: claim its default tab.
      await this.batch(spreadsheetId, [
        {
          updateSheetProperties: {
            properties: { sheetId: only.properties.sheetId, title: TAB_NAME, index: 0 },
            fields: 'title,index',
          },
        },
      ]);
      return only.properties.sheetId;
    }
    // Our tab was deleted or renamed: add a fresh one first, leaving theirs alone.
    const res = await this.batch(spreadsheetId, [
      { addSheet: { properties: { title: TAB_NAME, index: 0 } } },
    ]);
    return (res.replies[0] as { addSheet: { properties: { sheetId: number } } }).addSheet.properties
      .sheetId;
  }

  private async meta(spreadsheetId: string): Promise<SpreadsheetMeta | null> {
    try {
      return await this.client.json<SpreadsheetMeta>(
        `${SHEETS}/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetUrl,sheets.properties(sheetId,title)`,
      );
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404) return null;
      throw err;
    }
  }

  private batch(spreadsheetId: string, requests: unknown[]): Promise<{ replies: unknown[] }> {
    return this.client.json(`${SHEETS}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
  }
}

function sheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}
