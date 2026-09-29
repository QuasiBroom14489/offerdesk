import {
  type Cell,
  COLUMNS_BY_ID,
  type ColumnMeta,
  cellText,
  type ReportRow,
  SIGNALS,
  STATUSES,
  type ViewFilter,
  type ViewSort,
  type ViewSpec,
} from '@offerdesk/shared';
import { DAY, isoDate } from '../dates.js';
import { COLUMN_GETTERS, type RowFacts } from './columns.js';

/**
 * Turn facts into rows for a view: filter (all must match), free-text search,
 * sort, then project the chosen columns. Pure — the same spec over the same
 * facts always yields the same rows, which is what makes exports match the screen.
 */
export function runView(
  spec: ViewSpec,
  facts: readonly RowFacts[],
  now: number,
): { columns: ColumnMeta[]; rows: ReportRow[] } {
  const columns = spec.columns.map((id) => COLUMNS_BY_ID[id]);
  const filters = spec.filters.map((f) => compileFilter(f, now));
  const query = spec.query?.toLowerCase();

  const rows = facts
    .filter((r) => filters.every((matches) => matches(r)))
    .map((r) => ({ facts: r, cells: columns.map((c) => COLUMN_GETTERS[c.id](r)) }))
    .filter(
      ({ cells }) =>
        !query ||
        columns.some((c, i) =>
          cellText(c, cells[i] ?? null)
            .toLowerCase()
            .includes(query),
        ),
    );

  if (spec.sort.length > 0) {
    const keys = spec.sort.map((s) => ({ ...s, cmp: comparator(s) }));
    rows.sort((a, b) => {
      for (const k of keys) {
        const x = COLUMN_GETTERS[k.column](a.facts);
        const y = COLUMN_GETTERS[k.column](b.facts);
        // Empty cells sort last whichever way the column is sorted.
        if (x === null || y === null) {
          if (x !== y) return x === null ? 1 : -1;
          continue;
        }
        const d = k.cmp(x, y);
        if (d !== 0) return k.desc ? -d : d;
      }
      return 0;
    });
  }

  return {
    columns,
    rows: rows.map(({ facts, cells }) => ({ id: facts.app.id, flags: facts.app.flags, cells })),
  };
}

function comparator(s: ViewSort): (x: string | number, y: string | number) => number {
  const type = COLUMNS_BY_ID[s.column].type;
  if (type === 'status') return byIndex(STATUSES);
  if (type === 'signal') return byIndex(SIGNALS);
  if (type === 'number') return (x, y) => Number(x) - Number(y);
  if (type === 'date') return (x, y) => String(x).localeCompare(String(y));
  return (x, y) => String(x).localeCompare(String(y), undefined, { sensitivity: 'base' });
}

const byIndex =
  (order: readonly string[]) =>
  (x: string | number, y: string | number): number =>
    order.indexOf(String(x)) - order.indexOf(String(y));

function compileFilter(f: ViewFilter, now: number): (r: RowFacts) => boolean {
  const get = COLUMN_GETTERS[f.column];
  const type = COLUMNS_BY_ID[f.column].type;
  const norm = (v: string | number): string | number => {
    if (type === 'number') return Number(v);
    if (type === 'date') return resolveDate(String(v), now);
    return String(v).toLowerCase();
  };
  const cell = (r: RowFacts): string | number | null => {
    const v: Cell = get(r);
    return v === null || v === '' ? null : norm(v);
  };

  if (f.op === 'empty') return (r) => cell(r) === null;
  if (f.op === 'notEmpty') return (r) => cell(r) !== null;
  if (f.op === 'in') {
    const set = new Set((f.value as string[]).map(norm));
    return (r) => {
      const v = cell(r);
      return v !== null && set.has(v);
    };
  }

  const want = norm(f.value as string | number);
  const test: (v: string | number) => boolean = {
    eq: (v: string | number) => v === want,
    neq: (v: string | number) => v !== want,
    contains: (v: string | number) => String(v).includes(String(want)),
    gt: (v: string | number) => v > want,
    gte: (v: string | number) => v >= want,
    lt: (v: string | number) => v < want,
    lte: (v: string | number) => v <= want,
  }[f.op];
  // An empty cell "is not" anything, and fails every other comparison.
  return (r) => {
    const v = cell(r);
    return v === null ? f.op === 'neq' : test(v);
  };
}

/** `2026-10-01` stays as is; `today+7` becomes the date a week from `now`. */
export function resolveDate(value: string, now: number): string {
  const m = /^today(?:([+-])(\d+))?$/.exec(value);
  if (!m) return value;
  const days = m[2] ? Number(m[2]) * (m[1] === '-' ? -1 : 1) : 0;
  return isoDate(now + days * DAY);
}
