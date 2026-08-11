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
import { firstActiveByRole, notifyOnce } from '../../staffing.ts';
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
};

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
    const ceo = await firstActiveByRole(app.db, 'ceo');
    for (const c of unhealthy) {
      const why = reasonFor(c.name);
      const detail = c.state === 'running'
        ? `unhealthy for ~${c.unhealthyMinutes ?? '?'} min (${c.failingStreak} failed checks)`
        : `state ${c.state}`;
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
