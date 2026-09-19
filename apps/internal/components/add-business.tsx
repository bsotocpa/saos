'use client';

/*
 * ADD A BUSINESS FROM THE CLIENT PAGE (Brian, 2026-09-19, item 0).
 *
 * The Businesses card offered Set as primary and Archive and no way in: the harness made its
 * S corporation through the route, and Brian's own record could not. This is the door: legal
 * name, entity type, state, EIN, formation date, and primary at creation. The same modal shell
 * as everything else; a refusal renders beside the field that caused it, verbatim, and the
 * fields keep their text (defect 2, the same day).
 */

import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { ModalShell } from './modal-shell';

const ENTITY_TYPES: Array<{ key: string; label: string }> = [
  { key: 'llc', label: 'LLC' },
  { key: 's_corp', label: 'S corporation' },
  { key: 'c_corp', label: 'C corporation' },
  { key: 'partnership', label: 'Partnership' },
  { key: 'sole_prop', label: 'Sole proprietorship' },
  { key: 'pllc', label: 'PLLC' },
  { key: 'nonprofit', label: 'Nonprofit' },
  { key: 'coop', label: 'Cooperative' },
  { key: 'not_sure', label: 'Not sure yet' },
  { key: 'other', label: 'Other' },
];

export interface AddBusinessProps {
  contactId: string;
  /** Whether the record already has a primary; the checkbox defaults to primary when it does not. */
  hasPrimary: boolean;
  onClose: () => void;
  onAdded: (businessId: string) => Promise<void> | void;
}

export function AddBusinessModal(props: AddBusinessProps): React.JSX.Element {
  const [name, setName] = useState('');
  const [entityType, setEntityType] = useState('llc');
  const [state, setState] = useState('IL');
  const [ein, setEin] = useState('');
  const [formationDate, setFormationDate] = useState('');
  const [setPrimary, setSetPrimary] = useState(!props.hasPrimary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: 'name' | 'ein' | 'state' | 'formationDate' | 'form'; message: string } | null>(null);

  const errAt = (field: NonNullable<typeof error>['field']) =>
    error?.field === field ? <p className="field-error" role="alert" data-field={field}>{error.message}</p> : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (name.trim().length === 0) { setError({ field: 'name', message: 'The legal name is required.' }); return; }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(), entityType, state: state.trim().toUpperCase(), setPrimary,
        ...(ein.trim() ? { ein: ein.trim() } : {}),
        ...(formationDate ? { formationDate } : {}),
      };
      const r = await api<{ id: string }>(`/contacts/${props.contactId}/businesses`, { method: 'POST', body });
      await props.onAdded(r.id);
    } catch (err) {
      // The server's words, beside the field they are about. A validation issue names its path.
      const message = err instanceof Error && err.message ? err.message : 'The business was refused.';
      const payload = (err as { payload?: { issues?: Array<{ path?: string; message?: string }>; error?: string } }).payload;
      const issue = payload?.issues?.[0];
      const field = issue?.path === 'ein' ? 'ein' : issue?.path === 'state' ? 'state' : issue?.path === 'formationDate' || payload?.error === 'formation_date_in_future' ? 'formationDate' : issue?.path === 'name' ? 'name' : 'form';
      setError({ field, message: issue?.message ? `${issue.message}` : message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      id="add-business"
      title="Add a business"
      dismissable={!busy}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="btn ghost" disabled={busy} onClick={props.onClose}>Cancel</button>
          <button type="submit" form="add-business-form" className="btn accent" disabled={busy}>{busy ? 'Working…' : 'Add business'}</button>
        </>
      }
    >
      <form id="add-business-form" onSubmit={(e) => void submit(e)} noValidate>
        <label className="field">
          Legal name <span className="muted small">(required)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Soto Accounting LLC" autoFocus aria-invalid={error?.field === 'name' || undefined} />
          {errAt('name')}
        </label>
        <label className="field">
          Entity type
          <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            {ENTITY_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <label className="field">
          State
          <input value={state} onChange={(e) => setState(e.target.value)} maxLength={2} style={{ width: '5em' }} aria-invalid={error?.field === 'state' || undefined} />
          {errAt('state')}
        </label>
        <label className="field">
          EIN <span className="muted small">(optional, XX-XXXXXXX)</span>
          <input value={ein} onChange={(e) => setEin(e.target.value)} inputMode="numeric" placeholder="12-3456789" aria-invalid={error?.field === 'ein' || undefined} />
          {errAt('ein')}
        </label>
        <label className="field">
          Formation date <span className="muted small">(optional; the state&apos;s date, as you know it)</span>
          <input type="date" value={formationDate} onChange={(e) => setFormationDate(e.target.value)} aria-invalid={error?.field === 'formationDate' || undefined} />
          {errAt('formationDate')}
        </label>
        <label className="small">
          <input type="checkbox" checked={setPrimary} onChange={(e) => setSetPrimary(e.target.checked)} />{' '}
          Make this the primary business{props.hasPrimary ? ' (the current primary stops being primary)' : ''}
        </label>
        {errAt('form')}
      </form>
    </ModalShell>
  );
}
