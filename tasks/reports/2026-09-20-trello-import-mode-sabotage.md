# trello-import-mode-sabotage (2026-09-20)

Generated 2026-09-20T02:53:08.857Z by scripts/report-table.mjs from the log import-mode-sabotage.log; 2 row(s).

Item b. THE SABOTAGE THAT MAKES THE ZERO MEAN SOMETHING. Both rows are the same measurement on the same copy minutes apart: a return carrying a fee, walked to filed through the real transitionStage, which runs invoiceForFiledEngagement, which enqueues invoice.send. Seven client-acting automations were armed on the copy (attachment_acks, efile_acknowledgment, payment_receipt, portal_upload_acks, refund_receipt, schedule_added_notice, void_notice) — the same seven armed on production — so nothing about this run was quiet by accident.

UNDER THE MODE: zero outbox rows, one audit row naming the effect and the import. WITH THE MODE OFF (--unsafe-no-import-mode, which the script refuses against any database whose name does not end in _copy): one outbox row, status pending, effect invoice.send, and nothing audited because nothing was refused. That row is the email a real client would have received about an invoice for a return we imported as already filed. The copy was dropped rather than drained.

WHERE THE CHECK LIVES. enqueueEffect in apps/api/src/outbox.ts, first thing, before the INSERT: isImportContext() reads an AsyncLocalStorage store that runInImportContext(label, fn) sets. Under it the row is NOT WRITTEN and one audit row is written instead (action outbox.refused_in_import, actor the import label, details naming the effect). Refusing at the DRAIN instead would leave a real pending row that any later drain on any container could perform, and the point is that the message does not exist.

WHY AMBIENT AND NOT A PARAMETER. The import walks records through the same doors a person uses, on purpose, and those doors enqueue four and five frames down (filed -> invoiceForFiledEngagement -> enqueueEffect). A suppressSends flag threaded down every chain would be exactly as reliable as the least careful function on it, and one that forgot to forward it is one client who gets an invoice. AsyncLocalStorage inverts that: a NEW client-facing effect added tomorrow is refused without anybody thinking about the import. The spec asserts that inversion directly — one test enqueues four frames deep, one enqueues every member of OUTBOX_EFFECTS rather than a list somebody maintained, and one proves the context does not leak out of its own async tree.

THE PROBES ARE SYNTHETIC AND SAY SO. They are the only place in the rehearsal where a gate is stamped, and they are stamped on a contact the script created, flagged is_test with a test_note naming the rehearsal. R16 forbids a fabricated letter, estimate, 8879 or PTIN stamp ON REAL RECORDS; a probe fixture on a database about to be dropped is not one, and the real import stamps nothing at all (0 imported returns carry any gate fact). The fee came from the price book (IND_BASE_SINGLE, 20000 cents in the book in force) because a price literal in application code is a build failure and a rehearsal script is application code.

THE REAL IMPORT ITSELF REFUSED ONE SEND, NOT FORTY-FOUR, and that is the finding rather than a shortfall: an honest import never attempts a client-facing send at all. setImportedStage moves the stage directly, so the filed hook that enqueues is never reached; createTask and the staff alerts are internal and are not gated. The one refusal is the probe. The mode is the seatbelt for the case where a future import does walk the pipeline, and the sabotage manifest scripts/sabotages/2026-09-20-e.mjs is how it stays fastened: the import-mode branch in enqueueEffect made unreachable turns apps/api/test/import-mode.spec.ts red.

```sql
TRELLO_IMPORT_DIR=/trello_import DATABASE_URL=postgresql://saos:***@postgres:5432/saos_trello_copy node --experimental-strip-types scripts/trello-import.ts --unsafe-no-import-mode   (run inside a THROWAWAY container built from the deployed saos-api image — never inside saos-api-1 — against saos_trello_copy, a fresh pg_dump of production carrying migrations 0105-0111. The scripts refuse any database whose name does not end in _copy. The copy was dropped and the bundle removed from the box at the end; production was read and never written.)
```

| measurement | import mode | outbox rows added | refusals audited | stage reached | what it means |
|---|---|---|---|---|---|
| one imported return carrying a fee, walked to filed | ON | 0 | 1 | filed | the client is told nothing, and the refusal is on the record |
| the same return, the same walk | OFF (--unsafe-no-import-mode) | 1 | 0 | filed | without the mode the invoice email is queued for real — which is what the zero above prevents |
