// SOTO ACCOUNTING LLC — LEGAL TEXT PACKAGE — FINAL v3 (MASTER + SCHEDULES)
//
// Attorney-reviewed final text, loaded VERBATIM from
// migration-data/SOTO_Legal_Text_Package_FINAL_v3.docx. Do not edit the English
// bodies here — Brian edits legal text in Admin → Templates, which creates a new
// version and leaves this seed alone (ON CONFLICT DO NOTHING).
//
// Architecture: one Master Engagement Agreement signed once; Schedules A–E attach
// per services selected; the two §7216 consents are presented separately and
// optionally, after the engagement signature.
//
// SPANISH: v3 states "English text controls; Spanish translations to follow." So
// every body below ships with body_es = NULL and needs_es_review = true. The render
// path falls back to English rather than sending unapproved Spanish, and the
// translation queue in Admin lists exactly what is waiting on Brian.

const FIRM = 'Soto Accounting LLC, 4252 N. Cicero Ave., Chicago, IL 60641 · (312) 715-8599 · sotoaccounting.com';

const SIGNATURE_BLOCK =
  '\n\nClient signature: ____________________________________    Date: ______________\n' +
  'Printed name / Entity and title: ____________________________________\n' +
  'SOTO ACCOUNTING LLC — By: ____________________________________';

export const MASTER_KEY = 'engagement_master';

