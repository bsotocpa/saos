# #44 and #47 — what an engagement is, and when it ends

Two designs, no code. Both are about the same object from opposite ends: #47 gives an
engagement a definition of **what it covers**; #44 gives it a definition of **when it is
over**. Neither is built until you sign off.

---

## First: a correction to the premise

You wrote that #44 "matters beyond status: the Dubsado retirement trigger counts a
month-end close." **The retirement trigger does not depend on engagement closure at all.**
It counts `close_cycles` — the bookkeeping month-end close, `cadence = 'monthly'` with
`closed_at` set — and that mechanism already exists and works:

```
A. 25 migrated clients have logged into the portal   (currently measurable)
B. one full month-end close has run inside SAOS      (close_cycles, already built)
```

So retiring Dubsado is not blocked on #44. I'd rather say that now than design toward a
dependency that isn't there.

**The return-delivery half of your premise is real**, and stronger than you put it. See
§1.3 — the tax pipeline already has a terminal state that nothing propagates.

---

# #44 — the engagement close path

## 1. What exists today

### 1.1 The states

`engagement_status` is already a five-value enum: `draft, active, on_hold, completed,
withdrawn`. **The states you asked me to design mostly exist** — what is missing is the
*act* that moves an engagement into a terminal one, and any meaning attached to it.

| Value | Used today | By what |
|---|---|---|
| `draft` | yes | configurator creates non-tax engagements here |
| `active` | yes | quote acceptance, intake |
| `on_hold` | **never set by any code path** | — |
| `completed` | **never set by any code path** | — |
| `withdrawn` | yes | migration 0061 (duplicate cleanup) only |

`ended_on` (date) exists and is written only by that same duplicate-cleanup migration.

### 1.2 Nothing closes an engagement

There is no route, no service function, and no job that moves an engagement to
`completed`. The configurator sets `draft → active`; after that an engagement is active
forever. This is why #42's `active → dormant` transition is currently carried by the
health sweep — a stand-in I flagged at the time and want to remove.

### 1.3 The tax pipeline already ends, and nothing hears it

`tax_engagements.stage` has a real terminal state with a real gate:

```
ready_to_file → filed → completed      (completed reached ONLY by e-file acceptance)
filed → rejected → ready_to_file/in_preparation
completed: []                          (genuinely terminal)
```

`recordEfileAcceptance` transitions a return to `completed`. **The parent engagement stays
`active`.** So today a client whose 2025 return was accepted by the IRS has:

- `tax_engagements.stage = 'completed'` — the work is finished and filed
- `engagements.status = 'active'` — the system believes it is ongoing
- `contact_status = 'active'` — because an "open" engagement exists

That is the same class of untruth as #42's "lead", one level down. **This is the strongest
argument for #44 and it is not hypothetical** — it will happen to the first client whose
return is accepted.

## 2. Proposed terminal states

You asked whether it is `completed / withdrawn / declined`, and whether `on_hold` is
terminal. My proposal:

| State | Terminal | Meaning | Who sets it |
|---|---|---|---|
| `draft` | no | configured, not agreed | configurator |
| `active` | no | work is live | acceptance |
| `on_hold` | **NO — a pause** | paused, expected to resume | staff, reason required |
| `completed` | **yes** | the work was done and delivered | staff, or propagated from the return |
| `withdrawn` | **yes** | ended without delivering — we or the client stopped it | staff, reason required |

### 2.1 `on_hold` is a pause, not an end

It should NOT count as open for `contact_status` purposes and should NOT count as closed
either. A client with one paused engagement is not `active` (no work is happening) and not
`dormant` (the relationship has live work waiting). I propose **`on_hold` keeps the client
`active`** — the engagement is still ours to move, and a paused engagement showing the
client as dormant would hide real work.

There is precedent to reuse rather than invent: `engagements.work_paused_at` /
`work_pause_reason` already exist, written by the dunning job when payment stops work.
`on_hold` should be the *status* that pairs with those columns rather than a second
mechanism.

### 2.2 I recommend AGAINST adding `declined`

You floated it with a question mark. My read: `declined` describes a **quote**, not an
engagement — `quotes.status` already has `declined` with `decline_reason`. An engagement
only exists because a quote was accepted, so "declined" cannot happen to one. The case you
might mean — *we agreed, then it fell apart before any work* — is `withdrawn` with a
reason, and inventing a second word for it means two states nobody can reliably choose
between.

**If you want it, the distinction has to be nameable in one sentence.** I could not write
that sentence, which is why I am recommending against.

### 2.3 Reason: optional on `completed`, REQUIRED on `withdrawn`

Your ruling said "reason optional". I would split it:

- `completed` — reason optional. The work being done is its own explanation.
- `withdrawn` — **reason required**, enforced by a CHECK constraint like
  `contacts_archived_has_reason`. An engagement that ended without delivering, with no
  record of why, is the thing someone will need in a year and not have. This is the same
  argument you accepted for `archived`.

Flagging it as a deviation from what you said rather than quietly doing it.

## 3. The close action

