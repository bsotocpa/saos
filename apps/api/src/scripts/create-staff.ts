// Bootstrap CLI — creates a staff account without HTTP (solves the first-admin
// cold start). Prints the temporary password ONCE; MFA enrollment is forced on
// first login before any full session exists.
//
// Usage (from apps/api):
//   npm run create-staff -- --email brian@sotoaccounting.com --name "Brian Soto" --role ceo

import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { loadConfig } from '../config.ts';
import { createPool } from '../db.ts';
import { writeAudit } from '../audit.ts';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    password: { type: 'string' }, // optional; generated when omitted
  },
});

if (!values.email || !values.name || !values.role) {
  console.error('Usage: npm run create-staff -- --email <email> --name "<Full Name>" --role <role_key> [--password <pw>]');
  process.exit(1);
}

const config = loadConfig();
const db = createPool(config.DATABASE_URL);

try {
  const role = await db.query<{ id: string }>(`SELECT id FROM roles WHERE key = $1`, [values.role]);
  if (!role.rows[0]) {
    const { rows } = await db.query<{ key: string }>(`SELECT key FROM roles ORDER BY key`);
    console.error(`Unknown role '${values.role}'. Available: ${rows.map((r) => r.key).join(', ')}`);
    process.exit(1);
  }

  const password = values.password ?? randomBytes(15).toString('base64url');
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO staff (full_name, email, role_id, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
    [values.name, values.email, role.rows[0].id, await argon2.hash(password)]
  );

  await writeAudit(db, {
    actorType: 'system',
    actorLabel: 'create-staff CLI',
    action: 'staff.created',
    objectType: 'staff',
    objectId: inserted.rows[0]!.id,
    details: { role: values.role },
  });

  console.log(`✓ Staff account created: ${values.email} (role: ${values.role})`);
  console.log(`  Temporary password (shown once): ${password}`);
  console.log('  First login will require MFA enrollment before any session is issued.');
} finally {
  await db.end();
}
