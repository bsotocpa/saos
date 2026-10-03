/*
 * Batch 21 (Brian, 2026-10-03): R130, Uptime Kuma has no public address, and R131, the ntfy host's
 * access log and one audit row per push (scripts/check-public-hosts.mjs, npm run check:public-hosts;
 * scripts/check-push-payload.mjs; apps/api/test/push-payload.spec.ts). Each item puts one thing back
 * the way it was, or loosens the log or the audit row one way; the last blinds the new check, and its
 * own self-test must refuse it.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-10-03-p-r130-r131.mjs
 */
export const date = '2026-10-03';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const swap = (from, to) => (t) => { must(t, from); return t.replace(from, to); };
const hosts = { kind: 'guard', spec: 'check:public-hosts' };
const payload = { kind: 'guard', spec: 'check:push-payload' };
const spec = { kind: 'api', spec: 'test/push-payload.spec.ts' };
const caddy = 'deploy/Caddyfile';
const push = 'apps/api/src/notify/push.ts';

export const items = [
  {
    item: 'R130: the status host back in the Caddy file',
    file: caddy,
    change: 'the block removed by R130 is appended again',
    test: hosts,
    apply: (t) => t + '\nstatus.sotoaccounting.com {\n\treverse_proxy uptime-kuma:3001\n}\n',
    expectRed: /status\.sotoaccounting\.com is a public host the list does not name/,
  },
  {
    item: 'R130: Kuma reachable behind another public name',
    file: caddy,
    change: 'the vault host proxies to uptime-kuma',
    test: hosts,
    apply: swap('reverse_proxy vaultwarden:80', 'reverse_proxy uptime-kuma:3001'),
    expectRed: /the Caddy file proxies to uptime-kuma/,
  },
  {
    item: "R131: the ntfy host's log keeps the request headers",
    file: caddy,
    change: 'the filter no longer drops request headers',
    test: hosts,
    apply: swap('\t\t\t\trequest>headers delete\n', ''),
    expectRed: /keeps what it must drop: request>headers delete/,
  },
  {
    item: "R131: the ntfy host's log keeps the query string",
    file: caddy,
    change: 'the filter no longer cuts the path at the question mark',
    test: hosts,
    apply: swap('\t\t\t\trequest>uri regexp "\\?.*$" ""\n', ''),
    expectRed: /keeps what it must drop: request>uri regexp/,
  },
  {
    item: 'R131: the access log kept a year',
    file: 'deploy/logrotate-ntfy-access',
    change: 'rotate 365 and maxage 365',
    test: hosts,
    apply: (t) => swap('maxage 90', 'maxage 365')(swap('rotate 90', 'rotate 365')(t)),
    expectRed: /the rotation lacks "rotate 90"/,
  },
  {
    item: "R131: the audit row of a push carries the push's text",
    file: push,
    change: 'details gains a third field',
    test: payload,
    apply: swap('details: { server: pusher.server, outcome },', 'details: { server: pusher.server, outcome, text: PUSH_TEXT },'),
    expectRed: /the audit row of a push holds something other than the server and the outcome/,
  },
  {
    item: 'R131: a push is sent and no audit row is written',
    file: push,
    change: 'the row for a sent push is skipped',
    test: spec,
    apply: swap("await auditPush(app, pusher, n.id, 'sent');", ''),
    expectRed: /an alert that names a client is pushed as the fixed text/,
  },
  {
    item: 'R131: the audit row names the topic',
    file: push,
    change: "the pusher's server is the address with the topic appended",
    test: spec,
    apply: swap('server: target.url,', "server: target.url + '/' + target.topic,"),
    expectRed: /an alert that names a client is pushed as the fixed text/,
  },
  {
    item: 'R130: the check goes blind to a host nobody named',
    file: 'scripts/check-public-hosts.mjs',
    change: 'a host off the list is accepted; the self-test must refuse the check',
    test: hosts,
    apply: swap('if (!PUBLIC_HOSTS.includes(h)) out.push(', 'if (false) out.push('),
    expectRed: /self-test: "a new public host nobody named" was accepted/,
  },
];
