import { z } from 'zod';

/** What a document is for. Presentation and filtering only; any kind attaches anywhere. */
export const DOCUMENT_KINDS = [
  'resume',
  'cover-letter',
  'transcript',
  'writing-sample',
  'portfolio',
  'other',
] as const;
export const DocumentKind = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  resume: 'Resume',
  'cover-letter': 'Cover letter',
  transcript: 'Transcript',
  'writing-sample': 'Writing sample',
  portfolio: 'Portfolio',
  other: 'Other',
};

/** Uploads pass through a Vercel function, which accepts bodies up to 4.5 MB (ADR 0006). */
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

/** One uploaded revision of a document. Immutable once written. */
export const DocumentVersion = z.object({
  id: z.string(),
  documentId: z.string(),
  version: z.number().int().positive(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  note: z.string().nullable(),
  createdAt: z.number(),
});
export type DocumentVersion = z.infer<typeof DocumentVersion>;

export const Document = z.object({
  id: z.string(),
  name: z.string(),
  kind: DocumentKind,
  createdAt: z.number(),
  archivedAt: z.number().nullable(),
  /** Newest first; never empty. */
  versions: z.array(DocumentVersion).min(1),
  /** Derived from attach/detach events: applications that currently have it. */
  applicationIds: z.array(z.string()),
});
export type Document = z.infer<typeof Document>;

/** A document as attached to one application, pinned to the version sent. */
export interface AttachedDocument {
  document: Pick<Document, 'id' | 'name' | 'kind'>;
  version: DocumentVersion;
  attachedAt: number;
}

export const NewDocument = z.object({
  name: z.string().trim().min(1).max(200),
  kind: DocumentKind.default('other'),
});
export type NewDocument = z.input<typeof NewDocument>;

export const DocumentPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  kind: DocumentKind.optional(),
  archived: z.boolean().optional(),
});
export type DocumentPatch = z.input<typeof DocumentPatch>;

/** Metadata that travels with an upload's bytes. */
export const UploadMeta = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).default('application/octet-stream'),
  note: z.string().trim().min(1).max(500).nullish(),
});
export type UploadMeta = z.input<typeof UploadMeta>;
