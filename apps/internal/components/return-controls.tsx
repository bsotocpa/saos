'use client';

/*
 * STEP-7 CONTROLS ON THE RETURN'S PAGE (Brian, 2026-09-19, item 2).
 *
 * The return's page in Ops is the Returns card on the client record — there is no return detail
 * page and the ruling forbids a new admin page. Under each return still before filing, three
 * controls, each with one plain sentence saying what it does:
 *
 *   Lock estimate   — locks the range so preparation can start (gate 2 in the pipeline).
 *   Set final fee   — records the fee the client will be invoiced; read against the quoted range
 *                     under the price book in force; outside it, a standalone reason.
 *   <next stage>    — only the legal next transition(s), labelled by where the return goes.
 *                     "Mark filed" asks whose PTIN is on the filing (default: the assigned
 *                     preparer) and is refused, inline, without a signed authorization on file.
 *
 * WHO SEES THEM: a session holding engagements.tax.manage (tax_preparer, and the CEO by
 * wildcard) — decided from GET /auth/me, the same permission the routes require. Anyone else
 * gets nothing here: not disabled buttons, nothing.
 *
 * WHERE A REFUSAL RENDERS: in the modal, under the field, in the server's words (ask's `run`);
 * a failure reading the return renders beside the controls. Never at the page top.
 *
 * WHAT THIS SENDS TO CLIENTS: nothing. Filing issues the final-fee invoice through
 * invoiceForFiledEngagement → createInvoice, the door every invoice uses; its email is an outbox
 * intent behind its own gate.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, formatMoney } from '../lib/api';
import { TAX_STAGE_LABEL } from '../lib/labels';
import {
  canManageReturns, controlsApply, dollarsToCents, outsideRange, stageActionLabel, type QuotedRange,
} from '../lib/return-controls';
import { useAsk } from './ask';

interface Detail {
  taxEngagement: {
    id: string; stage: string;
    estimate_locked_at: string | null;
    estimated_fee_min_cents: number | null; estimated_fee_max_cents: number | null;
    final_fee_cents: number | null;
    preparer_ptin_holder_id: string | null;
  };
  quoted_range: QuotedRange | null;
  legal_next_stages: string[];
  signed_authorization_on_file: boolean;
  assigned_preparer: { id: string; name: string } | null;
  staff_options: Array<{ id: string; name: string }>;
}

/** One read of the session per page load, shared by every return on the card. */
let mePromise: Promise<{ permissions: string[] }> | null = null;
function me(): Promise<{ permissions: string[] }> {
  if (!mePromise) {
    mePromise = api<{ permissions: string[] }>('/auth/me').catch((e: unknown) => { mePromise = null; throw e; });
  }
  return mePromise;
}

const stageLabel = (s: string): string => (TAX_STAGE_LABEL as Record<string, string>)[s] ?? s.replaceAll('_', ' ');
const centsToDollars = (cents: number): string => (cents / 100).toFixed(2);
const words = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'The request was refused.');

export const CONTROL_SENTENCES = {
  lock: "Locks the estimate so preparation can start; the client's range no longer moves.",
  fee: 'Records the fee the client will be invoiced; outside the quoted range it needs a reason.',
  move: 'Moves the return to the next stage; filed issues the final-fee invoice through the same door every invoice uses.',
  upload: 'This scan is what authorizes the return; the date and the PTIN holder are recorded from it.',
} as const;

export interface ReturnControlsProps {
  taxEngagementId: string;
  /** The client the return belongs to — the signed 8879 upload files under them. */
  contactId: string;
  stage: string;
  /** The card re-reads the return list so the stage badge and the amount follow the change. */
  onChanged: () => Promise<void> | void;
}

