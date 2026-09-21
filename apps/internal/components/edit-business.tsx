'use client';

/*
 * EDIT A BUSINESS ON THE CLIENT PAGE (Brian, 2026-09-20, edit after create).
 *
 * The Businesses card could add a business and never correct one: a wrong EIN, a missing formation
 * date or an industry left blank at creation had no door but the API. This is the door, the same
 * shell and the same rules as Add: legal name, entity type, state, EIN, formation date, industry;
 * a refusal renders beside the field that caused it, in the server's words, and the fields keep
 * their text. Only what changed is sent, so a PATCH never overwrites a field edited elsewhere since
 * the page loaded.
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

export interface EditBusinessProps {
  business: {
    id: string; name: string; entity_type: string | null; state: string | null;
    ein: string | null; formation_date?: string | null; industry: string | null;
  };
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

type Field = 'name' | 'entityType' | 'state' | 'ein' | 'formationDate' | 'industry' | 'form';

export function EditBusinessModal(props: EditBusinessProps): React.JSX.Element {
  const b = props.business;
  const [name, setName] = useState(b.name);
  const [entityType, setEntityType] = useState(b.entity_type ?? 'not_sure');
  const [state, setState] = useState(b.state ?? 'IL');
  const [ein, setEin] = useState(b.ein ?? '');
  const [formationDate, setFormationDate] = useState(b.formation_date ?? '');
  const [industry, setIndustry] = useState(b.industry ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: Field; message: string } | null>(null);

  const errAt = (field: Field) =>
    error?.field === field ? <p className="field-error" role="alert" data-field={field}>{error.message}</p> : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (name.trim().length === 0) { setError({ field: 'name', message: 'The legal name is required.' }); return; }
    setBusy(true);
    try {
      // Only what changed. An EIN or a formation date cannot be cleared here — clearing an
      // identifier is a different act from correcting one, and this door does not offer it.
      const body: Record<string, unknown> = {};
      if (name.trim() !== b.name) body.name = name.trim();
      if (entityType !== (b.entity_type ?? 'not_sure')) body.entityType = entityType;
      if (state.trim().toUpperCase() !== (b.state ?? '')) body.state = state.trim().toUpperCase();
      if (ein.trim() && ein.trim() !== (b.ein ?? '')) body.ein = ein.trim();
      if (formationDate && formationDate !== (b.formation_date ?? '')) body.formationDate = formationDate;
      if (industry.trim() !== (b.industry ?? '')) body.industry = industry.trim();
      if (Object.keys(body).length === 0) { props.onClose(); return; }
      await api(`/businesses/${b.id}`, { method: 'PATCH', body });
      await props.onSaved();
    } catch (err) {
      // The server's words, beside the field they are about. A validation issue names its path.
      const message = err instanceof Error && err.message ? err.message : 'The change was refused.';
      const payload = (err as { payload?: { issues?: Array<{ path?: string; message?: string }>; error?: string } }).payload;
      const issue = payload?.issues?.[0];
      const path = issue?.path ?? '';
      const field: Field =
        path === 'ein' || payload?.error === 'ein_in_use' ? 'ein'
          : path === 'state' ? 'state'
            : path === 'formationDate' || payload?.error === 'formation_date_in_future' ? 'formationDate'
              : path === 'name' ? 'name'
                : path === 'entityType' ? 'entityType'
                  : path === 'industry' ? 'industry'
                    : 'form';
      setError({ field, message: issue?.message ? `${issue.message}` : message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      id="edit-business"
      title={`Edit ${b.name}`}
      dismissable={!busy}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="btn ghost" disabled={busy} onClick={props.onClose}>Cancel</button>
          <button type="submit" form="edit-business-form" className="btn accent" disabled={busy}>{busy ? 'Working…' : 'Save business'}</button>
        </>
      }
    >
      <form id="edit-business-form" onSubmit={(e) => void submit(e)} noValidate>
        <label className="field">
          Legal name <span className="muted small">(required)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-invalid={error?.field === 'name' || undefined} />
          {errAt('name')}
        </label>
        <label className="field">
          Entity type
          <select value={entityType} onChange={(e) => setEntityType(e.target.value)} aria-invalid={error?.field === 'entityType' || undefined}>
            {ENTITY_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          {errAt('entityType')}
        </label>
        <label className="field">
          State
          <input value={state} onChange={(e) => setState(e.target.value)} maxLength={2} style={{ width: '5em' }} aria-invalid={error?.field === 'state' || undefined} />
          {errAt('state')}
        </label>
        <label className="field">
          EIN <span className="muted small">(XX-XXXXXXX)</span>
          <input value={ein} onChange={(e) => setEin(e.target.value)} inputMode="numeric" placeholder="12-3456789" aria-invalid={error?.field === 'ein' || undefined} />
          {errAt('ein')}
        </label>
        <label className="field">
          Formation date <span className="muted small">(the state&apos;s date, as you know it)</span>
          <input type="date" value={formationDate} onChange={(e) => setFormationDate(e.target.value)} aria-invalid={error?.field === 'formationDate' || undefined} />
          {errAt('formationDate')}
        </label>
        <label className="field">
          Industry
          <input value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="food_beverage" aria-invalid={error?.field === 'industry' || undefined} />
          {errAt('industry')}
        </label>
        {errAt('form')}
      </form>
    </ModalShell>
  );
}
