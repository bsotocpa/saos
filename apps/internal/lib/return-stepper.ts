/*
 * THE RETURNS CARD AS A STEPPER (Brian, 2026-09-26, R50) — the pure parts.
 *
 * Sixteen steps, in the order Brian ruled: letter signed; preparer assigned; estimate locked;
 * scheduled; documents requested; in preparation; internal review; delivered to client; 8879 sent
 * (R53); 8879 on file; final fee set; ready to file; filed; accepted or mailed per jurisdiction;
 * paid; completed.
 *
 * A DONE step shows a check, the day and who did it. The CURRENT step — the first one not done — is
 * the one with a control and one sentence. A LATER step says what unlocks it. Steps after the
 * current one that are already done (a completed return with its invoice still open, say) stay
 * done: the state of each step is a fact about the return, and only "which one carries the control"
 * is a rule about order.
 *
 * FIVE PHASES (R50 v2, 2026-09-27): the steps group into Engage, Prepare, Sign, File and Close. The
 * CURRENT phase is the one holding the current step; a phase whose steps are all done is DONE and
 * dated by its last step; any other phase is FUTURE. The rail draws the phases; only the current one
 * opens to its steps (buildPhases, below the steps).
 *
 * Everything here is a pure function of GET /tax-engagements/:id, so the rule can be proven by a
 * test rather than believed from a screenshot. No React, no fetch, and — like return-controls.ts —
 * NO DATE FORMATTER: every day or instant leaves here raw, tagged as a calendar day or an instant,
 * and the component formats it with the one helper (formatDate for a day, dayOf for an instant).
 */
// A TYPE-ONLY import: this lib has no runtime import, so node --test loads it without a bundler.
import type { JurisdictionView } from './return-controls';

export const STEP_KEYS = [
  'letter', 'preparer', 'estimate', 'scheduled', 'documents_requested', 'in_preparation', 'internal_review',
  'delivered', 'f8879_sent', 'f8879_on_file', 'final_fee', 'ready_to_file', 'filed', 'jurisdictions', 'paid', 'completed',
] as const;
export type StepKey = (typeof STEP_KEYS)[number];

export const STEP_LABEL: Record<StepKey, string> = {
  letter: 'Letter signed',
  preparer: 'Preparer assigned',
  estimate: 'Estimate locked',
  scheduled: 'Scheduled',
  documents_requested: 'Documents requested',
  in_preparation: 'In preparation',
  internal_review: 'Internal review',
  delivered: 'Delivered to client',
  f8879_sent: '8879 sent',
  f8879_on_file: '8879 on file',
  final_fee: 'Final fee set',
  ready_to_file: 'Ready to file',
  filed: 'Filed',
  jurisdictions: 'Accepted or mailed',
  paid: 'Paid',
  completed: 'Completed',
};

/** What a LATER step says: the thing that has to happen first, in the order ruled. */
export const STEP_UNLOCKS: Record<StepKey, string> = {
  letter: 'The first step: the client signs the engagement packet in the portal, or the signed letter is uploaded here.',
  preparer: 'Unlocks when the engagement letter is signed; the preparer can also be named from the details area at any time.',
  estimate: 'Unlocks when a preparer is named.',
  scheduled: 'Unlocks when the estimate is locked.',
  documents_requested: 'Unlocks when the return is scheduled.',
  in_preparation: 'Unlocks when documents have been requested (and the estimate is locked and a preparer named — the pipeline refuses otherwise).',
  internal_review: 'Unlocks when preparation starts.',
  delivered: 'Unlocks when internal review starts; delivering the return PDF from Deliver a return moves the stage.',
  f8879_sent: 'Unlocks when the return has been delivered to the client.',
  f8879_on_file: 'Unlocks when the 8879 has been sent to the client or handed over in office.',
  final_fee: 'Unlocks when the signed 8879 is on file.',
  ready_to_file: 'Unlocks when the final fee is set.',
  filed: 'Unlocks when the return is ready to file.',
  jurisdictions: 'Unlocks when the return is filed: each e-filed jurisdiction waits on its acknowledgment, each paper one on its recorded mailing.',
  paid: 'Unlocks when the filing issues the final-fee invoice; the client pays it in the portal.',
  completed: 'Completes on its own when every declared jurisdiction has accepted or been mailed.',
};

