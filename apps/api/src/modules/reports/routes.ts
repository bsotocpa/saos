// Reports & KPIs routes (M27). Owner-facing, so guarded by the same
// `dashboards.executive` permission as the Executive dashboard — per-staff
// own-only scorecards are Phase 4 and deliberately not faked here.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { defaultRange, reportCatalog, runReport, REPORTS } from './service.ts';
import { csvFilename, toCsv } from './csv.ts';

const RangeQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  format: z.enum(['json', 'csv']).optional(),
});

const TilesBody = z.object({
  tiles: z.array(z.string().min(1)).max(24),
});

export function registerReportRoutes(app: FastifyInstance): void {
  const leadership = { preHandler: [app.authenticate, requirePermission('dashboards.executive')] };

  /** The catalog: what reports exist, their columns, and their stated limits. */
  app.get('/reports', leadership, async () => ({
    reports: reportCatalog(),
    defaultRange: defaultRange(),
  }));

  /**
   * Run one report. `format=csv` streams the same rows through the CSV writer,
   * so the export can never disagree with what the screen showed.
   */
  app.get<{ Params: { key: string }; Querystring: Record<string, string> }>(
    '/reports/:key',
    leadership,
    async (request, reply) => {
      const key = z.string().min(1).max(64).parse(request.params.key);
      const q = RangeQuery.parse(request.query);
      const fallback = defaultRange();
      const range = { from: q.from ?? fallback.from, to: q.to ?? fallback.to };

      const result = await runReport(app, key, range);

      if (q.format === 'csv') {
        // An export leaves the system, so it is audited by name and range —
        // the same standard as a document download.
        await writeAudit(app.db, {
          actorType: 'staff',
          actorId: request.staff!.id,
          actorLabel: request.staff!.email,
          action: 'report.exported',
          objectType: 'report',
          objectId: key,
          details: { from: range.from, to: range.to, rows: result.rows.length, format: 'csv' },
        });
        const filename = csvFilename(key, range.from, range.to, result.snapshot);
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="${filename}"`)
          .send(toCsv(result.columns, result.rows));
      }
      return result;
    }
  );

  /** Which report tiles this staffer wants on their dashboard. */
  app.get('/reports/tiles/mine', leadership, async (request) => {
    const { rows } = await app.db.query<{ dashboard_tiles: string[] | null }>(
      `SELECT dashboard_tiles FROM staff WHERE id = $1`,
      [request.staff!.id]
    );
    const stored = rows[0]?.dashboard_tiles;
    // Unset ≠ empty: a staffer who has never configured tiles gets a sensible
    // default, while one who deliberately cleared them keeps an empty board.
    return {
      tiles: stored ?? ['revenue_by_line_month', 'ar_aging', 'pipeline_conversion'],
      configured: stored !== null && stored !== undefined,
    };
  });

  app.put('/reports/tiles/mine', leadership, async (request) => {
    const b = TilesBody.parse(request.body);
    const unknown = b.tiles.filter((t) => !REPORTS[t]);
    if (unknown.length > 0) {
      throw new AppError(400, 'unknown_report', `Not a report: ${unknown.join(', ')}.`);
    }
    await app.db.query(`UPDATE staff SET dashboard_tiles = $2::jsonb WHERE id = $1`, [
      request.staff!.id,
      JSON.stringify(b.tiles),
    ]);
    return { tiles: b.tiles, configured: true };
  });
}
