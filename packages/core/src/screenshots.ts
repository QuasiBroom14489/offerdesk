import { randomUUID } from 'node:crypto';
import type { PostingDraft, PostingImage } from '@offerdesk/shared';
import type { Db } from './db.js';
import { NotFoundError } from './errors.js';
import { type FileStore, screenshotKey } from './files/store.js';

/** A claim older than this belongs to a reader that died mid-read; it's up for grabs again. */
export const STALE_CLAIM_MS = 2 * 60_000;
/** Claims per reading before it's marked failed, so one bad image can't wedge the queue. */
const MAX_ATTEMPTS = 2;
/** Finished readings, and queued ones nobody read, are purged after this. */
const KEEP_MS = 24 * 60 * 60_000;

type Status = 'queued' | 'reading' | 'done' | 'failed';

interface Row {
  id: string;
  status: Status;
  images: string;
  today: string;
  attempts: number;
  draft: string | null;
  error: string | null;
  claimed_at: number | null;
}

interface StoredImage {
  key: string;
  mediaType: PostingImage['mediaType'];
}

/** A queued reading as the queue sees it, before duplicates are looked up. */
export interface QueuedRead {
  id: string;
  status: Status;
  draft: PostingDraft | null;
  error: string | null;
}

/** A claimed reading, with its images, for the reader to work on. */
export interface ClaimedRead {
  id: string;
  images: PostingImage[];
  today: string;
}

/**
 * Screenshot readings waiting for the owner's computer (ADR 0009). The hosted
 * app enqueues; a reader on the owner's machine, signed in to Claude, claims,
 * reads and completes. Rows are a work queue, not history: the posting itself
 * is recorded by `posting.captured` when the user saves it.
 */
export class ScreenshotQueue {
  constructor(
    private readonly db: Db,
    private readonly workspaceId: string,
    private readonly files: FileStore,
    private readonly now: () => number,
  ) {}

  async enqueue(images: PostingImage[], today: string): Promise<QueuedRead> {
    const id = randomUUID();
    const stored: StoredImage[] = [];
    for (const [n, img] of images.entries()) {
      const key = screenshotKey(this.workspaceId, id, n);
      await this.files.put(key, Buffer.from(img.data, 'base64'), img.mediaType);
      stored.push({ key, mediaType: img.mediaType });
    }
    await this.db.run(
      `INSERT INTO screenshot_reads (id, workspace_id, status, images, today, created_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
      id,
      this.workspaceId,
      JSON.stringify(stored),
      today,
      this.now(),
    );
    return { id, status: 'queued', draft: null, error: null };
  }

  async get(id: string): Promise<QueuedRead> {
    const row = await this.row(id);
    if (!row) throw new NotFoundError('screenshot reading', id);
    return {
      id,
      status: row.status,
      draft: row.draft ? (JSON.parse(row.draft) as PostingDraft) : null,
      error: row.error,
    };
  }

  /** Forget a reading and its images, whatever state it's in. */
  async cancel(id: string): Promise<void> {
    const row = await this.row(id);
    if (!row) return;
    await this.db.run(
      'DELETE FROM screenshot_reads WHERE workspace_id = ? AND id = ?',
      this.workspaceId,
      id,
    );
    await this.deleteImages(row);
  }

  /**
   * Take the oldest reading that's waiting, or one whose reader went quiet.
   * Safe with two readers: the conditional update lets only one of them win.
   */
  async claim(): Promise<ClaimedRead | null> {
    const now = this.now();
    const row = await this.db.get<Row>(
      `SELECT * FROM screenshot_reads
       WHERE workspace_id = ?
         AND (status = 'queued' OR (status = 'reading' AND claimed_at < ?))
       ORDER BY created_at LIMIT 1`,
      this.workspaceId,
      now - STALE_CLAIM_MS,
    );
    if (!row) return null;
    if (row.attempts >= MAX_ATTEMPTS) {
      await this.fail(row.id, 'the reader stopped partway through twice; try again');
      return this.claim();
    }
    const { changes } = await this.db.run(
      `UPDATE screenshot_reads SET status = 'reading', claimed_at = ?, attempts = attempts + 1
       WHERE workspace_id = ? AND id = ? AND status = ? AND coalesce(claimed_at, 0) = ?`,
      now,
      this.workspaceId,
      row.id,
      row.status,
      row.claimed_at ?? 0,
    );
    if (changes === 0) return null;
    const images: PostingImage[] = [];
    for (const img of JSON.parse(row.images) as StoredImage[]) {
      const bytes = await this.files.get(img.key);
      if (!bytes) {
        await this.fail(row.id, 'the screenshots are gone; paste them again');
        return null;
      }
      images.push({ mediaType: img.mediaType, data: Buffer.from(bytes).toString('base64') });
    }
    return { id: row.id, images, today: row.today };
  }

  async complete(id: string, draft: PostingDraft): Promise<void> {
    await this.finish(id, 'done', JSON.stringify(draft), null);
  }

  async fail(id: string, error: string): Promise<void> {
    await this.finish(id, 'failed', null, error);
  }

  /** The reader says it's alive, and clears out readings nobody needs any more. */
  async heartbeat(): Promise<void> {
    const now = this.now();
    await this.db.run(
      `INSERT INTO screenshot_readers (workspace_id, seen_at) VALUES (?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET seen_at = excluded.seen_at`,
      this.workspaceId,
      now,
    );
    const old = await this.db.all<Row>(
      'SELECT * FROM screenshot_reads WHERE workspace_id = ? AND created_at < ?',
      this.workspaceId,
      now - KEEP_MS,
    );
    for (const row of old) await this.cancel(row.id);
  }

  /** When this workspace's reader last checked in, or null if it never has. */
  async readerSeenAt(): Promise<number | null> {
    const row = await this.db.get<{ seen_at: number }>(
      'SELECT seen_at FROM screenshot_readers WHERE workspace_id = ?',
      this.workspaceId,
    );
    return row?.seen_at ?? null;
  }

  private async finish(
    id: string,
    status: 'done' | 'failed',
    draft: string | null,
    error: string | null,
  ): Promise<void> {
    const row = await this.row(id);
    // Cancelled while it was being read: nothing to record.
    if (!row) return;
    await this.db.run(
      `UPDATE screenshot_reads SET status = ?, draft = ?, error = ?, finished_at = ?
       WHERE workspace_id = ? AND id = ?`,
      status,
      draft,
      error,
      this.now(),
      this.workspaceId,
      id,
    );
    await this.deleteImages(row);
  }

  private async deleteImages(row: Row): Promise<void> {
    for (const img of JSON.parse(row.images) as StoredImage[]) {
      await this.files.delete(img.key);
    }
  }

  private row(id: string): Promise<Row | undefined> {
    return this.db.get<Row>(
      'SELECT * FROM screenshot_reads WHERE workspace_id = ? AND id = ?',
      this.workspaceId,
      id,
    );
  }
}
