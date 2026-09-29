import type { Dashboard, FollowUpItem, PipelineStats } from '@offerdesk/shared';
import { useState } from 'react';
import { Link } from 'wouter';
import { useDashboard } from '../api';
import { countWord, daysUntil, describeEvent, percent, relativeDays, shortDate } from '../format';

function followUpName(f: FollowUpItem): string {
  if (f.contact) return f.contact.name;
  return f.application?.label.split(' — ')[0] ?? 'Someone';
}

function closesPhrase(days: number): string {
  if (days === 0) return 'closes today';
  if (days === 1) return 'closes tomorrow';
  return `closes in ${days} days`;
}

/**
 * The home screen leads with a sentence, not a KPI row: what needs doing
 * today, in the words you would use to say it out loud.
 */
function headline(d: Dashboard): string {
  const f = d.followUps;
  let first: string;
  if (f.length === 0) first = 'You’re caught up on follow-ups';
  else if (f.length === 1 && f[0])
    first = `${followUpName(f[0])} has gone quiet for ${f[0].daysWaiting} days`;
  else first = `${countWord(f.length)} conversations have gone quiet`;

  const next = d.deadlines[0];
  if (!next?.deadline) return `${first}, and nothing is due in the next two weeks.`;
  return `${first}, and ${next.companyName} ${closesPhrase(daysUntil(next.deadline))}.`;
}

