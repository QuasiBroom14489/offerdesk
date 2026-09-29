import type { AnyEvent } from '@offerdesk/shared';
import { describeEvent } from '../format';

const KIND_TONE: Partial<Record<AnyEvent['kind'], string>> = {
  'status.changed': 'var(--accent)',
  'response.received': 'var(--good)',
  'outreach.sent': 'var(--fg-muted)',
  'interview.scheduled': 'var(--accent)',
};

/** The event log, newest first. This is the application's real history. */
export function Timeline({ events, names }: { events: AnyEvent[]; names?: Map<string, string> }) {
  if (events.length === 0) return <p className="text-sm text-faint">Nothing has happened yet.</p>;
  return (
    <ol className="relative flex flex-col gap-4 border-l border-line pl-5">
      {[...events].reverse().map((e) => (
        <li key={e.id} className="relative text-sm">
          <span
            aria-hidden
            className="absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-bg"
            style={{ background: KIND_TONE[e.kind] ?? 'var(--fg-faint)' }}
          />
          <p className={e.kind === 'note.added' ? 'whitespace-pre-wrap text-fg' : 'text-fg'}>
            {describeEvent(e)}
          </p>
          <p className="text-xs text-faint">
            {new Date(e.ts).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
            {e.contactId && names?.get(e.contactId) && ` with ${names.get(e.contactId)}`}
          </p>
        </li>
      ))}
    </ol>
  );
}