const MASTER_BODY = `MASTER ENGAGEMENT AGREEMENT
${FIRM}

This Master Engagement Agreement ("Agreement") is between Soto Accounting LLC ("we," "us," "the Firm") and the client identified below ("you," "Client"), and governs all professional services we provide to you. The specific services you have engaged are described in the Service Schedules attached to or later added under this Agreement. Each Schedule incorporates this Agreement; if a Schedule conflicts with this Agreement, the Schedule controls for that service.

1. Engagement structure
Your signature below constitutes acceptance of this Agreement and every Service Schedule attached at signing. Services added later are engaged by your electronic acceptance of the applicable Schedule through the client portal, without re-execution of this Agreement.

2. Fees, quotes, deposits, and reconciliation
Fees for each service are set out in your fee quote and engagement configuration, based on our current fee schedule. Where a deposit is collected when you accept a quote, all completed work is reconciled against your deposit at invoicing: overpayments are credited to your account and any remaining balance is billed. The Firm may, in its discretion, reduce or waive a deposit; any such accommodation does not modify the fees for the services performed. Deposits for engagements that do not proceed are held as account credit and addressed individually; deposits are not automatically forfeited. Recurring plans are billed automatically in advance on your plan cadence; plan changes take effect the following billing cycle. Software subscriptions procured for you are billed as pass-through costs.

3. Late charges; suspension
Invoices are due upon presentation. Any balance remaining unpaid more than thirty (30) days past the invoice date accrues a late charge of one and one-half percent (1.5%) per month (18% per annum), applied to the outstanding balance after all deposits and credits. We may suspend work while an invoice remains more than thirty (30) days past due; we will notify you before any suspension takes effect.

4. Client portal; electronic records and signatures
Our engagement is administered through the Soto Accounting secure client portal. You agree to exchange documents through the portal rather than by email or text-message attachment; documents received outside the portal may be transferred into your portal file. You consent to receive records, notices, invoices, and disclosures electronically and to the use of electronic signatures (E-SIGN Act / UETA). For IRS e-file authorizations (Form 8879) signed remotely, you agree to complete identity verification (knowledge-based authentication) as required by IRS Publication 1345; in-person signature remains available on request.

5. Communications
With your consent provided at onboarding, we may communicate with you by email, portal message, and SMS regarding your account, appointments, and documents. Message frequency varies; message and data rates may apply; reply STOP to opt out of SMS at any time. SMS terms and our privacy policy: sotoaccounting.com/sms-terms and sotoaccounting.com/privacy.

6. Confidentiality; §7216
Each party will protect the other's confidential information with no less than reasonable care, use it only as necessary to perform under this Agreement, and limit access to personnel who need it. Our use and disclosure of your tax return information is further restricted by IRC §7216; we will not use or disclose your tax return information except as authorized by law or by your separate written consent.

7. Records
Original records you provide will be returned to you or maintained in your portal file. Our workpapers remain our property. We retain engagement records for seven (7) years, after which they may be destroyed.

8. Termination
Either party may terminate this Agreement or any Schedule by written notice. You remain responsible for fees and costs incurred through termination, reconciled against deposits and credits.

9. Limitation of liability; indemnification; governing law; dispute resolution
(a) Limitation of liability. To the maximum extent permitted by law, the total aggregate liability of the Firm and its partners, principals, employees, and agents (the "Firm Parties") to the Client or any third party for any claims, damages, losses, costs, or expenses (including reasonable attorneys' fees) arising out of or relating to this Agreement or the services — regardless of the theory of recovery, whether contract, tort (including negligence), professional malpractice, or otherwise — is limited to the professional fees actually paid by the Client for the specific services giving rise to the claim. In no event are the Firm Parties liable for consequential, incidental, indirect, punitive, exemplary, or special damages, or for lost profits, lost data, loss of goodwill, or business interruption, even if advised of their possibility. These limitations are a fundamental inducement to the Firm's performance of the services and survive completion, expiration, or termination of the engagement.
(b) Indemnification. The Client will indemnify, defend, and hold harmless the Firm Parties from and against third-party claims, liabilities, losses, damages, costs, and expenses (including reasonable attorneys' fees) arising out of (i) the Client's failure to provide accurate, complete, and timely information, documentation, or representations; (ii) misrepresentation, fraud, or intentional omission by the Client, its management, or its agents; or (iii) the Client's unauthorized distribution or publication of the Firm's reports, deliverables, or work product — except to the extent a final, non-appealable judgment of a court or arbitration panel determines the claim resulted directly from the gross negligence, willful misconduct, or bad faith of the Firm.
(c) Governing law; venue. This Agreement and all claims or controversies arising out of or relating to the engagement (contractual or non-contractual) are governed by the laws of the State of Illinois, without regard to conflict-of-law rules. Subject to paragraph (d), any permitted judicial proceeding shall be brought exclusively in the state or federal courts located in Chicago, Cook County, Illinois, and each party irrevocably submits to their exclusive personal jurisdiction.
(d) Dispute resolution. The parties will first attempt in good faith to resolve any dispute by negotiation between principals with settlement authority; if unresolved within thirty (30) days of written notice, by non-binding mediation administered by the American Arbitration Association ("AAA") under its Commercial Mediation Procedures in Chicago, Illinois, with the mediator's fees shared equally; and if still unresolved sixty (60) days after mediation commences, by final and binding arbitration administered by the AAA under its Commercial Arbitration Rules in Chicago, Illinois, before a single neutral arbitrator who is a retired judge or an attorney with at least fifteen (15) years' experience in accounting law or professional-liability disputes. The arbitrator has no authority to award damages excluded by paragraph (a). Judgment on the award may be entered in any court of competent jurisdiction.
(e) WAIVER OF JURY TRIAL AND CLASS ACTIONS. EACH PARTY IRREVOCABLY WAIVES, TO THE FULLEST EXTENT PERMITTED BY LAW, ANY RIGHT TO TRIAL BY JURY IN RESPECT OF ANY DISPUTE, AND THE CLIENT AGREES THAT ALL CLAIMS MUST BE BROUGHT IN AN INDIVIDUAL CAPACITY AND NOT AS A PLAINTIFF OR CLASS MEMBER IN ANY PURPORTED CLASS, REPRESENTATIVE, OR COLLECTIVE PROCEEDING.

10. Entire agreement
This Agreement together with its Schedules, your fee quote, and your engagement configuration constitutes the entire agreement for the services described and supersedes prior engagement letters for those services.

Service Schedules attached at signing: {{schedules_attached}}${SIGNATURE_BLOCK}`;

const SCHEDULE_A = `SCHEDULE A — INDIVIDUAL INCOME TAX PREPARATION

We will prepare your federal and state individual income tax returns for the tax year(s) identified in your engagement configuration, based on information you provide. Our work does not include procedures to discover irregularities or inaccuracies in the information you provide. Additional years (including prior unfiled years), additional states, amendments, and taxing-authority notice responses are separate services quoted from our current fee schedule.

You will provide all information related to income and deductions and respond timely to our requests so returns can be completed by their due dates.

You will maintain appropriate records: official tax documents, receipts and substantiation for deductions, and purchase/sale information for assets.

You will review your returns before filing; timely filing is your responsibility. Where documents remain outstanding near a deadline, we may recommend and, with notice to you, prepare a protective extension.

If your returns are selected for review or audit, we can assist or represent you at your request; such assistance is billed per our current fee schedule and is not included in preparation fees.`;

