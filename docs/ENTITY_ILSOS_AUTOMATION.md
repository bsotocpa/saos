# Automated ILSOS lookups: asked for, refused, retired

**Status: CLOSED. Do not reopen without a contract.**
Decided 2026-09-06 by Brian Soto. This file exists so that the decision survives the people who
made it.

---

## The short version

The Illinois Secretary of State was asked, in writing, to allow SAOS to query their business
search automatically. They said no: **automated querying violates their Terms of Use, and they do
not whitelist.**

The scraper was therefore **removed from every code path** — not disabled, not feature-flagged.
`scripts/check-no-sos-scraping.mjs` fails the build if any code in this repository fetches a
Secretary-of-State host, so rebuilding it is not a thing that can happen by accident.

The lookup is now a person in a browser, on a schedule the system keeps. That is the procedure,
and it is compliant. See the `laura-sos-verify` SOP.

---

## How it went

### 1. It never worked

`SOS_MODE=live` was set in production from the day the box was provisioned. Every call failed.

Measured 2026-08-17, before anything was changed:

| | |
|---|---|
| `sos.checked` audit rows in production | **0** |
| Businesses with `il_sos_checked_at` set | **0 of 619** |

Every request had been failing into a `catch` that logged a warning and returned `null`. A monitor
that has never once monitored, for a month, with nothing reporting that fact — the run record said
`checked: 0`, which is also what a clean day says.

### 2. The block

Fetching the search endpoint:

| From | Result |
|---|---|
| the office | HTTP **403** in 0.35s — the Secretary of State's own block page |
| `saos-prod`, IPv4 | HTTP **403** in 0.18s — same page |
| `saos-prod`, IPv6 | HTTP **403** in 0.18s — same page |
| `efile.sunbiz.org` (Florida), same host | flat **403** |

The block page said:

> Sorry, the page you are looking for is not available. Please email webmaster@ilsos.gov including
> the Reference ID and Client IP numbers below.

Identifiers sent with the request, captured 2026-08-22 17:27:50 CDT:

- Reference ID (IPv4): `0.cc00de17.1787437670.7dd1b1dd` — Client IP `178.156.196.114`
- Reference ID (IPv6): `0.e15ec817.1787437670.5d0b5479` — Client IP `2a01:4ff:f0:3053::1`

Both were included because the host resolves AAAA records first; an allowlist covering only IPv4
would not have taken effect in normal operation.

**A correction that mattered.** An earlier note recorded that the server "hangs" while only the
office got a 403. That was wrong — the hang came from a Node `fetch` in a diagnostic, not from
ILSOS. It mattered practically: believing the server hung is why the first Reference ID offered
for the appeal belonged to the office rather than to the machine that needed access. Allowlisting
the wrong network would have appeared to fail for no reason.

### 3. The answer

The state's reply: **automated queries violate their Terms of Use. No whitelisting. Full stop.**

### 4. What was done about it

Brian's rulings, 2026-09-06:

1. **Retire the fetch permanently** — removed from every code path, not disabled.
2. **Convert the monitor to task generation** — same cadence, output is a staff task, result
   recorded on the entity with `staff_verified` provenance.
3. **The Illinois formation-date backfill is that same manual task**, not a parse.
4. **Log the exchange here** so nobody rebuilds the scraper.
5. **No WAF block may read as an entity problem** — a refusal is never a fact about a client.

---

## Why this is not a workaround to be improved on

Two things were technically possible and were not done.

**Evading the block.** Rotating user agents, proxying through residential addresses, pacing
requests under a detection threshold — all standard, all effective, all out of the question. This
is bot-detection evasion against a state agency, by a CPA firm, concerning that agency's own
records about that firm's own clients. The exposure is not "the scraper stops working"; it is a
licensed professional's relationship with a regulator.

**Reading the refusal as a bug.** A 403 is a decision, not a fault. The old code turned it into
`not_found` — which does not mean "we could not look", it means **the state has no record of this
company**, a serious finding about a client's entity. For a month, any successful-looking parse
failure would have written that. The value survives, because a person searching and finding
nothing is real; nothing can write it from a failure any more, because nothing fails.

---

## What would change this

The Illinois Secretary of State runs a **commercial bulk-data programme**. Brian is asking about
it separately.

If that is contracted, the automated route comes back — but as a licensed data feed, purchased,
with terms, and the guard is updated deliberately with a contract to point at. It does not come
back because someone found a faster endpoint.

Until then: `laura-sos-verify`, a browser, and a person.

---

## Where the pieces live

| | |
|---|---|
| Cadence + task generation | `apps/api/src/modules/entity/sos.ts` → `runSosRecheckJob` |
| Raising one lookup | `requestSosVerification` (recheck, intake, enrolment) |
| Recording the answer | `recordSosResult`, and `POST /businesses/:id/sos-result` |
| The procedure | `laura-sos-verify` SOP |
| The guard | `scripts/check-no-sos-scraping.mjs`, wired into `npm test` |
| Client notice | automation `sos_adverse_client_notice` — registered, ships **disarmed** |
