#!/usr/bin/env node
/*
 * THE PUBLIC HOSTS ARE A LIST, AND THE NTFY HOST KEEPS AN ACCESS LOG (Brian, 2026-10-03, R130, R131).
 *
 * R130. Uptime Kuma was never set up, and status.sotoaccounting.com served its first-run page to
 * anyone. A service is either configured or not routed, so the proxy's hosts are held to a list here:
 * a new public host is added to deploy/Caddyfile AND named below, on purpose, or this fails. Nothing
 * may proxy to uptime-kuma.
 *
 * R131. The ntfy host writes an access log: the time, the method, the path, the status and the client
 * address; no header, no query string, no body; kept 90 days by logrotate on the box
 * (deploy/logrotate-ntfy-access, installed by scripts/deploy.sh into a folder the proxy mounts).
 *
 *   node scripts/check-public-hosts.mjs      (npm run check:public-hosts; in the root suite)
 *
 * It tests itself first on synthetic files, so a check that had gone blind cannot read green.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Every address the proxy answers for. Uptime Kuma has none (R130).
const PUBLIC_HOSTS = ['api', 'book', 'ntfy', 'ops', 'portal', 'vault'].map((h) => `${h}.sotoaccounting.com`);
const LOG_PATH = '/var/log/caddy/ntfy-access.log';
// What the ntfy host's log must drop, so a line is the time, method, path, status and client address.
const MUST_DROP = ['request>headers delete', 'request>tls delete', 'resp_headers delete', 'user_id delete', 'request>uri regexp "\\?.*$" ""'];

const noComments = (s) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

/** The site blocks of a Caddy file: { host: body }. A site opens at column 0 and closes at a "}" at column 0. */
function sites(caddy) {
  const out = {};
  const lines = noComments(caddy).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\S[^{]*?)\s*\{\s*$/.exec(lines[i]);
    if (!m || m[1] === '') continue;
    const end = lines.indexOf('}', i + 1);
    if (end < 0) break;
    out[m[1].trim()] = lines.slice(i + 1, end).join('\n');
    i = end;
  }
  return out;
}

