// Demo-data script (dev DB, synthetic only): a client mid-journey so the
// portal demo shows every dashboard surface. Prints the magic-link URL.
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const db = new pg.Client({ connectionString: 'postgres://saos:saos_dev_password@localhost:5432/saos' });
await db.connect();

const email = 'demo-portal@example.test';

// Reuse-if-exists: re-running only mints a fresh magic link (the schema's
// referential integrity intentionally resists delete-recreate).
const existing = await db.query(`SELECT id FROM portal_users WHERE email = $1`, [email]);
if (existing.rows[0]) {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO magic_link_tokens (portal_user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, 'login', now() + interval '2 hours')`,
    [existing.rows[0].id, createHash('sha256').update(token).digest('hex')]
  );
  console.log(`MAGIC_URL=http://localhost:3000/auth/verify?token=${token}`);
  await db.end();
  process.exit(0);
}

const contact = await db.query(
  `INSERT INTO contacts (first_name, last_name, email, phone, language, soto_status, client_since)
   VALUES ('Maria', 'Demo', $1, '+13125550199', 'en', 'active', '2024-01-15') RETURNING id`,
  [email]
);
const contactId = contact.rows[0].id;

const user = await db.query(
  `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`,
  [contactId, email]
);
await db.query(`INSERT INTO portal_onboarding (contact_id, variant) VALUES ($1, 'new')`, [contactId]);

// Tax engagement mid-pipeline with a deadline.
const eng = await db.query(
  `INSERT INTO engagements (contact_id, service_line, status, title) VALUES ($1, 'tax', 'active', '2025 1040') RETURNING id`,
  [contactId]
);
const te = await db.query(
  `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, original_deadline, docs_requested_at)
   VALUES ($1, 2025, '1040', 'pending_client_response', '2026-04-15', now()) RETURNING id`,
  [eng.rows[0].id]
);

// Open document request with items.
const req = await db.query(
  `INSERT INTO document_requests (contact_id, tax_engagement_id, title_en, title_es, status)
   VALUES ($1, $2, '2025 tax documents', 'Documentos de impuestos 2025', 'open') RETURNING id`,
  [contactId, te.rows[0].id]
);
await db.query(
  `INSERT INTO document_request_items (request_id, label_en, label_es) VALUES ($1, 'W-2', 'Formulario W-2'), ($1, 'Prior-year return', 'Declaración anterior')`,
  [req.rows[0].id]
);

// Unsigned envelopes (drafts — queued by intake).
await db.query(
  `INSERT INTO signature_envelopes (contact_id, tax_engagement_id, type, status, template_key)
   VALUES ($1, $2, 'engagement_letter', 'draft', 'engagement_letter_tax'), ($1, $2, 'consent_7216', 'draft', 'consent_7216_use')`,
  [contactId, te.rows[0].id]
);

// Open invoice (amounts are synthetic demo data).
const inv = await db.query(
  `INSERT INTO invoices (invoice_number, contact_id, tax_engagement_id, status, subtotal_cents, total_cents, sent_at)
   VALUES ('SA-2026-9999', $1, $2, 'sent', 38000, 38000, now()) RETURNING id`,
  [contactId, te.rows[0].id]
);
await db.query(
  `INSERT INTO invoice_line_items (invoice_id, description, qty, unit_cents, total_cents)
   VALUES ($1, '2025 1040 tax return preparation', 1, 38000, 38000)`,
  [inv.rows[0].id]
);

// A staff message in the thread.
const thread = await db.query(
  `INSERT INTO message_threads (contact_id, subject, last_message_at) VALUES ($1, 'Welcome!', now()) RETURNING id`,
  [contactId]
);
await db.query(
  `INSERT INTO messages (thread_id, direction, channel, sender_type, body)
   VALUES ($1, 'outbound', 'portal', 'staff', 'Welcome to your new portal, Maria! Upload your documents whenever you are ready — we are on it.')`,
  [thread.rows[0].id]
);

// Magic link.
const token = randomBytes(32).toString('base64url');
await db.query(
  `INSERT INTO magic_link_tokens (portal_user_id, token_hash, purpose, expires_at)
   VALUES ($1, $2, 'login', now() + interval '2 hours')`,
  [user.rows[0].id, createHash('sha256').update(token).digest('hex')]
);

console.log(`MAGIC_URL=http://localhost:3000/auth/verify?token=${token}`);
await db.end();
