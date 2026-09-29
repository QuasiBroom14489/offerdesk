import { useEffect, useRef } from 'react';

type Handler = (e: KeyboardEvent) => void;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Global keyboard shortcuts. Keys are single characters (`n`), modifier combos
 * (`mod+k`), or two-key sequences (`g b`), vim-style. Shortcuts never fire
 * while the user is typing in a field, except modifier combos.
 */
export function useHotkeys(bindings: Record<string, Handler>, enabled = true): void {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    if (!enabled) return;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod) {
        const combo = `mod+${e.key.toLowerCase()}`;
        const h = ref.current[combo];
        if (h) {
          e.preventDefault();
          h(e);
        }
        return;
      }
      if (e.altKey || isTyping(e.target)) return;

      const key = e.key;
      if (pending) {
        const h = ref.current[`${pending} ${key}`];
        pending = null;
        clearTimeout(timer);
        if (h) {
          e.preventDefault();
          h(e);
          return;
        }
      }
      if (Object.keys(ref.current).some((k) => k.startsWith(`${key} `))) {
        pending = key;
        timer = setTimeout(() => {
          pending = null;
        }, 900);
        return;
      }
      const h = ref.current[key];
      if (h) {
        e.preventDefault();
        h(e);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(timer);
    };
  }, [enabled]);
}
