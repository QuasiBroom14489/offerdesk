import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { quietButtonClass } from './Dialog';

/**
 * A button that opens a small panel below it. Closes on Escape (returning
 * focus to the button) or a click outside. Not modal: the table stays live
 * behind it, so edits show up as you make them.
 */
export function Popover({
  label,
  title,
  align = 'left',
  children,
}: {
  label: ReactNode;
  /** Accessible name for the panel. */
  title: string;
  align?: 'left' | 'right';
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={`${quietButtonClass} ${open ? 'border-accent text-fg' : ''}`}
      >
        {label}
      </button>
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label={title}
          className={`absolute top-full z-20 mt-1.5 w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-line bg-raised p-3 text-sm shadow-lg ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
