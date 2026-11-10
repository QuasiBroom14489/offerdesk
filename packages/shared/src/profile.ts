import { z } from 'zod';

export const PROFILE_CATEGORIES = [
  'Personal Information',
  'Education',
  'Work Experience',
  'Projects',
  'Skills',
  'Leadership',
  'Common Questions',
  'Custom Responses',
] as const;
export const DESCRIPTION_VARIANTS = [
  'General',
  'Software Engineering',
  'Data Analytics',
  'Finance / Business',
  'Product Management',
] as const;
export const ProfileContent = z.object({
  category: z.enum(PROFILE_CATEGORIES),
  name: z.string().trim().min(1).max(300),
  fields: z.record(z.string().max(100), z.string().max(20000)),
});
export type ProfileContent = z.infer<typeof ProfileContent>;
export interface Provenance {
  file: string;
  section: string;
  hash: string;
  kind: 'markdown' | 'resume';
}
export interface SourceFact extends ProfileContent {
  id: string;
  sourceId: string;
  identity: string;
  provenance: Provenance;
  warnings: string[];
  status: 'pending' | 'accepted' | 'rejected' | 'superseded';
  conflicts: string[];
  duplicateIds: string[];
}
export interface ProfileEntry extends ProfileContent {
  id: string;
  sourceFactIds: string[];
  fieldSources: Record<string, string[]>;
  variants: Record<string, string>;
  favorite: boolean;
  position: number;
  lastUsed: number | null;
}
export interface ProfileSource {
  id: string;
  name: string;
  kind: 'markdown' | 'resume';
  hash: string;
  syncedAt: number;
  factCount: number;
  extractorVersion?: number;
  factIds?: string[];
}
export interface ProfileState {
  sources: ProfileSource[];
  facts: SourceFact[];
  entries: ProfileEntry[];
}
export const SourceUpload = z.object({
  // Logical relative paths only. The API never opens a user-supplied filesystem path.
  name: z
    .string()
    .min(1)
    .max(1000)
    .refine(
      (s) =>
        !s.startsWith('/') &&
        !s.includes('\\') &&
        !s.split('/').some((p) => p === '..' || p === '.' || !p || p.startsWith('.')) &&
        !Array.from(s).some((character) => character.charCodeAt(0) < 32),
      'Use a relative, non-hidden file path',
    ),
  kind: z.enum(['markdown', 'resume']),
  content: z.string().max(5_600_000),
});
export const SyncProfile = z.object({ files: z.array(SourceUpload).min(1).max(100) });
export const ProfileEdit = ProfileContent.extend({
  variants: z.record(z.string().max(100), z.string().max(20000)).default({}),
  favorite: z.boolean().default(false),
  position: z.number().int().min(0).default(0),
});
export const ReviewProfile = z.object({
  action: z.enum(['accept', 'reject']),
  content: ProfileContent.optional(),
  targetId: z.string().min(1).optional(),
  createNew: z.boolean().optional(),
});
export type SourceUpload = z.infer<typeof SourceUpload>;
export type ProfileEdit = z.infer<typeof ProfileEdit>;
export type ReviewProfile = z.infer<typeof ReviewProfile>;

export function copyProfileFields(entry: ProfileContent): string {
  return Object.entries(entry.fields)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

/** Extractive tailoring: only select original sentences; never generate claims. */
export function describeVariants(description: string): Record<string, string> {
  const chunks = description
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const choose = (pattern: RegExp) => {
    const selected = chunks.filter((chunk) => pattern.test(chunk));
    return (selected.length ? selected : chunks).join('\n');
  };
  return {
    General: description,
    'Software Engineering': choose(
      /code|software|schema|pipeline|develop|engineer|deploy|infrastructure|CI\/CD|database|built|API/i,
    ),
    'Data Analytics': choose(
      /data|analy|dashboard|SQL|pandas|Tableau|geospatial|insight|research/i,
    ),
    'Finance / Business': choose(
      /strateg|market|operat|business|distribut|decision|revenue|cost|research|constraint|production/i,
    ),
    'Product Management': choose(
      /product|user|launch|beta|strategy|stakeholder|led|priorit|feedback|ship|team/i,
    ),
  };
}
