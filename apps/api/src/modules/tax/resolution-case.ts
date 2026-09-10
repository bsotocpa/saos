// M26.5 (v4.6): spawning and running a tax-resolution case.
//
// Accepting a resolution quote spawns ONE engagement per year per return type,
// plus a paired reconstruction engagement for every year whose books are
// partial or missing, and CHAINS THE WORK OLDEST-YEAR-FIRST with real task
// dependencies: books(Y) → return(Y) → books(Y+1) → return(Y+1)… so
// carryforwards flow in the only order that produces correct returns.
//
// Authorization is gated, not advisory:
//   · 8821 signs at ONBOARDING, before any document work; signature
//     auto-creates the transcript-request task.
//   · 2848 swaps in only when REPRESENTATION begins, and abatement /
//     installment-agreement work is refused for a year the signed 2848 does
//     not cover.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError, type AuthedStaff } from '../../types.ts';
import { firstActiveByRole, ownerForRole } from '../../staffing.ts';
import { addTaskDependency, createTask } from '../tasks/service.ts';
import { createEngagement } from '../engagements/service.ts';
import { createEnvelope } from '../signatures/service.ts';
import { originalDeadline, todayChicago, type DeadlineReturnType } from './deadlines.ts';
import { PAPER_LANE_CHECKLIST, filingLane, planResolution, refundStatuteExpiry } from './resolution.ts';

export interface SpawnYearInput {
  taxYear: number;
  returnType: DeadlineReturnType;
  booksExist?: 'yes' | 'partial' | 'no' | undefined;
}

/**
 * Spawn the whole case. Returns the per-year engagement ids in the order the
 * work must happen (oldest first).
 */
