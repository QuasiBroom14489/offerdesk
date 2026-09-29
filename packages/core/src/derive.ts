import { type AnyEvent, RESPONDED_STATUSES, type Status } from '@offerdesk/shared';

/**
 * Pure folds over the event log. Nothing here touches the database, so every
 * rule the dashboard shows can be unit-tested with a hand-written event list.
 */

const DAY = 86_400_000;

export interface ApplicationHistory {
  status: Status;
  /** Every status this application has ever been in. */
  reached: Set<Status>;
  /** When the application entered its current status. */
  statusSince: number;
  lastActivityAt: number;
  responded: boolean;
}

/** Fold one application's events (in log order) into its current state. */
export function foldApplication(events: readonly AnyEvent[]): ApplicationHistory {
  let status: Status = 'saved';
  let statusSince = 0;
  let lastActivityAt = 0;
  let responded = false;
  const reached = new Set<Status>();

  for (const ev of events) {
    lastActivityAt = Math.max(lastActivityAt, ev.ts);
    switch (ev.kind) {
      case 'application.created':
        status = ev.payload.status;
        statusSince = ev.ts;
        reached.add(status);
        break;
      case 'status.changed':
        status = ev.payload.to;
        statusSince = ev.ts;
        reached.add(status);
        break;
      case 'response.received':
        responded = true;
        break;
      default:
        break;
    }
  }
  if (RESPONDED_STATUSES.has(status) || [...reached].some((s) => RESPONDED_STATUSES.has(s))) {
    responded = true;
  }
  return { status, reached, statusSince, lastActivityAt, responded };
}

export function groupBy<K, V>(items: readonly V[], key: (v: V) => K | null): Map<K, V[]> {
  const out = new Map<K, V[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

export interface FollowUp {
  kind: 'application' | 'contact';
  applicationId: string | null;
  contactId: string | null;
  /** When the silence started — the last thing we sent or did. */
  waitingSince: number;
  daysWaiting: number;
}

/**
 * Something is due for a follow-up when we were the last to act and the other
 * side has been quiet for `afterDays`:
 *  - an application sitting in `applied` with no response since, or
 *  - outreach to a contact with no response from them since.
 */
export function followUpsDue(
  events: readonly AnyEvent[],
  opts: { now: number; afterDays: number },
): FollowUp[] {
  const out: FollowUp[] = [];
  const threshold = opts.afterDays * DAY;

  for (const [applicationId, evs] of groupBy(events, (e) => e.applicationId)) {
    const h = foldApplication(evs);
    if (h.status !== 'applied') continue;
    const lastResponse = lastTs(evs, 'response.received');
    if (lastResponse !== null && lastResponse >= h.statusSince) continue;
    const lastOutbound = Math.max(h.statusSince, lastTs(evs, 'outreach.sent') ?? 0);
    if (opts.now - lastOutbound >= threshold) {
      out.push(followUp('application', applicationId, null, lastOutbound, opts.now));
    }
  }

  for (const [contactId, evs] of groupBy(events, (e) => e.contactId)) {
    const lastOut = lastTs(evs, 'outreach.sent');
    if (lastOut === null) continue;
    const lastIn = lastTs(evs, 'response.received');
    if (lastIn !== null && lastIn >= lastOut) continue;
    if (opts.now - lastOut >= threshold) {
      const appId =
        [...evs].reverse().find((e) => e.kind === 'outreach.sent')?.applicationId ?? null;
      out.push(followUp('contact', appId, contactId, lastOut, opts.now));
    }
  }

  return out.sort((a, b) => a.waitingSince - b.waitingSince);
}

function followUp(
  kind: FollowUp['kind'],
  applicationId: string | null,
  contactId: string | null,
  waitingSince: number,
  now: number,
): FollowUp {
  return {
    kind,
    applicationId,
    contactId,
    waitingSince,
    daysWaiting: Math.floor((now - waitingSince) / DAY),
  };
}

function lastTs(events: readonly AnyEvent[], kind: AnyEvent['kind']): number | null {
  let ts: number | null = null;
  for (const e of events) if (e.kind === kind && (ts === null || e.ts > ts)) ts = e.ts;
  return ts;
}

export interface PipelineStats {
  total: number;
  byStatus: Record<Status, number>;
  /** Applications that were actually submitted (left `saved` for the pipeline). */
  submitted: number;
  responded: number;
  /** responded / submitted, or null before anything is submitted. */
  responseRate: number | null;
  interviews: number;
  offers: number;
  funnel: { stage: string; count: number }[];
}

const SUBMITTED: ReadonlySet<Status> = new Set([
  'applied',
  'oa',
  'interview',
  'offer',
  'rejected',
  'ghosted',
]);

export function pipelineStats(histories: readonly ApplicationHistory[]): PipelineStats {
  const byStatus = {
    saved: 0,
    applied: 0,
    oa: 0,
    interview: 0,
    offer: 0,
    rejected: 0,
    withdrawn: 0,
    ghosted: 0,
  } satisfies Record<Status, number>;
  let submitted = 0;
  let responded = 0;
  let interviews = 0;
  let offers = 0;

  for (const h of histories) {
    byStatus[h.status]++;
    const wasSubmitted = [...h.reached].some((s) => SUBMITTED.has(s));
    if (!wasSubmitted) continue;
    submitted++;
    if (h.responded) responded++;
    if (h.reached.has('interview') || h.reached.has('offer')) interviews++;
    if (h.reached.has('offer')) offers++;
  }

  return {
    total: histories.length,
    byStatus,
    submitted,
    responded,
    responseRate: submitted === 0 ? null : responded / submitted,
    interviews,
    offers,
    funnel: [
      { stage: 'Applied', count: submitted },
      { stage: 'Heard back', count: responded },
      { stage: 'Interviewed', count: interviews },
      { stage: 'Offer', count: offers },
    ],
  };
}
