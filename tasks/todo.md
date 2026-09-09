# TODO — 2026-09-09 OVERNIGHT BATCH (Brian asleep; one commit per item; suite + one sabotage per run)

Guardrails: never touch Jackson F. / Josean I. / Joseph B.; no attorney language; no staff accounts;
no live charges; no webhook-subscription changes; Rehearsal Client 2 fixes via real routes only.

- [x] 0. DB confirmations: 0003 was still paid (Stripe delivered the 08:39 resend → 401, unlatched); re-delivered via the API retry → 200, latched, refunded, credit 0. 0002 void by Brian 08:56 (notice 08:56:55); no session to expire; engagement 6e474b1f still says deposit charged $200 (finding). Both $430 accepts produced engagements + deposit invoices.
- [x] 1. Flash renders once: one page-level slot on the client page; sweep found 4 more pages (pricing, pipeline override, portal questionnaire, task-form was two components) — fixed; guard scripts/check-flash-once.mjs in the build chain (static: per-component count; no render harness exists). Sabotage: duplicate pasted back → guard fails.
- [ ] 2. Flash tells the truth (queued vs delivered [time], linked to the send-log row; sabotage: worker blocked → "queued").
- [ ] 3. One active engagement per (contact, service_line, period): partial unique index; legacy report (DECISION-PENDING);
      quote-send gate (change_order + replaces); atomic change-order acceptance; deposit credit carry; sabotage: drop index;
      withdraw the newer $430 engagement via the real route; report the 08-13 Taxes engagement + SA-2026-0001.
- [ ] 4. Ops invoice display: same status column as portal; void/refunded/partial inline detail; behavioural test.
- [ ] 5. Date formatting sweep: one helper; Chicago for Ops, client locale for portal; ISO-T grep test.
- [ ] 6. Carryovers: a) no 90-day expiry; b) retire expired sessions; c) void template EN/ES; d) refund receipt gate check
      shown in the send path; e) dashboard net-of-refund test + fix; f) is_test=false list + rehearsal flags; g) dispute SOP.
- [ ] 7. If time: Ops client page audit as Rene — list, don't fix.
