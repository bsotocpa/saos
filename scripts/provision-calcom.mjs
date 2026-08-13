#!/usr/bin/env node
/**
 * Provision Cal.com event types and availability schedules for Soto Accounting.
 *
 * WHY A SCRIPT INSTEAD OF CLICKING:
 * six event types, two schedules and twelve date blackouts is ~40 UI operations.
 * More importantly, the Busy Season flip in January is a RE-RUN of this file with
 * one constant changed, not a re-derivation of what Brian meant in August.
 *
 * WHY DIRECT SQL:
 * this deployment runs the Cal.com monolith (v6.2.0) with no API service. The web
 * app proxies /api/v2 to port 5555, which is not deployed, and /api/v1 does not
 * exist in the image. There is no supported REST surface to call, so the schema is
 * the interface. Every column used here was read from information_schema on the
 * live database, not recalled.
 *
 * The one thing this file DOES rely on about Cal.com's internals is that booking
 * fields merge on read: getBookingFieldsWithSystemFields() parses
 * `bookingFields || []` and calls ensureBookingInputsHaveSystemFields(), so storing
 * only the custom questions is correct — name, email, location, notes and guests are
 * added by Cal.com. Verified by reading the source in the running container.
 *
 * USAGE (runs inside saos-api-1, which has pg and DATABASE_URL):
 *   node provision-calcom.mjs            # dry run — prints the plan, writes nothing
 *   node provision-calcom.mjs --execute  # applies the plan in one transaction
 *
 * RE-RUNNING IS SAFE BUT OPINIONATED: event types are matched by (userId, slug) and
 * updated in place. A schedule's availability rows are REPLACED from the spec below,
 * so hand-edits made in the Cal.com UI to Default Hours or Busy Season will be
 * overwritten. The dry run says so explicitly when it would happen.
 */

import pg from 'pg';

const EXECUTE = process.argv.includes('--execute');

const OWNER_EMAIL = process.env.CALCOM_OWNER_EMAIL || 'brian@sotoaccounting.com';
const TZ = 'America/Chicago';

// Cal.com day numbering matches dayjs(): 0 = Sunday … 6 = Saturday.
const MON_FRI = [1, 2, 3, 4, 5];

const SCHEDULES = {
  default: {
    name: 'Default Hours',
    isDefault: true,
    // One row per distinct time range, carrying the days it applies to.
    rules: [{ days: MON_FRI, start: '09:00', end: '17:00' }],
    // Blackout dates: stored as date overrides with startTime == endTime, which is
    // how Cal.com represents "unavailable all day" for a specific date.
    blackouts: [
      '2026-08-28',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-07', // Labor Day — Brian does not work it (added 2026-08-12)
      '2026-09-08',
      '2026-09-14',
      '2026-09-15',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ],
  },
  busySeason: {
    name: 'Busy Season',
    isDefault: false,
    // Saturday and Sunday off — absent days are simply not represented.
    rules: [
      { days: [1, 2], start: '10:00', end: '17:00' }, // Mon, Tue
      { days: [3], start: '10:00', end: '16:00' }, // Wed
      { days: [4], start: '10:00', end: '15:00' }, // Thu
      { days: [5], start: '10:00', end: '14:00' }, // Fri
    ],
    blackouts: [], // Set in January when the season is actually planned.
  },
};

// ── Location shapes (Cal.com `locations` jsonb) ──────────────────────────────
// Cal Video is the built-in Daily.co integration — no Zoom, per Brian.
const CAL_VIDEO = { type: 'integrations:daily' };
// Attendee phone number: the client supplies the number and Brian calls them.
const PHONE = { type: 'phone' };
const OFFICE = {
  type: 'inPerson',
  address: '4252 N. Cicero Ave, Chicago, IL 60641',
  displayLocationPublicly: true,
};

