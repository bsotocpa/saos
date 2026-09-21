#!/usr/bin/env node
/*
 * EVERY LINK A CLIENT IS EMAILED, AND WHAT A BARE GET DOES TO IT (Brian, 2026-09-20, the stalled
 * proposal link). One row per token-bearing or one-time link: which portal page it lands on, which
 * API route the page calls when it loads, which request marks the link used or changes state,
 * whether the link is single use, and whether a bare GET — what a mail scanner or a link preview
 * does — consumes it or has any side effect at all. The annotations are read from the code cited
 * in the last column; the script re-finds each citation in the source on every run and prints
 * NOT FOUND if the registration moved, so a stale row cannot survive a re-run unnoticed.
 *
 *   node scripts/token-routes.mjs > token-routes.log
 *   node scripts/report-table.mjs --name token-routes --from-log token-routes.log --sql "node scripts/token-routes.mjs"
 *
 * Columns: link | portal page | fetched on page load | marks used / changes state | single use |
 *          bare GET consumes | bare GET side effect | where
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** file + a literal that must appear on one line of it; prints file:line or NOT FOUND. */
function cite(file, needle) {
  try {
    const lines = readFileSync(resolve(root, file), 'utf8').split(/\r?\n/);
    const i = lines.findIndex((l) => l.includes(needle));
    return i >= 0 ? `${file}:${i + 1}` : `${file}: NOT FOUND (${needle})`;
  } catch {
    return `${file}: NOT FOUND (file)`;
  }
}