/** The stage each stage-step stands for, and the pipeline's order for it. */
const STAGE_STEP: Partial<Record<StepKey, string>> = {
  scheduled: 'scheduled', documents_requested: 'documents_requested', in_preparation: 'in_preparation',
  internal_review: 'internal_review', delivered: 'client_review', ready_to_file: 'ready_to_file', filed: 'filed', completed: 'completed',
};
const STAGE_ORDER: Record<string, number> = {
  intake_started: 0, scheduled: 1, documents_requested: 2, pending_client_response: 3,
  in_preparation: 4, internal_review: 5, client_review: 6, ready_to_file: 7, filed: 8, rejected: 8, completed: 9,
};

/** One stage-history row as GET reports it (`entered_at` is an instant; `changed_by_name` may be null for automation). */
export interface StageHistoryRow { stage: string; entered_at: string; changed_by_name: string | null; note: string | null }
/** One audit row GET reports as `activity`: the step actions, oldest first. */
export interface ActivityRow { action: string; actor_label: string | null; at: string; details: Record<string, unknown> }
/** The 8879-sent record (R53), or null. */
export interface F8879SentView {
  method: 'adobe_sign' | 'in_office' | 'mailed' | null;
  sent_on: string;
  recorded_by_name: string | null;
  declared_by_import: boolean;
}

export const F8879_SENT_METHOD_LABEL: Record<'adobe_sign' | 'in_office' | 'mailed', string> = {
  adobe_sign: 'Adobe Sign',
  in_office: 'In office',
  mailed: 'Mailed',
};
export const F8879_SENT_METHODS = ['adobe_sign', 'in_office', 'mailed'] as const;

/** What the stepper reads: the detail GET /tax-engagements/:id returns, the parts that decide a step. */
export interface StepperInput {
  te: {
    stage: string;
    engagement_letter_signed_at: string | null;
    /** The letter's day as a calendar day, when the API gives it; the instant is the fallback. */
    engagement_letter_signed_on?: string | null;
    estimate_locked_at: string | null;
    estimated_fee_min_cents: number | null;
    estimated_fee_max_cents: number | null;
    final_fee_cents: number | null;
    filed_date: string | null;
    f8879_signed_on: string | null;
    payment_status?: string | null;
  };
  stageHistory: StageHistoryRow[];
  activity: ActivityRow[];
  f8879_sent: F8879SentView | null;
  signed_authorization_on_file: boolean;
  assigned_preparer: { id: string; name: string } | null;
  preparer_of_record: string | null;
  jurisdictions: JurisdictionView[];
  final_fee_invoice: { status: string; paid_at: string | null; total_cents: number } | null;
  legal_next_stages: string[];
}

/** A done step's evidence: WHEN (a calendar day or an instant, formatted by the component) and WHO. */
export interface StepDone {
  day?: string | null;
  at?: string | null;
  by: string | null;
  /** Extra words for the check line: the locked range, the fee, the method, the note. */
  detail?: string | undefined;
}

export interface StepView {
  key: StepKey;
  label: string;
  state: 'done' | 'current' | 'later';
  done?: StepDone;
  /** What a LATER step prints. */
  unlocks?: string;
  /** For a stage step that is current: the stage the control moves to, when the pipeline allows it from here. */
  transitionTo?: string | null;
  /** Words for a current step with no control of its own (waiting on the client, on ATX, on payment). */
  waiting?: string;
}

const last = <T,>(list: readonly T[]): T | undefined => (list.length > 0 ? list[list.length - 1] : undefined);

function latest(activity: readonly ActivityRow[], action: string, where: (a: ActivityRow) => boolean = () => true): ActivityRow | undefined {
  return last(activity.filter((a) => a.action === action && where(a)));
}

/** The stage the ORDER is read from: a return on hold reads the stage it was held at. */
export function effectiveStage(te: { stage: string }, history: readonly StageHistoryRow[]): string {
  if (te.stage !== 'on_hold') return te.stage;
  const resumed = [...history].reverse().find((h) => h.stage !== 'on_hold' && h.stage in STAGE_ORDER);
  return resumed?.stage ?? 'intake_started';
}

