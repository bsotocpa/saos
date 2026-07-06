// Client portal endpoints. ROW-LEVEL RULE (MP: "clients see only their own
// records"): every query here filters by request.client.contactId — the id
// from the verified session. Client-supplied ids are NEVER used for scoping;
// anything not owned by the caller behaves as if it does not exist.

import type { FastifyInstance } from 'fastify';

export function registerPortalRoutes(app: FastifyInstance): void {
  const scoped = { preHandler: [app.authenticateClient] };

  app.get('/portal/me', scoped, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query(
      `SELECT id, first_name, last_name, email, phone, preferred_contact_method, language,
              address_line1, address_line2, city, state, zip, soto_status, hilo_status
       FROM contacts WHERE id = $1`,
      [client.contactId]
    );
    return { contact: rows[0] ?? null };
  });

  app.get('/portal/documents', scoped, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query(
      `SELECT id, category, status, filename, tax_year, uploaded_at
       FROM documents
       WHERE contact_id = $1 AND archived_at IS NULL
       ORDER BY uploaded_at DESC`,
      [client.contactId]
    );
    return { documents: rows };
  });
}