/** Build a custom booking question. `editable: 'user'` marks it as Brian's, not a system field. */
function question({ name, type, label, required, options }) {
  const field = {
    name,
    type,
    label,
    required,
    editable: 'user',
    sources: [{ id: 'user', type: 'user', label: 'User' }],
  };
  if (options) field.options = options.map((o) => ({ label: o.label, value: o.value }));
  return field;
}

// Only the PUBLIC new-client event carries intake questions. Authenticated portal
// clients are already known to the system, so asking them their phone number or
// whether they are a client is the system forgetting who it is talking to.
const NEW_CLIENT_QUESTIONS = [
  question({
    name: 'business-name',
    type: 'text',
    label: 'Business name (if any) · Nombre del negocio (si aplica)',
    required: false,
  }),
  question({
    name: 'phone',
    type: 'phone',
    label: 'Phone number · Número de teléfono',
    required: true,
  }),
  question({
    name: 'preferred-language',
    type: 'select',
    label: 'Preferred language · Idioma preferido',
    required: true,
    options: [
      { label: 'English', value: 'english' },
      { label: 'Español', value: 'espanol' },
      { label: 'Romanian', value: 'romanian' },
    ],
  }),
  question({
    name: 'service-interest',
    type: 'multiselect',
    label: 'What can we help with? · ¿En qué podemos ayudarle?',
    required: true,
    options: [
      { label: 'Individual tax', value: 'individual-tax' },
      { label: 'Business tax', value: 'business-tax' },
      { label: 'IRS or state notice / letter', value: 'notice' },
      { label: 'Bookkeeping / financial statements', value: 'bookkeeping' },
      { label: 'Payroll', value: 'payroll' },
      { label: 'Sales tax', value: 'sales-tax' },
      { label: 'ITIN', value: 'itin' },
      { label: 'Audits & reviews', value: 'attest' },
      { label: 'Outsourced CFO', value: 'cfo' },
      { label: 'Something else', value: 'other' },
    ],
  }),
];

// NOTE ON PRICE: `price` and `currency` are deliberately NOT written. Cal.com
// defaults price to 0, and "no payment at booking" is the absence of payment
// configuration rather than a zero written into a third-party table. Deposits are
// quoted from the SAOS price book and collected in the engagement flow — this file
// contains no dollar amount for that reason.
const EVENTS = [
  {
    slug: 'onboarding-consultation',
    title: 'Onboarding Consultation',
    length: 30,
    hidden: true, // link-only: this is the portal checklist step 4 target
    locations: [CAL_VIDEO],
    bookingFields: [],
    description:
      'A short call to get your engagement started and answer anything outstanding. ' +
      'Booked from your client portal — we already have your details.\n\n' +
      'Una llamada breve para iniciar su contrato y responder cualquier pregunta pendiente. ' +
      'Se reserva desde su portal de cliente — ya tenemos sus datos.',
  },
  {
    slug: 'new-client',
    title: 'New Client Consultation',
    length: 30,
    hidden: false, // the one public, discoverable event
    locations: [CAL_VIDEO, PHONE],
    bookingFields: NEW_CLIENT_QUESTIONS,
    description:
      'Tell us what you need and we will tell you plainly whether we are the right fit, ' +
      'what it costs, and what happens next. Video or phone — your choice.\n\n' +
      'Cuéntenos lo que necesita y le diremos con claridad si somos la opción adecuada, ' +
      'cuánto cuesta y qué sigue. Video o teléfono — usted elige.',
  },
  {
    slug: 'in-person-tax-prep',
    title: 'In-Person Tax Preparation',
    length: 60,
    hidden: false,
    locations: [OFFICE],
    bookingFields: [],
    description:
      'An hour at our Cicero Avenue office to prepare your return together. ' +
      'Bring your documents — or upload them to your portal beforehand, which saves time.\n' +
      'No payment is taken when you book. A deposit is collected with your engagement ' +
      'quote, which we send after this appointment is scheduled.\n\n' +
      'Una hora en nuestra oficina de Cicero Avenue para preparar su declaración juntos. ' +
      'Traiga sus documentos — o súbalos a su portal antes, lo cual ahorra tiempo.\n' +
      'No se cobra nada al reservar. El depósito se cobra con su cotización de contrato, ' +
      'que enviamos después de programar esta cita.',
  },
  {
    slug: 'review-taxreturn',
    title: 'Tax Return Review',
    length: 30,
    hidden: true, // link-only, sent when a return is ready to walk through
    locations: [CAL_VIDEO, PHONE],
    bookingFields: [],
    description:
      'We walk through your finished return together before anything is filed, so you ' +
      'know what it says and why.\n\n' +
      'Revisamos juntos su declaración terminada antes de presentarla, para que sepa ' +
      'qué dice y por qué.',
  },
  {
    slug: 'review-financials',
    title: 'Financial Statement Review',
    length: 30,
    hidden: true, // link-only
    locations: [CAL_VIDEO],
    bookingFields: [],
    description:
      'A working session on your statements: what the numbers show, what changed, and ' +
      'what to do about it.\n\n' +
      'Una sesión de trabajo sobre sus estados financieros: qué muestran las cifras, ' +
      'qué cambió y qué hacer al respecto.',
  },
  {
    slug: 'customer-support',
    title: 'Client Support Session',
    length: 30,
    hidden: false,
    locations: [CAL_VIDEO, PHONE, OFFICE],
    bookingFields: [],
    description:
      'For current clients: bring a question, a notice you received, or something that ' +
      'is not working. Video, phone, or in person at our office.\n\n' +
      'Para clientes actuales: traiga una pregunta, un aviso que recibió o algo que no ' +
      'está funcionando. Video, teléfono o en persona en nuestra oficina.',
  },
];