/** Whether a stage step has been reached; a rejected return has NOT filed (it must re-file). */
function stageReached(effective: string, target: string): boolean {
  if (effective === 'withdrawn') return false;
  if (effective === 'rejected') return (STAGE_ORDER[target] ?? 99) < STAGE_ORDER.filed!;
  return (STAGE_ORDER[effective] ?? -1) >= (STAGE_ORDER[target] ?? 99);
}

function stageDone(history: readonly StageHistoryRow[], activity: readonly ActivityRow[], stage: string): StepDone {
  const h = last(history.filter((r) => r.stage === stage));
  const imported = h?.note?.startsWith('Steps before this stage were completed outside SAOS');
  const importer = imported ? latest(activity, 'tax_engagement.imported_at_stage')?.actor_label : null;
  return {
    at: h?.entered_at ?? null,
    by: h?.changed_by_name ?? importer ?? (h ? 'automation' : null),
    ...(imported ? { detail: 'imported at this stage under the R16 attestation' } : {}),
  };
}

/** The money words the fee step prints; the amount arrives already formatted (no money formatter here either). */
export function feeDetail(moneyText: string): string {
  return `current ${moneyText}`;
}

/**
 * The sixteen steps for one return. The component formats days and money; this decides state,
 * evidence and words.
 */