```
POST /engagements/:id/close
  body: { outcome: 'completed' | 'withdrawn', reason?: string, endedOn?: date }
  permission: engagements.write (proposed — see §3.1)
```

- Refuses if already terminal (409), so a second click is not a silent overwrite.
- Sets `status`, `ended_on` (defaults to today), `notes`/reason.
- Audits `engagement.closed` with outcome, reason, and who.
- Calls `refreshContactStatus(contactId, 'engagement_closed')` — which is where
  `active → dormant` comes from, replacing the health-sweep stand-in.

### 3.1 One permission gap to rule on

There is **no `engagements.write` permission** in the role seed. The closest are
`engagements.read`, `engagements.tax.manage`, and the per-service `*.assigned.manage`
family. Closing a bookkeeping engagement is not a tax action. Options:

- **(a)** add `engagements.write`, granted to ceo + ed_coo — clean, one more permission
- **(b)** reuse `contacts.write` — wrong shape; closing work is not editing a contact
- **(c)** require the matching service-line permission — most precise, most fiddly

I recommend **(a)**.

## 4. Propagating the return's terminal state

When `recordEfileAcceptance` moves a return to `completed`, the parent engagement should
close **only if every tax engagement under it is terminal**. A client with 2024 and 2025
returns on one engagement is not finished when the first is accepted.

Proposed: on acceptance, check for remaining non-terminal `tax_engagements` on that
engagement; if none, close it as `completed` with reason `"All returns filed and
accepted."` and let `refreshContactStatus` do the rest.

**This is the piece I would build first if you only want one thing** — it fixes a
correctness bug that is already waiting to happen, rather than adding a capability.

## 5. What #44 does NOT do

- It does not touch the Dubsado trigger (§Correction).
- It does not close recurring engagements automatically. Bookkeeping and payroll have no
  finish line; they end when someone decides they have.
- It does not un-close anything. Re-opening is a new engagement, because the work someone
  agreed to is the work that was quoted.

---

# #47 — the engagement → quote-lines scope link

## 1. The gap, precisely

`quote_line_items` exists and is rich: `item_code`, bilingual descriptions, quantity,
`unit_cents`, `line_cents`, `min/max_cents`, `is_optional`, `chosen`, `is_pass_through`,
`sort_order`. Everything needed to say what an engagement covers is already stored.

**The link is one-directional and lossy.** `quotes.converted_engagement_id` is a single
column, and all 5 production quotes have it set — but #19's `engagementLinesForQuote()`
splits an accepted quote into **one engagement per service line**. So a quote covering tax
+ bookkeeping + payroll creates three engagements and points at one of them.

The consequence, which is exactly what you saw in #41:

- an engagement cannot say what it covers
- two engagements on one service line are indistinguishable
- `engagements.title` is the only carrier, it is free text, and it held "Accepted quote"
  until I backfilled it

## 2. Proposal: `engagement_scope_items`

A join table rather than a column, because the relationship is many-to-one and the
alternative is re-deriving scope by re-parsing a quote every time.

```
engagement_scope_items
  engagement_id      → engagements(id) ON DELETE CASCADE
  quote_line_item_id → quote_line_items(id)
  PRIMARY KEY (engagement_id, quote_line_item_id)
```

Written by the same code that creates the engagements, in the same transaction — so an
engagement without scope becomes impossible rather than merely unusual.

### 2.1 What it makes possible

- **A name derived from data, not free text.** `projectName` composes from actual item
  descriptions instead of a `title` column anyone can type into.
- **Bilingual names for free.** `quote_line_items` already carries `description_en` and
  `description_es`, so the portal stops needing a Spanish label table for engagement names.
- **"What am I paying for" answerable** on the portal and the client record.
- **#44 gets a delivery definition**: an engagement covering three items is done when all
  three are.

### 2.2 The backfill problem — and my recommendation

There is no way to reconstruct which engagement covered which line for the 5 existing
quotes, because the split happened in code and was never recorded.

I recommend **not backfilling**. An engagement with no scope rows renders as it does today
(service line, or title when more specific). Guessing at scope and storing the guess would
make an unreliable record look authoritative — the same error as my 426-client backfill,
where I derived a confident wrong answer from incomplete evidence.

### 2.3 Where the title column ends up

`engagements.title` stays, but stops being the source of truth for the client-facing name.
It becomes what it should have been: a **staff label**, editable, for the cases where a
human wants to call something something. Composition prefers scope items → tax year/form →
title → service line.

## 3. Cost and sequencing

| | #44 | #47 |
|---|---|---|
| Migration | `on_hold`/reason columns, CHECK on withdrawn | one join table |
| New surface | close action on the client record | none — it feeds existing surfaces |
| Riskiest part | propagation from the return (§4) | none; additive |
| Fixes a live bug | **yes** — accepted returns leave engagements open forever | no |
| Unblocks | removes the health-sweep stand-in for `dormant` | #41 properly, and #44's §4 |

**Recommended order: #44 §4 first** (the propagation bug), then #47, then the rest of #44.
§4 is small and fixes something already broken; #47 makes #44's "is it all delivered?"
question answerable for non-tax work, which the rest of #44 then uses.

---

## Decisions I need