// ── Provisioning ────────────────────────────────────────────────────────────

const calcomUrl =
  process.env.CALCOM_DATABASE_URL ||
  (process.env.DATABASE_URL || '').replace(/\/[^/]+$/, '/calcom');
if (!calcomUrl) {
  console.error('No CALCOM_DATABASE_URL or DATABASE_URL in the environment.');
  process.exit(1);
}

const db = new pg.Client({ connectionString: calcomUrl });
await db.connect();

const plan = [];
const note = (line) => plan.push(line);

const owner = await db.query(
  `SELECT id, username, name, "defaultScheduleId" FROM users WHERE lower(email) = lower($1)`,
  [OWNER_EMAIL]
);

if (owner.rows.length === 0) {
  const anyUser = await db.query(`SELECT count(*)::int n FROM users`);
  console.error(`
╔════════════════════════════════════════════════════════════════════════════╗
║  BLOCKED: no Cal.com account exists for ${OWNER_EMAIL}
╚════════════════════════════════════════════════════════════════════════════╝

Users in the Cal.com database: ${anyUser.rows[0].n}

Event types belong to a user, so nothing can be provisioned until the account
exists. Cal.com first-boot has not been done on this instance.

  1. Go to https://book.sotoaccounting.com/auth/signup
  2. Sign up as ${OWNER_EMAIL} and choose your username — it becomes the
     booking URL (https://book.sotoaccounting.com/<username>/new-client)
  3. Set the timezone to ${TZ} when asked
  4. Re-run this script

Account creation is yours to do: it sets a password, which I do not handle.
`);
  await db.end();
  process.exit(2);
}

const user = owner.rows[0];
note(`owner: user #${user.id} @${user.username} (${OWNER_EMAIL})`);

