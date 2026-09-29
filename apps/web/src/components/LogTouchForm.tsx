import type { Contact } from '@offerdesk/shared';
import { type FormEvent, useState } from 'react';
import { type OutreachChannel, type ResponseChannel, useLogOutreach, useLogResponse } from '../api';
import { buttonClass, inputClass } from './Dialog';

const OUT: OutreachChannel[] = ['email', 'linkedin', 'in-person', 'referral', 'other'];
const IN: ResponseChannel[] = ['email', 'linkedin', 'phone', 'portal', 'other'];

/**
 * One form for both directions of a conversation: "I reached out" or "They
 * replied". Either an application, a contact, or both anchor it.
 */
export function LogTouchForm({
  applicationId,
  contactId,
  contacts,
}: {
  applicationId?: string;
  contactId?: string;
  contacts?: Contact[];
}) {
  const outreach = useLogOutreach();
  const response = useLogResponse();
  const [direction, setDirection] = useState<'out' | 'in'>('out');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const summary = String(f.get('summary') ?? '').trim() || undefined;
    const chosenContact = contactId ?? (String(f.get('contactId') ?? '') || null);
    const base = { applicationId: applicationId ?? null, contactId: chosenContact, summary };
    const done = {
      onSuccess: () => {
        form.reset();
        setError(null);
      },
      onError: (err: Error) => setError(err.message),
    };
    if (direction === 'out')
      outreach.mutate({ ...base, channel: f.get('channel') as OutreachChannel }, done);
    else response.mutate({ ...base, channel: f.get('channel') as ResponseChannel }, done);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5 rounded-lg border border-line p-3">
      <fieldset className="flex gap-1 text-sm">
        <legend className="sr-only">Direction</legend>
        {(['out', 'in'] as const).map((d) => (
          <label
            key={d}
            className={`cursor-pointer rounded-md px-2.5 py-1 ${direction === d ? 'bg-sunken font-medium text-fg' : 'text-muted'}`}
          >
            <input
              type="radio"
              name="direction"
              value={d}
              checked={direction === d}
              onChange={() => setDirection(d)}
              className="sr-only"
            />
            {d === 'out' ? 'I reached out' : 'They replied'}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <select name="channel" aria-label="Channel" className={inputClass} key={direction}>
          {(direction === 'out' ? OUT : IN).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {!contactId && contacts && contacts.length > 0 && (
          <select name="contactId" aria-label="Person" className={inputClass} defaultValue="">
            <option value="">No specific person</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <input
        name="summary"
        placeholder="What was said (optional)"
        aria-label="Summary"
        className={inputClass}
      />
      {error && <p className="text-sm text-bad">{error}</p>}
      <div>
        <button
          type="submit"
          className={buttonClass}
          disabled={outreach.isPending || response.isPending}
        >
          {direction === 'out' ? 'Log outreach' : 'Log reply'}
        </button>
      </div>
    </form>
  );
}
