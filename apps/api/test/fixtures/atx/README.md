# ATX "E-Files" export — synthetic fixture (built 2026-09-20 from the shape of a real 500-row export)
Every name and identifier here is invented (identifiers start 900, which the SSA never issues). Header, column order, value vocabularies,
date format and quirks mirror the real export exactly.

Quirks the parser must handle
- There is NO tax-year column. ~86% of names end in a year ("LAST, FIRST 2025"); business names usually carry none. Never require it.
- SSN/EIN is 9 digits, sometimes prefixed with an apostrophe. Never persist or display the full value.
- Jurisdiction is "Federal" or a two-letter state. Type is the form ("1040", "IL 1040", "1120S", "IL 1120-ST", "1065", "IL 1065", "1120", "990", "990EZ", "4868", "7004", "8868", "CA 540NR"...).
- Sub Type: Federal | Return | Extension | Amended.
- Status: Accepted | AcceptedWithMessages (both = accepted) | Created | Held | TransmittedToAgency (pending, no action) | RejectedByAgency | RejectedByEfc | RejectedByUser.
- Status Date: M/D/YYYY h:mm:ss AM/PM, local (Central) time.
- The export is firm-wide. Most rows belong to returns SAOS is not tracking.
- File is UTF-8 with BOM; "Client #", "Complete" are empty.