1. **`declined`** — add it, or is `withdrawn` + reason enough? (I recommend against; I
   could not write the one-sentence distinction.)
2. **`on_hold`** — agreed it is a pause, and a paused engagement keeps the client `active`?
3. **Reason on `withdrawn`** — required, as a constraint? (Deviates from "optional".)
4. **Permission** — add `engagements.write`, or something else?
5. **#47 backfill** — confirm: leave existing engagements without scope rather than guess.
6. **Order** — propagation bug first, or the full close action first?

---

# Amendments (Brian's rulings, 2026-08-16)

All six decisions confirmed as recommended. Two additions, one of which changes #47's
design and one of which I cannot confirm as stated.

## A. #47 is a SNAPSHOT — design amended

**You are right that the design did not say this.** `engagement_scope_items(engagement_id,
quote_line_item_id)` is a foreign key to a live row: editing a quote line afterwards would
silently rewrite what the engagement claims to cover, and nothing would look wrong. That is
the same shape as the price-book bug the price-lock fields exist to prevent — an agreement
whose terms move after it was agreed.

**Amended design — the scope row carries the content, not a pointer to it:**

```
engagement_scope_items
  id
  engagement_id          → engagements(id) ON DELETE CASCADE
  -- provenance, for tracing only. NEVER joined to for display or totals.
  source_quote_line_id   uuid NULL          (the line this was taken from)
  source_quote_id        uuid NULL
  -- THE SNAPSHOT: what was agreed, as it read at acceptance
  price_book_version_id  → price_book_versions(id)   NOT NULL
  item_code              text NOT NULL
  description_en         text NOT NULL
  description_es         text
  quantity               numeric NOT NULL
  unit_cents             integer
  line_cents             integer
  is_pass_through        boolean NOT NULL DEFAULT false
  captured_at            timestamptz NOT NULL DEFAULT now()
```

Written once, in the same transaction that creates the engagement, and **never updated**.
The price-book version is pinned alongside the text, so an engagement can always answer
"what did we agree, at what prices, under which version" from its own rows.

`source_quote_line_id` is deliberately nullable and deliberately never read for display —
it exists so a human can trace where a line came from, and it must survive the quote line
being edited or deleted afterwards. **No FK constraint on it**, for that reason: a
constraint would either block a legitimate quote edit or cascade a delete into the
engagement's own record of what was agreed.

This also removes a dependency I had quietly accepted: the amended table needs nothing
from `quote_line_items` at read time, so the portal and the client record compose names
and totals without touching quotes at all.

## B. `on_hold` freezing the ladder — I cannot confirm this, and here is why

You asked me to confirm the pause "also freezes the escalation ladder and any
engagement-level clocks." Three findings, none of which is a confirmation:

### B.1 The ladder is engagement-blind today

`runLadderJob` reads `tasks.waiting_since` and joins to `contacts`. **It never looks at
`engagements` at all**, so it has no idea whether work is paused. Dunning already pauses
work (`work_paused_at`) for non-payment, and the ladder keeps escalating those clients
today, unchanged. So "the pause also freezes the ladder" is not something to confirm — it
is new behaviour that does not exist for the pause we already have.

### B.2 The kill-switch pattern does NOT do what you may be picturing

When `escalation_ladder` is disarmed, rungs do not advance — but `waiting_since` keeps
running. On re-arm, a task waiting 40 days evaluates to rung 4 and fires **D30
immediately**. The protection is that it fires the highest newly-reached rung ONLY, so the
client gets one message rather than four — not that the clock was held.

So "resuming from the client's real clock per the kill-switch pattern" contains a
contradiction I would rather surface than resolve by guessing: the kill-switch pattern
resumes on WALL-CLOCK time, which is the opposite of freezing.

### B.3 The ruling I need

Two readings, different client experiences:

- **(i) Pause holds the clock.** On resume, `waiting_since` advances by the paused
  duration, so the paused interval never counts as client delay. A client paused for six
  weeks resumes at the rung they were on. *Argument for:* we imposed the pause; escalating
  someone for not answering during our own hold is chasing them for our decision.
- **(ii) Pause suppresses sends only** — exactly the kill-switch. On resume the real
  elapsed time applies, so a long pause lands them at D30 with one message. *Argument for:*
  the dunning pause exists **because the client has not paid**, and a client who owes money
  and has gone quiet for six weeks arguably should be at D30.

The two diverge most in the case that matters: **dunning**. I lean (i) for a
staff-initiated `on_hold` and (ii) for the dunning pause — the difference being who caused
the pause — but that is a policy call about how hard to chase a non-paying client, and it
is yours.

### B.4 Engagement-level clocks: there is exactly one, and it is a pricing question

The only engagement column that ticks is **`price_lock_expires_on`**. Whether a pause
should extend it is a pricing ruling, not an implementation detail: a client paused for
two months either keeps the price they were quoted or does not. `maintenance_mode_at`,
`configured_at` and `ended_on` are stamps, not clocks — nothing expires from them.

**I have not built any of B.** Recommend: settle B.3 and B.4 before `on_hold` ships. It
does not block #44 §4 or #47, which is what I am building now.
