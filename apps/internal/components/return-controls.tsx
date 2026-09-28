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
 * And, since 2026-09-20, three more on the same row:
 *
 *   Assign preparer — names who prepares the return; preparation is refused until somebody is.
 *   Record extension — which form went in and the day it was filed; the extended deadline is
 *                     derived, never typed, and the row then carries it as a badge.
 *   Upload the signed engagement letter — the paper path for gate 1, in the 8879's shape; it
 *                     leaves the row the moment the letter is on the return (the portal signature
 *                     stamps it for everyone who signs there).
 *
 * And, since 2026-09-26, on the FILED row:
 *
 *   Mark filed takes "Filed on" — the calendar day the return went in, opening on today; the route
 *                     refuses a day after today or before the signed 8879, in the modal.
 *   Correct the filing — the filed date, the PTIN holder and the declared jurisdictions of a return
 *                     at filed, appended as a correction with a standalone reason; correcting the
 *                     PTIN holder offers to move the assigned preparer with it (the assign door).
 *                     The client page prints each correction under the row.
 *
 * And, since 2026-09-26 (R53), between delivery and the signed 8879:
 *
 *   Record 8879 sent  — how Form 8879 reached the client (Adobe Sign, in office, mailed) and the
 *                     day; recorded, never sent, by SAOS. The queue reads the return as awaiting
 *                     signature until the signed scan is uploaded.
 *
 * And, since 2026-09-26/27 (R69, R66, R67):
 *
 *   Correct the filing also takes "Signed on" (the day on the signed 8879), "Form" (which 8879 the
 *                     paper is) and "Replace the scan" (a new file, uploaded through /documents; the
 *                     old row is kept and marked superseded). The filed-date rule then reads the
 *                     corrected signed day.
 *   Upload the signed 8879 takes "Form": 8879, 8879-CORP, 8879-PE or 8879-TE, opening on the return
 *                     type's default; the row prints it ("8879-TE on file, signed …").
 *   Reopen the return — on a COMPLETED row, for the CEO alone (engagements.tax.reopen is explicit-only,
 *                     so the wildcard does not show it): a standalone reason; the return goes back to
 *                     filed, the engagement to active, and every jurisdiction needs a new acceptance
 *                     or mailing before it completes again.
 *
 * ONE SET OF ACTIONS, TWO RENDERINGS (R50, 2026-09-26). The modals live in useReturnActions below
 * and are shared by this row and by the stepper (return-stepper.tsx), which renders in its place
 * when OPS_RETURN_STEPPER is on. Neither duplicates the other's logic: the stepper shows the same
 * control on its current step that this row shows in its grid.
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
import { formatDate, todayChicago } from '../lib/dates';
import { TAX_STAGE_LABEL } from '../lib/labels';
import {
  aboveLockedEstimate, addState, canManageReturns, canReopenReturns, changedFilingFields, controlsApply, correctionsApply,
  defaultExtensionForm, defaultF8879Variant, defaultPreparerId, dollarsToCents, extensionBadgeText, f8879OnFileText, filingMethodsFor, jurisdictionLabel,
  jurisdictionSatisfiedText, jurisdictionStatusText, jurisdictionsSentence, mailingControlsApply, mailingsNeeded,
  normaliseJurisdictions, outsideRange, preparerLine, preparerOfferDefault, removeState, reopenApplies, stageActionLabel,
  startingFilingMethods, startingJurisdictions, documentRequestSentence, type DocumentRequestOutcome,
  EXTENSION_FORMS, EXTENSION_FORM_LABEL, F8879_VARIANTS, F8879_VARIANT_LABEL, FEDERAL, FILING_METHODS, FILING_METHOD_LABEL,
  MAILING_METHODS, MAILING_METHOD_LABEL, SCOPE_CREEP_CATEGORIES, SCOPE_CREEP_LABEL,
  type ExtensionForm, type F8879Variant, type FilingAsRecorded, type FilingCorrectionView, type FilingMethod, type JurisdictionView, type MailingMethod, type QuotedRange,
} from '../lib/return-controls';
import { F8879_SENT_METHODS, F8879_SENT_METHOD_LABEL, type ActivityRow, type F8879SentView, type StageHistoryRow } from '../lib/return-stepper';
import { useAsk } from './ask';

export interface Detail {
  taxEngagement: {
    id: string; stage: string; return_type: string; tax_year: number;
    /** The paid preparer of record's name, once filed (or once the 8879 names the holder). */
    preparer_of_record?: string | null;
    payment_status?: string | null;
    estimate_locked_at: string | null;
    estimated_fee_min_cents: number | null; estimated_fee_max_cents: number | null;
    final_fee_cents: number | null;
    preparer_ptin_holder_id: string | null;
    /** Gate 1 on the return (2026-09-20): set by the portal signature or by the uploaded scan. */
    engagement_letter_signed_at: string | null;
    /** The same fact as a calendar day (R50): the day the letter was signed, never shifted by a zone. */
    engagement_letter_signed_on?: string | null;
    /** The extension block (2026-09-20): which form went in, and the deadline it bought. */
    extension_filed: boolean;
    extension_form: string | null;
    extended_deadline: string | null;
    /** The filed day, a calendar day; null until the return is filed (2026-09-26). */
    filed_date: string | null;
    /** The day on the signed 8879, a calendar day; the floor under "Filed on". */
    f8879_signed_on: string | null;
    /** Which Form 8879 the scan is (R66): 8879, 8879-CORP, 8879-PE, 8879-TE; null on a scan filed before the form was named. */
    f8879_variant?: string | null;
    /** R67: set when the CEO reopened this completed return; the row says so until every jurisdiction answers again. */
    reopened_at?: string | null;
    reopen_reason?: string | null;
  };
  /** R53: the 8879 sent for signature, or null. */
  f8879_sent: F8879SentView | null;
  /** R50: the stage history with the actor's name, the step audit rows, the filing's invoice. */
  stageHistory: StageHistoryRow[];
  activity: ActivityRow[];
  final_fee_invoice: { id: string; status: string; total_cents: number; paid_at: string | null; sent_at: string | null } | null;
  filing_corrections?: FilingCorrectionView[];
  quoted_range: QuotedRange | null;
  /** What the address suggests, and what the return already declares (2026-09-19 evening, ruling 2). */
  default_jurisdictions: string[];
  declared_jurisdictions: string[];
  /**
   * PAPER FILING (2026-09-20, ruling 15): each declared jurisdiction with how it was filed and what
   * has answered for it, plus the lane the return's YEAR implies — derived by the API, never here.
   */
  jurisdictions: JurisdictionView[];
  default_filing_method: FilingMethod;
  legal_next_stages: string[];
  signed_authorization_on_file: boolean;
  assigned_preparer: { id: string; name: string } | null;
  /** The firm's only active tax preparer, when there is exactly one (2026-09-20). */
  sole_tax_preparer_id: string | null;
  staff_options: Array<{ id: string; name: string }>;
}

