import {
  type Cell,
  type ColumnId,
  type ColumnMeta,
  cellText,
  type Report,
  type SavedView,
  SIGNAL_LABELS,
  type Signal,
  type Status,
  type ViewSort,
  type ViewSpec,
} from '@offerdesk/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'wouter';
import {
  type ApiError,
  exportUrl,
  useConnections,
  useCreateView,
  useDeleteView,
  usePushViewSheet,
  useReport,
  useUpdateView,
  useViewSheet,
  useViews,
} from '../api';
import { buttonClass, Dialog, Field, inputClass, quietButtonClass } from '../components/Dialog';
import { Popover } from '../components/Popover';
import { Dot, Pill, StartFlag, StatusMark } from '../components/StatusMark';
import { ColumnsPanel, type DraftFilter, FiltersPanel, isComplete } from '../components/ViewEditor';
import { daysUntil, shortDate, timeAgo } from '../format';
import { useHotkeys } from '../hotkeys';
import { ServerDown } from './Home';

const DEFAULT_VIEW = 'everything';

/** An edit in progress on top of a saved view. Filters may still be half-typed. */
interface Draft {
  columns: ColumnId[];
  filters: DraftFilter[];
  sort: ViewSort[];
  query: string;
}

const toDraft = (spec: ViewSpec): Draft => ({
  columns: [...spec.columns],
  filters: spec.filters.map((f) => ({ ...f })),
  sort: spec.sort.map((s) => ({ ...s })),
  query: spec.query ?? '',
});

/** What the server runs: only finished filters, no empty search. */
const toSpec = (d: Draft): ViewSpec => ({
  columns: d.columns,
  filters: d.filters.filter(isComplete) as ViewSpec['filters'],
  sort: d.sort,
  ...(d.query.trim() ? { query: d.query.trim() } : {}),
});

/** Compare specs by meaning, not key order. */
const key = (s: ViewSpec) =>
  JSON.stringify([
    s.columns,
    s.filters.map((f) => [f.column, f.op, f.value ?? null]),
    s.sort.map((x) => [x.column, x.desc]),
    s.query ?? '',
  ]);

