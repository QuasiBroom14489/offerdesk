import { z } from 'zod';
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
