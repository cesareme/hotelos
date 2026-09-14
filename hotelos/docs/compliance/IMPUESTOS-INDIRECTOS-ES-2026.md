# Impuestos indirectos en hostelería (España, vigente septiembre 2026)

Referencia de producto para Anfitorio. Es la base del catálogo fiscal por región
(`packages/compliance/src/spain/indirect-tax.ts`) y de la provisión automática de
impuestos al crear una propiedad (Tanda 3 de la auditoría 360). No sustituye al
asesor fiscal del hotel: los tipos se validan contra la ordenanza/ley vigente en
el momento de facturar y el hotel puede sobrescribirlos por concepto.

## 1. Península y Baleares — IVA (Ley 37/1992)

| Concepto de folio | Tipo | Base legal |
|---|---|---|
| Alojamiento (habitación, noche extra, late check-out, early check-in, cuna, mascota, supl. ocupación) | **10 %** | art. 91.Uno.2.2º: «servicios de hostelería, acampamento y balneario» |
| Restaurante, bar, cafetería, room service, minibar, desayuno, media pensión, pensión completa, banquetes (suministro de comidas y bebidas para consumir en el acto, incluidas bebidas alcohólicas servidas) | **10 %** | art. 91.Uno.2.2º; desde la Ley 3/2017 los «servicios mixtos de hostelería» (discoteca, bar musical, café-teatro) también tributan al 10 % |
| Balneario / aguas mineromedicinales | **10 %** | art. 91.Uno.2.2º («balneario») |
| Spa, wellness, masajes, gimnasio (sin carácter de balneario) | **21 %** | tipo general (art. 90); la DGT no los asimila al balneario |
| Parking, garaje | **21 %** | art. 90 |
| Lavandería, tintorería | **21 %** | art. 90 |
| Teléfono, internet, TV de pago, business center | **21 %** | art. 90 |
| Alquiler de salas, eventos (sin restauración) | **21 %** | art. 90 |
| Entradas a espectáculos/discoteca (acceso, no consumición) | **21 %** | art. 90 (el acceso es independiente del servicio de hostelería) |
| Transporte de viajeros (transfer, shuttle) | **10 %** | art. 91.Uno.2.1º |
| Excursiones, entradas a museos/monumentos revendidas | **10 %** (cultura) / según proveedor | art. 91.Uno.2.6º |
| Tasa turística autonómica repercutida (IEET Cataluña, ITS Baleares) | **10 %** (forma parte de la base del alojamiento; las tarifas oficiales se publican «IVA incluido» / «+10 % IVA») | doctrina DGT; ATC/ATIB |
| Penalización por no-show / cancelación tardía | **No sujeta** (indemnización, art. 78.Tres.1º) | doctrina DGT; VeriFactu: `CalificacionOperacion=N1`, `Impuesto=01` |
| Depósitos/fianzas devueltos | Fuera de base | — |

Tipos vigentes del IVA: general 21 %, reducido 10 %, superreducido 4 % (no aplica
a hostelería). No hay tipos del 0 %/5 % vigentes para estos conceptos en 2026.

## 2. Canarias — IGIC (Ley 4/2012, Comunidad Autónoma de Canarias)

El IVA no se aplica en Canarias. La hostelería tributa al **tipo general del 7 %**
(alojamiento y restauración; doctrina de la Agencia Tributaria Canaria, art. 51.1
Ley 4/2012). El tipo reducido del 3 % (art. 54) cubre transporte terrestre,
reparaciones y servicios sociales, **no** la hostelería. Spa, parking, lavandería,
telecomunicaciones: 7 %. No existe tasa turística autonómica en Canarias (2026).
VeriFactu: `Impuesto=03`, `ClaveRegimen` de la lista L8B.

| Concepto | Tipo IGIC |
|---|---|
| Alojamiento y F&B | 7 % |
| Spa, parking, lavandería, teléfono, salas | 7 % |
| Transporte de viajeros | 3 % |
| No-show / cancelación | No sujeta |

## 3. Ceuta y Melilla — IPSI (ordenanzas fiscales municipales)