const SCHEDULE_B = `SCHEDULE B — BUSINESS INCOME TAX PREPARATION

We will prepare the entity's federal and state income tax returns and accompanying schedules (including owner Schedules K-1, as applicable) for the year(s) in your engagement configuration, based on the trial balance, financial statements, and information you provide. We may propose adjusting entries necessary for tax reporting; recording them remains your responsibility unless bookkeeping services are also engaged (Schedule C). Additional years, states, amendments, elections (including Form 2553), and notice responses are separately quoted.

Management is responsible for the accuracy and completeness of the financial records. Our preparation is not an audit, review, or compilation and cannot be relied upon to detect errors, fraud, or other illegal acts.

You will review returns before filing and before signing the e-file authorization. Where documents remain outstanding near a deadline, we may recommend and, with notice, prepare a protective extension.

Where the entity holds an S-corporation election, maintaining reasonable owner compensation is your responsibility; compensation analysis is available under Schedule D.

Related entities engaged together may elect one consolidated invoice itemized per entity, or separate invoices per entity, changeable prospectively at any time.`;

const SCHEDULE_C = `SCHEDULE C — BOOKKEEPING & RECURRING ACCOUNTING

On the preparation cadence in your engagement configuration (weekly / monthly / quarterly / semi-annual), we will: reconcile bank and card accounts and record correcting entries with notice to you; review and reconcile general ledger accounts; record necessary journal entries; prepare and post financial statements to your portal at each period close; and, if selected, prepare sales tax returns, review and reconcile payroll records, and set up accounting/payroll systems with a basic walk-through.

On the session cadence in your engagement configuration, we will meet with you to review financial statements and discuss tax strategy and business matters; session recaps summarizing decisions and action items are provided through your portal. Clients with an active S-corporation election maintain a minimum of two CPA sessions per year.

This engagement is limited to the periods and services configured; catch-up or cleanup work is quoted separately at our hourly rate.

This is not business management; we do not review the payment of invoices or bills, though we will call unusual items to your attention.

This is not an audit or review under generally accepted auditing standards and no opinion is expressed; please do not refer to our work as an audit or review.

We rely on the accuracy and completeness of records you provide and cannot be relied upon to disclose errors, fraud, or other illegal acts, though we will inform you of material items that come to our attention. We have no responsibility to identify deficiencies in your internal controls.`;

const SCHEDULE_D = `SCHEDULE D — ADVISORY / CFO SERVICES

As configured, advisory services may include: financial-statement review and interpretation; tax planning and projections; entity-structure analysis (including S-corporation election analysis and owner-compensation calculation); budgeting, forecasting, and margin analysis; loan and funding readiness and due-diligence support; CPA letters of confirmation; and business advisory delivered in scheduled sessions with portal recaps.

Advisory services are consultative; decisions and their implementation and outcomes remain solely yours.

Projections and forecasts are estimates based on assumptions and information you provide; actual results will vary and no assurance is expressed on prospective financial information.

Advisory services are not an audit, review, or compilation, and are not legal or investment advice; engagements with referred professionals are directly between you and the provider.`;

const SCHEDULE_E = `SCHEDULE E — ENTITY FORMATION & COMPLIANCE

As configured, we will prepare and submit: Illinois entity formation filings with EIN application; 501(c)(3) exemption application (Form 1023); annual report filings; articles of amendment; assumed name (DBA) registration; and/or beneficial ownership information (BOI) reporting. Copies of all filings are provided through your portal, and applicable renewal deadlines are tracked with reminders while you remain an active client.

We are not a law firm and do not provide legal advice; formation documents use standard forms based on information you provide. Entity choice and governance terms may have legal consequences; we recommend consulting an attorney and can refer you to qualified counsel.

Government processing times are outside our control; government filing fees are your responsibility, billed as pass-through costs.

You are responsible for the accuracy of information provided for filings, including beneficial-ownership information, and for maintaining your entity's good standing.`;

const CONSENT_USE = `CONSENT TO USE OF TAX RETURN INFORMATION (IRC §7216)

This consent is presented separately from your engagement documents, is entirely optional, and is not a condition of any service.

Federal law requires this consent form be provided to you. Unless authorized by law, we cannot use your tax return information for purposes other than the preparation and filing of your tax return without your consent.

You are not required to complete this form to engage our tax return preparation services. If we obtain your signature on this form by conditioning our tax return preparation services on your consent, your consent will not be valid. If you agree to the use of your tax return information, your consent is valid for the amount of time that you specify. If you do not specify the duration of your consent, your consent is valid for one year from the date of signature.

Tax return preparer using the information: Soto Accounting LLC.

Information to be used: information contained in your tax returns and supporting records, including entity type, income and expense composition, payroll and contractor activity, and filing history.

Purpose: to evaluate and inform you of accounting, tax-planning, entity-structure (including S-corporation election analysis), bookkeeping, payroll, advisory, and educational services offered by Soto Accounting LLC or by Hilo NFP that may benefit you or your business.

Duration of consent: This consent is valid for one (1) year from the date of signature below, unless a different period is specified here: ______________. You may revoke this consent at any time by written notice to Soto Accounting LLC.

If you believe your tax return information has been disclosed or used improperly in a manner unauthorized by law or without your permission, you may contact the Treasury Inspector General for Tax Administration (TIGTA) by telephone at 1-800-366-4484, or by email at complaints@tigta.treas.gov.${SIGNATURE_BLOCK}`;

