// Forms engine (OF spec): definition-driven validation (conditional logic
// exactly as specced — hidden fields are never required, selects validate
// against admin-editable options), Form 1/2 submit processors (intake
// automation #1), and the Form 5 module-assembly + flag rules.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { ensurePortalUser, issueMagicLink } from '../portal-auth/service.ts';
import { refreshEnrichmentGaps } from '../crm/service.ts';
import { createEnvelope, templateKeyFor } from '../signatures/service.ts';
import { createPllcConversion } from '../entity/service.ts';
import { runSosCheck } from '../entity/sos.ts';

type Answers = Record<string, unknown>;

interface FieldDef {
  key: string;
  type: string;
  required?: boolean | { field: string; equals?: string; includesAny?: string[] };
  showWhen?: { field: string; equals?: string; in?: string[]; includesAny?: string[] };
  options?: Array<{ value: string }>;
}

interface FormDefinition {
  slug: string;
  screens: Array<{ id: number; fields: FieldDef[] }>;
}

function conditionMet(cond: { field: string; equals?: string; in?: string[]; includesAny?: string[] }, answers: Answers): boolean {
  const value = answers[cond.field];
  if (cond.equals !== undefined) return value === cond.equals;
  if (cond.in !== undefined) return typeof value === 'string' && cond.in.includes(value);
  if (cond.includesAny !== undefined) {
    return Array.isArray(value) && value.some((v) => cond.includesAny!.includes(String(v)));
  }
  return false;
}

/** Validate answers against a definition. Returns sanitized issues (paths only). */
export function validateSubmission(definition: FormDefinition, answers: Answers): Array<{ field: string; issue: string }> {
  const issues: Array<{ field: string; issue: string }> = [];
  for (const screen of definition.screens) {
    for (const field of screen.fields) {
      const visible = !field.showWhen || conditionMet(field.showWhen, answers);
      const value = answers[field.key];
      if (!visible) continue;

      const isRequired =
        field.required === true ||
        (typeof field.required === 'object' && field.required !== null && conditionMet(field.required as never, answers));
      const empty =
        value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0) ||
        (field.type === 'checkbox' && value !== true);
      if (isRequired && empty) {
        issues.push({ field: field.key, issue: 'required' });
        continue;
      }
      if (empty) continue;

      if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) {
        issues.push({ field: field.key, issue: 'invalid_email' });
      }
      if (field.type === 'zip' && !/^\d{5}$/.test(String(value))) {
        issues.push({ field: field.key, issue: 'invalid_zip' });
      }
      if (field.type === 'select' && field.options && !field.options.some((o) => o.value === value)) {
        issues.push({ field: field.key, issue: 'invalid_option' });
      }
      if (field.type === 'multiselect' && field.options) {
        const allowed = new Set(field.options.map((o) => o.value));
        if (!Array.isArray(value) || value.some((v) => !allowed.has(String(v)))) {
          issues.push({ field: field.key, issue: 'invalid_option' });
        }
      }
    }
  }
  return issues;
}

/** Strip client attempts to write server-reserved keys (underscore namespace). */
export function sanitizeAnswers(answers: Answers): Answers {
  return Object.fromEntries(Object.entries(answers).filter(([k]) => !k.startsWith('_')));
}

export async function loadDefinition(app: FastifyInstance, key: string): Promise<{ id: string; version: number; definition: FormDefinition }> {
  const { rows } = await app.db.query<{ id: string; version: number; definition: FormDefinition }>(
    `SELECT id, version, definition FROM form_definitions
     WHERE key = $1 AND is_active ORDER BY version DESC LIMIT 1`,
    [key]
  );
  if (!rows[0]) throw new AppError(404, 'form_not_found', `Form '${key}' not found.`);
  return rows[0];
}

// ── Form 1: Soto intake (automation #1) ──────────────────────────────────────

const SERVICE_LINE_MAP: Record<string, string> = {
  bookkeeping: 'bookkeeping', payroll: 'payroll', sales_tax: 'sales_tax',
  entity: 'entity', cfo_advisory: 'advisory',
};

