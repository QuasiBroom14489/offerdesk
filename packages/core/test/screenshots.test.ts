import type { PostingImage } from '@offerdesk/shared';
import { describe, expect, it } from 'vitest';
import { Offerdesk, type PostingReader } from '../src/index.js';

const png: PostingImage = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };

const fixed = (draft: Awaited<ReturnType<PostingReader['read']>>): PostingReader => ({
  read: async () => draft,
});

describe('readPostingScreenshots', () => {
  it('is unavailable without a reader', async () => {
    const desk = await Offerdesk.open(':memory:');
    expect(desk.canReadScreenshots).toBe(false);
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
