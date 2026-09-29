import {
  COLUMNS_BY_ID,
  type ColumnId,
  FILTER_OP_LABELS,
  type FilterOp,
  OPS_FOR_TYPE,
  REPORT_COLUMNS,
  SIGNAL_LABELS,
  SIGNALS,
  STATUS_LABELS,
  STATUSES,
  ViewFilter,
} from '@offerdesk/shared';
import { useState } from 'react';
import { inputClass } from './Dialog';

/** A filter as it is being typed: it may not have a value yet. */
export interface DraftFilter {
  column: ColumnId;
  op: FilterOp;
  value?: string | number | string[];
}

export const isComplete = (f: DraftFilter): boolean => ViewFilter.safeParse(f).success;

const iconButton =
  'grid size-6 place-items-center rounded text-faint hover:bg-sunken hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent';

// ── columns ──────────────────────────────────────────────────────────────────

export function ColumnsPanel({
  columns,
  onChange,
}: {
  columns: ColumnId[];
  onChange: (columns: ColumnId[]) => void;
}) {
  const move = (i: number, by: -1 | 1) => {
    const next = [...columns];
    [next[i], next[i + by]] = [next[i + by] as ColumnId, next[i] as ColumnId];
    onChange(next);
  };
  const hidden = REPORT_COLUMNS.filter((c) => !columns.includes(c.id));

  return (
    <div className="flex flex-col gap-3">
      <section>
        <h3 className="mb-1 text-xs text-faint">Shown, in order</h3>
        <ol className="flex flex-col">
          {columns.map((id, i) => (
            <li key={id} className="flex items-center gap-1 rounded py-0.5 pl-1 hover:bg-sunken">
              <span className="flex-1">{COLUMNS_BY_ID[id].label}</span>
              <button
                type="button"
                className={iconButton}
                disabled={i === 0}
                onClick={() => move(i, -1)}
                aria-label={`Move ${COLUMNS_BY_ID[id].label} left`}
              >
                ↑
              </button>
              <button
                type="button"
                className={iconButton}
                disabled={i === columns.length - 1}
                onClick={() => move(i, 1)}
                aria-label={`Move ${COLUMNS_BY_ID[id].label} right`}
              >
                ↓
              </button>
              <button
                type="button"
                className={iconButton}
                disabled={columns.length === 1}
                onClick={() => onChange(columns.filter((c) => c !== id))}
                aria-label={`Hide ${COLUMNS_BY_ID[id].label}`}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      </section>
      {hidden.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs text-faint">Add a column</h3>
          <ul className="flex flex-col">
            {hidden.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onChange([...columns, c.id])}
                  className="flex w-full items-baseline gap-2 rounded px-1 py-1 text-left hover:bg-sunken"
                >
                  <span className="text-faint">+</span>
                  <span>{c.label}</span>
                  <span className="truncate text-xs text-faint">{c.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ── filters ──────────────────────────────────────────────────────────────────

export function FiltersPanel({
  filters,
  onChange,
}: {
  filters: DraftFilter[];
  onChange: (filters: DraftFilter[]) => void;
}) {
  const set = (i: number, f: DraftFilter) => onChange(filters.map((x, j) => (j === i ? f : x)));

  return (
    <div className="flex flex-col gap-2">
      {filters.length === 0 && <p className="text-faint">No filters: every application shows.</p>}
      {filters.map((f, i) => {
        const type = COLUMNS_BY_ID[f.column].type;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: filters have no identity beyond position
          <div key={i} className="flex flex-col gap-1.5 border-b border-line pb-2 last:border-0">
            <div className="flex items-center gap-1.5">
              <select
                aria-label="Column"
                value={f.column}
                onChange={(e) => {
                  const column = e.target.value as ColumnId;
                  set(i, { column, op: OPS_FOR_TYPE[COLUMNS_BY_ID[column].type][0] as FilterOp });
                }}
                className={`${inputClass} min-w-0 flex-1 py-1`}
              >
                {REPORT_COLUMNS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Condition"
                value={f.op}
                onChange={(e) => {
                  const op = e.target.value as FilterOp;
                  // A list and a single value don't convert into each other.
                  const keep = (op === 'in') === Array.isArray(f.value);
                  set(i, { ...f, op, value: keep ? f.value : undefined });
                }}
                className={`${inputClass} py-1`}
              >
                {OPS_FOR_TYPE[type].map((op) => (
                  <option key={op} value={op}>
                    {FILTER_OP_LABELS[op]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={iconButton}
                onClick={() => onChange(filters.filter((_, j) => j !== i))}
                aria-label="Remove filter"
              >
                ×
              </button>
            </div>
            <FilterValue filter={f} onChange={(value) => set(i, { ...f, value })} />
            {!isComplete(f) && f.value !== undefined && (
              <p className="text-xs text-red">
                {type === 'date' ? 'Use YYYY-MM-DD, today, or today+7' : 'Not a valid value'}
              </p>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => onChange([...filters, { column: 'status', op: 'eq', value: 'applied' }])}
        className="self-start rounded px-1 py-1 text-muted hover:bg-sunken hover:text-fg"
      >
        + Add filter
      </button>
    </div>
  );
}

const CHOICES: Partial<Record<string, { value: string; label: string }[]>> = {
  status: STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
  signal: SIGNALS.map((s) => ({ value: s, label: SIGNAL_LABELS[s] })),
};

function FilterValue({
  filter: f,
  onChange,
}: {
  filter: DraftFilter;
  onChange: (value: DraftFilter['value']) => void;
}) {
  if (f.op === 'empty' || f.op === 'notEmpty') return null;
  const type = COLUMNS_BY_ID[f.column].type;
  const choices = CHOICES[type];

  if (choices && f.op === 'in') {
    const picked = Array.isArray(f.value) ? f.value : [];
    return (
      <div className="flex flex-wrap gap-1">
        {choices.map((c) => {
          const on = picked.includes(c.value);
          return (
            <button
              key={c.value}
              type="button"
              aria-pressed={on}
              onClick={() => {
                const next = on ? picked.filter((v) => v !== c.value) : [...picked, c.value];
                onChange(next.length ? next : undefined);
              }}
              className={`rounded-full border px-2 py-0.5 text-xs ${on ? 'border-fg text-fg' : 'border-line text-muted hover:text-fg'}`}
            >
              {c.label}
            </button>
          );
        })}
      </div>
    );
  }
  if (choices) {
    return (
      <select
        aria-label="Value"
        value={typeof f.value === 'string' ? f.value : ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className={`${inputClass} py-1`}
      >
        <option value="">Choose…</option>
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    );
  }
  if (type === 'number') {
    return (
      <input
        type="number"
        aria-label="Value"
        value={typeof f.value === 'number' ? f.value : ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        className={`${inputClass} py-1`}
      />
    );
  }
  if (f.op === 'in') return <ListInput value={f.value} onChange={onChange} />;
  return (
    <input
      type="text"
      aria-label="Value"
      placeholder={type === 'date' ? 'today+7 or 2026-11-01' : 'Value'}
      value={typeof f.value === 'string' ? f.value : ''}
      onChange={(e) => onChange(e.target.value.trim() ? e.target.value : undefined)}
      className={`${inputClass} py-1`}
    />
  );
}

/** Comma-separated values. Keeps its own text so a trailing comma survives typing. */
function ListInput({
  value,
  onChange,
}: {
  value: DraftFilter['value'];
  onChange: (value: string[] | undefined) => void;
}) {
  const [raw, setRaw] = useState(Array.isArray(value) ? value.join(', ') : '');
  return (
    <input
      type="text"
      aria-label="Values"
      placeholder="Comma-separated, e.g. Handshake, LinkedIn"
      value={raw}
      onChange={(e) => {
        setRaw(e.target.value);
        const parts = e.target.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        onChange(parts.length ? parts : undefined);
      }}
      className={`${inputClass} py-1`}
    />
  );
}