/** One read of the session per page load, shared by every return on the card (and by the stepper). */
let mePromise: Promise<{ permissions: string[] }> | null = null;
export function me(): Promise<{ permissions: string[] }> {
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
  jurisdictions: 'The return completes when every jurisdiction declared here has accepted; federal is always one of them.',
  mailing: 'A paper jurisdiction has no acknowledgment to wait for: the recorded mailing is what completes it.',
  upload: 'This scan is what authorizes the return; the date and the PTIN holder are recorded from it.',
  preparer: 'Names who prepares this return; preparation cannot start until somebody is on it.',
  extension: 'Records an extension that already went in; the extended deadline is derived from the return type, never typed.',
  letter: 'This scan is the signed engagement letter; the return is stamped with the date the client signed it.',
  correction: 'Corrects the filed date, the PTIN holder, the declared jurisdictions, or the signed 8879 (its date, its form, its scan) of this filing; each correction is kept with its reason and printed under the row.',
  sent8879: 'Records that Form 8879 went to the client for signature — through Adobe Sign, across the desk, or by mail — and the day; nothing is sent from here.',
  reopen: 'Takes a completed return back to filed with a reason; the engagement is active again and every jurisdiction needs a new acceptance or mailing before it completes.',
} as const;

export interface ReturnControlsProps {
  taxEngagementId: string;
  /** The client the return belongs to — the signed 8879 upload files under them. */
  contactId: string;
  stage: string;
  /** The card re-reads the return list so the stage badge and the amount follow the change. */
  onChanged: () => Promise<void> | void;
}

/**
 * THE ACTIONS ON A RETURN, ONE SET (R50). Every modal the row offers — lock the estimate, set the fee,
 * assign the preparer, record the extension, move the stage, mark filed, correct the filing, record a
 * mailing, and (R53) record the 8879 sent — as functions, built from the detail the caller already
 * read. The row below and the stepper call the same functions, so the two renderings cannot drift.
 * `after` is what runs once a modal commits: the caller re-reads the return and tells the card.
 */
