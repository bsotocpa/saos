/* eslint-disable camelcase */
/**
 * DECISION 1 (2026-09-09, Brian's evening ruling): no payable invoice on a withdrawn engagement.
 *
 * SA-2026-0001 sat paid on a withdrawn engagement; SA-2026-0004 sat SENT on one that was about
 * to be withdrawn. Withdrawing now voids the attached sent/overdue invoices and deletes drafts
 * in the same transaction (engagements/retire-invoices.ts). The database holds the rule from
 * both sides: an engagement cannot become withdrawn while a payable invoice points at it, and a
 * payable invoice cannot be created on, moved to, or reopened on a withdrawn engagement.
 *
 * "Payable" = draft, sent, overdue. Paid, void, refunded, partially refunded and disputed
 * invoices are history and may stay attached.
 *
 * Completed engagements are deliberately NOT covered: a final-fee invoice is issued at filing
 * and the engagement completes while it is collected. That case is DECISION-PENDING for Brian.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION engagements_withdrawn_no_payable() RETURNS trigger AS $$
    DECLARE
      payable text;
    BEGIN
      IF NEW.status = 'withdrawn' AND (OLD.status IS DISTINCT FROM 'withdrawn') THEN
        SELECT string_agg(invoice_number || ' (' || status::text || ')', ', ' ORDER BY invoice_number)
          INTO payable
          FROM invoices
         WHERE engagement_id = NEW.id AND status IN ('draft', 'sent', 'overdue');
        IF payable IS NOT NULL THEN
          RAISE EXCEPTION 'engagement % cannot be withdrawn while payable invoices point at it: %', NEW.id, payable
            USING ERRCODE = 'check_violation', CONSTRAINT = 'engagements_withdrawn_no_payable';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS engagements_withdrawn_no_payable ON engagements;
    CREATE TRIGGER engagements_withdrawn_no_payable
      BEFORE UPDATE OF status ON engagements
      FOR EACH ROW EXECUTE FUNCTION engagements_withdrawn_no_payable();
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION invoices_engagement_open() RETURNS trigger AS $$
    DECLARE
      eng_status text;
    BEGIN
      IF NEW.engagement_id IS NOT NULL AND NEW.status IN ('draft', 'sent', 'overdue') THEN
        SELECT status::text INTO eng_status FROM engagements WHERE id = NEW.engagement_id;
        IF eng_status = 'withdrawn' THEN
          RAISE EXCEPTION 'invoice % is % but engagement % is withdrawn: a payable invoice cannot sit on withdrawn work', NEW.invoice_number, NEW.status, NEW.engagement_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_engagement_open';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS invoices_engagement_open ON invoices;
    CREATE TRIGGER invoices_engagement_open
      BEFORE INSERT OR UPDATE OF status, engagement_id ON invoices
      FOR EACH ROW EXECUTE FUNCTION invoices_engagement_open();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS invoices_engagement_open ON invoices;`);
  pgm.sql(`DROP FUNCTION IF EXISTS invoices_engagement_open();`);
  pgm.sql(`DROP TRIGGER IF EXISTS engagements_withdrawn_no_payable ON engagements;`);
  pgm.sql(`DROP FUNCTION IF EXISTS engagements_withdrawn_no_payable();`);
};
