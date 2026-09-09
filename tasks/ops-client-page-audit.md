## Item 7 — the Ops client page, read as Rene on her first day (list only; nothing fixed)

1. **Two engagements titled the same thing.** Rehearsal Client 2 still shows "Taxes" (08-13,
   active, no period) beside "Tax — Individual return — MFJ" (09-09, active). Same line, no
   way to tell which is the real agreement. Proposed: an engagement row shows its period
   ("2025 return") and, when period is NULL, a "period not recorded" badge that links to the
   DECISION-PENDING list.
2. **An engagement says "deposit charged $200" under a void invoice.** 6e474b1f's
   deposit_charged_cents is 20000; SA-2026-0002 is void. The row asserts money that was never
   taken. Proposed: derive "deposit" on the engagement row from its invoices (paid − refunded),
   never from the stamp; keep the stamp as "deposit quoted".
3. **"Send reminder" on a void invoice was possible until tonight's card fix; on a
   partially refunded one it still is not obviously wrong.** Proposed: the reminder control
   appears only for sent/overdue and says the amount it will chase.
4. **The pay link is printed as a URL "so it can be read out on a call."** The link is now a
   40-character token; nobody reads that aloud. Proposed: replace with "Text/email the pay
   link" (one tap, through the send log) and drop the URL text.
5. **"Before you work this" lists gates, but the packet card below says "Nothing is papered
   yet. Fix the reason above and reload."** Two places explain one state, in different words.
   Proposed: one gate card with the reason and the single action that clears it.
6. **The Quotes card shows three drafts at $75 / $75 / $195 with no author, no age, no
   "why".** A first-day reader cannot tell abandoned from in-progress. Proposed: draft rows
   show who started them and when, and a "withdraw draft" control with a reason.
7. **Sessions card: "summarized by <model>"** names a model to a person who has no reason to
   know what that means. Proposed: "summary auto-generated — review before relying on it."
8. **Documents card caps at 12 with "+N more" and no link.** Proposed: the "+N more" opens the
   documents page filtered to this client.
9. **Portal-access copy: "sign-in link delivered <time>"** is now true, but the card does not
   say whether the client ever signed in since. Proposed: "last signed in <date>" already
   exists at the top — move it beside the grant control.
10. **The Meetings and Sessions cards both exist** with overlapping meaning (recorded sessions
    vs calendar meetings). Proposed: one card, "Meetings", with a "recorded" badge on rows
    that have a transcript.
11. **Status badges use the raw enum** (`sent`, `partially_refunded`, `on_hold`). Proposed:
    one label map per enum, shared with the portal's wording where the client sees the same
    state (portal says "Open" for `sent`).
12. **"Test client: workable here, excluded from every number on this page"** appears on the
    pipeline card but not on the client page header for the same client. Proposed: the same
    badge in the header, with the test_note on hover.
