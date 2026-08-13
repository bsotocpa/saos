# Rehearsal Runbook — full client journey, Rehearsal Client 2

**Client:** Rehearsal Client 2 · `brian3712+rehearsal2@gmail.com`
**Contact id:** `f80118b8-cafb-452f-a167-b3592da20ded`
**State at creation:** 0 quotes · 0 documents · 0 packets · 0 message threads · `is_test = true` · `soto_status = lead`
**Portal access:** already granted, so sign-in by magic link is part of the rehearsal.

Written for a phone. Two browser contexts, because you are playing both roles:

- **OPS** — `https://ops.sotoaccounting.com` — you as staff
- **PORTAL** — `https://portal.sotoaccounting.com` — you as the client

Use a private/incognito window for PORTAL. Same-browser sessions are separate cookies
so it works either way, but one tab each stops you losing your place.

**Gaps are marked inline.** 🔴 means it will not work today and why. 🟡 means it works
but not the way you would expect. Nothing below is a guess — each one was checked
against production on 2026-08-12.

---

## Step 1 — Sign in as staff (OPS)

1. Open `https://ops.sotoaccounting.com`
2. Email `brian@sotoaccounting.com`, your password, then your TOTP code.

**You should see:** the Executive dashboard. No "System health" card — that card is
silent when nothing is wrong, and right now ClamAV is healthy and nothing is awaiting a
scan. Its absence is the pass condition.

---

## Step 2 — Find the client (OPS)

1. Tap **Clients** in the nav.
2. Tap **Rehearsal Client 2**.

**You should see:** the client detail page, cards stacked for a phone. Empty Returns
card, empty Engagement packet card, no documents.

🟡 The client directory lists test clients alongside real ones with a `test` badge.
That is deliberate — "excluded from measurement, visible in operations."

---

## Step 3 — Build and send a quote (OPS)

1. Tap **Pipeline** in the nav.
2. Start a new quote and select **Rehearsal Client 2**.
3. Add line items from the price book. For a 1040-series journey pick the individual
   return item so Schedule A is what gets attached later.
4. Send it.

**You should see:** the pipeline header count go to 1 open, and a confirmation that
stays on screen until you dismiss it. The client gets an email with a proposal link.

🔴 **Known gap — the guided tax interview UI does not exist yet.** The engine, the API
and the tests are done (9 questions, derives schedules, counts multiply, range stays on
the base only) but there is no staff-facing screen for it, so you are picking line items
by hand. This is the unfinished half of item C.

🟡 The duplicate-quote guard fires if this client already has an open quote. It will not
fire here — Rehearsal Client 2 has none.

---

## Step 4 — Open the proposal as the client (PORTAL)

1. Open the proposal link from the email on your phone.

**You should see:** the quote with its line items and total, an **Accept** button, and a
decline path.

🔴 **Known gap — the decline/dispute UX is item D and is not built.** Declining works,
but there is no separate "Something looks off?" path that opens a thread, notifies staff
and holds the quote open. If you want to test declining, do it on a throwaway quote, not
this one.

---

## Step 5 — Accept the quote (PORTAL)

1. Tap **Accept**.

**You should see:** an acceptance confirmation.

🔴 **KNOWN GAP — THIS IS FINDING #17, AND IT IS THE ONE THAT BIT YOU LAST TIME.**
Acceptance currently produces **no visible consequence** on a client who already has a
signed Master covering that schedule. Rehearsal Client 2 has no signed Master, so
acceptance here should behave better than it did on Rehearsal Client 1 — but the fix is
not built yet, so treat whatever you see at this step as unverified. I am building #17
next; when it lands, acceptance either creates the engagement work and tasks for that
schedule, or refuses at SEND time with "this client already has an active Schedule A —
adding work or duplicating?"

**Do not stop the rehearsal here.** Carry on to step 6 — the packet path works
independently of this gap.

---

## Step 6 — Deposit (PORTAL, then OPS)

🔴 **KNOWN GAP — production runs `STRIPE_MODE=stub`, and stub mode refuses checkout in
production on purpose** (503 `stripe_not_configured`). A real card payment is not
possible today. You have two ways through:

- **Waive it (what you did last time, works now):** in OPS, on the quote, use the
  deposit override to set the deposit to $0 with a reason. Your CEO role holds
  `deposits.override` explicitly — verified in production — so the control is there.
- **Or make payments real:** install Stripe **test** keys and set `STRIPE_MODE=live`.
  That exercises the true checkout against Stripe's test environment. This is a config
  change on the server plus a restart; say the word and I will do it.

**You should see, after waiving:** the deposit requirement satisfied, and an audit row
recording the override with your reason.

---

## Step 7 — Create and review the engagement packet (OPS)

1. On the client page, find the **Engagement packet** card.
2. Tap **Preview** to see which schedules will attach.
3. Tap **Create**.
4. Tap **Review document** — this opens the rendered packet as HTML, readable on a
   phone.

**You should see:** the Master Engagement Agreement plus **Schedule A** (individual
tax), with `{{schedules_attached}}` filled in with the actual schedule codes, and the
late-fee disclosure present. No `{{...}}` placeholders anywhere. If you see a raw
template variable, stop and tell me.

---

## Step 8 — Send for signature (OPS)

1. Tap **Send for signature**.

**You should see:** confirmation that it went to the portal. The client gets an email.

This is **portal-native signing**, permanently — not Docuseal. Docuseal stays for 8879s
only.

