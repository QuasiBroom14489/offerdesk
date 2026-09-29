import { type FormEvent, useState } from 'react';
import { useLocation } from 'wouter';
import { useAddContact } from '../api';
import { buttonClass, Dialog, Field, inputClass, quietButtonClass } from './Dialog';

export function NewContactDialog({
  open,
  onClose,
  defaultCompany,
}: {
  open: boolean;
  onClose: () => void;
  defaultCompany?: string;
}) {
  const add = useAddContact();
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
        name: text('name') ?? '',
        company: text('company'),
        title: text('title'),
        email: text('email'),
        linkedin: text('linkedin'),
        howMet: text('howMet'),
      },
      {
        onSuccess: (c) => {
          setError(null);
          onClose();
          navigate(`/people/${c.id}`);
        },
        onError: (err) => setError(err.message),
      },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} title="Add a person">
      <form onSubmit={submit} className="flex flex-col gap-4 p-5">
        <h2 className="text-lg font-semibold">Add a person</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input name="name" required autoFocus className={inputClass} />
          </Field>
          <Field label="Company">
            <input name="company" defaultValue={defaultCompany} className={inputClass} />
          </Field>
          <Field label="Title">
            <input name="title" placeholder="Recruiter, analyst…" className={inputClass} />
          </Field>
          <Field label="How you met">
            <input name="howMet" placeholder="Career fair, alumni…" className={inputClass} />
          </Field>
          <Field label="Email">
            <input name="email" type="email" className={inputClass} />
          </Field>
          <Field label="LinkedIn">
            <input name="linkedin" className={inputClass} />
          </Field>
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={quietButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={add.isPending} className={buttonClass}>
            Add person
          </button>
        </div>
      </form>
    </Dialog>
  );
}
