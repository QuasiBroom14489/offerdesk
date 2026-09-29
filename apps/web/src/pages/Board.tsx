import {
  ACTIVE_STATUSES,
  type Application,
  isTerminal,
  STATUS_LABELS,
  type Status,
  TERMINAL_STATUSES,
} from '@offerdesk/shared';
import { type DragEvent, type KeyboardEvent, useState } from 'react';
import { useLocation } from 'wouter';
import { useApplications, useSetStatus } from '../api';
import { StartFlag, StatusMark, stageColor } from '../components/StatusMark';
import { daysUntil, relativeDays } from '../format';
import { ServerDown } from './Home';

type Column = { id: string; label: string; statuses: readonly Status[]; drop: Status };

const COLUMNS: Column[] = [
  ...ACTIVE_STATUSES.map((s) => ({
    id: s,
    label: s === 'oa' ? 'Assessment' : STATUS_LABELS[s],
    statuses: [s],
    drop: s,
  })),
  { id: 'closed', label: 'Closed', statuses: TERMINAL_STATUSES, drop: 'rejected' },
];

/** Keyboard moves walk the active pipeline; closed cards step back into it. */
function step(status: Status, dir: 1 | -1): Status | null {
  if (isTerminal(status)) return dir === -1 ? 'offer' : null;
  const i = ACTIVE_STATUSES.indexOf(status as (typeof ACTIVE_STATUSES)[number]);
  const next = ACTIVE_STATUSES[i + dir];
  if (next) return next;
  return dir === 1 ? 'rejected' : null;
}

export function Board() {
  const { data, isPending, error } = useApplications();
  const setStatus = useSetStatus();
  const [, navigate] = useLocation();
  const [dragOver, setDragOver] = useState<string | null>(null);

  if (isPending) return <p className="text-faint">Loading…</p>;
  if (error) return <ServerDown message={error.message} />;

  const move = (app: Application, to: Status) => {
    if (app.status !== to) setStatus.mutate({ id: app.id, status: to });
  };

  const onDrop = (col: Column) => (e: DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const app = data.find((a) => a.id === e.dataTransfer.getData('text/plain'));
    if (app && !col.statuses.includes(app.status)) move(app, col.drop);
  };

  const onCardKey = (app: Application) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const dir = e.key === ']' || e.key === 'l' ? 1 : e.key === '[' || e.key === 'h' ? -1 : 0;
    if (dir !== 0) {
      e.preventDefault();
      const to = step(app.status, dir);
      if (to) {
        move(app, to);
        // Keep focus on the card as it lands in its new column.
        requestAnimationFrame(() => document.getElementById(`card-${app.id}`)?.focus());
      }
      return;
    }
    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault();
      const cards = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-column="${e.currentTarget.dataset.column}"] [data-card]`,
        ),
      ];
      const i = cards.indexOf(e.currentTarget);
      cards[i + (e.key === 'j' ? 1 : -1)]?.focus();
    }
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-medium">Board</h1>
        <p className="text-sm text-faint">
          Drag a card, or focus it and press <kbd>[</kbd> <kbd>]</kbd> to move it. <kbd>J</kbd>{' '}
          <kbd>K</kbd> move between cards.
        </p>
      </header>
      <div className="-mx-4 flex flex-1 gap-2 overflow-x-auto px-4 pb-4 md:mx-0 md:px-0">
        {COLUMNS.map((col) => {
          const cards = data
            .filter((a) => col.statuses.includes(a.status))
            .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
          return (
            <section
              key={col.id}
              aria-label={col.label}
              data-column={col.id}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(col.id);
              }}
              onDragLeave={() => setDragOver((c) => (c === col.id ? null : c))}
              onDrop={onDrop(col)}
              className={`flex min-w-40 flex-1 basis-0 flex-col rounded-lg p-1.5 transition-colors ${
                dragOver === col.id ? 'bg-sunken' : ''
              }`}
            >
              <h2 className="flex items-center gap-2 px-1.5 pt-1 pb-3 text-sm font-medium">
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ background: stageColor(col.drop) }}
                />
                {col.label}
                <span className="font-normal text-faint">{cards.length}</span>
              </h2>
              <div className="flex flex-col gap-2">
                {cards.map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    id={`card-${a.id}`}
                    data-card
                    data-column={col.id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', a.id)}
                    onClick={() => navigate(`/applications/${a.id}`)}
                    onKeyDown={onCardKey(a)}
                    title={`${a.companyName} — ${a.role}`}
                    className="cursor-grab rounded-lg border border-line bg-raised p-3 text-left hover:border-fg/30 active:cursor-grabbing"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate">{a.companyName}</span>
                      {a.flags.includes('start') && <StartFlag />}
                    </span>
                    <span className="block truncate text-sm text-muted">{a.role}</span>
                    <span className="mt-2 flex items-center justify-between gap-2 text-xs text-faint">
                      {col.id === 'closed' ? (
                        <StatusMark status={a.status} className="!text-xs" />
                      ) : (
                        <span>{relativeDays(a.lastActivityAt)}</span>
                      )}
                      {a.deadline && a.status === 'saved' && (
                        <span
                          className={
                            daysUntil(a.deadline) <= 3
                              ? 'font-medium text-red'
                              : daysUntil(a.deadline) <= 7
                                ? 'font-medium text-yellow'
                                : ''
                          }
                        >
                          due{' '}
                          {relativeDays(new Date(`${a.deadline}T00:00`).getTime()).replace(
                            'in ',
                            '',
                          )}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
                {cards.length === 0 && (
                  <p className="px-1.5 py-4 text-center text-xs text-faint">Drop a card here</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
