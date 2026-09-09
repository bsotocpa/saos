// CONTAINER HEALTH WATCHDOG.
//
// Why this exists, precisely: ClamAV sat unhealthy for ~12 hours with 1470 failed
// health checks, wedged mid-database-reload, and Brian found out from a container
// listing I happened to paste into a report. A dead virus scanner should be on his
// dashboard at minute ten, not hour twelve.
//
// TWO DELIBERATE DESIGN CHOICES:
//
// 1. THE API DOES NOT TOUCH THE DOCKER SOCKET. Mounting /var/run/docker.sock into
//    the API container would hand root-equivalent control of the host to the
//    process most exposed to the internet. Instead a host-side cron script (the
//    same idempotent pattern as the nightly backup cron) reads container health and
//    POSTs it here. The API stores and alerts; it never inspects.
//
// 2. IT ALSO PROBES WHAT THE APP ACTUALLY NEEDS. Docker health says "the container
//    thinks it is fine". `probeDependencies` asks the different and more useful
//    question: can the API reach the scanner right now? A container can be healthy
//    while unreachable from the app, and that failure is invisible to Docker.
//
// Alerts follow the backup watchdog exactly: notifyOnce (so it nags rather than
// spams) plus ONE open task per service until it closes.

import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { firstActiveByRole, notifyOnce, ownerForRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { getSetting } from '../tax/extension.ts';

export interface ContainerReport {
  name: string;
  /** Docker's own verdict: healthy | unhealthy | starting | none. */
  health: string;
  /** running | exited | restarting | … */
  state: string;
  failingStreak: number;
  /** Minutes since the container entered its current unhealthy run, if known. */
  unhealthyMinutes?: number | undefined;
  /** Exit code when stopped. 0 = finished its job (init containers do this). */
  exitCode?: number | undefined;
}

/** Services whose failure is a COMPLIANCE problem, not just an outage. */
const COMPLIANCE_CRITICAL: Record<string, string> = {
  clamav: 'Attachment virus scanning is down — inbound client documents cannot be scanned.',
  postgres: 'The database is down.',
  minio: 'Document storage is down — uploads and signed-copy retention cannot complete.',
  stripe_live_key:
    'Production is not on a LIVE Stripe key — every client checkout is a sandbox or a 503, ' +
    'and no real payment can succeed. Re-run scripts/install-stripe-live.sh on the server.',
};

/**
 * Is production actually able to take a real payment? Null when yes; the reason when no.
 *
 * 2026-09-09. The live key was installed on the server at 01:25 and verified; a deploy at
 * 02:29 merged the laptop's stale TEST key back over it. Nothing noticed for three hours,
 * until Brian's real card was declined by a Stripe sandbox. The installer's verification
 * was true when it ran; nothing kept checking. This does, every tick, and it is a pure
 * function of config so the rule is testable without a server.
 *
 * Outside production it is nobody's business what key is loaded — dev and test run the
 * stub or a sandbox on purpose — so the answer there is always "fine".
 */
export function stripeKeyModeProblem(c: {
  NODE_ENV: string;
  STRIPE_MODE: string;
  STRIPE_SECRET_KEY?: string | undefined;
}): string | null {
  if (c.NODE_ENV !== 'production') return null;
  if (c.STRIPE_MODE !== 'live') return 'STRIPE_MODE is not live in production — Pay returns 503';
  const key = c.STRIPE_SECRET_KEY ?? '';
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return null;
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) {
    return 'STRIPE_MODE=live on a TEST key — every checkout is a Stripe sandbox';
  }
  return 'STRIPE_SECRET_KEY is not a recognisable Stripe secret key';
}

function severityFor(name: string): 'critical' | 'warning' {
  return Object.keys(COMPLIANCE_CRITICAL).some((k) => name.includes(k)) ? 'critical' : 'warning';
}

function reasonFor(name: string): string | null {
  const key = Object.keys(COMPLIANCE_CRITICAL).find((k) => name.includes(k));
  return key ? COMPLIANCE_CRITICAL[key]! : null;
}

/**
 * Record a host-reported snapshot and alert on anything unhealthy for longer than
 * the configured grace period. Called by the host cron, not by a human.
 */
