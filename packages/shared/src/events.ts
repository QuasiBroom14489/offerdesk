import { z } from 'zod';
import { Status } from './status.js';

/**
 * Every fact OfferDesk knows about "what happened" is one of these events.
 * The log is append-only: a kind's meaning never changes once shipped, and new
 * facts get new kinds. Current state (status, follow-ups, stats) is a fold
 * over this log.
 */
export const EventPayloads = {
  'application.created': z.object({ status: Status }),
  'status.changed': z.object({ from: Status, to: Status }),
  'outreach.sent': z.object({
    channel: z.enum(['email', 'linkedin', 'in-person', 'referral', 'other']),
    summary: z.string().optional(),
  }),
  'response.received': z.object({
    channel: z.enum(['email', 'linkedin', 'phone', 'portal', 'other']),
    summary: z.string().optional(),
  }),
  'interview.scheduled': z.object({
    at: z.number(),
    round: z.string().optional(),
    location: z.string().optional(),
  }),
  'document.attached': z.object({ documentId: z.string(), kind: z.string() }),
  'resume.generated': z.object({ resumeVersionId: z.string() }),
  'note.added': z.object({ text: z.string().min(1) }),
} as const;

export type EventKind = keyof typeof EventPayloads;
export const EVENT_KINDS = Object.keys(EventPayloads) as EventKind[];
export type EventPayload<K extends EventKind> = z.infer<(typeof EventPayloads)[K]>;

export interface OfferdeskEvent<K extends EventKind = EventKind> {
  seq: number;
  id: string;
  ts: number;
  kind: K;
  applicationId: string | null;
  contactId: string | null;
  payload: EventPayload<K>;
}

export type AnyEvent = { [K in EventKind]: OfferdeskEvent<K> }[EventKind];

export interface NewEvent<K extends EventKind = EventKind> {
  kind: K;
  applicationId?: string | null;
  contactId?: string | null;
  payload: EventPayload<K>;
  ts?: number;
}
