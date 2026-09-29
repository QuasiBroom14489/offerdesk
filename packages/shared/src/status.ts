import { z } from 'zod';

/**
 * Pipeline stages, in the order an application normally moves through them.
 * Terminal stages end the pipeline; an application can reach one from anywhere.
 */
export const ACTIVE_STATUSES = ['saved', 'applied', 'oa', 'interview', 'offer'] as const;
export const TERMINAL_STATUSES = ['rejected', 'withdrawn', 'ghosted'] as const;
export const STATUSES = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES] as const;

export const Status = z.enum(STATUSES);
export type Status = z.infer<typeof Status>;

export const STATUS_LABELS: Record<Status, string> = {
  saved: 'Saved',
  applied: 'Applied',
  oa: 'Online assessment',
  interview: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  ghosted: 'Ghosted',
};

/** Statuses that mean the company has engaged — used for response rate. */
export const RESPONDED_STATUSES: ReadonlySet<Status> = new Set([
  'oa',
  'interview',
  'offer',
  'rejected',
]);

/** Traffic-light meaning of a stage (docs/design.md). Shared so exports color cells the same way. */
export const SIGNALS = ['green', 'yellow', 'red', 'grey'] as const;
export type Signal = (typeof SIGNALS)[number];

export const STATUS_SIGNAL: Record<Status, Signal> = {
  saved: 'grey',
  applied: 'yellow',
  oa: 'green',
  interview: 'green',
  offer: 'green',
  rejected: 'red',
  ghosted: 'red',
  withdrawn: 'grey',
};

export const SIGNAL_LABELS: Record<Signal, string> = {
  green: 'Moving forward',
  yellow: 'Waiting on them',
  red: 'Closed',
  grey: 'Neutral',
};

export function isTerminal(status: Status): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
