// Templated outbound mail. ALL client-facing copy lives in the templates
// table (EN + ES, admin-editable — copy changes never require a deploy).
//
// ⛔ PLACEHOLDER GATE (CLAUDE.md non-negotiable, MP §7216): a template flagged
// is_placeholder can NEVER be sent — this function refuses in every
// environment, so the launch gate cannot be bypassed by a config mistake.
// Never remove this check.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';

interface TemplateRow {
  key: string;
  subject_en: string | null;
  subject_es: string | null;
  body_en: string;
  body_es: string | null;
  is_placeholder: boolean;
}

export function renderVars(text: string, vars: Record<string, string>): string {
  const rendered = text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new AppError(500, 'template_var_missing', `Template variable '${name}' missing.`);
    return value;
  });
  return rendered;
}

export async function renderTemplate(
  app: FastifyInstance,
  key: string,
  language: 'en' | 'es',
  vars: Record<string, string>
): Promise<{ subject: string; body: string; isPlaceholder: boolean }> {
  const { rows } = await app.db.query<TemplateRow & { needs_es_review: boolean }>(
    `SELECT key, subject_en, subject_es, body_en, body_es, is_placeholder, needs_es_review
     FROM templates WHERE key = $1`,
    [key]
  );
  const t = rows[0];
  if (!t) throw new AppError(500, 'template_missing', `Template '${key}' not found.`);

  // ENGLISH CONTROLS (legal package v3: "English text controls; Spanish
  // translations to follow"). Spanish is used only when it EXISTS and has been
  // approved. Unapproved Spanish is not a lesser version of the text — for the
  // Master, the Schedules and the §7216 consents it is text a client might rely
  // on and Brian has not read, so it must not be sent.
  //
  // Falling back to English rather than refusing is deliberate: a Spanish reader
  // receiving the controlling English text is imperfect; a Spanish reader
  // receiving NOTHING is worse, and English is what governs either way.
  /*
   * A SUBJECT IS ONLY REQUIRED WHERE THERE IS ONE.
   *
   * This used to read `t.body_es === null || t.subject_es === null`, which quietly made
   * Spanish impossible for every legal DOCUMENT: the Master, the six Schedules and the
   * two §7216 consents all have subject_en NULL, because a contract has no email
   * subject line. subject_es was therefore also NULL, esUnavailable was permanently
   * true, and the render fell back to English no matter how carefully the translation
   * had been reviewed and approved.
   *
   * Found on 2026-08-13, the morning after Brian approved nine translations — every one
   * of which would have rendered English to Spanish-speaking clients while the admin
   * screen showed them as approved. A fallback that cannot be switched off is not a
   * fallback, it is a wall.
   */
  const needsSubject = t.subject_en !== null;
  const esUnavailable = t.body_es === null || (needsSubject && t.subject_es === null);
  const esUnapproved = t.needs_es_review === true;
  const useSpanish = language === 'es' && !esUnavailable && !esUnapproved;

  const subject = useSpanish ? t.subject_es : t.subject_en;
  const body = useSpanish ? t.body_es! : t.body_en;
  if (language === 'es' && !useSpanish) {
    app.log.warn(
      { templateKey: key, esUnavailable, esUnapproved },
      esUnapproved
        ? 'spanish copy awaiting approval — sent english (english controls)'
        : 'spanish template copy missing — fell back to english'
    );
  }
  return {
    subject: renderVars(subject ?? '', vars),
    body: renderVars(body, vars),
    isPlaceholder: t.is_placeholder,
  };
}

export async function sendTemplatedEmail(
  app: FastifyInstance,
  opts: {
    to: string;
    templateKey: string;
    language: 'en' | 'es';
    vars: Record<string, string>;
    contactId?: string | null;
  }
): Promise<void> {
  // THE COMPLIANCE GATE FIRST: a placeholder template is refused before any
  // rendering is attempted. Order matters — otherwise a missing variable in
  // placeholder copy throws a DIFFERENT error and the gate never speaks.
  const flag = await app.db.query<{ is_placeholder: boolean }>(
    `SELECT is_placeholder FROM templates WHERE key = $1`,
    [opts.templateKey]
  );
  if (flag.rows[0]?.is_placeholder) {
    throw new AppError(
      409,
      'template_placeholder_blocked',
      `Template '${opts.templateKey}' is flagged PLACEHOLDER and cannot be sent to a client. Final copy must be entered in Admin → Templates first.`
    );
  }

  const rendered = await renderTemplate(app, opts.templateKey, opts.language, opts.vars);

  if (rendered.isPlaceholder) {
    // The compliance gate. Blocks in EVERY environment — placeholder legal
    // text (engagement letters, §7216 consents) must never reach anyone.
    throw new AppError(
      409,
      'template_placeholder_blocked',
      `Template '${opts.templateKey}' is flagged PLACEHOLDER and cannot be sent. Final text must be supplied in admin first.`
    );
  }

  await app.mailer.send({ to: opts.to, subject: rendered.subject, text: rendered.body });
  await writeAudit(app.db, {
    actorType: 'system',
    action: 'email.sent',
    objectType: 'template',
    objectId: opts.templateKey,
    contactId: opts.contactId ?? null,
    details: { language: opts.language, transport: app.mailer.transport },
  });
}
