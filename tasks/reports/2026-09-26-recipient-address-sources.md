# recipient-address-sources (2026-09-26)

Generated 2026-09-26T21:25:37.215Z by scripts/report-table.mjs from the log recipients.log; 36 row(s).

R45 diagnosis (2026-09-26). Every client-facing send reads contacts.email except the magic link (portal-auth/service.ts:120), which reads portal_users.email, and the booking confirmation, which answers the address the Cal.com webhook carried. Read from the code by hand in this session; file:line are the call sites.

```sql
grep -rn 'sendTemplatedEmail(' apps/api/src --include=*.ts (35 call sites outside tests) and grep -rn 'enqueueEffect(' apps/api/src (7 sites; consumers in apps/api/src/outbox.ts), each traced back to the SQL that selected its email column
```

| send site (file:line) | what it sends | recipient expression | address column read | source table |
|---|---|---|---|---|
| apps/api/src/modules/billing/dunning.ts:136 | dunning reminder | inv.email | c.email (query at :96) | contacts |
| apps/api/src/modules/billing/refunds.ts:700 | refund receipt (outbox invoice.refund_receipt) | inv.email | c.email (:674) | contacts |
| apps/api/src/modules/billing/routes.ts:94 | invoice sent | inv.email | c.email (:81) | contacts |
| apps/api/src/modules/billing/routes.ts:150 | invoice resend / payment link | inv.email | c.email (:131) | contacts |
| apps/api/src/modules/billing/service.ts:228 | deposit / checkout mail | c.email | email (:70, FROM contacts) | contacts |
| apps/api/src/modules/billing/service.ts:288 | invoice send now (outbox invoice.send) | inv.email | c.email (:274) | contacts |
| apps/api/src/modules/billing/service.ts:498 | filed-return invoice | inv.email | c.email (:443) | contacts |
| apps/api/src/modules/billing/service.ts:582 | unpaid-invoice reminder | inv.email | c.email (:560) | contacts |
| apps/api/src/modules/billing/void.ts:203 | void notice (outbox invoice.void_notice) | inv.email | c.email (:177) | contacts |
| apps/api/src/modules/booking/routes.ts:247 | booking confirmation | email | attendee.email from the Cal.com webhook (:72); matched to contacts by email (:89) | webhook payload (not a stored column) |
| apps/api/src/modules/bookkeeping/close.ts:217 | close-cycle notice | c.email | email (:212, FROM contacts) | contacts |
| apps/api/src/modules/comms/review-requests.ts:126 | review request | c.email | email (:122, FROM contacts) | contacts |
| apps/api/src/modules/comms/routes.ts:343 | attachment-received reply | c.email | email (:327, FROM contacts matched by inbound sender) | contacts |
| apps/api/src/modules/documents/service.ts:216 | document received / scan result | c.email | email (:210, FROM contacts) | contacts |
| apps/api/src/modules/documents/service.ts:551 | document request complete | te.email | c.email (:533) | contacts |
| apps/api/src/modules/documents/service.ts:609 | document request chase | r.email | c.email (:597) | contacts |
| apps/api/src/modules/engagements/packet.ts:573 | packet signature link (outbox packet.send_signature_link) | p.email | c.email (:553) | contacts |
| apps/api/src/modules/engagements/schedule-notice.ts:81 | added-schedule notice (outbox schedule.added_notice) | contact.email | email (:75, FROM contacts) | contacts |
| apps/api/src/modules/entity/service.ts:401 | annual report reminder | r.email | c.email (:281) | contacts |
| apps/api/src/modules/entity/sos.ts:251 | SOS status change | biz.email | c.email of the primary member (:147) | contacts |
| apps/api/src/modules/meetings/recaps.ts:336 | meeting recap | r.email | c.email (:264) | contacts |
| apps/api/src/modules/portal-auth/service.ts:120 | magic link: portal invite and sign-in | user.email | u.email (:97, FROM portal_users) | portal_users (the only site) |
| apps/api/src/modules/pricing/quotes.ts:497 | quote sent | c.email | email (:486, FROM contacts) | contacts |
| apps/api/src/modules/pricing/quotes.ts:580 | quote reminder / re-send | c.email | email (:570, FROM contacts) | contacts |
| apps/api/src/modules/referrals/service.ts:196 | referral thank-you | r.email | c.email (:133) | contacts |
| apps/api/src/modules/referrals/service.ts:211 | referral credit notice | r.email | c.email (:133) | contacts |
| apps/api/src/modules/tasks/service.ts:752 | escalation ladder portal reminder | t.email | c.email (:707) | contacts |
| apps/api/src/modules/tasks/service.ts:765 | escalation ladder portal reminder (second rung) | t.email | c.email (:707) | contacts |
| apps/api/src/modules/tax/efile-ack.ts:494 | e-file acceptance / rejection notice (outbox efile.ack_notice) | a.email | c.email (:467) | contacts |
| apps/api/src/modules/tax/extension-batch.ts:139 | extension batch notice | te.email | c.email (:87) | contacts |
| apps/api/src/modules/tax/extension.ts:201 | extension filed notice | te.email | c.email (:172-175 JOIN contacts) | contacts |
| apps/api/src/modules/tax/extension.ts:237 | extension payment estimate | te.email | c.email (:172-175 JOIN contacts) | contacts |
| apps/api/src/modules/tax/extension.ts:370 | extension deadline reminder | r.email | c.email (:349) | contacts |
| apps/api/src/modules/tax/extension.ts:521 | season notice to affected clients | c.email | c.email (:512) | contacts |
| apps/api/src/modules/tax/routes.ts:753 | return-stage notice | c.email | email (:745, FROM contacts) | contacts |
| enqueueEffect consumers (apps/api/src/outbox.ts:247-305) | invoice.send, invoice.refund_receipt, invoice.void_notice, efile.ack_notice, schedule.added_notice, packet.send_signature_link | resolved by the rows above | contacts.email at every consumer | contacts |
