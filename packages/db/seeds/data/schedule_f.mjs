// SCHEDULE F — ATTEST (SOTO_Schedule_F_Attest_FINALFORM.docx), loaded verbatim.
//
// ⚠ THE PLACEHOLDER FLAG IS DELIBERATELY LEFT SET. Brian said the document is
// attorney-cleared with no redlines. The document's own first two lines say:
//
//     "SOTO ACCOUNTING LLC — SCHEDULE F (ATTEST) — FOR ATTORNEY REDLINE"
//     "... No open items — ready for redline."
//
// "ready FOR redline" is not "redlined and cleared". That may simply be stale
// header text on the draft he sent to the attorney — the filename does say
// FINALFORM — but the two readings differ on whether an attorney has actually
// signed off on the terms governing the firm's highest-liability work.
//
// Clearing the flag is a one-word confirmation from Brian and a one-line change
// here. Loading the text with the flag ON gets everything else built and tested
// now, and the gate guarantees nothing reaches a client in the meantime.
//
// Everything else Brian asked for IS done: Schedule F exists, attest is
// assemblable, the Addendum is required, and the Spanish translation is queued.

const SCHEDULE_F = `SCHEDULE F — ATTEST SERVICES (CPA REVIEW AND AUDIT)

As configured in your engagement, we will perform one of the following attest engagements with respect to the financial statements of the entity identified in the applicable Engagement Addendum: (i) a review of financial statements conducted in accordance with Statements on Standards for Accounting and Review Services (SSARS) issued by the AICPA; or (ii) an audit of financial statements conducted in accordance with auditing standards generally accepted in the United States of America (GAAS); or (iii) a workers' compensation or payroll insurance audit as specified. Each attest engagement is documented by an Engagement Addendum stating the entity, the financial statements and period(s) covered, the applicable financial reporting framework, and the fee.

Independence

We may accept an attest engagement only where we are independent of the entity within the meaning of applicable professional standards. Where the Firm provides bookkeeping, payroll, management, or other nonattest services to the entity, independence may be impaired and we may be required to decline the attest engagement or refer it to another firm; we will notify you promptly if so.

For any permitted nonattest services performed alongside an attest engagement, you agree to assume all management responsibilities; to oversee those services by designating an individual with suitable skill, knowledge, or experience; to evaluate the adequacy and results of the services; and to accept responsibility for them.

Management's responsibilities

Management is responsible for the preparation and fair presentation of the financial statements in accordance with the applicable framework; for the design, implementation, and maintenance of internal control relevant to their preparation; for the prevention and detection of fraud; and for compliance with applicable laws and regulations.

Management will provide us access to all information relevant to the engagement, additional information we request, and unrestricted access to persons within the entity, and will provide a signed representation letter at the conclusion of the engagement. Our report is conditioned on receipt of that letter.

Nature and limitations of the engagement

A review consists primarily of analytical procedures and inquiries and provides limited assurance; it is substantially less in scope than an audit, and we will not express an audit opinion.

An audit will be conducted in accordance with auditing standards generally accepted in the United States of America (US GAAS), which require that we plan and perform the audit to obtain reasonable — not absolute — assurance about whether the financial statements are free from material misstatement. An audit involves performing procedures to obtain evidence about the amounts and disclosures in the financial statements; the procedures selected depend on our judgment, including assessment of the risks of material misstatement, whether due to fraud or error. An audit also includes evaluating the appropriateness of accounting policies used and the reasonableness of significant estimates made by management, and the overall presentation of the financial statements. Because of the inherent limitations of an audit, together with the inherent limitations of internal control, an unavoidable risk exists that some material misstatements may not be detected, even though the audit is properly planned and performed in accordance with US GAAS.

In making our risk assessments, we consider internal control relevant to the entity's preparation and fair presentation of the financial statements in order to design appropriate procedures, but not for the purpose of expressing an opinion on the effectiveness of internal control.

We will communicate to you, as required by professional standards, significant matters arising from the engagement, including significant deficiencies or material weaknesses in internal control that come to our attention.

Reports and distribution

Upon completion we will issue the written report required by the applicable standards, addressed as appropriate (for audits, to the board of directors or equivalent). We cannot provide assurance that an unmodified opinion or conclusion will be expressed; circumstances may require us to modify our report, add emphasis-of-matter or other-matter paragraphs, or withdraw from the engagement, and we will discuss any such circumstances with you. You remain responsible for fees incurred through that date.

Our report and the financial statements it accompanies are for the use described in the report. You may not reproduce, excerpt, or distribute our report except in full, and any use in offering documents or regulatory filings requires our prior written consent.

Fees

Attest fees are per the applicable Engagement Addendum, quoted from our current fee schedule (fixed-fee or hourly with an estimated range, as stated in the Addendum), plus direct out-of-pocket expenses and applicable taxes. A deposit/retainer stated in the Addendum is due at acceptance and is reconciled against final billing under the Master Engagement Agreement. Late charges and suspension of work for nonpayment are governed by the Master; if we suspend or withdraw due to nonpayment, we are not liable for any damages arising from ceasing to render services. The Master's limitation-of-liability and dispute-resolution provisions apply to attest engagements except to the extent limited by applicable law or professional standards.

ENGAGEMENT ADDENDUM (per attest engagement)

Entity: {{entity_name}}
Engagement type: {{engagement_type}}
Financial statements and period(s) covered: {{statements_and_periods}}
Reporting framework: {{reporting_framework}}
Fee: {{fee_summary}}
Deposit/retainer due at acceptance: {{deposit_summary}}
Expected report date: {{expected_report_date}}`;

