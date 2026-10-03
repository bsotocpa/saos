#!/usr/bin/env node
/*
 * A PUSH CARRIES NO RECORD DATA (Brian, 2026-10-03, R127 step 4).
 *
 * Until 2026-10-03 a push carried the alert's own title and body, client names included, to a server
 * that took anonymous subscribers. A push now says only "1 new alert in Ops"; the alert stays in Ops.
 * This check reads the one file that may send a push (apps/api/src/notify/push.ts) and fails when:
 *   - the fixed text is not exactly "1 new alert in Ops", or it is not a plain string constant;
 *   - the pusher takes an argument (anything it is handed could reach the request);
 *   - the request's body is anything but the constant, or a header is anything but the token, the fixed
 *     title and a literal priority;
 *   - any ${…} in the file interpolates something other than the server address, the topic, the token
 *     or the response status;
 *   - the sweep reads an alert's title, body, type or related record, or hands the pusher anything;
 *   - the audit row of a push (R131) holds anything but the server and the outcome;
 *   - any other file under apps/ or scripts/ reaches the push server on its own.
 *
 *   node scripts/check-push-payload.mjs      (npm run check:push-payload; in the root suite)
 *
 * It tests itself first on synthetic sources, so a check that had gone blind cannot read green.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUSH_FILE = 'apps/api/src/notify/push.ts';
const TEXT = '1 new alert in Ops';
// What a ${…} in the push file may hold: where to send, the token, and the status that came back.
const MAY_INTERPOLATE = ['target.token', 'target.url', 'target.topic', 'res.status', 'err.status'];

/**
 * The body of the function, interface or object that starts at `marker`: from the first "{" that ends
 * its line (so a brace inside a parameter or return type is passed over) to the matching "}".
 */