export function useReturnActions({ taxEngagementId, contactId, stage, detail, after }: {
  taxEngagementId: string; contactId: string; stage: string; detail: Detail; after: () => Promise<void>;
}) {
  const ask = useAsk();
  const te = detail.taxEngagement;
  const range = detail.quoted_range;
  const rangeText = range
    ? `${range.min_cents === range.max_cents ? formatMoney(range.min_cents) : `${formatMoney(range.min_cents)}–${formatMoney(range.max_cents)}`} (price book v${range.price_book_version})`
    : 'no quoted range on file';

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
    const draft = { amount: te.final_fee_cents !== null ? centsToDollars(te.final_fee_cents) : '', category: '' };
    const a = await ask({
      title: 'Set the final fee',
      body: <FinalFeeFields draft={draft} range={range} rangeText={rangeText} te={te} />,
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
          body: {
            finalFeeCents,
            ...(r.reason ? { reason: r.reason } : {}),
            // Only ever what the person chose. The route refuses the missing category in its own
            // words, beside the field, and nothing here fills it in for them.
            ...(draft.category ? { scopeCreepReason: draft.category } : {}),
          },
        });
      },
    });
    if (!a) return;
    await after();
  };

  /*
   * WHO PREPARES THIS RETURN (Brian, 2026-09-20). The select offers the active tax preparers and
   * the CEO — the same list the PTIN-holder select reads — and opens on whoever is already
   * assigned, else the firm's only preparer when there is exactly one. The route refuses an
   * inactive or wrong-role choice in its own words, in the modal, beside the field.
   */
  const assignPreparer = async () => {
    const draft = { staffId: defaultPreparerId(detail) };
    const a = await ask({
      title: 'Assign preparer',
      body: <PreparerField draft={draft} options={detail.staff_options} assigned={detail.assigned_preparer} />,
      choices: [{ key: 'assign', label: 'Assign preparer', tone: 'primary' }],
      run: async () => {
        if (!draft.staffId) throw new Error('Choose who prepares this return.');
        await api(`/tax-engagements/${taxEngagementId}/preparer`, { method: 'POST', body: { staffId: draft.staffId } });
      },
    });
    if (!a) return;
    await after();
  };

  /*
   * THE EXTENSION THAT ALREADY WENT IN (Brian, 2026-09-20). Two answers: which form, and the day it
   * was filed. No deadline is typed — the route derives the extended deadline from the return type
   * and the fiscal year end, and the row then shows it.
   */
  const recordExtension = async () => {
    const draft: { form: string; filedOn: string } = { form: defaultExtensionForm(te.return_type), filedOn: '' };
    const a = await ask({
      title: 'Record extension',
      body: <ExtensionFields draft={draft} returnType={te.return_type} />,
      choices: [{ key: 'record', label: 'Record extension', tone: 'primary' }],
      run: async () => {
        if (!draft.filedOn) throw new Error('Say the date the extension was filed.');
        await api(`/tax-engagements/${taxEngagementId}/extension/filed`, {
          method: 'POST',
          body: { form: draft.form, filedOn: draft.filedOn },
        });
      },
    });
    if (!a) return;
    await after();
  };

  const transition = async (toStage: string) => {
    const label = stageActionLabel(toStage);
    if (toStage !== 'filed') {
      let outcome: DocumentRequestOutcome | undefined;
      const a = await ask({
        title: `${label}?`,
        body: toStage === 'documents_requested' ? (
          <p>
            Moves this return from {stageLabel(stage)} to {stageLabel(toStage)}, and emails the client the items still missing
            from the return&apos;s document checklist (held while the &quot;Request documents&quot; automation is off).
          </p>
        ) : <p>Moves this return from {stageLabel(stage)} to {stageLabel(toStage)}.</p>,
        choices: [{ key: 'go', label, tone: 'primary' }],
        run: async () => {
          const r = await api<{ documentRequest?: DocumentRequestOutcome }>(`/tax-engagements/${taxEngagementId}/transition`, { method: 'POST', body: { toStage } });
          outcome = r.documentRequest;
        },
      });
      if (!a) return;
      await after();
      // R83: say what the press did with the email, sent or held, once. A return with no checklist (opened by
      // hand, not from a quote) has nothing to send and nothing to report: the stage move is the whole answer.
      if (outcome && !(!outcome.emailed && outcome.reason === 'no_checklist')) {
        await ask({
          title: 'Documents requested',
          body: <p data-testid="documents-request-outcome">{documentRequestSentence(outcome)}</p>,
          choices: [{ key: 'ok', label: 'OK', tone: 'primary' }],
        });
      }
      return;
    }
    // The PTIN holder: set once at filing; the default is the assigned preparer. The jurisdictions:
    // what the return already declares, else what the address suggests — the preparer edits either.
    // The methods: each jurisdiction's lane, opening on what the YEAR implies (ruling 15).
    const starting = startingJurisdictions(detail);
    // FILED ON (2026-09-26): today in Chicago, or the day already on a return being re-filed — the
    // route holds the rules (not after today, not before the signed 8879) and says so in the modal.
    const draft = {
      ptin: te.preparer_ptin_holder_id ?? detail.assigned_preparer?.id ?? '',
      jurisdictions: starting,
      methods: startingFilingMethods(detail, starting),
      filedOn: te.filed_date ?? todayChicago(),
    };
    const a = await ask({
      title: 'Mark filed',
      body: (
        <FiledFields
          draft={draft}
          options={detail.staff_options}
          signed={detail.signed_authorization_on_file}
          signedOn={te.f8879_signed_on}
          refiledFrom={te.filed_date}
          feeCents={te.final_fee_cents}
          defaultMethod={detail.default_filing_method}
        />
      ),
      choices: [{ key: 'file', label: 'Mark filed', tone: 'primary' }],
      run: async () => {
        if (!draft.ptin) throw new Error('Say whose PTIN is on this filing (the paid preparer of record).');
        if (!draft.filedOn) throw new Error('Say the day the return was filed.');
        const jurisdictions = normaliseJurisdictions(draft.jurisdictions);
        await api(`/tax-engagements/${taxEngagementId}/transition`, {
          method: 'POST',
          body: {
            toStage: 'filed',
            preparerPtinHolderId: draft.ptin,
            jurisdictions,
            filingMethods: filingMethodsFor(jurisdictions, draft.methods, detail.default_filing_method),
            filedOn: draft.filedOn,
          },
        });
      },
    });
    if (!a) return;
    await after();
  };

  /*
   * THE FILING, CORRECTED (Brian, 2026-09-26). One modal for the three facts the filing recorded:
   * the day, the PTIN holder, the jurisdictions. It opens on the filing as recorded; only what the
   * person changes is sent, with one standalone reason, and the route appends the correction and
   * moves the return to it. Every refusal — a day after today or before the signed 8879, a
   * jurisdiction that has already answered, nothing changed — renders in the modal in the route's
   * words. Correcting the PTIN holder offers to move the assigned preparer with it, through the
   * assign door; the offer opens checked when the two were the same person.
   */
  const correctFiling = async () => {
    const current: FilingAsRecorded = {
      filedOn: te.filed_date ?? '',
      ptin: te.preparer_ptin_holder_id ?? '',
      jurisdictions: normaliseJurisdictions(detail.declared_jurisdictions),
      f8879SignedOn: te.f8879_signed_on ?? '',
      f8879Variant: te.f8879_variant ?? '',
    };
    const draft: FilingAsRecorded & { alsoAssign: boolean; scan: File | null } = {
      ...current,
      jurisdictions: [...current.jurisdictions],
      alsoAssign: preparerOfferDefault(te.preparer_ptin_holder_id, detail.assigned_preparer?.id),
      scan: null,
    };
    const a = await ask({
      title: 'Correct the filing',
      body: (
        <CorrectionFields
          draft={draft}
          current={current}
          options={detail.staff_options}
          assigned={detail.assigned_preparer}
          signedOn={te.f8879_signed_on}
          rows={detail.jurisdictions}
          defaultMethod={detail.default_filing_method}
        />
      ),
      reason: {
        label: 'Reason',
        required: true,
        placeholder: 'Say what the filing recorded wrongly and what is right, for whoever reads this next.',
      },
      choices: [{ key: 'correct', label: 'Correct the filing', tone: 'primary' }],
      run: async (r) => {
        const changed = changedFilingFields(current, draft);
        /*
         * THE REPLACEMENT SCAN (R69, amended): through /documents under Signed Authorizations against
         * this return — the same door the row's upload uses — with no signed date on it, so nothing
         * stamps the return; the correction below is what makes it the 8879 on file and marks the
         * previous scan superseded.
         */
        let f8879DocumentId: string | undefined;
        if (draft.scan) {
          const fd = new FormData();
          fd.append('contactId', contactId);
          fd.append('category', 'signed_authorizations');
          fd.append('taxEngagementId', taxEngagementId);
          fd.append('file', draft.scan, draft.scan.name);
          const doc = await api<{ id: string }>('/documents', { method: 'POST', formData: fd });
          f8879DocumentId = doc.id;
        }
        await api(`/tax-engagements/${taxEngagementId}/filing-corrections`, {
          method: 'POST',
          body: {
            ...changed,
            ...(f8879DocumentId ? { f8879DocumentId } : {}),
            ...(changed.preparerPtinHolderId && draft.alsoAssign ? { alsoAssignPreparer: true } : {}),
            reason: r.reason,
          },
        });
      },
    });
    if (!a) return;
    await after();
  };

  /*
   * REOPEN A COMPLETED RETURN (Brian, 2026-09-26, R67). One reason, standalone; the route holds the
   * rules (completed only, the CEO alone) and its words render in the modal. The return goes back to
   * filed and the engagement to active; the row then reads "Reopened" until every jurisdiction has
   * answered again.
   */
  const reopenReturn = async () => {
    if (!(await askReopen(ask, { taxEngagementId, taxYear: te.tax_year, returnType: te.return_type }))) return;
    await after();
  };

  /*
   * THE PAPER LANE'S ACCEPTANCE (Brian, 2026-09-20, ruling 15). One control per declared paper
   * jurisdiction that has no mailing yet: the day it went out, how it went, the tracking number when
   * there is one, and the receipt scan when there is one. The scan goes through /documents under
   * mailing_receipts — the same door every document uses — and the mailing route then carries its id.
   * The route refuses a future date, an e-file jurisdiction and a second mailing in its own words,
   * beside the field.
   */
  const recordMailing = async (jurisdiction: string) => {
    const draft: { mailedOn: string; method: MailingMethod; tracking: string; file: File | null } = {
      mailedOn: '', method: 'certified', tracking: '', file: null,
    };
    const a = await ask({
      title: `Record mailing — ${jurisdictionLabel(jurisdiction)}`,
      body: <MailingFields draft={draft} jurisdiction={jurisdiction} />,
      choices: [{ key: 'record', label: 'Record mailing', tone: 'primary' }],
      run: async () => {
        if (!draft.mailedOn) throw new Error('Say the day this went in the mail.');
        let receiptDocumentId: string | undefined;
        if (draft.file) {
          const fd = new FormData();
          fd.append('contactId', contactId);
          fd.append('category', 'mailing_receipts');
          fd.append('taxEngagementId', taxEngagementId);
          fd.append('file', draft.file, draft.file.name);
          const doc = await api<{ id: string }>('/documents', { method: 'POST', formData: fd });
          receiptDocumentId = doc.id;
        }
        await api(`/tax-engagements/${taxEngagementId}/jurisdictions/${jurisdiction}/mailing`, {
          method: 'POST',
          body: {
            mailedOn: draft.mailedOn,
            method: draft.method,
            ...(draft.tracking.trim() ? { trackingNumber: draft.tracking.trim() } : {}),
            ...(receiptDocumentId ? { receiptDocumentId } : {}),
          },
        });
      },
    });
    if (!a) return;
    await after();
  };


  /*
   * RECORD 8879 SENT (Brian, 2026-09-26, R53). Two answers: how the form reached the client and the
   * day, opening on today. The route holds the rules — delivered or later, no signed 8879 on file yet,
   * not after today — and its words render in the modal beside the field. Nothing is sent from here:
   * the Adobe Sign envelope, the envelope in the mail and the paper across the desk all happen
   * outside SAOS, and this records that one of them did.
   */
  const record8879Sent = async () => {
    const draft: { method: string; sentOn: string } = { method: detail.f8879_sent?.method ?? 'adobe_sign', sentOn: detail.f8879_sent?.sent_on ?? todayChicago() };
    const a = await ask({
      title: 'Record 8879 sent',
      body: <Sent8879Fields draft={draft} current={detail.f8879_sent} />,
      choices: [{ key: 'record', label: 'Record 8879 sent', tone: 'primary' }],
      run: async () => {
        if (!draft.method) throw new Error('Say how the 8879 reached the client.');
        if (!draft.sentOn) throw new Error('Say the day it was sent or handed over.');
        await api(`/tax-engagements/${taxEngagementId}/8879-sent`, { method: 'POST', body: { method: draft.method, sentOn: draft.sentOn } });
      },
    });
    if (!a) return;
    await after();
  };

  return { lockEstimate, setFinalFee, assignPreparer, recordExtension, transition, correctFiling, recordMailing, record8879Sent, reopenReturn, rangeText, range, te };
}

