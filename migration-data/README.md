# migration-data/ — client exports for the M22 migration

Drop the raw export files here:

- **Dubsado** — client/project export (CSV)
- **Zoho CRM** — full contact/account export (CSV)
- **Grant Tracker** — the spreadsheet (XLSX/CSV)

Everything in this folder is **git-ignored except this README** — these files
are real client PII and must never enter version control. The import
pipeline reads from here and flags every record with its source system.

Note: this repo lives in a Dropbox folder, so files placed here still sync
to Dropbox. These exports came from cloud systems you already control, but
if you'd rather keep them off Dropbox entirely, park them anywhere else and
point the importer at that path instead — it takes a directory argument.