function block(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const m = /\{[ \t]*\r?\n/.exec(src.slice(at + marker.length));
  if (!m) return null;
  const open = at + marker.length + m.index;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Every way the push file breaks the rule. `others` is [{ file, src }] for the rest of the tree. */
export function problemsIn(pushSrc, others = []) {
  const out = [];
  const src = noComments(pushSrc);
  if (!new RegExp(`export const PUSH_TEXT = '${TEXT}';`).test(src)) out.push(`the fixed text is not the plain constant '${TEXT}'`);
  if (!/export const PUSH_TITLE = '[^'$`]*';/.test(src)) out.push('the fixed title is not a plain string constant');

  const iface = block(src, 'export interface Pusher');
  if (!iface || !/\bpush\(\)\s*:\s*Promise<void>/.test(iface)) out.push('the Pusher interface hands push() an argument (it must take none)');
  if (/\bpush\(\s*[A-Za-z_{[]/.test(src.replace(/\.push\(\s*\)/g, ''))) out.push('a push() is declared or called with an argument');

  const sender = block(src, 'export function ntfyPusherFor');
  if (!sender) out.push('ntfyPusherFor, the one sender, is not in the file');
  else {
    if (!/\bbody:\s*PUSH_TEXT\s*,?\s*\n/.test(sender)) out.push('the request body is not the fixed text constant');
    const headers = block(sender, 'headers:');
    const lines = (headers ?? '').split('\n').map((l) => l.trim()).filter((l) => l && l !== '{' && l !== '}' && l !== '},');
    const allowed = [/^Authorization: `Bearer \$\{target\.token\}`,$/, /^Title: PUSH_TITLE,$/, /^Priority: '(default|high|urgent)',$/];
    for (const l of lines) if (!allowed.some((re) => re.test(l))) out.push(`a request header is not one of the three fixed ones: ${l.slice(0, 60)}`);
    if (lines.length !== 3) out.push(`the request carries ${lines.length} header line(s), not the three fixed ones`);
  }
  for (const m of src.matchAll(/\$\{([^}]*)\}/g)) {
    if (!MAY_INTERPOLATE.includes(m[1].trim())) out.push(`the push file interpolates \${${m[1].trim().slice(0, 40)}}`);
  }
  const sweep = block(src, 'export async function runPushSweep');
  if (!sweep) out.push('runPushSweep is not in the file');
  else {
    // The WHERE may filter on severity; what the sweep must never read is the alert's own words.
    if (/\bn\.(title|body|type|related_object_\w+)\b/.test(sweep)) out.push("the sweep reads the alert's own title, body, type or record");
    if (!/await pusher\.push\(\);/.test(sweep)) out.push('the sweep does not call pusher.push() with no argument');
  }
  // R131: one audit row per push, holding the server and the outcome and nothing else.
  const audit = block(src, 'async function auditPush');
  if (!audit) out.push('auditPush, the audit row of a push, is not in the file');
  else {
    const d = audit.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('details:'));
    if (d.length !== 1 || d[0] !== 'details: { server: pusher.server, outcome },') out.push('the audit row of a push holds something other than the server and the outcome');
    if (!/server: target\.url,/.test(sender ?? '')) out.push("the pusher's server is not the bare server address");
  }
  for (const o of others) {
    const s = noComments(o.src);
    if (/\bNTFY_(URL|TOPIC|TOKEN)\b/.test(s) && /\b(fetch|curl|wget|request)\b/.test(s)) out.push(`${o.file} reaches the push server on its own (only ${PUSH_FILE} may)`);
  }
  return out;
}

const GOOD = `
export const PUSH_TITLE = 'SAOS';
export const PUSH_TEXT = '${TEXT}';
export interface Pusher {
  readonly mode: 'stub' | 'ntfy';
  readonly server: string;
  push(): Promise<void>;
}
export function ntfyPusherFor(target: { url: string; topic: string; token: string | undefined }, send: typeof fetch = fetch): Pusher {
  return {
    mode: 'ntfy',
    server: target.url,
    async push() {
      const res = await send(\`\${target.url}/\${target.topic}\`, {
        method: 'POST',
        headers: {
          Authorization: \`Bearer \${target.token}\`,
          Title: PUSH_TITLE,
          Priority: 'high',
        },
        body: PUSH_TEXT,
      });
      if (!res.ok) throw new Error(\`ntfy push failed (\${res.status})\`);
    },
  };
}
async function auditPush(app: FastifyInstance, pusher: Pusher, notificationId: string, outcome: string): Promise<void> {
  await writeAudit(app.db, {
    action: 'notification.push',
    objectId: notificationId,
    details: { server: pusher.server, outcome },
  });
}
export async function runPushSweep(app: FastifyInstance, pusher: Pusher): Promise<{ pushed: number }> {
  const { rows } = await app.db.query(\`SELECT n.id FROM notifications n WHERE n.severity IN ('warning', 'critical')\`);
  for (const n of rows) {
    await pusher.push();
  }
}
`;
function selfTest() {
  const cases = [
    ['the file as ruled', GOOD, [], 0],
    ["the alert's title as the body", GOOD.replace('body: PUSH_TEXT,', 'body: msg.title,'), [], 1],
    ['a title header built from the alert', GOOD.replace('Title: PUSH_TITLE,', 'Title: headerSafe(msg.title),'), [], 1],
    ['a pusher that takes the alert', GOOD.replace('push(): Promise<void>;', 'push(msg: { title: string }): Promise<void>;').replace('async push() {', 'async push(msg) {'), [], 1],
    ['an interpolated client name', GOOD.replace("'ntfy push failed", "'x").replace('body: PUSH_TEXT,', 'body: PUSH_TEXT,\n        cache: `${n.title}`,'), [], 1],
    ['a sweep that reads the title', GOOD.replace('SELECT n.id FROM', 'SELECT n.id, n.title FROM'), [], 1],
    ['a different fixed text', GOOD.replace(`'${TEXT}'`, "'New alert: ' + name"), [], 1],
    ['an audit row that carries the alert', GOOD.replace('details: { server: pusher.server, outcome },', 'details: { server: pusher.server, outcome, title },'), [], 1],
    ['an audit row that names the topic', GOOD.replace('server: target.url,', 'server: target.url + target.topic,'), [], 1],
    ['a second sender elsewhere', GOOD, [{ file: 'apps/api/src/modules/x.ts', src: 'await fetch(`${config.NTFY_URL}/${config.NTFY_TOPIC}`, { body: title });' }], 1],
  ];
  const bad = cases.filter(([, src, others, min]) => (problemsIn(src, others).length >= 1) !== (min >= 1));
  for (const [name, , , min] of bad) console.error(`RED check-push-payload self-test: "${name}" was ${min ? 'accepted' : 'refused'}`);
  return bad.length === 0;
}

function tree(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.next' || n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) tree(p, out);
    else if (/\.(ts|tsx|mjs|js|sh)$/.test(n)) out.push(p);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!selfTest()) process.exit(1);
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  // Not senders: the config that names the keys, this check, the tests of the test-target guard, and the sabotage manifests.
  const skip = (f) => f === PUSH_FILE || f === 'apps/api/src/config.ts' || f === 'scripts/check-push-payload.mjs' || f.startsWith('scripts/sabotages/')
    || f.startsWith('apps/api/test/') || f === 'apps/api/scripts/check-test-targets.ts';
  const others = [...tree(resolve(root, 'apps')), ...tree(resolve(root, 'scripts'))]
    .map((p) => ({ file: rel(p), p })).filter((o) => !skip(o.file))
    .map((o) => ({ file: o.file, src: readFileSync(o.p, 'utf8') }));
  const problems = problemsIn(readFileSync(resolve(root, PUSH_FILE), 'utf8'), others);
  for (const p of problems) console.error(`RED ${p}`);
  if (problems.length) process.exit(1);
  console.log(`check-push-payload: a push carries only "${TEXT}"; one sender (${PUSH_FILE}); ${others.length} other files scanned.`);
}
