'use strict';
/*
 * A BUSINESS NAMED AFTER THE PERSON IT BELONGS TO (2026-09-12 night, Brian's ruling 2).
 *
 * The Zoho import made a "business" out of every tax household: "JUAN LOZA and IVONNE LOZA",
 * "ANGEL M SIDA JR", "ESTEBAN DELEON". An exact match against "First Last" finds none of them, so
 * the rule is by word: every word of the contact's first and last name appears as a whole word in
 * the business name, case-insensitive, punctuation ignored, one-letter words (middle initials)
 * ignored. Shared by migration 0103 and the API so the two cannot disagree.
 */
function words(s) {
  return String(s ?? '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 2);
}

function isSelfNamed(businessName, firstName, lastName) {
  const have = new Set(words(businessName));
  const need = [...words(firstName), ...words(lastName)];
  return need.length > 0 && need.every((w) => have.has(w));
}

module.exports = { isSelfNamed, words };
