/*
 * Batch 20 (Brian, 2026-10-03): R127 step 4, a push carries the fixed text "1 new alert in Ops" and
 * nothing of the record (scripts/check-push-payload.mjs, npm run check:push-payload; and
 * apps/api/test/push-payload.spec.ts). Each item puts record data, a second sender or a tokenless
 * send back one way; the last blinds the check, and its own self-test must refuse it.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-10-03-o-r127.mjs
 */
export const date = '2026-10-03';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const swap = (from, to) => (t) => { must(t, from); return t.replace(from, to); };
const all = (...fns) => (t) => fns.reduce((acc, fn) => fn(acc), t);
const guard = { kind: 'guard', spec: 'check:push-payload' };
const spec = { kind: 'api', spec: 'test/push-payload.spec.ts' };
const push = 'apps/api/src/notify/push.ts';

// The push as it was before R127: the sweep reads the alert's title and the pusher sends it.
const titleAsBody = all(
  swap('push(): Promise<void>;', 'push(text?: string): Promise<void>;'),
  swap("mode: 'ntfy',\n    async push() {", "mode: 'ntfy',\n    async push(text?: string) {"),
  swap('body: PUSH_TEXT,', 'body: text ?? PUSH_TEXT,'),
  swap('`SELECT n.id\n', '`SELECT n.id, n.title\n'),
  swap('await pusher.push();', 'await pusher.push((n as { title?: string }).title);'),
);

export const items = [
  {
    item: "R127: the alert's title is sent as the push (the root check)",
    file: push,
    change: "the sweep selects the alert's title and hands it to the pusher, which sends it as the body",
    test: guard,
    apply: titleAsBody,
    expectRed: /the request body is not the fixed text constant/,
  },
  {
    item: "R127: the alert's title is sent as the push (the request itself)",
    file: push,
    change: 'the same change; the recorded request must show the client name and the test must refuse it',
    test: spec,
    apply: titleAsBody,
    expectRed: /an alert that names a client is pushed as the fixed text/,
  },
  {
    item: 'R127: a header built from something other than the fixed title',
    file: push,
    change: 'the Title header is no longer the constant',
    test: guard,
    apply: swap('Title: PUSH_TITLE,', 'Title: target.url,'),
    expectRed: /a request header is not one of the three fixed ones/,
  },
  {
    item: 'R127: a different fixed text',
    file: push,
    change: 'the text is reworded to say what kind of alert it is',
    test: guard,
    apply: swap("export const PUSH_TEXT = '1 new alert in Ops';", "export const PUSH_TEXT = '1 new invoice alert in Ops';"),
    expectRed: /the fixed text is not the plain constant/,
  },
  {
    item: 'R127: a second sender outside the push file',
    file: 'apps/api/src/jobs/daily.ts',
    change: 'the daily job posts to the push server on its own, with a title',
    test: guard,
    apply: (t) => t + "\nexport async function sideSend(config: { NTFY_URL: string; NTFY_TOPIC: string }, title: string) {\n  await fetch(`${config.NTFY_URL}/${config.NTFY_TOPIC}`, { method: 'POST', body: title });\n}\n",
    expectRed: /apps\/api\/src\/jobs\/daily\.ts reaches the push server on its own/,
  },
  {
    item: 'R127: a push sent without the token',
    file: push,
    change: 'the pusher no longer stops when no token is set',
    test: spec,
    apply: swap('if (!target.token || !target.topic) throw', 'if (false) throw'),
    expectRed: /with push on and no token, or no topic, nothing is sent/,
  },
  {
    item: 'R127: the check goes blind to interpolation',
    file: 'scripts/check-push-payload.mjs',
    change: 'any ${…} in the push file is accepted; the self-test must refuse the check',
    test: guard,
    apply: swap('if (!MAY_INTERPOLATE.includes(m[1].trim()))', 'if (false)'),
    expectRed: /self-test: "an interpolated client name" was accepted/,
  },
];
