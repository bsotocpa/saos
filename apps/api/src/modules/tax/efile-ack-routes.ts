/*
 * E-file acknowledgment routes (2026-09-12). All behind engagements.tax.manage: this is the tax
 * preparer's screen. Upload → review → release; nothing sends on upload.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../types.ts';
import { requirePermission } from '../../plugins/auth.ts';
import { holdRow, ingestReport, listReports, releaseReport, reportView } from './efile-ack.ts';

const ACCEPTED_TYPES = new Set(['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/csv', 'text/tab-separated-values']);

export function registerEfileAckRoutes(app: FastifyInstance): void {
  const manage = { preHandler: [app.authenticate, requirePermission('engagements.tax.manage')] };
  const actorOf = (request: FastifyRequest) => ({ id: request.staff!.id, label: request.staff!.fullName });

  app.post('/efile-acks', manage, async (request, reply) => {
    const data = await request.file();
    if (!data) throw new AppError(400, 'file_required', 'Attach the ATX acknowledgment report.');
    const buffer = await data.toBuffer();
    if (!ACCEPTED_TYPES.has(data.mimetype) && !/\.(csv|txt|tsv)$/i.test(data.filename)) {
      throw new AppError(415, 'unsupported_file_type', `Expected a CSV export from ATX, got '${data.mimetype}'.`);
    }
    if (buffer.length > 2 * 1024 * 1024) throw new AppError(413, 'too_large', 'An acknowledgment report is a small text file; this is over 2 MB.');
    const asOf = typeof (request.query as Record<string, string | undefined>).asOf === 'string' ? (request.query as Record<string, string>).asOf : undefined;
    const result = await ingestReport(app, actorOf(request), { filename: data.filename, text: buffer.toString('utf8'), today: asOf });
    return reply.code(result.alreadyIngested ? 200 : 201).send(result);
  });

  app.get('/efile-acks', manage, async () => ({ reports: await listReports(app) }));

  app.get<{ Params: { id: string } }>('/efile-acks/:id', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    return reportView(app, id);
  });

  app.post<{ Params: { id: string } }>('/efile-acks/rows/:id/hold', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    await holdRow(app, actorOf(request), id, true);
    return { status: 'held' };
  });

  app.post<{ Params: { id: string } }>('/efile-acks/rows/:id/unhold', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    await holdRow(app, actorOf(request), id, false);
    return { status: 'queued' };
  });

  app.post<{ Params: { id: string } }>('/efile-acks/:id/release', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    return { status: 'released', ...(await releaseReport(app, actorOf(request), id)) };
  });
}