export function buildSteps(input: StepperInput): StepView[] {
  const { te, stageHistory, activity, jurisdictions } = input;
  const effective = effectiveStage(te, stageHistory);
  const onFile = input.signed_authorization_on_file;

  // Each step's facts, independent of order.
  const letterUpload = latest(activity, 'signature.recorded_wet', (a) => a.details?.type === 'engagement_letter');
  const f8879Upload = latest(activity, 'signature.recorded_wet', (a) => a.details?.type === 'f8879');
  const preparerAssigned = latest(activity, 'tax_engagement.preparer_assigned');
  const estimateLocked = latest(activity, 'tax_engagement.estimate_locked');
  const feeSet = latest(activity, 'tax_engagement.final_fee_set');
  const sent = input.f8879_sent;
  const declared = jurisdictions.filter((j) => j.jurisdiction);
  const answered = declared.filter((j) => (j.filingMethod === 'paper' ? Boolean(j.mailedOn) : Boolean(j.acceptedOn)));
  const allAnswered = declared.length > 0 && answered.length === declared.length;
  const invoice = input.final_fee_invoice;
  const paid = invoice?.status === 'paid' || te.payment_status === 'paid';

  const facts: Record<StepKey, { done: boolean; evidence?: StepDone; transitionTo?: string | null; waiting?: string }> = {
    letter: {
      done: Boolean(te.engagement_letter_signed_at),
      evidence: {
        day: te.engagement_letter_signed_on ?? null,
        at: te.engagement_letter_signed_on ? null : te.engagement_letter_signed_at,
        by: letterUpload ? `${letterUpload.actor_label ?? 'staff'} (uploaded scan)` : 'the client (portal signature)',
      },
    },
    preparer: {
      done: Boolean(input.assigned_preparer),
      evidence: {
        at: preparerAssigned?.at ?? null,
        by: preparerAssigned?.actor_label ?? (input.assigned_preparer ? 'assigned at creation (the firm’s only tax preparer)' : null),
        detail: input.assigned_preparer ? `Preparer: ${input.assigned_preparer.name}` : undefined,
      },
    },
    estimate: {
      done: Boolean(te.estimate_locked_at),
      evidence: { at: te.estimate_locked_at, by: estimateLocked?.actor_label ?? null },
    },
    scheduled: { done: stageReached(effective, 'scheduled'), evidence: stageDone(stageHistory, activity, 'scheduled'), transitionTo: 'scheduled' },
    documents_requested: { done: stageReached(effective, 'documents_requested'), evidence: stageDone(stageHistory, activity, 'documents_requested'), transitionTo: 'documents_requested' },
    in_preparation: { done: stageReached(effective, 'in_preparation'), evidence: stageDone(stageHistory, activity, 'in_preparation'), transitionTo: 'in_preparation' },
    internal_review: { done: stageReached(effective, 'internal_review'), evidence: stageDone(stageHistory, activity, 'internal_review'), transitionTo: 'internal_review' },
    delivered: { done: stageReached(effective, 'client_review'), evidence: stageDone(stageHistory, activity, 'client_review'), transitionTo: 'client_review' },
    f8879_sent: {
      done: Boolean(sent) || onFile,
      evidence: sent
        ? {
            day: sent.sent_on,
            by: sent.declared_by_import ? 'the Trello import (declared from the card)' : sent.recorded_by_name,
            detail: sent.method ? F8879_SENT_METHOD_LABEL[sent.method] : 'method not recorded',
          }
        : { day: te.f8879_signed_on, by: null, detail: 'not recorded separately; the signed 8879 is on file' },
    },
    f8879_on_file: {
      done: onFile,
      evidence: { day: te.f8879_signed_on, by: f8879Upload?.actor_label ?? null, detail: input.preparer_of_record ? `PTIN holder ${input.preparer_of_record}` : undefined },
    },
    final_fee: {
      done: te.final_fee_cents !== null,
      evidence: { at: feeSet?.at ?? null, by: feeSet?.actor_label ?? null },
    },
    ready_to_file: {
      done: stageReached(effective, 'ready_to_file') && effective !== 'rejected',
      evidence: stageDone(stageHistory, activity, 'ready_to_file'),
      transitionTo: 'ready_to_file',
      ...(effective === 'rejected' ? { waiting: 'E-file rejected: fix the return and move it back to ready to file, then re-file inside the perfection window.' } : {}),
    },
    filed: {
      done: stageReached(effective, 'filed'),
      evidence: {
        day: te.filed_date,
        by: last(stageHistory.filter((h) => h.stage === 'filed'))?.changed_by_name ?? null,
        detail: `preparer of record: ${input.preparer_of_record ?? 'not recorded'}`,
      },
      transitionTo: 'filed',
    },
    jurisdictions: {
      done: allAnswered,
      evidence: {
        day: last(answered.map((j) => (j.filingMethod === 'paper' ? j.mailedOn : j.acceptedOn)).filter(Boolean).sort()) ?? null,
        by: null,
        detail: declared.length > 0 ? `${answered.length} of ${declared.length} answered` : undefined,
      },
      waiting: declared.some((j) => j.filingMethod === 'paper' && !j.mailedOn)
        ? 'A paper jurisdiction completes when its mailing is recorded here.'
        : 'Waiting on the acknowledgments from ATX; the E-file acks page releases them to this return.',
    },
    paid: {
      done: paid,
      evidence: { at: invoice?.paid_at ?? null, by: paid ? 'the client' : null },
      waiting: invoice
        ? `The final-fee invoice is ${invoice.status}; the client pays it in the portal.`
        : 'The filing issues the final-fee invoice; nothing to pay yet.',
    },
    completed: { done: stageReached(effective, 'completed'), evidence: stageDone(stageHistory, activity, 'completed') },
  };

  // The first step not done carries the control; everything before it is done, everything after is later or done.
  const firstOpen = STEP_KEYS.findIndex((k) => !facts[k].done);
  return STEP_KEYS.map((key, i) => {
    const f = facts[key];
    const state: StepView['state'] = f.done ? 'done' : i === firstOpen ? 'current' : 'later';
    const view: StepView = { key, label: STEP_LABEL[key], state };
    if (state === 'done' && f.evidence) view.done = f.evidence;
    if (state === 'later') view.unlocks = STEP_UNLOCKS[key];
    if (state === 'current') {
      if (f.transitionTo !== undefined) view.transitionTo = input.legal_next_stages.includes(f.transitionTo!) ? f.transitionTo : null;
      if (f.waiting) view.waiting = f.waiting;
    }
    return view;
  });
}

/** The current step, or null for a return that has finished every step (or was withdrawn). */
export function currentStep(steps: readonly StepView[]): StepView | null {
  return steps.find((s) => s.state === 'current') ?? null;
}

/*
 * THE FIVE PHASES (Brian, 2026-09-27, R50 v2). Engage: letter signed, preparer assigned, estimate
 * locked, scheduled. Prepare: documents requested, in preparation, internal review. Sign: delivered
 * to client, 8879 sent, 8879 on file. File: final fee set, ready to file, filed, accepted or mailed
 * per jurisdiction. Close: paid, completed. Every step sits in exactly one phase, in the step order.
 */
