import { useCallback, useState } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { AccountButton } from './components/Auth';
import { CommandPalette } from './components/CommandPalette';
import { NewApplicationDialog } from './components/NewApplicationDialog';
import { NewContactDialog } from './components/NewContactDialog';
import { useHotkeys } from './hotkeys';
import { ApplicationPage } from './pages/Application';
import { ApplicationsTable } from './pages/ApplicationsTable';
import { Board } from './pages/Board';
import { Documents } from './pages/Documents';
import { Home } from './pages/Home';
import { People, Person } from './pages/People';
import { Settings } from './pages/Settings';

const NAV = [
  { path: '/', label: 'Home', key: 'H' },
  { path: '/board', label: 'Board', key: 'B' },
  { path: '/applications', label: 'Applications', key: 'A' },
  { path: '/people', label: 'People', key: 'P' },
  { path: '/documents', label: 'Documents', key: 'D' },
  { path: '/settings', label: 'Settings', key: 'S' },
];

export function App() {
  const [location, navigate] = useLocation();
  const [palette, setPalette] = useState(false);
  const [newApp, setNewApp] = useState(false);
  const [newContact, setNewContact] = useState(false);
  const anyDialog = palette || newApp || newContact;

  useHotkeys(
    {
      'mod+k': () => setPalette(true),
      '/': () => setPalette(true),
      n: () => setNewApp(true),
      'g h': () => navigate('/'),
      'g b': () => navigate('/board'),
      'g a': () => navigate('/applications'),
      'g p': () => navigate('/people'),
      'g d': () => navigate('/documents'),
      'g s': () => navigate('/settings'),
    },
    !anyDialog,
  );

  const openNewApp = useCallback(() => setNewApp(true), []);
  const openNewContact = useCallback(() => setNewContact(true), []);

  const isActive = (path: string) => (path === '/' ? location === '/' : location.startsWith(path));

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 md:px-8">
          <Link href="/" className="shrink-0 font-semibold tracking-tight">
            OfferDesk
          </Link>
          <nav aria-label="Main" className="-mx-1 flex min-w-0 gap-1 overflow-x-auto">
            {NAV.map((item) => (
              <Link
                key={item.path}
                href={item.path}
                title={`G then ${item.key}`}
                aria-current={isActive(item.path) ? 'page' : undefined}
                className={`rounded-md px-2.5 py-1 text-sm whitespace-nowrap ${
                  isActive(item.path) ? 'bg-sunken text-fg' : 'text-muted hover:text-fg'
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setPalette(true)}
              className="hidden items-center gap-3 rounded-md border border-line px-2.5 py-1 text-sm text-faint hover:text-fg sm:flex"
            >
              Search <kbd>⌘K</kbd>
            </button>
            <button
              type="button"
              onClick={openNewApp}
              title="N"
              className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-accent-ink hover:opacity-85"
            >
              New
            </button>
            <AccountButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 md:px-8 md:py-12">
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/board" component={Board} />
          <Route path="/applications" component={() => <ApplicationsTable onNew={openNewApp} />} />
          <Route path="/applications/:id">{(p) => <ApplicationPage id={p.id} />}</Route>
          <Route path="/people" component={() => <People onNew={openNewContact} />} />
          <Route path="/people/:id">{(p) => <Person id={p.id} />}</Route>
          <Route path="/documents" component={Documents} />
          <Route path="/settings" component={Settings} />
          <Route>
            <p className="text-muted">
              There’s nothing at this address.{' '}
              <Link href="/" className="text-fg underline">
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
