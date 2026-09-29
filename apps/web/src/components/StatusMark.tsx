import { STATUS_LABELS, type Status } from '@offerdesk/shared';

export type Signal = 'green' | 'yellow' | 'red' | 'grey';

/** Traffic-light meaning of each stage. */
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

const DOT: Record<Signal, string> = {
  green: 'var(--green)',
  yellow: 'var(--yellow-dot)',
  red: 'var(--red)',
  grey: 'var(--grey-dot)',
};

export function signalColor(signal: Signal): string {
  return DOT[signal];
}

export function stageColor(status: Status): string {
  return DOT[STATUS_SIGNAL[status]];
}

export function Dot({ signal, className = '' }: { signal: Signal; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-2 shrink-0 rounded-full ${className}`}
      style={{ background: DOT[signal] }}
    />
  );
}

/** A status is always a word, never color alone. */
export function StatusMark({ status, className = '' }: { status: Status; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-muted ${className}`}
    >
      <Dot signal={STATUS_SIGNAL[status]} />
      {STATUS_LABELS[status]}
    </span>
  );
}

/** Small tinted pill for counts that need attention ("12 days", "in 2 days"). */
export function Pill({
  signal,
  children,
}: {
  signal: Exclude<Signal, 'grey'>;
  children: React.ReactNode;
}) {
  const tone = {
    green: 'bg-green-bg text-green',
    yellow: 'bg-yellow-bg text-yellow',
    red: 'bg-red-bg text-red',
  }[signal];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone}`}
    >
      {children}
    </span>
  );
}
