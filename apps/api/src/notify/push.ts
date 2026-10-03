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

import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.ts';

export const PUSH_TITLE = 'SAOS';
export const PUSH_TEXT = '1 new alert in Ops';

export interface Pusher {
  readonly mode: 'stub' | 'ntfy';
  push(): Promise<void>;
}

function stubPusher(): Pusher {
  return {
    mode: 'stub',
    async push() {
      /* dev/test, or push switched off: the sweep's pushed_at stamp is the observable effect */
    },
  };
}

/** The ntfy sender, from plain values (the tests build it with a recording fetch; nothing leaves them). */
export function ntfyPusherFor(target: { url: string; topic: string; token: string | undefined }, send: typeof fetch = fetch): Pusher {
  return {
    mode: 'ntfy',
    async push() {
      if (!target.token || !target.topic) throw new Error('push is on but NTFY_TOKEN or NTFY_TOPIC is not set: nothing was sent');
      const res = await send(`${target.url}/${target.topic}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${target.token}`,
          Title: PUSH_TITLE,
          Priority: 'high',
        },
        body: PUSH_TEXT,
      });
      if (!res.ok) throw new Error(`ntfy push failed (${res.status})`);
    },
  };
}

export function makePusher(config: Config): Pusher {
  if (config.PUSH_MODE !== 'ntfy') return stubPusher();
  return ntfyPusherFor({ url: config.NTFY_URL.replace(/\/$/, ''), topic: config.NTFY_TOPIC, token: config.NTFY_TOKEN });
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
      await app.db.query(`UPDATE notifications SET pushed_at = now() WHERE id = $1`, [n.id]);
      pushed++;
    } catch (err) {
      app.log.warn({ err, notificationId: n.id }, 'push failed — will retry next sweep');
    }
  }
  return { pushed };
}
