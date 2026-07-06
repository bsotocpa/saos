// Mint a transition link for the dev DB (synthetic Hilo contact + approved
// referral). Token format mirrors apps/api/src/crypto.ts createScopedToken.
import { createHmac } from 'node:crypto';
import pg from 'pg';

const KEY_HEX = 'decade00'.repeat(8); // dev APP_ENCRYPTION_KEY
const db = new pg.Client({ connectionString: 'postgres://saos:saos_dev_password@localhost:5432/saos' });
await db.connect();

const email = 'demo-transition@example.test';
let contact = await db.query(`SELECT id FROM contacts WHERE email = $1`, [email]);
if (!contact.rows[0]) {
  contact = await db.query(
    `INSERT INTO contacts (first_name, last_name, email, phone, language, hilo_status, hilo_first_contact)
     VALUES ('Rosa', 'Emprendedora', $1, '+13125550177', 'es', 'active', '2025-10-01') RETURNING id`,
    [email]
  );
}
const contactId = contact.rows[0].id;

const referral = await db.query(
  `INSERT INTO referrals (contact_id, direction, status, source) VALUES ($1, 'hilo_to_soto', 'approved', 'manual') RETURNING id`,
  [contactId]
);

const payload = { sub: referral.rows[0].id, purpose: 'hilo_transition', exp: Math.floor(Date.now() / 1000) + 3600 };
const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
const sig = createHmac('sha256', Buffer.from(KEY_HEX, 'hex')).update(body).digest('base64url');
console.log(`TRANSITION_URL=http://localhost:3000/transition?rt=${body}.${sig}`);
await db.end();
