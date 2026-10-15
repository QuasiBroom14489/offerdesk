import { tmpdir } from 'node:os';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  MAX_SCREENSHOTS,
  type PostingDraft,
  PostingDraft as PostingDraftSchema,
  type PostingImage,
} from '@offerdesk/shared';
import { z } from 'zod';
import { UnavailableError } from '../../errors.js';

/** Reads job postings out of screenshots. Claude in production; a fake in tests. */
export interface PostingReader {
  read(images: PostingImage[], today: string): Promise<PostingDraft>;
}

/** What the model returns. Every key is required, so "not shown" is null. */
const Extraction = z.object({
  isPosting: z.boolean(),
  company: z.string().nullable(),
  role: z.string().nullable(),
  location: z.string().nullable(),
  deadline: z.string().nullable(),
  postingUrl: z.string().nullable(),
  pay: z.string().nullable(),
  source: z.string().nullable(),
  season: z.string().nullable(),
  postingText: z.string().nullable(),
});

/** Claude Code validates against draft-07 and rejects a `$schema` it doesn't know. */
const { $schema: _, ...EXTRACTION_SCHEMA } = z.toJSONSchema(Extraction);

const SYSTEM = [
  'You read job and internship postings out of screenshots for an application tracker.',
  'The screenshots are one posting, possibly scrolled across several images; read them together.',
  'Copy what the page actually shows. Use null for anything it does not show; never guess.',
  'deadline: the application deadline as YYYY-MM-DD, resolving a missing year to the next occurrence after today. Not a start date.',
  'postingUrl: only a full URL that is visible (e.g. in the address bar).',
  'source: the site the posting is on if recognizable (Handshake, LinkedIn, Indeed, a company careers page as "Company careers").',
  'season: the internship term if stated, e.g. "Summer 2027".',
  'postingText: the job description as plain text, in reading order, without navigation or ads.',
  'Set isPosting to false if the images are not a job posting.',
].join('\n');

const MODEL = 'claude-opus-5-5';

/**
 * Claude through the Agent SDK, signed in with the user's Claude subscription
 * (the login Claude Code already has on this machine), not an API key (ADR
 * 0008). The SDK runs a local Claude Code process, so this works where the
 * server runs on the user's own computer, not on Vercel.
 */
export class ClaudeCodePostingReader implements PostingReader {
  async read(images: PostingImage[], today: string): Promise<PostingDraft> {
    if (images.length === 0 || images.length > MAX_SCREENSHOTS) {
      throw new RangeError(`send 1 to ${MAX_SCREENSHOTS} screenshots`);
    }
    const message: SDKUserMessage = {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          ...images.map((img) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
          })),
          { type: 'text' as const, text: `Today is ${today}. Read this posting.` },
        ],
      },
    };
    // An API key in the environment would take precedence over the
    // subscription login, so the child process never sees one.
    const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...env } = process.env;

    // Loaded on first use, so a deployment without screenshots never loads it.
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    let out: unknown;
    let failure: string | undefined;
    for await (const msg of query({
      prompt: (async function* () {
        yield message;
      })(),
      options: {
        model: MODEL,
        effort: 'low',
        systemPrompt: SYSTEM,
        outputFormat: { type: 'json_schema', schema: EXTRACTION_SCHEMA },
        // A pure reading: no tools, no settings, MCP servers or CLAUDE.md
        // from this machine, and no transcript left behind.
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        maxTurns: 3,
        cwd: tmpdir(),
        env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: 'offerdesk' } as Record<string, string>,
      },
    })) {
      if (msg.type !== 'result') continue;
      if (msg.subtype === 'success' && !msg.is_error) out = msg.structured_output;
      else failure = msg.subtype === 'success' ? msg.result : msg.subtype;
    }
    const parsed = Extraction.safeParse(out);
    if (!parsed.success) {
      throw new UnavailableError(
        `Claude couldn't read the screenshots${failure ? `: ${failure}` : ''}. Is Claude Code signed in on this computer?`,
      );
    }
    const r = parsed.data;
    if (!r.isPosting) return { isPosting: false };
    // Keep only what passes the tracker's own validation, so a bad date or URL
    // becomes an empty field to fill in rather than a failed save.
    const keep = <S extends z.ZodType>(schema: S, v: string | null) =>
      v !== null && schema.safeParse(v).success ? v.trim() : undefined;
    const shape = PostingDraftSchema.shape;
    return {
      isPosting: true,
      company: keep(shape.company, r.company),
      role: keep(shape.role, r.role),
      location: keep(shape.location, r.location),
      deadline: keep(shape.deadline, r.deadline),
      postingUrl: keep(shape.postingUrl, r.postingUrl),
      pay: keep(shape.pay, r.pay),
      source: keep(shape.source, r.source),
      season: keep(shape.season, r.season),
      postingText: keep(shape.postingText, r.postingText),
    };
  }
}

/**
 * On wherever the server runs on the user's own computer; off on Vercel, where
 * there is no Claude Code login (and the SDK's binary doesn't fit a function),
 * or with `OFFERDESK_SCREENSHOTS=off`.
 */
export function postingReaderFromEnv(env: NodeJS.ProcessEnv = process.env): PostingReader | null {
  if (env.VERCEL || env.OFFERDESK_SCREENSHOTS === 'off') return null;
  return new ClaudeCodePostingReader();
}
