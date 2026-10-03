// ntfy push (MP Alert Center: a leadership alert reaches the phone within a minute). Self-hosted —
// no third-party push service. The sweep runs every minute: each unpushed warning/critical
// notification addressed to the leadership roles produces one push, then is stamped pushed_at
// (never re-sent).
//
// A PUSH SAYS ONLY THAT AN ALERT EXISTS (Brian, 2026-10-03, R127). Until that day a push carried the
// alert's own title and body ("Invoice … unpaid 30+ days: <client name>") to a server that accepted
// anonymous subscribers on a default topic name. Now:
//   - every push is the same fixed text, PUSH_TEXT, under the fixed title PUSH_TITLE: no client name,
//     amount, return or invoice ever leaves the API this way. The alert itself stays in Ops → Alerts;
//   - the pusher takes NO argument, so nothing about the record can reach the request;
//   - the request carries the API's own token, and without a token or a topic nothing is sent at all;
//   - scripts/check-push-payload.mjs (root suite) fails if any of that stops being true.
//
// EVERY PUSH LEAVES ONE AUDIT ROW (Brian, 2026-10-03, R131): the time, the server and the outcome,
// never the content. On 2026-10-03, 78 of the 87 messages the server had ever published had no record
// of what sent them. A request that left (sent, refused, or unanswered) is a row; a push that never
// left (no token, or push switched off) is not.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.ts';
import { writeAudit } from '../audit.ts';

export const PUSH_TITLE = 'SAOS';
export const PUSH_TEXT = '1 new alert in Ops';

export interface Pusher {
  readonly mode: 'stub' | 'ntfy';
  /** Where a push goes: the server's address only, never the topic or the token. */
  readonly server: string;
  push(): Promise<void>;
}

/** Nothing left the API: no token or no topic. Logged, never audited as a push. */
export class PushNotSent extends Error {}

/** The server answered and refused. */
export class PushRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function stubPusher(): Pusher {
  return {
    mode: 'stub',
    server: 'none',
    async push() {
      /* dev/test, or push switched off: the sweep's pushed_at stamp is the observable effect */
    },
  };
}

/** The ntfy sender, from plain values (the tests build it with a recording fetch; nothing leaves them). */
export function ntfyPusherFor(target: { url: string; topic: string; token: string | undefined }, send: typeof fetch = fetch): Pusher {
  return {
    mode: 'ntfy',
    server: target.url,
    async push() {
      if (!target.token || !target.topic) throw new PushNotSent('push is on but NTFY_TOKEN or NTFY_TOPIC is not set: nothing was sent');
      const res = await send(`${target.url}/${target.topic}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${target.token}`,
          Title: PUSH_TITLE,
          Priority: 'high',
        },
        body: PUSH_TEXT,
      });
      if (!res.ok) throw new PushRefused(res.status, `ntfy push failed (${res.status})`);
    },
  };
}

export function makePusher(config: Config): Pusher {
  if (config.PUSH_MODE !== 'ntfy') return stubPusher();
  return ntfyPusherFor({ url: config.NTFY_URL.replace(/\/$/, ''), topic: config.NTFY_TOPIC, token: config.NTFY_TOKEN });
}

/** One audit row for a request that left: when (the row's own time), to which server, and what came of it. */
async function auditPush(app: FastifyInstance, pusher: Pusher, notificationId: string, outcome: string): Promise<void> {
  if (pusher.mode !== 'ntfy') return;
  await writeAudit(app.db, {
    actorType: 'system',
    action: 'notification.push',
    objectType: 'notification',
    objectId: notificationId,
    details: { server: pusher.server, outcome },
  });
}

/** Sweep unpushed leadership alerts: one fixed-text push each. Runs every minute; idempotent. */
export async function runPushSweep(app: FastifyInstance, pusher: Pusher): Promise<{ pushed: number }> {
  const { rows } = await app.db.query<{ id: string }>(
    `SELECT n.id
     FROM notifications n
     JOIN staff st ON st.id = n.staff_id
     JOIN roles r ON r.id = st.role_id
     WHERE n.pushed_at IS NULL
       AND n.severity IN ('warning', 'critical')
       AND r.key IN ('ceo', 'ed_coo')
     ORDER BY n.created_at
     LIMIT 50`
  );
  let pushed = 0;
  for (const n of rows) {
    try {
      await pusher.push();
    } catch (err) {
      app.log.warn({ err, notificationId: n.id }, 'push failed — will retry next sweep');
      if (!(err instanceof PushNotSent)) {
        await auditPush(app, pusher, n.id, err instanceof PushRefused ? `refused (${err.status})` : 'no answer');
      }
      // The request is the same fixed one for every alert, so the rest would fail the same way.
      break;
    }
    // The row before the stamp: a push with no audit row is the gap R131 closes.
    await auditPush(app, pusher, n.id, 'sent');
    await app.db.query(`UPDATE notifications SET pushed_at = now() WHERE id = $1`, [n.id]);
    pushed++;
  }
  return { pushed };
}