/** The Reopen modal (R67): one reason, the route's words on a refusal. Returns whether the return was reopened. */
async function askReopen(
  ask: ReturnType<typeof useAsk>,
  te: { taxEngagementId: string; taxYear: number; returnType: string }
): Promise<boolean> {
  const a = await ask({
    title: 'Reopen this return',
    body: (
      <p className="small">
        {te.taxYear} {te.returnType.toUpperCase()} goes back to filed and its engagement to active. The acceptance or mailing
        that completed it no longer counts: every jurisdiction needs a new one before the return completes again.
      </p>
    ),
    reason: {
      label: 'Reason',
      required: true,
      placeholder: 'Say why the completion is in doubt and what must happen now, for whoever reads this next.',
    },
    choices: [{ key: 'reopen', label: 'Reopen the return', tone: 'primary' }],
    run: async (r) => {
      await api(`/tax-engagements/${te.taxEngagementId}/reopen`, { method: 'POST', body: { reason: r.reason } });
    },
  });
  return Boolean(a);
}

/*
 * THE ONE CONTROL ON A COMPLETED ROW (R67), standalone: it reads the session itself and renders
 * nothing without engagements.tax.reopen by name. The row grid uses it, and so does the client page
 * beside the stepper (R50, when OPS_RETURN_STEPPER is on): the stepper's Close step is the other
 * component's to draw, but the door is this one, and a completed return must offer it whichever
 * rendering is on. `taxYear` and `returnType` come from the row the caller already has, so no read.
 */
export function ReopenReturnControl({ taxEngagementId, taxYear, returnType, onChanged }: {
  taxEngagementId: string; taxYear: number; returnType: string; onChanged: () => Promise<void> | void;
}): React.JSX.Element | null {
  const ask = useAsk();
  const [canReopen, setCanReopen] = useState(false);
  useEffect(() => {
    let alive = true;
    me().then((m) => { if (alive) setCanReopen(canReopenReturns(m.permissions)); }).catch(() => { if (alive) setCanReopen(false); });
    return () => { alive = false; };
  }, []);
  if (!canReopen) return null;
  return (
    <div style={{ flex: '1 1 100%' }}>
      <button
        type="button"
        className="btn small ghost"
        data-testid="reopen-return"
        onClick={() => void (async () => { if (await askReopen(ask, { taxEngagementId, taxYear, returnType })) await onChanged(); })()}
      >
        Reopen…
      </button>
      <p className="muted small">{CONTROL_SENTENCES.reopen}</p>
    </div>
  );
}

/** A reopened return says so, with the reason, until every jurisdiction has answered again (R67). */
export function ReopenedNotice({ reason }: { reason: string | null | undefined }): React.JSX.Element {
  return (
    <p className="small" style={{ flex: '1 1 100%', gridColumn: '1 / -1', margin: 0 }} data-testid="reopened-notice">
      <span className="badge warn">Reopened</span>{' '}
      <span className="muted small">needs a new acceptance or mailing on every jurisdiction{reason ? `: ${reason}` : ''}</span>
    </p>
  );
}

export function ReturnControls({ taxEngagementId, contactId, stage, onChanged }: ReturnControlsProps): React.JSX.Element | null {
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const [canReopen, setCanReopen] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  /*
   * THREE SETS OF CONTROLS, THREE WINDOWS. The pre-filing controls stop at filing, as they always
   * have (2026-09-20, ruling 15). The Record mailing control STARTS there: a jurisdiction is declared
   * at filing, so a paper one can only be recorded as mailed afterwards. And Reopen (R67) belongs to
   * the COMPLETED row alone, for the session that holds engagements.tax.reopen by name. `applies` is any.
   */
  const preFiled = controlsApply(stage);
  // R86: a completed return is correctable too, for any session that manages returns.
  const applies = preFiled || mailingControlsApply(stage) || correctionsApply(stage) || (canReopen && reopenApplies(stage));

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
      .then((m) => { if (alive) { setCanManage(canManageReturns(m.permissions)); setCanReopen(canReopenReturns(m.permissions)); } })
      .catch(() => { if (alive) { setCanManage(false); setCanReopen(false); } });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (canManage && applies) void load();
  }, [canManage, applies, load, stage]);

  if (!canManage || !applies) return null;
  if (!detail) return err ? <p className="field-error" role="alert">{err}</p> : null;
  return <ReturnControlsRow taxEngagementId={taxEngagementId} contactId={contactId} stage={stage} detail={detail} preFiled={preFiled} canReopen={canReopen} err={err} after={async () => { await load(); await onChanged(); }} />;
}

