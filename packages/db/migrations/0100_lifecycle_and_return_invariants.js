/* eslint-disable camelcase */
/**
 * THE LIFECYCLE AND RETURN INVARIANTS (2026-09-12 evening, Brian's ruling 2).
 *
 *   2a. Engagement creation emits the lifecycle event, at the database: an engagement becoming
 *       active or on_hold moves a lead or dormant contact to onboarding. And the contrapositive
 *       is refused: a contact holding active work cannot be set back to lead or dormant.
 *       (Archived is already refused by 0099.) The legacy soto_status mirror is settled by
 *       crm/lifecycle.ts on the next event, as it always was; the trigger moves the lifecycle only.
 *   2c. A return in any pre-filed stage requires an active or on_hold engagement: refused on the
 *       return's side (no pre-filed return on a draft or closed engagement) and on the
 *       engagement's side (no closing an engagement with pre-filed returns; the withdraw cascade
 *       in engagements/close.ts runs first).
 *
 * Touches no row. Production was queried by name before this shipped: no contact held an active
 * or on-hold engagement while lead, dormant or archived; one pre-filed return sat on a withdrawn
 * engagement (Brian's own, withdrawn through the route the same evening).
 */
exports.shorthands = undefined;

const PRE_FILED = `('intake_started','scheduled','documents_requested','pending_client_response','in_preparation','internal_review','client_review','ready_to_file','on_hold')`;

exports.up = (pgm) => {
  // 2a
  pgm.sql(`
    CREATE OR REPLACE FUNCTION engagements_emit_lifecycle() RETURNS trigger AS $$
    BEGIN
      IF NEW.status IN ('active', 'on_hold') THEN
        UPDATE contacts SET contact_status = 'onboarding', contact_status_at = now()
         WHERE id = NEW.contact_id AND contact_status IN ('lead', 'dormant');
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    DROP TRIGGER IF EXISTS engagements_emit_lifecycle ON engagements;
    CREATE TRIGGER engagements_emit_lifecycle
      AFTER INSERT OR UPDATE OF status, contact_id ON engagements
      FOR EACH ROW EXECUTE FUNCTION engagements_emit_lifecycle();
  `);
  pgm.sql(`
    CREATE OR REPLACE FUNCTION contacts_lifecycle_holds_work() RETURNS trigger AS $$
    DECLARE n integer;
    BEGIN
      IF NEW.contact_status IN ('lead', 'dormant') AND NEW.contact_status IS DISTINCT FROM OLD.contact_status THEN
        SELECT count(*) INTO n FROM engagements e WHERE e.contact_id = NEW.id AND e.status IN ('active', 'on_hold');
        IF n > 0 THEN
          RAISE EXCEPTION 'lifecycle_contradiction: a contact holding % active or on-hold engagement(s) is onboarding or active, not %', n, NEW.contact_status
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    DROP TRIGGER IF EXISTS contacts_lifecycle_holds_work ON contacts;
    CREATE TRIGGER contacts_lifecycle_holds_work
      BEFORE UPDATE OF contact_status ON contacts
      FOR EACH ROW EXECUTE FUNCTION contacts_lifecycle_holds_work();
  `);

  // 2c
  pgm.sql(`
    CREATE OR REPLACE FUNCTION tax_engagements_need_open_engagement() RETURNS trigger AS $$
    DECLARE s text;
    BEGIN
      IF NEW.stage IN ${PRE_FILED} THEN
        SELECT e.status::text INTO s FROM engagements e WHERE e.id = NEW.engagement_id;
        IF s IS DISTINCT FROM 'active' AND s IS DISTINCT FROM 'on_hold' THEN
          RAISE EXCEPTION 'return_without_engagement: a return at % needs an active or on-hold engagement, and engagement % is %', NEW.stage, NEW.engagement_id, s
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    DROP TRIGGER IF EXISTS tax_engagements_need_open_engagement ON tax_engagements;
    CREATE TRIGGER tax_engagements_need_open_engagement
      BEFORE INSERT OR UPDATE OF stage, engagement_id ON tax_engagements
      FOR EACH ROW EXECUTE FUNCTION tax_engagements_need_open_engagement();
  `);
  pgm.sql(`
    CREATE OR REPLACE FUNCTION engagements_close_needs_returns_closed() RETURNS trigger AS $$
    DECLARE n integer;
    BEGIN
      IF NEW.status IN ('completed', 'withdrawn') AND OLD.status NOT IN ('completed', 'withdrawn') THEN
        SELECT count(*) INTO n FROM tax_engagements te WHERE te.engagement_id = NEW.id AND te.stage IN ${PRE_FILED};
        IF n > 0 THEN
          RAISE EXCEPTION 'return_without_engagement: engagement % still holds % unfiled return(s); withdraw or complete them first (the withdraw route cascades)', NEW.id, n
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    DROP TRIGGER IF EXISTS engagements_close_needs_returns_closed ON engagements;
    CREATE TRIGGER engagements_close_needs_returns_closed
      BEFORE UPDATE OF status ON engagements
      FOR EACH ROW EXECUTE FUNCTION engagements_close_needs_returns_closed();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS engagements_close_needs_returns_closed ON engagements; DROP FUNCTION IF EXISTS engagements_close_needs_returns_closed();`);
  pgm.sql(`DROP TRIGGER IF EXISTS tax_engagements_need_open_engagement ON tax_engagements; DROP FUNCTION IF EXISTS tax_engagements_need_open_engagement();`);
  pgm.sql(`DROP TRIGGER IF EXISTS contacts_lifecycle_holds_work ON contacts; DROP FUNCTION IF EXISTS contacts_lifecycle_holds_work();`);
  pgm.sql(`DROP TRIGGER IF EXISTS engagements_emit_lifecycle ON engagements; DROP FUNCTION IF EXISTS engagements_emit_lifecycle();`);
};