🟡 If the button says **"Grant portal access first"** instead, something is wrong —
Rehearsal Client 2 already has a portal user. Tell me rather than working around it.

---

## Step 9 — Sign it (PORTAL)

1. Open the portal, sign in by magic link if needed.
2. Go to the signing screen.
3. Type your full legal name and submit.

**You should see:** a signature confirmation. Behind it: the document is re-rendered
server-side and the hash re-verified before the signature is recorded, a copy is stored
in MinIO **before** the signature row is written, and your IP, user agent and method are
stamped on it.

---

## Step 10 — §7216 consent (PORTAL)

1. Dismiss the signature confirmation.

**You should see:** a dedicated `/consent` screen with **nothing else on it** — no site
nav, no checklist, no progress bar, no thank-you residue. It states the consent text,
its **duration**, an affirmative action, and a **decline styled exactly as prominently
as the accept**.

This is the Rev. Proc. 2013-14 isolation rule and it is launch-gate tier. If you can see
navigation or checklist chrome on that screen, that is a compliance defect, not a
cosmetic one — stop and tell me.

Either choice is valid for the rehearsal. Declining blocks nothing, and a decline can
never overwrite an already-signed consent.

---

## Step 11 — Back to the checklist (PORTAL)

**You should see:** the home checklist with **step 2 (Sign your documents) marked done**,
and no dead end. You should not have to find your own way back.

🟡 "You're all caught up — nothing waiting on you" must **not** appear above an
unfinished checklist. That was finding #8 and it is fixed, but it is worth a glance.

---

## Step 12 — Upload a document from your phone (PORTAL)

1. Tap **Documents**.
2. Pick a category, choose a file — a photo from your camera roll is the realistic test.
3. Upload.

**You should see:** the document listed as **Received**, with a Download button.

Behind it: the file is virus-scanned inline. Because ClamAV is healthy, the verdict is
`clean` and the file files immediately. If the scanner were down, the upload would
**still succeed** — it would sit as "awaiting scan", visible to you, and the rescan job
would file it automatically when the scanner came back. Intake never refuses.

🔴 **KNOWN GAP — the attachment acknowledgement will NOT fire here.** `attachment_acks`
is armed, but it is wired only to the **inbound email/SMS** path, and its copy points the
client *at* the portal ("please use the secure portal"). Sending that to someone who just
used the portal would be nonsense, so I did not reuse it. A portal-upload confirmation
needs its own registered automation and its own template, which you then arm. That is a
build, not a config change — it is not in tonight's scope and I have logged it.

---

## Step 13 — Send a file inside Messages (PORTAL)

1. Tap **Messages**.
2. Type a note, attach a file, send.

**You should see:** **one** message containing your note plus the sentence
`[Attached: yourfile.pdf]`, and a link to open the attachment.

Then check **Documents** — the same file appears there, filed and scanned, exactly as a
direct upload. That is your no-silent-fork rule: a differential test asserts every
`documents` column matches between the two paths, and that no `source`/`origin` column
exists for anything downstream to branch on.

---

## Step 14 — Book the consultation (PORTAL)

1. On the home checklist, tap **Go** on **step 4, Book your consultation**.

**You should see:** Cal.com's booking page for **Onboarding Consultation**, 30 min, Cal
Video, America/Chicago, with **your name and email already filled in**. The description
appears in English and Spanish.

Verified availability: weekdays 9:00am–4:30pm, weekends closed, and all **13** blackout
dates unbookable — including Labor Day, Sep 7, which you just added.

2. Book a slot. Cancel it afterwards if you like; the booking itself is not needed for
   any later step.

---

## Step 15 — Intake questionnaire, EN then ES (PORTAL)

1. Open `https://portal.sotoaccounting.com/intake/soto_intake`
2. Work through it in English.
3. Use the **language toggle** to switch to Spanish and check the same screens.

**You should see:** every question, help text and option label switch to Spanish. The
first question is literally "Which language should we use with you? / ¿En qué idioma
prefiere que le hablemos?".

🟡 **This page is not linked from the portal nav** — it is a public pre-portal form
reached by a link you send, so you need the URL above. If you want it in the portal for
existing clients, that is a small change; tell me.

🟡 Spanish **form** copy is complete. Spanish **legal template** bodies are not: every v3
template ships `needs_es_review = true` with no Spanish body, the render path falls back
to English and logs it, and the translations are queued for your approval. So an
ES-language client would get the questionnaire in Spanish and the engagement letter in
English until you approve those.

---

## Step 16 — Check what it looked like from your side (OPS)

1. **Documents** in the nav — the new page. You should see both files you uploaded,
   scan status **Clean**, each row naming Rehearsal Client 2.
2. **Clients → Rehearsal Client 2** — packet signed, letter status signed.
3. **My Tasks** — anything the journey generated.

---

## Summary of gaps you will hit, in order

| Step | Gap | Status |
|---|---|---|
| 3 | Guided tax interview has no UI — pick line items by hand | Item C, unbuilt |
| 4 | No decline/dispute path that holds the quote open | Item D, unbuilt |
| 5 | **Accepted quote may produce no visible consequence** | **Finding #17 — building next** |
| 6 | Stripe is in stub mode; checkout refuses in production | Waive the deposit, or install test keys |
| 12 | Portal-upload acknowledgement does not exist | Needs its own automation + template |
| 15 | Intake form not linked in portal nav; ES legal bodies unapproved | Small change / your approval |

Everything else on this path was verified working in production today.
