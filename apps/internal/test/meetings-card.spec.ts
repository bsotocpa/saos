// Audit item 10 (2026-09-09): one "Meetings" card — the calendar on top, the recorded sessions
// under it, each row marked "recorded". The separate Sessions card is gone. Static on purpose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../app/clients/[id]/page.tsx', import.meta.url), 'utf8');

test('one Meetings card holds the calendar and the recorded sessions, and a recorded row says so', () => {
  assert.doesNotMatch(page, /<h2>Sessions \(/, 'the separate Sessions card is gone');
  assert.equal((page.match(/<h2>Meetings<\/h2>/g) ?? []).length, 1, 'one Meetings card');
  // R64: the count leaves the heading when meetings.read is refused; the heading itself stays under the card.
  assert.match(page, /<h3 style=\{\{ marginTop: 14 \}\}>Recorded\{unavailable\.meetings \? '' : ` \(\$\{sessions\.length\}\)`\}<\/h3>/, 'the recorded sessions live under it');
  assert.match(page, /badge ok" title="A recorded session: transcript and summary below\."\>recorded</, 'a recorded row is badged');
  const meetings = page.indexOf('<h2>Meetings</h2>');
  const recorded = page.indexOf('>Recorded{unavailable.meetings');
  assert.ok(recorded > meetings, 'the recorded list sits inside the Meetings card, after the calendar');
});