export async function recordContainerHealth(
  app: FastifyInstance,
  containers: ContainerReport[]
): Promise<{ checked: number; alerted: string[]; graceMinutes: number }> {
  const graceMinutes = Number(await getSetting(app, 'ops.container_unhealthy_alert_minutes', 10));

  const unhealthy = containers.filter((c) => {
    if (c.state === 'restarting') return true;
    // A container that EXITED CLEANLY did its job and stopped. The stack has
    // one-shot init containers (saos-minio-init-1, saos-calcom-db-init-1) that are
    // supposed to be in exactly this state, and the first live run of this watchdog
    // alerted on both of them. A watchdog that cries wolf twice every five minutes
    // gets ignored, which recreates the outage it was built to catch.
    if (c.state === 'exited') return (c.exitCode ?? 0) !== 0;
    if (c.health !== 'unhealthy') return false;
    // 'starting' is never an alert: a container that is still booting is not broken.
    // Past the grace period, or a long failing streak, is.
    return (c.unhealthyMinutes ?? 0) >= graceMinutes || c.failingStreak >= 5;
  });

  const alerted: string[] = [];
  if (unhealthy.length > 0) {
    const ceo = await ownerForRole(app.db, 'ceo');
    for (const c of unhealthy) {
      const why = reasonFor(c.name);
      const detail = c.state === 'running'
        ? `unhealthy for ~${c.unhealthyMinutes ?? '?'} min (${c.failingStreak} failed checks)`
        : `state ${c.state}`;
      /*
       * THE TASK IS UNCONDITIONAL; only the ALERT needs a person (Brian's rule).
       *
       * Both used to sit inside `if (ceo)`. Even for the CEO — the end of the fallback chain —
       * that is the #17 shape: a wedged container with nobody on staff produced no task at
       * all, so the record of the outage did not exist either. An unassigned task in the queue
       * is visible the moment someone logs in; a skipped one never was.
       */
      await createTask(app, {
        title: `Fix ${c.name} — ${c.health === 'unhealthy' ? 'unhealthy' : c.state}`,
        description:
          `${why ?? 'Service is not healthy.'}\n\n${detail}\n\n` +
          `Check: docker logs ${c.name} --tail 50 · docker inspect ${c.name} --format '{{json .State.Health}}'\n` +
          `A wedged container usually clears with: docker restart ${c.name}`,
        assignedStaffId: ceo,
        priority: severityFor(c.name) === 'critical' ? 1 : 2,
        source: 'system',
        sourceType: 'container_unhealthy',
        sourceId: c.name, // stable: one open task per container until it closes
      });
      if (ceo) {
        await notifyOnce(app.db, {
          staffId: ceo,
          type: 'container_unhealthy',
          severity: severityFor(c.name),
          title: `${c.name} is ${detail}.${why ? ` ${why}` : ''}`,
          relatedObjectType: 'container',
          // Re-nags per container per day rather than every cron tick.
          relatedObjectId: `${c.name}:${new Date().toISOString().slice(0, 10)}`,
        });
      }
      alerted.push(c.name);
    }
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'container-health',
    action: 'ops.container_health_reported',
    details: {
      checked: containers.length,
      grace_minutes: graceMinutes,
      unhealthy: unhealthy.map((c) => ({ name: c.name, health: c.health, state: c.state, streak: c.failingStreak })),
    },
  });

  return { checked: containers.length, alerted, graceMinutes };
}

/** Can the API actually reach clamd? Docker health cannot answer this. */
async function pingClamav(host: string, port: number, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => socket.write('zPING\0'));
    socket.on('data', (d) => done(d.toString().includes('PONG')));
    socket.on('error', () => done(false));
  });
}

/**
 * Probe the dependencies the app itself needs, from inside the app. This is the
 * check that would have caught a scanner reachable-by-Docker but not by us.
 */
export async function probeDependencies(
  app: FastifyInstance
): Promise<{ reachable: Record<string, boolean>; alerted: string[] }> {
  const reachable: Record<string, boolean> = {};

  if (app.config.CLAMAV_HOST) {
    reachable.clamav = await pingClamav(app.config.CLAMAV_HOST, app.config.CLAMAV_PORT ?? 3310);
  }
  try {
    await app.db.query('SELECT 1');
    reachable.postgres = true;
  } catch {
    reachable.postgres = false;
  }

  // Can production take a real payment right now? (See stripeKeyModeProblem.) Recorded as
  // a dependency so it gets the same since/duration bookkeeping and the same nagging alert
  // as a dead scanner — a payments config that silently reverted IS an outage.
  if (app.config.NODE_ENV === 'production') {
    const problem = stripeKeyModeProblem(app.config);
    reachable.stripe_live_key = problem === null;
    if (problem !== null) app.log.error({ problem }, 'production cannot take a real payment');
  }

  /*
   * FINDING #14(3), Brian's ruling: "13 hours down should be visible, not discovered
   * via OOM logs."
   *
   * This probe already ran every tick and already alerted. What it did not do was
   * REMEMBER, so the duration of an outage was not a fact the system held — it was
   * something you reconstructed afterwards from dmesg. `since` only moves when the
   * state TRANSITIONS, which is what makes it a duration rather than a timestamp of
   * the last check.
   */
  for (const [name, ok] of Object.entries(reachable)) {
    await app.db.query(
      `INSERT INTO dependency_health (name, reachable, since, last_checked_at, detail)
       VALUES ($1, $2, now(), now(), $3)
       ON CONFLICT (name) DO UPDATE
         SET reachable = EXCLUDED.reachable,
             last_checked_at = now(),
             detail = EXCLUDED.detail,
             -- Only reset the clock when the state actually changed.
             since = CASE WHEN dependency_health.reachable <> EXCLUDED.reachable
                          THEN now() ELSE dependency_health.since END`,
      [name, ok, ok ? null : (reasonFor(name) ?? 'unreachable from the API')]
    );
  }

  const down = Object.entries(reachable).filter(([, ok]) => !ok).map(([name]) => name);
  const alerted: string[] = [];
  if (down.length > 0) {
    const ceo = await firstActiveByRole(app.db, 'ceo');
    for (const name of down) {
      if (ceo) {
        await notifyOnce(app.db, {
          staffId: ceo,
          type: 'dependency_unreachable',
          severity: severityFor(name),
          title: `${name} is UNREACHABLE from the API.${reasonFor(name) ? ` ${reasonFor(name)}` : ''}`,
          relatedObjectType: 'dependency',
          relatedObjectId: `${name}:${new Date().toISOString().slice(0, 10)}`,
        });
      }
      alerted.push(name);
    }
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'dependency-probe',
    action: 'ops.dependencies_probed',
    details: { reachable, unreachable: down },
  });
  return { reachable, alerted };
}
