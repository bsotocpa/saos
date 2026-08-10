// The per-engagement attest Addendum (AU-C 210 / AR-C 90).
//
// Schedule F carries the standing attest terms. This carries the terms that are
// specific to ONE engagement — entity, statements and period, framework, fee,
// deposit, expected report date — which professional standards require to be
// agreed for each engagement before work begins.
//
// Two rules that are not negotiable here:
//
//  1. THE FEE COMES FROM THE PRICE BOOK. Not typed in. The item code is looked up
//     in the version in force and the cents are pinned onto the Addendum, the same
//     way quotes and engagements pin theirs. A free-text fee would be a hardcoded
//     price with extra steps.
//  2. THE INDEPENDENCE GATE IS UPSTREAM AND STAYS THERE. An attest engagement
//     cannot exist without passing it (engagements/service.ts), so an Addendum
//     cannot either — it requires an attest engagement to hang from. This file
//     does not re-check it and must never be given a way to bypass it.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError, type AuthedStaff } from '../../types.ts';

export type AttestEngagementType = 'review' | 'audit' | 'insurance_wc';

/** The price-book item each attest engagement type is quoted from. */
const FEE_ITEM_FOR: Record<AttestEngagementType, string> = {
  review: 'ATTEST_REVIEW',
  audit: 'ATTEST_AUDIT',
  insurance_wc: 'ATTEST_WC_INS_AUDIT',
};

export interface AddendumInput {
  engagementId: string;
  entityName: string;
  entityBusinessId?: string | null | undefined;
  engagementType: AttestEngagementType;
  statementsAndPeriods: string;
  reportingFramework: string;
  /** 'fixed' pins the item's amount; 'hourly' pins a rate and needs an estimate. */
  feeBasis: 'fixed' | 'hourly';
  /** Required when feeBasis is 'hourly'. */
  estimatedHours?: number | undefined;
  /** Overrides the default hourly item when the work is billed at another rate. */
  hourlyItemCode?: string | undefined;
  /** Price-book item the deposit/retainer comes from. */
  depositItemCode: string;
  expectedReportDate: string;
}

async function priceOf(
  app: FastifyInstance,
  versionId: string,
  itemCode: string
): Promise<{ amountCents: number; unit: string | null; needsConfirmation: boolean; nameEn: string }> {
  const { rows } = await app.db.query<{
    amount_cents: number | null; unit: string | null; needs_confirmation: boolean; name_en: string;
  }>(
    `SELECT amount_cents, unit, needs_confirmation, name_en FROM price_book_items
     WHERE version_id = $1 AND item_code = $2`,
    [versionId, itemCode]
  );
  const r = rows[0];
  if (!r) throw new AppError(400, 'price_item_unknown', `No price-book item '${itemCode}' in the version in force.`);
  if (r.amount_cents === null) {
    throw new AppError(400, 'price_item_has_no_amount', `Price-book item '${itemCode}' carries no amount.`);
  }
  return { amountCents: r.amount_cents, unit: r.unit, needsConfirmation: r.needs_confirmation, nameEn: r.name_en };
}

export async function createAttestAddendum(
  app: FastifyInstance,
  actor: AuthedStaff,
  input: AddendumInput
): Promise<{ id: string; feeCents: number; depositCents: number; warnings: string[] }> {
  const eng = await app.db.query<{ contact_id: string; service_line: string; status: string }>(
    `SELECT contact_id, service_line::text AS service_line, status::text AS status
     FROM engagements WHERE id = $1`,
    [input.engagementId]
  );
  const e = eng.rows[0];
  if (!e) throw new AppError(404, 'not_found', 'Engagement not found.');
  if (e.service_line !== 'attest') {
    throw new AppError(
      400,
      'not_an_attest_engagement',
      'An Engagement Addendum belongs to an attest engagement. This engagement is on the ' +
        `${e.service_line} line.`
    );
  }
  if (input.feeBasis === 'hourly' && (input.estimatedHours === undefined || input.estimatedHours <= 0)) {
    throw new AppError(
      400,
      'estimated_hours_required',
      'An hourly attest fee needs an estimated number of hours — "hourly, hours unknown" is not agreed terms under AU-C 210 / AR-C 90.'
    );
  }

  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions
     WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
     ORDER BY version_number DESC LIMIT 1`
  );
  if (!version.rows[0]) throw new AppError(500, 'price_book_missing', 'No price book version in force.');
  const versionId = version.rows[0].id;

  const warnings: string[] = [];
  const feeItemCode = input.feeBasis === 'hourly'
    ? (input.hourlyItemCode ?? 'IND_SPECIALIZED_HOURLY')
    : FEE_ITEM_FOR[input.engagementType];
  const fee = await priceOf(app, versionId, feeItemCode);
  const deposit = await priceOf(app, versionId, input.depositItemCode);

  // A price still awaiting Brian's confirmation is not refused — it is surfaced,
  // because an attest fee is negotiated per engagement anyway and he is the one
  // quoting it. Silence would be the problem.
  for (const [code, p] of [[feeItemCode, fee], [input.depositItemCode, deposit]] as const) {
    if (p.needsConfirmation) {
      warnings.push(`Price-book item '${code}' is still flagged ⚠ awaiting confirmation (${p.nameEn}).`);
    }
  }

  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO attest_addenda
       (engagement_id, contact_id, entity_business_id, entity_name, engagement_type,
        statements_and_periods, reporting_framework, price_book_version_id, fee_item_code,
        fee_basis, fee_fixed_cents, fee_hourly_rate_cents, estimated_hours, deposit_cents,
        expected_report_date, created_by_staff_id)
     VALUES ($1,$2,$3,$4,$5::attest_engagement_type,$6,$7,$8,$9,$10::attest_fee_basis,
             $11,$12,$13,$14,$15::date,$16)
     RETURNING id`,
    [
      input.engagementId, e.contact_id, input.entityBusinessId ?? null, input.entityName.trim(),
      input.engagementType, input.statementsAndPeriods.trim(), input.reportingFramework.trim(),
      versionId, feeItemCode, input.feeBasis,
      input.feeBasis === 'fixed' ? fee.amountCents : null,
      input.feeBasis === 'hourly' ? fee.amountCents : null,
      input.feeBasis === 'hourly' ? input.estimatedHours : null,
      deposit.amountCents, input.expectedReportDate, actor.id,
    ]
  );

  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'attest.addendum_created', objectType: 'attest_addendum', objectId: rows[0]!.id,
    contactId: e.contact_id,
    details: {
      engagement_id: input.engagementId,
      engagement_type: input.engagementType,
      fee_item_code: feeItemCode,
      fee_basis: input.feeBasis,
      deposit_item_code: input.depositItemCode,
      price_book_version_id: versionId,
      warnings,
    },
  });

  return { id: rows[0]!.id, feeCents: fee.amountCents, depositCents: deposit.amountCents, warnings };
}
