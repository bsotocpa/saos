# status-rene-role (2026-09-19)

Generated 2026-09-19T19:35:08.928Z by scripts/report-table.mjs from production; 10 row(s).

Where Rene's bookkeeping role is recorded: the permissions the comms_billing role holds on the box (roles.mjs seeds them; role_permissions carries them).

```sql
SELECT st.email, r.key AS role, rp.permission FROM staff st JOIN roles r ON r.id = st.role_id JOIN role_permissions rp ON rp.role_id = r.id WHERE st.email = 'rene@sotoaccounting.com' ORDER BY 3
```

| email | role | permission |
|---|---|---|
| rene@sotoaccounting.com | comms_billing | billing.manage |
| rene@sotoaccounting.com | comms_billing | bookkeeping.assigned.manage |
| rene@sotoaccounting.com | comms_billing | contacts.read |
| rene@sotoaccounting.com | comms_billing | contacts.write |
| rene@sotoaccounting.com | comms_billing | inbox.manage |
| rene@sotoaccounting.com | comms_billing | magic_links.manage |
| rene@sotoaccounting.com | comms_billing | pii.read |
| rene@sotoaccounting.com | comms_billing | tasks.manage |
| rene@sotoaccounting.com | comms_billing | tasks.read |
| rene@sotoaccounting.com | comms_billing | time.log |