const CONSENT_DISCLOSE = `CONSENT TO DISCLOSURE OF TAX RETURN INFORMATION (IRC §7216)

This consent is presented separately from your engagement documents, is entirely optional, and is not a condition of any service.

Federal law requires this consent form be provided to you. Unless authorized by law, we cannot disclose your tax return information to third parties for purposes other than the preparation and filing of your tax return without your consent. If you consent to the disclosure of your tax return information, Federal law may not protect your tax return information from further use or distribution.

You are not required to complete this form to engage our tax return preparation services. If we obtain your signature on this form by conditioning our tax return preparation services on your consent, your consent will not be valid. If you agree to the disclosure of your tax return information, your consent is valid for the amount of time that you specify. If you do not specify the duration of your consent, your consent is valid for one year from the date of signature.

Preparer making the disclosure: Soto Accounting LLC, 4252 N. Cicero Ave., Chicago, IL 60641.

Recipient: Hilo NFP (formerly DishRoulette Kitchen NFP), 917 W. 18th St., Chicago, IL 60606.

Information to be disclosed: your name, contact information, business/entity name and type, and a general description of your accounting, tax, or business-development needs.

Purpose: to coordinate business-development programming, education, grants, and referral services offered by Hilo NFP that you may be eligible for or have requested.

Duration of consent: This consent is valid for one (1) year from the date of signature below, unless a different period is specified here: ______________. You may revoke this consent at any time by written notice to Soto Accounting LLC.

If you believe your tax return information has been disclosed or used improperly in a manner unauthorized by law or without your permission, you may contact the Treasury Inspector General for Tax Administration (TIGTA) by telephone at 1-800-366-4484, or by email at complaints@tigta.treas.gov.${SIGNATURE_BLOCK}`;

/**
 * Schedules and the service lines each covers.
 *
 * ATTEST IS DELIBERATELY ABSENT. v3 defines Schedules A–E and none of them covers
 * CPA review/audit work. Rather than attach attest work to Advisory terms it does
 * not belong under, packet assembly REFUSES an attest engagement and says why —
 * Cristian's attest work needs its own schedule from the attorney.
 */
export const SCHEDULES = [
  {
    code: 'A', key: 'schedule_a_individual_tax', title: 'Schedule A — Individual Tax',
    body: SCHEDULE_A, serviceLines: ['tax'],
  },
  {
    // serviceLines is EMPTY on purpose. Both individual and business tax are the
    // same service_line ('tax') — the A-vs-B split is by RETURN TYPE, which the
    // packet assembler resolves (BUSINESS_RETURN_TYPES in engagements/packet.ts).
    // A client filing a 1040 and an 1120-S gets both A and B.
    code: 'B', key: 'schedule_b_business_tax', title: 'Schedule B — Business Tax',
    body: SCHEDULE_B, serviceLines: [],
  },
  {
    code: 'C', key: 'schedule_c_bookkeeping', title: 'Schedule C — Bookkeeping & Recurring Accounting',
    body: SCHEDULE_C, serviceLines: ['bookkeeping', 'payroll', 'sales_tax'],
  },
  {
    code: 'D', key: 'schedule_d_advisory', title: 'Schedule D — Advisory / CFO',
    body: SCHEDULE_D, serviceLines: ['advisory', 'coo', 'nonprofit_cfo', 'specialized_cpa'],
  },
  {
    code: 'E', key: 'schedule_e_entity', title: 'Schedule E — Entity Formation & Compliance',
    body: SCHEDULE_E, serviceLines: ['entity'],
  },
];