async function planSchedule(spec) {
  const existing = await db.query(`SELECT id FROM "Schedule" WHERE "userId" = $1 AND name = $2`, [
    user.id,
    spec.name,
  ]);
  const id = existing.rows[0]?.id ?? null;
  if (id) {
    const cur = await db.query(
      `SELECT count(*)::int AS weekly, count("date") ::int AS overrides FROM "Availability" WHERE "scheduleId" = $1`,
      [id]
    );
    note(
      `schedule "${spec.name}": EXISTS (#${id}) — its ${cur.rows[0].weekly} availability row(s) ` +
        `will be REPLACED by ${spec.rules.length} weekly rule(s) + ${spec.blackouts.length} blackout(s)`
    );
  } else {
    note(
      `schedule "${spec.name}": CREATE (${TZ}) with ${spec.rules.length} weekly rule(s) + ` +
        `${spec.blackouts.length} blackout(s)`
    );
  }
  for (const r of spec.rules) note(`    days ${JSON.stringify(r.days)}  ${r.start}–${r.end}`);
  if (spec.blackouts.length) note(`    blackouts: ${spec.blackouts.join(', ')}`);
  return id;
}

async function applySchedule(spec) {
  const existing = await db.query(`SELECT id FROM "Schedule" WHERE "userId" = $1 AND name = $2`, [
    user.id,
    spec.name,
  ]);
  let id = existing.rows[0]?.id;
  if (id) {
    await db.query(`UPDATE "Schedule" SET "timeZone" = $2 WHERE id = $1`, [id, TZ]);
    await db.query(`DELETE FROM "Availability" WHERE "scheduleId" = $1`, [id]);
  } else {
    const ins = await db.query(
      `INSERT INTO "Schedule" ("userId", name, "timeZone") VALUES ($1, $2, $3) RETURNING id`,
      [user.id, spec.name, TZ]
    );
    id = ins.rows[0].id;
  }
  for (const r of spec.rules) {
    await db.query(
      `INSERT INTO "Availability" ("userId", "scheduleId", days, "startTime", "endTime")
       VALUES ($1, $2, $3::integer[], $4::time, $5::time)`,
      [user.id, id, r.days, r.start, r.end]
    );
  }
  for (const date of spec.blackouts) {
    // startTime == endTime is Cal.com's "unavailable all day" date override.
    await db.query(
      `INSERT INTO "Availability" ("userId", "scheduleId", days, date, "startTime", "endTime")
       VALUES ($1, $2, '{}'::integer[], $3::date, '00:00'::time, '00:00'::time)`,
      [user.id, id, date]
    );
  }
  return id;
}

async function planEvent(spec) {
  const existing = await db.query(`SELECT id, hidden FROM "EventType" WHERE "userId" = $1 AND slug = $2`, [
    user.id,
    spec.slug,
  ]);
  const verb = existing.rows.length ? `UPDATE (#${existing.rows[0].id})` : 'CREATE';
  const where = spec.locations
    .map((l) => (l.type === 'integrations:daily' ? 'Cal Video' : l.type === 'phone' ? 'phone' : 'in person'))
    .join(' / ');
  note(
    `event "${spec.slug}": ${verb} — ${spec.length} min, ${where}, ` +
      `${spec.hidden ? 'HIDDEN (link-only)' : 'public'}, ` +
      `${spec.bookingFields.length} custom question(s), schedule=Default Hours`
  );
  return existing.rows[0]?.id ?? null;
}

