import { type SavedView, ViewSpec, type ViewSpecInput } from '@offerdesk/shared';

const preset = (id: string, name: string, spec: ViewSpecInput): SavedView => ({
  id,
  name,
  spec: ViewSpec.parse(spec),
  builtIn: true,
  sheetId: null,
  createdAt: 0,
  updatedAt: 0,
});

/** Views every workspace starts with. Ids are stable; they ship in code, not the database. */
export const PRESET_VIEWS: readonly SavedView[] = [
  preset('everything', 'Everything', {
    columns: ['company', 'role', 'status', 'location', 'deadline', 'source', 'lastActivity'],
    sort: [{ column: 'lastActivity', desc: true }],
  }),
  preset('waiting', 'Waiting to hear', {
    columns: ['company', 'role', 'appliedOn', 'daysWaiting', 'contacts', 'lastContact'],
    filters: [{ column: 'status', op: 'eq', value: 'applied' }],
    sort: [{ column: 'daysWaiting', desc: true }],
  }),
  preset('response-times', 'Response times', {
    columns: ['company', 'role', 'status', 'appliedOn', 'responseDays'],
    filters: [{ column: 'responseDays', op: 'notEmpty' }],
    sort: [{ column: 'responseDays', desc: false }],
  }),
  preset('deadlines', 'Due this month', {
    columns: ['company', 'role', 'deadline', 'flag', 'location', 'postingUrl'],
    filters: [
      { column: 'status', op: 'eq', value: 'saved' },
      { column: 'deadline', op: 'gte', value: 'today' },
      { column: 'deadline', op: 'lte', value: 'today+30' },
    ],
    sort: [{ column: 'deadline', desc: false }],
  }),
];

export const DEFAULT_VIEW_ID = 'everything';
