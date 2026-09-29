import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useApplications, useContact, useContacts } from '../api';
import { buttonClass, inputClass } from '../components/Dialog';
import { LogTouchForm } from '../components/LogTouchForm';
import { Timeline } from '../components/Timeline';
import { relativeDays } from '../format';
import { ServerDown } from './Home';

export function People({ onNew }: { onNew: () => void }) {
  const { data, isPending, error } = useContacts();
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data ?? []).filter(
      (c) =>
        !q ||
        `${c.name} ${c.companyName ?? ''} ${c.title ?? ''} ${c.howMet ?? ''}`
          .toLowerCase()
          .includes(q),
    );
  }, [data, query]);

  if (isPending) return <p className="text-faint">Loading…</p>;
  if (error) return <ServerDown message={error.message} />;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">People</h1>
        <button type="button" onClick={onNew} className={buttonClass}>
          Add person
        </button>
      </header>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Who do I know at…"
        aria-label="Filter people"
        className={`${inputClass} w-full sm:w-80`}
      />
      {rows.length === 0 ? (
        <p className="py-8 text-sm text-faint">
          {data.length === 0
            ? 'Add the recruiters, alumni and engineers you meet, and log each message so nobody slips through.'
            : `Nobody matches “${query}”.`}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((c) => (
            <li key={c.id}>
              <Link
                href={`/people/${c.id}`}
                className="flex items-center justify-between gap-4 py-3 hover:text-accent"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{c.name}</span>
                  <span className="block truncate text-sm text-muted">
                    {[c.title, c.companyName].filter(Boolean).join(', ') || 'No company'}
                  </span>
                </span>
                <span className="shrink-0 text-right text-sm text-faint">
                  {c.lastTouchedAt
                    ? `Last talked ${relativeDays(c.lastTouchedAt)}`
                    : 'Not contacted yet'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Person({ id }: { id: string }) {
  const { data: c, isPending, error } = useContact(id);
  const apps = useApplications();

  if (isPending) return <p className="text-faint">Loading…</p>;
  if (error) return <ServerDown message={error.message} />;

  const atCompany = (apps.data ?? []).filter((a) => a.companyId === c.companyId);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <header>
        <Link href="/people" className="text-sm text-faint hover:text-accent">
          People
        </Link>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{c.name}</h1>
        <p className="text-lg text-muted">{[c.title, c.companyName].filter(Boolean).join(', ')}</p>
        <p className="mt-2 flex flex-wrap gap-x-4 text-sm">
          {c.email && (
            <a href={`mailto:${c.email}`} className="text-accent underline">
              {c.email}
            </a>
          )}
          {c.linkedin && (
            <a
              href={c.linkedin.startsWith('http') ? c.linkedin : `https://${c.linkedin}`}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline"
            >
              LinkedIn
            </a>
          )}
          {c.howMet && <span className="text-faint">Met at {c.howMet.toLowerCase()}</span>}
        </p>
      </header>
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_20rem]">
        <div className="flex min-w-0 flex-col gap-8">
          <section>
            <h2 className="mb-3 text-base font-semibold">Log a conversation</h2>
            <LogTouchForm contactId={id} />
          </section>
          <section>
            <h2 className="mb-4 text-base font-semibold">History</h2>
            <Timeline events={c.timeline} />
          </section>
        </div>
        <aside>
          <h2 className="mb-2 text-base font-semibold">
            Applications at {c.companyName ?? 'their company'}
          </h2>
          {atCompany.length === 0 ? (
            <p className="text-sm text-faint">None yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {atCompany.map((a) => (
                <li key={a.id}>
                  <Link href={`/applications/${a.id}`} className="text-sm hover:text-accent">
                    {a.role}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