export function ReturnControls({ taxEngagementId, contactId, stage, onChanged }: ReturnControlsProps): React.JSX.Element | null {
  const ask = useAsk();
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  const applies = controlsApply(stage);

  const load = useCallback(async () => {
    try {
      setDetail(await api<Detail>(`/tax-engagements/${taxEngagementId}`));
      setErr('');
    } catch (e) {
      setErr(words(e));
    }
  }, [taxEngagementId]);

  useEffect(() => {
    let alive = true;
    me()
      .then((m) => { if (alive) setCanManage(canManageReturns(m.permissions)); })
      .catch(() => { if (alive) setCanManage(false); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (canManage && applies) void load();
  }, [canManage, applies, load, stage]);

  if (!canManage || !applies) return null;
  if (!detail) return err ? <p className="field-error" role="alert">{err}</p> : null;

  const te = detail.taxEngagement;
  const range = detail.quoted_range;
  const rangeText = range
    ? `${range.min_cents === range.max_cents ? formatMoney(range.min_cents) : `${formatMoney(range.min_cents)}–${formatMoney(range.max_cents)}`} (price book v${range.price_book_version})`
    : 'no quoted range on file';
  const after = async () => { await load(); await onChanged(); };

  const lockEstimate = async () => {
    const draft = { min: range ? centsToDollars(range.min_cents) : '', max: range ? centsToDollars(range.max_cents) : '' };
    const a = await ask({
      title: 'Lock the estimate',
      body: <EstimateFields draft={draft} rangeText={rangeText} />,
      choices: [{ key: 'lock', label: 'Lock estimate', tone: 'primary' }],
      run: async () => {
        const minCents = dollarsToCents(draft.min);
        const maxCents = dollarsToCents(draft.max);
        if (minCents === null || maxCents === null) throw new Error('Enter the low and high ends of the range in dollars.');
        if (maxCents < minCents) throw new Error('The high end must be at least the low end.');
        await api(`/tax-engagements/${taxEngagementId}/estimate`, { method: 'POST', body: { minCents, maxCents } });
      },
    });
    if (!a) return;
    await after();
  };

  const setFinalFee = async () => {
    const draft = { amount: te.final_fee_cents !== null ? centsToDollars(te.final_fee_cents) : '' };
    const a = await ask({
      title: 'Set the final fee',
      body: <FinalFeeFields draft={draft} range={range} rangeText={rangeText} />,
      reason: {
        label: 'Reason',
        required: false,
        placeholder: 'Required when the amount is outside the quoted range: say why, for whoever reads this next.',
      },
      choices: [{ key: 'set', label: 'Set final fee', tone: 'primary' }],
      run: async (r) => {
        const finalFeeCents = dollarsToCents(draft.amount);
        if (finalFeeCents === null) throw new Error('Enter the final fee in dollars.');
        await api(`/tax-engagements/${taxEngagementId}/final-fee`, {
          method: 'POST',
          body: { finalFeeCents, ...(r.reason ? { reason: r.reason } : {}) },
        });
      },
    });
    if (!a) return;
    await after();
  };

  const transition = async (toStage: string) => {
    const label = stageActionLabel(toStage);
    if (toStage !== 'filed') {
      const a = await ask({
        title: `${label}?`,
        body: <p>Moves this return from {stageLabel(stage)} to {stageLabel(toStage)}.</p>,
        choices: [{ key: 'go', label, tone: 'primary' }],
        run: async () => { await api(`/tax-engagements/${taxEngagementId}/transition`, { method: 'POST', body: { toStage } }); },
      });
      if (!a) return;
      await after();
      return;
    }
    // The PTIN holder: set once at filing; the default is the assigned preparer.
    const draft = { ptin: te.preparer_ptin_holder_id ?? detail.assigned_preparer?.id ?? '' };
    const a = await ask({
      title: 'Mark filed',
      body: <FiledFields draft={draft} options={detail.staff_options} signed={detail.signed_authorization_on_file} feeCents={te.final_fee_cents} />,
      choices: [{ key: 'file', label: 'Mark filed', tone: 'primary' }],
      run: async () => {
        if (!draft.ptin) throw new Error('Say whose PTIN is on this filing (the paid preparer of record).');
        await api(`/tax-engagements/${taxEngagementId}/transition`, { method: 'POST', body: { toStage: 'filed', preparerPtinHolderId: draft.ptin } });
      },
    });
    if (!a) return;
    await after();
  };

  return (
    <div style={{ flex: '1 1 100%', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 8 }}>
      <div>
        {te.estimate_locked_at ? (
          <span className="badge ok">Estimate locked · {rangeText}</span>
        ) : (
          <button type="button" className="btn small ghost" onClick={() => void lockEstimate()}>Lock estimate</button>
        )}
        <p className="muted small">{CONTROL_SENTENCES.lock}</p>
      </div>
      <div>
        <button type="button" className="btn small ghost" onClick={() => void setFinalFee()}>Set final fee</button>
        {te.final_fee_cents !== null ? <span className="muted small"> current {formatMoney(te.final_fee_cents)}</span> : null}
        <p className="muted small">{CONTROL_SENTENCES.fee}</p>
      </div>
      <div>
        {detail.legal_next_stages.length === 0 ? <span className="muted small">No next stage from here.</span> : null}
        {detail.legal_next_stages.map((s) => (
          <button key={s} type="button" className="btn small accent" style={{ marginRight: 6 }} onClick={() => void transition(s)}>
            {stageActionLabel(s)}
          </button>
        ))}
        {detail.legal_next_stages.includes('filed') && !detail.signed_authorization_on_file ? (
          <p className="small" style={{ margin: '6px 0 0' }}><span className="badge warn">No signed authorization on file</span></p>
        ) : null}
        <p className="muted small">{CONTROL_SENTENCES.move}</p>
      </div>
      {detail.signed_authorization_on_file ? null : (
        <Upload8879
          contactId={contactId}
          taxEngagementId={taxEngagementId}
          defaultPtin={te.preparer_ptin_holder_id ?? detail.assigned_preparer?.id ?? ''}
          options={detail.staff_options}
          onUploaded={after}
        />
      )}
      {err ? <p className="field-error" role="alert" style={{ gridColumn: '1 / -1' }}>{err}</p> : null}
    </div>
  );
}

/*
 * THE SIGNED 8879, UPLOADED FROM THE RETURN'S ROW (2026-09-19, walk step 6). Ops had no screen
 * that put a signed authorization on file with its date and PTIN holder — the inbox filing form
 * has no signed date, and upload-return delivers only return deliverables. This is that screen:
 * one multipart POST to /documents, the same route the harness called by hand, and the upload IS
 * the authorization (signed-8879.ts). A refusal — a future date, a wrong category, an unknown
 * holder — renders beside the date control in the server's words, and the fields keep what was
 * typed.
 */
function Upload8879({ contactId, taxEngagementId, defaultPtin, options, onUploaded }: {
  contactId: string; taxEngagementId: string; defaultPtin: string;
  options: Array<{ id: string; name: string }>; onUploaded: () => Promise<void>;
}): React.JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [signedOn, setSignedOn] = useState('');
  const [ptin, setPtin] = useState(defaultPtin);
  const [uploadErr, setUploadErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!file) { setUploadErr('Choose the scanned, signed 8879 first.'); return; }
    if (!signedOn) { setUploadErr('Say the date on the signature.'); return; }
    if (!ptin) { setUploadErr('Say whose PTIN is on the 8879.'); return; }
    setBusy(true);
    setUploadErr('');
    try {
      const fd = new FormData();
      fd.append('contactId', contactId);
      fd.append('category', 'signed_authorizations');
      fd.append('taxEngagementId', taxEngagementId);
      fd.append('signedOn', signedOn);
      fd.append('preparerPtinHolderId', ptin);
      fd.append('file', file, file.name);
      await api<{ signed8879: boolean }>('/documents', { method: 'POST', formData: fd });
      await onUploaded();
    } catch (e) {
      setUploadErr(words(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, alignItems: 'end' }}>
      <label className="field">
        Signed 8879 (scan)
        <input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <label className="field">
        Signed on
        <input type="date" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} aria-invalid={uploadErr ? true : undefined} />
        {uploadErr ? <p className="field-error" role="alert">{uploadErr}</p> : null}
      </label>
      <label className="field">
        PTIN holder
        <select value={ptin} onChange={(e) => setPtin(e.target.value)}>
          <option value="">Choose…</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      <div>
        <button type="button" className="btn small ghost" data-testid="upload-signed-8879" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Uploading…' : 'Upload the signed 8879'}
        </button>
        <p className="muted small">{CONTROL_SENTENCES.upload}</p>
      </div>
    </div>
  );
}

