import type { PostingImage } from '@offerdesk/shared';
import { describe, expect, it } from 'vitest';
import { MemoryFileStore, Offerdesk, type PostingReader, STALE_CLAIM_MS } from '../src/index.js';

const png: PostingImage = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };

const fixed = (draft: Awaited<ReturnType<PostingReader['read']>>): PostingReader => ({
  read: async () => draft,
});

describe('readPostingScreenshots', () => {
  it('is unavailable without a reader', async () => {
    const desk = await Offerdesk.open(':memory:');
    expect(desk.screenshotMode).toBeNull();
    await expect(desk.readPostingScreenshots({ images: [png] })).rejects.toThrow(
      /signed in to Claude Code/,
    );
  });

  it('passes today and the images through, and saves nothing', async () => {
    const seen: { count: number; today: string }[] = [];
    const desk = await Offerdesk.open(':memory:', {
      now: () => new Date(2026, 9, 15, 12).getTime(),
      postingReader: {
        read: async (images, today) => {
          seen.push({ count: images.length, today });
          return { isPosting: true, company: 'Acme', role: 'Intern', deadline: '2026-11-01' };
        },
      },
    });
    const { draft, duplicateOf } = await desk.readPostingScreenshots({ images: [png, png] });
    expect(seen).toEqual([{ count: 2, today: '2026-10-15' }]);
    expect(draft).toMatchObject({ company: 'Acme', deadline: '2026-11-01' });
    expect(duplicateOf).toBeNull();
    expect(await desk.listApplications()).toEqual([]);
  });

  it('points at the application a posting already matches', async () => {
    const desk = await Offerdesk.open(':memory:', {
      postingReader: fixed({ isPosting: true, company: 'acme', role: ' intern ' }),
    });
    const { application } = await desk.capturePosting({ company: 'Acme', role: 'Intern' });
    const { duplicateOf } = await desk.readPostingScreenshots({ images: [png] });
    expect(duplicateOf?.id).toBe(application.id);
  });

  it('does not look for duplicates when it is not a posting', async () => {
    const desk = await Offerdesk.open(':memory:', { postingReader: fixed({ isPosting: false }) });
    expect(await desk.readPostingScreenshots({ images: [png] })).toEqual({
      draft: { isPosting: false },
      duplicateOf: null,
    });
  });

  it('rejects too many or oversized screenshots before calling the reader', async () => {
    let calls = 0;
    const desk = await Offerdesk.open(':memory:', {
      postingReader: {
        read: async () => {
          calls++;
          return { isPosting: false };
        },
      },
    });
    await expect(desk.readPostingScreenshots({ images: Array(6).fill(png) })).rejects.toThrow();
    const huge = { mediaType: 'image/png' as const, data: 'A'.repeat(4_000_001) };
    await expect(desk.readPostingScreenshots({ images: [huge] })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

describe("screenshots queued for the owner's reader (ADR 0009)", () => {
  /** The hosted app (files, no reader) and the owner's computer (both), on one database. */
  async function pair(read: PostingReader['read'] = async () => ({ isPosting: false })) {
    let clock = new Date(2026, 9, 15, 12).getTime();
    const files = new MemoryFileStore();
    const hosted = await Offerdesk.open(':memory:', { files, now: () => clock });
    const home = new Offerdesk(hosted.db, { files, now: () => clock, postingReader: { read } });
    return { hosted, home, files, tick: (ms: number) => (clock += ms) };
  }

  it('is queue mode with files and no reader, here mode with a reader', async () => {
    const { hosted, home } = await pair();
    expect(hosted.screenshotMode).toBe('queue');
    expect(home.screenshotMode).toBe('here');
  });

  it('stores the images until the reader is done, then deletes them', async () => {
    const seen: { data: string; today: string }[] = [];
    const { hosted, home, files } = await pair(async (images, today) => {
      seen.push({ data: images[0]?.data ?? '', today });
      return { isPosting: true, company: 'Acme', role: 'Intern' };
    });
    const queued = await hosted.startScreenshotRead({ images: [png] });
    expect(queued).toMatchObject({ status: 'queued', draft: null, readerSeenAt: null });
    expect(files.files.size).toBe(1);

    await home.screenshotQueue?.heartbeat();
    const id = queued.id ?? '';
    expect(await home.readQueuedScreenshots()).toEqual({ id, status: 'done' });
    expect(seen).toEqual([{ data: png.data, today: '2026-10-15' }]);
    expect(files.files.size).toBe(0);
    expect(await home.readQueuedScreenshots()).toBeNull();

    const { application } = await hosted.capturePosting({ company: 'Acme', role: 'Intern' });
    expect(await hosted.screenshotRead(id)).toMatchObject({
      status: 'done',
      draft: { company: 'Acme' },
      duplicateOf: { id: application.id },
    });
  });

  it('reports when the reader last checked in while a reading waits', async () => {
    const { hosted, home } = await pair();
    await home.screenshotQueue?.heartbeat();
    const queued = await hosted.startScreenshotRead({ images: [png] });
    expect(queued.readerSeenAt).toBe(new Date(2026, 9, 15, 12).getTime());
  });

  it('records a failed reading and keeps going', async () => {
    const { hosted, home } = await pair(async () => {
      throw new Error('not signed in');
    });
    const { id } = await hosted.startScreenshotRead({ images: [png] });
    expect(await home.readQueuedScreenshots()).toEqual({ id, status: 'failed' });
    expect(await hosted.screenshotRead(id ?? '')).toMatchObject({
      status: 'failed',
      error: 'not signed in',
    });
  });

  it('takes back a claim from a reader that died, and gives up after two', async () => {
    const { hosted, home, tick } = await pair();
    const { id } = await hosted.startScreenshotRead({ images: [png] });
    expect(await home.screenshotQueue?.claim()).toMatchObject({ id });
    expect(await home.screenshotQueue?.claim()).toBeNull();
    tick(STALE_CLAIM_MS + 1);
    expect(await home.screenshotQueue?.claim()).toMatchObject({ id });
    tick(STALE_CLAIM_MS + 1);
    expect(await home.screenshotQueue?.claim()).toBeNull();
    expect(await hosted.screenshotRead(id ?? '')).toMatchObject({ status: 'failed' });
  });

  it('cancels a reading and its images, even mid-read', async () => {
    const { hosted, home, files } = await pair(async () => {
      await hosted.cancelScreenshotRead(id ?? '');
      return { isPosting: false };
    });
    const { id } = await hosted.startScreenshotRead({ images: [png] });
    expect(await home.readQueuedScreenshots()).toEqual({ id, status: 'done' });
    expect(files.files.size).toBe(0);
    await expect(hosted.screenshotRead(id ?? '')).rejects.toThrow(/not found/);
  });

  it('keeps each workspace to its own readings', async () => {
    const { hosted, home } = await pair();
    const { id } = await hosted.startScreenshotRead({ images: [png] });
    expect(await home.forWorkspace('someone-else').screenshotQueue?.claim()).toBeNull();
    await expect(hosted.forWorkspace('someone-else').screenshotRead(id ?? '')).rejects.toThrow();
  });

  it('purges readings a day old', async () => {
    const { hosted, home, files, tick } = await pair();
    const { id } = await hosted.startScreenshotRead({ images: [png] });
    tick(25 * 60 * 60_000);
    await home.screenshotQueue?.heartbeat();
    expect(files.files.size).toBe(0);
    await expect(hosted.screenshotRead(id ?? '')).rejects.toThrow(/not found/);
  });
});
