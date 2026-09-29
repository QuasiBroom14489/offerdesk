import type { AnyEvent } from '@offerdesk/shared';
import { describeEvent } from '../format';
import { stageColor } from './StatusMark';

/** Status changes take their new stage's signal; replies are green; the rest stay grey. */
function tone(e: AnyEvent): string {
  switch (e.kind) {
    case 'status.changed':
      return stageColor(e.payload.to);
    case 'application.created':
      return stageColor(e.payload.status);
    case 'response.received':
      return 'var(--green)';
    default:
      return 'var(--grey-dot)';
  }
}

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
            style={{ background: tone(e) }}
          />
          <p className={e.kind === 'note.added' ? 'whitespace-pre-wrap' : ''}>{describeEvent(e)}</p>
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
