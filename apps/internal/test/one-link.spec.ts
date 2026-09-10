// Item 14 (2026-09-09): one link per invoice. The Ops client page never prints the portal
// invoice URL again; the pay link is SENT through the one route, by email or text. Static on
// purpose — there is no render harness — and paired with pay-link-send.spec on the API side.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../app/clients/[id]/page.tsx', import.meta.url), 'utf8');

test('the client page prints no portal invoice URL, and sends the pay link through the one route', () => {
  assert.doesNotMatch(page, /invoices\?invoice=/, 'the portal URL "to be read out on a call" is retired');
  assert.match(page, /\/pay-link\/send/, 'the pay link is sent, not shown');
  assert.match(page, /Send the pay link…/, 'one control, one label');
});
