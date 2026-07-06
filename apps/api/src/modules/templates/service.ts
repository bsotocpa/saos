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
  const { rows } = await app.db.query<TemplateRow>(
    `SELECT key, subject_en, subject_es, body_en, body_es, is_placeholder FROM templates WHERE key = $1`,
    [key]
  );
  const t = rows[0];
  if (!t) throw new AppError(500, 'template_missing', `Template '${key}' not found.`);

  // Bilingual rule: ES copy must exist for launch; until then fall back to EN
  // loudly rather than sending nothing.
  let subject = language === 'es' ? (t.subject_es ?? t.subject_en) : t.subject_en;
  let body = language === 'es' ? (t.body_es ?? t.body_en) : t.body_en;
  if (language === 'es' && (t.body_es === null || t.subject_es === null)) {
    app.log.warn({ templateKey: key }, 'spanish template copy missing — fell back to english');
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