export function Home() {
  const { data, isPending, error } = useDashboard();

  if (isPending) return <p className="text-faint">Loading your pipeline…</p>;
  if (error) return <ServerDown message={error.message} />;

  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  if (data.stats.total === 0) {
    return (
      <div className="max-w-2xl">
        <p className="text-muted">{today}</p>
        <h1 className="mt-2 text-3xl leading-tight font-medium text-balance md:text-[2.6rem]">
          Nothing tracked yet. Press <kbd className="align-middle text-base">N</kbd> to add the
          first posting you’re eyeing.
        </h1>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-10">
      <header className="max-w-4xl">
        <p className="text-muted">{today}</p>
        <h1 className="mt-2 text-3xl leading-[1.15] font-medium tracking-[-0.015em] text-balance md:text-[2.75rem]">
          {headline(data)}
        </h1>
        <StatLine stats={data.stats} />
      </header>

      <div className="grid grid-cols-1 gap-x-10 gap-y-10 lg:grid-cols-[1.25fr_1fr]">
        <Section title="Follow up" count={data.followUps.length}>
          {data.followUps.length === 0 ? (
            <Empty>Nobody is waiting on you. Anything silent for a week will show up here.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {data.followUps.map((f) => (
                <FollowUpRow key={`${f.kind}-${f.contactId ?? f.applicationId}`} f={f} />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Deadlines in the next two weeks" count={data.deadlines.length}>
          {data.deadlines.length === 0 ? (
            <Empty>No saved postings close in the next 14 days.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {data.deadlines.map((a) => {
                const days = a.deadline ? daysUntil(a.deadline) : 0;
                return (
                  <li key={a.id}>
                    <Link
                      href={`/applications/${a.id}`}
                      className="flex items-baseline justify-between gap-4 py-3 hover:text-accent"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{a.companyName}</span>
                        <span className="block truncate text-sm text-muted">{a.role}</span>
                      </span>
                      <span
                        className={`shrink-0 text-right text-sm ${days <= 5 ? 'text-attention font-medium' : 'text-muted'}`}
                      >
                        {a.deadline && shortDate(a.deadline)}
                        <span className="block text-xs text-faint">
                          {closesPhrase(days).replace('closes ', '')}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="Pipeline">
          <Funnel stats={data.stats} />
        </Section>

        <Section title="Recent activity">
          <ol className="flex flex-col gap-3">
            {data.recent.map(({ event, application, contact }) => (
              <li key={event.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 text-sm">
                <span className="text-faint">{relativeDays(event.ts)}</span>
                <span className="min-w-0">
                  <span className="text-fg">{describeEvent(event)}</span>
                  {(application || contact) && (
                    <span className="block truncate text-muted">
                      {application ? (
                        <Link
                          href={`/applications/${application.id}`}
                          className="hover:text-accent"
                        >
                          {application.label}
                        </Link>
                      ) : (
                        contact && (
                          <Link href={`/people/${contact.id}`} className="hover:text-accent">
                            {contact.name}
                          </Link>
                        )
                      )}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </div>
  );
}

function StatLine({ stats }: { stats: PipelineStats }) {
  const items: [string, string][] = [
    [String(stats.total), 'tracked'],
    [String(stats.submitted), 'submitted'],
    [percent(stats.responseRate), 'heard back'],
    [String(stats.interviews), stats.interviews === 1 ? 'interview' : 'interviews'],
    [String(stats.offers), stats.offers === 1 ? 'offer' : 'offers'],
  ];
  return (
    <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-2">
      {items.map(([value, label]) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <dt className="sr-only">{label}</dt>
          <dd className="text-lg font-semibold text-fg">{value}</dd>
          <span aria-hidden className="text-sm text-muted">
            {label}
          </span>
        </div>
      ))}
    </dl>
  );
}

function FollowUpRow({ f }: { f: FollowUpItem }) {
  const href = f.contact ? `/people/${f.contact.id}` : `/applications/${f.application?.id}`;
  const what = f.kind === 'contact' ? 'No reply to your last message' : 'No word since you applied';
  const context = f.contact
    ? (f.contact.companyName ?? f.application?.label)
    : f.application?.label.split(' — ')[1];
  return (
    <li>
      <Link href={href} className="flex items-center justify-between gap-4 py-3 hover:text-accent">
        <span className="min-w-0">
          <span className="block truncate font-medium">
            {followUpName(f)}
            {context && <span className="font-normal text-muted">, {context}</span>}
          </span>
          <span className="block text-sm text-muted">{what}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-attention-bg px-2.5 py-0.5 text-sm font-medium text-attention">
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
          >
            <circle cx="8" cy="8" r="6.25" />
            <path d="M8 4.5V8l2.25 1.5" strokeLinecap="round" />
          </svg>
          {f.daysWaiting} days
        </span>
      </Link>
    </li>
  );
}

/**
 * Horizontal funnel. One series, one hue, every bar direct-labeled; hovering a
 * stage shows its conversion from the previous one.
 */
function Funnel({ stats }: { stats: PipelineStats }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...stats.funnel.map((s) => s.count));
  return (
    <div>
      <ul className="flex flex-col gap-2.5" aria-label="Pipeline funnel">
        {stats.funnel.map((s, i) => {
          const prev = stats.funnel[i - 1];
          const conv = prev && prev.count > 0 ? s.count / prev.count : null;
          return (
            <li
              key={s.stage}
              className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 text-sm"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <span className="text-muted">{s.stage}</span>
              <span className="relative flex h-7 items-center">
                <span
                  className="h-full rounded-r-[4px] transition-opacity"
                  style={{
                    width: `max(${(s.count / max) * 100}%, 2px)`,
                    background: 'var(--accent)',
                    opacity: hover === null || hover === i ? 1 : 0.45,
                  }}
                />
                <span className="ml-2 font-semibold text-fg">{s.count}</span>
                {hover === i && conv !== null && (
                  <span
                    role="tooltip"
                    className="ml-3 rounded-md border border-line bg-raised px-2 py-0.5 text-xs text-muted shadow-sm"
                  >
                    {percent(conv)} of {prev?.stage.toLowerCase()}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <table className="sr-only">
        <caption>Pipeline funnel</caption>
        <tbody>
          {stats.funnel.map((s) => (
            <tr key={s.stage}>
              <th scope="row">{s.stage}</th>
              <td>{s.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0">
      <h2 className="mb-2 flex items-baseline gap-2 border-b border-line pb-2 text-base font-semibold">
        {title}
        {count !== undefined && count > 0 && (
          <span className="text-sm font-normal text-faint">{count}</span>
        )}
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-3 text-sm text-faint">{children}</p>;
}

export function ServerDown({ message }: { message: string }) {
  return (
    <div className="max-w-xl">
      <h1 className="text-xl font-semibold">Can’t reach the OfferDesk server</h1>
      <p className="mt-2 text-muted">
        Start it with <code className="rounded bg-sunken px-1.5 py-0.5">pnpm start</code> and this
        page will reload on its own.
      </p>
      <p className="mt-4 text-sm text-faint">{message}</p>
    </div>
  );
}