export async function spawnResolutionCase(
  app: FastifyInstance,
  input: {
    contactId: string;
    businessId?: string | null | undefined;
    years: SpawnYearInput[];
    preparerId?: string | null | undefined;
    lookbackYears?: number | undefined;
  },
  actor: AuthedStaff,
  today: string = todayChicago()
): Promise<{
  caseId: string;
  engagements: Array<{ taxEngagementId: string; taxYear: number; kind: 'return' | 'reconstruction'; lane: string }>;
  f8821EnvelopeId: string;
}> {
  if (input.years.length === 0) throw new AppError(400, 'no_years', 'Select at least one unfiled year.');

  const caseRow = await app.db.query<{ id: string }>(
    `INSERT INTO resolution_cases (contact_id, business_id, lookback_years)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.contactId, input.businessId ?? null, input.lookbackYears ?? 6]
  );
  const caseId = caseRow.rows[0]!.id;
  const plan = planResolution({ years: input.years }, today); // sorted oldest first
  const preparer = input.preparerId ?? (await ownerForRole(app.db, 'tax_preparer'));
  const bookkeeper = await firstActiveByRole(app.db, 'bookkeeper');

  const spawned: Array<{ taxEngagementId: string; taxYear: number; kind: 'return' | 'reconstruction'; lane: string; taskId: string }> = [];

  for (const year of plan) {
    // Reconstruction FIRST for the year — the return cannot be right without it.
    if (year.needsReconstruction) {
      const recon = await createResolutionEngagement(app, actor, {
        contactId: input.contactId, businessId: input.businessId ?? null, caseId,
        taxYear: year.taxYear, returnType: year.returnType, lane: year.lane,
        isReconstruction: true, booksExist: year.booksExist,
        statuteExpiry: year.refundStatuteExpiry, preparerId: bookkeeper ?? preparer,
      });
      spawned.push({ ...recon, taxYear: year.taxYear, kind: 'reconstruction', lane: year.lane });
    }
    const ret = await createResolutionEngagement(app, actor, {
      contactId: input.contactId, businessId: input.businessId ?? null, caseId,
      taxYear: year.taxYear, returnType: year.returnType, lane: year.lane,
      isReconstruction: false, booksExist: year.booksExist,
      statuteExpiry: year.refundStatuteExpiry, preparerId: preparer,
    });
    spawned.push({ ...ret, taxYear: year.taxYear, kind: 'return', lane: year.lane });
  }

  // THE CHAIN: every step blocked by the one before it, oldest year first.
  for (let i = 1; i < spawned.length; i++) {
    await addTaskDependency(app, spawned[i]!.taskId, spawned[i - 1]!.taskId, actor);
  }

  // 8821 at onboarding — before any document work.
  const envelope = await createEnvelope(app, { type: 'staff', id: actor.id, label: actor.fullName }, {
    contactId: input.contactId,
    type: 'f8821',
    signatureMethod: 'remote_kba',
  });
  await app.db.query(`UPDATE resolution_cases SET f8821_envelope_id = $2 WHERE id = $1`, [caseId, envelope.id]);
  await createTask(app, {
    title: 'Send the Form 8821 (transcript authorization) — before any document work',
    description:
      'Resolution cases start with transcripts. The 8821 lets us pull the IRS record for every year in scope; ' +
      'the transcript-request task appears automatically once it is signed.',
    assignedStaffId: preparer,
    contactId: input.contactId,
    priority: 2,
    source: 'automation',
    sourceType: 'f8821_send',
    sourceId: caseId,
  });

  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
    action: 'resolution_case.spawned', objectType: 'resolution_case', objectId: caseId,
    contactId: input.contactId,
    details: {
      years: plan.map((p) => p.taxYear),
      engagements: spawned.length,
      paper_years: plan.filter((p) => p.lane === 'paper').map((p) => p.taxYear),
      reconstruction_years: plan.filter((p) => p.needsReconstruction).map((p) => p.taxYear),
    },
  });

  return {
    caseId,
    engagements: spawned.map(({ taxEngagementId, taxYear, kind, lane }) => ({ taxEngagementId, taxYear, kind, lane })),
    f8821EnvelopeId: envelope.id,
  };
}

async function createResolutionEngagement(
  app: FastifyInstance,
  actor: AuthedStaff,
  input: {
    contactId: string; businessId: string | null; caseId: string;
    taxYear: number; returnType: DeadlineReturnType; lane: 'efile' | 'paper';
    isReconstruction: boolean; booksExist: string; statuteExpiry: string | null;
    preparerId: string | null;
  }
): Promise<{ taxEngagementId: string; taskId: string }> {
  const label = input.isReconstruction
    ? `${input.taxYear} books reconstruction`
    : `${input.taxYear} ${input.returnType.toUpperCase()} (resolution)`;

  const parent = await createEngagement(
    app,
    actor,
    {
      contactId: input.contactId,
      ...(input.businessId ? { businessId: input.businessId } : {}),
      serviceLine: input.isReconstruction ? 'bookkeeping' : 'tax',
      title: label,
      status: 'active',
      ...(input.preparerId ? { leadStaffId: input.preparerId } : {}),
    },
    {}
  );

  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements
       (engagement_id, tax_year, return_type, preparer_id, resolution_case_id, filing_lane,
        books_exist, is_reconstruction, refund_statute_expiry, original_deadline)
     VALUES ($1,$2,$3::return_type,$4,$5,$6::filing_lane,$7,$8,$9,$10)
     RETURNING id`,
    [
      parent.id, input.taxYear, input.returnType, input.preparerId, input.caseId, input.lane,
      input.booksExist, input.isReconstruction, input.statuteExpiry,
      originalDeadline(input.returnType, input.taxYear, 12),
    ]
  );
  const teId = te.rows[0]!.id;
  await app.db.query(
    `INSERT INTO engagement_stage_history (tax_engagement_id, stage, changed_by_staff_id, waiting_on, note)
     VALUES ($1, 'intake_started', $2, 'staff', 'resolution case spawned')`,
    [teId, actor.id]
  );

  // The work item, with the PAPER-LANE checklist baked in where the year
  // forces paper (staff never choose the lane — the year did).
  const created = await createTask(app, {
    title: label,
    description:
      input.lane === 'paper' && !input.isReconstruction
        ? `PAPER LANE (${input.taxYear} is more than two years back — e-file is not available):\n` +
          PAPER_LANE_CHECKLIST.map((s) => `· ${s}`).join('\n')
        : input.isReconstruction
          ? `Books are ${input.booksExist} for ${input.taxYear}. Reconstruct before the return is prepared.`
          : `Standard e-file lane with remote KBA 8879.`,
    assignedStaffId: input.preparerId,
    contactId: input.contactId,
    businessId: input.businessId,
    engagementId: parent.id,
    dueDate: input.statuteExpiry,
    priority: 1,
    source: 'automation',
    sourceType: 'resolution_year',
    sourceId: teId,
  });
  return { taxEngagementId: teId, taskId: created.id };
}

/** 8821 signed → transcripts can be requested. Called from the signature hook. */
export async function onF8821Signed(app: FastifyInstance, envelopeId: string): Promise<void> {
  const { rows } = await app.db.query<{ id: string; contact_id: string }>(
    `UPDATE resolution_cases SET f8821_signed_at = COALESCE(f8821_signed_at, now())
     WHERE f8821_envelope_id = $1
     RETURNING id, contact_id`,
    [envelopeId]
  );
  const c = rows[0];
  if (!c) return;
  const preparer = await ownerForRole(app.db, 'tax_preparer');
  await createTask(app, {
    title: 'Request IRS transcripts for every year in scope',
    description: 'The 8821 is signed. Pull wage & income and account transcripts per year; flag any SFR the IRS already filed.',
    assignedStaffId: preparer,
    contactId: c.contact_id,
    priority: 2,
    source: 'automation',
    sourceType: 'transcript_request',
    sourceId: c.id,
  });
  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'signature-webhook',
    action: 'resolution_case.f8821_signed', objectType: 'resolution_case', objectId: c.id,
    contactId: c.contact_id,
  });
}

