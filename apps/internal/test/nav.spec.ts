/*
 * THE NAVIGATION FILTER AND EACH ROLE'S HOME (R64, 2026-09-26).
 *
 * The shell shows a session only the pages it can open (lib/nav.ts); the API sends it to the home
 * its permissions earn (apps/api/src/modules/auth/home.ts). Both are pure functions of the
 * permissions, proven here on the seeded grants (packages/db/seeds/data/roles.mjs) and on synthetic
 * sessions — and proven AGAINST EACH OTHER: every seeded role's home is a page the shell shows that
 * role, so nobody is sent to a page that is not in their navigation. The wiring (that the shell
 * renders visibleNav and that the root redirects) is checked in the source, because the front end
 * has no render harness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NAV, sessionHolds, visibleNav } from '../lib/nav.ts';
import { HOME_FALLBACK, HOME_RULES, homeFor } from '../../api/src/modules/auth/home.ts';
import { roles } from '../../../packages/db/seeds/data/roles.mjs';

type Role = { key: string; permissions: string[] };
const seeded = roles as Role[];
const grants = (key: string): string[] => seeded.find((r) => r.key === key)!.permissions;
const labels = (permissions: string[]) => visibleNav(permissions).map((i) => i.label);
const homeOf = (permissions: string[]) => homeFor((p) => sessionHolds(permissions, p));

test('the table names every Ops page once, each with the door its permission was read from', () => {
  const hrefs = NAV.map((i) => i.href);
  assert.equal(new Set(hrefs).size, hrefs.length, 'no href twice');
  for (const item of NAV) assert.ok(item.door.length > 0, `${item.label} names its door`);
  assert.equal(NAV.length, 25, 'the 25 items the shell had before the filter');
});

test('no navigation permission is explicit-only, so the wildcard opens every item', () => {
  const plugin = readFileSync(new URL('../../api/src/plugins/auth.ts', import.meta.url), 'utf8');
  const block = /EXPLICIT_ONLY_PERMISSIONS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(plugin);
  assert.ok(block, 'the explicit-only set is read from the plugin');
  const explicitOnly = [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  assert.ok(explicitOnly.length >= 2, 'the set has entries');
  for (const item of NAV) for (const p of item.needs) assert.ok(!explicitOnly.includes(p), `${item.label} does not need ${p}`);
  assert.equal(labels(['*']).length, NAV.length, 'the wildcard sees all 25');
});

test('the filter: a preparer sees her pages and none of the CEO-only ones; a session with nothing sees the three open pages', () => {
  const preparer = labels(grants('tax_preparer'));
  for (const yes of ['Clients', 'Documents', 'My Tasks', 'My Queue', 'E-file acks', 'Pipeline', 'Deliver Return', 'Recorder', 'SOPs', 'Alerts', 'Account']) {
    assert.ok(preparer.includes(yes), `tax_preparer sees ${yes}`);
  }
  for (const no of ['Executive', 'Reports', 'Approvals', 'Configurator', 'Inbox', 'Announcements', 'Events', 'Hilo Ops', 'Automations', 'Pricing', 'Templates', 'Staff', 'Settings', 'WISP']) {
    assert.ok(!preparer.includes(no), `tax_preparer does not see ${no}`);
  }
  assert.deepEqual(labels([]), ['SOPs', 'Alerts', 'Account'], 'the pages every staff session opens');
  assert.deepEqual(labels(grants('auditor')), ['SOPs', 'Alerts', 'Account'], 'the auditor holds no Ops page');
  assert.deepEqual(labels(grants('intern')), ['My Tasks', 'SOPs', 'Alerts', 'Account']);
  assert.deepEqual(labels(grants('ed_coo')), ['Clients', 'Documents', 'My Tasks', 'My Queue', 'Pipeline', 'SOPs', 'Events', 'Hilo Ops', 'Alerts', 'Recorder', 'Account']);
});

test('the home rule, per role: executive → /, preparer → /queue, billing → /clients, the first page otherwise, /account for none', () => {
  assert.equal(homeOf(grants('ceo')), '/');
  assert.equal(homeOf(['dashboards.executive']), '/');
  assert.equal(homeOf(grants('tax_preparer')), '/queue');
  assert.equal(homeOf(grants('comms_billing')), '/clients');
  assert.equal(homeOf(['billing.manage']), '/clients', 'billing alone lands on the client list, where the Invoices card is');
  assert.equal(homeOf(grants('ed_coo')), '/clients', 'the first page of her navigation');
  assert.equal(homeOf(grants('va_entity')), '/clients');
  assert.equal(homeOf(grants('bookkeeper')), '/clients');
  assert.equal(homeOf(grants('intern')), '/tasks');
  assert.equal(homeOf(grants('auditor')), HOME_FALLBACK);
  assert.equal(homeOf([]), '/account');
  assert.equal(homeOf(['engagements.read']), '/queue', 'a read-only tax role still works from the queue');
});

test('every seeded role, and every single permission, is sent to a page its navigation shows', () => {
  const hrefsFor = (permissions: string[]) => visibleNav(permissions).map((i) => i.href);
  for (const role of seeded) {
    assert.ok(hrefsFor(role.permissions).includes(homeOf(role.permissions)), `${role.key}'s home ${homeOf(role.permissions)} is in its navigation`);
  }
  /*
   * Rules 1 to 3 are the ruling's words: dashboards.executive → /, engagements.tax.manage → /queue,
   * billing.manage → /clients. The queue itself opens on engagements.read and the client list on
   * contacts.read, so rules 2 and 3 presume what every seeded role holding the one also holds — the
   * other. That presumption is pinned here rather than hidden: a role that could manage returns
   * without reading them, or bill without reading clients, would be sent to a page that refuses it.
   */
  const ruled = HOME_RULES.slice(0, 3);
  for (const [permission, href] of ruled) {
    for (const role of seeded) {
      if (sessionHolds(role.permissions, permission)) assert.ok(hrefsFor(role.permissions).includes(href), `${role.key} holds ${permission} and its navigation shows ${href}`);
    }
  }
  // Every other pair is the navigation's own: a session holding just that permission sees that page.
  const every = new Set<string>([...NAV.flatMap((i) => i.needs), ...HOME_RULES.map(([p]) => p), ...seeded.flatMap((r) => r.permissions)]);
  for (const [permission] of ruled) every.delete(permission);
  for (const p of every) assert.ok(hrefsFor([p]).includes(homeOf([p])), `a session holding only ${p} lands on a page it can see`);
  // And the rule's own pairs are all pages in the table.
  for (const [, href] of HOME_RULES) assert.ok(NAV.some((i) => i.href === href), `${href} is an Ops page`);
});

