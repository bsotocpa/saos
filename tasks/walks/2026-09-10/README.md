# Walk failures, 2026-09-10

Screenshots the rendered-output harness (apps/e2e) wrote when a run went red. Passing runs keep
their screenshots locally under apps/e2e/.artifacts/<date>/ for 14 days; only failures are committed.

## client-page-phone.png, client-page-desk.png — deliberate sabotage of the harness

Brian's ruling (2026-09-10): "put the raw enum back on one badge on the Ops client page → run red".
The engagement status badge on the Ops client page was changed from `engagementStatusLabel(e.status)`
to `e.status`. Both viewports failed on the same assertion:

    Error: no raw enum on a badge
    Expected: []
    Received: ["active", "on_hold"]

The label was restored and the harness then passed five consecutive runs.

## Page two's own sabotage (portal Invoices, EN/ES)

`inv_refunded` was left untranslated — `['Refunded', 'Refunded']` — so the Spanish page carried
an English word among Spanish ones. Both viewports went red on "es: the refunded invoice". The
screenshots are not committed: they were taken, read, and the finding was the point. What the
run did prove is that the picture now matches the failure. The first version of page two shot
the screen only after the English assertions passed, so a Spanish failure kept the English
screenshot and showed a page that was fine. It shoots first, then asserts.

## A finding page two turned up on page one

With a portal account granted and signed in, the Ops client page's portal-access badge read
`active` — the enum word, lowercase, inches from an engagement badge reading `Active` that
means something else entirely. Audit item 11 gave every other badge a word and missed this one,
because its label map returned the enum spelled out rather than falling through to a default.
The four portal states now read No access, Invited, Signed up, Revoked.
