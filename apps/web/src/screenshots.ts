import { MAX_SCREENSHOT_BASE64, MAX_SCREENSHOTS, type PostingImage } from '@offerdesk/shared';

/** Wide enough to read body text; tall enough for a scrolled capture of a posting. */
const MAX_WIDTH = 1568;
const MAX_HEIGHT = 4000;

/** The image files among pasted or dropped items. */
export function imageFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const all =
    list instanceof FileList
      ? Array.from(list)
      : Array.from(list, (item) => (item.kind === 'file' ? item.getAsFile() : null));
  return all.filter((f): f is File => f?.type.startsWith('image/') ?? false);
}

/**
 * Shrink and re-encode screenshots in the browser, so a Retina capture fits
 * the request limit, then base64 them for the API (ADR 0008).
 */
export async function prepareScreenshots(files: File[]): Promise<PostingImage[]> {
  if (files.length > MAX_SCREENSHOTS) {
    throw new Error(`Use up to ${MAX_SCREENSHOTS} screenshots of one posting.`);
  }
  const bitmaps = await Promise.all(files.map((f) => createImageBitmap(f)));
  // Lower the quality together until the set fits.
  for (const quality of [0.85, 0.7, 0.55]) {
    const images = await Promise.all(bitmaps.map((b) => encode(b, quality)));
    if (images.reduce((n, i) => n + i.data.length, 0) <= MAX_SCREENSHOT_BASE64) {
      for (const b of bitmaps) b.close();
      return images;
    }
  }
  for (const b of bitmaps) b.close();
  throw new Error('Those screenshots are too large together. Try fewer, or crop to the posting.');
}

async function encode(bitmap: ImageBitmap, quality: number): Promise<PostingImage> {
  const scale = Math.min(1, MAX_WIDTH / bitmap.width, MAX_HEIGHT / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot read images.');
  ctx.fillStyle = '#fff'; // JPEG has no transparency
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return { mediaType: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}
