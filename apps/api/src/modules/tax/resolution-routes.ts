// Tax resolution lane + bundle routes (M26.5, v4.6).
//
// The intake preview and the years × services grid are read-only derivations
// (safe to call as often as the UI likes); spawning a case is the write that
// creates engagements, chains them oldest-first, and queues the 8821.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { todayChicago } from './deadlines.ts';
import { lookbackYears, planResolution } from './resolution.ts';
import {
  assertRepresentationAuthorized, recordF2848, recordPaperMailing, resolutionCaseView, spawnResolutionCase,
} from './resolution-case.ts';
import { composeBundle, composeYearGrid } from '../pricing/bundles.ts';

const RETURN_TYPES = [
  '1040', '1065', '1120s', '1120', '990', '990ez', '1120c', '1120f', '1120h', '1120pol',
  '1041', '1120f_foreign', '1040_expat', 'fbar', 'w7_itin', 'ag990il',
] as const;

const YearInput = z.object({
  taxYear: z.number().int().min(1990).max(2100),
  returnType: z.enum(RETURN_TYPES),
  booksExist: z.enum(['yes', 'partial', 'no']).optional(),
});

export function registerResolutionRoutes(app: FastifyInstance): void {
  const read = { preHandler: [app.authenticate, requirePermission('engagements.read')] };
  const manage = { preHandler: [app.authenticate, requirePermission('engagements.tax.manage')] };

  /**
   * Intake preview: the unfiled-year defaults (6-year norm) plus, for whatever
   * the client selects, the derived lane / statute / surcharge picture. Nothing
   * is written — this is what the intake screen renders from.
   */
  app.post('/resolution/preview', read, async (request) => {
    const b = z.object({
      years: z.array(YearInput).max(20).optional(),
      returnType: z.enum(RETURN_TYPES).default('1040'),
      lookbackYears: z.number().int().min(1).max(20).optional(),
      asOf: z.iso.date().optional(),
    }).parse(request.body ?? {});
    const today = b.asOf ?? todayChicago();
    const defaults = lookbackYears(today, b.lookbackYears ?? 6);
    const years = b.years ?? defaults.map((y) => ({ taxYear: y, returnType: b.returnType }));
    return {
      today,
      defaultYears: defaults,
      plan: planResolution({ years }, today),
    };
  });

  /** The years × services quote grid, priced from the book. */
  app.post('/resolution/quote-grid', read, async (request) => {
    const b = z.object({
      years: z.array(YearInput.extend({
        itemCode: z.string().min(1),
        reconstructionHours: z.number().min(0).max(500).optional(),
      })).min(1).max(20),
      language: z.enum(['en', 'es']).optional(),
      multiYearDiscountPercent: z.number().min(0).max(90).optional(),
      asOf: z.iso.date().optional(),
    }).parse(request.body);
    return composeYearGrid(app, b.years, {
      language: b.language ?? 'en',
      today: b.asOf ?? todayChicago(),
      multiYearDiscountPercent: b.multiYearDiscountPercent ?? 0,
    });
  });

  /** Accept → spawn one engagement per year (+ reconstruction pairs), chained. */
  app.post('/resolution/cases', manage, async (request, reply) => {
    const b = z.object({
      contactId: z.uuid(),
      businessId: z.uuid().optional(),
      years: z.array(YearInput).min(1).max(20),
      preparerId: z.uuid().optional(),
      lookbackYears: z.number().int().min(1).max(20).optional(),
      asOf: z.iso.date().optional(),
    }).parse(request.body);
    const result = await spawnResolutionCase(
      app,
      {
        contactId: b.contactId, businessId: b.businessId ?? null, years: b.years,
        preparerId: b.preparerId ?? null, lookbackYears: b.lookbackYears,
      },
      request.staff!,
      b.asOf ?? todayChicago()
    );
    return reply.code(201).send(result);
  });

  app.get<{ Params: { id: string } }>('/resolution/cases/:id', read, async (request) => {
    return resolutionCaseView(app, z.uuid().parse(request.params.id));
  });

  /** Record the signed 2848 and the years it actually covers. */
  app.post<{ Params: { id: string } }>('/resolution/cases/:id/f2848', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({
      scopeYears: z.array(z.number().int().min(1990).max(2100)).min(1),
      envelopeId: z.uuid().optional(),
    }).parse(request.body);
    await recordF2848(app, id, b.scopeYears, b.envelopeId ?? null, request.staff!);
    return { status: 'ok', scopeYears: b.scopeYears };
  });

  /**
   * Representation check — the endpoint the abatement / installment-agreement
   * flows call before doing any work for a year.
   */
  app.post<{ Params: { id: string } }>('/resolution/cases/:id/representation-check', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({ taxYear: z.number().int().min(1990).max(2100) }).parse(request.body);
    await assertRepresentationAuthorized(app, id, b.taxYear);
    return { status: 'authorized', taxYear: b.taxYear };
  });

  /** Paper lane: certified mailing with tracking (refused on e-file years). */
  app.post<{ Params: { id: string } }>('/tax-engagements/:id/paper-mailing', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({
      mailedOn: z.iso.date(),
      tracking: z.string().min(1).max(60),
    }).parse(request.body);
    await recordPaperMailing(app, id, { mailedOn: b.mailedOn, tracking: b.tracking }, request.staff!);
    return { status: 'ok' };
  });

  // ── bundles ───────────────────────────────────────────────────────────────
  app.get('/bundles', read, async () => {
    const { rows } = await app.db.query(
      `SELECT b.slug, b.name_en, b.name_es, b.description_en, b.discount_percent, b.discount_cents,
              b.override_cents, b.published_at, b.campaign_code,
              (SELECT count(*)::int FROM bundle_components bc WHERE bc.bundle_id = b.id) AS components
       FROM bundles b
       JOIN price_book_versions v ON v.id = b.version_id
       WHERE b.is_active
         AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
       ORDER BY b.name_en`
    );
    return { bundles: rows };
  });

  app.get<{ Params: { slug: string } }>('/bundles/:slug', read, async (request) => {
    const slug = z.string().min(1).parse(request.params.slug);
    const q = z.object({ include: z.string().optional() }).parse(request.query);
    return composeBundle(app, slug, {
      includeOptional: q.include ? q.include.split(',').filter(Boolean) : [],
    });
  });
}
