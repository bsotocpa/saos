'use client';

/*
 * THE RETURNS CARD AS A RAIL OF FIVE PHASES (Brian, 2026-09-26 R50; sent back and rebuilt 2026-09-27,
 * R50 v2). Behind OPS_RETURN_STEPPER, off in production until Brian approves the screenshots (the
 * dark-ship rule, R57); the client page renders this in place of the row when GET /auth/me says the
 * switch is on, and the row otherwise.
 *
 * THE RAIL shows five phases — Engage, Prepare, Sign, File, Close (lib/return-stepper.ts holds the
 * phases, their steps and the rules). A DONE phase is one line: check, name, date. A FUTURE phase is
 * its name, greyed. Only the CURRENT phase is open; inside it the current step shows its one control
 * and one sentence — the same control the row offers, from the same useReturnActions hook, so nothing
 * here re-implements a modal — and the other steps of the phase are one line each (a done step: check,
 * name, day, person; a later step: its greyed name). Horizontal on the desk, vertical on the phone,
 * where the current phase is scrolled into view when the row opens.
 *
 * SECONDARY ACTIONS — record the extension, change the preparer, correct the filing — sit in a details
 * area under the rail, at every stage they apply, because none of them is a step: an extension can go
 * in at any time before filing and a preparer can change.
 *
 * THE JURISDICTION RECORD prints once (R50 fix 1): as the body of the "accepted or mailed" step while
 * the File phase is open, and as its own block under the rail at every other stage, since where a
 * return was filed and mailed is readable at every stage (ruling 25). The Record mailing controls hang
 * off the same list wherever it is. The paper sentence prints only when a paper jurisdiction is declared
 * (fix 2); the amount is labelled by the page's header (amountLabel, fix 3); the "extended" badge leaves
 * at filing (showExtendedBadge, fix 4).
 *
 * WHO SEES WHAT: everyone who can read the return sees the phases (engagements.read, the same read
 * GET /tax-engagements/:id requires); only a session holding engagements.tax.manage sees a control,
 * the details area or the mailing block — the same rule as the row, decided from the same session read.
 *
 * WHERE A REFUSAL RENDERS: in the modal, beside its field, in the server's words; a failure reading the
 * return renders beside the rail. Never at the page top.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatMoney } from '../lib/api';
import { dayOf, formatDate } from '../lib/dates';
import {
  canManageReturns, controlsApply, correctionLine, correctionsApply, extensionBadgeText, jurisdictionLabel, jurisdictionStatusText,
  mailingControlsApply, mailingsNeeded, stageActionLabel, MAILING_METHOD_LABEL, type FilingCorrectionView, type JurisdictionView,
} from '../lib/return-controls';
import {
  buildPhases, buildSteps, currentPhase, currentStep, feeDetail, hasPaperJurisdiction, type PhaseView, type StepView, type StepperInput,
} from '../lib/return-stepper';
import {
  CONTROL_SENTENCES, me, sent8879Line, Upload8879, UploadEngagementLetter, useReturnActions, type Detail,
} from './return-controls';

const words = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'The request was refused.');

export interface ReturnStepperProps {
  taxEngagementId: string;
  contactId: string;
  stage: string;
  /** The card re-reads the return list so the header follows the change. */
  onChanged: () => Promise<void> | void;
}

export function ReturnStepper({ taxEngagementId, contactId, stage, onChanged }: ReturnStepperProps): React.JSX.Element | null {
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [err, setErr] = useState('');

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
  useEffect(() => { void load(); }, [load, stage]);

  if (canManage === null) return null;
  if (!detail) return err ? <p className="field-error" role="alert" style={{ flex: '1 1 100%' }}>{err}</p> : null;
  return (
    <StepperBody
      taxEngagementId={taxEngagementId}
      contactId={contactId}
      stage={stage}
      detail={detail}
      canManage={canManage}
      err={err}
      after={async () => { await load(); await onChanged(); }}
    />
  );
}

