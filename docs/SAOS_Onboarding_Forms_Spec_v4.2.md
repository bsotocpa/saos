# SAOS Onboarding Forms — Field-Level Spec (v4.2)
### Companion to SAOS Master Prompt v4.2 | July 5, 2026 | v4.1: bridge fields renamed BR1–BR6; Module B firing rule fixed. v4.2: additions listed in addendum at end
### All forms render in English and Spanish; language selected on first screen and saved to contact record.

---

## FORM 1 — SOTO ACCOUNTING NEW CLIENT INTAKE
**Where it lives:** public link on sotoaccounting.com + sent after Cal.com consultation booking
**What it creates:** Contact record + Lead status + queued signature requests (engagement letter, §7216)
**Design rule:** ≤3 minutes to complete on a phone. Anything the team can gather later stays out.

### Screen 1 — Language + Contact
| # | Field | Type | Req | Notes |
|---|---|---|---|---|
| 1.1 | Preferred language | Toggle EN/ES | ✓ | Rest of form renders in choice; saved to record |
| 1.2 | First name | Text | ✓ | |
| 1.3 | Last name | Text | ✓ | |
| 1.4 | Email | Email | ✓ | Validated live; becomes magic-link address |
| 1.5 | Mobile phone | Phone | ✓ | |
| 1.6 | OK to text this number? | Yes/No | ✓ | Sets SMS consent flag (TCPA) |
| 1.7 | Preferred contact method | Select: Text / Email / Phone / Portal | ✓ | |

### Screen 2 — About Your Business
| # | Field | Type | Req | Notes |
|---|---|---|---|---|
| 2.1 | Do you own a business? | Yes / No / Starting one | ✓ | "No" → skips to 3.1 (individual return path) |
| 2.2 | Business name | Text | ✓ if 2.1=Yes | |
| 2.3 | Entity type | Select: Sole Prop / LLC / S-Corp / C-Corp / Partnership / Nonprofit / Not sure | ✓ if Yes | "Not sure" is a valid answer — flags advisory opportunity |
| 2.4 | Industry | Select: Food & Beverage — restaurant, catering, food truck, vendor **[→B]** / Healthcare, Therapy & Counseling **[→I]** / Construction & Trades **[→G]** / Retail & E-commerce **[→H]** / Beauty & Personal Care — salon, barber, spa / Professional Services — consulting, legal, design, marketing / Real Estate & Property Management / Transportation & Logistics / Fitness & Wellness / Arts, Events & Entertainment / Cleaning & Home Services / Nonprofit / Other + text | ✓ if Yes | Each option NAICS-mapped internally → auto-suggests IRS activity code. [→X] = fires industry module |
| 2.5 | Years in business | Select: <1 / 1–3 / 3–5 / 5+ | ✓ if Yes | |
| 2.6 | Annual revenue range | Select: <$50K / $50–150K / $150–500K / $500K–1M / $1M+ / Prefer not to say | Opt | |
| 2.7 | Number of employees | Select: Just me / 1–5 / 6–20 / 20+ | Opt | |
| 2.8 | Business zip code | Text (5) | ✓ if Yes | Neighborhood analytics |

### Screen 3 — What You Need
| # | Field | Type | Req | Notes |
|---|---|---|---|---|
| 3.1 | What can we help with? | Multi-select: Tax prep – personal / Tax prep – business / Bookkeeping / Payroll / Sales tax / IRS notice or letter / Entity formation or conversion (LLC, PLLC, S-Corp election) / CFO–advisory / Not sure yet | ✓ | Each selection maps to a service-line opportunity |
| 3.2 | Have you filed last year's return? | Yes / No / Filed an extension | ✓ if tax selected | "No/Extension" flags prior-year work |
| 3.3 | Received any IRS or state letters? | Yes / No | ✓ | Yes → priority routing to Ana-Maria on conversion |
| 3.4 | Anything else we should know? | Long text | Opt | |

### Screen 4 — How You Found Us + Consents
| # | Field | Type | Req | Notes |
|---|---|---|---|---|
| 4.1 | How did you hear about us? | Select: Referral from a person / Hilo NFP / Google / Social media / Another CPA / Other | ✓ | "Referral" → 4.2; "Another CPA" → CPA network field |
| 4.2 | Who referred you? | Text | Opt | Links referral credit |
| 4.3 | Communication consent | Checkbox | ✓ | "Soto Accounting may contact me about my request" |
| 4.4 | E-sign consent (ESIGN Act) | Checkbox | ✓ | Enables Docuseal flow |

