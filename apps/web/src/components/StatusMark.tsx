import { type Signal, STATUS_LABELS, STATUS_SIGNAL, type Status } from '@offerdesk/shared';

export type { Signal };

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

/** Ink flag glyph for "get started" — an action on you, not a signal about them. */
export function StartFlag({ label = false }: { label?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-fg"
      title="Get started"
    >
      <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="currentColor">
        <path d="M3.5 1.75a.75.75 0 0 0-1.5 0v12.5a.75.75 0 0 0 1.5 0V10h7.2a.8.8 0 0 0 .64-1.28L9.6 6.5l1.74-2.22A.8.8 0 0 0 10.7 3H3.5V1.75Z" />
      </svg>
      {label ? 'Get started' : <span className="sr-only">Get started</span>}
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