async function applyEvent(spec, scheduleId) {
  const existing = await db.query(`SELECT id FROM "EventType" WHERE "userId" = $1 AND slug = $2`, [
    user.id,
    spec.slug,
  ]);
  let id = existing.rows[0]?.id;
  const args = [
    spec.title,
    spec.slug,
    spec.description,
    JSON.stringify(spec.locations),
    spec.length,
    spec.hidden,
    JSON.stringify(spec.bookingFields),
    scheduleId,
    user.id,
  ];
  if (id) {
    await db.query(
      `UPDATE "EventType"
          SET title = $1, slug = $2, description = $3, locations = $4::jsonb, length = $5,
              hidden = $6, "bookingFields" = $7::jsonb, "scheduleId" = $8
        WHERE id = $10 AND "userId" = $9`,
      [...args, id]
    );
  } else {
    const ins = await db.query(
      `INSERT INTO "EventType"
         (title, slug, description, locations, length, hidden, "bookingFields", "scheduleId", "userId")
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9)
       RETURNING id`,
      args
    );
    id = ins.rows[0].id;
  }
  // Personal event types carry BOTH the owner column and the users relation.
  await db.query(
    `INSERT INTO "_user_eventtype" ("A", "B") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [id, user.id]
  );
  return id;
}

for (const spec of Object.values(SCHEDULES)) await planSchedule(spec);
for (const spec of EVENTS) await planEvent(spec);
note(`user default schedule → "Default Hours"`);

console.log('\n' + (EXECUTE ? 'APPLYING' : 'DRY RUN — nothing will be written') + '\n');
for (const line of plan) console.log('  ' + line);

if (!EXECUTE) {
  console.log('\nRe-run with --execute to apply.\n');
  await db.end();
  process.exit(0);
}

await db.query('BEGIN');
try {
  const defaultScheduleId = await applySchedule(SCHEDULES.default);
  await applySchedule(SCHEDULES.busySeason);
  for (const spec of EVENTS) await applyEvent(spec, defaultScheduleId);
  await db.query(`UPDATE users SET "defaultScheduleId" = $2, "timeZone" = $3 WHERE id = $1`, [
    user.id,
    defaultScheduleId,
    TZ,
  ]);
  await db.query('COMMIT');
} catch (err) {
  await db.query('ROLLBACK');
  console.error('\nFAILED — rolled back, nothing was written:\n', err.message);
  await db.end();
  process.exit(1);
}

// ── Verify what actually landed, rather than trusting the writes ─────────────
const check = await db.query(
  `SELECT e.slug, e.length, e.hidden, e."scheduleId", s.name AS schedule,
          jsonb_array_length(e."bookingFields") AS questions,
          jsonb_array_length(e.locations) AS locations, e.price,
          (SELECT count(*)::int FROM "_user_eventtype" j WHERE j."A" = e.id AND j."B" = e."userId") AS linked
     FROM "EventType" e LEFT JOIN "Schedule" s ON s.id = e."scheduleId"
    WHERE e."userId" = $1 ORDER BY e.id`,
  [user.id]
);
console.log('\nRESULT — event types:');
for (const r of check.rows) {
  console.log(
    `  ${r.slug.padEnd(26)} ${String(r.length).padStart(3)}min  ` +
      `${r.hidden ? 'hidden' : 'public'}  schedule=${r.schedule}  ` +
      `questions=${r.questions}  locations=${r.locations}  price=${r.price}  linked=${r.linked}`
  );
}

const sched = await db.query(
  `SELECT s.name, s."timeZone",
          count(a.id) FILTER (WHERE a.date IS NULL)::int AS weekly,
          count(a.id) FILTER (WHERE a.date IS NOT NULL)::int AS blackouts,
          (s.id = u."defaultScheduleId") AS is_default
     FROM "Schedule" s JOIN users u ON u.id = s."userId"
     LEFT JOIN "Availability" a ON a."scheduleId" = s.id
    WHERE s."userId" = $1 GROUP BY s.id, s.name, s."timeZone", u."defaultScheduleId" ORDER BY s.id`,
  [user.id]
);
console.log('\nRESULT — schedules:');
for (const r of sched.rows) {
  console.log(
    `  ${r.name.padEnd(16)} ${r.timeZone}  weekly=${r.weekly}  blackouts=${r.blackouts}` +
      `${r.is_default ? '  [default]' : ''}`
  );
}

console.log(`\nBooking URLs (https://book.sotoaccounting.com/${user.username}/<slug>):`);
for (const e of EVENTS) console.log(`  ${e.hidden ? 'link-only' : 'public   '}  ${e.slug}`);
console.log(
  `\nSet SAOS booking.client_booking_url to:\n` +
    `  https://book.sotoaccounting.com/${user.username}/onboarding-consultation\n`
);

await db.end();