**HIDDEN BRIDGE FIELDS (auto-populated only when arriving via Hilo transition link — never shown to a cold visitor):**
BR1 Referred by Hilo = Yes | BR2 Hilo relationship status at referral | BR3 Referred by Jackson (Y/N) | BR4 Hilo program participant (Y/N) | BR5 Hilo first engagement date | BR6 Referring staff member
*(Renamed from B1–B6 in v4.0 to avoid ID collision with Module B fields.)*

**On submit:** confirmation screen (EN/ES) → magic link email → contact + lead created → Rene notified → if 3.3=Yes, Ana-Maria flagged → engagement letter + §7216 queued into portal checklist.

---

## FORM 2 — HILO ENTREPRENEUR INTAKE
**Where it lives:** teamhilo.org + QR at workshops + Jackson's Cal.com confirmation
**What it creates:** Contact record + Hilo status "Exploring"
**Design rule:** ≤90 seconds. This is a hotline, not an application. Warm Hilo voice.

### Screen 1 — Language + You
1.1 Preferred language (EN/ES toggle, ✓) · 1.2 First name (✓) · 1.3 Last name (✓) · 1.4 Email (✓) · 1.5 Mobile (✓) · 1.6 OK to text? (✓) · 1.7 Neighborhood/zip (✓ — funder metric)

### Screen 2 — Your Business (or the one you're dreaming about)
| # | Field | Type | Req | Notes |
|---|---|---|---|---|
| 2.1 | Where are you right now? | Select: Just an idea / Getting started (<1 yr) / Up and running (1–3 yrs) / Growing (3+ yrs) | ✓ | Maps to curriculum level: Foundation / Growth / Scale |
| 2.2 | Business name | Text | Opt | "Doesn't have a name yet? That's fine." |
| 2.3 | What kind of business? | Select: Food & beverage / Retail / Services / Other + text | ✓ | |
| 2.4 | What do you need help with first? | Multi-select mapped to the 4 domains: Money stuff — taxes, bookkeeping, pricing / Legal stuff — licenses, permits, structure / Running the business — operations, hiring, systems / Getting the word out — branding, marketing / I'm not sure — help me figure it out | ✓ | Domain tags drive resource surfacing + session prep |
| 2.5 | Tell us what's going on | Long text | Opt | "A sentence or two is plenty." |

### Screen 3 — Demographics (optional, funder-driven)
Header copy: "These questions are optional. They help us report our community impact to the funders who keep Hilo free."
3.1 Do you identify as a woman? (Y/N/Prefer not) · 3.2 Race/ethnicity (multi-select, standard categories) · 3.3 Veteran? (Y/N/Prefer not) · 3.4 Person with a disability? (Y/N/Prefer not)
All optional. Aggregated only. Never shown on internal day-to-day views — reporting tables only.

### Screen 4 — Book It
4.1 Cal.com embed — Jackson's advisory session (Zoom-only event type for first sessions) · 4.2 Communication consent checkbox (✓)

**On submit:** Hilo portal magic link → status "Exploring" → domain-tagged resources surface in portal → Jackson sees new entrepreneur on her dashboard with session prep context.

---

## FORM 3 — HILO → SOTO TRANSITION FORM
**Trigger:** Jackson's referral (approved from her queue) OR portal CTA when status = "Referral" or session summary flags a financial need (§7216-aware)
**What it is:** Form 1 with everything Hilo already knows PRE-FILLED. The entrepreneur confirms, never re-types.

| Section | Behavior |
|---|---|
| Contact info | Pre-filled from Hilo record. Editable. One tap to confirm |
| Business info | Pre-filled from Hilo record + session data. Editable |
| Bridge fields BR1–BR6 | Auto-populated, locked, invisible to the client |
| Service needs (3.1–3.4) | Pre-checked from session summary flags (e.g. flagged "needs bookkeeping" → Bookkeeping pre-selected). Client can adjust |
| New fields required | Only: consent checkboxes (4.3, 4.4) + anything Hilo never captured (EIN if known — optional) |
| Referral integrity block | One screen, required: "Soto Accounting is one option — you're free to work with any provider. Hilo's Executive Director also holds a role at Soto Accounting." Acknowledge checkbox. Timestamp + policy version logged (protects the 990) |

**Target: under 60 seconds tap-to-submitted.** On submit: Soto lead created with full attribution, Brian notified, warm-handoff message to client from Jackson's template.

---

