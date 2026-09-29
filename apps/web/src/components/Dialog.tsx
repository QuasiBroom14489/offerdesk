import { type ReactNode, useEffect, useRef } from 'react';

/** Native <dialog>: focus trapping, Escape and the backdrop come for free. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse affordance; <dialog> handles Escape natively
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={`m-auto w-[min(34rem,calc(100vw-2rem))] rounded-xl border border-line bg-raised p-0 text-fg shadow-2xl backdrop:bg-black/40 ${className}`}
    >
      {open && children}
    </dialog>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  'rounded-md border border-line bg-bg px-2.5 py-1.5 text-fg placeholder:text-faint focus:border-accent focus:outline-none';

export const buttonClass =
  'inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50';

export const quietButtonClass =
  'inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:border-accent hover:text-fg';
