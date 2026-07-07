// M23: provision the SAOS production server on Hetzner Cloud. Idempotent —
// every resource is looked up by name before creation, so reruns converge
// instead of duplicating. Prints public facts only (ids, IPs, statuses);
// the token stays in env / .env.production.
//
//   HETZNER_API_TOKEN=... node scripts/provision-hetzner.mjs
//   (or rerun later with the token already in .env.production)
//
// What it ensures:
//   ssh key   saos-deploy      (public half of ~/.ssh/saos_hetzner_ed25519)
//   firewall  saos-prod-fw     (inbound: 22, 80, 443, ICMP — nothing else;
//                               Postgres/MinIO/etc. stay compose-internal)
//   server    saos-prod        (CPX41 per MP, Ubuntu 24.04, US location,
//                               Docker preinstalled via cloud-init)

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, '../.env.production');

let token = process.env.HETZNER_API_TOKEN ?? null;
if (!token) {
  const env = await readFile(envPath, 'utf8').catch(() => '');
  token = env.match(/^HETZNER_API_TOKEN=(\S+)$/m)?.[1] ?? null;
}
if (!token) {
  console.error('provision: no HETZNER_API_TOKEN in env or .env.production.');
  process.exit(1);
}

const API = 'https://api.hetzner.cloud/v1';
async function api(method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${route} -> ${res.status}: ${json.error?.message ?? 'unknown error'}`);
  }
  return json;
}

// ── [1] token + capability check ────────────────────────────────────────────
const servers = await api('GET', '/servers');
console.log(`provision: token OK — project currently has ${servers.servers.length} server(s).`);

// ── [2] pick a US location with CPX41 available ─────────────────────────────
const types = await api('GET', '/server_types');
const cpx41 = types.server_types.find((t) => t.name === 'cpx41');
if (!cpx41) throw new Error('cpx41 not offered on this account.');
const datacenters = await api('GET', '/datacenters');
const usPreference = ['ash', 'hil'];
let location = null;
for (const loc of usPreference) {
  const dc = datacenters.datacenters.find(
    (d) => d.location.name === loc && d.server_types.available.includes(cpx41.id)
  );
  if (dc) { location = loc; break; }
}
if (!location) throw new Error('CPX41 not available in ash/hil right now — check other locations in the console.');
console.log(`provision: CPX41 available in '${location}' (US) — using it.`);

// ── [3] ssh key ──────────────────────────────────────────────────────────────
const pubKeyPath = path.join(homedir(), '.ssh', 'saos_hetzner_ed25519.pub');
const publicKey = (await readFile(pubKeyPath, 'utf8')).trim();
let sshKey = (await api('GET', '/ssh_keys?name=saos-deploy')).ssh_keys[0];
if (!sshKey) {
  sshKey = (await api('POST', '/ssh_keys', { name: 'saos-deploy', public_key: publicKey })).ssh_key;
  console.log('provision: ssh key "saos-deploy" registered.');
} else {
  console.log('provision: ssh key "saos-deploy" already registered.');
}

// ── [4] firewall ─────────────────────────────────────────────────────────────
const anywhere = ['0.0.0.0/0', '::/0'];
let firewall = (await api('GET', '/firewalls?name=saos-prod-fw')).firewalls[0];
if (!firewall) {
  firewall = (
    await api('POST', '/firewalls', {
      name: 'saos-prod-fw',
      rules: [
        { direction: 'in', protocol: 'tcp', port: '22', source_ips: anywhere, description: 'ssh' },
        { direction: 'in', protocol: 'tcp', port: '80', source_ips: anywhere, description: 'http -> Caddy redirect' },
        { direction: 'in', protocol: 'tcp', port: '443', source_ips: anywhere, description: 'https' },
        { direction: 'in', protocol: 'icmp', source_ips: anywhere, description: 'ping' },
      ],
    })
  ).firewall;
  console.log('provision: firewall "saos-prod-fw" created (22/80/443/icmp only).');
} else {
  console.log('provision: firewall "saos-prod-fw" already exists.');
}

// ── [5] server ───────────────────────────────────────────────────────────────
const CLOUD_INIT = `#cloud-config
package_update: true
package_upgrade: true
packages: [ca-certificates, curl, git]
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker
`;

let server = (await api('GET', '/servers?name=saos-prod')).servers[0];
if (!server) {
  server = (
    await api('POST', '/servers', {
      name: 'saos-prod',
      server_type: 'cpx41',
      image: 'ubuntu-24.04',
      location,
      ssh_keys: [sshKey.id],
      firewalls: [{ firewall: firewall.id }],
      user_data: CLOUD_INIT,
    })
  ).server;
  console.log(`provision: server "saos-prod" created (id ${server.id}) — waiting for it to run...`);
} else {
  console.log(`provision: server "saos-prod" already exists (id ${server.id}, status ${server.status}).`);
}

for (let i = 0; i < 30 && server.status !== 'running'; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  server = (await api('GET', `/servers/${server.id}`)).server;
}
const ip4 = server.public_net.ipv4?.ip ?? '(none)';
const ip6 = server.public_net.ipv6?.ip ?? '(none)';
console.log(`provision: status ${server.status} — IPv4 ${ip4} · IPv6 ${ip6}`);

// ── [6] record in .env.production (token for reruns + the IP for deploy) ────
let env = await readFile(envPath, 'utf8');
const setLine = (key, value) => {
  const line = `${key}=${value}`;
  env = new RegExp(`^${key}=`, 'm').test(env)
    ? env.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : `${env.trimEnd()}\n${line}\n`;
};
if (!env.includes('# -- Deploy tooling')) {
  env = `${env.trimEnd()}\n\n# -- Deploy tooling (not read by the app) ------------------------------------\n`;
}
setLine('HETZNER_API_TOKEN', token);
setLine('SERVER_IPV4', ip4);
setLine('SERVER_IPV6', ip6);
await writeFile(envPath, env, 'utf8');
console.log('provision: .env.production updated (token + server IPs).');

console.log(`
provision: DNS records to create at the registrar (all A -> ${ip4}, AAAA -> ${ip6}):
  portal.sotoaccounting.com    (client portal)
  api.sotoaccounting.com       (API + webhooks)
  ops.sotoaccounting.com       (internal app)
  sign.sotoaccounting.com      (Docuseal)
  book.sotoaccounting.com      (Cal.com)
  ntfy.sotoaccounting.com      (push)
  vault.sotoaccounting.com     (Vaultwarden)
  status.sotoaccounting.com    (Uptime Kuma)
provision: done.`);