test('the shell filters by the table and sends the root to the home; the login lands on the home', () => {
  const shell = readFileSync(new URL('../app/shell.tsx', import.meta.url), 'utf8');
  assert.match(shell, /visibleNav\(me\.permissions\)/, 'the shell renders visibleNav of the session');
  assert.doesNotMatch(shell, /NAV\.map\(/, 'the unfiltered table is never rendered');
  assert.match(shell, /pathname === '\/' && me !== null && me\.home !== '\/'/, 'the root redirects a non-executive session');
  assert.match(shell, /router\.replace\(me\.home\)/);
  const login = readFileSync(new URL('../app/login/page.tsx', import.meta.url), 'utf8');
  assert.match(login, /router\.push\(me\?\.home \?\? '\/'\)/, 'sign-in lands on the home the API names');
  const executive = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(executive, /Not available to your role\. <Link href=\{unavailable\.home\}>/, 'the Executive view names the way out on a 403');
});

test('the client page and the queue print the sentence for a refused card, never a swallowed count', () => {
  const client = readFileSync(new URL('../app/clients/[id]/page.tsx', import.meta.url), 'utf8');
  for (const card of ['returns', 'documents', 'quotes', 'engagements', 'invoices', 'nextSession', 'packets', 'meetings']) {
    assert.match(client, new RegExp(`refused\\('${card}'`), `${card} routes its 403 to the card`);
  }
  assert.match(client, /<h2>Invoices\{unavailable\.invoices \|\| !settled\.invoices \? '' : ` \(\$\{invoices\.length\}\)`\}<\/h2>/, 'the Invoices heading drops its count when refused, and shows none until the read has answered');
  assert.match(client, /<h2>Documents\{unavailable\.documents \|\| !settled\.documents \? '' : ` \(\$\{docs\.length\}\)`\}<\/h2>/);
  assert.doesNotMatch(client, /<h2>Invoices \(\{invoices\.length\}\)<\/h2>/, 'the old "(0)" heading is gone');
  const queue = readFileSync(new URL('../app/queue/page.tsx', import.meta.url), 'utf8');
  assert.match(queue, /status === 403\) \{ setUnavailable\(true\)/);
  assert.match(queue, /data-testid="role-unavailable">Not available to your role</);
});
