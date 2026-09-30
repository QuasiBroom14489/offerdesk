import type { Db } from '../db.js';

/** A view's Google Sheet, and how far behind it is (ADR 0007). */
export interface ViewSheet {
  viewId: string;
  spreadsheetId: string;
  url: string;
  pushedAt: number;
  /** Events recorded since the last push; 0 means the sheet is current. */
  changesSince: number;
}

interface Row {
  view_id: string;
  spreadsheet_id: string;
  url: string;
  pushed_at: number;
  pushed_seq: number;
  changes: number;
}

/** Which spreadsheet each view pushes to. Configuration, so a mutable row. */
export class ViewSheets {
  constructor(
    private readonly db: Db,
    private readonly workspaceId: string,
  ) {}

  async get(viewId: string): Promise<ViewSheet | null> {
    const row = await this.db.get<Row>(
      `SELECT s.*, (SELECT COUNT(*) FROM events e
                    WHERE e.workspace_id = s.workspace_id AND e.seq > s.pushed_seq) AS changes
       FROM view_sheets s WHERE s.workspace_id = ? AND s.view_id = ?`,
      this.workspaceId,
      viewId,
    );
    return row
      ? {
          viewId: row.view_id,
          spreadsheetId: row.spreadsheet_id,
          url: row.url,
          pushedAt: row.pushed_at,
          changesSince: Number(row.changes),
        }
      : null;
  }

  /** The newest event's seq in this workspace: what a push about to start will include. */
  async latestSeq(): Promise<number> {
    const row = await this.db.get<{ seq: number | null }>(
      'SELECT MAX(seq) AS seq FROM events WHERE workspace_id = ?',
      this.workspaceId,
    );
    return Number(row?.seq ?? 0);
  }

  async save(
    viewId: string,
    sheet: { spreadsheetId: string; url: string },
    pushedAt: number,
    pushedSeq: number,
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO view_sheets (workspace_id, view_id, spreadsheet_id, url, pushed_at, pushed_seq)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, view_id) DO UPDATE SET
         spreadsheet_id = excluded.spreadsheet_id, url = excluded.url,
         pushed_at = excluded.pushed_at, pushed_seq = excluded.pushed_seq`,
      this.workspaceId,
      viewId,
      sheet.spreadsheetId,
      sheet.url,
      pushedAt,
      pushedSeq,
    );
  }

  /** Forget the link. The spreadsheet itself stays in the user's Drive. */
  async remove(viewId: string): Promise<void> {
    await this.db.run(
      'DELETE FROM view_sheets WHERE workspace_id = ? AND view_id = ?',
      this.workspaceId,
      viewId,
    );
  }
}
