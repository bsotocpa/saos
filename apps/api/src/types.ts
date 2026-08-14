// Shared app types + Fastify augmentation (decorations added in server.ts).

import type { Db } from './db.ts';
import type { Config } from './config.ts';
import type { Mailer } from './mailer.ts';

export interface AuthedStaff {
  id: string;
  email: string;
  fullName: string;
  roleKey: string;
  permissions: string[];
  sessionId: string;
}

export interface AuthedClient {
  portalUserId: string;
  /** THE scoping key: every portal query filters by this — never by client-supplied ids. */
  contactId: string;
  email: string;
  language: 'en' | 'es';
  sessionId: string;
}

/** Error with an HTTP status — thrown by services, mapped by the error handler. */
export class AppError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    mailer: Mailer;
    /**
     * The payments adapter. Decorated once so checkout, the webhook, and the
     * reconcile backstop all speak to the same Stripe — and so a test can inject
     * a Stripe that reports a paid session, which the stub deliberately never does.
     */
    stripe: import('./modules/billing/stripe.ts').StripeAdapter;
    /** preHandler: verifies the staff Bearer session and populates request.staff. */
    authenticate: (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
    /** preHandler: verifies the client portal session and populates request.client. */
    authenticateClient: (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply
    ) => Promise<void>;
    /** Serial meeting-intelligence queue (decorated by the meetings module). */
    meetingQueue?: import('./modules/meetings/pipeline.ts').MeetingQueue;
  }
  interface FastifyRequest {
    staff?: AuthedStaff;
    client?: AuthedClient;
  }
}
