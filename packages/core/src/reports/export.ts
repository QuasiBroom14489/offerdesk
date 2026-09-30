import {
  type Cell,
  type ColumnMeta,
  cellText,
  type Report,
  type Signal,
  STATUS_SIGNAL,
  type Status,
} from '@offerdesk/shared';
import ExcelJS from 'exceljs';

/**
 * CSV and Excel from a `Report`. Both render exactly the report's rows and
 * columns — the same object the dashboard draws — so a download always
 * matches the screen.
 */

/** RFC 4180 CSV with a BOM so Excel reads UTF-8, and CRLF line endings. */
export function toCsv(report: Report): string {
  const lines = [
    report.columns.map((c) => csvField(headerText(c))),
    ...report.rows.map((r) =>
      report.columns.map((c, i) => csvField(csvText(c, r.cells[i] ?? null))),
    ),
  ];
  return `﻿${lines.map((l) => l.join(',')).join('\r\n')}\r\n`;
}

/** "Waiting (days)": units go in the header so cells stay plain numbers. */
export const headerText = (c: ColumnMeta): string => (c.unit ? `${c.label} (${c.unit})` : c.label);

function csvText(column: ColumnMeta, cell: Cell): string {
  const text = cellText(column, cell);
  // A text cell starting with = + - @ would run as a formula in a spreadsheet.
  // Numbers and dates are ours; anything typed or captured gets neutralized.
  if ((column.type === 'text' || column.type === 'url') && /^[=+\-@\t\r]/.test(text)) {
    return `'${text}`;
  }
  return text;
}

function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Same palette as the dashboard (apps/web/src/styles.css), as ARGB. */
export const SIGNAL_FILL: Record<Signal, { fill: string; font: string } | null> = {
  green: { fill: 'FFEAF7EF', font: 'FF1F9D55' },
  yellow: { fill: 'FFFDF6E3', font: 'FFB7791F' },
  red: { fill: 'FFFDEEEE', font: 'FFD64545' },
  grey: null,
};

const INK = 'FF1D1D1F';
const LINE = 'FFEBEBED';

/**
 * An .xlsx with typed columns (real dates and numbers, clickable links), a
 * frozen bold header with filters, and status cells tinted by signal.
 */
export async function toXlsx(report: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OfferDesk';
  wb.created = new Date(report.generatedAt);
  const ws = wb.addWorksheet(sheetName(report.view?.name ?? 'Applications'), {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = report.columns.map((c) => ({
    header: headerText(c),
    key: c.id,
    // Wide enough for the header, which is bold and carries the unit.
    width: Math.max(WIDTH[c.type] ?? 18, headerText(c).length + 3),
    style:
      c.type === 'date' ? { numFmt: 'yyyy-mm-dd' } : c.type === 'number' ? { numFmt: '0' } : {},
  }));

  for (const row of report.rows) {
    ws.addRow(report.columns.map((c, i) => xlsxValue(c, row.cells[i] ?? null)));
  }

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: INK } };
  header.border = { bottom: { style: 'thin', color: { argb: LINE } } };
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(1, report.columns.length) },
  };

  report.rows.forEach((row, r) => {
    report.columns.forEach((column, c) => {
      const tone = SIGNAL_FILL[signalOf(column, row.cells[c] ?? null)];
      if (!tone) return;
      const x = ws.getCell(r + 2, c + 1);
      x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: tone.fill } };
      x.font = { color: { argb: tone.font } };
    });
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

const WIDTH: Partial<Record<ColumnMeta['type'], number>> = {
  text: 24,
  url: 36,
  date: 12,
  number: 14,
  status: 18,
  signal: 16,
};

export function signalOf(column: ColumnMeta, cell: Cell): Signal {
  if (cell === null) return 'grey';
  if (column.type === 'status') return STATUS_SIGNAL[cell as Status] ?? 'grey';
  if (column.type === 'signal') return cell as Signal;
  return 'grey';
}

function xlsxValue(column: ColumnMeta, cell: Cell): ExcelJS.CellValue {
  if (cell === null) return null;
  switch (column.type) {
    case 'number':
      return Number(cell);
    case 'date': {
      // Excel dates have no zone; UTC midnight keeps the calendar day exact.
      const [y, m, d] = String(cell).split('-').map(Number) as [number, number, number];
      return new Date(Date.UTC(y, m - 1, d));
    }
    case 'url':
      return { text: String(cell), hyperlink: String(cell) };
    default:
      return cellText(column, cell);
  }
}

/** Excel sheet names: 31 characters, none of []:*?/\ */
function sheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Applications';
}
