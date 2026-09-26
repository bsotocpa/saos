/*
 * The duplicate-EIN answer the Add and Edit business forms share (Brian, 2026-09-26, R54): the
 * business already holding a number and the person it belongs to, for the warning's link. The
 * route (GET /businesses/ein-check) never returns the number itself.
 */
export interface EinHolder { businessId: string; name: string; ownerContactId: string | null; ownerName: string | null }

/** The nine digits of what was typed, whatever the spelling. */
export const einDigits = (typed: string): string => typed.replace(/\D/g, '');