export function ApplicationsTable({ onNew }: { onNew: () => void }) {
  const [params, setParams] = useSearchParams();
  const [, navigate] = useLocation();
  const views = useViews();
  const requested = params.get('view') ?? DEFAULT_VIEW;
  // A deleted or mistyped view id falls back to Everything.
  const view =
    views.data?.find((v) => v.id === requested) ?? views.data?.find((v) => v.id === DEFAULT_VIEW);
  const viewId = view?.id ?? requested;

  const [draft, setDraft] = useState<Draft | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: switching views drops unsaved edits
  useEffect(() => setDraft(null), [viewId]);

  const spec = draft ? toSpec(draft) : null;
  const dirty = !!(spec && view && key(spec) !== key(view.spec));
  const report = useReport(viewId, dirty ? spec : null);
  const edit = (patch: Partial<Draft>) =>
    setDraft((d) => ({ ...(d ?? toDraft(view?.spec as ViewSpec)), ...patch }));
  const current = draft ?? (view ? toDraft(view.spec) : null);

  const [cursor, setCursor] = useState(0);
  const rows = report.data?.rows ?? [];
  useHotkeys({
    j: () => setCursor((c) => Math.min(c + 1, rows.length - 1)),
    k: () => setCursor((c) => Math.max(c - 1, 0)),
    Enter: () => rows[cursor] && navigate(`/applications/${rows[cursor].id}`),
  });

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const update = useUpdateView();

  const selectView = (id: string) => setParams(id === DEFAULT_VIEW ? {} : { view: id });

  if (views.error) return <ServerDown message={views.error.message} />;
  if (report.error) return <ServerDown message={report.error.message} />;
  if (!view || !current || !report.data) return <p className="text-faint">Loading…</p>;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-medium">Applications</h1>
        <button type="button" onClick={onNew} className={buttonClass}>
          Add application <kbd className="border-0 bg-transparent text-accent-ink/80">N</kbd>
        </button>
      </header>

      <ViewTabs views={views.data ?? []} active={view.id} onSelect={selectView} />

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={current.query}
          onChange={(e) => edit({ query: e.target.value })}
          placeholder="Search these rows…"
          aria-label="Search rows"
          className={`${inputClass} w-full sm:w-64`}
        />
        <Popover label="Columns" title="Choose columns">
          {() => (
            <ColumnsPanel columns={current.columns} onChange={(columns) => edit({ columns })} />
          )}
        </Popover>
        <Popover
          label={
            <>
              Filters
              {current.filters.length > 0 && (
                <span className="text-fg tabular-nums">{current.filters.length}</span>
              )}
            </>
          }
          title="Filter rows"
        >
          {() => (
            <FiltersPanel filters={current.filters} onChange={(filters) => edit({ filters })} />
          )}
        </Popover>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {dirty && (
            <>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="px-1 text-sm text-muted hover:text-fg"
              >
                Reset
              </button>
              {!view.builtIn && (
                <button
                  type="button"
                  disabled={update.isPending}
                  onClick={() =>
                    spec &&
                    update.mutate({ id: view.id, spec }, { onSuccess: () => setDraft(null) })
                  }
                  className={buttonClass}
                >
                  Save
                </button>
              )}
              <button
                type="button"
                onClick={() => setSaving(true)}
                className={view.builtIn ? buttonClass : quietButtonClass}
              >
                Save as view…
              </button>
            </>
          )}
          {!dirty && !view.builtIn && (
            <button
              type="button"
              onClick={() => setDeleting(true)}
              className="px-1 text-sm text-muted hover:text-red"
            >
              Delete view
            </button>
          )}
          <ExportMenu viewId={view.id} spec={dirty ? spec : null} />
        </div>
      </div>

      <ReportTable
        report={report.data}
        cursor={cursor}
        stale={report.isPlaceholderData}
        onSort={(column) => {
          const first = current.sort[0];
          const desc = first?.column === column ? !first.desc : false;
          edit({ sort: [{ column, desc }] });
        }}
        onOpen={(id) => navigate(`/applications/${id}`)}
      />

      <p className="text-xs text-faint">
        {report.data.rows.length} {report.data.rows.length === 1 ? 'application' : 'applications'}
        {dirty && ' · edited, not saved'}
      </p>

      <SaveViewDialog
        open={saving}
        onClose={() => setSaving(false)}
        spec={spec ?? view.spec}
        suggestedName={view.builtIn ? `${view.name} (mine)` : `${view.name} copy`}
        onSaved={(v) => {
          setSaving(false);
          selectView(v.id);
        }}
      />
      <DeleteViewDialog
        open={deleting}
        view={view}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          setDeleting(false);
          selectView(DEFAULT_VIEW);
        }}
      />
    </div>
  );
}

function ViewTabs({
  views,
  active,
  onSelect,
}: {
  views: SavedView[];
  active: string;
  onSelect: (id: string) => void;
}) {
  const presets = views.filter((v) => v.builtIn);
  const mine = views.filter((v) => !v.builtIn);
  const tab = (v: SavedView) => (
    <button
      key={v.id}
      type="button"
      role="tab"
      aria-selected={v.id === active}
      onClick={() => onSelect(v.id)}
      className={`-mb-px border-b-2 px-1 pb-2 whitespace-nowrap ${
        v.id === active ? 'border-fg text-fg' : 'border-transparent text-muted hover:text-fg'
      }`}
    >
      {v.name}
    </button>
  );
  return (
    <div
      role="tablist"
      aria-label="Views"
      className="flex gap-4 overflow-x-auto border-b border-line text-sm"
    >
      {presets.map(tab)}
      {mine.length > 0 && <span aria-hidden className="my-1 mb-3 w-px shrink-0 bg-line" />}
      {mine.map(tab)}
    </div>
  );
}

