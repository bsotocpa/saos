// SES bounce/complaint handling via SNS (launch gate): AWS was told this
// process exists, so it is REAL — signature-verified SNS messages feed the
// same bounce workflow the mail module already runs (Rene task + audit).
//
// Security: every SNS message is verified against Amazon's signing
// certificate (RSA over the documented canonical string). Certificate and
// SubscribeURL hosts must be *.amazonaws.com over https — a forged message
// can neither spoof a bounce nor make us fetch an attacker URL.

import { createVerify } from 'node:crypto';

export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Subject?: string | undefined;
  Message: string;
  Timestamp: string;
  Token?: string | undefined;
  SubscribeURL?: string | undefined;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
}

/** Injectable HTTP layer so tests can supply their own cert + record fetches. */
export const snsHttp = {
  async fetchText(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SNS fetch ${url} -> ${res.status}`);
    return res.text();
  },
};

const certCache = new Map<string, string>();

export function isAmazonSnsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && /(^|\.)sns\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname);
  } catch {
    return false;
  }
}

function canonicalString(msg: SnsMessage): string {
  const keys =
    msg.Type === 'Notification'
      ? (['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] as const)
      : (['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'] as const);
  let out = '';
  for (const key of keys) {
    const value = msg[key];
    if (value === undefined || value === null) continue; // Subject is optional
    out += `${key}\n${value}\n`;
  }
  return out;
}

export async function verifySnsSignature(msg: SnsMessage): Promise<boolean> {
  if (!isAmazonSnsUrl(msg.SigningCertURL)) return false;
  let cert = certCache.get(msg.SigningCertURL);
  if (!cert) {
    cert = await snsHttp.fetchText(msg.SigningCertURL);
    certCache.set(msg.SigningCertURL, cert);
  }
  const algorithm = msg.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
  try {
    return createVerify(algorithm).update(canonicalString(msg), 'utf8').verify(cert, msg.Signature, 'base64');
  } catch {
    return false;
  }
}

export interface SesFeedback {
  kind: 'bounce' | 'complaint' | 'other';
  recipients: string[];
  detail: string | null; // bounceType/complaintFeedbackType — never message content
}

/** Parse the SES notification JSON riding inside SNS `Message`. */
export function parseSesFeedback(messageJson: string): SesFeedback {
  const m = JSON.parse(messageJson) as {
    notificationType?: string;
    bounce?: { bounceType?: string; bouncedRecipients?: Array<{ emailAddress?: string }> };
    complaint?: { complaintFeedbackType?: string; complainedRecipients?: Array<{ emailAddress?: string }> };
  };
  if (m.notificationType === 'Bounce') {
    return {
      kind: 'bounce',
      recipients: (m.bounce?.bouncedRecipients ?? []).map((r) => r.emailAddress ?? '').filter(Boolean),
      detail: m.bounce?.bounceType ?? null,
    };
  }
  if (m.notificationType === 'Complaint') {
    return {
      kind: 'complaint',
      recipients: (m.complaint?.complainedRecipients ?? []).map((r) => r.emailAddress ?? '').filter(Boolean),
      detail: m.complaint?.complaintFeedbackType ?? null,
    };
  }
  return { kind: 'other', recipients: [], detail: null };
}
