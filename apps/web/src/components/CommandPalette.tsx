import { type KeyboardEvent, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useApplications, useContacts } from '../api';
import { Dialog } from './Dialog';

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** ⌘K: jump to any page, application or person, or run an action. */
export function CommandPalette({
  open,
  onClose,
  onNewApplication,
  onNewContact,
}: {
  open: boolean;
  onClose: () => void;
  onNewApplication: () => void;
  onNewContact: () => void;
}) {
  const [, navigate] = useLocation();
  const apps = useApplications();
  const contacts = useContacts();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => navigate(path);
    return [
      { id: 'new-app', label: 'Add an application', hint: 'N', run: onNewApplication },
      { id: 'new-contact', label: 'Add a person', run: onNewContact },
      { id: 'home', label: 'Go to Home', hint: 'G H', run: go('/') },
      { id: 'board', label: 'Go to Board', hint: 'G B', run: go('/board') },
      { id: 'table', label: 'Go to All applications', hint: 'G A', run: go('/applications') },
      { id: 'people', label: 'Go to People', hint: 'G P', run: go('/people') },
      { id: 'documents', label: 'Go to Documents', hint: 'G D', run: go('/documents') },
      ...(apps.data ?? []).map((a) => ({
        id: `app-${a.id}`,
        label: `${a.companyName} — ${a.role}`,
        hint: 'Application',
        run: go(`/applications/${a.id}`),
      })),
      ...(contacts.data ?? []).map((c) => ({
        id: `contact-${c.id}`,
        label: c.companyName ? `${c.name}, ${c.companyName}` : c.name,
        hint: 'Person',
        run: go(`/people/${c.id}`),
      })),
    ];
  }, [apps.data, contacts.data, navigate, onNewApplication, onNewContact]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 8);
    const words = q.split(/\s+/);
    return commands
      .filter((c) => words.every((w) => c.label.toLowerCase().includes(w)))
      .slice(0, 12);
  }, [commands, query]);

  const close = () => {
    setQuery('');
    setActive(0);
    onClose();
  };

  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    c.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[active]);
    }
  };

  return (
    <Dialog open={open} onClose={close} title="Command palette" className="mt-[15vh] mb-auto">
      <input
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        placeholder="Search applications, people, or actions"
        aria-label="Search"
        role="combobox"
        aria-expanded
        aria-controls="palette-results"
        aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
        className="w-full border-b border-line bg-transparent px-4 py-3.5 text-base text-fg placeholder:text-faint focus:outline-none"
      />
      <div id="palette-results" role="listbox" className="max-h-80 overflow-y-auto p-1.5">
        {results.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-faint">Nothing matches “{query}”.</p>
        )}
        {/* Keyboard selection lives on the combobox input (aria-activedescendant). */}
        {results.map((c, i) => (
          <div
            key={c.id}
            id={`cmd-${c.id}`}
            role="option"
            tabIndex={-1}
            aria-selected={i === active}
            onMouseMove={() => setActive(i)}
            onClick={() => run(c)}
            onKeyDown={(e) => e.key === 'Enter' && run(c)}
            className={`flex cursor-pointer items-center justify-between gap-4 rounded-md px-3 py-2 text-sm ${
              i === active ? 'bg-sunken text-fg' : 'text-muted'
            }`}
          >
            <span className="truncate">{c.label}</span>
            {c.hint && <span className="shrink-0 text-xs text-faint">{c.hint}</span>}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
