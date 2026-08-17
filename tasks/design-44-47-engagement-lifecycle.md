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