/** 2848 signed → representation is authorized for the listed years only. */
export async function recordF2848(
  app: FastifyInstance,
  caseId: string,
  scopeYears: number[],
  envelopeId: string | null,
  actor: { id: string; email: string; fullName: string }
): Promise<void> {
  const res = await app.db.query(
    `UPDATE resolution_cases
     SET f2848_envelope_id = COALESCE($3, f2848_envelope_id),
         f2848_signed_at = COALESCE(f2848_signed_at, now()),
         f2848_scope_years = $2
     WHERE id = $1`,
    [caseId, scopeYears, envelopeId]
  );
  if (res.rowCount === 0) throw new AppError(404, 'not_found', 'Resolution case not found.');
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
    action: 'resolution_case.f2848_recorded', objectType: 'resolution_case', objectId: caseId,
    details: { scope_years: scopeYears },
  });
}

/**
 * THE REPRESENTATION GATE: abatement and installment-agreement work require an
 * active 2848 covering that specific year. Refused otherwise, in code.
 */
export async function assertRepresentationAuthorized(
  app: FastifyInstance,
  caseId: string,
  taxYear: number
): Promise<void> {
  const { rows } = await app.db.query<{ f2848_signed_at: Date | null; f2848_scope_years: number[] }>(
    `SELECT f2848_signed_at, f2848_scope_years FROM resolution_cases WHERE id = $1`,
    [caseId]
  );
  const c = rows[0];
  if (!c) throw new AppError(404, 'not_found', 'Resolution case not found.');
  if (!c.f2848_signed_at) {
    throw new AppError(
      409, 'f2848_required',
      'Blocked: representation work (penalty abatement, installment agreement, exam) needs a signed Form 2848. The 8821 authorizes transcripts only.'
    );
  }
  if (!c.f2848_scope_years.includes(taxYear)) {
    throw new AppError(
      409, 'f2848_year_not_covered',
      `Blocked: the signed 2848 covers ${c.f2848_scope_years.join(', ') || 'no years'} — not ${taxYear}. Extend the POA before representing this year.`
    );
  }
}

/** Case view: the chain, the lanes, the statute clocks, the authorization state. */
export async function resolutionCaseView(app: FastifyInstance, caseId: string) {
  const caseRow = await app.db.query(
    `SELECT rc.id, rc.contact_id, rc.lookback_years, rc.f8821_signed_at, rc.f2848_signed_at,
            rc.f2848_scope_years, rc.transcripts_received_at,
            c.first_name || ' ' || c.last_name AS client_name
     FROM resolution_cases rc JOIN contacts c ON c.id = rc.contact_id
     WHERE rc.id = $1`,
    [caseId]
  );
  if (!caseRow.rows[0]) throw new AppError(404, 'not_found', 'Resolution case not found.');
  const years = await app.db.query(
    `SELECT te.id, te.tax_year, te.return_type, te.stage, te.filing_lane, te.books_exist,
            te.is_reconstruction, te.refund_statute_expiry::text AS refund_statute_expiry,
            te.sfr_risk, te.paper_mailed_on::text AS paper_mailed_on, te.certified_tracking,
            -- tasks.source_id is TEXT (it holds ids from many sources), so the
            -- comparison against a uuid column needs an explicit cast.
            (SELECT count(*)::int FROM task_dependencies d
             JOIN tasks bt ON bt.id = d.blocker_task_id
             JOIN tasks t ON t.id = d.blocked_task_id
             WHERE t.source_type = 'resolution_year' AND t.source_id = te.id::text
               AND bt.status NOT IN ('completed', 'cancelled')) AS blocked_by
     FROM tax_engagements te
     WHERE te.resolution_case_id = $1
     ORDER BY te.tax_year, te.is_reconstruction DESC`,
    [caseId]
  );
  return { case: caseRow.rows[0], years: years.rows };
}

/** Paper lane: record the certified mailing (tracking number is required). */
export async function recordPaperMailing(
  app: FastifyInstance,
  taxEngagementId: string,
  input: { mailedOn: string; tracking: string },
  actor: { id: string; email: string; fullName: string }
): Promise<void> {
  const te = await app.db.query<{ filing_lane: string | null; tax_year: number }>(
    `SELECT filing_lane, tax_year FROM tax_engagements WHERE id = $1`,
    [taxEngagementId]
  );
  if (!te.rows[0]) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  // Derivation is the authority — refuse a certified mailing on an e-file year.
  const lane = te.rows[0].filing_lane ?? filingLane(te.rows[0].tax_year);
  if (lane !== 'paper') {
    throw new AppError(409, 'not_paper_lane', `${te.rows[0].tax_year} files electronically — certified mail does not apply.`);
  }
  if (!input.tracking.trim()) {
    throw new AppError(400, 'tracking_required', 'The certified-mail tracking number is required.');
  }
  await app.db.query(
    `UPDATE tax_engagements SET paper_mailed_on = $2, certified_tracking = $3 WHERE id = $1`,
    [taxEngagementId, input.mailedOn, input.tracking.trim()]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
    action: 'tax_engagement.paper_mailed', objectType: 'tax_engagement', objectId: taxEngagementId,
    details: { mailed_on: input.mailedOn, certified_tracking: input.tracking.trim() },
  });
}
