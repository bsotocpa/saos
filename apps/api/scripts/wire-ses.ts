// SES SMTP wiring tool (M23 prep). Takes the IAM accessKeys.csv that AWS
// hands out, DERIVES the region-scoped SMTP password (SigV4 chain — raw IAM
// secrets are not valid SMTP passwords), finds the right region by auth-only
// probes, patches .env.production in place, and optionally sends one test
// email. Prints NO secret material — region names and result codes only.
//
//   node scripts/wire-ses.ts <accessKeys.csv> [--send-test=you@example.com]
//
// Reusable at key rotation: run it again with the new CSV.

import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const REGIONS = ['us-east-2', 'us-east-1', 'us-west-2'];

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('usage: node scripts/wire-ses.ts <accessKeys.csv> [--send-test=addr]');
  process.exit(1);
}
const sendTo = process.argv.find((a) => a.startsWith('--send-test='))?.slice('--send-test='.length) ?? null;

// AWS accessKeys.csv: header line + one row "AccessKeyId,SecretAccessKey".
const csv = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/);
const row = csv[1]?.split(',');
const accessKeyId = row?.[0]?.trim();
const secret = row?.[1]?.trim();
if (!accessKeyId?.startsWith('AKIA') || !secret) {
  console.error('wire-ses: that file does not look like an AWS accessKeys.csv (header + AKIA…,secret row).');
  process.exit(1);
}

/** AWS-documented derivation: SigV4 chain over the literal date/service/message. */
function smtpPassword(secretAccessKey: string, region: string): string {
  const h = (key: Buffer | string, msg: string) => createHmac('sha256', key).update(msg, 'utf8').digest();
  let sig = h(`AWS4${secretAccessKey}`, '11111111');
  for (const part of [region, 'ses', 'aws4_request', 'SendRawEmail']) sig = h(sig, part);
  return Buffer.concat([Buffer.from([0x04]), sig]).toString('base64');
}

async function authWorks(region: string, pass: string): Promise<boolean> {
  const transport = nodemailer.createTransport({
    host: `email-smtp.${region}.amazonaws.com`,
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: accessKeyId, pass },
    connectionTimeout: 15_000,
  });
  try {
    await transport.verify(); // EHLO + STARTTLS + AUTH, no mail sent
    return true;
  } catch {
    return false;
  } finally {
    transport.close();
  }
}

let found: { region: string; pass: string } | null = null;
for (const region of REGIONS) {
  const pass = smtpPassword(secret, region);
  process.stdout.write(`wire-ses: probing ${region}... `);
  if (await authWorks(region, pass)) {
    console.log('AUTH OK');
    found = { region, pass };
    break;
  }
  console.log('auth refused');
}
if (!found) {
  console.error(
    'wire-ses: no probed region accepted these credentials. Check that the IAM user has ses:SendRawEmail, ' +
      `or add its region to REGIONS (${REGIONS.join(', ')} tried).`
  );
  process.exit(1);
}

// Patch .env.production in place — secrets go to the git-ignored file, not stdout.
const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, '../../../.env.production');
let env = await readFile(envPath, 'utf8');
const setLine = (key: string, value: string) => {
  const line = `${key}=${value}`;
  env = new RegExp(`^${key}=`, 'm').test(env) ? env.replace(new RegExp(`^${key}=.*$`, 'm'), line) : `${env}\n${line}`;
};
setLine('SMTP_HOST', `email-smtp.${found.region}.amazonaws.com`);
setLine('SMTP_PORT', '587');
setLine('SMTP_USER', accessKeyId);
setLine('SMTP_PASS', found.pass);
await writeFile(envPath, env, 'utf8');
console.log(`wire-ses: .env.production updated (region ${found.region}, user ${accessKeyId.slice(0, 4)}…${accessKeyId.slice(-4)}).`);

if (sendTo) {
  const transport = nodemailer.createTransport({
    host: `email-smtp.${found.region}.amazonaws.com`,
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: accessKeyId, pass: found.pass },
  });
  try {
    const info = await transport.sendMail({
      from: 'Soto Accounting <no-reply@sotoaccounting.com>',
      to: sendTo,
      subject: 'SAOS SES relay test',
      text: 'The SAOS production mail relay is wired to Amazon SES. This is a one-off test — no action needed.',
    });
    console.log(`wire-ses: TEST EMAIL SENT to ${sendTo} (message id ${info.messageId}).`);
  } catch (err) {
    // SES rejection texts (sandbox / unverified identity) name only email
    // addresses and are exactly what the operator needs to see.
    console.log(`wire-ses: test send REFUSED: ${(err as Error).message}`);
  } finally {
    transport.close();
  }
}
