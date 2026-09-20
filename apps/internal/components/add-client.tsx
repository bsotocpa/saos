'use client';

/*
 * ADD A CLIENT (Brian, ruling R14, 2026-09-20).
 *
 * Ops could search 426 clients and create none of them. /contacts has accepted a POST since M6 and
 * no screen ever sent one: a new client arrived by seed, by import, or by curl. This is the door,
 * and it is the door with the duplicate check built into it — because the cheapest moment to catch
 * a second record for one person is before the first keystroke is saved, not in a merge three months
 * later when both records hold work.
 *
 * The check runs as the person types (debounced) and again on submit, so a fast typist pressing the
 * button cannot outrun it. A likely duplicate does not refuse anything: it renders here, with a link
 * to the record, and creating anyway takes a second, deliberate tap that the route records on the
 * creation's audit row (duplicate_acknowledged) — the twin was seen, not missed.
 *
 * Refusals render beside the field that caused them, in the server's words, and the fields keep
 * their text (the 2026-09-19 defect 2 rule). The same ModalShell as everything else.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';
import { ModalShell } from './modal-shell';

export interface Duplicate {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  isTest: boolean;
  reasons: string[];
  /** The server's words for why this is a likely duplicate, rendered as they arrive. */
  reason: string;
}

type Field = 'firstName' | 'lastName' | 'email' | 'phone' | 'language' | 'form';

export interface AddClientProps {
  onClose: () => void;
  /** The new contact's id; the caller navigates to the record. */
  onAdded: (contactId: string) => Promise<void> | void;
}

/** Ten digits is what the check compares (the merge's own rule); fewer is not a number yet. */
const digitsOf = (s: string): string => s.replace(/\D/g, '');

export function AddClientModal(props: AddClientProps): React.JSX.Element {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [language, setLanguage] = useState<'en' | 'es'>('en');
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: Field; message: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const errAt = (field: Field) =>
    error?.field === field ? <p className="field-error" role="alert" data-field={field}>{error.message}</p> : null;

  /** The query the check needs, or null when there is not enough typed to ask a real question. */
  const query = useCallback((): string | null => {
    const params = new URLSearchParams();
    if (firstName.trim() && lastName.trim()) {
      params.set('firstName', firstName.trim());
      params.set('lastName', lastName.trim());
    }
    if (email.trim()) params.set('email', email.trim());
    if (digitsOf(phone).length >= 10) params.set('phone', phone.trim());
    return [...params.keys()].length === 0 ? null : params.toString();
  }, [firstName, lastName, email, phone]);

  const check = useCallback(async (): Promise<Duplicate[]> => {
    const q = query();
    if (q === null) return [];
    const res = await api<{ duplicates: Duplicate[] }>(`/contacts/duplicate-check?${q}`);
    return res.duplicates;
  }, [query]);

  // As the person types. Debounced so a name is one request, not one per keystroke.
  useEffect(() => {
    const q = query();
    if (q === null) { setDuplicates([]); return; }
    const handle = setTimeout(() => {
      void api<{ duplicates: Duplicate[] }>(`/contacts/duplicate-check?${q}`)
        .then((res) => { if (alive.current) setDuplicates(res.duplicates); })
        // A background check that cannot reach the server says nothing: submit asks again, and a
        // refusal there lands beside the control, not as noise while someone is still typing.
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(handle);
  }, [query]);

  const create = async (anyway: boolean): Promise<void> => {
    if (busy) return;
    setError(null);
    if (firstName.trim().length === 0) { setError({ field: 'firstName', message: 'A first name is required.' }); return; }
    if (lastName.trim().length === 0) { setError({ field: 'lastName', message: 'A last name is required.' }); return; }
    setBusy(true);
    try {
      if (!anyway) {
        const found = await check();
        if (found.length > 0) { setDuplicates(found); setBusy(false); return; }
      }
      const body: Record<string, unknown> = {
        firstName: firstName.trim(), lastName: lastName.trim(), language,
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(anyway ? { duplicateAcknowledged: true, duplicateIds: duplicates.map((d) => d.id) } : {}),
      };
      const r = await api<{ id: string }>('/contacts', { method: 'POST', body });
      await props.onAdded(r.id);
    } catch (err) {
      // The server's words, beside the field they are about. A validation refusal names its path.
      const message = err instanceof Error && err.message ? err.message : 'The client was refused.';
      const payload = (err as { payload?: { issues?: Array<{ path?: string; message?: string }>; error?: string } }).payload;
      const issue = payload?.issues?.[0];
      const path = issue?.path ?? '';
      const field: Field =
        path === 'firstName' ? 'firstName'
          : path === 'lastName' ? 'lastName'
            : path === 'email' ? 'email'
              : path === 'phone' ? 'phone'
                : path === 'language' ? 'language'
                  : 'form';
      setError({ field, message: issue?.message ?? message });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const submit = (e: FormEvent) => { e.preventDefault(); void create(false); };

  return (
    <ModalShell
      id="add-client"
      title="Add a client"
      dismissable={!busy}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="btn ghost" disabled={busy} onClick={props.onClose}>Cancel</button>
          <button type="submit" form="add-client-form" className="btn accent" disabled={busy}>{busy ? 'Working…' : 'Add client'}</button>
        </>
      }
    >
      <form id="add-client-form" onSubmit={submit} noValidate>
        <label className="field">
          First name <span className="muted small">(required)</span>
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus autoComplete="off" aria-invalid={error?.field === 'firstName' || undefined} />
          {errAt('firstName')}
        </label>
        <label className="field">
          Last name <span className="muted small">(required)</span>
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="off" aria-invalid={error?.field === 'lastName' || undefined} />
          {errAt('lastName')}
        </label>
        <label className="field">
          Email <span className="muted small">(optional)</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" autoComplete="off" aria-invalid={error?.field === 'email' || undefined} />
          {errAt('email')}
        </label>
        <label className="field">
          Phone <span className="muted small">(optional)</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" aria-invalid={error?.field === 'phone' || undefined} />
          {errAt('phone')}
        </label>
        <label className="field">
          Language
          <select value={language} onChange={(e) => setLanguage(e.target.value === 'es' ? 'es' : 'en')} aria-invalid={error?.field === 'language' || undefined}>
            <option value="en">English</option>
            <option value="es">Spanish</option>
          </select>
          {errAt('language')}
        </label>
        {errAt('form')}
        {duplicates.length > 0 ? (
          <div className="alert warn" data-testid="duplicate-warning">
            <strong>{duplicates.length === 1 ? 'This may already be in the book.' : 'These may already be in the book.'}</strong>
            <ul>
              {duplicates.map((d) => (
                <li key={d.id}>
                  <Link href={`/clients/${d.id}`}>{d.firstName} {d.lastName}</Link>
                  {d.isTest ? <> <span className="badge warn">TEST</span></> : null}
                  {' — '}{d.reason}.
                </li>
              ))}
            </ul>
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => void create(true)}>Create anyway</button>
          </div>
        ) : null}
      </form>
      <p className="muted small">
        The book is checked for a likely duplicate as you type; nothing is created until you choose.
      </p>
    </ModalShell>
  );
}