/** Every way the four files break R130 or R131. */
export function problemsIn({ caddy, compose, rotate, deploy }) {
  const out = [];
  const blocks = sites(caddy);
  const hosts = Object.keys(blocks).filter((h) => h !== '').flatMap((h) => h.split(/[\s,]+/)).filter(Boolean).sort();
  for (const h of hosts) if (!PUBLIC_HOSTS.includes(h)) out.push(`${h} is a public host the list does not name (a first-run or setup page must never be reachable from outside)`);
  for (const h of PUBLIC_HOSTS) if (!hosts.includes(h)) out.push(`${h} is on the list and not in the Caddy file`);
  if (/uptime-kuma/.test(noComments(caddy))) out.push('the Caddy file proxies to uptime-kuma: Kuma has no public address (R130)');

  const ntfy = blocks['ntfy.sotoaccounting.com'] ?? '';
  if (!/^\tlog \{$/m.test(ntfy)) out.push('the ntfy host has no access log (R131)');
  else {
    if (!ntfy.includes(`output file ${LOG_PATH} {`)) out.push(`the ntfy host's log does not go to ${LOG_PATH}`);
    if (!/^\t\t\troll_disabled$/m.test(ntfy)) out.push("Caddy's own rolling is on: logrotate keeps the 90 days, and two rotators lose lines");
    if (!/format filter \{/.test(ntfy) || !/wrap json/.test(ntfy)) out.push("the ntfy host's log is not filtered");
    for (const d of MUST_DROP) if (!ntfy.split('\n').some((l) => l.trim() === d)) out.push(`the ntfy host's log keeps what it must drop: ${d}`);
  }
  for (const [h, body] of Object.entries(blocks)) {
    if (h !== 'ntfy.sotoaccounting.com' && /^\tlog\b/m.test(body)) out.push(`${h} has an access log: only the ntfy host is ruled (R131); the others are post-freeze work`);
  }

  if (!compose.includes('- /mnt/saos-data/logs/caddy:/var/log/caddy')) out.push('the proxy does not mount its log folder from the encrypted volume');

  const r = noComments(rotate);
  if (!r.includes('/mnt/saos-data/logs/caddy/ntfy-access.log {')) out.push('the rotation does not name the ntfy access log');
  for (const want of ['daily', 'rotate 90', 'maxage 90', 'copytruncate']) {
    if (!r.split('\n').some((l) => l.trim() === want)) out.push(`the rotation lacks "${want}": the log is kept 90 days, rotated daily`);
  }
  if (!deploy.includes('install -m 644 /opt/saos/deploy/logrotate-ntfy-access /etc/logrotate.d/saos-ntfy-access')) out.push('the deploy does not install the rotation');
  if (!deploy.includes('caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile')) out.push('the deploy recreates the proxy without validating the Caddy file first');
  return out;
}

const site = (h, body) => `${h}.sotoaccounting.com {\n${body}\n}\n`;
const NTFY = `\tlog {\n\t\toutput file ${LOG_PATH} {\n\t\t\tmode 0600\n\t\t\troll_disabled\n\t\t}\n\t\tformat filter {\n\t\t\twrap json\n\t\t\tfields {\n${MUST_DROP.map((d) => `\t\t\t\t${d}`).join('\n')}\n\t\t\t}\n\t\t}\n\t}\n\treverse_proxy ntfy:80`;
const GOOD = {
  caddy: `{\n\temail x@example.test\n}\n\n${['api', 'book', 'ops', 'portal', 'vault'].map((h) => site(h, `\treverse_proxy ${h}:80`)).join('\n')}\n${site('ntfy', NTFY)}`,
  compose: '    volumes:\n      - /mnt/saos-data/logs/caddy:/var/log/caddy\n',
  rotate: '/mnt/saos-data/logs/caddy/ntfy-access.log {\n\tdaily\n\trotate 90\n\tmaxage 90\n\tcopytruncate\n}\n',
  deploy: "install -m 644 /opt/saos/deploy/logrotate-ntfy-access /etc/logrotate.d/saos-ntfy-access\ncaddy validate --adapter caddyfile --config /etc/caddy/Caddyfile\n",
};
function selfTest() {
  const withCaddy = (fn) => ({ ...GOOD, caddy: fn(GOOD.caddy) });
  const cases = [
    ['the files as ruled', GOOD, 0],
    ['the status host back', withCaddy((c) => c + site('status', '\treverse_proxy uptime-kuma:3001')), 1],
    ['a new public host nobody named', withCaddy((c) => c + site('setup', '\treverse_proxy something:80')), 1],
    ['Kuma behind another name', withCaddy((c) => c.replace('reverse_proxy vault:80', 'reverse_proxy uptime-kuma:3001')), 1],
    ['the ntfy log removed', withCaddy((c) => c.replace(NTFY, '\treverse_proxy ntfy:80')), 1],
    ['headers kept in the log', withCaddy((c) => c.replace('\t\t\t\trequest>headers delete\n', '')), 1],
    ['the query string kept in the log', withCaddy((c) => c.replace('\t\t\t\trequest>uri regexp "\\?.*$" ""\n', '')), 1],
    ['a year of retention', { ...GOOD, rotate: GOOD.rotate.replace('rotate 90', 'rotate 365').replace('maxage 90', 'maxage 365') }, 1],
    ['the log folder not mounted', { ...GOOD, compose: '    volumes:\n' }, 1],
    ['the rotation not installed', { ...GOOD, deploy: 'caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile\n' }, 1],
  ];
  const bad = cases.filter(([, files, min]) => (problemsIn(files).length >= 1) !== (min >= 1));
  for (const [name, , min] of bad) console.error(`RED check-public-hosts self-test: "${name}" was ${min ? 'accepted' : 'refused'}`);
  return bad.length === 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!selfTest()) process.exit(1);
  const read = (f) => readFileSync(resolve(root, f), 'utf8').replace(/\r\n/g, '\n');
  const problems = problemsIn({
    caddy: read('deploy/Caddyfile'),
    compose: read('docker-compose.prod.yml'),
    rotate: read('deploy/logrotate-ntfy-access'),
    deploy: read('scripts/deploy.sh'),
  });
  for (const p of problems) console.error(`RED ${p}`);
  if (problems.length) process.exit(1);
  console.log(`check-public-hosts: ${PUBLIC_HOSTS.length} public hosts, none of them Uptime Kuma; the ntfy host logs time, method, path, status and client address, kept 90 days.`);
}
