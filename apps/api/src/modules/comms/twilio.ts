// Twilio inbound (launch gate): SMS and voice webhooks for the firm's
// texting number. Every request is authenticated with X-Twilio-Signature
// (HMAC-SHA1 over the exact URL + sorted form params, keyed by the auth
// token) — forged posts are refused before any parsing side effects.
//
// Number strategy (Brian, 2026-07-06): +1 708 300 0375 at launch; the 312
// number ports in later as a TWILIO_PHONE_NUMBER config swap — nothing here
// hardcodes the number.
//
// STOP compliance: Twilio's mandatory keyword handling sends the carrier
// auto-reply, and we ALSO revoke consent on our side (contact rollup +
// consents event) so no send path can ever text an opted-out client.

import { createHmac, timingSafeEqual } from 'node:crypto';

export function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined
): boolean {
  if (!signature) return false;
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  const expected = createHmac('sha1', authToken).update(data, 'utf8').digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/** Twilio posts x-www-form-urlencoded; the raw body is kept for signing. */
export function parseFormBody(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of raw.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const k = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
    const v = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    if (!(k in params)) params[k] = v;
  }
  return params;
}

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout']);

export function isStopMessage(params: Record<string, string>): boolean {
  if ((params['OptOutType'] ?? '').toUpperCase() === 'STOP') return true;
  return STOP_WORDS.has((params['Body'] ?? '').trim().toLowerCase());
}

export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