export const PHASE_KEYS = ['engage', 'prepare', 'sign', 'file', 'close'] as const;
export type PhaseKey = (typeof PHASE_KEYS)[number];

export const PHASE_LABEL: Record<PhaseKey, string> = { engage: 'Engage', prepare: 'Prepare', sign: 'Sign', file: 'File', close: 'Close' };

export const PHASE_STEPS: Record<PhaseKey, readonly StepKey[]> = {
  engage: ['letter', 'preparer', 'estimate', 'scheduled'],
  prepare: ['documents_requested', 'in_preparation', 'internal_review'],
  sign: ['delivered', 'f8879_sent', 'f8879_on_file'],
  file: ['final_fee', 'ready_to_file', 'filed', 'jurisdictions'],
  close: ['paid', 'completed'],
};

/** The phase a step belongs to. */
export function phaseOf(step: StepKey): PhaseKey {
  return PHASE_KEYS.find((p) => PHASE_STEPS[p].includes(step))!;
}

export interface PhaseView {
  key: PhaseKey;
  label: string;
  /** DONE: every step done. CURRENT: holds the current step. FUTURE: anything else. */
  state: 'done' | 'current' | 'future';
  /** The phase's steps, in order, each with its own state (a future phase can hold a done step; it is not drawn). */
  steps: StepView[];
  /** A done phase's date: its last step's day or instant, raw (the component formats); null when none was recorded. */
  doneOn: { day: string | null; at: string | null } | null;
}

/** A done phase is dated by its LAST step; a last step without a date (an imported stage) falls back to the latest dated step of the phase. */
function phaseDate(own: readonly StepView[]): PhaseView['doneOn'] {
  const dated = own.map((s) => s.done).filter((d): d is StepDone => Boolean(d && (d.day || d.at)));
  const lastStep = own[own.length - 1]?.done;
  const pick = lastStep && (lastStep.day || lastStep.at) ? lastStep : dated[dated.length - 1];
  return pick ? { day: pick.day ?? null, at: pick.at ?? null } : null;
}

/** The five phases over the sixteen steps: the current phase holds the current step; done phases are dated; the rest are future. */
export function buildPhases(steps: readonly StepView[]): PhaseView[] {
  const current = currentStep(steps);
  const holder = current ? phaseOf(current.key) : null;
  return PHASE_KEYS.map((key) => {
    const own = PHASE_STEPS[key].map((k) => steps.find((s) => s.key === k)!);
    const state: PhaseView['state'] = key === holder ? 'current' : own.every((s) => s.state === 'done') ? 'done' : 'future';
    return { key, label: PHASE_LABEL[key], state, steps: own, doneOn: state === 'done' ? phaseDate(own) : null };
  });
}

/** The current phase, or null when every step is done (or the return was withdrawn). */
export function currentPhase(phases: readonly PhaseView[]): PhaseView | null {
  return phases.find((p) => p.state === 'current') ?? null;
}

/**
 * THE HEADER'S AMOUNT, LABELLED (Brian's fix 3): the row printed a bare figure that could be an
 * estimate or a fee. Now it says which.
 */
export function amountLabel(te: { final_fee_cents: number | null; estimated_fee_max_cents: number | null }, money: (cents: number) => string): string {
  if (te.final_fee_cents !== null) return `Final fee ${money(te.final_fee_cents)}`;
  if (te.estimated_fee_max_cents !== null) return `Estimate up to ${money(te.estimated_fee_max_cents)}`;
  return 'No fee yet';
}

/** THE "EXTENDED" BADGE (fix 4) shows before filing; a filed return is past its deadline question. */
export function showExtendedBadge(te: { extension_filed: boolean; filed_date: string | null; stage: string }): boolean {
  return te.extension_filed && !te.filed_date && te.stage !== 'filed' && te.stage !== 'completed';
}

/** THE PAPER SENTENCE (fix 2) is printed only when a paper jurisdiction is declared. */
export function hasPaperJurisdiction(rows: readonly JurisdictionView[]): boolean {
  return rows.some((j) => j.filingMethod === 'paper');
}

