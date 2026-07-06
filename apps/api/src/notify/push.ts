// ntfy push (MP Alert Center: iPhone push, Brian + Jackson). Self-hosted —
// no third-party push service. The sweep runs every minute: unpushed
// warning/critical notifications addressed to the leadership roles go to the
// alerts topic, then get stamped pushed_at (never re-sent).

import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.ts';

export interface Pusher {
  readonly mode: 'stub' | 'ntfy';
  push(msg: { title: string; body: string; priority: 'default' | 'high' | 'urgent'; tags?: string[] }): Promise<void>;
}

function stubPusher(): Pusher {
  return {
    mode: 'stub',
    async push() {
      /* dev/test: the sweep's pushed_at stamp is the observable effect */
    },
  };
}

function ntfyPusher(config: Config): Pusher {
  const url = `${config.NTFY_URL.replace(/\/$/, '')}/${config.NTFY_TOPIC}`;
  return {
    mode: 'ntfy',
    async push(msg) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Title: msg.title,
          Priority: msg.priority,
          ...(msg.tags?.length ? { Tags: msg.tags.join(',') } : {}),
        },
        body: msg.body,
      });
      if (!res.ok) throw new Error(`ntfy push failed (${res.status})`);
    },
  };
}

export function makePusher(config: Config): Pusher {
  return config.PUSH_MODE === 'ntfy' ? ntfyPusher(config) : stubPusher();
}

/** Sweep unpushed leadership alerts to ntfy. Runs every minute; idempotent. */
export async function runPushSweep(app: FastifyInstance, pusher: Pusher): Promise<{ pushed: number }> {
  const { rows } = await app.db.query<{
    id: string; type: string; severity: string; title: string; body: string | null;
  }>(
    `SELECT n.id, n.type, n.severity, n.title, n.body
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
      await pusher.push({
        title: n.title,
        body: n.body ?? n.type.replace(/_/g, ' '),
        priority: n.severity === 'critical' ? 'urgent' : 'high',
        tags: [n.type],
      });
      await app.db.query(`UPDATE notifications SET pushed_at = now() WHERE id = $1`, [n.id]);
      pushed++;
    } catch (err) {
      app.log.warn({ err, notificationId: n.id }, 'push failed — will retry next sweep');
    }
  }
  return { pushed };
}