function StepperBody({ taxEngagementId, contactId, stage, detail, canManage, err, after }: {
  taxEngagementId: string; contactId: string; stage: string; detail: Detail; canManage: boolean; err: string; after: () => Promise<void>;
}): React.JSX.Element {
  const actions = useReturnActions({ taxEngagementId, contactId, stage, detail, after });
  const te = detail.taxEngagement;
  const input: StepperInput = {
    te: {
      stage: te.stage,
      engagement_letter_signed_at: te.engagement_letter_signed_at,
      engagement_letter_signed_on: te.engagement_letter_signed_on ?? null,
      estimate_locked_at: te.estimate_locked_at,
      estimated_fee_min_cents: te.estimated_fee_min_cents,
      estimated_fee_max_cents: te.estimated_fee_max_cents,
      final_fee_cents: te.final_fee_cents,
      filed_date: te.filed_date,
      f8879_signed_on: te.f8879_signed_on,
      payment_status: te.payment_status ?? null,
    },
    stageHistory: detail.stageHistory ?? [],
    activity: detail.activity ?? [],
    f8879_sent: detail.f8879_sent,
    signed_authorization_on_file: detail.signed_authorization_on_file,
    assigned_preparer: detail.assigned_preparer,
    preparer_of_record: te.preparer_of_record ?? null,
    jurisdictions: detail.jurisdictions ?? [],
    final_fee_invoice: detail.final_fee_invoice,
    legal_next_stages: detail.legal_next_stages ?? [],
  };
  const steps = buildSteps(input);
  const current = currentStep(steps);
  const phases = buildPhases(steps);
  const open = currentPhase(phases);
  const preFiled = controlsApply(stage);
  const mailable = mailingControlsApply(stage);
  const corrections: FilingCorrectionView[] = detail.filing_corrections ?? [];
  const mailingControls = canManage && mailable;

  // ON THE PHONE THE CURRENT PHASE IS IN VIEW when the row opens: once, when the rail mounts, and only
  // for the top return's rail when the client has several (one scroll, not one per return). The desk
  // rail sits beside the header and needs none. A reader who asked for reduced motion gets a jump.
  const railRef = useRef<HTMLOListElement>(null);
  const openRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const rail = railRef.current;
    const el = openRef.current;
    if (!rail || !el || window.matchMedia('(min-width: 768px)').matches) return;
    if (document.querySelector('[data-testid="return-stepper"]') !== rail) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  }, []);

  const jurisdictionBlock = <JurisdictionBlock detail={detail} controls={mailingControls} onMailing={actions.recordMailing} />;

  return (
    <>
      <ol className="stepper" data-testid="return-stepper" aria-label="Return phases" ref={railRef}>
        {phases.map((p, i) => (
          <li
            key={p.key}
            ref={p.state === 'current' ? openRef : undefined}
            className={`phase ${p.state}`}
            data-testid={`phase-${p.key}`}
            data-state={p.state}
            aria-current={p.state === 'current' ? 'step' : undefined}
          >
            <div className="phase-head">
              <span className="step-mark" aria-hidden="true">{p.state === 'done' ? '✓' : i + 1}</span>
              {/* ONE ELEMENT per phase's words: a done phase's name and date are one text, so a reader (and
                  the walk's getByText) finds the line once. */}
              <span className="phase-label">{p.state === 'done' ? phaseLine(p) : p.label}</span>
            </div>
            {p.state === 'current' ? (
              <ol className="phase-steps" aria-label={`${p.label} steps`}>
                {p.steps.map((s, j) => (
                  <li key={s.key} className={`step ${s.state}`} data-testid={`step-${s.key}`} data-state={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
                    <div className="step-head">
                      <span className="step-mark" aria-hidden="true">{s.state === 'done' ? '✓' : j + 1}</span>
                      <span className="step-label">{s.state === 'done' && s.done ? doneLine(s, te, actions.rangeText) : s.label}</span>
                    </div>
                    {s.key === 'jurisdictions' ? jurisdictionBlock : null}
                    {s.state === 'current' && canManage ? (
                      <div className="step-panel" data-testid="current-step-control">
                        <CurrentControl step={s} detail={detail} actions={actions} contactId={contactId} taxEngagementId={taxEngagementId} after={after} />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ))}
      </ol>
      {/* The record, at every stage the File phase is not open (ruling 25: readable at every stage). */}
      {open?.key !== 'file' && (detail.jurisdictions ?? []).length > 0 ? (
        <div className="step-record" data-testid="jurisdiction-record">{jurisdictionBlock}</div>
      ) : null}
      {canManage && (preFiled || mailable || correctionsApply(stage)) ? (
        <div className="step-details" data-testid="return-details">
          <p className="muted small" style={{ gridColumn: '1 / -1', margin: 0 }}>Details</p>
          {preFiled && current?.key !== 'preparer' ? (
            <div>
              {/* The Engage phase names the preparer; this changes them. */}
              <button type="button" className="btn small ghost" data-testid="assign-preparer" onClick={() => void actions.assignPreparer()}>
                {detail.assigned_preparer ? 'Change preparer' : 'Assign preparer'}
              </button>
              <p className="muted small">{CONTROL_SENTENCES.preparer}</p>
            </div>
          ) : null}
          {preFiled ? (
            <div>
              {te.extension_filed ? (
                <span className="badge warn">{extensionBadgeText(te.extension_form, te.extended_deadline ? formatDate(te.extended_deadline) : '')}</span>
              ) : (
                <button type="button" className="btn small ghost" data-testid="record-extension" onClick={() => void actions.recordExtension()}>Record extension</button>
              )}
              <p className="muted small">{CONTROL_SENTENCES.extension}</p>
            </div>
          ) : null}
          {correctionsApply(stage) ? (
            <div>
              <button type="button" className="btn small ghost" data-testid="correct-filing" onClick={() => void actions.correctFiling()}>Correct the filing</button>
              <p className="muted small">{CONTROL_SENTENCES.correction}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {corrections.length > 0 ? (
        <ul className="list" style={{ flex: '1 1 100%' }} data-testid={`filing-history-${taxEngagementId}`}>
          {corrections.map((c) => (
            <li key={c.id} data-testid={`filing-correction-${c.id}`}>
              <span className="grow muted small">{correctionLine(c, dayOf(c.created_at))}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {err ? <p className="field-error" role="alert" style={{ flex: '1 1 100%' }}>{err}</p> : null}
    </>
  );
}

/** "Engage · Sep 26, 2026" — a done phase's one line after its check: the name and the day its last step was done. */
function phaseLine(p: PhaseView): string {
  const d = p.doneOn;
  const when = d?.day ? formatDate(d.day) : d?.at ? dayOf(d.at) : '';
  return when ? `${p.label} · ${when}` : p.label;
}

/** "Filed Sep 26, 2026 · by Brian Soto · preparer of record: Ana" — a done step's one line: the check, the day, the person, the detail. */
function doneLine(s: StepView, te: Detail['taxEngagement'], rangeText: string): string {
  const d = s.done!;
  const when = d.day ? formatDate(d.day) : d.at ? dayOf(d.at) : '';
  let detail = d.detail ?? '';
  // The locked range, under the book version that priced it — the words the row printed.
  if (s.key === 'estimate' && te.estimate_locked_at) detail = rangeText;
  if (s.key === 'final_fee' && te.final_fee_cents !== null) detail = feeDetail(formatMoney(te.final_fee_cents));
  const parts = [`${s.label}${when ? ` ${when}` : ''}`, d.by ? `by ${d.by}` : '', detail].filter(Boolean);
  return parts.join(' · ');
}

/**
 * THE JURISDICTIONS, PRINTED ONCE (fix 1). The record — one line per declared jurisdiction — is the
 * body of the "accepted or mailed" step while the File phase is open, and its own block under the rail
 * otherwise; at filed and rejected, for a manager, the same list sits inside the mailing block with a
 * Record mailing control per paper jurisdiction that has none. The paper sentence prints only when a
 * paper jurisdiction is declared (fix 2).
 */
function JurisdictionBlock({ detail, controls, onMailing }: {
  detail: Detail; controls: boolean; onMailing: (jurisdiction: string) => Promise<void>;
}): React.JSX.Element | null {
  const rows = detail.jurisdictions ?? [];
  if (rows.length === 0) return null;
  const list = (
    <ul className="list" style={{ marginTop: 6 }}>
      {rows.map((j) => {
        const day = j.filingMethod === 'paper' ? j.mailedOn : j.acceptedOn;
        return (
          <li key={j.jurisdiction} data-testid={`jurisdiction-line-${j.jurisdiction}`}>
            <span className="badge">{jurisdictionLabel(j.jurisdiction)}</span>{' '}
            <span className="grow muted small">
              {jurisdictionRecordLine(j, day ? formatDate(day) : '')}
            </span>
          </li>
        );
      })}
    </ul>
  );
  if (!controls) return list;
  return (
    <div data-testid="jurisdiction-status">
      {list}
      {mailingsNeeded(rows).map((j) => (
        <span key={j.jurisdiction} style={{ marginRight: 8 }}>
          <button type="button" className="btn small accent" data-testid={`record-mailing-${j.jurisdiction}`} onClick={() => void onMailing(j.jurisdiction)}>
            Record mailing {'—'} {jurisdictionLabel(j.jurisdiction)}
          </button>
        </span>
      ))}
      {hasPaperJurisdiction(rows) ? <p className="muted small">{CONTROL_SENTENCES.mailing}</p> : null}
    </div>
  );
}

/** One jurisdiction's line, as the record prints it at every stage: the shared status words, plus how a paper one went out. */
function jurisdictionRecordLine(j: JurisdictionView, dayText: string): string {
  const status = jurisdictionStatusText(j, dayText);
  if (j.filingMethod !== 'paper' || !j.mailedOn) return status;
  return [status, j.mailingMethod ? MAILING_METHOD_LABEL[j.mailingMethod] : null, j.trackingNumber].filter(Boolean).join(' · ');
}

/** The one control and one sentence of the current step. */
function CurrentControl({ step, detail, actions, contactId, taxEngagementId, after }: {
  step: StepView; detail: Detail; actions: ReturnType<typeof useReturnActions>;
  contactId: string; taxEngagementId: string; after: () => Promise<void>;
}): React.JSX.Element {
  const te = detail.taxEngagement;
  const noMove = (
    <p className="muted small">No legal move to this step from {te.stage.replaceAll('_', ' ')}; a return on hold is resumed from the pipeline.</p>
  );
  switch (step.key) {
    case 'letter':
      return (
        <>
          <p className="small">The client signs the engagement packet in the portal, which stamps every return of theirs; a letter signed on paper is uploaded here.</p>
          <UploadEngagementLetter contactId={contactId} taxEngagementId={taxEngagementId} onUploaded={after} />
        </>
      );
    case 'preparer':
      return (
        <>
          <button type="button" className="btn small accent" data-testid="assign-preparer" onClick={() => void actions.assignPreparer()}>Assign preparer</button>
          <p className="muted small">{CONTROL_SENTENCES.preparer}</p>
        </>
      );
    case 'estimate':
      return (
        <>
          <button type="button" className="btn small accent" onClick={() => void actions.lockEstimate()}>Lock estimate</button>{' '}
          <span className="muted small">Quoted: {actions.rangeText}</span>
          <p className="muted small">{CONTROL_SENTENCES.lock}</p>
        </>
      );
    case 'f8879_sent':
      return (
        <>
          <button type="button" className="btn small accent" data-testid="record-8879-sent" onClick={() => void actions.record8879Sent()}>Record 8879 sent</button>
          <p className="muted small">{CONTROL_SENTENCES.sent8879}</p>
        </>
      );
    case 'f8879_on_file':
      return (
        <>
          {detail.f8879_sent ? <p className="small">{sent8879Line(detail.f8879_sent, formatDate(detail.f8879_sent.sent_on))}. Upload the signed scan when it is back.</p> : null}
          <Upload8879
            contactId={contactId}
            taxEngagementId={taxEngagementId}
            defaultPtin={te.preparer_ptin_holder_id ?? detail.assigned_preparer?.id ?? ''}
            options={detail.staff_options}
            onUploaded={after}
          />
        </>
      );
    case 'final_fee':
      return (
        <>
          <button type="button" className="btn small accent" onClick={() => void actions.setFinalFee()}>Set final fee</button>{' '}
          <span className="muted small">Quoted range: {actions.rangeText}</span>
          <p className="muted small">{CONTROL_SENTENCES.fee}</p>
        </>
      );
    case 'scheduled':
    case 'documents_requested':
    case 'in_preparation':
    case 'internal_review':
    case 'delivered':
    case 'ready_to_file':
    case 'filed':
      return (
        <>
          {step.transitionTo ? (
            <button type="button" className="btn small accent" onClick={() => void actions.transition(step.transitionTo!)}>{stageActionLabel(step.transitionTo)}</button>
          ) : step.waiting ? <p className="small">{step.waiting}</p> : noMove}
          {step.key === 'filed' && !detail.signed_authorization_on_file ? (
            <p className="small" style={{ margin: '6px 0 0' }}><span className="badge warn">No signed authorization on file</span></p>
          ) : null}
          <p className="muted small">
            {step.key === 'delivered'
              ? 'Delivering the return PDF from Deliver a return moves the stage here and puts the copy in the client’s portal; this button moves the stage by hand.'
              : step.key === 'filed' ? CONTROL_SENTENCES.move : `Moves the return to ${step.label.toLowerCase()}.`}
          </p>
        </>
      );
    case 'jurisdictions':
    case 'paid':
    case 'completed':
      return <p className="small">{step.waiting ?? 'Nothing to do here; the step completes on its own.'}</p>;
    default:
      return noMove;
  }
}
