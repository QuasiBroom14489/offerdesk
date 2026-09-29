import { useCallback, useState } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { CommandPalette } from './components/CommandPalette';
import { NewApplicationDialog } from './components/NewApplicationDialog';
import { NewContactDialog } from './components/NewContactDialog';
import { useHotkeys } from './hotkeys';
import { ApplicationPage } from './pages/Application';
import { ApplicationsTable } from './pages/ApplicationsTable';
import { Board } from './pages/Board';
import { Home } from './pages/Home';
import { People, Person } from './pages/People';

const NAV = [
  { path: '/', label: 'Home', key: 'H' },
  { path: '/board', label: 'Board', key: 'B' },
  { path: '/applications', label: 'All applications', key: 'A' },
  { path: '/people', label: 'People', key: 'P' },
];

type Theme = 'system' | 'light' | 'dark';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('offerdesk-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(t: Theme) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('offerdesk-theme', t);
  } catch {
    // Storage can be unavailable (private windows); the theme still applies for this visit.
  }
}

applyTheme(readTheme());

export function App() {
  const [location, navigate] = useLocation();
  const [palette, setPalette] = useState(false);
  const [newApp, setNewApp] = useState(false);
  const [newContact, setNewContact] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const anyDialog = palette || newApp || newContact;

  const cycleTheme = () => {
    const next: Theme = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';
    setTheme(next);
    applyTheme(next);
  };

  useHotkeys(
    {
      'mod+k': () => setPalette(true),
      '/': () => setPalette(true),
      n: () => setNewApp(true),
      'g h': () => navigate('/'),
      'g b': () => navigate('/board'),
      'g a': () => navigate('/applications'),
      'g p': () => navigate('/people'),
    },
    !anyDialog,
  );

  const openNewApp = useCallback(() => setNewApp(true), []);
  const openNewContact = useCallback(() => setNewContact(true), []);

  const isActive = (path: string) => (path === '/' ? location === '/' : location.startsWith(path));

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <nav
        aria-label="Main"
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-4 py-2 md:sticky md:top-0 md:h-dvh md:w-56 md:flex-col md:items-stretch md:gap-0.5 md:border-r md:border-b-0 md:px-3 md:py-5"
      >
        <Link
          href="/"
          className="mr-3 flex items-center gap-2 px-2 text-[15px] font-semibold md:mr-0 md:mb-6"
        >
          <span
            aria-hidden
            className="grid size-6 place-items-center rounded-md bg-accent text-accent-ink"
          >
            <svg viewBox="0 0 32 32" className="size-4" aria-hidden="true">
              <path
                d="M9 17l5 5 9-11"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          OfferDesk
        </Link>
        {NAV.map((item) => (
          <Link
            key={item.path}
            href={item.path}
            aria-current={isActive(item.path) ? 'page' : undefined}
            className={`group flex items-center justify-between whitespace-nowrap rounded-md px-2 py-1.5 text-sm ${
              isActive(item.path) ? 'bg-sunken font-medium text-fg' : 'text-muted hover:text-fg'
            }`}
          >
            {item.label}
            <span className="ml-4 hidden text-xs text-faint md:inline">G {item.key}</span>
          </Link>
        ))}
        <div className="ml-auto flex items-center gap-2 md:mt-auto md:ml-0 md:flex-col md:items-stretch">
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="flex items-center justify-between gap-3 rounded-md border border-line px-2 py-1.5 text-sm text-muted hover:border-accent hover:text-fg"
          >
            Search <kbd>⌘K</kbd>
          </button>
          <button
            type="button"
            onClick={cycleTheme}
            className="rounded-md px-2 py-1.5 text-left text-sm whitespace-nowrap text-faint hover:text-fg"
            aria-label={`Theme: ${theme}. Change theme`}
          >
            Theme: {theme}
          </button>
        </div>
      </nav>

      <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-10">
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/board" component={Board} />
          <Route path="/applications" component={() => <ApplicationsTable onNew={openNewApp} />} />
          <Route path="/applications/:id">{(p) => <ApplicationPage id={p.id} />}</Route>
          <Route path="/people" component={() => <People onNew={openNewContact} />} />
          <Route path="/people/:id">{(p) => <Person id={p.id} />}</Route>
          <Route>
            <p className="text-muted">
              There’s nothing at this address.{' '}
              <Link href="/" className="text-accent underline">
                Go home
              </Link>
              .
            </p>
          </Route>
        </Switch>
      </main>

      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        onNewApplication={openNewApp}
        onNewContact={openNewContact}
      />
      <NewApplicationDialog open={newApp} onClose={() => setNewApp(false)} />
      <NewContactDialog open={newContact} onClose={() => setNewContact(false)} />
    </div>
  );
}