El IVA no se aplica. Ordenanza de Melilla (vigente): «Las prestaciones de servicios
tributarán al tipo general del 4 %»; «los restaurantes de dos o más tenedores, los
cafés y bares de categoría especial, y demás servicios de hostelería tributarán al
2 %»; «restaurante de un tenedor y demás cafés y bares: 1 %». Ceuta aplica una
estructura equivalente (1 % / 2 % hostelería, 4 % servicios en general).
VeriFactu: `Impuesto=02`.

| Concepto | Tipo IPSI (defecto) |
|---|---|
| Alojamiento, restauración y demás hostelería | 2 % |
| Bar/cafetería de categoría no especial | 1 % |
| Spa, parking, lavandería, teléfono, salas | 4 % |

Los tipos del IPSI cambian por ordenanza anual: el catálogo los marca como
`verifyAgainstOrdinance: true` y el readiness fiscal exige confirmación explícita.

## 4. Tasas turísticas (no son impuestos sobre la factura, pero se repercuten)

| Territorio | Tributo | Regla 2026 | IVA |
|---|---|---|---|
| Cataluña | IEET (impuesto sobre las estancias en establecimientos turísticos) | por persona y noche según categoría, máximo 7 noches por estancia, menores de 17 exentos; recargo municipal (Barcelona hasta 8 €; resto de municipios por ordenanza desde 01-10-2026); nuevas tarifas desde 01-04-2026 | tarifas oficiales IVA incluido (10 %) |
| Illes Balears | ITS (impost del turisme sostenible) | 1–4 €/persona/noche según categoría; temporada baja (1-nov→30-abr) 25 % menos; menores de 16 exentos; a partir de la 9ª noche bonificación 50 % | + 10 % IVA sobre la cuota |
| Resto de España | sin tasa autonómica (Valencia derogó la suya en 2024) | — | — |

Anfitorio modela la tasa como línea de folio `tourist_tax` con cálculo por
(personas adultas × noches gravadas × tarifa) y la incluye en la base del IVA al
10 % cuando el territorio lo exige.

## 5. VeriFactu: mapeo de desglose

- `Impuesto`: 01 IVA · 02 IPSI · 03 IGIC · 05 Otros.
- `ClaveRegimen`: 01 régimen general (IVA, L8A) / 01 (IGIC, L8B).
- `CalificacionOperacion`: S1 sujeta y no exenta · N1 no sujeta (indemnizaciones).
- `TipoImpositivo`, `BaseImponibleOimporteNoSujeto`, `CuotaRepercutida` por cada tipo.
- Bloque `SistemaInformatico` (Orden HAC/1177/2024, anexo): `NombreRazon` y **`NIF`
  del productor del software** son obligatorios, junto con `NombreSistemaInformatico`,
  `IdSistemaInformatico`, `Version`, `NumeroInstalacion`, `TipoUsoPosibleSoloVerifactu`,
  `TipoUsoPosibleMultiOT`, `IndicadorMultiplesOT`.

## Fuentes

- Ley 37/1992 del IVA, arts. 90 y 91 (BOE-A-1992-28740, texto consolidado 2026).
- AEAT, Manual práctico IVA 2025, cap. 4 «Tipo impositivo reducido del 10 por ciento».
- AEAT, novedades Ley 6/2018 y Ley 3/2017 (servicios mixtos de hostelería al 10 %).
- Ley 4/2012 de Canarias (BOE-A-2012-9282) y doctrina de la Agencia Tributaria Canaria (hostelería al tipo general).
- Ordenanza fiscal del IPSI de la Ciudad Autónoma de Melilla (tipos impositivos, melilla.es); ordenanza de Ceuta (BOCCE).
- Agència Tributària de Catalunya, IEET: tarifas desde 01-04-2026 (atc.gencat.cat, 10-03-2026).
- ATIB / Govern de les Illes Balears, Impost del Turisme Sostenible.
- Orden HAC/1177/2024 (BOE-A-2024-22138), anexo: registros de facturación y bloque SistemaInformatico.
