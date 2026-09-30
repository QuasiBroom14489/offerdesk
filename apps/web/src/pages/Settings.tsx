import { useEffect, useState } from 'react';
import {
  type GoogleStatus,
  useCheckGoogle,
  useConnectGoogle,
  useConnections,
  useDisconnectGoogle,
} from '../api';
import { buttonClass, quietButtonClass } from '../components/Dialog';
import { Dot, type Signal } from '../components/StatusMark';
import { ServerDown } from './Home';

/** What Google's redirect back to /settings?google=… means, in words. */
function flashFrom(search: string): { signal: Signal; text: string } | null {
  const q = new URLSearchParams(search);
  switch (q.get('google')) {
    case 'connected':
      return { signal: 'green', text: 'Google is connected.' };
    case 'denied':
      return { signal: 'grey', text: 'You didn’t grant access, so nothing changed.' };
    case 'error':
      return {
        signal: 'red',
        text: `Google didn’t connect: ${q.get('reason') ?? 'unknown error'}.`,
      };
    default:
      return null;
  }
}

export function Settings() {
  const { data, isPending, error } = useConnections();
  const [flash] = useState(() => flashFrom(window.location.search));

  // The outcome is shown once; don't keep it in the address bar.
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, '', '/settings');
  }, []);

  if (isPending) return <p className="text-faint">Loading…</p>;
  if (error) return <ServerDown message={error.message} />;

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-medium">Settings</h1>

      {flash && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <Dot signal={flash.signal} />
          {flash.text}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm text-faint">Connections</h2>
        <ul className="divide-y divide-line border-y border-line">
          <GoogleRow google={data.google} />
        </ul>
      </section>
    </div>
  );
}

const STATE: Record<GoogleStatus['status'], { signal: Signal; label: string }> = {
  connected: { signal: 'green', label: 'Connected' },
  error: { signal: 'red', label: 'Needs reconnecting' },
  disconnected: { signal: 'grey', label: 'Not connected' },
};

function GoogleRow({ google }: { google: GoogleStatus }) {
  const connect = useConnectGoogle();
  const check = useCheckGoogle();
  const disconnect = useDisconnectGoogle();
  const state = STATE[google.status];
  const busy = connect.isPending || check.isPending || disconnect.isPending;
  const failure = connect.error ?? check.error ?? disconnect.error;

  return (
    <li className="flex flex-wrap items-start justify-between gap-4 py-4">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium">Google Drive &amp; Sheets</span>
        <span className="text-sm text-muted">
          Push saved views to Google Sheets and bring files in from Drive. OfferDesk only sees files
          it creates or that you pick.
        </span>
        {google.available ? (
          <span className="flex items-center gap-1.5 text-sm text-muted">
            <Dot signal={state.signal} />
            {state.label}
            {google.status === 'connected' && google.email && ` as ${google.email}`}
          </span>
        ) : (
          <span className="text-sm text-muted">
            Google isn’t set up on this deployment (no OAuth client or credentials key).
          </span>
        )}
        {google.status === 'error' && google.lastError && (
          <span className="text-sm text-muted">{google.lastError}</span>
        )}
        {failure && <span className="text-sm text-muted">{failure.message}</span>}
      </div>

      {google.available && (
        <div className="flex shrink-0 gap-2">
          {google.status === 'connected' ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => check.mutate()}
                className={quietButtonClass}
              >
                {check.isPending ? 'Checking…' : 'Check'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => disconnect.mutate()}
                className={quietButtonClass}
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => connect.mutate()}
              className={buttonClass}
            >
              {google.status === 'error' ? 'Reconnect' : 'Connect'}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