/** The row as production renders it: the grid of controls, from the shared actions. */
function ReturnControlsRow({ taxEngagementId, contactId, stage, detail, preFiled, canReopen, err, after }: {
  taxEngagementId: string; contactId: string; stage: string; detail: Detail; preFiled: boolean; canReopen: boolean; err: string; after: () => Promise<void>;
}): React.JSX.Element {
  const { lockEstimate, setFinalFee, assignPreparer, recordExtension, transition, correctFiling, recordMailing, record8879Sent, reopenReturn, rangeText, te } =
    useReturnActions({ taxEngagementId, contactId, stage, detail, after });
  return (
    <div style={{ flex: '1 1 100%', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 8 }}>
      {preFiled ? (
      <>
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
      <div>
        <button type="button" className="btn small ghost" data-testid="assign-preparer" onClick={() => void assignPreparer()}>Assign preparer</button>{' '}
        <span className={detail.assigned_preparer ? 'muted small' : 'badge warn'}>{preparerLine(detail.assigned_preparer)}</span>
        <p className="muted small">{CONTROL_SENTENCES.preparer}</p>
      </div>
      <div>
        {te.extension_filed ? (
          <span className="badge warn">
            {extensionBadgeText(te.extension_form, te.extended_deadline ? formatDate(te.extended_deadline) : '')}
          </span>
        ) : (
          <button type="button" className="btn small ghost" data-testid="record-extension" onClick={() => void recordExtension()}>Record extension</button>
        )}
        <p className="muted small">{CONTROL_SENTENCES.extension}</p>
      </div>
      {te.engagement_letter_signed_at ? null : (
        <UploadEngagementLetter
          contactId={contactId}
          taxEngagementId={taxEngagementId}
          onUploaded={after}
        />
      )}
      {/* R53: the 8879 out for signature, between delivery and the signed scan. */}
      {sent8879Applies(stage, detail.signed_authorization_on_file) ? (
        <div>
          <button type="button" className="btn small ghost" data-testid="record-8879-sent" onClick={() => void record8879Sent()}>Record 8879 sent</button>{' '}
          {detail.f8879_sent ? <span className="muted small">{sent8879Line(detail.f8879_sent, formatDate(detail.f8879_sent.sent_on))}</span> : <span className="badge warn">Not yet sent for signature</span>}
          <p className="muted small">{CONTROL_SENTENCES.sent8879}</p>
        </div>
      ) : null}
      {detail.signed_authorization_on_file ? null : (
        <Upload8879
          contactId={contactId}
          taxEngagementId={taxEngagementId}
          defaultPtin={te.preparer_ptin_holder_id ?? detail.assigned_preparer?.id ?? ''}
          options={detail.staff_options}
          returnType={te.return_type}
          onUploaded={after}
        />
      )}
      </>
      ) : null}
      {/* R67: a reopened return says so until every jurisdiction has answered again. */}
      {te.reopened_at && stage === 'filed' ? <ReopenedNotice reason={te.reopen_reason} /> : null}
      {/*
        * WHERE THIS RETURN STANDS, JURISDICTION BY JURISDICTION (ruling 15). A paper one reads
        * "Mailed <date>" and never "Accepted": there is no acknowledgment coming for it. Each paper
        * jurisdiction with no mailing yet carries its own Record mailing control, because that is
        * what the return is waiting on.
        */}
      {detail.jurisdictions.length > 0 ? (
        <div style={{ gridColumn: '1 / -1' }} data-testid="jurisdiction-status">
          <ul style={{ listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 10, padding: 0, margin: '0 0 6px' }}>
            {detail.jurisdictions.map((j) => (
              <li key={j.jurisdiction}>
                <span className="badge">{jurisdictionLabel(j.jurisdiction)}</span>{' '}
                <span className="muted small">
                  {jurisdictionStatusText(j, j.filingMethod === 'paper' ? (j.mailedOn ? formatDate(j.mailedOn) : '') : (j.acceptedOn ? formatDate(j.acceptedOn) : ''))}
                </span>
              </li>
            ))}
          </ul>
          {mailingsNeeded(detail.jurisdictions).map((j) => (
            <span key={j.jurisdiction} style={{ marginRight: 8 }}>
              <button
                type="button"
                className="btn small accent"
                data-testid={`record-mailing-${j.jurisdiction}`}
                onClick={() => void recordMailing(j.jurisdiction)}
              >
                Record mailing — {jurisdictionLabel(j.jurisdiction)}
              </button>
            </span>
          ))}
          {detail.jurisdictions.some((j) => j.filingMethod === 'paper') ? <p className="muted small">{CONTROL_SENTENCES.mailing}</p> : null}
        </div>
      ) : null}
      {correctionsApply(stage) ? (
        <div style={{ gridColumn: '1 / -1' }}>
          <button type="button" className="btn small ghost" data-testid="correct-filing" onClick={() => void correctFiling()}>Correct the filing</button>
          <p className="muted small">{CONTROL_SENTENCES.correction}</p>
        </div>
      ) : null}
      {canReopen && reopenApplies(stage) ? (
        <div style={{ gridColumn: '1 / -1' }}>
          <button type="button" className="btn small ghost" data-testid="reopen-return" onClick={() => void reopenReturn()}>Reopen…</button>
          <p className="muted small">{CONTROL_SENTENCES.reopen}</p>
        </div>
      ) : null}
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
export function Upload8879({ contactId, taxEngagementId, defaultPtin, options, returnType, onUploaded }: {
  contactId: string; taxEngagementId: string; defaultPtin: string;
  options: Array<{ id: string; name: string }>;
  /** R66: the return type the scan authorizes; the Form select opens on its default (8879-TE for a 990). */
  returnType?: string | null;
  onUploaded: () => Promise<void>;
}): React.JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [signedOn, setSignedOn] = useState('');
  const [ptin, setPtin] = useState(defaultPtin);
  const [variant, setVariant] = useState<F8879Variant>(defaultF8879Variant(returnType));
  /*
   * A CALLER THAT DID NOT SAY THE RETURN TYPE (the stepper's call predates the prop): the form is read
   * from the return once, so the select still opens on the right 8879 — a 990's is the 8879-TE — rather
   * than on the individual form by silence. A caller that passes it costs nothing.
   */
  useEffect(() => {
    if (returnType) return;
    let alive = true;
    api<{ taxEngagement: { return_type: string } }>(`/tax-engagements/${taxEngagementId}`)
      .then((d) => { if (alive) setVariant(defaultF8879Variant(d.taxEngagement.return_type)); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [returnType, taxEngagementId]);
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
      fd.append('f8879Variant', variant);
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
    <div style={{ gridColumn: '1 / -1' }} data-testid="upload-8879-form">
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, alignItems: 'end' }}>
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
      {/* WHICH 8879 (R66): opens on the return type's default; the person can say the other one. */}
      <label className="field" data-testid="f8879-variant">
        Form
        <select value={variant} onChange={(e) => setVariant(e.target.value as F8879Variant)}>
          {F8879_VARIANTS.map((v) => <option key={v} value={v}>{F8879_VARIANT_LABEL[v]}</option>)}
        </select>
      </label>
    </div>
      {/* THE BUTTON BENEATH THE FIELDS (R50): one grouped form, read top to bottom, on the phone and the desk alike. */}
      <div style={{ marginTop: 4 }}>
        <button type="button" className="btn small ghost" data-testid="upload-signed-8879" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Uploading…' : 'Upload the signed 8879'}
        </button>
        <p className="muted small">{CONTROL_SENTENCES.upload}</p>
      </div>
    </div>
  );
}

/** The Record 8879 sent control shows once the return is delivered and until the signed scan is on file. */
export function sent8879Applies(stage: string, signedOnFile: boolean): boolean {
  return !signedOnFile && (stage === 'client_review' || stage === 'ready_to_file');
}

/** "Sent Sep 26, 2026 · Adobe Sign · recorded by Ana" — the day arrives formatted (no formatter here). */
export function sent8879Line(sent: F8879SentView, dayText: string): string {
  const how = sent.method ? F8879_SENT_METHOD_LABEL[sent.method] : 'method not recorded';
  const who = sent.declared_by_import ? 'declared by the Trello import' : sent.recorded_by_name ? `recorded by ${sent.recorded_by_name}` : '';
  return [`Sent ${dayText}`, how, who].filter(Boolean).join(' \u00b7 ');
}

/** The Record 8879 sent modal: how it reached the client, and the day (opening on today). */
function Sent8879Fields({ draft, current }: { draft: { method: string; sentOn: string }; current: F8879SentView | null }): React.JSX.Element {
  const [method, setMethod] = useState(draft.method);
  const [sentOn, setSentOn] = useState(draft.sentOn);
  return (
    <>
      <p className="small">
        {current
          ? `Recorded as sent ${formatDate(current.sent_on)}${current.method ? ` (${F8879_SENT_METHOD_LABEL[current.method]})` : ''}; recording again replaces it.`
          : 'The client signs Form 8879 outside SAOS — through Adobe Sign, across the desk, or by mail. Say which, and when it went out; the preparer queue then reads this return as awaiting signature.'}
      </p>
      <label className="field" data-testid="sent-8879-method">
        Method
        <select value={method} onChange={(e) => { setMethod(e.target.value); draft.method = e.target.value; }}>
          {F8879_SENT_METHODS.map((m) => <option key={m} value={m}>{F8879_SENT_METHOD_LABEL[m]}</option>)}
        </select>
      </label>
      <label className="field">
        Date sent
        <input type="date" value={sentOn} onChange={(e) => { setSentOn(e.target.value); draft.sentOn = e.target.value; }} />
      </label>
      <p className="muted small">Never after today. Nothing is sent from SAOS; this records that it went.</p>
    </>
  );
}

/*
 * THE ENGAGEMENT LETTER SIGNED ON PAPER, FROM THE RETURN'S ROW (Brian, 2026-09-20).
 *
 * The client who signs the packet in the portal stamps every return that signature covers. The
 * client who signs across the desk has a scan, and until now the only writer that could stamp the
 * return was a staff-only route on no screen — a compliance gate closed by a curl. This is that
 * screen, in the 8879's shape: one multipart POST to /documents under Signed Authorizations, and
 * THE UPLOAD is what stamps gate 1. A refusal — a future date, a date before the tax year closed,
 * a wrong category — renders beside the date in the server's words, and the fields keep what was
 * typed. The control leaves the moment the letter is on the return.
 *
 * THE DATE LABEL IS "Date signed", not "Signed on": the 8879 door's "Signed on" is what the browser
 * walk taps by label, and a second control whose label contains those words would make that tap
 * ambiguous. One date field, one name each.
 */
export function UploadEngagementLetter({ contactId, taxEngagementId, onUploaded }: {
  contactId: string; taxEngagementId: string; onUploaded: () => Promise<void>;
}): React.JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [signedOn, setSignedOn] = useState('');
  const [uploadErr, setUploadErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!file) { setUploadErr('Choose the scanned, signed engagement letter first.'); return; }
    if (!signedOn) { setUploadErr('Say the date the client signed it.'); return; }
    setBusy(true);
    setUploadErr('');
    try {
      const fd = new FormData();
      fd.append('contactId', contactId);
      fd.append('category', 'signed_authorizations');
      fd.append('taxEngagementId', taxEngagementId);
      fd.append('engagementLetterSignedOn', signedOn);
      fd.append('file', file, file.name);
      await api<{ signedEngagementLetter: boolean }>('/documents', { method: 'POST', formData: fd });
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
        Signed engagement letter (scan)
        <input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <label className="field">
        Date signed
        <input type="date" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} aria-invalid={uploadErr ? true : undefined} />
        {uploadErr ? <p className="field-error" role="alert">{uploadErr}</p> : null}
      </label>
      <div>
        <button type="button" className="btn small ghost" data-testid="upload-engagement-letter" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Uploading…' : 'Upload the signed engagement letter'}
        </button>
        <p className="muted small">{CONTROL_SENTENCES.letter}</p>
      </div>
    </div>
  );
}

