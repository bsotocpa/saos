/**
 * Why a template version says what it says.
 *
 * `templates.version` counts edits; nothing recorded WHY an edit was made. That was
 * tolerable while edits were copy tweaks. It stopped being tolerable the moment a legal
 * clause was added on attorney advice with one sentence deliberately left out:
 *
 *   Brian, 2026-08-13 — the attorney's governing-language draft carried a third
 *   sentence requiring all communications to be conducted in English. He removed it
 *   because it contradicts Soto's bilingual operations, and the deletion is pending the
 *   attorney's written confirmation.
 *
 * A deliberate omission that is not written down is indistinguishable from an accident,
 * and the next person to compare the template against the attorney's draft would
 * "fix" it by pasting the sentence back in. This column is where that decision lives.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE templates ADD COLUMN version_note text;

    COMMENT ON COLUMN templates.version_note IS
      'Why the current version says what it says — required reading before editing legal text. Records deliberate omissions and the advice a change came from, so an intentional deletion is never mistaken for an oversight.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE templates DROP COLUMN version_note;`);
};