## FORM 4 — PORTAL FIRST-LOGIN ONBOARDING (the 4-step checklist)
**Who sees it:** every new and migrated client on first magic-link login. Progress bar. Collapses when done.

**Step 1 — Confirm your info** (30 sec): pre-filled contact + business fields, confirm or correct. Migrated Zoho/Dubsado records show enrichment gaps here (missing EIN, entity type) as gentle asks — this is how the data-gap backfill actually happens.

**Step 2 — Sign your documents** (2 min): embedded Docuseal — engagement letter (service-specific) + §7216 consent (+ 8879 when in season). Plain-language one-line explainer above each ("This lets us legally e-file for you"). BLOCKING: work can't start without these; the checklist says so honestly.

**Step 3 — Upload your prior-year return** (1 min): camera/file upload, category auto-set. Skippable with "I'll do this later" → creates a document request task so the chase automation owns it.

**Step 4 — Book your consultation** (1 min): Cal.com embed, Zoom-only initial type. Already-booked clients (came via Form 1 → booking) see this pre-completed.

**Migrated-client variant:** Step 3 replaced with "Review your documents" (their history is pre-loaded — the wow moment). Step 4 replaced with "Anything you need right now?" quick service-request buttons.

---

## BUILD NOTES FOR FABLE
- Every form: autosave per screen (mobile users get interrupted), resume via magic link
- Conditional logic exactly as specced — no screen shows a field that doesn't apply
- All selects admin-editable (Brian adds industries/services without code)
- Spanish copy is a translation pass on final English copy — Brian/Jackson approve both
- Form analytics: started / completed / drop-off screen per form on the admin dashboard

---

## FORM 5 — SERVICE ONBOARDING (Stage 2, modular)
**Trigger:** engagement letter signed → portal checklist adds "Complete your service setup." Modules assemble based on services on the engagement. Client only ever sees modules that apply.
**Owner:** responses route to the service owner (Marian = bookkeeping, Rene = payroll/sales tax, Ana-Maria = tax) for review before work begins.
**Design rule:** each module ≤2 minutes. Access requests are tracked checklist items, not questions.

### MODULE A — TECH STACK (fires for: Bookkeeping, Payroll, Sales Tax, CFO/Advisory)
| # | Field | Type | Notes |
|---|---|---|---|
| A1 | Bookkeeping software | Select: QuickBooks Online / QuickBooks Desktop / Xero / Wave / Spreadsheets / None yet / Other | QBO → triggers accountant-invite access item |
| A2 | Payroll system | Select: Gusto / QB Payroll / ADP / Paychex / We pay manually / No employees / Other | |
| A3 | POS system(s) | Multi-select: Square / Toast / Clover / Shopify POS / Lightspeed / None / Other | |
| A4 | Payment processors | Multi-select: Stripe / Square / PayPal / Venmo Business / Zelle / Cash only / Other | Deposits-net-of-fees is the #1 reconciliation issue — this question scopes it |
| A5 | Online sales channels | Multi-select: Own website (Shopify/Wix/Squarespace) / Etsy / Amazon / None / Other | |
| A6 | Business bank accounts | Number + bank name(s) | Bank feed setup scope |
| A7 | Business credit cards | Number + issuer(s) | |
| A8 | Do you ever pay business expenses from personal accounts (or vice versa)? | Often / Sometimes / Never | The honest question — drives cleanup scoping |

### MODULE B — FOOD & BEVERAGE (fires when industry = Food & Beverage, regardless of services selected)
*(v4.1 fix: under the v4.0 rule a tax-only restaurant client skipped Module A, so Module B never fired — losing the delivery-app 1099-K, cash %, and tips inputs the Schedule C needs. Industry alone now triggers it.)*
| # | Field | Type | Notes |
|---|---|---|---|
| B1 | Third-party delivery apps | Multi-select: DoorDash / UberEats / Grubhub / ChowNow / Direct online ordering / None / Other | Each app = separate 1099-K + fee reconciliation stream |
| B2 | Roughly what % of sales are cash? | Select: <10% / 10–25% / 25–50% / 50%+ | Cash-heavy = different reconciliation + audit posture |
| B3 | How are tips handled? | Select: Through POS/payroll / Cash tips / Both / No tips | Payroll + reporting implications |
| B4 | Do you sell at markets, pop-ups, or events? | Yes / No | Multi-location sales tax exposure |

