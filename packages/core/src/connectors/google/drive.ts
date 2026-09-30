import { MAX_DOCUMENT_BYTES } from '@offerdesk/shared';
import { GoogleApiError, type GoogleClient } from './client.js';

/**
 * Drive files for the documents library (ADR 0007): read files the user picked
 * (Google Docs, Sheets and Slides export as PDF) and copy versions out to the
 * `OfferDesk` folder. With `drive.file`, only picked or app-made files are visible.
 */

export const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const FOLDER_NAME = 'OfferDesk';
/** Links a Drive copy back to the version it was saved from, so saving is idempotent. */
const VERSION_PROPERTY = 'offerdeskVersion';

/** Google-native files have no bytes of their own; they're exported as PDF. */
const EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.spreadsheet': 'application/pdf',
  'application/vnd.google-apps.presentation': 'application/pdf',
};

export interface DriveDownload {
  fileId: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface DriveCopy {
  fileId: string;
  url: string;
}

/** Drive file ids and our UUIDs only: anything else never reaches a URL or a query. */
function safeId(id: string): string {
  if (!/^[\w-]{10,200}$/.test(id)) throw new GoogleApiError(400, `not a valid id: ${id}`);
  return id;
}

const tooBig = (name: string) =>
  new GoogleApiError(413, `${name} is larger than 4 MB, the documents library limit`);

/** The app's `OfferDesk` folder, made on first use. `drive.file` only lists folders this app made. */
export async function offerdeskFolder(client: GoogleClient): Promise<string> {
  const q = `name = '${FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const found = await client.json<{ files: { id: string }[] }>(
    `${DRIVE_FILES}?${new URLSearchParams({ q, fields: 'files(id)', spaces: 'drive' })}`,
  );
  const existing = found.files[0];
  if (existing) return existing.id;
  const made = await client.json<{ id: string }>(`${DRIVE_FILES}?fields=id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  });
  return made.id;
}

export class GoogleDrive {
  constructor(private readonly client: GoogleClient) {}

  /** A picked file's bytes, with Google-native files exported to PDF. */
  async download(fileId: string): Promise<DriveDownload> {
    const id = encodeURIComponent(safeId(fileId));
    const meta = await this.client.json<{
      name: string;
      mimeType: string;
      size?: string;
      trashed?: boolean;
    }>(`${DRIVE_FILES}/${id}?fields=name,mimeType,size,trashed&supportsAllDrives=true`);
    if (meta.trashed) throw new GoogleApiError(410, `${meta.name} is in the Drive trash`);
    if (meta.mimeType === FOLDER_MIME) throw new GoogleApiError(400, `${meta.name} is a folder`);

    const exportAs = EXPORTS[meta.mimeType];
    if (!exportAs && Number(meta.size ?? 0) > MAX_DOCUMENT_BYTES) throw tooBig(meta.name);
    const res = await this.client.request(
      exportAs
        ? `${DRIVE_FILES}/${id}/export?${new URLSearchParams({ mimeType: exportAs })}`
        : `${DRIVE_FILES}/${id}?alt=media&supportsAllDrives=true`,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw tooBig(meta.name);
    return {
      fileId,
      filename: exportAs ? `${meta.name.replace(/\.pdf$/i, '')}.pdf` : meta.name,
      contentType: exportAs ?? meta.mimeType,
      bytes,
    };
  }

  /** The Drive copy of a version, if one was saved and isn't trashed. */
  async findCopy(versionId: string): Promise<DriveCopy | null> {
    const q = `appProperties has { key='${VERSION_PROPERTY}' and value='${safeId(versionId)}' } and trashed = false`;
    const found = await this.client.json<{ files: { id: string; webViewLink: string }[] }>(
      `${DRIVE_FILES}?${new URLSearchParams({ q, fields: 'files(id,webViewLink)', spaces: 'drive' })}`,
    );
    const file = found.files[0];
    return file ? { fileId: file.id, url: file.webViewLink } : null;
  }

  /** Upload a version into the `OfferDesk` folder, tagged with its version id. */
  async upload(input: {
    versionId: string;
    name: string;
    contentType: string;
    bytes: Uint8Array;
  }): Promise<DriveCopy> {
    const folder = await offerdeskFolder(this.client);
    const boundary = `offerdesk-${crypto.randomUUID()}`;
    const metadata = {
      name: input.name,
      parents: [folder],
      appProperties: { [VERSION_PROPERTY]: input.versionId },
    };
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
          `--${boundary}\r\ncontent-type: ${input.contentType}\r\n\r\n`,
      ),
      Buffer.from(input.bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const made = await this.client.json<{ id: string; webViewLink: string }>(
      `${UPLOAD}?uploadType=multipart&fields=id,webViewLink`,
      {
        method: 'POST',
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    return { fileId: made.id, url: made.webViewLink };
  }
}