/** The Assign preparer modal: the eligible staff, opening on whoever the return should already have. */
function PreparerField({ draft, options, assigned }: {
  draft: { staffId: string };
  options: Array<{ id: string; name: string }>;
  assigned: { id: string; name: string } | null;
}): React.JSX.Element {
  const [id, setId] = useState(draft.staffId);
  return (
    <>
      <p className="small">{preparerLine(assigned)}. The return appears in the preparer&apos;s queue and their My Tasks.</p>
      <label className="field" data-testid="preparer-select">
        Preparer
        <select value={id} onChange={(e) => { setId(e.target.value); draft.staffId = e.target.value; }}>
          <option value="">Choose…</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
    </>
  );
}

/** The Record extension modal: which form went in, and the day it was filed. No deadline is typed. */
function ExtensionFields({ draft, returnType }: {
  draft: { form: string; filedOn: string };
  returnType: string;
}): React.JSX.Element {
  const [form, setForm] = useState(draft.form);
  const [filedOn, setFiledOn] = useState(draft.filedOn);
  return (
    <>
      <p className="small">
        A {returnType.toUpperCase()} extends on {EXTENSION_FORM_LABEL[defaultExtensionForm(returnType)]} — change it if a different form went in.
      </p>
      <label className="field" data-testid="extension-form">
        Extension form
        <select value={form} onChange={(e) => { setForm(e.target.value); draft.form = e.target.value; }}>
          {EXTENSION_FORMS.map((f: ExtensionForm) => <option key={f} value={f}>{EXTENSION_FORM_LABEL[f]}</option>)}
        </select>
      </label>
      <label className="field">
        Date filed
        <input type="date" value={filedOn} onChange={(e) => { setFiledOn(e.target.value); draft.filedOn = e.target.value; }} />
      </label>
      <p className="muted small">The extended deadline follows from the return type and the fiscal year end; it is never typed here.</p>
    </>
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

/*
 * ONE MODAL, ONE REASON, AND THE CATEGORY (Brian, 2026-09-19 evening, ruling 1).
 *
 * The amount is read against the quoted range as it is typed. Above the LOCKED estimate's top the
 * scope-creep category select appears beside the same reason textarea the ask modal already owns —
 * one modal, two answers, no second screen. The select opens on "Choose…" and is never preselected:
 * the build this replaces stored every overrun as 'other', which is the same as storing nothing.
 * The route is what refuses a missing answer, so its words are what the person reads.
 */
function FinalFeeFields({ draft, range, rangeText, te }: {
  draft: { amount: string; category: string };
  range: QuotedRange | null;
  rangeText: string;
  te: { estimated_fee_max_cents: number | null };
}): React.JSX.Element {
  const [text, setText] = useState(draft.amount);
  const [category, setCategory] = useState(draft.category);
  const cents = dollarsToCents(text);
  const outside = cents !== null && outsideRange(cents, range);
  const overLock = cents !== null && aboveLockedEstimate(cents, te);
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
      {overLock ? (
        <>
          <label className="field" data-testid="scope-creep-category">
            Scope-creep category
            <select value={category} onChange={(e) => { setCategory(e.target.value); draft.category = e.target.value; }}>
              <option value="">Choose…</option>
              {SCOPE_CREEP_CATEGORIES.map((c) => <option key={c} value={c}>{SCOPE_CREEP_LABEL[c]}</option>)}
            </select>
          </label>
          <p className="small" style={{ color: 'var(--danger)' }}>
            Above the locked estimate — choose the category and say why below. Both are required.
          </p>
        </>
      ) : null}
    </>
  );
}

function FiledFields({ draft, options, signed, signedOn, refiledFrom, feeCents, defaultMethod }: {
  draft: { ptin: string; jurisdictions: string[]; methods: Record<string, FilingMethod>; filedOn: string };
  options: Array<{ id: string; name: string }>;
  signed: boolean;
  /** The day on the signed 8879, a calendar day — the floor the route holds "Filed on" to. */
  signedOn: string | null;
  /** The day already on a return being re-filed after a rejection; a re-file keeps it. */
  refiledFrom: string | null;
  feeCents: number | null;
  defaultMethod: FilingMethod;
}): React.JSX.Element {
  const [filedOn, setFiledOn] = useState(draft.filedOn);
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
      {/*
        * FILED ON (2026-09-26): the calendar day the return went in, opening on today. No min or max
        * on the control — the route holds the two rules and its words render below on a refusal.
        */}
      <label className="field">
        Filed on
        <input type="date" value={filedOn} onChange={(e) => { setFiledOn(e.target.value); draft.filedOn = e.target.value; }} />
      </label>
      <p className="muted small">
        {refiledFrom
          ? `First filed ${formatDate(refiledFrom)}; a re-file keeps that day. Correct the filing afterwards if the day is wrong.`
          : signedOn
            ? `Today unless it went in earlier; never after today and never before the signed 8879 (${formatDate(signedOn)}).`
            : 'Today unless it went in earlier; never after today.'}
      </p>
      <label className="field">
        PTIN holder (the paid preparer of record)
        <select defaultValue={draft.ptin} onChange={(e) => { draft.ptin = e.target.value; }}>
          <option value="">Choose…</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      <JurisdictionList draft={draft} defaultMethod={defaultMethod} />
    </>
  );
}