export async function processSotoIntake(app: FastifyInstance, submissionId: string, answers: Answers): Promise<{ contactId: string }> {
  const a = answers as Record<string, string | string[] | boolean | Array<{ name?: string; role?: string }>>;
  const email = String(a.email);
  const language = a.language === 'es' ? 'es' : 'en';

  // Duplicate detection: an existing contact by email is linked, not duplicated.
  const existing = await app.db.query<{ id: string }>(`SELECT id FROM contacts WHERE email = $1 LIMIT 1`, [email]);
  let contactId: string;
  if (existing.rows[0]) {
    contactId = existing.rows[0].id;
    await app.db.query(
      `UPDATE contacts SET
         phone = COALESCE(phone, $2), language = $3, preferred_contact_method = $4::contact_method,
         soto_status = CASE WHEN soto_status = 'none' THEN 'lead'::soto_status ELSE soto_status END,
         sms_consent = $5, sms_consent_at = CASE WHEN $5 THEN now() ELSE sms_consent_at END,
         communication_consent_at = now(), esign_consent_at = now(),
         how_heard = COALESCE(how_heard, $6), referred_by_text = COALESCE(referred_by_text, $7)
       WHERE id = $1`,
      [contactId, a.mobile_phone, language, a.preferred_contact_method, a.sms_ok === 'yes', a.how_heard, a.referred_by ?? null]
    );
  } else {
    const created = await app.db.query<{ id: string }>(
      `INSERT INTO contacts
         (first_name, last_name, email, phone, language, preferred_contact_method, soto_status,
          sms_consent, sms_consent_at, communication_consent_at, esign_consent_at,
          how_heard, referred_by_text, cpa_network_source, ssn_status)
       VALUES ($1,$2,$3,$4,$5,$6::contact_method,'lead',$7,CASE WHEN $7 THEN now() END,now(),now(),$8,$9,$10,$11::ssn_state)
       RETURNING id`,
      [
        a.first_name, a.last_name, email, a.mobile_phone, language, a.preferred_contact_method,
        a.sms_ok === 'yes', a.how_heard, a.referred_by ?? null,
        a.how_heard === 'cpa' ? 'intake' : null,
        a.ssn_preference === 'phone' ? 'provide_by_phone' : a.ssn_preference === 'on_file' ? 'on_file' : 'none',
      ]
    );
    contactId = created.rows[0]!.id;
  }

  // Hidden bridge fields — ONLY when the submission arrived via a verified
  // Hilo transition link (server-written; never client-supplied).
  const bridge = (answers as { _hilo?: { referringContactId?: string; referredByJackson?: boolean; staff?: string } })._hilo;
  if (bridge?.referringContactId) {
    const hilo = await app.db.query<{ hilo_status: string; hilo_first_contact: string | null }>(
      `SELECT hilo_status, hilo_first_contact::text AS hilo_first_contact FROM contacts WHERE id = $1`,
      [bridge.referringContactId]
    );
    await app.db.query(
      `UPDATE contacts SET br1_referred_by_hilo = true, br2_hilo_status_at_referral = $2,
              br3_referred_by_jackson = $3, br4_hilo_program_participant = true,
              br5_hilo_first_engagement = $4, br6_referring_staff = $5
       WHERE id = $1`,
      [contactId, hilo.rows[0]?.hilo_status ?? null, bridge.referredByJackson ?? false,
       hilo.rows[0]?.hilo_first_contact ?? null, bridge.staff ?? null]
    );
  }

  // Business (+ IL SOS check at intake, v4.2 #3).
  let businessId: string | null = null;
  if (a.owns_business === 'yes' || a.owns_business === 'starting') {
    if (a.business_name) {
      const biz = await app.db.query<{ id: string }>(
        `INSERT INTO businesses (name, entity_type, industry, years_in_business, revenue_range, employees_range, zip)
         VALUES ($1, $2::business_entity_type, $3, $4, $5, $6, $7) RETURNING id`,
        [a.business_name, (a.entity_type as string) ?? null, (a.industry as string) ?? null,
         a.years_in_business ?? null, a.revenue_range ?? null, a.employees_range ?? null, a.business_zip ?? null]
      );
      businessId = biz.rows[0]!.id;
      await app.db.query(
        `INSERT INTO business_members (business_id, contact_id, member_role, is_primary) VALUES ($1, $2, 'owner', true)`,
        [businessId, contactId]
      );
      await runSosCheck(app, businessId);
    }
    // Entity group (v4.2 #2): other co-owned businesses.
    const others = Array.isArray(a.other_businesses_list) ? (a.other_businesses_list as Array<{ name?: string; role?: string }>) : [];
    if (a.other_businesses === 'yes' && others.length > 0) {
      const group = await app.db.query<{ id: string }>(
        `INSERT INTO entity_groups (name) VALUES ($1) RETURNING id`,
        [`${a.first_name} ${a.last_name} — related entities`]
      );
      await app.db.query(`INSERT INTO entity_group_members (group_id, contact_id, member_role) VALUES ($1, $2, 'owner')`, [group.rows[0]!.id, contactId]);
      if (businessId) {
        await app.db.query(`INSERT INTO entity_group_members (group_id, business_id, member_role) VALUES ($1, $2, 'entity')`, [group.rows[0]!.id, businessId]);
      }
      for (const other of others) {
        if (!other.name) continue;
        const ob = await app.db.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ($1) RETURNING id`, [other.name]);
        await app.db.query(
          `INSERT INTO business_members (business_id, contact_id, member_role, is_primary) VALUES ($1, $2, $3, false)`,
          [ob.rows[0]!.id, contactId, other.role ?? 'co-owner']
        );
        await app.db.query(`INSERT INTO entity_group_members (group_id, business_id, member_role) VALUES ($1, $2, 'entity')`, [group.rows[0]!.id, ob.rows[0]!.id]);
      }
    }
  }
  await refreshEnrichmentGaps(app.db, contactId);

  // Service-line opportunities: tax → tax engagement; others → draft engagements.
  const services = Array.isArray(a.services) ? (a.services as string[]) : [];
  const currentTaxYear = new Date().getFullYear() - 1;
  if (services.includes('tax_personal') || services.includes('tax_business')) {
    const eng = await app.db.query<{ id: string }>(
      `INSERT INTO engagements (contact_id, business_id, service_line, status, title)
       VALUES ($1, $2, 'tax', 'active', $3) RETURNING id`,
      [contactId, services.includes('tax_business') ? businessId : null, `${currentTaxYear} intake`]
    );
    const te = await app.db.query<{ id: string }>(
      `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type)
       VALUES ($1, $2, $3::return_type, $4::tax_client_type) RETURNING id`,
      [eng.rows[0]!.id, currentTaxYear, services.includes('tax_business') && businessId ? '1120s' : '1040',
       services.includes('tax_business') ? 'business' : 'individual']
    );
    await app.db.query(
      `INSERT INTO engagement_stage_history (tax_engagement_id, stage, waiting_on, note)
       VALUES ($1, 'intake_started', 'staff', 'created by intake')`,
      [te.rows[0]!.id]
    );
    // Queue engagement letter + §7216 into the portal checklist (drafts — the
    // placeholder gate governs actual sending, M11).
    await createEnvelope(app, { type: 'system', label: 'intake' }, {
      contactId, type: 'engagement_letter', engagementId: eng.rows[0]!.id,
      taxEngagementId: te.rows[0]!.id, templateKey: templateKeyFor('engagement_letter', 'tax'),
    });
  } else if (services.some((s) => SERVICE_LINE_MAP[s])) {
    // No tax: the letter attaches to the first non-tax service line.
    const first = services.find((s) => SERVICE_LINE_MAP[s])!;
    const eng = await app.db.query<{ id: string }>(
      `INSERT INTO engagements (contact_id, business_id, service_line, status) VALUES ($1, $2, $3::service_line, 'draft') RETURNING id`,
      [contactId, businessId, SERVICE_LINE_MAP[first]]
    );
    await createEnvelope(app, { type: 'system', label: 'intake' }, {
      contactId, type: 'engagement_letter', engagementId: eng.rows[0]!.id,
      templateKey: templateKeyFor('engagement_letter', SERVICE_LINE_MAP[first]),
    });
  }
  for (const s of services) {
    if (SERVICE_LINE_MAP[s] && !(s === services.find((x) => SERVICE_LINE_MAP[x]) && !services.includes('tax_personal') && !services.includes('tax_business'))) {
      await app.db.query(
        `INSERT INTO engagements (contact_id, business_id, service_line, status) VALUES ($1, $2, $3::service_line, 'draft')`,
        [contactId, businessId, SERVICE_LINE_MAP[s]]
      );
    }
  }
  await createEnvelope(app, { type: 'system', label: 'intake' }, {
    contactId, type: 'consent_7216', templateKey: templateKeyFor('consent_7216'),
  });

  // Welcome + portal magic link (their language) + routing flags.
  const contact = await app.db.query<{ first_name: string }>(`SELECT first_name FROM contacts WHERE id = $1`, [contactId]);
  await sendTemplatedEmail(app, {
    to: email, templateKey: 'welcome_soto', language, contactId,
    vars: { first_name: contact.rows[0]!.first_name, portal_link: app.config.PORTAL_BASE_URL },
  });
  const portalUser = await ensurePortalUser(app, contactId);
  await issueMagicLink(app, portalUser.id);

  const rene = await firstActiveByRole(app.db, 'comms_billing');
  if (rene) {
    await notifyOnce(app.db, {
      staffId: rene, type: 'new_intake', severity: 'info',
      title: `New Soto intake: ${a.first_name} ${a.last_name}`,
      contactId, relatedObjectType: 'form_submission', relatedObjectId: submissionId,
    });
    if (a.ssn_preference === 'phone') {
      await app.db.query(
        `INSERT INTO tasks (title, assigned_staff_id, contact_id, priority, source, source_type, source_id)
         VALUES ($1, $2, $3, 1, 'automation', 'ssn_by_phone', $4)`,
        [`Call ${a.first_name} ${a.last_name} to collect SSN (requested phone entry)`, rene, contactId, submissionId]
      );
    }
  }
  if (a.irs_letters === 'yes') {
    const ana = await firstActiveByRole(app.db, 'tax_preparer');
    if (ana) {
      await notifyOnce(app.db, {
        staffId: ana, type: 'intake_irs_letter_flag', severity: 'warning',
        title: `Intake flagged IRS letters: ${a.first_name} ${a.last_name} — priority routing`,
        contactId, relatedObjectType: 'form_submission', relatedObjectId: submissionId,
      });
    }
  }

  await writeAudit(app.db, {
    actorType: 'client', actorLabel: email, action: 'intake.submitted',
    objectType: 'form_submission', objectId: submissionId, contactId,
    details: { form: 'soto_intake', services },
  });
  return { contactId };
}

// ── Form 2: Hilo intake ──────────────────────────────────────────────────────

export async function processHiloIntake(app: FastifyInstance, submissionId: string, answers: Answers): Promise<{ contactId: string }> {
  const a = answers as Record<string, string | string[]>;
  const email = String(a.email);
  const language = a.language === 'es' ? 'es' : 'en';

  const existing = await app.db.query<{ id: string }>(`SELECT id FROM contacts WHERE email = $1 LIMIT 1`, [email]);
  let contactId: string;
  if (existing.rows[0]) {
    contactId = existing.rows[0].id;
    await app.db.query(
      `UPDATE contacts SET hilo_status = CASE WHEN hilo_status = 'none' THEN 'exploring'::hilo_status ELSE hilo_status END,
              hilo_first_contact = COALESCE(hilo_first_contact, CURRENT_DATE), language = $2,
              zip = COALESCE(zip, $3), communication_consent_at = now()
       WHERE id = $1`,
      [contactId, language, a.zip ?? null]
    );
  } else {
    const created = await app.db.query<{ id: string }>(
      `INSERT INTO contacts (first_name, last_name, email, phone, language, hilo_status, hilo_first_contact,
                             zip, sms_consent, sms_consent_at, communication_consent_at)
       VALUES ($1,$2,$3,$4,$5,'exploring',CURRENT_DATE,$6,$7,CASE WHEN $7 THEN now() END,now())
       RETURNING id`,
      [a.first_name, a.last_name, email, a.mobile_phone, language, a.zip ?? null, a.sms_ok === 'yes']
    );
    contactId = created.rows[0]!.id;
  }
  // Demographics (screen 3) stay in the SUBMISSION for aggregate funder
  // reporting only — deliberately NOT copied to the contact record.

  await sendTemplatedEmail(app, {
    to: email, templateKey: 'welcome_hilo', language, contactId,
    vars: { first_name: String(a.first_name), portal_link: app.config.PORTAL_BASE_URL },
  });
  const portalUser = await ensurePortalUser(app, contactId);
  await issueMagicLink(app, portalUser.id);

  await writeAudit(app.db, {
    actorType: 'client', actorLabel: email, action: 'intake.submitted',
    objectType: 'form_submission', objectId: submissionId, contactId,
    details: { form: 'hilo_intake' },
  });
  return { contactId };
}

// ── Form 5: module assembly + flag processing ────────────────────────────────

interface ModuleRow {
  key: string;
  name_en: string;
  name_es: string;
  trigger: { services_any?: string[]; industry?: string; any_service_module?: boolean };
  questions: unknown[];
  flags: Array<{ flagKey: string; when: { question: string; equals?: string; numberGte?: number }; routeToRole: string }>;
}

/** Which modules fire for a contact (OF assembly logic; B fires on industry alone). */
export async function assembleModules(app: FastifyInstance, contactId: string): Promise<ModuleRow[]> {
  const services = await app.db.query<{ service_line: string }>(
    `SELECT DISTINCT service_line::text FROM engagements WHERE contact_id = $1 AND status <> 'withdrawn'`,
    [contactId]
  );
  const serviceLines = new Set(services.rows.map((r) => r.service_line));
  // Map engagement service lines back to intake service slugs for triggers.
  const serviceSlugs = new Set<string>();
  if (serviceLines.has('tax')) { serviceSlugs.add('tax_personal'); serviceSlugs.add('tax_business'); }
  if (serviceLines.has('bookkeeping')) serviceSlugs.add('bookkeeping');
  if (serviceLines.has('payroll')) serviceSlugs.add('payroll');
  if (serviceLines.has('sales_tax')) serviceSlugs.add('sales_tax');
  if (serviceLines.has('advisory')) serviceSlugs.add('cfo_advisory');

  const industry = await app.db.query<{ industry: string | null }>(
    `SELECT b.industry FROM businesses b
     JOIN business_members m ON m.business_id = b.id
     WHERE m.contact_id = $1 AND m.is_primary LIMIT 1`,
    [contactId]
  );
  const primaryIndustry = industry.rows[0]?.industry ?? null;

  const { rows: modules } = await app.db.query<ModuleRow>(
    `SELECT key, name_en, name_es, trigger, questions, flags
     FROM onboarding_modules WHERE is_active ORDER BY sort_order`
  );

  const fires = (m: ModuleRow, serviceModuleFired: boolean): boolean => {
    if (m.trigger.services_any) return m.trigger.services_any.some((s) => serviceSlugs.has(s));
    if (m.trigger.industry) {
      if (m.trigger.industry !== primaryIndustry) return false;
      return m.trigger.any_service_module ? serviceModuleFired : true;
    }
    return false;
  };

  const serviceModuleFired = modules.some((m) => m.trigger.services_any && fires(m, false));
  return modules.filter((m) => fires(m, serviceModuleFired));
}

/** Process a service-onboarding submission: store, evaluate flags, PLLC rule, complexity feed. */
export async function processServiceOnboarding(
  app: FastifyInstance,
  contactId: string,
  answers: Answers
): Promise<{ flags: string[] }> {
  const fired: string[] = [];
  const modules = await assembleModules(app, contactId);

  for (const m of modules) {
    for (const flag of m.flags ?? []) {
      const value = answers[flag.when.question];
      const hit =
        (flag.when.equals !== undefined && value === flag.when.equals) ||
        (flag.when.numberGte !== undefined && Number(value) >= flag.when.numberGte);
      if (!hit) continue;
      fired.push(flag.flagKey);
      const staffId = await firstActiveByRole(app.db, flag.routeToRole);
      if (staffId) {
        await notifyOnce(app.db, {
          staffId, type: `onboarding_flag_${flag.flagKey}`, severity: 'warning',
          title: `Onboarding flag: ${flag.flagKey.replace(/_/g, ' ')} (${m.key})`,
          contactId, relatedObjectType: 'contact', relatedObjectId: contactId,
        });
      }
    }
  }

  // ⚑ OF Module I auto-flag: licensed professional + LLC/sole prop + IL →
  // PLLC conversion opportunity (this IS the new service pipeline).
  if (modules.some((m) => m.key === 'module_i')) {
    const license = String(answers.I1 ?? '');
    const structure = String(answers.I2 ?? '');
    if (license && license !== 'not_licensed' && ['llc', 'sole_prop'].includes(structure)) {
      const biz = await app.db.query<{ id: string; state: string }>(
        `SELECT b.id, b.state FROM businesses b
         JOIN business_members m ON m.business_id = b.id
         WHERE m.contact_id = $1 AND m.is_primary LIMIT 1`,
        [contactId]
      );
      if ((biz.rows[0]?.state ?? 'IL') === 'IL') {
        await createPllcConversion(app, { type: 'system', label: 'module_i auto-flag' }, {
          contactId,
          businessId: biz.rows[0]?.id,
          licenseType: license,
          currentEntityType: structure,
          detectedVia: 'module_i',
        });
        fired.push('pllc_conversion');
      }
    }
  }

  // Module F feeds the complexity score (states count) on the latest tax engagement.
  if (modules.some((m) => m.key === 'module_f') && Array.isArray(answers.F4)) {
    await app.db.query(
      `UPDATE tax_engagements SET complexity_inputs = complexity_inputs || $2::jsonb
       WHERE id = (SELECT te.id FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
                   WHERE e.contact_id = $1 ORDER BY te.created_at DESC LIMIT 1)`,
      [contactId, JSON.stringify({ states: (answers.F4 as string[]).length })]
    );
  }
  return { flags: fired };
}
