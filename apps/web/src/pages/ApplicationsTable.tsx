import { type Application, STATUS_LABELS, STATUSES, type Status } from '@offerdesk/shared';
import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useApplications } from '../api';
import { buttonClass, inputClass } from '../components/Dialog';
import { StartFlag, StatusMark } from '../components/StatusMark';
import { relativeDays, shortDate } from '../format';
import { useHotkeys } from '../hotkeys';
import { ServerDown } from './Home';

type SortKey = 'company' | 'role' | 'status' | 'deadline' | 'activity';

const SORTERS: Record<SortKey, (a: Application, b: Application) => number> = {
  company: (a, b) => a.companyName.localeCompare(b.companyName),
  role: (a, b) => a.role.localeCompare(b.role),
  status: (a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status),
  deadline: (a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999'),
  activity: (a, b) => b.lastActivityAt - a.lastActivityAt,
};

export function ApplicationsTable({ onNew }: { onNew: () => void }) {
  const { data, isPending, error } = useApplications();
  const [, navigate] = useLocation();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status | 'all'>('all');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'activity',
    desc: false,
  });
  const [cursor, setCursor] = useState(0);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (data ?? []).filter(
      (a) =>
        (status === 'all' || a.status === status) &&
        (!q ||
          `${a.companyName} ${a.role} ${a.location ?? ''} ${a.source ?? ''}`
            .toLowerCase()
            .includes(q)),
    );
    const sorted = filtered.sort(SORTERS[sort.key]);
    return sort.desc ? sorted.reverse() : sorted;
  }, [data, query, status, sort]);

  useHotkeys({
    j: () => setCursor((c) => Math.min(c + 1, rows.length - 1)),
    k: () => setCursor((c) => Math.max(c - 1, 0)),
    Enter: () => rows[cursor] && navigate(`/applications/${rows[cursor].id}`),
  });

  if (isPending) return <p className="text-faint">Loading…</p>;
  if (error) return <ServerDown message={error.message} />;

  const header = (key: SortKey, label: string, className = '') => (
    <th
      scope="col"
      className={`py-2 pr-4 font-medium ${className}`}
      aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : false }))}
        className="hover:text-fg"
      >
        {label}
        {sort.key === key && <span aria-hidden> {sort.desc ? '↑' : '↓'}</span>}
      </button>
    </th>
  );

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-medium">All applications</h1>
        <button type="button" onClick={onNew} className={buttonClass}>
          Add application <kbd className="border-0 bg-transparent text-accent-ink/80">N</kbd>
        </button>
      </header>

      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by company, role, location…"
          aria-label="Filter applications"
          className={`${inputClass} w-full sm:w-80`}
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as Status | 'all')}
          aria-label="Filter by status"
          className={inputClass}
        >
          <option value="all">Every status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead className="border-b border-line text-muted">
            <tr>
              {header('company', 'Company')}
              {header('role', 'Role')}
              {header('status', 'Status')}
              {header('deadline', 'Deadline')}
              {header('activity', 'Last activity', 'text-right')}
            </tr>
          </thead>
          <tbody>
            {rows.map((a, i) => (
              <tr
                key={a.id}
                onClick={() => navigate(`/applications/${a.id}`)}
                className={`cursor-pointer border-b border-line/60 hover:bg-sunken ${i === cursor ? 'bg-sunken' : ''}`}
              >
                <td className="py-2.5 pr-4 font-medium">
                  <span className="inline-flex items-center gap-2">
                    {a.companyName}
                    {a.flags.includes('start') && <StartFlag />}
                  </span>
                </td>
                <td className="py-2.5 pr-4 text-muted">
                  {a.role}
                  {a.location && <span className="block text-xs text-faint">{a.location}</span>}
                </td>
                <td className="py-2.5 pr-4">
                  <StatusMark status={a.status} />
                </td>
                <td className="py-2.5 pr-4 text-muted">
                  {a.deadline ? shortDate(a.deadline) : <span className="text-faint">None</span>}
                </td>
                <td className="py-2.5 text-right text-muted">{relativeDays(a.lastActivityAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="py-8 text-center text-sm text-faint">
            {data.length === 0
              ? 'No applications yet. Press N to add one.'
              : 'No applications match these filters.'}
          </p>
        )}
      </div>
    </div>
  );
}