const LEGAL_TEMPLATES = [
  {
    key: MASTER_KEY,
    name: 'Master Engagement Agreement (v3 FINAL)',
    kind: 'master',
    scheduleCode: null,
    body: MASTER_BODY,
    variables: ['schedules_attached'],
    // Master §3 carries the late-charge disclosure: 1.5%/month after 30 days,
    // which matches LATE_FEE_MONTHLY metadata in the price book exactly. Verified
    // before setting this flag — a flag on a body without the block is a false gate.
    hasLateFeeDisclosure: true,
    // The rate the body actually discloses, machine-readable (finding #25). The CHECK
    // ties the two together, so a Master can never disclose a late fee at no stated
    // rate — and the assessment caps every charge at the rate the client signed.
    lateFeeRatePercent: 1.5,
  },
  ...SCHEDULES.map((s) => ({
    key: s.key,
    name: `${s.title} (v3 FINAL)`,
    kind: 'schedule',
    scheduleCode: s.code,
    body: s.body,
    variables: [],
    hasLateFeeDisclosure: false,
    lateFeeRatePercent: null,
  })),
  {
    key: 'consent_7216_use',
    name: 'Consent to USE of tax return information (§7216, v3 FINAL)',
    kind: 'consent',
    scheduleCode: null,
    body: CONSENT_USE,
    variables: [],
    hasLateFeeDisclosure: false,
  },
  {
    key: 'consent_7216_disclose',
    name: 'Consent to DISCLOSURE to Hilo NFP (§7216, v3 FINAL)',
    kind: 'consent',
    scheduleCode: null,
    body: CONSENT_DISCLOSE,
    variables: [],
    hasLateFeeDisclosure: false,
  },
];

/** The five letters v3 replaces. Retired, never deleted. */
const RETIRED = [
  'engagement_letter_tax',
  'engagement_letter_bookkeeping',
  'engagement_letter_advisory',
  'engagement_letter_coo',
  'engagement_letter_entity',
];

export async function seedLegalV3(client) {
  let inserted = 0;
  let updated = 0;

  for (const t of LEGAL_TEMPLATES) {
    // The two consent keys already exist as PLACEHOLDERS. For those we UPDATE in
    // place — the whole point of this load is replacing placeholder text with
    // final text and clearing the flag. Everything else inserts fresh.
    const existing = await client.query(`SELECT key, is_placeholder FROM templates WHERE key = $1`, [t.key]);
    if (existing.rows.length > 0) {
      if (!existing.rows[0].is_placeholder) continue; // already final — admin edits win
      await client.query(
        `UPDATE templates
         SET name = $2, channel = 'document', body_en = $3, body_es = NULL,
             is_placeholder = false, needs_es_review = true,
             kind = $4::template_kind, schedule_code = $5,
             variables = $6::jsonb, has_late_fee_disclosure = $7,
             late_fee_rate_percent = $8,
             version = version + 1, updated_at = now()
         WHERE key = $1`,
        [t.key, t.name, t.body, t.kind, t.scheduleCode, JSON.stringify(t.variables), t.hasLateFeeDisclosure, t.lateFeeRatePercent ?? null]
      );
      updated += 1;
      continue;
    }
    await client.query(
      `INSERT INTO templates (key, name, channel, body_en, body_es, is_placeholder, variables,
                              has_late_fee_disclosure, kind, schedule_code, needs_es_review,
                              late_fee_rate_percent)
       VALUES ($1, $2, 'document', $3, NULL, false, $4::jsonb, $5, $6::template_kind, $7, true, $8)
       ON CONFLICT (key) DO NOTHING`,
      [t.key, t.name, t.body, JSON.stringify(t.variables), t.hasLateFeeDisclosure, t.kind, t.scheduleCode, t.lateFeeRatePercent ?? null]
    );
    inserted += 1;
  }

  for (const s of SCHEDULES) {
    await client.query(
      `INSERT INTO service_schedules (schedule_code, template_key, title, service_lines, sort_order)
       VALUES ($1, $2, $3, $4::service_line[], $5)
       ON CONFLICT (schedule_code) DO UPDATE
         SET template_key = EXCLUDED.template_key, title = EXCLUDED.title,
             service_lines = EXCLUDED.service_lines`,
      [s.code, s.key, s.title, s.serviceLines, s.code.charCodeAt(0) - 64]
    );
  }

  // Retire the five superseded letters. Kept for the record: they are the terms
  // any historical engagement was signed under.
  const retired = await client.query(
    `UPDATE templates
     SET is_active = false, retired_at = now(),
         retired_reason = 'Superseded by the Master Engagement Agreement + Schedules A–E (legal package v3 FINAL).'
     WHERE key = ANY($1) AND is_active`,
    [RETIRED]
  );

  return (
    `legal v3: ${inserted} inserted, ${updated} placeholder(s) replaced with final text, ` +
    `${SCHEDULES.length} schedules mapped, ${retired.rowCount} old letter(s) retired ` +
    `(all ES bodies queued for Brian's approval)`
  );
}
