# document-checklist-seeded (2026-09-28)

Generated 2026-09-28T08:32:04.773Z by scripts/report-table.mjs from production; 46 row(s).

R83: the document checklist exactly as seeded on production (migration 0132 and the document_checklist seed, deployed 2026-09-28). Every row is Brian's to edit in Admin -> Document checklist (the words, the order, on/off, a new document); no deploy.

```sql
SELECT d.item_code, d.doc_key, d.label_en, d.label_es, d.sort_order, d.active FROM document_checklist_items d ORDER BY d.item_code, d.sort_order, d.doc_key
```

| item_code | doc_key | label_en | label_es | sort_order | active |
|---|---|---|---|---|---|
| BIZ_1065 | year_end_financials | Year-end financial statements (profit and loss and balance sheet) | Estados financieros de cierre de año (pérdidas y ganancias y balance general) | 10 | t |
| BIZ_1065 | prior_year_business_return | Last year’s business tax return | La declaración de impuestos del negocio del año pasado | 20 | t |
| BIZ_1065 | k1_detail | Partner detail for the K-1s (each partner, ownership percentage, contributions and distributions) | Detalle de socios para los K-1 (cada socio, porcentaje de participación, aportaciones y distribuciones) | 30 | t |
| BIZ_1120 | year_end_financials | Year-end financial statements (profit and loss and balance sheet) | Estados financieros de cierre de año (pérdidas y ganancias y balance general) | 10 | t |
| BIZ_1120 | prior_year_business_return | Last year’s business tax return | La declaración de impuestos del negocio del año pasado | 20 | t |
| BIZ_1120S | year_end_financials | Year-end financial statements (profit and loss and balance sheet) | Estados financieros de cierre de año (pérdidas y ganancias y balance general) | 10 | t |
| BIZ_1120S | prior_year_business_return | Last year’s business tax return | La declaración de impuestos del negocio del año pasado | 20 | t |
| BIZ_1120S | k1_detail | Shareholder detail for the K-1s (each owner, ownership percentage and distributions) | Detalle de accionistas para los K-1 (cada dueño, porcentaje de participación y distribuciones) | 30 | t |
| BIZ_990 | year_end_financials | Year-end financial statements (profit and loss and balance sheet) | Estados financieros de cierre de año (pérdidas y ganancias y balance general) | 10 | t |
| BIZ_990 | prior_year_business_return | Last year’s business tax return | La declaración de impuestos del negocio del año pasado | 20 | t |
| BIZ_990 | officers_list | The list of officers, directors and key employees | La lista de funcionarios, directores y empleados clave | 30 | t |
| BIZ_AMENDMENT | return_being_amended | The return being amended, and the documents that change it | La declaración que se va a enmendar y los documentos que la cambian | 10 | t |
| BIZ_NOTICE_SUPPORT | notice | The IRS or state notice (every page) | El aviso del IRS o del estado (todas las páginas) | 10 | t |
| BIZ_SCH_C | business_income_records | Business income records for the year (sales totals, 1099-NEC and 1099-K) | Registros de ingresos del negocio del año (totales de ventas, 1099-NEC y 1099-K) | 10 | t |
| BIZ_SCH_C | business_expense_records | Business expense records for the year (receipts, statements or a profit and loss) | Registros de gastos del negocio del año (recibos, estados de cuenta o un estado de pérdidas y ganancias) | 20 | t |
| IND_AMENDMENT_1040X | return_being_amended | The return being amended, and the documents that change it | La declaración que se va a enmendar y los documentos que la cambian | 10 | t |
| IND_BASE_HOH | photo_id | Photo ID (driver’s license or passport) for each person on the return | Identificación con foto (licencia de conducir o pasaporte) de cada persona en la declaración | 10 | t |
| IND_BASE_HOH | prior_year_return | Last year’s tax return (federal and state) | La declaración de impuestos del año pasado (federal y estatal) | 20 | t |
| IND_BASE_HOH | w2 | W-2 forms from every employer | Los formularios W-2 de cada empleador | 30 | t |
| IND_BASE_HOH | forms_1099 | 1099 forms you received (1099-NEC, 1099-MISC, 1099-G, 1099-R, SSA-1099 and any others) | Los formularios 1099 que recibió (1099-NEC, 1099-MISC, 1099-G, 1099-R, SSA-1099 y cualquier otro) | 40 | t |
| IND_BASE_MFJ | photo_id | Photo ID (driver’s license or passport) for each person on the return | Identificación con foto (licencia de conducir o pasaporte) de cada persona en la declaración | 10 | t |
| IND_BASE_MFJ | prior_year_return | Last year’s tax return (federal and state) | La declaración de impuestos del año pasado (federal y estatal) | 20 | t |
| IND_BASE_MFJ | w2 | W-2 forms from every employer | Los formularios W-2 de cada empleador | 30 | t |
| IND_BASE_MFJ | forms_1099 | 1099 forms you received (1099-NEC, 1099-MISC, 1099-G, 1099-R, SSA-1099 and any others) | Los formularios 1099 que recibió (1099-NEC, 1099-MISC, 1099-G, 1099-R, SSA-1099 y cualquier otro) | 40 | t |
| IND_BASE_MFS | photo_id | Photo ID (driver’s license or passport) for each person on the return | Identificación con foto (licencia de conducir o pasaporte) de cada persona en la declaración | 10 | t |
| IND_BASE_MFS | prior_year_return | Last year’s tax return (federal and state) | La declaración de impuestos del año pasado (federal y estatal) | 20 | t |
| IND_BASE_MFS | w2 | W-2 forms from every employer | Los formularios W-2 de cada empleador | 30 | t |
| IND_BASE_MFS | forms_1099 | 1099 forms you received (1099-NEC, 1099-MISC, 1099-G, 1099-R, SSA-1099 and any others) | Los formularios 1099 que recibió (1099-NEC, 1099-MISC, 1099-G, 1099-R, SSA-1099 y cualquier otro) | 40 | t |
| IND_BASE_SINGLE | photo_id | Photo ID (driver’s license or passport) for each person on the return | Identificación con foto (licencia de conducir o pasaporte) de cada persona en la declaración | 10 | t |
| IND_BASE_SINGLE | prior_year_return | Last year’s tax return (federal and state) | La declaración de impuestos del año pasado (federal y estatal) | 20 | t |
| IND_BASE_SINGLE | w2 | W-2 forms from every employer | Los formularios W-2 de cada empleador | 30 | t |
| IND_BASE_SINGLE | forms_1099 | 1099 forms you received (1099-NEC, 1099-MISC, 1099-G, 1099-R, SSA-1099 and any others) | Los formularios 1099 que recibió (1099-NEC, 1099-MISC, 1099-G, 1099-R, SSA-1099 y cualquier otro) | 40 | t |
| IND_F2441 | dependent_care_providers | Each dependent care provider’s name, address, tax ID and the amount paid | El nombre, la dirección, el número de identificación fiscal y el monto pagado a cada proveedor de cuidado de dependientes | 10 | t |
| IND_F4562 | asset_purchases | Purchase records for equipment, vehicles or property placed in service this year | Registros de compra de equipo, vehículos o propiedades puestos en servicio este año | 10 | t |
| IND_F5695 | energy_improvements | Receipts for energy improvements to your home (solar, heat pump, insulation, windows) | Recibos de mejoras de energía en su hogar (solar, bomba de calor, aislamiento, ventanas) | 10 | t |
| IND_F8863 | form_1098t | Form 1098-T from each school | El Formulario 1098-T de cada escuela | 10 | t |
| IND_F8936 | clean_vehicle_report | The purchase agreement and the dealer’s clean vehicle report | El contrato de compra y el informe de vehículo limpio del concesionario | 10 | t |
| IND_F8949_121 | home_sale_closing | The closing statement for the home sale, and the purchase and improvement records | La declaración de cierre de la venta de la casa y los registros de compra y mejoras | 10 | t |
| IND_NOTICE_SUPPORT | notice | The IRS or state notice (every page) | El aviso del IRS o del estado (todas las páginas) | 10 | t |
| IND_SCH_A | itemized_records | Form 1098 mortgage interest, property tax bills and charitable donation receipts | El Formulario 1098 de intereses hipotecarios, los recibos del impuesto predial y los recibos de donaciones | 10 | t |
| IND_SCH_B_D | forms_1099_int_div_b | 1099-INT, 1099-DIV and 1099-B statements from every bank and brokerage account | Los formularios 1099-INT, 1099-DIV y 1099-B de cada cuenta bancaria y de inversión | 10 | t |
| IND_SCH_C | business_income_records | Business income records for the year (sales totals, 1099-NEC and 1099-K) | Registros de ingresos del negocio del año (totales de ventas, 1099-NEC y 1099-K) | 10 | t |
| IND_SCH_C | business_expense_records | Business expense records for the year (receipts, statements or a profit and loss) | Registros de gastos del negocio del año (recibos, estados de cuenta o un estado de pérdidas y ganancias) | 20 | t |
| IND_SCH_E_K1 | k1s | Schedule K-1 from each partnership, S corporation, estate or trust | El Anexo K-1 de cada sociedad, corporación S, patrimonio o fideicomiso | 10 | t |
| IND_SCH_E_RENTAL | rental_records | Rent received and expenses for each rental property (Form 1098, property tax, repairs, insurance) | Rentas recibidas y gastos de cada propiedad de alquiler (Formulario 1098, impuesto predial, reparaciones, seguro) | 10 | t |
| IND_SCH_H | household_payroll | Wages paid to each household employee this year | Los salarios pagados a cada empleado doméstico este año | 10 | t |