function ExportMenu({ viewId, spec }: { viewId: string; spec: ViewSpec | null }) {
  const item = 'flex flex-col rounded px-2 py-1.5 hover:bg-sunken';
  return (
    <Popover label="Export" title="Export these rows" align="right">
      {(close) => (
        <div className="-m-1 flex w-64 flex-col">
          <a href={exportUrl('xlsx', viewId, spec)} download onClick={close} className={item}>
            Excel workbook
            <span className="text-xs text-faint">Typed columns, colored statuses</span>
          </a>
          <a href={exportUrl('csv', viewId, spec)} download onClick={close} className={item}>
            CSV
            <span className="text-xs text-faint">Opens anywhere</span>
          </a>
          <div aria-hidden className="mx-2 my-1 h-px bg-line" />
          <SheetItem viewId={viewId} edited={spec !== null} />
        </div>
      )}
    </Popover>
  );
}

/** The view's Google Sheet: create it, open it, or bring it up to date. */
function SheetItem({ viewId, edited }: { viewId: string; edited: boolean }) {
  const connections = useConnections();
  const google = connections.data?.google;
  const connected = google?.status === 'connected';
  const sheet = useViewSheet(viewId, connected);
  const push = usePushViewSheet();
  const linked = sheet.data?.sheet ?? null;
  const pad = 'flex flex-col gap-1 px-2 py-1.5';

  if (!google?.available) {
    return (
      <span className={`${pad} text-faint`}>
        Google Sheet
        <span className="text-xs">Google isn’t set up on this deployment</span>
      </span>
    );
  }
  if (!connected) {
    return (
      <Link href="/settings" className="flex flex-col rounded px-2 py-1.5 hover:bg-sunken">
        Google Sheet
        <span className="text-xs text-faint">
          {google.status === 'error'
            ? 'Reconnect Google in Settings'
            : 'Connect Google in Settings'}
        </span>
      </Link>
    );
  }

  const failure = push.error as ApiError | null;
  const busy = push.isPending || sheet.isPending;
  return (
    <div className={pad}>
      {linked ? (
        <a href={linked.url} target="_blank" rel="noreferrer" className="hover:underline">
          Google Sheet ↗
        </a>
      ) : (
        <span>Google Sheet</span>
      )}
      <span className="flex items-center gap-1.5 text-xs text-faint">
        {linked ? (
          <>
            <Dot signal={linked.changesSince === 0 ? 'green' : 'yellow'} />
            {linked.changesSince === 0
              ? `Up to date · updated ${timeAgo(linked.pushedAt)}`
              : `Updated ${timeAgo(linked.pushedAt)} · ${linked.changesSince} ${
                  linked.changesSince === 1 ? 'change' : 'changes'
                } since`}
          </>
        ) : (
          'A copy in your Drive’s OfferDesk folder'
        )}
      </span>
      {edited && <span className="text-xs text-faint">Uses the saved view, not your edits.</span>}
      {failure && (
        <span className="text-xs text-muted">
          {failure.status === 409 ? 'Google needs reconnecting in Settings.' : failure.message}
        </span>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => push.mutate(viewId)}
        className={`${quietButtonClass} mt-1 self-start`}
      >
        {push.isPending ? 'Updating…' : linked ? 'Update now' : 'Create sheet'}
      </button>
    </div>
  );
}

function ReportTable({
  report,
  cursor,
  stale,
  onSort,
  onOpen,
}: {
  report: Report;
  cursor: number;
  stale: boolean;
  onSort: (column: ColumnId) => void;
  onOpen: (id: string) => void;
}) {
  const sort = report.spec.sort[0];
  const flagAt = useMemo(() => {
    const i = report.columns.findIndex((c) => c.id === 'company');
    return i === -1 ? 0 : i;
  }, [report.columns]);

  return (
    <div className={`overflow-x-auto transition-opacity ${stale ? 'opacity-60' : ''}`}>
      <table className="w-full min-w-[40rem] text-left text-sm">
        <thead className="border-b border-line text-muted">
          <tr>
            {report.columns.map((c) => {
              const sorted = sort?.column === c.id;
              return (
                <th
                  key={c.id}
                  scope="col"
                  aria-sort={sorted ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                  className={`py-2 pr-4 font-medium whitespace-nowrap ${alignFor(c)}`}
                >
                  <button type="button" onClick={() => onSort(c.id)} className="hover:text-fg">
                    {c.label}
                    {sorted && <span aria-hidden> {sort.desc ? '↑' : '↓'}</span>}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, i) => (
            <tr
              key={row.id}
              onClick={() => onOpen(row.id)}
              className={`cursor-pointer border-b border-line/60 hover:bg-sunken ${i === cursor ? 'bg-sunken' : ''}`}
            >
              {report.columns.map((c, j) => (
                <td
                  key={c.id}
                  className={`py-2.5 pr-4 ${j === flagAt ? 'font-medium' : 'text-muted'} ${alignFor(c)}`}
                >
                  <span className="inline-flex items-center gap-2">
                    <CellView column={c} cell={row.cells[j] ?? null} />
                    {j === flagAt && row.flags.includes('start') && <StartFlag />}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {report.rows.length === 0 && (
        <p className="py-8 text-center text-sm text-faint">No applications match this view.</p>
      )}
    </div>
  );
}

const alignFor = (c: ColumnMeta) => (c.type === 'number' ? 'text-right tabular-nums' : '');

/** Days-waiting pills use the same thresholds as follow-ups on Home. */
const WAIT_SIGNAL = (days: number): Exclude<Signal, 'grey'> | null =>
  days >= 14 ? 'red' : days >= 7 ? 'yellow' : null;

function CellView({ column, cell }: { column: ColumnMeta; cell: Cell }) {
  if (cell === null || cell === '') return <span className="text-faint">—</span>;

  switch (column.type) {
    case 'status':
      return <StatusMark status={cell as Status} />;
    case 'signal':
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <Dot signal={cell as Signal} />
          {SIGNAL_LABELS[cell as Signal]}
        </span>
      );
    case 'number': {
      const n = Number(cell);
      const text = column.unit
        ? `${n} ${n === 1 ? column.unit.replace(/s$/, '') : column.unit}`
        : n;
      const signal = column.id === 'daysWaiting' ? WAIT_SIGNAL(n) : null;
      return signal ? <Pill signal={signal}>{text}</Pill> : <span>{text}</span>;
    }
    case 'date': {
      const iso = String(cell);
      if (column.id === 'deadline') {
        const d = daysUntil(iso);
        const tone =
          d < 0
            ? 'text-faint'
            : d <= 3
              ? 'font-medium text-red'
              : d <= 7
                ? 'font-medium text-yellow'
                : '';
        return <span className={`whitespace-nowrap ${tone}`}>{shortDate(iso)}</span>;
      }
      return <span className="whitespace-nowrap">{shortDate(iso)}</span>;
    }
    case 'url': {
      const href = String(cell);
      let host = href;
      try {
        host = new URL(href).host.replace(/^www\./, '');
      } catch {}
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="underline decoration-line underline-offset-2 hover:text-fg"
        >
          {host}
        </a>
      );
    }
    default:
      return <span>{cellText(column, cell)}</span>;
  }
}

function SaveViewDialog({
  open,
  onClose,
  spec,
  suggestedName,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  spec: ViewSpec;
  suggestedName: string;
  onSaved: (v: SavedView) => void;
}) {
  const create = useCreateView();
  const [name, setName] = useState(suggestedName);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset each time it opens
  useEffect(() => {
    if (open) {
      setName(suggestedName);
      create.reset();
    }
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title="Save view">
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ name, spec }, { onSuccess: onSaved });
        }}
      >
        <h2 className="text-lg font-medium">Save as a view</h2>
        <Field label="Name">
          <input
            autoFocus
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </Field>
        {create.error && <p className="text-sm text-red">{create.error.message}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={quietButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={create.isPending} className={buttonClass}>
            Save view
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteViewDialog({
  open,
  view,
  onClose,
  onDeleted,
}: {
  open: boolean;
  view: SavedView;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const remove = useDeleteView();
  return (
    <Dialog open={open} onClose={onClose} title="Delete view">
      <div className="flex flex-col gap-4 p-5">
        <h2 className="text-lg font-medium">Delete “{view.name}”?</h2>
        <p className="text-sm text-muted">
          Only the view goes. Your applications and their history stay as they are.
        </p>
        {remove.error && <p className="text-sm text-red">{remove.error.message}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={quietButtonClass}>
            Cancel
          </button>
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => remove.mutate(view.id, { onSuccess: onDeleted })}
            className={buttonClass}
          >
            Delete view
          </button>
        </div>
      </div>
    </Dialog>
  );
}