### MODULE C — BOOKKEEPING SCOPING (fires for: Bookkeeping)
| # | Field | Type | Notes |
|---|---|---|---|
| C1 | When were your books last reconciled? | Select: Last month / 2–6 months ago / 6–12 months / Over a year / Never–not sure | **Primary cleanup detector** |
| C2 | Accounting method | Cash / Accrual / Not sure | |
| C3 | Fiscal year end | Select: December / Other + month | |
| C4 | Do you pay 1099 contractors? | Yes + rough count / No | Year-end 1099 scope. **Count ≥3 fires worker-classification risk flag for ANY industry** — trades (G4) and healthcare (I6) carry sharper industry-specific versions; C4 covers everyone else (booth-rent salons, 1099 trainers, etc.) |
| C5 | Rough monthly transaction volume | Select: <50 / 50–200 / 200–500 / 500+ | Tier scoping |
| **AUTO-SCOPE** | | | C1+C5+A6+A7+A8 auto-calculate a **cleanup flag + suggested tier** (Essential/Growth/Full Mgmt) on the engagement record — Marian reviews the suggestion, Brian approves pricing. Same pattern as the tax calculator |

### MODULE D — SALES TAX (fires for: Sales Tax)
D1 States/jurisdictions where you sell (multi-select) · D2 Currently registered to collect? (Yes/No/Not sure) · D3 Current filing frequency if known (Monthly/Quarterly/Annual/Not sure) · D4 Any past-due sales tax filings? (Yes/No/Not sure) → routes to Rene

### MODULE E — PAYROLL (fires for: Payroll)
E1 W-2 employees count · E2 1099 contractors count · E3 Pay frequency (Weekly/Biweekly/Semimonthly/Monthly) · E4 States where employees work (multi-select — nexus) · E5 Current provider + are you switching or keeping it? → routes to Rene

### MODULE F — TAX ONBOARDING (fires for: Tax prep, replaces none of Form 1 — adds depth)
F1 Who prepared last year's return? (Self/Another preparer/Soto/Didn't file) · F2 Filing status · F3 Dependents (count) · F4 States you lived/earned in during the tax year (multi) · F5 Did you make estimated payments this year? (Yes+amounts if known/No/Not sure) · F6 Major life/business changes this year? (multi: bought/sold property, new business, closed business, marriage/divorce, new dependent, crypto, none) → feeds complexity score inputs

### ACCESS PROVISIONING CHECKLIST (auto-generated from Module A answers — tracked items, not questions)
| Trigger | Access item | Status flow | Owner |
|---|---|---|---|
| A1 = QBO | Invite marian@sotoaccounting.com as Accountant user (guided screenshots in portal) | Requested → Client completed → Marian verified | Marian |
| A2 = Gusto/ADP/etc. | Invite accountant/admin access to payroll | Same | Rene |
| A3 = any POS | Reports-only access or monthly report export instructions | Same | Marian |
| B1 = any delivery app | Portal access or monthly statement upload instruction | Same | Marian |
| A6 | Bank feed connection confirmed in QBO | Marian verifies | Marian |
**Work-start gate (soft):** bookkeeping engagement shows "Waiting on access" status until required items verified — visible to client in portal so the delay attribution is honest (mirrors Pending Client Response logic).

### MODULE G — TRADES & CONTRACTORS (fires when industry = Construction/Trades AND any service module fires)
| # | Field | Type | Notes |
|---|---|---|---|
| G1 | Trade | Select: General contractor / Electrical / Plumbing / HVAC / Landscaping / Painting / Remodeling / Other | |
| G2 | Do you track costs by job/project? | Yes in software / Yes on paper–spreadsheets / No | Job costing setup scope |
| G3 | How do you bill? | Multi-select: Fixed bid / Time & materials / Progress billing–draws / Deposits upfront | Progress billing + deposits = revenue recognition + liability tracking |
| G4 | Subcontractors (1099) | Yes + rough count / No | Year-end 1099 scope + **worker classification risk flag if count high** |
| G5 | Vehicles or equipment owned by the business | Yes + rough count / No | Depreciation schedules → complexity score input |
| G6 | Licensed/bonded jurisdictions | Text | City registrations → Laura's entity/compliance radar |

### MODULE H — E-COMMERCE (fires when A5 ≠ None, or industry = Retail/E-commerce)
| # | Field | Type | Notes |
|---|---|---|---|
| H1 | Selling platforms | Multi-select: Shopify / Amazon / Etsy / eBay / TikTok Shop / Walmart / Own site / Other | Each = separate settlement reconciliation stream |
| H2 | Do you hold physical inventory? | Yes / No (dropship-digital) | COGS + inventory method |
| H3 | Fulfillment | Self-ship / 3PL / Amazon FBA / Mix | **FBA = multi-state nexus flag → Module D auto-fires** |
| H4 | States where you have inventory or significant sales | Multi-select / Not sure | Marketplace facilitator vs own-site sales tax analysis → Rene |
| H5 | Returns/refunds volume | Low / Moderate / High | Reconciliation approach |

