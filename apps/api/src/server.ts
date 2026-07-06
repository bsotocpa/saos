import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import type { Config } from './config.ts';
import { createPool } from './db.ts';
import { loggerOptions } from './logging.ts';
import { createMailer, type Mailer } from './mailer.ts';
import { buildAuthenticate } from './plugins/auth.ts';
import { buildAuthenticateClient } from './plugins/client-auth.ts';
import { registerAuthRoutes } from './modules/auth/routes.ts';
import { registerStaffRoutes } from './modules/staff/routes.ts';
import { registerPortalAuthRoutes } from './modules/portal-auth/routes.ts';
import { registerPortalRoutes } from './modules/portal/routes.ts';
import { registerCrmRoutes } from './modules/crm/routes.ts';
import { registerEngagementRoutes } from './modules/engagements/routes.ts';
import { registerTaxRoutes } from './modules/tax/routes.ts';
import { registerExtensionRoutes } from './modules/tax/extension-routes.ts';
import { registerNoticeRoutes } from './modules/notices/routes.ts';
import { registerEntityRoutes } from './modules/entity/routes.ts';
import { registerDocumentRoutes } from './modules/documents/routes.ts';
import { registerSignatureRoutes } from './modules/signatures/routes.ts';
import { AppError } from './types.ts';

/** True for PostgreSQL error objects (5-char SQLSTATE code). */
function isPgError(err: unknown): err is { code: string; constraint?: string; table?: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((err as { code: string }).code)
  );
}

export function buildServer(config: Config, overrides: { mailer?: Mailer } = {}): FastifyInstance {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : loggerOptions,
    trustProxy: true, // Caddy/Traefik terminates TLS in front of us (M23)
  });

  app.decorate('config', config);
  app.decorate('db', createPool(config.DATABASE_URL));
  app.decorate('mailer', overrides.mailer ?? createMailer(config));
  app.decorate('authenticate', buildAuthenticate(app));
  app.decorate('authenticateClient', buildAuthenticateClient(app));

  void app.register(multipart, {
    limits: { fileSize: config.DOC_MAX_SIZE_MB * 1024 * 1024, files: 1 },
  });

  app.addHook('onClose', async () => {
    await app.db.end();
  });

  // Error handler — sanitizes before logging (no-PII-in-logs rule):
  //  - zod issues: paths + messages only (zod v4 messages carry types, not values)
  //  - pg errors: SQLSTATE + constraint/table only — pg `detail` echoes column
  //    VALUES (e.g. "Key (email)=(x@y.com) already exists") and must never be logged
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation_failed',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (isPgError(err)) {
      request.log.error(
        { pgCode: err.code, constraint: err.constraint, table: err.table, route: request.routeOptions?.url },
        'database error'
      );
      if (err.code === '23505') {
        return reply.code(409).send({ error: 'conflict', constraint: err.constraint });
      }
      return reply.code(500).send({ error: 'internal_error' });
    }
    // Fastify-native errors (body parse, 404 handled elsewhere) keep their status.
    const known = err as { statusCode?: unknown; message?: unknown };
    const statusCode = typeof known.statusCode === 'number' ? known.statusCode : 500;
    if (statusCode >= 500) request.log.error({ err, route: request.routeOptions?.url }, 'unhandled error');
    return reply
      .code(statusCode)
      .send({ error: statusCode >= 500 ? 'internal_error' : String(known.message ?? 'error') });
  });

  app.get('/health', async () => {
    await app.db.query('SELECT 1');
    return { status: 'ok', db: 'ok' };
  });

  registerAuthRoutes(app);
  registerStaffRoutes(app);
  registerPortalAuthRoutes(app);
  registerPortalRoutes(app);
  registerCrmRoutes(app);
  registerEngagementRoutes(app);
  registerTaxRoutes(app);
  registerExtensionRoutes(app);
  registerNoticeRoutes(app);
  registerEntityRoutes(app);
  registerDocumentRoutes(app);
  registerSignatureRoutes(app);

  return app;
}
