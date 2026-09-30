import { randomUUID } from 'node:crypto';
import {
  type AnyEvent,
  type AttachedDocument,
  type Document,
  type DocumentKind,
  DocumentPatch,
  type DocumentVersion,
  MAX_DOCUMENT_BYTES,
  NewDocument,
  UploadMeta,
} from '@offerdesk/shared';
import { z } from 'zod';
import type { Db } from './db.js';
import { NotFoundError, UnavailableError } from './errors.js';
import type { EventLog } from './events.js';
import { type FileStore, fileKey, sha256 } from './files/store.js';

interface DocumentRow {
  id: string;
  name: string;
  kind: string;
  created_at: number;
  archived_at: number | null;
}

interface VersionRow {
  id: string;
  document_id: string;
  version: number;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  note: string | null;
  created_at: number;
}

const Bytes = z
  .instanceof(Uint8Array)
  .refine((b) => b.byteLength > 0, 'the file is empty')
  .refine((b) => b.byteLength <= MAX_DOCUMENT_BYTES, 'the file is larger than 4 MB');

function toVersion(r: VersionRow): DocumentVersion {
  return {
    id: r.id,
    documentId: r.document_id,
    version: r.version,
    filename: r.filename,
    contentType: r.content_type,
    size: r.size,
    sha256: r.sha256,
    note: r.note,
    createdAt: r.created_at,
  };
}

/**
 * Which document versions each application has right now, folded from
 * attach/detach events in log order. Re-attaching re-pins the version.
 */
export function foldAttachments(
  events: readonly AnyEvent[],
): Map<string, Map<string, { versionId: string | null; at: number }>> {
  const out = new Map<string, Map<string, { versionId: string | null; at: number }>>();
  for (const e of events) {
    if (!e.applicationId) continue;
    if (e.kind === 'document.attached') {
      const docs = out.get(e.applicationId) ?? new Map();
      docs.set(e.payload.documentId, { versionId: e.payload.versionId ?? null, at: e.ts });
      out.set(e.applicationId, docs);
    } else if (e.kind === 'document.detached') {
      out.get(e.applicationId)?.delete(e.payload.documentId);
    }
  }
  return out;
}

/**
 * The documents library for one workspace (ADR 0006). Documents and their
 * immutable versions are rows; the bytes live in a `FileStore`. Attaching a
 * document to an application is an event, written by `Offerdesk`.
 */
