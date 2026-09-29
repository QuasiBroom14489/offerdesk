import { z } from 'zod';
import { EventSource, FLAGS } from './events.js';
import { Status } from './status.js';

/** Calendar date without a time, e.g. `2026-10-30`. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const Company = z.object({
  id: z.string(),
  name: z.string().min(1),
  website: z.string().nullable(),
  createdAt: z.number(),
});
export type Company = z.infer<typeof Company>;

export const Application = z.object({
  id: z.string(),
  companyId: z.string(),
  companyName: z.string(),
  role: z.string().min(1),
  postingUrl: z.string().nullable(),
  location: z.string().nullable(),
  season: z.string().nullable(),
  deadline: IsoDate.nullable(),
  source: z.string().nullable(),
  createdAt: z.number(),
  /** Derived from the event log — never stored. */
  status: Status,
  /** Timestamp of the last event touching this application. */
  lastActivityAt: z.number(),
  /** Derived: active flags. `start` clears itself once the application moves past `saved`. */
  flags: z.array(z.enum(FLAGS)),
  /** Derived: who created it — `manual`, or e.g. `vesper` for a screen capture. */
  addedBy: EventSource,
});
export type Application = z.infer<typeof Application>;

export const NewApplication = z.object({
  company: z.string().min(1),
  role: z.string().min(1),
  postingUrl: z.string().url().nullish(),
  location: z.string().nullish(),
  season: z.string().nullish(),
  deadline: IsoDate.nullish(),
  source: z.string().nullish(),
  status: Status.default('saved'),
  /** Override creation time, e.g. when importing history. */
  at: z.number().optional(),
});
export type NewApplication = z.input<typeof NewApplication>;

export const ApplicationPatch = NewApplication.omit({
  company: true,
  status: true,
  at: true,
}).partial();
export type ApplicationPatch = z.input<typeof ApplicationPatch>;

/**
 * A job posting read off a page (by Vesper looking at the screen, a browser
 * extension, or a paste). Only company and role are required: a capture should
 * leave a field empty rather than guess.
 */
export const CapturePosting = z.object({
  company: z.string().trim().min(1),
  role: z.string().trim().min(1),
  location: z.string().trim().min(1).nullish(),
  deadline: IsoDate.nullish(),
  postingUrl: z.string().url().nullish(),
  pay: z.string().trim().min(1).nullish(),
  /** Where the posting was found, e.g. "Handshake". */
  source: z.string().trim().min(1).nullish(),
  season: z.string().trim().min(1).nullish(),
  /** The job description as read from the page. */
  postingText: z.string().max(40_000).nullish(),
  /** Flag it as one to get started on. Defaults to true. */
  flagToStart: z.boolean().default(true),
  capturedBy: EventSource.default('vesper'),
});
export type CapturePosting = z.input<typeof CapturePosting>;

export const Contact = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  companyName: z.string().nullable(),
  name: z.string().min(1),
  title: z.string().nullable(),
  email: z.string().nullable(),
  linkedin: z.string().nullable(),
  howMet: z.string().nullable(),
  createdAt: z.number(),
  /** Derived: last outreach or response involving this contact. */
  lastTouchedAt: z.number().nullable(),
});
export type Contact = z.infer<typeof Contact>;

export const NewContact = z.object({
  name: z.string().min(1),
  company: z.string().nullish(),
  title: z.string().nullish(),
  email: z.string().email().nullish(),
  linkedin: z.string().nullish(),
  howMet: z.string().nullish(),
});
export type NewContact = z.input<typeof NewContact>;