/*
 * WHERE THIS RETURN WENT (Brian, 2026-09-19 evening, ruling 2). Not derived from the client's
 * address afterwards — declared here, by the person filing, at the moment of filing. Federal is on
 * the list and stays on it; the states start from the entity's (else the contact's) state, with a
 * no-income-tax state starting at none, and the preparer adds or removes before filing. Completion
 * then waits on every one of them.
 */
function JurisdictionList({ draft, defaultMethod }: {
  draft: { jurisdictions: string[]; methods: Record<string, FilingMethod> };
  defaultMethod: FilingMethod;
}): React.JSX.Element {
  const [list, setList] = useState<string[]>(normaliseJurisdictions(draft.jurisdictions));
  const [methods, setMethods] = useState<Record<string, FilingMethod>>(
    filingMethodsFor(draft.jurisdictions, draft.methods, defaultMethod)
  );
  const [typed, setTyped] = useState('');
  const [listErr, setListErr] = useState('');
  const commit = (next: string[]) => {
    // The methods follow the list: a state added takes the year's lane, a state removed takes its
    // method with it, so nothing is filed with a method for a jurisdiction it does not declare.
    const nextMethods = filingMethodsFor(next, methods, defaultMethod);
    draft.jurisdictions = next;
    draft.methods = nextMethods;
    setList(next);
    setMethods(nextMethods);
  };
  const setMethod = (jurisdiction: string, method: FilingMethod) => {
    const next = { ...methods, [jurisdiction]: method };
    draft.methods = next;
    setMethods(next);
  };
  const add = () => {
    const r = addState(list, typed);
    setListErr(r.error);
    if (r.error) return;
    commit(r.list);
    setTyped('');
  };
  return (
    <fieldset className="field" data-testid="filed-jurisdictions" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="small">Jurisdictions filed</legend>
      <p className="muted small">{jurisdictionsSentence(list)}</p>
      <ul style={{ listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 6, padding: 0, margin: '0 0 6px' }}>
        {list.map((j) => (
          <li key={j}>
            <span className="badge">{j === FEDERAL ? 'Federal' : j}</span>{' '}
            {/*
              * HOW THIS ONE WENT OUT (ruling 15). Opens on the lane the return's YEAR implies — an old
              * year is paper, because that is the only lane it has — and the preparer changes it per
              * jurisdiction, which is what a mixed filing needs: e-file to the IRS, paper to a state.
              */}
            <select
              data-testid={`filing-method-${j}`}
              aria-label={`Filing method — ${j === FEDERAL ? 'Federal' : j}`}
              value={methods[j] ?? defaultMethod}
              onChange={(e) => setMethod(j, e.target.value as FilingMethod)}
            >
              {FILING_METHODS.map((m) => <option key={m} value={m}>{FILING_METHOD_LABEL[m]}</option>)}
            </select>{' '}
            {j === FEDERAL ? (
              <span className="muted small">always</span>
            ) : (
              <button type="button" className="chip" onClick={() => { setListErr(''); commit(removeState(list, j)); }}>Remove {j}</button>
            )}
          </li>
        ))}
      </ul>
      <label className="field">
        Add a state (two-letter code)
        <input
          value={typed}
          maxLength={2}
          placeholder="IL"
          aria-invalid={listErr ? true : undefined}
          onChange={(e) => { setTyped(e.target.value); setListErr(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
        {listErr ? <p className="field-error" role="alert">{listErr}</p> : null}
      </label>
      <button type="button" className="btn small ghost" onClick={add}>Add state</button>
      <p className="muted small">{CONTROL_SENTENCES.jurisdictions}</p>
    </fieldset>
  );
}

/*
 * THE CORRECTION MODAL (Brian, 2026-09-26): the filing as recorded, each fact editable in place.
 *
 * The jurisdictions list is the Mark filed list without the method selects: a state ADDED takes the
 * lane the return's year implies (the route writes it), and a state that has already answered —
 * accepted, or mailed — shows why it stays instead of a Remove chip, because the route would refuse
 * it and the person should not have to find that out by trying. The preparer offer appears the
 * moment the PTIN holder differs from the recorded one.
 */
function CorrectionFields({ draft, current, options, assigned, signedOn, rows, defaultMethod }: {
  draft: FilingAsRecorded & { alsoAssign: boolean; scan: File | null };
  current: FilingAsRecorded;
  options: Array<{ id: string; name: string }>;
  assigned: { id: string; name: string } | null;
  signedOn: string | null;
  rows: JurisdictionView[];
  defaultMethod: FilingMethod;
}): React.JSX.Element {
  const [filedOn, setFiledOn] = useState(draft.filedOn);
  const [ptin, setPtin] = useState(draft.ptin);
  const [f8879SignedOn, setF8879SignedOn] = useState(draft.f8879SignedOn ?? '');
  const [f8879Variant, setF8879Variant] = useState(draft.f8879Variant ?? '');
  const [alsoAssign, setAlsoAssign] = useState(draft.alsoAssign);
  const [list, setList] = useState<string[]>(draft.jurisdictions);
  const [typed, setTyped] = useState('');
  const [listErr, setListErr] = useState('');
  const holderName = (id: string) => options.find((o) => o.id === id)?.name ?? 'not recorded';
  const commit = (next: string[]) => { draft.jurisdictions = next; setList(next); };
  const add = () => {
    const r = addState(list, typed);
    setListErr(r.error);
    if (r.error) return;
    commit(r.list);
    setTyped('');
  };
  return (
    <>
      <p className="small">
        As recorded: filed {current.filedOn ? formatDate(current.filedOn) : 'on no day'}, PTIN holder {holderName(current.ptin)},{' '}
        {jurisdictionsSentence(current.jurisdictions).replace(/ — .*$/, '')}. Change what is wrong and say why below.
      </p>
      <label className="field">
        Filed on
        <input type="date" value={filedOn} onChange={(e) => { setFiledOn(e.target.value); draft.filedOn = e.target.value; }} />
      </label>
      <p className="muted small">
        {signedOn ? `Never after today and never before the signed 8879 (${formatDate(signedOn)}).` : 'Never after today.'}
      </p>
      {/*
        * THE AUTHORIZATION (R69, R66). The day on the signed 8879 — the route refuses a day after today,
        * before the tax year closed, or after the filed day, in the modal — which 8879 the paper is, and a
        * replacement scan when the wrong file was uploaded (the old one is kept, marked superseded).
        */}
      <label className="field">
        Signed on
        <input type="date" value={f8879SignedOn} onChange={(e) => { setF8879SignedOn(e.target.value); draft.f8879SignedOn = e.target.value; }} />
      </label>
      <p className="muted small">The day on the signed 8879: never after today and never after the filed date; the filed date then keeps to it.</p>
      <label className="field" data-testid="correction-f8879-variant">
        Form
        <select value={f8879Variant} onChange={(e) => { setF8879Variant(e.target.value); draft.f8879Variant = e.target.value; }}>
          <option value="">{current.f8879Variant ? 'Choose…' : 'Not recorded — choose…'}</option>
          {F8879_VARIANTS.map((v) => <option key={v} value={v}>{F8879_VARIANT_LABEL[v]}</option>)}
        </select>
      </label>
      <label className="field">
        Replace the scan
        <input type="file" accept="application/pdf,image/*" data-testid="correction-f8879-scan" onChange={(e) => { draft.scan = e.target.files?.[0] ?? null; }} />
      </label>
      <p className="muted small">Only when the wrong file was uploaded: the new scan becomes the 8879 on file and the previous one is kept, marked superseded.</p>
      <label className="field">
        PTIN holder
        <select value={ptin} onChange={(e) => { setPtin(e.target.value); draft.ptin = e.target.value; }}>
          <option value="">Choose…</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      {ptin && ptin !== current.ptin ? (
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            data-testid="also-assign-preparer"
            checked={alsoAssign}
            onChange={(e) => { setAlsoAssign(e.target.checked); draft.alsoAssign = e.target.checked; }}
          />
          <span>Also make {holderName(ptin)} the assigned preparer ({preparerLine(assigned).toLowerCase()} today)</span>
        </label>
      ) : null}
      <fieldset className="field" data-testid="correction-jurisdictions" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small">Jurisdictions declared</legend>
        <ul style={{ listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 6, padding: 0, margin: '0 0 6px' }}>
          {list.map((j) => {
            const answered = jurisdictionSatisfiedText(
              rows.find((r) => r.jurisdiction === j),
              formatDate(rows.find((r) => r.jurisdiction === j)?.acceptedOn ?? rows.find((r) => r.jurisdiction === j)?.mailedOn ?? '')
            );
            return (
              <li key={j}>
                <span className="badge">{jurisdictionLabel(j)}</span>{' '}
                {j === FEDERAL ? (
                  <span className="muted small">always</span>
                ) : answered ? (
                  <span className="muted small">{answered} — stays on the filing</span>
                ) : (
                  <button type="button" className="chip" onClick={() => { setListErr(''); commit(removeState(list, j)); }}>Remove {j}</button>
                )}
              </li>
            );
          })}
        </ul>
        <label className="field">
          Add a state (two-letter code)
          <input
            value={typed}
            maxLength={2}
            placeholder="IL"
            aria-invalid={listErr ? true : undefined}
            onChange={(e) => { setTyped(e.target.value); setListErr(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          />
          {listErr ? <p className="field-error" role="alert">{listErr}</p> : null}
        </label>
        <button type="button" className="btn small ghost" onClick={add}>Add state</button>
        <p className="muted small">
          A state added is filed the way this year files ({FILING_METHOD_LABEL[defaultMethod]}); a jurisdiction that has accepted or been mailed stays.
        </p>
      </fieldset>
    </>
  );
}

/*
 * THE MAILING OF ONE PAPER JURISDICTION (Brian, 2026-09-20, ruling 15).
 *
 * Four answers, of which two are optional because demanding them would produce placeholders: a
 * hand-delivered return has no tracking number, and a receipt that has not been scanned yet is not a
 * reason to leave the mailing unrecorded. The date is refused by the route when it is in the future —
 * its words, under the field — because "not after today" is the route's rule to hold, in Chicago
 * time, not the browser's.
 */
function MailingFields({ draft, jurisdiction }: {
  draft: { mailedOn: string; method: MailingMethod; tracking: string; file: File | null };
  jurisdiction: string;
}): React.JSX.Element {
  const [mailedOn, setMailedOn] = useState(draft.mailedOn);
  const [method, setMethod] = useState<MailingMethod>(draft.method);
  const [tracking, setTracking] = useState(draft.tracking);
  return (
    <>
      <p className="small">
        {jurisdictionLabel(jurisdiction)} was filed on paper, so no acknowledgment is coming for it. The mailing is what
        satisfies it, and the return completes once every jurisdiction has answered.
      </p>
      <label className="field">
        Mailed on
        <input type="date" value={mailedOn} onChange={(e) => { setMailedOn(e.target.value); draft.mailedOn = e.target.value; }} />
      </label>
      <label className="field" data-testid="mailing-method">
        Method
        <select value={method} onChange={(e) => { setMethod(e.target.value as MailingMethod); draft.method = e.target.value as MailingMethod; }}>
          {MAILING_METHODS.map((m) => <option key={m} value={m}>{MAILING_METHOD_LABEL[m]}</option>)}
        </select>
      </label>
      <label className="field">
        Tracking number
        <input value={tracking} placeholder="Optional — certified mail has one" onChange={(e) => { setTracking(e.target.value); draft.tracking = e.target.value; }} />
      </label>
      <label className="field">
        Mailing receipt (scan)
        <input type="file" accept="application/pdf,image/*" onChange={(e) => { draft.file = e.target.files?.[0] ?? null; }} />
      </label>
      <p className="muted small">
        A certified mailing opens a follow-up task to check the tracking; the receipt files to the client record under
        mailing receipts.
      </p>
    </>
  );
}
