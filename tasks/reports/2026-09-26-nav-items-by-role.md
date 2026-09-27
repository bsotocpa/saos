# nav-items-by-role (2026-09-26)

Generated 2026-09-27T04:41:37.293Z by scripts/report-table.mjs from the log nav-items-by-role.log; 10 row(s).

R64 (2026-09-26) for the R42 Design Phase 1 record: how many top-navigation items each seeded role's session sees and which. Before R64 every session saw all 25. The shell filters by GET /auth/me permissions; each item's permission is read from the page's own guard (nav.ts names the door). SOPs, Alerts and Account open for every staff session. The apps/e2e ops-preparer-day spec asserts the tax_preparer row against the live navigation.

```sql
node scripts/nav-items-by-role.mjs  (the seeded grants in packages/db/seeds/data/roles.mjs joined with the shell's navigation table apps/internal/lib/nav.ts through visibleNav, the function the shell renders)
```

| role | items shown | item names |
|---|---|---|
| ceo | 25 | Executive, Clients, Documents, My Tasks, My Queue, E-file acks, Inbox, Pipeline, Reports, Configurator, Approvals, Announcements, SOPs, Events, Hilo Ops, Alerts, Deliver Return, Recorder, Automations, Pricing, Templates, Staff, Settings, WISP, Account |
| ed_coo | 11 | Clients, Documents, My Tasks, My Queue, Pipeline, SOPs, Events, Hilo Ops, Alerts, Recorder, Account |
| tax_preparer | 11 | Clients, Documents, My Tasks, My Queue, E-file acks, Pipeline, SOPs, Alerts, Deliver Return, Recorder, Account |
| va_entity | 7 | Clients, Documents, My Tasks, SOPs, Alerts, Deliver Return, Account |
| auditor | 3 | SOPs, Alerts, Account |
| comms_billing | 7 | Clients, My Tasks, Inbox, Announcements, SOPs, Alerts, Account |
| bookkeeper | 7 | Clients, Documents, My Tasks, SOPs, Alerts, Deliver Return, Account |
| intern | 4 | My Tasks, SOPs, Alerts, Account |
| client_success | 7 | Clients, My Tasks, Inbox, Announcements, SOPs, Alerts, Account |
| advisory_manager | 7 | Clients, My Tasks, My Queue, Pipeline, SOPs, Alerts, Account |