const rows = [
  {
    link: 'Sign-in (magic) link /auth/verify?token=',
    page: 'apps/portal/app/auth/verify/page.tsx (public)',
    load: 'POST /portal/auth/magic/verify (the page POSTs the token as soon as it mounts)',
    marks: 'that same POST: UPDATE magic_link_tokens SET used_at WHERE used_at IS NULL AND expires_at > now()',
    single: 'yes (used_at), and expires after MAGIC_LINK_TTL_MINUTES',
    getConsumes: 'no for a plain fetch of the page; YES for a scanner that executes the page JavaScript (the mount POSTs)',
    getEffect: 'none server-side from the HTML GET itself',
    where: [cite('apps/api/src/modules/portal-auth/routes.ts', "app.post('/portal/auth/magic/verify'"), cite('apps/api/src/modules/portal-auth/service.ts', 'SET used_at = now(), used_ip'), cite('apps/portal/app/auth/verify/page.tsx', "'/portal/auth/magic/verify'")],
  },
  {
    link: 'Proposal /quote/:token',
    page: 'apps/portal/app/quote/[token]/page.tsx (public; no session gate on the page)',
    load: 'GET /public/quote/:token (read by SHA-256 of the token; 404 when unknown; returns expired as a flag)',
    marks: 'POST /public/quote/:token/accept or /decline (status change; the hash stays valid until then)',
    single: 'no: reusable until accepted, declined or expires_at; the quotes table has no viewed/consumed column',
    getConsumes: 'no',
    getEffect: 'none (a read; the only audit row is written on accept/decline)',
    where: [cite('apps/api/src/modules/pricing/quote-routes.ts', "app.get<{ Params: { token: string } }>('/public/quote/:token'"), cite('apps/api/src/modules/pricing/quotes.ts', 'WHERE q.public_token_hash = $1'), cite('apps/portal/app/quote/[token]/page.tsx', '`/public/quote/${token}`')],
  },
  {
    link: 'Pay link /pay/:token',
    page: 'apps/portal/app/pay/[token]/page.tsx (public)',
    load: 'GET /public/pay/:token (read by pay_token_hash; expiry and revocation columns on the invoice)',
    marks: 'POST /public/pay/:token/checkout (creates the Stripe session) and /reconcile',
    single: 'no: reusable until pay_token_expires_at / pay_token_revoked_at',
    getConsumes: 'no',
    getEffect: 'none',
    where: [cite('apps/api/src/modules/billing/routes.ts', "app.get<{ Params: { token: string } }>('/public/pay/:token'"), cite('apps/api/src/modules/billing/pay-link.ts', 'WHERE i.pay_token_hash = $1'), cite('apps/portal/app/pay/[token]/page.tsx', '`/public/pay/${token}`')],
  },
  {
    link: 'Unsubscribe /unsubscribe/:id/:token',
    page: 'apps/portal/app/unsubscribe/[id]/[token]/page.tsx (public)',
    load: 'POST /public/unsubscribe/:id/:token from the page; the API ALSO serves GET with the same handler',
    marks: 'either verb: UPDATE contacts SET broadcast_opt_out_at (HMAC token, idempotent)',
    single: 'no: the token is an HMAC of the contact id, never stored, never expires',
    getConsumes: 'not consumed (idempotent), but',
    getEffect: 'YES: a bare GET opts the contact out of broadcasts (CAN-SPAM one-click, by design: "some mail clients will only follow a link")',
    where: [cite('apps/api/src/modules/comms/broadcast-routes.ts', "app.get<{ Params: { id: string; token: string } }>('/public/unsubscribe/:id/:token'"), cite('apps/api/src/modules/comms/broadcast.ts', 'UPDATE contacts'), cite('apps/portal/app/unsubscribe/[id]/[token]/page.tsx', '`/public/unsubscribe/${params.id}/${params.token}`')],
  },
  {
    link: 'Hilo transition /transition?rt=',
    page: 'apps/portal/app/transition/page.tsx (public)',
    load: 'GET /public/transition?rt= (verifyScopedToken: a signed, purpose-scoped token; prefill only)',
    marks: 'POST /public/transition/submit (converts the referral)',
    single: 'no: signed token, not stored; submit is guarded by the referral state',
    getConsumes: 'no',
    getEffect: 'none (reads contact/business prefill)',
    where: [cite('apps/api/src/modules/referrals/routes.ts', "app.get('/public/transition'"), cite('apps/api/src/modules/referrals/service.ts', 'verifyScopedToken(app.config.APP_ENCRYPTION_KEY, rt, TRANSITION_PURPOSE)'), cite('apps/portal/app/transition/page.tsx', '/api/public/transition?rt=')],
  },
  {
    link: 'Intake resume token (form_resume)',
    page: 'apps/portal/app/intake/[key]/page.tsx (public)',
    load: 'GET /public/forms/:key (the definition, no token); the resume token travels only in a POST body',
    marks: 'POST /public/forms/submissions/:id/resume, then /submit (409 once submitted)',
    single: 'no until submitted; then refused',
    getConsumes: 'no (there is no GET that accepts the token: "POST, not GET, so the resume token stays out of access logs")',
    getEffect: 'none',
    where: [cite('apps/api/src/modules/forms/routes.ts', "app.post<{ Params: { id: string } }>('/public/forms/submissions/:id/resume'"), cite('apps/portal/app/intake/[key]/page.tsx', '/public/forms/submissions/')],
  },
  {
    link: 'Engagement packet signing (emailed link goes to /sign)',
    page: 'apps/portal/app/sign/page.tsx (SESSION-GATED: no token in the link; a signed-out client is sent to /login)',
    load: 'GET /portal/packet, /portal/signature-envelopes, /portal/schedules, /portal/consents (all authenticateClient)',
    marks: 'POST /portal/packet/sign',
    single: 'not a token link at all; the session is the credential',
    getConsumes: 'no',
    getEffect: 'none; a bare GET of /sign without a session renders the sign-in request page',
    where: [cite('apps/api/src/modules/engagements/packet-routes.ts', "app.get('/portal/packet'"), cite('apps/api/src/modules/engagements/packet-routes.ts', "app.post('/portal/packet/sign'"), cite('apps/api/src/outbox.ts', "case 'packet.send_signature_link'")],
  },
  {
    link: 'Section 7216 consent (/consent)',
    page: 'apps/portal/app/consent/page.tsx (SESSION-GATED)',
    load: 'GET /portal/consents (authenticateClient)',
    marks: 'POST /portal/consents',
    single: 'not a token link; the session is the credential',
    getConsumes: 'no',
    getEffect: 'none',
    where: [cite('apps/api/src/modules/engagements/packet-routes.ts', "app.get('/portal/consents'"), cite('apps/api/src/modules/engagements/packet-routes.ts', "app.post('/portal/consents'")],
  },
  {
    link: 'Documents (portal upload links)',
    page: 'apps/portal/app/documents (SESSION-GATED; no public or share-token document route exists in apps/api)',
    load: 'GET /portal/documents (authenticateClient; every access audited)',
    marks: 'n/a',
    single: 'not a token link; the session is the credential',
    getConsumes: 'no',
    getEffect: 'none',
    where: [cite('apps/api/src/modules/documents/routes.ts', "'/portal/documents'")],
  },
  {
    link: 'Any portal page while a STALE signed-in marker is in localStorage',
    page: 'every page under apps/portal/app (the SessionProvider wraps all of them, public pages included)',
    load: 'GET /portal/me whenever localStorage saos_portal_authed = 1, even on /quote/:token',
    marks: 'nothing: on 401 the API client clears the marker and sets window.location.href = /login',
    single: 'n/a',
    getConsumes: 'no',
    getEffect: 'the redirect that stalled the proposal link: a 401 from /portal/me on a public page sends the browser to the sign-in request page',
    where: [cite('apps/portal/lib/api.ts', "window.location.href = '/login'"), cite('apps/portal/lib/session.tsx', "'/portal/me'"), cite('apps/portal/lib/api.ts', "if (s.getItem(AUTHED_KEY) === '1') return true;")],
  },
];

const header = ['link', 'portal page', 'fetched on page load', 'marks used / changes state', 'single use', 'bare GET consumes', 'bare GET side effect', 'where'];
const out = [header, ...rows.map((r) => [r.link, r.page, r.load, r.marks, r.single, r.getConsumes, r.getEffect, r.where.join('; ')])];
process.stdout.write(out.map((r) => r.map((c) => String(c ?? '').replace(/\|/g, '/')).join(' | ')).join('\n') + '\n');
