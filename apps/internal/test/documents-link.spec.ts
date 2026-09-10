// Audit item 8 (2026-09-09): "+N more" on the client page opens the documents page filtered to
// this client, and the documents page honours that filter. Static on purpose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const client = readFileSync(new URL('../app/clients/[id]/page.tsx', import.meta.url), 'utf8');
const documents = readFileSync(new URL('../app/documents/page.tsx', import.meta.url), 'utf8');

test('"+N more" is a link to this client\'s documents, and the documents page passes the filter to the API', () => {
  assert.match(client, /href=\{`\/documents\?contactId=\$\{params\.id\}`\}/, 'the link carries the client');
  assert.doesNotMatch(client, /<p className="muted small">\+\{docs\.length - 12\} more<\/p>/, 'the dead "+N more" is gone');
  assert.match(documents, /get\('contactId'\)/, 'the documents page reads it');
  assert.match(documents, /q\.set\('contactId', contactId\)/, 'and sends it to /documents/overview');
});