### MODULE I — HEALTHCARE & PRIVATE PRACTICE (fires when industry = Healthcare/Therapy/Counseling)
| # | Field | Type | Notes |
|---|---|---|---|
| I1 | License type | Select: LCPC / LCSW / LMFT / Licensed psychologist / Psychiatrist–MD / Chiropractor / PT–OT / Other licensed / Not licensed | Drives PLLC eligibility |
| I2 | Current entity structure | Select: Sole prop / LLC / PLLC / S-Corp / Not formed yet / Not sure | **⚑ AUTO-FLAG: I1 = licensed + I2 = LLC or Sole prop + state = IL → "PLLC conversion opportunity" created on record → routed to Laura + advisory flag.** Illinois requires licensed professionals to organize as PLLC — an existing LLC is improperly formed. This flag IS the new service pipeline |
| I3 | Payment mix | Select: Mostly insurance / Mostly private pay / Even mix | Insurance = receivables + ERA/EOB reconciliation complexity → bookkeeping tier input |
| I4 | Practice management / EHR | Select: SimplePractice / TherapyNotes / Jane / Headway / Alma / Grow Therapy / Other / None | Headway–Alma–Grow = aggregators paying NET (same reconciliation pattern as delivery apps) |
| I5 | Telehealth clients in other states? | Yes + states / No | Multi-state nexus + licensure awareness |
| I6 | Solo or group practice? | Solo / Group with W-2 clinicians / Group with 1099 clinicians / Mix | **1099 clinicians = worker classification risk flag → advisory conversation** |

**Module firing note for Fable:** Form 1 field 2.4 industry list must include Healthcare/Therapy & Counseling, Construction & Trades, and Retail/E-commerce as distinct options so Modules G/H/I fire correctly. All industry modules stack with A + service modules.

### MODULE BUILDER (admin — no-code)
Brian or Jackson creates new onboarding modules from admin without a developer:
- **Trigger**: industry selection, service selection, or answer condition (e.g. A5 ≠ None)
- **Question pack**: field label EN/ES, type (select/multi/number/text/yes-no), required flag, answer options
- **Flags it can set**: named flag on contact/engagement record + routing target (staff member) + optional dashboard alert
- New modules deploy instantly to Form 5 assembly logic. This is how the next client concentration gets its module in ten minutes instead of a dev cycle.

**Watchlist — next module candidate:** Real Estate & Property Management. If concentration develops: property managers carry trust/escrow accounting (IDFPR compliance in Illinois) and landlords stack Schedule Es. Until then, Schedule E count already feeds the tax complexity score.

---

## v4.2 ADDENDUM — INTAKE ADDITIONS (see Master Prompt v4.2 addendum for full module specs)
1. **Deposit checkout step**: New Client Discovery booking (Lane 1) collects the service-level deposit via Stripe before confirmation; true-up language shown at checkout. General Inquiries (Lane 2) has no charge — copy states "Questions are always free."
2. **Entity-group question (Form 1, new field 2.x)**: "Do you own or co-own any other businesses?" (Y/N; if Y → repeatable entity name + your role) → creates/links entity-group membership on the contact record.
3. **IL SOS auto-check**: on business-name/EIN capture, the compliance monitor queries IL Secretary of State; result (good standing / not in good standing / not found) is stamped on the record, shown to staff, and — if adverse — triggers the fix-steps notification. Replaces Brian's manual lookup on every discovery call.
4. **SSN field behavior (individual onboarding)**: options — secure portal entry (default) / "I'll provide by phone" (creates a call task for Rene) / "on file" (returning clients, pre-verified). Never requested over email or SMS.
5. **Service configurator (post-quote)**: recurring engagements configured on the two-axis model — prep cadence + session cadence + scope rungs — with the S corp 2-session floor enforced. Replaces single-package selection.
6. **W9 request flow (client-initiated, post-onboarding)**: portal action "Request a W9 from your contractor" → contractor gets a Docuseal link; completed W9 files under the client for 1099 season.

## v4.2 CHANGELOG
Deposit checkout · entity-group question · IL SOS auto-check at intake · SSN by-phone option · two-axis service configurator · client W9 request flow.
