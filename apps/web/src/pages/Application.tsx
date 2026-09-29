import { STATUS_LABELS, STATUSES, type Status } from '@offerdesk/shared';
import { type FormEvent, useState } from 'react';
import { Link } from 'wouter';
import { useAddNote, useApplication, useSetFlag, useSetStatus } from '../api';
import { buttonClass, inputClass, quietButtonClass } from '../components/Dialog';
import { LogTouchForm } from '../components/LogTouchForm';
import { NewContactDialog } from '../components/NewContactDialog';
import { StartFlag, StatusMark } from '../components/StatusMark';
import { Timeline } from '../components/Timeline';
import { relativeDays, shortDate } from '../format';
import { ServerDown } from './Home';

export function ApplicationPage({ id }: { id: string }) {
  const { data: app, isPending, error } = useApplication(id);
  const setStatus = useSetStatus();
  const setFlag = useSetFlag();
  const addNote = useAddNote();
  const [addingContact, setAddingContact] = useState(false);

  if (isPending) return <p className="text-faint">Loading…</p>;
  if (error) {
    return error.message.includes('not found') ? (
      <p className="text-muted">
        This application doesn’t exist.{' '}
        <Link href="/applications" className="text-accent underline">
          See all applications
        </Link>
        .
      </p>
    ) : (
      <ServerDown message={error.message} />
    );
  }

  const names = new Map(app.contacts.map((c) => [c.id, c.name]));
  const started = app.flags.includes('start');

  const submitNote = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const text = String(new FormData(form).get('text') ?? '').trim();
    if (text) addNote.mutate({ id, text }, { onSuccess: () => form.reset() });
  };

  const facts: [string, React.ReactNode][] = [
    ['Status', <StatusMark key="s" status={app.status} />],
    ['Deadline', app.deadline ? shortDate(app.deadline) : 'None'],
    ['Location', app.location ?? '—'],
    ['Season', app.season ?? '—'],
    ['Found via', app.source ?? '—'],
    ['Added', relativeDays(app.createdAt)],
  ];

  return (
    <div className="flex flex-col gap-8">
      <header>
        <Link href="/applications" className="text-sm text-faint hover:text-accent">
          All applications
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-medium tracking-tight">{app.companyName}</h1>
            <p className="text-lg text-muted">{app.role}</p>
          </div>
          <button
            type="button"
            aria-pressed={started}
            onClick={() => setFlag.mutate({ id, flag: 'start', on: !started })}
            className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
              started ? 'border-fg text-fg' : 'border-line text-muted hover:text-fg'
            }`}
          >
            {started ? <StartFlag label /> : 'Flag to get started'}
          </button>
        </div>
        {app.postingUrl && (
          <a
            href={app.postingUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-sm text-accent underline"
          >
            Open the posting
          </a>
        )}
      </header>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_20rem]">
        <div className="flex min-w-0 flex-col gap-8">
          <section>
            <h2 className="mb-3 text-sm font-medium text-muted">Move to</h2>
            <div className="flex flex-wrap gap-1.5">
              {STATUSES.map((s: Status) => (
                <button
                  type="button"
                  key={s}
                  aria-pressed={app.status === s}
                  onClick={() => setStatus.mutate({ id, status: s })}
                  className={`rounded-md border px-2.5 py-1 text-sm ${
                    app.status === s
                      ? 'border-accent bg-accent text-accent-ink'
                      : 'border-line text-muted hover:border-accent hover:text-fg'
                  }`}
                >
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-medium text-muted">Log a conversation</h2>
            <LogTouchForm applicationId={id} contacts={app.contacts} />
          </section>

          <section>
            <h2 className="mb-3 text-sm font-medium text-muted">Add a note</h2>
            <form onSubmit={submitNote} className="flex flex-col gap-2">
              <textarea
                name="text"
                rows={3}
                placeholder="Interview questions, referral details, salary range…"
                aria-label="Note"
                className={inputClass}
              />
              <div>
                <button type="submit" className={buttonClass} disabled={addNote.isPending}>
                  Save note
                </button>
              </div>
            </form>
          </section>

          <section>
            <h2 className="mb-4 text-sm font-medium text-muted">History</h2>
            <Timeline events={app.timeline} names={names} />
          </section>
        </div>

        <aside className="flex flex-col gap-8">
          <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2.5 text-sm">
            {facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-faint">{k}</dt>
                <dd className="text-fg">{v}</dd>
              </div>
            ))}
          </dl>

          <section>
            <h2 className="mb-2 flex items-center justify-between text-sm font-medium text-muted">
              People at {app.companyName}
            </h2>
            {app.contacts.length === 0 ? (
              <p className="text-sm text-faint">You don’t know anyone here yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {app.contacts.map((c) => (
                  <li key={c.id}>
                    <Link href={`/people/${c.id}`} className="block text-sm hover:text-accent">
                      <span className="font-medium">{c.name}</span>
                      {c.title && <span className="block text-muted">{c.title}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={() => setAddingContact(true)}
              className={`${quietButtonClass} mt-3`}
            >
              Add a person here
            </button>
          </section>
        </aside>
      </div>
      <NewContactDialog
        open={addingContact}
        onClose={() => setAddingContact(false)}
        defaultCompany={app.companyName}
      />
    </div>
  );
}
