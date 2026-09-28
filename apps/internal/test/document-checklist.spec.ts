// R83 (Brian, 2026-09-27): what Ops says about a return's document checklist, pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checklistCountLine, documentRequestSentence } from '../lib/return-controls.ts';

test('the return row reads the checklist as received and missing counts', () => {
  assert.equal(checklistCountLine(1, 3), 'Documents: 1 received · 3 missing');
  assert.equal(checklistCountLine(4, 0), 'Documents: 4 received · 0 missing');
});

test('"Request documents" says what it did with the email: sent, or held and why', () => {
  assert.equal(documentRequestSentence({ emailed: true, missing: 3 }), 'Emailed the client the 3 missing items on the checklist, with the portal link.');
  assert.equal(documentRequestSentence({ emailed: true, missing: 1 }), 'Emailed the client the 1 missing item on the checklist, with the portal link.');
  assert.equal(
    documentRequestSentence({ emailed: false, reason: 'automation_off', missing: 2 }),
    'Not emailed: the "Request documents" automation is off (Admin → Automations). The client sees the 2 missing items in the portal.'
  );
  assert.match(documentRequestSentence({ emailed: false, reason: 'no_email', missing: 2 }), /^Not emailed: this client has no email on file\./);
  assert.equal(documentRequestSentence({ emailed: false, reason: 'nothing_missing', missing: 0 }), 'Nothing to send: every item on the checklist is in.');
  assert.match(documentRequestSentence({ emailed: false, reason: 'no_checklist', missing: 0 }), /^Nothing to send: this return has no checklist/);
});
