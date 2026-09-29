import { isTerminal, STATUS_LABELS, type Status } from '@offerdesk/shared';

const STAGE_VAR: Record<Status, string> = {
  saved: 'var(--stage-saved)',
  applied: 'var(--stage-applied)',
  oa: 'var(--stage-oa)',
  interview: 'var(--stage-interview)',
  offer: 'var(--stage-offer)',
  rejected: 'var(--stage-closed)',
  withdrawn: 'var(--stage-closed)',
  ghosted: 'var(--stage-closed)',
};

export function stageColor(status: Status): string {
  return STAGE_VAR[status];
}

/**
 * A status is always a word, never color alone: the dot carries the stage's
 * place on the ramp, the label carries the meaning.
 */
export function StatusMark({ status, className = '' }: { status: Status; className?: string }) {
  const closed = isTerminal(status);
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-sm ${className}`}>
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{
          background: closed ? 'transparent' : STAGE_VAR[status],
          boxShadow: closed ? `inset 0 0 0 1.5px ${STAGE_VAR[status]}` : undefined,
        }}
      />
      <span
        className={
          closed ? 'text-faint' : status === 'offer' ? 'text-good font-medium' : 'text-muted'
        }
      >
        {STATUS_LABELS[status]}
      </span>
    </span>
  );
}
