import { z } from 'zod';
import type { Flag } from './events.js';
import { SIGNAL_LABELS, type Signal, STATUS_LABELS, type Status } from './status.js';

/**
 * The table builder's vocabulary. Column *metadata* lives here so every client
 * can offer the same pickers; how each value is computed lives in core
 * (`reports/columns.ts`). A view is just data — columns, filters, sort — so it
 * can be saved, exported, or pushed to a sheet without code.
 */

export const COLUMN_TYPES = ['text', 'number', 'date', 'status', 'signal', 'url'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export interface ColumnMeta {
  id: ColumnId;
  label: string;
  type: ColumnType;
  /** Shown after numbers, e.g. "days". */
  unit?: string;
  /** One line for the column picker. */
  description: string;
}

const col = <const I extends string>(
  id: I,
  label: string,
  type: ColumnType,
  description: string,
  unit?: string,
): { id: I; label: string; type: ColumnType; description: string; unit?: string } => ({
  id,
  label,
  type,
  description,
  ...(unit ? { unit } : {}),
});

/** Every column a view can show, stored ones first. Order here is picker order. */
export const REPORT_COLUMNS = [
  col('company', 'Company', 'text', 'Company name'),
  col('role', 'Role', 'text', 'Role title'),
  col('location', 'Location', 'text', 'Where the role is based'),
  col('season', 'Season', 'text', 'e.g. Summer 2027'),
  col('source', 'Source', 'text', 'Where the posting was found'),
  col('deadline', 'Deadline', 'date', 'Application deadline'),
  col('postingUrl', 'Posting', 'url', 'Link to the posting'),
  col('pay', 'Pay', 'text', 'Pay as read from the posting'),
  col('added', 'Added', 'date', 'When it was added to the tracker'),
  col('status', 'Status', 'status', 'Current stage'),
  col('signal', 'Signal', 'signal', 'Moving forward, waiting, or closed'),
  col('flag', 'Flag', 'text', '"Get started" when flagged'),
  col('appliedOn', 'Applied', 'date', 'When it was submitted'),
  col('daysSinceApplied', 'Since applied', 'number', 'Days since it was submitted', 'days'),
  col(
    'daysWaiting',
    'Waiting',
    'number',
    'Days since you last acted, while still waiting to hear',
    'days',
  ),
  col('responseDays', 'Response time', 'number', 'Days from applying to first response', 'days'),
  col('contacts', 'People', 'number', 'People you know at the company'),
  col('lastContact', 'Last contact', 'date', 'Last outreach or reply with anyone there'),
  col('nextInterview', 'Next interview', 'date', 'Soonest upcoming interview'),
  col('lastActivity', 'Last activity', 'date', 'Last thing that happened'),
] as const satisfies readonly (Omit<ColumnMeta, 'id'> & { id: string })[];

export type ColumnId = (typeof REPORT_COLUMNS)[number]['id'];
export const COLUMN_IDS = REPORT_COLUMNS.map((c) => c.id) as [ColumnId, ...ColumnId[]];
export const ColumnId = z.enum(COLUMN_IDS);

export const COLUMNS_BY_ID = Object.fromEntries(REPORT_COLUMNS.map((c) => [c.id, c])) as Record<
  ColumnId,
  ColumnMeta
>;

export const FILTER_OPS = [
  'eq',
  'neq',
  'in',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'empty',
  'notEmpty',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Which operators make sense for which column types. */
export const OPS_FOR_TYPE: Record<ColumnType, readonly FilterOp[]> = {
  text: ['contains', 'eq', 'neq', 'in', 'empty', 'notEmpty'],
  url: ['contains', 'empty', 'notEmpty'],
  status: ['eq', 'neq', 'in'],
  signal: ['eq', 'neq', 'in'],
  number: ['gte', 'lte', 'gt', 'lt', 'eq', 'neq', 'empty', 'notEmpty'],
  date: ['gte', 'lte', 'gt', 'lt', 'eq', 'neq', 'empty', 'notEmpty'],
};

export const FILTER_OP_LABELS: Record<FilterOp, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is any of',
  contains: 'contains',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  empty: 'is empty',
  notEmpty: 'is not empty',
};

/**
 * Date filters take `YYYY-MM-DD` or a date relative to the day the view runs,
 * `today`, `today+7`, `today-30`, so a saved view stays current.
 */
export const DateFilterValue = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2}|today([+-]\d{1,4})?)$/, 'expected YYYY-MM-DD or today±N');

