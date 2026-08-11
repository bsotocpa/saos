/**
 * THE GUIDED TAX INTERVIEW (walkthrough finding C).
 *
 * The problem: tax quotes priced the base correctly and understated everything
 * else, because the additional schedules were only ever captured if a staffer
 * remembered to add the chips. "3 rentals" silently became one Schedule E, or none.
 *
 * The fix is to DERIVE the line items from a short questionnaire instead of relying
 * on recall. Two properties of this table matter:
 *
 *  1. THE QUESTIONS AND THEIR MAPPING ARE DATA, not code. Each question names the
 *     price_book item_code it drives, so adding a schedule to the interview is an
 *     admin edit and the price still comes from the versioned book. A mapping in
 *     code would be a hardcoded price with extra steps.
 *
 *  2. ANSWERS CARRY COUNTS. `IND_SCH_E_RENTAL` is per_property and
 *     `IND_SCH_E_K1` is per_k1, so a yes/no answer cannot price them. answer_type
 *     'count' multiplies the item by the number given, which is precisely the gap
 *     that made quotes low.
 *
 * The same questions serve staff now and lead self-quoting later, which is why the
 * prompts are client-readable and bilingual rather than internal shorthand.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE interview_answer_type AS ENUM ('choice', 'count', 'bool');

    CREATE TABLE tax_interview_questions (
      key            text PRIMARY KEY,
      answer_type    interview_answer_type NOT NULL,
      prompt_en      text NOT NULL,
      prompt_es      text NOT NULL,
      help_en        text,
      help_es        text,
      -- The price-book item this answer adds. NULL for 'choice' questions whose
      -- options each name their own item (filing status picks the base return).
      item_code      text,
      -- For 'choice': option value -> price-book item_code.
      choice_items   jsonb,
      -- TRUE for the question that selects the base return. The base is the only
      -- part of a derived quote that carries a RANGE — Brian's ruling: a client who
      -- told us "3 rentals" should see precision, not vagueness.
      is_base        boolean NOT NULL DEFAULT false,
      sort_order     integer NOT NULL DEFAULT 0,
      is_active      boolean NOT NULL DEFAULT true,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),

      -- A question must be able to price itself: either one item, or a choice map.
      CONSTRAINT tax_interview_prices_something CHECK (
        (answer_type = 'choice' AND choice_items IS NOT NULL AND item_code IS NULL)
        OR (answer_type <> 'choice' AND item_code IS NOT NULL AND choice_items IS NULL)
      ),
      -- Only a choice question can select the base return.
      CONSTRAINT tax_interview_base_is_choice CHECK (NOT is_base OR answer_type = 'choice')
    );
    COMMENT ON TABLE tax_interview_questions IS
      'Guided tax interview. Questions and their price-book mapping are DATA so adding a schedule is an admin edit; answer_type count captures per-property / per-K-1 quantities, which is the gap that made quotes understate.';

    CREATE TRIGGER trg_tax_interview_questions_updated_at BEFORE UPDATE ON tax_interview_questions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- What the client/staffer answered, kept ON the quote so a price can always be
    -- explained months later: "you told us three rentals" beats "the system said so".
    ALTER TABLE quotes
      ADD COLUMN interview_answers jsonb,
      -- 'base_only' narrows the range to the base line; the derived schedules are
      -- exact. 'total' is the old whole-quote band, kept for non-interview quotes.
      ADD COLUMN range_basis text
        CHECK (range_basis IS NULL OR range_basis IN ('total', 'base_only'));
    COMMENT ON COLUMN quotes.interview_answers IS
      'The interview answers that derived this quote. Kept so the price is explainable to the client who gave them.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE quotes DROP COLUMN range_basis, DROP COLUMN interview_answers;
    DROP TABLE tax_interview_questions;
    DROP TYPE interview_answer_type;
  `);
};