const KEY = 'schedule_f_attest';

export async function seedScheduleF(client) {
  // The Addendum fields are filled from attest_addenda at render time, so the
  // variables are declared and something owns filling every one of them.
  const variables = [
    'entity_name', 'engagement_type', 'statements_and_periods',
    'reporting_framework', 'fee_summary', 'deposit_summary', 'expected_report_date',
  ];

  const existing = await client.query(`SELECT key, is_placeholder FROM templates WHERE key = $1`, [KEY]);
  if (existing.rows[0]) {
    await client.query(
      `UPDATE templates
       SET body_en = $2, variables = $3::jsonb, kind = 'schedule', schedule_code = 'F',
           is_active = true, needs_es_review = true, version = version + 1
       WHERE key = $1`,
      [KEY, SCHEDULE_F, JSON.stringify(variables)]
    );
  } else {
    await client.query(
      `INSERT INTO templates
         (key, name, channel, body_en, body_es, is_placeholder, variables,
          kind, schedule_code, is_active, needs_es_review)
       VALUES ($1, 'Schedule F — Attest (CPA Review and Audit)', 'document', $2, NULL,
               true, $3::jsonb, 'schedule', 'F', true, true)`,
      [KEY, SCHEDULE_F, JSON.stringify(variables)]
    );
  }

  await client.query(
    `INSERT INTO service_schedules (schedule_code, template_key, title, service_lines, sort_order)
     VALUES ('F', $1, 'Schedule F — Attest (CPA Review and Audit)', ARRAY['attest']::service_line[], 60)
     ON CONFLICT (schedule_code) DO UPDATE SET
       template_key = EXCLUDED.template_key,
       title = EXCLUDED.title,
       service_lines = EXCLUDED.service_lines,
       sort_order = EXCLUDED.sort_order`,
    [KEY]
  );

  const flag = await client.query(`SELECT is_placeholder FROM templates WHERE key = $1`, [KEY]);
  return `Schedule F: loaded (${flag.rows[0].is_placeholder ? 'PLACEHOLDER still set — awaiting Brian on the "FOR ATTORNEY REDLINE" header' : 'final'}), mapped to the attest service line, ES queued`;
}