export const ViewFilter = z
  .object({
    column: ColumnId,
    op: z.enum(FILTER_OPS),
    value: z.union([z.string(), z.number(), z.array(z.string()).min(1)]).optional(),
  })
  .superRefine((f, ctx) => {
    const meta = COLUMNS_BY_ID[f.column];
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message, path: ['value'] });
    if (!OPS_FOR_TYPE[meta.type].includes(f.op)) {
      ctx.addIssue({
        code: 'custom',
        message: `"${f.op}" does not apply to ${meta.label}`,
        path: ['op'],
      });
      return;
    }
    if (f.op === 'empty' || f.op === 'notEmpty') return;
    if (f.value === undefined) return issue('a value is required');
    if (f.op === 'in') {
      if (!Array.isArray(f.value)) issue('expected a list of values');
      return;
    }
    if (Array.isArray(f.value)) return issue('expected a single value');
    if (meta.type === 'number' && typeof f.value !== 'number') issue('expected a number');
    if (meta.type === 'date' && !DateFilterValue.safeParse(f.value).success) {
      issue('expected YYYY-MM-DD or today±N');
    }
  });
export type ViewFilter = z.infer<typeof ViewFilter>;

export const ViewSort = z.object({ column: ColumnId, desc: z.boolean().default(false) });
export type ViewSort = z.infer<typeof ViewSort>;

export const ViewSpec = z.object({
  columns: z
    .array(ColumnId)
    .min(1, 'pick at least one column')
    .refine((cs) => new Set(cs).size === cs.length, 'columns must be unique'),
  /** All must match. Filters may use columns the view does not show. */
  filters: z.array(ViewFilter).max(20).default([]),
  /** First key wins; nulls always sort last. */
  sort: z.array(ViewSort).max(3).default([]),
  /** Free text matched against every text cell of the shown columns. */
  query: z.string().trim().max(200).optional(),
});
export type ViewSpec = z.infer<typeof ViewSpec>;
export type ViewSpecInput = z.input<typeof ViewSpec>;

export const NewView = z.object({
  name: z.string().trim().min(1).max(80),
  spec: ViewSpec,
});
export type NewView = z.input<typeof NewView>;

export const ViewPatch = NewView.partial();
export type ViewPatch = z.input<typeof ViewPatch>;

export interface SavedView {
  id: string;
  name: string;
  spec: ViewSpec;
  /** Presets ship in code and cannot be edited or deleted; save a copy instead. */
  builtIn: boolean;
  /** Google Sheet this view is pushed to, once connected. */
  sheetId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A cell's raw value: status and signal ids, ISO dates, numbers, or text. */
export type Cell = string | number | null;

export interface ReportRow {
  /** The application id. */
  id: string;
  flags: Flag[];
  /** Aligned with `Report.columns`. */
  cells: Cell[];
}

export interface Report {
  view: { id: string; name: string; builtIn: boolean } | null;
  spec: ViewSpec;
  columns: ColumnMeta[];
  rows: ReportRow[];
  generatedAt: number;
}

/** A cell as plain words: what CSV, search and screen readers see. */
export function cellText(column: Pick<ColumnMeta, 'type'>, cell: Cell): string {
  if (cell === null) return '';
  if (column.type === 'status') return STATUS_LABELS[cell as Status] ?? String(cell);
  if (column.type === 'signal') return SIGNAL_LABELS[cell as Signal] ?? String(cell);
  return String(cell);
}
