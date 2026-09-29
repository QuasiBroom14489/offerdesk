import {
  type AnyEvent,
  type Application,
  type Cell,
  type ColumnId,
  type Contact,
  RESPONDED_STATUSES,
  STATUS_SIGNAL,
} from '@offerdesk/shared';
import { daysBetween, isoDate } from '../dates.js';
import { SUBMITTED } from '../derive.js';

/**
 * What one application knows about itself, beyond its stored fields, worked out
 * once per report from the event log. Every derived column reads from here.
 */
export interface RowFacts {
  app: Application;
  now: number;
  /** First time it entered a submitted stage. */
  appliedAt: number | null;
  /** First reply or response-stage move at or after `appliedAt`. */
  firstResponseAt: number | null;
  /** Still `applied` with no reply since: when the silence started. */
  waitingSince: number | null;
  contacts: number;
  lastContactAt: number | null;
  nextInterviewAt: number | null;
  pay: string | null;
}

export function rowFacts(
  app: Application,
  events: readonly AnyEvent[],
  people: readonly Contact[],
  peopleEvents: readonly AnyEvent[],
  now: number,
): RowFacts {
  let appliedAt: number | null = null;
  let firstResponseAt: number | null = null;
  let statusSince = app.createdAt;
  let lastOutreach = 0;
  let lastReply: number | null = null;
  let nextInterviewAt: number | null = null;
  let pay: string | null = null;

  for (const e of events) {
    const entered =
      e.kind === 'application.created'
        ? e.payload.status
        : e.kind === 'status.changed'
          ? e.payload.to
          : null;
    if (entered) {
      statusSince = e.ts;
      if (appliedAt === null && SUBMITTED.has(entered)) appliedAt = e.ts;
    }
    const isReply =
      e.kind === 'response.received' || (entered !== null && RESPONDED_STATUSES.has(entered));
    if (isReply && appliedAt !== null && firstResponseAt === null) firstResponseAt = e.ts;
    if (e.kind === 'response.received') lastReply = Math.max(lastReply ?? 0, e.ts);
    if (e.kind === 'outreach.sent') lastOutreach = Math.max(lastOutreach, e.ts);
    if (e.kind === 'interview.scheduled' && e.payload.at >= now) {
      nextInterviewAt = Math.min(nextInterviewAt ?? e.payload.at, e.payload.at);
    }
    if (e.kind === 'posting.captured' && e.payload.pay) pay = e.payload.pay;
  }

  // Same rule as follow-ups: we acted last and they have been quiet since.
  const waitingSince =
    app.status === 'applied' && (lastReply === null || lastReply < statusSince)
      ? Math.max(statusSince, lastOutreach)
      : null;

  let lastContactAt: number | null = null;
  for (const e of [...events, ...peopleEvents]) {
    if (e.kind === 'outreach.sent' || e.kind === 'response.received') {
      lastContactAt = Math.max(lastContactAt ?? 0, e.ts);
    }
  }

  return {
    app,
    now,
    appliedAt,
    firstResponseAt,
    waitingSince,
    contacts: people.length,
    lastContactAt,
    nextInterviewAt,
    pay,
  };
}

const date = (ms: number | null): Cell => (ms === null ? null : isoDate(ms));

/** How each column in `REPORT_COLUMNS` gets its value. */
export const COLUMN_GETTERS: Record<ColumnId, (r: RowFacts) => Cell> = {
  company: (r) => r.app.companyName,
  role: (r) => r.app.role,
  location: (r) => r.app.location,
  season: (r) => r.app.season,
  source: (r) => r.app.source,
  deadline: (r) => r.app.deadline,
  postingUrl: (r) => r.app.postingUrl,
  pay: (r) => r.pay,
  added: (r) => date(r.app.createdAt),
  status: (r) => r.app.status,
  signal: (r) => STATUS_SIGNAL[r.app.status],
  flag: (r) => (r.app.flags.includes('start') ? 'Get started' : null),
  appliedOn: (r) => date(r.appliedAt),
  daysSinceApplied: (r) => (r.appliedAt === null ? null : daysBetween(r.appliedAt, r.now)),
  daysWaiting: (r) => (r.waitingSince === null ? null : daysBetween(r.waitingSince, r.now)),
  responseDays: (r) =>
    r.appliedAt === null || r.firstResponseAt === null
      ? null
      : daysBetween(r.appliedAt, r.firstResponseAt),
  contacts: (r) => r.contacts,
  lastContact: (r) => date(r.lastContactAt),
  nextInterview: (r) => date(r.nextInterviewAt),
  lastActivity: (r) => date(r.app.lastActivityAt),
};
