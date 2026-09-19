# form-error-handlers (2026-09-19)

Generated 2026-09-19T19:36:38.611Z by scripts/report-table.mjs from the log handlers.log; 194 row(s).

Every api() call site in Ops and the portal with how its refusal renders: run (inside the modal), inline (field-error beside the control), load (a page-level navigation result). The survey of 2026-09-19 counted 122 handlers that could fail; this inventory is generated from the code, so it also lists loads and lookups.

```sql
node scripts/check-inline-errors.mjs --inventory
```

| file:line | handler | evidence |
|---|---|---|
| apps/internal/app/account/page.tsx:42 | submit | inline (field-error beside the control) |
| apps/internal/app/admin/automations/page.tsx:39 | load | inline (field-error beside the control) |
| apps/internal/app/admin/automations/page.tsx:64 | armed | run (the modal keeps the refusal beside its field) |
| apps/internal/app/admin/automations/page.tsx:80 | armed | load (page-level; a navigation result) |
| apps/internal/app/admin/pricing/page.tsx:78 | errAt | inline (field-error beside the control) |
| apps/internal/app/admin/pricing/page.tsx:109 | confirmItem | load (page-level; a navigation result) |
| apps/internal/app/admin/pricing/page.tsx:347 | onChange | inline (field-error beside the control) |
| apps/internal/app/admin/settings/page.tsx:20 | load | inline (field-error beside the control) |
| apps/internal/app/admin/settings/page.tsx:38 | raw | inline (field-error beside the control) |
| apps/internal/app/admin/staff/page.tsx:54 | load | inline (field-error beside the control) |
| apps/internal/app/admin/staff/page.tsx:55 | load | inline (field-error beside the control) |
| apps/internal/app/admin/staff/page.tsx:96 | saveEdit | load (page-level; a navigation result) |
| apps/internal/app/admin/staff/page.tsx:167 | next | inline (field-error beside the control) |
| apps/internal/app/admin/staff/page.tsx:199 | go | run (the modal keeps the refusal beside its field) |
| apps/internal/app/admin/staff/page.tsx:218 | go | inline (field-error beside the control) |
| apps/internal/app/admin/staff/page.tsx:267 | whose | inline (field-error beside the control) |
| apps/internal/app/admin/templates/page.tsx:72 | load | inline (field-error beside the control) |
| apps/internal/app/admin/templates/page.tsx:129 | a | run (the modal keeps the refusal beside its field) |
| apps/internal/app/admin/wisp/page.tsx:42 | WispPage | load (page-level; a navigation result) |
| apps/internal/app/alerts/page.tsx:25 | markRead | inline (field-error beside the control) |
| apps/internal/app/alerts/page.tsx:33 | load | inline (field-error beside the control) |
| apps/internal/app/announcements/page.tsx:76 | load | load (page-level; a navigation result) |
| apps/internal/app/announcements/page.tsx:93 | runPreview | load (page-level; a navigation result) |
| apps/internal/app/announcements/page.tsx:103 | act | load (page-level; a navigation result) |
| apps/internal/app/announcements/page.tsx:116 | create | load (page-level; a navigation result) |
| apps/internal/app/approvals/page.tsx:51 | load | inline (field-error beside the control) |
| apps/internal/app/approvals/page.tsx:151 | onChange | inline (field-error beside the control) |
| apps/internal/app/approvals/page.tsx:188 | onClick | unclassified |
| apps/internal/app/approvals/page.tsx:214 | onClick | inline (field-error beside the control) |
| apps/internal/app/clients/page.tsx:57 | params | load (page-level; a navigation result) |
| apps/internal/app/clients/[id]/page.tsx:247 | load | inline (field-error beside the control) |
| apps/internal/app/clients/[id]/page.tsx:251 | p | inline (field-error beside the control) |
| apps/internal/app/clients/[id]/page.tsx:254 | p | inline (field-error beside the control) |
| apps/internal/app/clients/[id]/page.tsx:257 | p | inline (field-error beside the control) |
| apps/internal/app/clients/[id]/page.tsx:260 | p | load (page-level; a navigation result) |
| apps/internal/app/clients/[id]/page.tsx:263 | p | load (page-level; a navigation result) |
| apps/internal/app/clients/[id]/page.tsx:266 | p | load (page-level; a navigation result) |
| apps/internal/app/clients/[id]/page.tsx:269 | p | load (page-level; a navigation result) |
| apps/internal/app/clients/[id]/page.tsx:272 | p | unclassified |
| apps/internal/app/clients/[id]/page.tsx:278 | p | unclassified |
| apps/internal/app/clients/[id]/page.tsx:309 | runEngagementAction | load (page-level; a navigation result) |
| apps/internal/app/clients/[id]/page.tsx:482 | body | inline (field-error beside the control) |
| apps/internal/app/clients/[id]/page.tsx:571 | ok | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:634 | onClick | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:649 | onClick | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:669 | a | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:745 | a | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:808 | onClick | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:824 | onClick | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:943 | a | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:991 | onClick | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:1002 | a | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:1027 | first0 | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:1189 |  | load (page-level; a navigation result) |
| apps/internal/app/clients/[id]/page.tsx:1219 | onClick | inline (field-error beside the control) |
| apps/internal/app/clients/[id]/page.tsx:1246 | a | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:1275 | a | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:1302 | a | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:1331 | a | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:1363 | a | run (the modal keeps the refusal beside its field) |
| apps/internal/app/clients/[id]/page.tsx:1428 | onChange | inline (field-error beside the control) |
| apps/internal/app/clients/[id]/page.tsx:1507 | onClick | load (page-level; a navigation result) |
| apps/internal/app/clients/[id]/page.tsx:1522 | onClick | load (page-level; a navigation result) |
| apps/internal/app/configurator/page.tsx:95 | handle | inline (field-error beside the control) |
| apps/internal/app/configurator/page.tsx:109 | pick | load (page-level; a navigation result) |
| apps/internal/app/configurator/page.tsx:110 | pick | load (page-level; a navigation result) |
| apps/internal/app/documents/page.tsx:106 | q | load (page-level; a navigation result) |
| apps/internal/app/efile-acks/page.tsx:51 | loadList | inline (field-error beside the control) |
| apps/internal/app/efile-acks/page.tsx:55 | loadReport | inline (field-error beside the control) |
| apps/internal/app/efile-acks/page.tsx:86 | hold | unclassified |
| apps/internal/app/efile-acks/page.tsx:111 | a | run (the modal keeps the refusal beside its field) |
| apps/internal/app/events/page.tsx:56 | load | inline (field-error beside the control) |
| apps/internal/app/events/page.tsx:68 | openEvent | inline (field-error beside the control) |
| apps/internal/app/events/page.tsx:69 | openEvent | inline (field-error beside the control) |
| apps/internal/app/events/page.tsx:117 | act | inline (field-error beside the control) |
| apps/internal/app/events/page.tsx:169 | onClick | inline (field-error beside the control) |
| apps/internal/app/events/page.tsx:212 |  | inline (field-error beside the control) |
| apps/internal/app/hilo/page.tsx:35 | router | load (page-level; a navigation result) |
| apps/internal/app/inbox/page.tsx:52 | load | inline (field-error beside the control) |
| apps/internal/app/inbox/page.tsx:72 | cat | load (page-level; a navigation result) |
| apps/internal/app/inbox/page.tsx:82 | discard | load (page-level; a navigation result) |
| apps/internal/app/inbox/page.tsx:100 | reassign | load (page-level; a navigation result) |
| apps/internal/app/login/page.tsx:31 | login | inline (field-error beside the control) |
| apps/internal/app/login/page.tsx:41 | res | inline (field-error beside the control) |
| apps/internal/app/login/page.tsx:60 | verifyEnrollment | unclassified |
| apps/internal/app/page.tsx:108 | router | load (page-level; a navigation result) |
| apps/internal/app/page.tsx:109 | router | load (page-level; a navigation result) |
| apps/internal/app/page.tsx:110 | router | load (page-level; a navigation result) |
| apps/internal/app/pipeline/page.tsx:190 | load | load (page-level; a navigation result) |
| apps/internal/app/pipeline/page.tsx:191 | load | load (page-level; a navigation result) |
| apps/internal/app/pipeline/page.tsx:202 | load | load (page-level; a navigation result) |
| apps/internal/app/pipeline/page.tsx:223 | handle | load (page-level; a navigation result) |
| apps/internal/app/pipeline/page.tsx:238 | handle | load (page-level; a navigation result) |
| apps/internal/app/pipeline/page.tsx:301 | refreshDraftDeposit | unclassified |
| apps/internal/app/pipeline/page.tsx:322 | depositWordsFor | unclassified |
| apps/internal/app/pipeline/page.tsx:347 | parsed | unclassified |
| apps/internal/app/pipeline/page.tsx:398 | words | load (page-level; a navigation result) |
| apps/internal/app/pipeline/page.tsx:423 | words | load (page-level; a navigation result) |
| apps/internal/app/pipeline/page.tsx:446 | words | load (page-level; a navigation result) |
| apps/internal/app/pipeline/page.tsx:474 | buildAndSend | load (page-level; a navigation result) |
| apps/internal/app/pipeline/page.tsx:492 | words | load (page-level; a navigation result) |
| apps/internal/app/recorder/page.tsx:34 | findContacts | inline (field-error beside the control) |
| apps/internal/app/recorder/page.tsx:51 | fd | unclassified |
| apps/internal/app/reports/page.tsx:63 | errAt | inline (field-error beside the control) |
| apps/internal/app/reports/page.tsx:64 | errAt | inline (field-error beside the control) |
| apps/internal/app/reports/page.tsx:82 | load | load (page-level; a navigation result) |
| apps/internal/app/reports/page.tsx:104 | next | load (page-level; a navigation result) |
| apps/internal/app/sops/page.tsx:114 | load | inline (field-error beside the control) |
| apps/internal/app/sops/page.tsx:128 | r | inline (field-error beside the control) |
| apps/internal/app/tasks/boards/page.tsx:31 | loadBoards | inline (field-error beside the control) |
| apps/internal/app/tasks/boards/page.tsx:38 | loadBoard | inline (field-error beside the control) |
| apps/internal/app/tasks/boards/page.tsx:58 | move | load (page-level; a navigation result) |
| apps/internal/app/tasks/boards/page.tsx:69 | createBoard | load (page-level; a navigation result) |
| apps/internal/app/tasks/boards/page.tsx:82 | first | unclassified |
| apps/internal/app/tasks/page.tsx:124 | isPhone | inline (field-error beside the control) |
| apps/internal/app/tasks/page.tsx:125 | isPhone | inline (field-error beside the control) |
| apps/internal/app/tasks/page.tsx:126 | isPhone | inline (field-error beside the control) |
| apps/internal/app/tasks/page.tsx:127 | isPhone | inline (field-error beside the control) |
| apps/internal/app/tasks/page.tsx:144 | load | load (page-level; a navigation result) |
| apps/internal/app/tasks/page.tsx:148 | r | load (page-level; a navigation result) |
| apps/internal/app/tasks/page.tsx:190 | a | run (the modal keeps the refusal beside its field) |
| apps/internal/app/tasks/page.tsx:198 | a | run (the modal keeps the refusal beside its field) |
| apps/internal/app/tasks/page.tsx:208 | deleteView | unclassified |
| apps/internal/app/tasks/page.tsx:222 | setStatus | unclassified |
| apps/internal/app/tasks/page.tsx:233 | field | load (page-level; a navigation result) |
| apps/internal/app/tasks/page.tsx:242 | duplicate | load (page-level; a navigation result) |
| apps/internal/app/tasks/page.tsx:251 | followUp | load (page-level; a navigation result) |
| apps/internal/app/tasks/page.tsx:268 | bulk | load (page-level; a navigation result) |
| apps/internal/app/tasks/page.tsx:1193 | WorkloadTable | load (page-level; a navigation result) |
| apps/internal/app/tasks/task-form.tsx:174 | load | inline (field-error beside the control) |
| apps/internal/app/tasks/task-form.tsx:184 | add | inline (field-error beside the control) |
| apps/internal/app/tasks/task-form.tsx:194 | remove | inline (field-error beside the control) |
| apps/internal/app/tasks/task-form.tsx:220 | remove | inline (field-error beside the control) |
| apps/internal/app/tasks/task-form.tsx:285 | remindAtIso | unclassified |
| apps/internal/app/tasks/task-form.tsx:303 | remindAtIso | unclassified |
| apps/internal/app/tasks/task-form.tsx:306 | remindAtIso | unclassified |
| apps/internal/app/upload-return/page.tsx:32 | findContacts | inline (field-error beside the control) |
| apps/internal/app/upload-return/page.tsx:43 | pickContact | inline (field-error beside the control) |
| apps/internal/app/upload-return/page.tsx:70 | fd | unclassified |
| apps/internal/components/add-business.tsx:63 | submit | inline (field-error beside the control) |
| apps/portal/app/auth/verify/page.tsx:23 | token | load (page-level; a navigation result) |
| apps/portal/app/consent/page.tsx:43 | load | load (page-level; a navigation result) |
| apps/portal/app/consent/page.tsx:65 | offer | load (page-level; a navigation result) |
| apps/portal/app/documents/page.tsx:34 | load | load (page-level; a navigation result) |
| apps/portal/app/documents/page.tsx:35 | load | load (page-level; a navigation result) |
| apps/portal/app/documents/page.tsx:57 | fd | load (page-level; a navigation result) |
| apps/portal/app/documents/page.tsx:190 | r | run (the modal keeps the refusal beside its field) |
| apps/portal/app/estimate/page.tsx:89 | onChange | inline (field-error beside the control) |
| apps/portal/app/events/[slug]/page.tsx:54 | load | load (page-level; a navigation result) |
| apps/portal/app/intake/[key]/page.tsx:144 | optLabel | load (page-level; a navigation result) |
| apps/portal/app/intake/[key]/page.tsx:223 | saveScreen | unclassified |
| apps/portal/app/intake/[key]/page.tsx:259 | found | unclassified |
| apps/portal/app/invoices/page.tsx:38 | load | load (page-level; a navigation result) |
| apps/portal/app/invoices/page.tsx:78 | ask | load (page-level; a navigation result) |
| apps/portal/app/invoices/page.tsx:103 | pay | load (page-level; a navigation result) |
| apps/portal/app/login/page.tsx:28 | LoginPage | inline (field-error beside the control) |
| apps/portal/app/messages/page.tsx:50 | load | load (page-level; a navigation result) |
| apps/portal/app/messages/page.tsx:72 | form | load (page-level; a navigation result) |
| apps/portal/app/messages/page.tsx:75 | form | load (page-level; a navigation result) |
| apps/portal/app/notices/page.tsx:39 | NoticesPage | load (page-level; a navigation result) |
| apps/portal/app/page.tsx:209 | useEffect | load (page-level; a navigation result) |
| apps/portal/app/page.tsx:210 | useEffect | unclassified |
| apps/portal/app/page.tsx:213 | useEffect | unclassified |
| apps/portal/app/page.tsx:214 | useEffect | unclassified |
| apps/portal/app/page.tsx:217 | useEffect | unclassified |
| apps/portal/app/page.tsx:224 | useEffect | unclassified |
| apps/portal/app/page.tsx:227 |  | unclassified |
| apps/portal/app/page.tsx:230 |  | unclassified |
| apps/portal/app/page.tsx:239 | markStep | unclassified |
| apps/portal/app/page.tsx:240 | markStep | unclassified |
| apps/portal/app/pay/[token]/page.tsx:33 | load | load (page-level; a navigation result) |
| apps/portal/app/pay/[token]/page.tsx:54 | paidReturn | load (page-level; a navigation result) |
| apps/portal/app/pay/[token]/page.tsx:72 | pay | load (page-level; a navigation result) |
| apps/portal/app/profile/page.tsx:61 | set | unclassified |
| apps/portal/app/profile/page.tsx:70 | set | unclassified |
| apps/portal/app/profile/page.tsx:147 | prev | inline (field-error beside the control) |
| apps/portal/app/profile/page.tsx:185 | onClick | inline (field-error beside the control) |
| apps/portal/app/questionnaire/page.tsx:177 | save | load (page-level; a navigation result) |
| apps/portal/app/questionnaire/page.tsx:212 | pref | unclassified |
| apps/portal/app/questionnaire/page.tsx:223 | submit | unclassified |
| apps/portal/app/questionnaire/page.tsx:228 | submit | unclassified |
| apps/portal/app/quote/[token]/page.tsx:127 | accept | load (page-level; a navigation result) |
| apps/portal/app/quote/[token]/page.tsx:161 | decline | unclassified |
| apps/portal/app/request-service/page.tsx:34 | RequestServicePage | unclassified |
| apps/portal/app/resources/page.tsx:18 | ResourcesPage | load (page-level; a navigation result) |
| apps/portal/app/returns/page.tsx:20 | ReturnsPage | load (page-level; a navigation result) |
| apps/portal/app/sign/page.tsx:77 | load | load (page-level; a navigation result) |
| apps/portal/app/sign/page.tsx:78 | load | load (page-level; a navigation result) |
| apps/portal/app/sign/page.tsx:79 | load | load (page-level; a navigation result) |
| apps/portal/app/sign/page.tsx:86 | load | load (page-level; a navigation result) |
| apps/portal/app/sign/page.tsx:106 | signPacket | load (page-level; a navigation result) |
| apps/portal/app/sign/page.tsx:137 | acceptSchedule | load (page-level; a navigation result) |
| apps/portal/app/sms-optin.tsx:39 | submit | inline (field-error beside the control) |
| apps/portal/app/unsubscribe/[id]/[token]/page.tsx:21 | params | load (page-level; a navigation result) |
