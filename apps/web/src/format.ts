import type { AnyEvent } from '@offerdesk/shared';
import { STATUS_LABELS } from '@offerdesk/shared';

const DAY = 86_400_000;

export function relativeDays(ts: number, now = Date.now()): string {
  const days = Math.round((now - ts) / DAY);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days === -1) return 'tomorrow';
  if (days < 0) return `in ${-days} days`;
  if (days < 14) return `${days} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "just now", "12 min ago", "3 h ago", then days: for things that change within a day. */
export function timeAgo(ts: number, now = Date.now()): string {
  const minutes = Math.round((now - ts) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return relativeDays(ts, now);
}

/** Days until an ISO date (local midnight), negative if past. */
export function daysUntil(iso: string, now = Date.now()): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const target = new Date(y, m - 1, d).getTime();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.round((target - today.getTime()) / DAY);
}

export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/** "84 KB", "1.2 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function percent(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 100)}%`;
}

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

/** "Two", "12" — sentence-friendly counts for the home headline. */
export function countWord(n: number, capitalize = true): string {
  const w = NUMBER_WORDS[n] ?? String(n);
  return capitalize ? w : w.toLowerCase();
}

/** One line describing an event, written from the user's side. */
export function describeEvent(e: AnyEvent): string {
  switch (e.kind) {
    case 'application.created':
      if (e.source === 'vesper') return 'Vesper added it from your screen';
      return e.payload.status === 'saved'
        ? 'Saved the posting'
        : `Added as ${STATUS_LABELS[e.payload.status].toLowerCase()}`;
    case 'status.changed':
      return `Moved to ${STATUS_LABELS[e.payload.to].toLowerCase()}`;
    case 'outreach.sent':
      return e.payload.summary
        ? `Reached out: ${e.payload.summary}`
        : `Reached out by ${e.payload.channel}`;
    case 'response.received':
      return e.payload.summary
        ? `Heard back: ${e.payload.summary}`
        : `Heard back by ${e.payload.channel}`;
    case 'interview.scheduled':
      return `Interview scheduled${e.payload.round ? ` (${e.payload.round})` : ''} for ${new Date(e.payload.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    case 'document.attached':
      return `Attached a ${e.payload.kind.replace('-', ' ')}`;
    case 'document.detached':
      return 'Removed a document';
    case 'resume.generated':
      return 'Generated a tailored resume';
    case 'note.added':
      return e.payload.text;
    case 'application.flagged':
      return e.source === 'vesper' ? 'Vesper flagged it to get started' : 'Flagged to get started';
    case 'application.unflagged':
      return 'Removed the get-started flag';
    case 'posting.captured':
      return e.source === 'vesper'
        ? 'Vesper saved the posting from your screen'
        : 'Saved the posting details';
  }
}
