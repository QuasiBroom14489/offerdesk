import { z } from 'zod';
import type { Application, Contact } from './entities.js';
import { DESCRIPTION_VARIANTS } from './profile.js';
import type { Signal, Status } from './status.js';

/**
 * How good a chance a company is, judged against what you've actually done
 * (ADR 0011). Traffic-light meaning: green is where you have the most relevant
 * experience.
 */
export const FITS = ['strong', 'good', 'stretch'] as const;
export const Fit = z.enum(FITS);
export type Fit = z.infer<typeof Fit>;

export const FIT_LABELS: Record<Fit, string> = {
  strong: 'Best chance',
  good: 'Good fit',
  stretch: 'Stretch',
};

export const FIT_SIGNAL: Record<Fit, Signal> = {
  strong: 'green',
  good: 'yellow',
  stretch: 'red',
};

/** Fields a company is relevant for. The same list as the profile's description variants. */
export const CompanyField = z.enum(DESCRIPTION_VARIANTS);
export type CompanyField = z.infer<typeof CompanyField>;

const text = (max: number) => z.string().trim().max(max).nullish();

/**
 * What you know about a company and why it's on your list. Everything is
 * optional: an empty field means "not researched yet", never "no".
 */
export const CompanyProfilePatch = z.object({
  /** On your target list. Companies you only applied to aren't, until you say so. */
  target: z.boolean().optional(),
  fit: Fit.nullish(),
  fields: z.array(CompanyField).max(DESCRIPTION_VARIANTS.length).optional(),
  industry: text(120),
  website: text(500),
  careersUrl: text(500),
  /** Why this company is relevant to you: specific links to your experience. */
  why: text(5000),
  /** How to pitch yourself here: what to lead with, which description variant to use. */
  angle: text(5000),
  /** Projects and experience to cite, by name (matched against the profile). */
  highlights: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  /** About the company: what it does, the team you'd join, programs, timeline, interview process. */
  context: text(10000),
});
export type CompanyProfilePatch = z.input<typeof CompanyProfilePatch>;

/** Add a company to your list, or update it if it's already known (names match without case). */
export const NewCompany = CompanyProfilePatch.extend({ name: z.string().trim().min(1).max(200) });
export type NewCompany = z.input<typeof NewCompany>;

export interface CompanyProfile {
  target: boolean;
  fit: Fit | null;
  fields: CompanyField[];
  industry: string | null;
  website: string | null;
  careersUrl: string | null;
  why: string | null;
  angle: string | null;
  highlights: string[];
  context: string | null;
  /** Last edit to the profile, or null if never researched. */
  updatedAt: number | null;
}

export interface CompanySummary extends CompanyProfile {
  id: string;
  name: string;
  createdAt: number;
  /** Derived from the applications here. */
  applicationCount: number;
  /** Applications not yet closed (rejected, withdrawn, ghosted). */
  openCount: number;
  /** The furthest stage any application here has reached, or null with none. */
  bestStatus: Status | null;
  contactCount: number;
  /** Last event on any application or person here. */
  lastActivityAt: number | null;
}

export interface CompanyDetail extends CompanySummary {
  applications: Application[];
  contacts: Contact[];
}

/** One profile entry a company's highlights point at, as text to paste or cite. */
export interface CompanyHighlight {
  name: string;
  /** Null when no profile entry matches the name yet. */
  entryId: string | null;
  category: string | null;
  /** The entry's description in the variant for this company's first field, else General. */
  description: string | null;
}

/** Everything needed to apply to a company in one read (`company_context` over MCP). */
export interface CompanyContext extends CompanyDetail {
  highlightDetails: CompanyHighlight[];
}
