import { STATUS_LABELS, STATUSES, type Status } from '@offerdesk/shared';
import { type FormEvent, useState } from 'react';
import { useLocation } from 'wouter';
import { useAddApplication } from '../api';
import { buttonClass, Dialog, Field, inputClass, quietButtonClass } from './Dialog';

export function NewApplicationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const add = useAddApplication();
  const [, navigate] = useLocation();
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => {
      const v = String(f.get(k) ?? '').trim();
      return v === '' ? null : v;
    };
    add.mutate(
      {
        company: text('company') ?? '',
        role: text('role') ?? '',
        postingUrl: text('postingUrl'),
        location: text('location'),
        deadline: text('deadline'),
        source: text('source'),
        season: text('season'),
        status: (text('status') ?? 'saved') as Status,
      },
      {
        onSuccess: (app) => {
          setError(null);
          onClose();
          navigate(`/applications/${app.id}`);
        },
        onError: (err) => setError(err.message),
      },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} title="Add an application">
      <form onSubmit={submit} className="flex flex-col gap-4 p-5">
        <h2 className="text-lg font-medium">Add an application</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Company">
            <input name="company" required autoFocus className={inputClass} />
          </Field>
          <Field label="Role">
            <input name="role" required className={inputClass} />
          </Field>
          <Field label="Posting link">
            <input name="postingUrl" type="url" placeholder="https://" className={inputClass} />
          </Field>
          <Field label="Location">
            <input name="location" className={inputClass} />
          </Field>
          <Field label="Deadline">
            <input name="deadline" type="date" className={inputClass} />
          </Field>
          <Field label="Where you found it">
            <input name="source" placeholder="Career fair, Handshake…" className={inputClass} />
          </Field>
          <Field label="Season">
            <input name="season" defaultValue="Summer 2027" className={inputClass} />
          </Field>
          <Field label="Status">
            <select name="status" defaultValue="saved" className={inputClass}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={quietButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={add.isPending} className={buttonClass}>
            Add application
          </button>
        </div>
      </form>
    </Dialog>
  );
}
