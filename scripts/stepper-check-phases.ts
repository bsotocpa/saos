/*
 * THE PHASES THE STEPPER DRAWS FOR A CLIENT'S RETURNS (Brian, 2026-09-29, the R50 v3 approval).
 *
 * Reads the JSON apps/api/scripts/stepper-check.ts printed on the box (the stepper's own route
 * output), builds the component's StepperInput from it the way components/return-stepper.tsx does,
 * and runs the Ops lib's buildSteps / buildPhases over it: the same functions the page renders from.
 * Prints forms, years and phase states only, " | "-separated for scripts/report-table.mjs --from-log.
 *
 *   node scripts/stepper-check-phases.ts <stepper-check.json>
 */
import { readFileSync } from 'node:fs';
import { buildPhases, buildSteps, currentStep, type StepperInput } from '../apps/internal/lib/return-stepper.ts';

const raw = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  switches: { returnStepper?: string };
  returns: Array<{ taxYear: number; returnType: string; detail: Record<string, any> }>;
};

console.log('return | stepper switch | stage | phases (done / current / future) | current step | steps drawn');
for (const r of raw.returns) {
  const d = r.detail;
  const te = d.taxEngagement;
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
    stageHistory: d.stageHistory ?? [],
    activity: d.activity ?? [],
    f8879_sent: d.f8879_sent ?? null,
    signed_authorization_on_file: Boolean(d.signed_authorization_on_file),
    assigned_preparer: d.assigned_preparer ?? null,
    preparer_of_record: te.preparer_of_record ?? null,
    jurisdictions: d.jurisdictions ?? [],
    final_fee_invoice: d.final_fee_invoice ?? null,
    legal_next_stages: d.legal_next_stages ?? [],
  };
  const steps = buildSteps(input);
  const phases = buildPhases(steps);
  const cur = currentStep(steps);
  const states = phases.map((p) => `${p.label} ${p.state}`).join(', ');
  const drawn = phases.filter((p) => p.state === 'current').reduce((n, p) => n + p.steps.length, 0);
  console.log(`${r.taxYear} ${r.returnType.toUpperCase()} | ${raw.switches.returnStepper ?? 'unknown'} | ${te.stage} | ${states} | ${cur ? cur.label : 'none (completed)'} | ${drawn}`);
}
