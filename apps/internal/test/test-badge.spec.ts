// Audit item 12 (2026-09-09): the TEST badge the pipeline card shows appears in the client
// header too, with the test note on hover. Static on purpose — there is no render harness.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const client = readFileSync(new URL('../app/clients/[id]/page.tsx', import.meta.url), 'utf8');
const pipeline = readFileSync(new URL('../app/pipeline/page.tsx', import.meta.url), 'utf8');

test('the client header carries the TEST badge with the note on hover, the same badge the pipeline shows', () => {
  assert.match(client, /className="badge warn test-client-badge"/, 'the header badge');
  assert.match(client, /title=\{c\.test_note \?\?/, 'the test note is the hover text');
  assert.match(pipeline, /badge warn" title="Test client/, 'the pipeline badge is still there');
});
