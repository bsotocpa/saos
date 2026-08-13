# Portal client home — redesign spec (Brian, 2026-08-13, during the rehearsal)

His words, turned into a build list. Nothing here is invented; where a decision is still
open it says so rather than guessing.

## The shape he wants, top to bottom

1. **Let's get you set up** — FIRST container. This is where a client should start.
2. **Open invoices** / **Quick actions** (unchanged position)
3. **Estimated payment due** — its OWN container, further down
4. **Text messages (optional)** — LAST, because it is optional

**Removed entirely: "Your to-dos".** It duplicated the checklist and gave the client
nothing. Rule going forward: if there is nothing of substance, the container does not
render at all.

## The checklist, reordered and renumbered

Deposit first, because services do not start before it is paid.

| # | step | note |
|---|---|---|
| 1 | Sign your documents | was step 2 |
| 2 | **Pay deposit** | **NEW** — nothing starts until this is done |
| 3 | Confirm your information | was step 1 |
| 4 | **Upload your documents** | renamed from "Upload your prior-year return" — clients send more than last year's return |
| 5 | **Track your services** | "allow X for follow-up, feel free to track progress" + a **Go** button to a per-service progress view |

**Dropped: "Book your consultation."** A client only reaches a quote after the discovery
meeting, so asking them to book one is asking for something already done. It moves to
Quick actions as **"Schedule a Call/Meeting"**, pointing at the general customer-support
booking link (`customer-support`, already live in Cal.com).

## Estimated payment due — own container

Currently one line under the greeting. Becomes a container with:

- the amount and due date (as now)
- **Pay the IRS** → irs.gov payment page
- **Pay Illinois** → mytax.illinois.gov
- **Book a session** → so a client can review the amount or update it after a life change

## Documents — a client can undo a mistake

"When I upload a document I don't see an option to remove, in case a client uploads the
wrong file."

**Needs a ruling before building.** Client documents are audit-logged, virus-scanned and
filed against document requests; the WISP rule is that every access and change is
recorded. So "remove" should almost certainly be **supersede/withdraw**, not delete:

- the file stops counting toward its document request and disappears from the client's
  active list
- the row and the object survive, marked withdrawn, with who did it and when
- a withdrawn file cannot satisfy a request, so the chase resumes

That keeps the audit trail intact while giving the client the undo they expect. **Confirm
this is the shape you want** — the alternative is a true delete, which conflicts with the
retention and audit rules.

## What this touches (why it is not a copy tweak)

The checklist steps are DATABASE COLUMNS, not a list in code:

```
portal_onboarding.step_confirm_info_at
portal_onboarding.step_sign_docs_at
portal_onboarding.step_upload_prior_return_at
portal_onboarding.step_book_consult_at
```

So the change needs a migration: add `step_pay_deposit_at`, rename the prior-year column
to something honest, and retire `step_book_consult_at` **without dropping the data** —
existing rows record real client actions and deleting the column would erase them.

Also required:
- `/portal/onboarding` and the step-completion route learn the new set
- step 2 (Pay deposit) should complete ITSELF when the deposit invoice is paid, rather
  than relying on the client to tick it — the system already knows
- step 5 needs a per-service progress view to link to; confirm whether that means the
  existing tax-engagement stages or something new

## Sequencing

Recommended: finish the remaining rehearsal steps first (upload a document, Messages,
intake in EN and ES). Changing the checklist mid-run would break the steps still being
tested, and the remaining ones take minutes. Then this lands as one piece.
