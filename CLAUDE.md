# CLAUDE.md — SAOS Build (Soto Accounting Operating System)

## Source of Truth
- `SAOS_Fable_Master_Prompt_v4.6.md` and `SAOS_Onboarding_Forms_Spec_v4.6.md` are the spec (all addendum sections are equal in authority to the main body). The Zoho reference screenshots in docs/reference/ are the UI benchmark for the task system — match their density and capability, not the thin v1 views.
- **Task dependencies are first-class**: tasks support "blocked by"; blocked tasks are visually distinct and cannot complete before their blockers; completing a blocker cascades unblock notifications. Resolution engagements auto-chain oldest-year-first.
- **Bundles compose from the price book only** — a bundle is price_book items + discount rules + optional components; no ad-hoc prices inside bundles. The prior-year surcharge (+$100/return, years >2 back) applies automatically wherever a prior-year return is quoted, bundled or not.
- **Prior-year returns derive their filing method from the year**: current + 2 prior → e-file/KBA lane; older → paper lane with wet signature and certified-mail tracking. Never route an old year to e-file. When code and spec conflict, the spec wins. When the spec is ambiguous, ask Brian — do not invent requirements.
- Build in phase order (Phase 1 → 5 per the roadmap). Do not start a later-phase feature to avoid a hard problem in the current phase.

## Workflow Orchestration
### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep the main context window clean
- Offload research, exploration, and parallel analysis to subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from Brian: update `tasks/lessons.md` with the pattern
- Write rules that prevent the same mistake; review lessons at session start

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Run tests, check logs, demonstrate correctness
- Ask: "Would a staff engineer approve this?"

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- Skip this for simple, obvious fixes — don't over-engineer

### 6. Autonomous Bug Fixing
- Given a bug report: just fix it. Point at logs, errors, failing tests — resolve them. Zero context switching required from Brian.

## Task Management
1. **Plan First**: write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: check in with Brian before starting implementation
3. **Track Progress**: mark items complete as you go
4. **Explain Changes**: high-level summary at each step
5. **Document Results**: add review section to `tasks/todo.md`
6. **Capture Lessons**: update `tasks/lessons.md` after corrections

## SAOS-Specific Hard Rules (non-negotiable)
### Compliance
- **Placeholder gate**: any document template flagged `PLACEHOLDER` (§7216 consent, engagement letters) must be blocked from sending to any production client. This gate is enforced in code, not convention. Never remove it.
- **8879 signatures** (ruling 2026-09-12): the remote e-sign path is retired — no KBA vendor, no Docuseal template. Form 8879 is wet-signed in office, scanned, and uploaded to the return as a Signed Authorization with the signed date and the PTIN holder recorded. That upload is what authorizes the return; nothing else may stamp it, and the filed gate checks for the document, not a timestamp.
- **Audit logging**: every document access, download, and permission change is logged. No feature ships that touches client documents without audit coverage.
- **Documents never travel by SMS or email attachment** — portal upload links only.

### Data & Vendors
- **Approved external vendors ONLY**: Stripe, Twilio, Amazon SES (relay), KBA API. Do not add a dependency that sends client data to any other third party — no analytics SDKs, no error-tracking SaaS, no CDN-hosted fonts on portal pages. If a library phones home, find another library.
- **No PII in logs**: no SSNs, EINs, DOBs, or document contents in application logs, error messages, or test fixtures. Use synthetic data for all tests.
- All storage self-hosted: PostgreSQL + MinIO. Backups to B2, encrypted.

### Stack Constraints
- Docker Compose on a single Hetzner CPX41 (16GB). Budget memory accordingly — Whisper and Ollama share the box with everything else. If a service needs more, flag it; don't silently degrade.
- Extended tax deadlines derive from return type + fiscal year end (1065/1120-S → Sep 15, 1040/1120 → Oct 15, 990 → Nov 15, fiscal-year → +6 months). Never a hardcoded date swap.
- Grant 1099 export defaults to **1099-MISC Box 3**, configurable per cycle. Never 1099-NEC.
- **No hardcoded prices, anywhere.** Every dollar amount comes from the versioned price_book table (effective-dated); engagements carry price-lock fields. A price appearing as a literal in application code is a build failure.
- **Attest independence check**: the system blocks creating a CPA review/audit engagement for any client with active Soto bookkeeping/payroll/management services, absent Brian's documented override.
- **S corp session floor**: the engagement configurator must not allow an active S corp client below 2 CPA sessions/year.
- **All tax deadlines derive from the AUTHORITATIVE TAX DEADLINE TABLE** (v4.3 addendum) + fiscal year end. 990 original is May 15, extended Nov 15. Any hardcoded date pair is a build failure.
- **No dead-end engagement states**: Filed is not terminal until e-file acceptance; rejects re-queue with perfection-period clocks; notices create owned tickets. Every waiting state has the D3/D7/D14/D30 escalation ladder attached.
- **Late fees are engagement-letter gated**: never apply a late fee unless the client's signed engagement letter contains the late-fee disclosure. Rate lives in the price book, never in code.
- **Calendar cross-check before scheduling**: never create a session-scheduling task without first checking for an existing recurring session with that client. Attach to existing sessions; only create tasks when none exists.
- **Grant vouchering is status-tracking only** — the system never generates voucher files; Brian operates the work outside the system.
- **Every work item in every module IS a task object in the unified task system** — no module-local to-do lists, ever. Escalation calls, notice tickets, scheduling tasks, voucher reminders, annual-report tasks, preparer queue items: all the same task table, all visible in My Tasks and the owner rollup.
- **Quotes come from the price book** — the quote builder composes from price_book entries; a quote converts to an engagement + deposit checkout without re-entry.
- **Broadcast messages require unsubscribe compliance**: every announcement email carries CAN-SPAM unsubscribe; every broadcast SMS respects TCPA opt-out; suppression lists enforced at send time, approval-gated, never auto-sent.
- **Tasks link to SOPs**: task types carry an optional "how to do this" link into the knowledge base; building a task-generating feature without its SOP hook is incomplete.

### Brand & Copy
- Soto: Forest Teal `#0D3B38` primary, Electric Teal `#00C9BF` accent, "SOTO." wordmark in Inter 800 with Electric Teal period. Inter across UI.
- Hilo: per Hilo Brand Guidelines (GT Ultra, Deep Navy/Off-White/Burgundy/Burnt Orange, thread motif).
- All Soto client-facing copy ships in English AND Spanish. Client copy treats the reader as a capable professional — never someone being rescued.
- All templates admin-editable; copy changes must never require a code deploy.

## Core Principles
- **Simplicity First**: make every change as simple as possible. Impact minimal code.
- **No Laziness**: find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: only touch what's necessary. No side effects, no new bugs.
- **Sequence discipline**: finish the current phase's checklist before proposing the next. Brian sequences deliberately — don't parallelize open tracks without asking.
- **Client-acting automations ship OFF**: every automation that sends to a client (ladders, dunning, extension notices, late fees, chases, acks) is registered in the `automations` table, gated by `isAutomationEnabled()`, and seeded `enabled = false`. Brian arms each one in Admin → Automations as real clients reach the portal. A client-facing send without a registered toggle + gate check is a build failure. Internal alerts/tasks are never gated — only the outbound client message, and every suppression is counted in the job's run record.