export class Documents {
  constructor(
    private readonly db: Db,
    private readonly workspaceId: string,
    private readonly events: EventLog,
    private readonly files: FileStore | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether uploads and downloads work in this deployment. */
  get storage(): string | null {
    return this.files?.name ?? null;
  }

  async list(opts: { archived?: boolean } = {}): Promise<Document[]> {
    const docs = await this.all();
    return docs.filter((d) => (d.archivedAt !== null) === (opts.archived ?? false));
  }

  async get(id: string): Promise<Document> {
    const doc = (await this.all()).find((d) => d.id === id);
    if (!doc) throw new NotFoundError('document', id);
    return doc;
  }

  /** A new document with its first version. */
  async create(input: NewDocument, bytes: Uint8Array, meta: UploadMeta): Promise<Document> {
    const d = NewDocument.parse(input);
    const id = randomUUID();
    await this.db.transaction(async () => {
      await this.db.run(
        'INSERT INTO documents (id, workspace_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)',
        id,
        this.workspaceId,
        d.name,
        d.kind,
        this.now(),
      );
      await this.writeVersion(id, 1, bytes, meta);
    });
    return this.get(id);
  }

  /** Upload a new revision. Earlier versions, and the applications pinned to them, are kept. */
  async addVersion(id: string, bytes: Uint8Array, meta: UploadMeta): Promise<Document> {
    await this.db.transaction(async () => {
      const latest = await this.db.get<{ n: number | null }>(
        'SELECT max(version) AS n FROM document_versions WHERE workspace_id = ? AND document_id = ?',
        this.workspaceId,
        id,
      );
      if (!latest?.n) throw new NotFoundError('document', id);
      await this.writeVersion(id, latest.n + 1, bytes, meta);
    });
    return this.get(id);
  }

  async update(id: string, patch: DocumentPatch): Promise<Document> {
    const p = DocumentPatch.parse(patch);
    const doc = await this.get(id);
    const archivedAt =
      p.archived === undefined
        ? doc.archivedAt
        : p.archived
          ? (doc.archivedAt ?? this.now())
          : null;
    await this.db.run(
      'UPDATE documents SET name = ?, kind = ?, archived_at = ? WHERE workspace_id = ? AND id = ?',
      p.name ?? doc.name,
      p.kind ?? doc.kind,
      archivedAt,
      this.workspaceId,
      id,
    );
    return this.get(id);
  }

  async version(versionId: string): Promise<DocumentVersion> {
    const row = await this.db.get<VersionRow>(
      'SELECT * FROM document_versions WHERE workspace_id = ? AND id = ?',
      this.workspaceId,
      versionId,
    );
    if (!row) throw new NotFoundError('document version', versionId);
    return toVersion(row);
  }

  /** A version's bytes, for download. */
  async read(versionId: string): Promise<{ version: DocumentVersion; bytes: Uint8Array }> {
    const version = await this.version(versionId);
    const bytes = await this.store().get(fileKey(this.workspaceId, version.sha256));
    if (!bytes) throw new NotFoundError('file for document version', versionId);
    return { version, bytes };
  }

  /** An application's attached documents, from its own events. */
  async attachedTo(
    applicationId: string,
    timeline: readonly AnyEvent[],
  ): Promise<AttachedDocument[]> {
    const attached = foldAttachments(timeline).get(applicationId);
    if (!attached?.size) return [];
    const docs = new Map((await this.all()).map((d) => [d.id, d]));
    const out: AttachedDocument[] = [];
    for (const [documentId, { versionId, at }] of attached) {
      const doc = docs.get(documentId);
      if (!doc) continue;
      // Attachments from before versions were pinned show the latest.
      const version = doc.versions.find((v) => v.id === versionId) ?? doc.versions[0];
      if (!version) continue;
      out.push({
        document: { id: doc.id, name: doc.name, kind: doc.kind },
        version,
        attachedAt: at,
      });
    }
    return out.sort((a, b) => b.attachedAt - a.attachedAt);
  }

  private store(): FileStore {
    if (!this.files) {
      throw new UnavailableError(
        'file storage is not configured here; connect a Vercel Blob store (ADR 0006)',
      );
    }
    return this.files;
  }

  private async writeVersion(
    documentId: string,
    version: number,
    bytes: Uint8Array,
    input: UploadMeta,
  ): Promise<void> {
    const body = Bytes.parse(bytes);
    const meta = UploadMeta.parse(input);
    const hash = sha256(body);
    // Bytes first: a failed upload leaves no row pointing at nothing, and a
    // failed insert leaves only an orphaned, content-addressed file.
    await this.store().put(fileKey(this.workspaceId, hash), body, meta.contentType);
    await this.db.run(
      `INSERT INTO document_versions
         (id, workspace_id, document_id, version, filename, content_type, size, sha256, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      this.workspaceId,
      documentId,
      version,
      meta.filename,
      meta.contentType,
      body.byteLength,
      hash,
      meta.note ?? null,
      this.now(),
    );
  }

  /** Every document with its versions, in two queries. */
  private async all(): Promise<Document[]> {
    const [docs, versions, events] = await Promise.all([
      this.db.all<DocumentRow>(
        'SELECT * FROM documents WHERE workspace_id = ? ORDER BY created_at DESC',
        this.workspaceId,
      ),
      this.db.all<VersionRow>(
        'SELECT * FROM document_versions WHERE workspace_id = ? ORDER BY version DESC',
        this.workspaceId,
      ),
      this.events.ofKinds('document.attached', 'document.detached'),
    ]);
    const byDoc = new Map<string, DocumentVersion[]>();
    for (const v of versions) {
      const list = byDoc.get(v.document_id) ?? [];
      list.push(toVersion(v));
      byDoc.set(v.document_id, list);
    }
    const usedBy = new Map<string, string[]>();
    for (const [appId, docsOf] of foldAttachments(events)) {
      for (const docId of docsOf.keys()) usedBy.set(docId, [...(usedBy.get(docId) ?? []), appId]);
    }
    return docs.map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind as DocumentKind,
      createdAt: d.created_at,
      archivedAt: d.archived_at,
      versions: byDoc.get(d.id) ?? [],
      applicationIds: usedBy.get(d.id) ?? [],
    }));
  }
}
