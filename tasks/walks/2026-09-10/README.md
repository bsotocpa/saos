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
