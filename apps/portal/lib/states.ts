// STATE CODE → NAME, EN AND ES (Brian, 2026-09-26, R48). The completed line under My Returns names
// the jurisdiction that answered: "Accepted by Illinois on <date>." / "Aceptada por Illinois el <fecha>."
// The API carries the two-letter code the return declared (tax_engagement_jurisdictions.jurisdiction);
// the name is the reader's. A code this table does not know prints as the code, never as nothing.

import type { PortalLang } from './dates';

export const STATE_NAMES: Record<string, [string, string]> = {
  AL: ['Alabama', 'Alabama'],
  AK: ['Alaska', 'Alaska'],
  AZ: ['Arizona', 'Arizona'],
  AR: ['Arkansas', 'Arkansas'],
  CA: ['California', 'California'],
  CO: ['Colorado', 'Colorado'],
  CT: ['Connecticut', 'Connecticut'],
  DE: ['Delaware', 'Delaware'],
  DC: ['the District of Columbia', 'el Distrito de Columbia'],
  FL: ['Florida', 'Florida'],
  GA: ['Georgia', 'Georgia'],
  HI: ['Hawaii', 'Hawái'],
  ID: ['Idaho', 'Idaho'],
  IL: ['Illinois', 'Illinois'],
  IN: ['Indiana', 'Indiana'],
  IA: ['Iowa', 'Iowa'],
  KS: ['Kansas', 'Kansas'],
  KY: ['Kentucky', 'Kentucky'],
  LA: ['Louisiana', 'Luisiana'],
  ME: ['Maine', 'Maine'],
  MD: ['Maryland', 'Maryland'],
  MA: ['Massachusetts', 'Massachusetts'],
  MI: ['Michigan', 'Míchigan'],
  MN: ['Minnesota', 'Minnesota'],
  MS: ['Mississippi', 'Misisipi'],
  MO: ['Missouri', 'Misuri'],
  MT: ['Montana', 'Montana'],
  NE: ['Nebraska', 'Nebraska'],
  NV: ['Nevada', 'Nevada'],
  NH: ['New Hampshire', 'Nuevo Hampshire'],
  NJ: ['New Jersey', 'Nueva Jersey'],
  NM: ['New Mexico', 'Nuevo México'],
  NY: ['New York', 'Nueva York'],
  NC: ['North Carolina', 'Carolina del Norte'],
  ND: ['North Dakota', 'Dakota del Norte'],
  OH: ['Ohio', 'Ohio'],
  OK: ['Oklahoma', 'Oklahoma'],
  OR: ['Oregon', 'Oregón'],
  PA: ['Pennsylvania', 'Pensilvania'],
  RI: ['Rhode Island', 'Rhode Island'],
  SC: ['South Carolina', 'Carolina del Sur'],
  SD: ['South Dakota', 'Dakota del Sur'],
  TN: ['Tennessee', 'Tennessee'],
  TX: ['Texas', 'Texas'],
  UT: ['Utah', 'Utah'],
  VT: ['Vermont', 'Vermont'],
  VA: ['Virginia', 'Virginia'],
  WA: ['Washington', 'Washington'],
  WV: ['West Virginia', 'Virginia Occidental'],
  WI: ['Wisconsin', 'Wisconsin'],
  WY: ['Wyoming', 'Wyoming'],
};

/** The state's name in the reader's language; an unknown code prints as itself. */
export function stateName(code: string, lang: PortalLang): string {
  const entry = STATE_NAMES[code.toUpperCase()];
  if (!entry) return code.toUpperCase();
  return lang === 'es' ? entry[1] : entry[0];
}
