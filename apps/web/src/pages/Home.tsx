import type { Dashboard, FollowUpItem, PipelineStats } from '@offerdesk/shared';
import { useState } from 'react';
import { Link } from 'wouter';
import { useDashboard } from '../api';
import { Dot, Pill, type Signal } from '../components/StatusMark';
import { countWord, daysUntil, describeEvent, percent, relativeDays, shortDate } from '../format';

/** Follow-ups turn from yellow to red once they have been quiet this long. */
const OVERDUE_DAYS = 14;

function followUpName(f: FollowUpItem): string {
  if (f.contact) return f.contact.name;
  return f.application?.label.split(' — ')[0] ?? 'Someone';
}

function closesPhrase(days: number): string {
  if (days === 0) return 'closes today';
  if (days === 1) return 'closes tomorrow';
  return `closes in ${days} days`;
}

function deadlineSignal(days: number): Signal {
  if (days <= 3) return 'red';
  if (days <= 7) return 'yellow';
  return 'grey';
}

/** What needs doing today, in the words you would use to say it out loud. */
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

  if (isPending) return <p className="text-faint">Loading…</p>;
  if (error) return <ServerDown message={error.message} />;

  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  if (data.stats.total === 0) {
    return (
      <div className="max-w-3xl">
        <p className="text-sm text-faint">{today}</p>
        <h1 className="mt-2 text-2xl font-medium text-balance">
          Nothing tracked yet. Press <kbd className="align-middle">N</kbd> to add the first posting
          you’re eyeing.
        </h1>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-12">
      <header>
        <p className="text-sm text-faint">{today}</p>
        <h1 className="mt-1.5 max-w-3xl text-2xl leading-snug font-medium tracking-[-0.01em] text-balance md:text-[1.75rem]">
          {headline(data)}
        </h1>
        <Signals stats={data.stats} />
      </header>

      <div className="grid grid-cols-1 gap-x-14 gap-y-12 lg:grid-cols-2">
        <Section title="Follow up" count={data.followUps.length}>
          {data.followUps.length === 0 ? (
            <Empty>Nobody is waiting on you. Anything silent for a week shows up here.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {data.followUps.map((f) => (
                <FollowUpRow key={`${f.kind}-${f.contactId ?? f.applicationId}`} f={f} />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Deadlines" count={data.deadlines.length}>
          {data.deadlines.length === 0 ? (
            <Empty>Nothing you’ve saved closes in the next two weeks.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {data.deadlines.map((a) => {
                const days = a.deadline ? daysUntil(a.deadline) : 0;
                const signal = deadlineSignal(days);
                const when = closesPhrase(days).replace('closes ', '');
                return (
                  <li key={a.id}>
                    <Link
                      href={`/applications/${a.id}`}
                      className="flex items-center justify-between gap-4 py-3"
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{a.companyName}</span>
                        <span className="block truncate text-sm text-muted">{a.role}</span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-0.5">
                        {signal === 'grey' ? (
                          <span className="text-xs text-muted">{when}</span>
                        ) : (
                          <Pill signal={signal}>{when}</Pill>
                        )}
                        <span className="text-xs text-faint">
                          {a.deadline && shortDate(a.deadline)}
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
          <ol className="flex flex-col gap-3.5">
            {data.recent.slice(0, 8).map(({ event, application, contact }) => (
              <li key={event.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 text-sm">
                <span className="text-faint">{relativeDays(event.ts)}</span>
                <span className="min-w-0">
                  <span>{describeEvent(event)}</span>
                  {application ? (
                    <Link
                      href={`/applications/${application.id}`}
                      className="block truncate text-muted hover:text-fg"
                    >
                      {application.label}
                    </Link>
                  ) : (
                    contact && (
                      <Link
                        href={`/people/${contact.id}`}
                        className="block truncate text-muted hover:text-fg"
                      >
                        {contact.name}
                      </Link>
                    )
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

/** The whole pipeline as a traffic light: moving, waiting, closed, not yet sent. */
function Signals({ stats }: { stats: PipelineStats }) {
  const b = stats.byStatus;
  const items: [Signal, number, string][] = [
    ['green', b.oa + b.interview + b.offer, 'moving forward'],
    ['yellow', b.applied, 'waiting to hear'],
    ['red', b.rejected + b.ghosted, 'closed'],
    ['grey', b.saved, 'not yet applied'],
  ];
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-7 gap-y-2 text-sm">
      {items.map(([signal, n, label]) => (
        <span key={label} className="inline-flex items-center gap-2">
          <Dot signal={signal} />
          <span className="font-medium">{n}</span>
          <span className="text-muted">{label}</span>
        </span>
      ))}
      <span className="text-muted">
        <span className="font-medium text-fg">{percent(stats.responseRate)}</span> response rate
      </span>
    </div>
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
      <Link href={href} className="flex items-center justify-between gap-4 py-3">
        <span className="min-w-0">
          <span className="block truncate">
            {followUpName(f)}
            {context && <span className="text-muted">, {context}</span>}
          </span>
          <span className="block text-sm text-muted">{what}</span>
        </span>
        <Pill signal={f.daysWaiting >= OVERDUE_DAYS ? 'red' : 'yellow'}>{f.daysWaiting} days</Pill>
      </Link>
    </li>
  );
}

/** One series, so one neutral ink. Every bar is labeled; hover shows conversion. */
function Funnel({ stats }: { stats: PipelineStats }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...stats.funnel.map((s) => s.count));
  return (
    <div>
      <ul className="flex flex-col gap-4" aria-label="Pipeline funnel">
        {stats.funnel.map((s, i) => {
          const prev = stats.funnel[i - 1];
          const conv = prev && prev.count > 0 ? s.count / prev.count : null;
          return (
            <li
              key={s.stage}
              className="text-sm"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <span className="mb-1.5 flex items-baseline justify-between">
                <span className="text-muted">{s.stage}</span>
                <span>
                  {hover === i && conv !== null && (
                    <span className="mr-2 text-xs text-faint">
                      {percent(conv)} of {prev?.stage.toLowerCase()}
                    </span>
                  )}
                  <span className="font-medium">{s.count}</span>
                </span>
              </span>
              <span className="block h-1.5 rounded-full bg-sunken">
                <span
                  className="block h-full rounded-full bg-fg transition-opacity"
                  style={{
                    width: `max(${(s.count / max) * 100}%, 4px)`,
                    opacity: hover === null || hover === i ? 1 : 0.35,
                  }}
                />
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
      <h2 className="mb-1 flex items-baseline gap-2 text-sm font-medium text-muted">
        {title}
        {count !== undefined && count > 0 && <span className="text-faint">{count}</span>}
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
      <h1 className="text-xl font-medium">Can’t reach the OfferDesk server</h1>
      <p className="mt-2 text-muted">
        Start it with <code className="rounded bg-sunken px-1.5 py-0.5">pnpm start</code> and this
        page will reload on its own.
      </p>
      <p className="mt-4 text-sm text-faint">{message}</p>
    </div>
  );
}
