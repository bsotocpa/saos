# duplicate-scan-notes (2026-09-13)

Generated 2026-09-13T01:36:52.858Z by scripts/report-table.mjs from production; 107 row(s).

Contacts the duplicate scan noted as a possible duplicate with no shared identifier.

```sql
SELECT first_name || ' ' || last_name AS name, left(id::text, 8) AS record, source::text AS source FROM contacts WHERE notes LIKE '%Possible duplicate%' ORDER BY 1, 2
```

| name | record | source |
|---|---|---|
| Aaron Covert | 13e49a59 | dubsado |
| Aaron Covert | a449dba6 | dubsado |
| Abdon Loera | 09c12a3a | dubsado |
| Abdon LOERA | e6715ef3 | zoho |
| Adrian Camacho | 64b5f33e | dubsado |
| Adrian Camacho | 8e95d3bc | dubsado |
| Aleen Olivares | 04b3cd15 | dubsado |
| Aleen Olivares | 197021ef | zoho |
| Aleen Olivares | a55c224a | dubsado |
| Aleen Olivares | b1c814d9 | dubsado |
| Alexander Ginsberg | 42d3e35d | dubsado |
| Alexander Ginsberg | 609988dd | dubsado |
| Alexander Ginsberg | 92d990de | dubsado |
| Alma Blancarte | 0495f822 | dubsado |
| Alma Blancarte | 659d26c9 | dubsado |
| Alma Blancarte | 8ada44c4 | dubsado |
| Angelika Charczuk | 9b7e01a1 | dubsado |
| Angelika Charczuk | f6ff2c08 | dubsado |
| Boris Buchancow | 92cf5d49 | zoho |
| Boris Buchancow | ea2b1eb7 | zoho |
| Christopher Cole | 2bc3da19 | zoho |
| Christopher Cole | 5cb2f9af | zoho |
| Cinthia Lopez | 861ec748 | dubsado |
| Cinthia Lopez | 93926a86 | dubsado |
| Cristobal Mora | f86f95b6 | zoho |
| Delilah Martinez | 0e6d1a09 | dubsado |
| Delilah Martinez | 6ebbe1d5 | zoho |
| Eber Figueroa | 5901a49d | zoho |
| Eber Figueroa | 7141b53b | zoho |
| Gerod Carfantan | 21362b2c | dubsado |
| Gerod Carfantan | 30215b8f | dubsado |
| Guillermo Duarte | 0a0bce62 | dubsado |
| Guillermo Duarte | bfa38a7d | dubsado |
| Hanna Kazakevich | 7a590d8c | zoho |
| Hanna Kazakevich | a67d1108 | dubsado |
| Hector Diaz | df238e87 | dubsado |
| ivan ramos | 026fbf4f | dubsado |
| Ivan Ramos | e77eaea5 | dubsado |
| Jacqueline Foster | 855f07cd | dubsado |
| Jacqueline Foster | f17a64d0 | dubsado |
| Jessica Carlos | 870845f1 | zoho |
| Jessica Carlos | 881e5182 | dubsado |
| Jhoanmy Luque Leon | 12b82f0f | dubsado |
| Jhoanmy Luque Leon | f5600888 | zoho |
| John Avila | aac667bb | dubsado |
| Jordan Stauder | 4be82c12 | dubsado |
| Jordan Stauder | c367097e | dubsado |
| Josean Irizarry | 224346a2 | dubsado |
| Josean Irizarry | 66300bc1 | dubsado |
| Josean Irizarry | 7497cc21 | dubsado |
| Joshua Woodard | 27c6e66d | zoho |
| Joshua Woodard | 8195d59d | dubsado |
| Julia Lopez | 0f6d361a | dubsado |
| Julia Lopez | 13ae96d0 | dubsado |
| Karina Guzman | fcd914a2 | dubsado |
| KARINA GUZMAN | 0acccfdf | dubsado |
| Katherine Bosch | 4688148e | dubsado |
| Katherine Bosch | 54eace4c | dubsado |
| Kevin Canchola | 519d315a | dubsado |
| Kevin Canchola | d5465aa7 | dubsado |
| Lizet Alba | 7ebafcb0 | zoho |
| Lizet Alba | 8dfafe91 | zoho |
| Marco Bautista | 9fdbad4c | dubsado |
| Marco Bautista | 9ff2ddc8 | dubsado |
| Nina Martinez | 2843c513 | dubsado |
| Nina Martinez | 2bcaed66 | zoho |
| Noelle Dela Cruz | 0ef5d236 | dubsado |
| Noelle Dela Cruz | 1e965660 | dubsado |
| oscar martinez | 3f9b3a5c | dubsado |
| Oscar Martinez | c57015f9 | dubsado |
| Oscar Salinas | 00004208 | dubsado |
| Oscar Salinas | 713fef76 | dubsado |
| Oscar Uzin | 1e057479 | zoho |
| Oscar Uzin | 64bf5483 | dubsado |
| Osvaldo Varela | 0b6444e4 | zoho |
| Osvaldo Varela | 1c30adcd | zoho |
| Raul Juarez | 67dbdbe6 | dubsado |
| Raul Juarez | 9f748f62 | dubsado |
| Richard Espinal | de769e43 | zoho |
| Richard Espinal | e2819da9 | zoho |
| Ryan Hansen | 733491af | zoho |
| Ryan Hansen | fdcb86fc | zoho |
| Sabrina Alicea | 313f76c5 | zoho |
| Sabrina Alicea | 8c94c603 | zoho |
| Sabrina Alicea | b2bfc1a8 | zoho |
| Samantha Collazo | 35952171 | dubsado |
| Samantha Collazo | 7631e6f3 | dubsado |
| Santos Gonzalez | 4d02fbf4 | dubsado |
| Santos Gonzalez | 89cb44c7 | dubsado |
| Sebastian Koziura | 004b7932 | dubsado |
| Sebastian Koziura | 956cdf76 | zoho |
| Serhat Cicekoglu | 3fbc0717 | dubsado |
| Serhat Cicekoglu | eb42c97d | dubsado |
| Stephanie Fernandez | 60dedf26 | zoho |
| Stephanie Fernandez | 944dc908 | dubsado |
| Suge Lim | c72a82d2 | dubsado |
| Suge Lim | db411265 | dubsado |
| Theresa Ashford | 5991c7ce | dubsado |
| Theresa Ashford | 650013f0 | dubsado |
| Uriel Velasco | 11dcdadb | zoho |
| Uriel Velasco | b7e5075d | dubsado |
| Veronica Linares | 77788d2e | dubsado |
| Veronica Linares | c724fa33 | dubsado |
| Victor Chan | ccadbc28 | dubsado |
| Victor Chan | e1e8e52c | dubsado |
| Wendy Rodriguez | 3d713b61 | zoho |
| Wendy Rodriguez | b9f4fb04 | dubsado |
