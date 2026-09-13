# primary-flags-cleared (2026-09-12)

Generated 2026-09-13T01:36:50.373Z by scripts/report-table.mjs from production; 167 row(s).

The 167 primary flags migration 0102 cleared, read back from its audit rows.

```sql
SELECT details->>'contact' AS contact, details->>'business' AS business FROM audit_log WHERE action = 'business.primary_cleared' AND actor_label LIKE 'migration 0102%' ORDER BY 1, 2
```

| contact | business |
|---|---|
| Alberto Perez | Alvarez Events LLC |
| Alberto Perez | ALVAREZ TRUCKING & TRANSPORTATION LLC |
| Alberto Perez | TITO'S HOTSHOT TRUCKING LLC |
| Amy Jewel | 312 Housing Collective |
| Amy Jewel | Ann Panopio & Irving |
| Angel Sida, Jr | ANGEL M SIDA JR |
| Angel Sida, Jr | Studio 117 |
| Anne Zakaras | CHRISTOPHER WALTERS and ANNE ZAKARAS |
| Anne Zakaras | SCOUT COUNSELING AND ART THERAPY LLC |
| Ann Leone | ANN LEONE and JONATHAN OCCKIAL |
| Ann Leone | Lakeshore Family Law LLC |
| Anthony Pedroza | ANTHONY A PEDROZA |
| Anthony Pedroza | PEDROZA LOGISTICS LLC |
| Artapong (Art) Sriratana | ARTAPONG SRIRATANA |
| Artapong (Art) Sriratana | MICHELLE P PUNMIT and A SRIRATANA |
| Artapong (Art) Sriratana | Sadic & Sriratana LLC |
| Cerasela Calderon | ETHAN CALDERON |
| Cerasela Calderon | IVASCU FAMILY IRRV TR DATED JUNE 22 2022 |
| Cerasela Calderon | JACQUELINE CALDERON |
| Cesar Pino | CITLALLI PINO |
| Cesar Pino | LIVING BLOCKS LLC |
| Christopher Brent | BRENT RACING & MACHINING LLC |
| Christopher Brent | CHRISTOPHER BRENT and SAMANTHA BRENT |
| Coleen Kane | C KANE DESIGN LLC |
| Coleen Kane | COLLEEN KANE and PAUL ROGERS |
| Dan DIY | DANIEL S SANTIAGO |
| Dan DIY | VVNDS CHICAGO LLC |
| Daniel Espinoza | JHOANA A RUIZ and DANIEL ESPINOZA |
| Daniel Espinoza | SANTA MASA TAMALERIA LLC |
| Daniel Hernandez | DRH HOLDINGS LLC |
| Daniel Hernandez | Explorar USA LLC DBA DanielRomeohh |
| Daniel Hernandez | Fayo LLC |
| Daniel Hernandez | VISTA LLC |
| David Davemport | DAVENPORT COMMUNITY DEVELOPMENT CORPORATION NFP |
| David Davemport | DAVID DAVENPORT and ANITA DAVENPORT |
| Duncan Smith | FRANCESCA TRAUGHBER-SMITH |
| Duncan Smith | JANE TRAUGHBER-SMITH |
| Edward Debruyne | DeBruyne Insurance Agency Inc. |
| Edward Debruyne | EDWARD DEBRUYNE and KARLA DEBRUYNE |
| Edward Tanglao | BIG TANK LLC |
| Edward Tanglao | EDWARD H and KELLY C TANGLAO |
| Emani Roberts | EMANI N ROBERTS |
| Emani Roberts | ENR ENTERPRISES INC |
| Enrique Galvan | EGALVAN LLC |
| Enrique Galvan | ENRIQUE GALVAN and ZULEMA HUERTA-BONIFACIO |
| Erica Gonzalez | Tri-Taylor Condominium Association |
| Erica Gonzalez | TRI-TAYLOR CONDOMINIUM ASSOCIATION |
| Erica London | ERICA LONDON and JASON LONDON |
| Erica London | The Chef and the Baker LLC |
| Florence Kimondo | COMPASSION COUCH THERAPY LLC |
| Florence Kimondo | GEMS LIFE COACH LLC |
| Gerod Carfantan | GEROD CARFANTAN and JENNIFER CARFANTAN |
| Gerod Carfantan | Piper Kennedy Ventures, LLC |
| Hamdi Ozan Tuncer | VENTUM PROPERTY MANAGEMENT LLC |
| Hamdi Ozan Tuncer | VENTUM SOFTWARE DEVELOPMENT AND CONSULTANCY, LLC |
| Hector Diaz | Humble House Real Estate, LLC |
| Hector Diaz | In Good Spirits LLC |
| Humberto Silva | HUMBERTO SILVA and VIVIANA FIGUEROA |
| Humberto Silva | SILVA REFRIGERATION INC |
| Isimeme Edeko | HALFRICAN BEAUTE LLC |
| Isimeme Edeko | ISIMEME EDEKO and JOSHUA WOODARD |
| Jackson Flores | DISHROULETTE KITCHEN NFP |
| Jackson Flores | DISHROULETTE SERVICES LLC |
| Jared Bobo | BLK COW LLC |
| Jared Bobo | JARED BOBO and JOY ANDERSON |
| Jared Bobo | LIKEFOOD LLC |
| Jared Bobo | MATTESON FARMS LLC |
| Jared Bobo | STAMP CHICAGO LLC |
| Jason Lopez | JASON LOPEZ and JESSIEN LOPEZ |
| Jason Lopez | TURNTABLE MANNERS LLC |
| Jason Malito | Casa de Malito LLC |
| Jason Malito | JASON MALITO and KIMBERLY MALITO |
| Jason Malito | LIA MALITO |
| Jazmin Zamora | SEMBRA CHICAGO NFP |
| Jazmin Zamora | SEMBRA LLC |
| Jean Rivera | JEAN C and AMANDA L RIVERA |
| Jean Rivera | RE VISION EXECUTIVE SEARCH LLC |
| Jessica Macias | JESSICA DIANA MACIAS LLC |
| Jessica Macias | JESSICA MACIAS and DAVID MACIAS |
| JM Tarbell | BRIXFIELD LLC |
| JM Tarbell | JOSE M TARBELL |
| JM Tarbell | MPC Investment Group LLC |
| JOEL HERRERA | FOUR TWO FIVE TWO LLC |
| JOEL HERRERA | HERRERA LAW CENTER LLC |
| JOEL HERRERA | JOEL HERRERA and STEPHANIE HERRERA |
| Jose Damian | JD AND SONS TRANSPORT INC |
| Jose Damian | JOSE DAMIAN JR |
| Joseph Basilone | JOSEPH BASILONE and MELISSA BASILONE |
| Joseph Basilone | Thrift & Thrive Inc |
| Josue Lopez | Glowspa Skincare, LLC |
| Josue Lopez | JOSUE LOPEZ and YINETH GARCIA |
| Juan Soto | JUAN SOTO and VERONICA DIAZ-SOTO |
| Juan Soto | RAQUEL L SOTO |
| Juan Soto | SABRINA M SOTO |
| Juan Soto | Soto Strategies LLC |
| Larry Reed | LARRY J REED |
| Larry Reed | The Card Hustle LLC |
| Luis Salinas | ATA Home Improvement LLC |
| Luis Salinas | LUIS A SALINAS |
| Lydia Nader | FUEL UP NUTRITION SERVICES LLC |
| Lydia Nader | LYDIA URDIALES and ANDREW URDIALES |
| Manuel Velasco | JUAN-MANUEL VELASCO -LOERA and LORENA VELASCO |
| Manuel Velasco | MLV CUSTOM STONES LLC |
| Margarita Aguillon | MARGARITA AGUILLON and MARCO DELGADO ARTEAGA |
| Margarita Aguillon | STEPHANIE DELGADO |
| Mario Arevalo | EMMANUEL AREVALO-NOWELL |
| Mario Arevalo | MARIO AREVALO and ANA MARIA NOWELL-AREVALO |
| Mario Arevalo | Tempixque LLC |
| Marisa Carrillo | MARISA MELTON |
| Marisa Carrillo | RIS EVENTS LLC |
| Megan Falsafi | MOHSEN FALSAFI and MEGAN FALSAFI |
| Megan Falsafi | THE LAW OFFICE OF MEGAN E FALSAFI LLC |
| Meredith Millay | BILL WHITMIRE AND MEREDITH MILLAY |
| Meredith Millay | Bill Whitmire LLC |
| Michael Kaiser-nyman | 1508 N Harding Development LLC |
| Michael Kaiser-nyman | Chicago Family Housing Community |
| Miguel Saucedo | DR SAUCEDO CONSULTING LLC |
| Miguel Saucedo | JERRY'S CATERING LLC |
| Miguel Saucedo | KPS EDUCATION RESOURCE CENTER INC. |
| Miguel Saucedo | MIGUEL A SAUCEDO |
| Nilda Claudio | NILDA CLAUDIO and WILLIAM CLAUDIO |
| Nilda Claudio | WAYNE CLAUDIO |
| Nilda Claudio | WAYNE CLAUDIO (SON) |
| Olaide Okanlawon | Interserve Group LLC |
| Olaide Okanlawon | OLUBUKOLA OKANLAWON and OLAIDE OKANLAWON |
| Rafael Castillo | BRIAN CASTILLO |
| Rafael Castillo | CJR LOGISTICS LLC |
| Rafael Castillo | NORMA GONZALEZ |
| Rafael Castillo | RAFAEL CASTILLO and ERIKA GONZALEZ |
| Ratanya Olaves | Ratanya Noel LLC |
| Ratanya Olaves | RATANYA OLAVES and DAVID OLAVES |
| Raul Tinoco | PLATINO LLC |
| Raul Tinoco | RAUL A TINOCO PLASCENCIA |
| Razvan Sofronie | DJS FINANCIALS INC |
| Razvan Sofronie | EKL LLC |
| Razvan Sofronie | EKL RV LLC |
| Razvan Sofronie | RONIC ENTERPRISES INC |
| Roberto Gonzalez | AK 2022 DEVELOPMENT & CONSTRUCTION LLC |
| Roberto Gonzalez | ROBERTO GONZALEZ and DEANNA RUBIO |
| Roberto Moreno Souza dos Reis | RdR Consulting LLC |
| Roberto Moreno Souza dos Reis | ROBERTO SOUZA DOS REIS and CYNTHIA MEDINA |
| Rodrigo Lozano | ANGELA GRANADO-LOZANO and RODRIGO LOZANO |
| Rodrigo Lozano | BRAULIO LOZANO |
| Sabrena Lopez | SABRENA LOPEZ and JESSE MEXICANO |
| Sabrena Lopez | Spectrum Administrative Services LLC |
| Sany Nguyen | CELEBRATE ARGYLE, LLC |
| Sany Nguyen | SDEELITE, LLC |
| Sany Nguyen | The Law Office of H.S. Nguyen LLC |
| Sarah Pekoc | SARAH A PEKOC and JESUS Y DURAN |
| Sarah Pekoc | Sarah Pekoc PsyD LLC |
| SKAR Group Holdings | SKAR GROUP HOLDINGS INC |
| SKAR Group Holdings | STARIO INVESTMENT MANAGEMENT INC |
| Stephanie Herrera | CARITAS MENTAL HEALTH / CATORI THERAPY PLLC |
| Stephanie Herrera | CATORI THERAPY PLLC |
| Steven Walsh | OMNI MEDIA AND MARKETING LLC |
| Steven Walsh | STEVEN J WALSH |
| Tal Haimovitch | 3414 Potomac LLC |
| Tal Haimovitch | TAL HAIMOVITCH and BRITTANY KWAIT |
| Tal Haimovitch | TH Buildings LLC |
| Taylor Mason | TAYLOR M SNIDER and MAYA A ADAMS |
| Taylor Mason | Taylor's Tacos |
| Ting Ting Zhao | FLEUR DE LUXE LLC |
| Ting Ting Zhao | KEVIN G RUSSELL and TINGTING ZHAO |
| Veronica Linares | LACALACA 22 LLC |
| Veronica Linares | VERONICA LINARES and JONATHAN ORNELAS |
| Yolanda Rueda | ARMANDO and YOLANDA RUEDA |
| Yolanda Rueda | YANNA INC. |
