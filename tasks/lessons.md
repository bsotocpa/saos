# Lessons

Patterns captured after corrections from Brian, per CLAUDE.md's self-improvement
loop. Review at session start. Format: **Lesson** — what went wrong → the rule
that prevents it.

**Every UI milestone ships with phone-width screenshot verification**
(2026-08-09, mobile defect pass) — desktop-verified screens shipped with
page-level horizontal scroll at 390px, a filter rail rendering inline into
the content flow, and an overflowing nav; Brian had to phone-screenshot the
defects himself. → Rule: before any UI milestone is "done", browser-test
every affected screen at 390×844 — assert
`document.documentElement.scrollWidth <= clientWidth` per page, exercise the
phone-specific affordances (sheets, cards, scrollable tabs), and include the
390px screenshots in the report. Wide content scrolls inside its own
container; the page itself never scrolls horizontally.

**Match the tool being replaced, not the minimum viable screen** (2026-07-11,
M25 task UI) — I shipped thin v1 task views (basic list, kanban with move
dropdowns) for a system explicitly specced as a "full Trello replacement"
whose real benchmark was the firm's live Zoho CRM: dense sortable tables,
saved/shared views, a full filter rail, four view types, recurrence,
reminders, bulk ops. Brian rejected the v1 views ("the thin v1 views don't
ship") and had to supply screenshots to reset the bar. → Rule: when a module
REPLACES a tool the team uses daily, benchmark the build against that tool's
actual screens BEFORE building — ask for screenshots/exports of the live
system up front, and treat "replacement" in the spec as meaning feature
parity for the workflows in daily use, not a functional subset.