function EstimateFields({ draft, rangeText }: { draft: { min: string; max: string }; rangeText: string }): React.JSX.Element {
  return (
    <>
      <p className="small">Quoted: {rangeText}. The range the client sees is locked at these numbers.</p>
      <label className="field">
        Low end (dollars)
        <input inputMode="decimal" defaultValue={draft.min} onChange={(e) => { draft.min = e.target.value; }} />
      </label>
      <label className="field">
        High end (dollars)
        <input inputMode="decimal" defaultValue={draft.max} onChange={(e) => { draft.max = e.target.value; }} />
      </label>
    </>
  );
}

function FinalFeeFields({ draft, range, rangeText }: { draft: { amount: string }; range: QuotedRange | null; rangeText: string }): React.JSX.Element {
  const [text, setText] = useState(draft.amount);
  const cents = dollarsToCents(text);
  const outside = cents !== null && outsideRange(cents, range);
  return (
    <>
      <p className="small">Quoted range: {rangeText}.</p>
      <label className="field">
        Final fee (dollars)
        <input inputMode="decimal" value={text} onChange={(e) => { setText(e.target.value); draft.amount = e.target.value; }} />
      </label>
      {outside ? (
        <p className="small" style={{ color: 'var(--danger)' }}>Outside the quoted range — a reason is required below; it registers on the money line.</p>
      ) : range ? (
        <p className="muted small">Inside the quoted range — no reason needed.</p>
      ) : null}
    </>
  );
}

function FiledFields({ draft, options, signed, feeCents }: {
  draft: { ptin: string }; options: Array<{ id: string; name: string }>; signed: boolean; feeCents: number | null;
}): React.JSX.Element {
  return (
    <>
      {signed ? null : (
        <p className="field-error" role="alert">No signed authorization on file: the filing is refused until the signed 8879 is uploaded under Signed Authorizations.</p>
      )}
      <p className="small">
        {feeCents !== null
          ? `Issues the final-fee invoice for ${formatMoney(feeCents)} through the same door every invoice uses.`
          : 'No final fee is set: filing records the return and opens a task to set the fee and invoice.'}
      </p>
      <label className="field">
        PTIN holder (the paid preparer of record)
        <select defaultValue={draft.ptin} onChange={(e) => { draft.ptin = e.target.value; }}>
          <option value="">Choose…</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
    </>
  );
}
