# Dataset demo · inventario previo y plan de refresco (Tanda 4 · 2026-09-14)

Lote `dataset-seeds` de la Tanda 4 («instalabilidad y datos»). Este documento
fija (1) el inventario de la BD demo **antes** de tocar nada, (2) qué es
intocable, (3) el plan por fases que implementa
`apps/api/src/scripts/refresh-demo-dataset.ts` y (4) la salida del `--dry-run`
ejecutado sobre la BD demo el 2026-09-14, que el integrador debe reproducir
antes de `--apply`.

## 1 · Inventario previo (recon read-only 2026-09-14, mañana)

| Tabla | Total | Detalle |
| --- | --- | --- |
| organizations | 5 | org_123 (HotelOS Demo SL, NIF B12345678 **inválido**), Faranda `cmrhw9jy30002fyvb6tsdiugt` (legal_name «AUDIT-T1 SL», NIF B99999999 **inválido**), 3 AUDIT |
| properties | 6 | prop_123, prop_canary, Faranda `cmrhw9jy40003fyvbuu2ec2w7`, 3 AUDIT |
| users | 12 | usr_123, Carmen + 10 AUDIT |
| reservations | 80 | Faranda 76 (58 AUDIT, RES-00001..16 walkthrough, RES-00038/39 probes sin marca), prop_123 3, AUDIT-T1 1 |
| guests | 63 | Faranda 61 (55 sin documento), AUDIT-T1 1, org_123 1 |
| invoices | 45 | 19 con `verifactu_hash` (14 Faranda + 5 prop_123) = INTOCABLES; 26 drafts sin hash (uno con 5.000 líneas) |
| verifactu_submissions / ses | 19 / 2 | todas stub, todas conservadas |
| pos_orders | 47 | Faranda 44 + prop_123 1 + AUDIT-T1 2: todos residuos de auditoría |
| revenue_daily_snapshots | 490 Faranda (430 demo + 60 night_audit) + 61 night_audit en cada otra propiedad | sin huecos |
| rate_days | 901 | BAR Faranda 900 (2026-08-15 → 2027-02-11) + 1 celda AUDIT 2027-03-15 |
| audit_events / event_stream | 851 / 336 | cadena hash GLOBAL (génesis único, enlaces cruzan orgs) |

Al mediodía la Tanda 3 añadió: 2 orgs AUDIT-T3 (`cmu1cmxjz0009fypsqe9lacmw`,
`cmu1cpvlp003dfyolfj8x503l`), RES-00077..86, facturas FAC-2026-000014..000020 y
REC-000002/3 en Faranda, FAC-2026-000001 con hash en prop_canary, SES aceptadas
en RES-00084/85 (y fallidas en RES-00021/28), 6 usuarios `audit-t3-*`. Por eso
el script es 100 % dirigido por predicados (nunca por ids fijos) y el
inventario «antes» de la sección 4 es el vinculante.

## 2 · Intocable (assert en código, nunca `deleteMany`)

- `audit_events` y `event_stream`: cadenas hash globales. Tras borrar orgs
  AUDIT quedan ~35 eventos con `organization_id` huérfano: **esperado**.
- Facturas con `verifactu_hash` (issued / cancelled / rectified), sus
  `verifactu_submissions` y las `ses_hospedajes_submissions` (cualquier estado).
  Las reservas de las que cuelgan (KEEP) se cierran por servicio: check-out
  con `acknowledgeBalance` (`checkOutReservationDetailed`) o cancelación
  (`transitionReservation`), nunca se borran (FK `invoices.folio_id` SET NULL
  rompería la trazabilidad).
- Series `invoice_sequences` FAC/REC; solo se borra la serie `AUDIT`.
- Partes de viajeros con SES: quedan con su reserva (KEEP).

## 3 · Plan por fases (`demo:refresh`)

| Fase | Ámbito | Qué hace | Transacción |
| --- | --- | --- | --- |
| A | orgs `name ILIKE 'AUDIT%'` distintas de org_123/Faranda | precondición 0 facturas con hash / 0 VeriFactu / 0 SES / 0 journals; borrado hijo→padre de 60+ tablas (invoice_lines → … → users → roles → taxes → properties → organizations) | una por org, timeout 600 s |
| B | Faranda | KEEP (hash o SES) → check-out / cancel por servicio; DELETABLE (AUDIT + probes + RES-00001 huérfana) árbol completo; maestros/POS/tareas/usuarios/sesiones/roles AUDIT | una |
| B′ | org_123 | 14 drafts huérfanos, RES-00003 (AUDIT-T0F) con folio/pago, tipos/rooms/floors/zone/space/channel/group/WO/POS/banco/gdpr/TTOO/usuarios AUDIT; RES-00002 (FAC-000001) → cancel | una |
| C | ambos | RES-00003..16 y RES-18392 desplazadas a [hoy+1, hoy+30] conservando LOS; habitación 501 liberada; folios open de reservas checked_out a saldo 0 cerrados | una |
| D | org_123 (allowlist) | solo si faltan: BAR (`seed-commercial SEED_SCOPE=rates SEED_BAR_PRICES={"DBL":105}`) y snapshots (`seed-revenue-snapshots SEED_ORG_ID=org_123`), como procesos hijo con su propio guard | seeds |

Post-condiciones tras `--apply`: cadena `audit_events`/`event_stream` sin
enlaces colgantes nuevos (`analyseChainLinks`), barrido dinámico por
`information_schema` de las 200+ tablas con `organization_id`/`property_id`
(solo `audit_events`/`event_stream` pueden seguir referenciando las orgs
borradas), inventario final y un `audit_event DEMO_DATASET_REFRESHED`
encadenado vía `audit.service`.

Decisiones: (a) el draft `cmu17ai0t014pfy69xm254r9g` de RES-00051 (cobro de
12,10 €) se borra y el pago queda en el folio (`payments.invoice_id` SET NULL
automático); (b) Fase D no ejecuta `seed-commercial` FULL sobre prop_123
(48 rooms + 4 tipos): sigue siendo una decisión manual documentada en
CLAUDE.md; los snapshots demo de prop_123 se calculan sobre sus 2
habitaciones reales; (c) prop_canary queda sin inventario («sin inventario»
en dashboards) salvo `SEED_CREATE_ROOMS=1`; (d) la cancelación de RES-00002
(prop_123, SES aceptada) encola una baja SES vía `queueSesBajaForReservation`
(best-effort: si prop_123 no tiene establecimiento SES completo queda una
submission `failed` + audit `SES_HOSPEDAJES_SUBMISSION_BLOCKED`, sin bloquear
la cancelación).

## 4 · Salida del `--dry-run` (BD demo, 2026-09-14 17:20 UTC)

```
[demo:refresh] DRY-RUN (no writes) · scope all · today 2026-09-14 · exclude-after 2026-09-14T17:20:07.768Z · 554 ms
  Fase A · orgs AUDIT: 5
    BORRAR  cmtzofrwh00lofy1jmkjpohuz (AUDIT Org 1789295660) · properties cmtzofrwi00lpfy1j4hlenmdy
    BORRAR  cmtzqn4u6001kfy43wgkdc0ik (AUDIT-T0 Org) · properties cmtzqn4u8001lfy43bnlbn0gx
    BORRAR  cmtzvgcxh000cfy3yfzti8ps4 (AUDIT-T1 Org) · properties cmtzvgcxi000dfy3yo8bhfr20
    BORRAR  cmu1cmxjz0009fypsqe9lacmw (AUDIT-T3 Org) · properties cmu1cmxk0000afypsb2i5g40w
    BORRAR  cmu1cpvlp003dfyolfj8x503l (AUDIT-T3 Impuestos SL) · properties cmu1cpvlq003efyolbbjowm6n
  Fase B · KEEP (fiscal/SES): 19
    RES-00021 checked_in → check_out [factura con verifactu_hash + ses_hospedajes_submission]
    RES-00028 checked_out → none [ses_hospedajes_submission]
    RES-00036 confirmed → cancel [factura con verifactu_hash]
    RES-00041 checked_out → none [factura con verifactu_hash]
    RES-00079 confirmed → cancel [factura con verifactu_hash]
    RES-00051 confirmed → cancel [factura con verifactu_hash]
    RES-00056 confirmed → cancel [factura con verifactu_hash]
    RES-00057 confirmed → cancel [factura con verifactu_hash]
    RES-00058 confirmed → cancel [factura con verifactu_hash]
    RES-00062 confirmed → cancel [factura con verifactu_hash]
    RES-00065 confirmed → cancel [factura con verifactu_hash]
    RES-00080 confirmed → cancel [factura con verifactu_hash]
    RES-00082 confirmed → cancel [factura con verifactu_hash]
    RES-00083 confirmed → cancel [factura con verifactu_hash]
    RES-00084 checked_in → check_out [ses_hospedajes_submission]
    RES-00077 checked_in → check_out [factura con verifactu_hash]
    RES-00081 confirmed → cancel [factura con verifactu_hash]
    RES-00085 checked_in → check_out [ses_hospedajes_submission]
    RES-00002 confirmed → cancel [factura con verifactu_hash]
  Fase B · huérfanas checked_in: RES-00001 · habitaciones liberadas: 501
  Borrados previstos por fase/tabla (144 grupos):
    A:cmtzofrwh00lofy1jmkjpohuz    revenue_daily_snapshots      ×   61  [cmtzq7xdm0003fyn311sbx8ej, cmu14nthe000dfy3ffwo6capx, cmu16ovdd004tfy7nmeunz3cx, cmu16ovde004ufy7nqnljf5t5, cmu16ovdg004vfy7n6jtwcij7, …]
    A:cmtzofrwh00lofy1jmkjpohuz    property_modules             ×    3  [cmtzofrws00lvfy1jmxst72tu, cmtzofrwu00lwfy1jimp3aemb, cmtzofrwv00lxfy1jxwzd8r3y]
    A:cmtzofrwh00lofy1jmkjpohuz    user_departments             ×    1  [cmtzofrwp00lufy1jmvzz2d1l]
    A:cmtzofrwh00lofy1jmkjpohuz    departments                  ×    1  [cmtzofrwn00ltfy1jvrng4fcn]
    A:cmtzofrwh00lofy1jmkjpohuz    user_property_roles          ×    1  [cmtzofrwm00lsfy1jbdi5roh6]
    A:cmtzofrwh00lofy1jmkjpohuz    users                        ×    1  audit-tenant-1789295660@audit.local  [cmtzofrwm00lrfy1jxuto1d73]
    A:cmtzofrwh00lofy1jmkjpohuz    role_permissions             ×  211  [cmtzv62qe009kfyvtj7sap3lq, cmtzv62qe009lfyvt1d7e6w9f, cmtzv62qe009mfyvtp6m55l3j, cmtzv62qe009nfyvt73r1dzdl, cmtzv62qe009ofyvtsz0sgl2v, …]
    A:cmtzofrwh00lofy1jmkjpohuz    roles                        ×    1  [cmtzofrwj00lqfy1jf5phu2lh]
    A:cmtzofrwh00lofy1jmkjpohuz    tax_rates                    ×    6  [cmu1cdas4000mfym5cwslcr0g, cmu1cdas4000nfym5r02o93a1, cmu1cdas5000ofym5m1o3nkzt, cmu1cdas5000pfym5b7ijn4kn, cmu1cdas6000qfym5xtqd3nn6, …]
    A:cmtzofrwh00lofy1jmkjpohuz    taxes                        ×    1  [cmu1cdas3000lfym5egdrt8jv]
    A:cmtzofrwh00lofy1jmkjpohuz    properties                   ×    1  [cmtzofrwi00lpfy1j4hlenmdy]
    A:cmtzofrwh00lofy1jmkjpohuz    organizations                ×    1  AUDIT Org 1789295660  [cmtzofrwh00lofy1jmkjpohuz]
    A:cmtzqn4u6001kfy43wgkdc0ik    revenue_daily_snapshots      ×   61  [cmtzrkiib0006fyfqxf11ec10, cmu14nthg000efy3foyr932q3, cmu16ovfo006gfy7nv8v6lim7, cmu16ovfp006hfy7n2pfthceu, cmu16ovfq006ify7np11laocf, …]
    A:cmtzqn4u6001kfy43wgkdc0ik    user_departments             ×    1  [cmtzqn4ue001qfy437ojzsn0l]
    A:cmtzqn4u6001kfy43wgkdc0ik    departments                  ×    1  [cmtzqn4uc001pfy43exofpec9]
    A:cmtzqn4u6001kfy43wgkdc0ik    user_property_roles          ×    1  [cmtzqn4uc001ofy43m47lxjwt]
    A:cmtzqn4u6001kfy43wgkdc0ik    users                        ×    1  audit-t0-owner@audit.local  [cmtzqn4ub001nfy43wmuprcar]
    A:cmtzqn4u6001kfy43wgkdc0ik    role_permissions             ×  211  [cmtzv62qk00fffyvtqxigj4f8, cmtzv62qk00fgfyvtn853ud1x, cmtzv62qk00fhfyvtdcpk7ft1, cmtzv62qk00fifyvt97girr7e, cmtzv62qk00fjfyvtn6v7tpcw, …]
    A:cmtzqn4u6001kfy43wgkdc0ik    roles                        ×    1  [cmtzqn4u9001mfy43elukji40]
    A:cmtzqn4u6001kfy43wgkdc0ik    tax_rates                    ×    6  [cmu1cdas9000tfym55hd5gldd, cmu1cdas9000ufym5o9o537hs, cmu1cdasa000vfym51ybkhh6x, cmu1cdasa000wfym5edhgl9co, cmu1cdasb000xfym5272u4w0u, …]
    A:cmtzqn4u6001kfy43wgkdc0ik    taxes                        ×    1  [cmu1cdas8000sfym54fjd1ghj]
    A:cmtzqn4u6001kfy43wgkdc0ik    properties                   ×    1  [cmtzqn4u8001lfy43bnlbn0gx]
    A:cmtzqn4u6001kfy43wgkdc0ik    organizations                ×    1  AUDIT-T0 Org  [cmtzqn4u6001kfy43wgkdc0ik]
    A:cmtzvgcxh000cfy3yfzti8ps4    invoice_lines                ×    2  [cmu171twb00hgfy69nnpkmq5l, cmu17462i006pfy7f1eaunuwv]
    A:cmtzvgcxh000cfy3yfzti8ps4    invoices                     ×    2  drafts sin hash  [cmu171tw900hffy69bj1hmx4k, cmu17462g006ofy7fdw01tlyn]
    A:cmtzvgcxh000cfy3yfzti8ps4    pos_order_lines              ×    1  [cmu16ydx8000rfy69e0fpu00u]
    A:cmtzvgcxh000cfy3yfzti8ps4    pos_orders                   ×    2  [pos_43c09064, pos_2b8cb556]
    A:cmtzvgcxh000cfy3yfzti8ps4    outlets                      ×    1  [cmu16ydwr000qfy69oakbvcx6]
    A:cmtzvgcxh000cfy3yfzti8ps4    folios                       ×    1  [cmu1737mu0069fy7fwx9kkbtr]
    A:cmtzvgcxh000cfy3yfzti8ps4    reservation_guests           ×    1  [cmu1737mt0067fy7fygdlcrti]
    A:cmtzvgcxh000cfy3yfzti8ps4    reservations                 ×    1  [cmu1737mr0065fy7furbiu6ul]
    A:cmtzvgcxh000cfy3yfzti8ps4    guests                       ×    1  [cmu1737mp0064fy7fddbfnw0m]
    A:cmtzvgcxh000cfy3yfzti8ps4    rooms                        ×    1  [cmu1737m30063fy7f9kkx5m9i]
    A:cmtzvgcxh000cfy3yfzti8ps4    room_types                   ×    1  [rt_4a321d32]
    A:cmtzvgcxh000cfy3yfzti8ps4    revenue_daily_snapshots      ×   61  [cmtzwm3j40042fyr8pu7lv1md, cmu14nthk000gfy3frr61xkih, cmu16ovhz0083fy7nbz1m7yhm, cmu16ovi10084fy7ngdxwmsvd, cmu16ovi20085fy7n265054bk, …]
    A:cmtzvgcxh000cfy3yfzti8ps4    revenue_pace_snapshots       ×    1  [cmu1hb6lm0001fymutk00e878]
    A:cmtzvgcxh000cfy3yfzti8ps4    forecast_accuracy            ×   60  [cmu17mv0701qcfy69q11tbwwy, cmu17mv0701qdfy69qxyxi51s, cmu17mv0701qefy69vnlr1ihp, cmu17mv0701qffy69qm4lxilu, cmu17mv0701qgfy69lcu89dkh, …]
    A:cmtzvgcxh000cfy3yfzti8ps4    property_readiness_checks    ×    8  [cmtzwn5rd004bfyr8oo6s6wtx, cmtzwn5re004cfyr85x9m49zj, cmtzwn5rf004dfyr8xv4n37d3, cmtzwn5rg004efyr8wdqyq60k, cmtzwn5rg004ffyr8mqrf5650, …]
    A:cmtzvgcxh000cfy3yfzti8ps4    property_modules             ×    2  [cmtzvgcy8006efy3yzrkrpdg9, cmtzvgcy9006ffy3yf6av4pl4]
    A:cmtzvgcxh000cfy3yfzti8ps4    property_ai_settings         ×    1  [cmtzvgcya006gfy3y3o1wa23c]
    A:cmtzvgcxh000cfy3yfzti8ps4    property_compliance_settings ×    1  [cmtzvgcya006hfy3y5q285hld]
    A:cmtzvgcxh000cfy3yfzti8ps4    upsell_offers                ×    1  [cmu1cjd740001fyps9f3me8ls]
    A:cmtzvgcxh000cfy3yfzti8ps4    user_departments             ×    1  [cmtzvgcy6006dfy3yww68hcl9]
    A:cmtzvgcxh000cfy3yfzti8ps4    departments                  ×    1  [cmtzvgcy4006cfy3yxtn9zwsu]
    A:cmtzvgcxh000cfy3yfzti8ps4    user_property_roles          ×    1  [cmtzvgcy4006bfy3y777macpl]
    A:cmtzvgcxh000cfy3yfzti8ps4    users                        ×    1  audit-t1-owner@example.com  [cmtzvgcy3006afy3ypv42me0o]
    A:cmtzvgcxh000cfy3yfzti8ps4    role_permissions             ×  211  [cmtzvgcxq000ffy3ygflb3cyn, cmtzvgcxq000gfy3yxnc4ae7u, cmtzvgcxq000hfy3yu3kms1hp, cmtzvgcxq000ify3y2po8vl5i, cmtzvgcxq000jfy3ya1eabhys, …]
    A:cmtzvgcxh000cfy3yfzti8ps4    roles                        ×    1  [cmtzvgcxj000efy3ykb3jgg7c]
    A:cmtzvgcxh000cfy3yfzti8ps4    properties                   ×    1  [cmtzvgcxi000dfy3yo8bhfr20]
    A:cmtzvgcxh000cfy3yfzti8ps4    organizations                ×    1  AUDIT-T1 Org  [cmtzvgcxh000cfy3yfzti8ps4]
    A:cmu1cmxjz0009fypsqe9lacmw    revenue_daily_snapshots      ×    1  [cmu1dcs5a000lfydz2itid87s]
    A:cmu1cmxjz0009fypsqe9lacmw    property_ai_settings         ×    1  [cmu1cmxl2006cfyps6qmccq13]
    A:cmu1cmxjz0009fypsqe9lacmw    property_compliance_settings ×    1  [cmu1cmxl1006bfyps2jl7wlpd]
    A:cmu1cmxjz0009fypsqe9lacmw    user_departments             ×    1  [cmu1cmxky006afypsfd86vjlp]
    A:cmu1cmxjz0009fypsqe9lacmw    departments                  ×    1  [cmu1cmxkw0069fypsvbgv621u]
    A:cmu1cmxjz0009fypsqe9lacmw    notification_deliveries      ×    3  [cmu1cmxlo006mfyps5ea7tmtr, cmu1cntyw0077fypsam52m992, cmu1cntzk0079fypsot5b84x1]
    A:cmu1cmxjz0009fypsqe9lacmw    user_invitations             ×    3  [cmu1cmxlk006lfypsvj3ncdit, cmu1cntyu0076fypsfek30qnz, cmu1cntzf0078fypsfw3xea25]
    A:cmu1cmxjz0009fypsqe9lacmw    user_property_roles          ×    1  [cmu1cmxkv0068fypsiig8ayg9]
    A:cmu1cmxjz0009fypsqe9lacmw    users                        ×    1  audit-t3-owner@example.com  [cmu1cmxku0067fypsvbwbpkje]
    A:cmu1cmxjz0009fypsqe9lacmw    role_permissions             ×  211  [cmu1cmxk9000cfypsfnk7cul5, cmu1cmxk9000dfyps83jebsf7, cmu1cmxk9000efypsy4yp13pn, cmu1cmxk9000ffypszo8r0rjt, cmu1cmxk9000gfypscpmcmpg8, …]
    A:cmu1cmxjz0009fypsqe9lacmw    roles                        ×    1  [cmu1cmxk2000bfypsp8ospr9f]
    A:cmu1cmxjz0009fypsqe9lacmw    tax_rates                    ×    6  [cmu1cmxl9006efypsf6ubljh9, cmu1cmxlb006ffypsdgxcsq5s, cmu1cmxlb006gfypsvdf690s0, cmu1cmxlc006hfyps4yxbpr99, cmu1cmxld006ifypsxxn7ojh3, …]
    A:cmu1cmxjz0009fypsqe9lacmw    taxes                        ×    1  [cmu1cmxl7006dfyps8eixxrue]
    A:cmu1cmxjz0009fypsqe9lacmw    properties                   ×    1  [cmu1cmxk0000afypsb2i5g40w]
    A:cmu1cmxjz0009fypsqe9lacmw    organizations                ×    1  AUDIT-T3 Org  [cmu1cmxjz0009fypsqe9lacmw]
    A:cmu1cpvlp003dfyolfj8x503l    revenue_daily_snapshots      ×    1  [cmu1dcs5d000mfydzq22m8rlq]
    A:cmu1cpvlp003dfyolfj8x503l    property_ai_settings         ×    1  [cmu1cpvmk009ffyolbt0rrgfr]
    A:cmu1cpvlp003dfyolfj8x503l    property_compliance_settings ×    1  [cmu1cpvmk009gfyolli0hsap4]
    A:cmu1cpvlp003dfyolfj8x503l    user_departments             ×    1  [cmu1cpvmi009efyolur1gbieu]
    A:cmu1cpvlp003dfyolfj8x503l    departments                  ×    1  [cmu1cpvmg009dfyolwxtj9bln]
    A:cmu1cpvlp003dfyolfj8x503l    notification_deliveries      ×    1  [cmu1cpvn8009qfyolz95mqy43]
    A:cmu1cpvlp003dfyolfj8x503l    user_invitations             ×    1  [cmu1cpvn3009pfyolnkqnbx26]
    A:cmu1cpvlp003dfyolfj8x503l    user_property_roles          ×    1  [cmu1cpvmf009cfyolefjbkdha]
    A:cmu1cpvlp003dfyolfj8x503l    users                        ×    1  audit-t3-impuestos@example.invalid  [cmu1cpvme009bfyol3fv2efj5]
    A:cmu1cpvlp003dfyolfj8x503l    role_permissions             ×  211  [cmu1cpvlw003gfyolt14doz5m, cmu1cpvlw003hfyolyzrx8qtw, cmu1cpvlw003ifyoljnim49x0, cmu1cpvlw003jfyoljlwjo6er, cmu1cpvlw003kfyol46wyxbk2, …]
    A:cmu1cpvlp003dfyolfj8x503l    roles                        ×    1  [cmu1cpvlr003ffyolub59x0e1]
    A:cmu1cpvlp003dfyolfj8x503l    tax_rates                    ×   14  [cmu1cpvmq009jfyolgfcav0jm, cmu1cpvmr009kfyol2t43hzbf, cmu1cpvms009lfyol2pwsfuph, cmu1cpvms009mfyolbotp3roj, cmu1cpvmt009nfyolnf72wsrw, …]
    A:cmu1cpvlp003dfyolfj8x503l    taxes                        ×    2  [cmu1crnss00affyol8m7mwkka, cmu1cpvmo009hfyolqk1sxagr]
    A:cmu1cpvlp003dfyolfj8x503l    properties                   ×    1  [cmu1cpvlq003efyolbbjowm6n]
    A:cmu1cpvlp003dfyolfj8x503l    organizations                ×    1  AUDIT-T3 Impuestos SL  [cmu1cpvlp003dfyolfj8x503l]
    B:faranda                      invoice_lines                × 5011  [cmtzqn8de001sfy43c892zdip, cmu1co6q3002gfyolctza8da5, cmtzqpyrq03wxfy43d8qsp24k, cmtzqq9px03x9fy43fb6rv6qz, cmtzqq9px03xafy43pnd9agjd, …]
    B:faranda                      invoices                     ×   11  drafts: 3 del árbol · 3 de KEEP · 5 huérfanos  [cmtzqq9px03x8fy43i0g1z71i, cmtzslpio000mfyqxvnyhy98u, cmu1co6q0002ffyola4p9dbsi, cmu18ujmi004ofyax9nb3r7u7, cmu17ai0t014pfy69xm254r9g, …]
    B:faranda                      payment_refunds              ×    4  [cmu18u3n3007lfy9hmp6kgol6, cmu18u3pg007mfy9hov1b8f6v, cmu18uc8f004lfyaxgvjk79ws, cmu18ucas004mfyaxieo51rrp]
    B:faranda                      payments                     ×   11  [cmtzqq9rn03xcfy43pxwqlwnn, cmu173z5x006lfy7f6zvtqwr7, cmu175s3m013sfy69jy6v9fh6, cmu176dhx013wfy69uvfqsztt, cmtzo5coq00dwfy1jtdg9chcy, …]
    B:faranda                      folio_lines                  ×   23  [cmtzo57n000aify1jgunpn1cj, cmtzo9cj600g6fy1jmr0ezzyv, cmtzqknpb0017fy43z6cf433c, cmtzqq9p103x5fy43jtxnn09z, cmtzqq9pg03x7fy43cztkh20s, …]
    B:faranda                      folios                       ×   65  [cmrhyhjnk0002fy694syb8oru, cmtzo46my003qfy1j7i1godin, cmtzo64b200e4fy1j7cgq4si7, cmtzo64br00eafy1j0qj79hyz, cmtzo71yj00evfy1jwuswdsga, …]
    B:faranda                      stays                        ×   20  [cmrhyi6s70004fy697djdgsq6, cmtzo4fr500agfy1jxmyoyfb1, cmtzo6pgv00eify1ju9wmtizf, cmtzqsub603xvfy43zvt4yxa4, cmu16ylax000zfy69zjhl0pex, …]
    B:faranda                      guest_register_records       ×   17  drafts sin SES  [grr_1804bdf4, grr_cb43ffbe, grr_fcdc91a0, grr_2fc8055e, grr_906507a1, …]
    B:faranda                      folio_routing_rules          ×    2  [cmu178d2c014bfy693nxpt2sq, cmu18ul45007wfy9h8vfj5bbm]
    B:faranda                      reservation_guests           ×   39  [cmtzo46mx003ofy1jtq15isok, cmtzo64b100e2fy1j03qi1hpb, cmtzo64br00e8fy1jkq10bhch, cmtzo6iwz00eefy1j41n4mf1x, cmtzo71yj00etfy1jka41d75r, …]
    B:faranda                      reservations                 ×   53  52 AUDIT + 1 huérfanas (RES-00001)  [cmu1cnnzi001efyol4lupmte6, cmtzo46mu003mfy1jyqmrswzs, cmtzo64b000e0fy1jd5ylauga, cmtzo64bq00e6fy1jxs13tihy, cmtzo6iwy00ecfy1j9h4wmbz0, …]
    B:faranda                      guests                       ×   39  exclusivos del conjunto borrado  [cmtzo46ms003lfy1j3b6ue3qw, cmtzo64ay00dzfy1jvs3xmelw, cmtzo64bp00e5fy1jugkli1le, cmtzo6iww00ebfy1jbqjd20bk, cmtzo71yf00eqfy1jidlbp9uh, …]
    B:faranda                      housekeeping_tasks           ×   23  creadas en la ventana de auditoría o sobre habitaciones AUDIT  [cmtzrtmkp001afyfqpz1z58tz, cmtzrtmri001ffyfqyi2cnjm5, cmtzrtnve001nfyfqhxrer62w, cmtzo3s74003hfy1j5gn5sbr5, cmtzo5cpf00dxfy1j7h8cpto8, …]
    B:faranda                      work_orders                  ×    8  [cmtzqjl7c0010fy43x0tcmbui, cmtzo6wim00epfy1jbbyfsmjw, cmtzrtnaf001jfyfqv783f6fa, cmtzrtnq9001mfyfq24vvchlu, cmtzo7xly00fafy1jztomb7so, …]
    B:faranda                      rooms                        ×    1  AUDITT0A  [cmtzqluzt0018fy43pa321bhu]
    B:faranda                      room_types                   ×    5  AUDIT_RT, AUDITT0MSRC, AUDT0OWN, AUDT0RA, AUDT0RC  [rt_54466a17, rt_9a4b8b3d, rt_9b04f907, rt_7e997da8, rt_e264a0b8]
    B:faranda                      rate_days                    ×    1  celdas de journals AUDIT + celdas de planes AUDIT  [cmtzo7p7700f7fy1jb1t8g6rf]
    B:faranda                      rate_change_journals         ×    1  [cmtzo7p7a00f9fy1j5c6ilxj1]
    B:faranda                      rate_plans                   ×    1  AUDIT-RP  [cmtzo841e00fbfy1jdhhmvsdu]
    B:faranda                      invoice_sequences            ×    1  AUDIT  [seq_c36fe68c]
    B:faranda                      user_departments             ×    1  [ud_a7cb036c]
    B:faranda                      departments                  ×    2  [dep_c29f8d5c, dep_7efcf75e]
    B:faranda                      floors                       ×    1  [floor_40289661]
    B:faranda                      housekeeping_sections        ×    3  [hk_f3788fa5, hk_f6a3309f, hk_39b5f11c]
    B:faranda                      maintenance_areas            ×    2  [ma_2c92d74a, ma_515b0577]
    B:faranda                      housekeeping_rules           ×    1  [hkr_3e5b87d2]
    B:faranda                      maintenance_rules            ×    1  [mr_e71f56de]
    B:faranda                      allotment_days               ×    4  [cmtzodmq400gify1jdredyye7, cmtzodmq400gjfy1j00kwqksf, cmtzodmq400gkfy1jxkpmi43u, cmtzodmq400glfy1jtqoykyy7]
    B:faranda                      allotments                   ×    1  [cmtzodmpy00ghfy1jo2b5lfcy]
    B:faranda                      group_bookings               ×    1  [cmtzoc5wu00gdfy1jzed07dnc]
    B:faranda                      document_templates           ×    1  [tpl_7ce470c9]
    B:faranda                      upsell_offers                ×    3  [cmu1cjd4s0000fypssahjvjnc, cmu1cok2c007hfypsjoplhyxs, cmu1hceuy000ifyo0u4ga4s8j]
    B:faranda                      pos_order_lines              ×   57  [cmtzogzam00m4fy1jv2z73sul, cmu16ydu8000lfy693ov9y8l6, cmu16ydun000mfy69nzzz66nk, cmu16ydv2000nfy69aogone6s, cmu16ydvi000ofy69fuxs61ny, …]
    B:faranda                      pos_orders                   ×   44  creados en la ventana de auditoría  [pos_8a05550d, pos_3359bb97, pos_1b295eab, pos_3e56a236, pos_9609372c, …]
    B:faranda                      outlets                      ×    1  out_casino  [cmu17mcfg01j7fy693xjyxzod]
    B:faranda                      sessions                     ×    6  de usuarios AUDIT o con device AUDIT  [cmtznv8lk003gfy1ji5krcbm2, cmtzvc8ag0003fy54kogyi1ou, cmtzvfmn9000bfy3y4x36lh7u, cmu17337b0062fy7fq9laq52l, cmu18rx0i005kfy9hj3i9couu, …]
    B:faranda                      password_reset_tokens        ×    1  [cmu1cmogd0007fypsv7n3hwdt]
    B:faranda                      user_invitations             ×    7  [cmu1cku3v000qfyolz8enso8z, cmu1cku1v0003fypszfc5zu35, cmu1coit0007bfypshegv5hvv, cmu1coivq007dfyps23lve05a, cmu1coiyg007ffyps3thyqgsv, …]
    B:faranda                      notification_deliveries      ×    8  [cmu1cku290004fypsk6ui8f00, cmu1cku46000rfyol2ctnnhn7, cmu1cmogj0008fyps6vpffd12, cmu1coit7007cfypsqxb11erq, cmu1cok7p007mfypszqi174m3, …]
    B:faranda                      user_property_roles          ×    4  [cmu1cku1p0002fypsm6ccjxpc, cmu1cku3r000pfyol9kp200mo, cmu1coisx007afypsh142qts6, cmu1cok5q007ifypsv7g1gyi7]
    B:faranda                      users                        ×    7  audit-t3-invite-demo@example.com, audit-t3-invite@example.com, audit-t2-norole@audit.local, audit-t2r-norole@audit.local, audit-t3-before@example.com, audit-t3-2@example.com, audit-t3-rbac-3400@example.com  [usr_1702a33f, usr_7ba09a82, cmu1733670061fy7fodyv1wr4, cmu18rln6003jfyaxu43oenog, usr_dbf84aab, …]
    B:org123                       invoice_lines                ×   14  [cmtzqpypy03wvfy43jq7lpz5e, cmtzqrsic03xgfy432n556iyc, cmtzqrsje03xify435a6awijv, cmtzqrsk703xkfy43kri6ceg2, cmtzrshps000ffyfqwt8q8dqf, …]
    B:org123                       invoices                     ×   14  drafts: 0 del árbol · 0 de KEEP · 14 huérfanos  [cmtzqrsic03xffy43e9te11vj, cmtzqrsk603xjfy43hugb9ea5, cmtzrshur000ifyfquej2deka, cmtzrsi12000pfyfqw4qzsc6h, cmtzrvx8w0021fyfq47suac2c, …]
    B:org123                       payments                     ×    1  [cmtzsmxkp000sfyqxs658yonn]
    B:org123                       folio_lines                  ×    2  [cmu1gz7940002fyotw0d399u6, cmu1hbdk20001fyolbp5048dk]
    B:org123                       folios                       ×    1  [cmtzsmf6p000qfyqxz32qnbig]
    B:org123                       reservations                 ×    1  1 AUDIT + 0 huérfanas (—)  [cmtzsmf6o000ofyqxiz90p7gb]
    B:org123                       housekeeping_tasks           ×    4  creadas en la ventana de auditoría o sobre habitaciones AUDIT  [cmtzqm5dv001afy43xakb125u, cmtzskq5f000ffyqxmfw4xqcr, cmtzoazi600gbfy1jchsd7t6b, cmtzol2wn00pvfy1j4ysqhmuj]
    B:org123                       work_orders                  ×    2  [cmtzqm5ep001dfy43ae5waf9a, cmtzskq40000efyqxu3lht044]
    B:org123                       rooms                        ×    2  AUDIT-T0-HK04, AUDIT-T0F  [cmtzqm5ck0019fy431vo6ol2y, cmtzskq2j000dfyqx506rw2ka]
    B:org123                       room_types                   ×    5  AUDIT_IDOR, AUDITVERIF1, AUDITT0IDOR, AUDITT0IDOR2, AUDT0GEN  [rt_12651c25, rt_eea9c636, rt_3da7ac4e, rt_92ab4f6e, rt_11ca3eb7]
    B:org123                       floors                       ×    2  [floor_239d5faa, floor_3439db89]
    B:org123                       group_bookings               ×    1  [cmtzvkl0z006ify3ytmrf7npm]
    B:org123                       property_zones               ×    1  [zone_031589e8]
    B:org123                       property_spaces              ×    1  [space_61ce70d6]
    B:org123                       channels                     ×    1  [cmtzvvofd0079fy3yxygy85f2]
    B:org123                       bank_accounts                ×    1  [cmtzvkl2w006jfy3y6i90149l]
    B:org123                       gdpr_requests                ×    1  [cmtzvp5k1006mfy3yz9sbkn94]
    B:org123                       tour_operators               ×    1  [cmtzqk0lr0011fy43wf2scemk]
    B:org123                       pos_order_lines              ×    3  [cmtzvqm14006ofy3yzr9jpipv, cmtzvqm14006pfy3yfrvkpp3d, cmtzvqm17006qfy3y4n45cu3w]
    B:org123                       pos_orders                   ×    1  creados en la ventana de auditoría  [pos_e7a12536]
    B:org123                       sessions                     ×    2  de usuarios AUDIT o con device AUDIT  [cmtznv8k6003ffy1j7d9nlbdn, cmtzvd4ab0004fy54wsw483f8]
    B:org123                       password_reset_tokens        ×    3  [cmtzowlkc00tify1j0ix92ypr, cmtzqmfdb001efy43lht3gyfi, cmtzqpxyh03wtfy4322yk1dht]
    B:org123                       users                        ×    4  audit-user-2026@audit.local, audit-reset-verify@example.com, audit-t0-demo@audit.local, audit-t0-gen@audit.local  [usr_8f765dbb, cmtzowljo00thfy1jo9gtxecg, usr_4b5f24da, usr_112c0950]
  Totales por tabla: revenue_daily_snapshots=185 · property_modules=5 · user_departments=6 · departments=7 · user_property_roles=9 · users=16 · role_permissions=1055 · roles=5 · tax_rates=32 · taxes=5 · properties=5 · organizations=5 · invoice_lines=5027 · invoices=27 · pos_order_lines=61 · pos_orders=47 · outlets=2 · folios=67 · reservation_guests=40 · reservations=55 · guests=40 · rooms=4 · room_types=11 · revenue_pace_snapshots=1 · forecast_accuracy=60 · property_readiness_checks=8 · property_ai_settings=3 · property_compliance_settings=3 · upsell_offers=4 · notification_deliveries=12 · user_invitations=11 · payment_refunds=4 · payments=12 · folio_lines=25 · stays=20 · guest_register_records=17 · folio_routing_rules=2 · housekeeping_tasks=27 · work_orders=10 · rate_days=1 · rate_change_journals=1 · rate_plans=1 · invoice_sequences=1 · floors=3 · housekeeping_sections=3 · maintenance_areas=2 · housekeeping_rules=1 · maintenance_rules=1 · allotment_days=4 · allotments=1 · group_bookings=2 · document_templates=1 · sessions=8 · password_reset_tokens=4 · property_zones=1 · property_spaces=1 · channels=1 · bank_accounts=1 · gdpr_requests=1 · tour_operators=1
  Fase C · desplazamientos de fecha: 15
    RES-00003: 2026-07-16→2026-07-18 ⇒ 2026-09-15→2026-09-17 (LOS 2)
    RES-00004: 2026-07-16→2026-07-19 ⇒ 2026-09-15→2026-09-18 (LOS 3)
    RES-00005: 2026-07-17→2026-07-18 ⇒ 2026-09-16→2026-09-17 (LOS 1)
    RES-00006: 2026-07-17→2026-07-21 ⇒ 2026-09-16→2026-09-20 (LOS 4)
    RES-00007: 2026-07-18→2026-07-20 ⇒ 2026-09-17→2026-09-19 (LOS 2)
    RES-00008: 2026-07-19→2026-07-21 ⇒ 2026-09-18→2026-09-20 (LOS 2)
    RES-00009: 2026-07-20→2026-07-23 ⇒ 2026-09-19→2026-09-22 (LOS 3)
    RES-00010: 2026-07-21→2026-07-22 ⇒ 2026-09-20→2026-09-21 (LOS 1)
    RES-00011: 2026-07-22→2026-07-24 ⇒ 2026-09-21→2026-09-23 (LOS 2)
    RES-00012: 2026-07-23→2026-07-26 ⇒ 2026-09-22→2026-09-25 (LOS 3)
    RES-00013: 2026-07-25→2026-07-27 ⇒ 2026-09-24→2026-09-26 (LOS 2)
    RES-00014: 2026-07-27→2026-07-31 ⇒ 2026-09-26→2026-09-30 (LOS 4)
    RES-00015: 2026-07-29→2026-07-31 ⇒ 2026-09-28→2026-09-30 (LOS 2)
    RES-00016: 2026-08-02→2026-08-05 ⇒ 2026-10-02→2026-10-05 (LOS 3)
    RES-18392: 2026-05-14→2026-05-16 ⇒ 2026-09-15→2026-09-17 (LOS 2)
  Fase C · folios open de checked_out a saldo 0 → cerrar: 0
  Fase D · reseed: 
    rates prop_123: BAR con 0 días futuros (<90) → SEED_PROPERTY_ID=prop_123 SEED_SCOPE=rates SEED_BAR_PRICES={"DBL":105}
    rates prop_canary: BAR con 0 días futuros (<90) pero sin tipos vendibles con habitaciones → omitido
    snapshots org_123: alguna propiedad demo con habitaciones tiene <400 snapshots top-level → SEED_ORG_ID=org_123
  Cadenas hash (antes): audit_events 1007 filas · génesis 3 · colgantes 0 | event_stream 391 · génesis 3 · colgantes 0
  Residuo orgs AUDIT (actual): audit_events=35 · departments=5 · event_stream=3 · forecast_accuracy=60 · guests=1 · invoices=2 · notification_deliveries=4 · outlets=1 · pos_orders=2 · property_ai_settings=3 · property_compliance_settings=3 · property_modules=5 · property_readiness_checks=8 · reservations=1 · revenue_daily_snapshots=185 · revenue_pace_snapshots=1 · roles=5 · room_types=1 · rooms=1 · taxes=5 · upsell_offers=1 · user_invitations=4 · user_property_roles=5 · users=5
  Inventario antes:
    organizations: 7
    properties: 8
    users: 18
    roles: 7
    reservations: prop_123=3 · cmtzvgcxi000dfy3yo8bhfr20=1 · cmrhw9jy40003fyvbuu2ec2w7=86
    guests: 67
    rooms: 126
    room_types: 17
    folios_open: 79
    folios_closed: 23
    folio_lines: 55
    payments: 36
    invoices_with_hash: prop_canary=1 · prop_123=5 · cmrhw9jy40003fyvbuu2ec2w7=23
    invoices_drafts: 27
    invoice_lines: 5065
    verifactu_submissions: 36
    ses_hospedajes_submissions: 12
    guest_register_records: 25
    pos_orders: 47
    housekeeping_tasks: 29
    rate_days: 901
    revenue_daily_snapshots: night_audit=367 · demo=430
    audit_events: 1007
    event_stream: 391
  Nada escrito. Haz backup (bash scripts/backup-postgres.sh) y repite con --apply; reinicia el API después.
```

## 5 · Orden de ejecución para el integrador

```bash
# 0. backup obligatorio (irreversible sin él)
bash scripts/backup-postgres.sh            # o, sin S3: pg_dump "$DATABASE_URL" -Fc -f hotelos_pre_t4_refresh.dump
# 1. plan (repetir hasta que coincida con esta sección)
corepack pnpm --filter @hotelos/api demo:refresh -- --scope all
# 2. aplicar
corepack pnpm --filter @hotelos/api demo:refresh -- --scope all --apply
# 3. identidad legal
corepack pnpm --filter @hotelos/api demo:fix-identity -- --dry-run
corepack pnpm --filter @hotelos/api demo:fix-identity -- --apply --confirm cmrhw9jy30002fyvb6tsdiugt --confirm org_123
# 4. reiniciar el API (espejos in-memory de tenants) y comprobar que el
#    backfill no reescribe cierres demo
corepack pnpm --filter @hotelos/api backfill:snapshots -- --from 2026-07-15 --to 2026-09-13 --dry-run
```

> **Nota 2026-09-17 (ensayo del VPS demo).** En una BD que ya tenga las migraciones
> de la Tanda 6b (`legal_entities`, `verifactu_installations`, `accounts`,
> `accounting_settings`), los pasos 1-3 de arriba deben ejecutarse **antes** de
> `backfill-legal-structure.ts --apply` y de `accounting:provision-chart --apply`:
> `demo:refresh` no conoce `legal_entities` (con las sociedades ya creadas borra las
> orgs AUDIT, deja sus 5 sociedades huérfanas y termina con exit 1 «Filas
> residuales de orgs AUDIT: legal_entities=5») y `demo:fix-identity` no corrige
> `legal_entities` (la sociedad de Faranda quedaría «AUDIT-T1 SL» con `tax_id`
> nulo). Orden validado y procedimiento completo:
> `docs/runbooks/vps-demo-actualizacion-2026-09-17.md` §7.

Identidad legal (dry-run 2026-09-14): Faranda org `legalName` «AUDIT-T1 SL» →
«Faranda Hotels & Resorts», `taxId` B99999999 → B99999997; property
`legalName` → «Hotel Faranda Rías Altas by Ascend Collection», `address` →
«Paseo Marítimo, 1», `fiscalTerritory` null → «common» (postal_code 15172,
provincia A Coruña, municipio Perillo (Oleiros), INE 15058 ya estaban);
org_123 `taxId` B12345678 → B12345674. Las 29 facturas emitidas conservan su
emisor histórico.

## 6 · Estado tras `--apply` y fixtures de la verificación adversarial (SELECT sobre la BD demo, 2026-09-14)

Cifras confirmadas con `psql` (solo `SELECT`) al cierre de la Tanda 4;
corrigen o matizan afirmaciones anteriores de este documento y del informe
del auditor. Primera foto a las 20:09 CEST (tras el primer `--apply` de las
19:29 CEST y con los fixtures AUDIT-T4 aún vivos); §6.1–6.3 se reescribieron
tras el cierre definitivo (segundo `--apply`, 20:23 CEST) y reflejan la BD
**hoy**.

> **Cierre ejecutado 2026-09-14 ~20:20 CEST:** `demo:refresh --apply` (Fase A
> borró «AUDIT-T4 Plantillas SL» con su propiedad y sus 4 roles plantilla;
> Fase B borró los usuarios/roles/sesiones AUDIT-T4 de Faranda, el grupo
> AUDIT-T4-REG2 con AUDIT-T4-REG2-001, RES-00035 y los huéspedes AUDIT sin
> traza fiscal; RES-00034 pasó a `checked_out` por servicio) y **segundo
> dry-run = 0** (nada que borrar, nada que cerrar). `audit_events`
> `DEMO_DATASET_REFRESHED` a las 17:29:11 y 18:23:25 UTC.

### 6.1 · Inventario de Faranda: 120 habitaciones, no 122

`rooms` de `cmrhw9jy40003fyvbuu2ec2w7` = **120** = DBL 60 + DSV 30 + JSU 15 +
IND 10 + SRA 5 (readiness `sellable_room_exists`: «120 habitación(es)
vendibles activas»). Cualquier cifra de 122 es errónea: a las 20:09 CEST
`rooms` totales daban 122 porque prop_123 tiene 2 y «AUDIT-T4 Hotel
Plantillas» (0 habitaciones) aún existía; de ahí la confusión. A las 20:09
había 37 reservas en Faranda, 3 orgs y 4 propiedades.

Hoy (tras el cierre): **orgs 2** (org_123, Faranda), **propiedades 3**
(prop_123, prop_canary, Faranda), **usuarios 2** (`reception@example.com`,
`direccion@farandariasaltas.es`), **roles 2** («Local Super Admin» 212 grants,
«Owner» de Faranda 211), `permissions` 212, reservas **Faranda 35 · prop_123
2**, huéspedes `Audit*`/`AUDIT*` 13 (12 enlazados a reservas KEEP + 1 residuo,
§6.3).

### 6.2 · «Sin reservas AUDIT» es inexacto: las KEEP se conservan por diseño

El refresco **no borra** reservas de las que cuelga una factura con
`verifactu_hash` (cadena VeriFactu) o un parte SES enviado (§2); las cierra
por servicio (check-out / cancel). Por eso siguen en Faranda **18 reservas
AUDIT-T0/T1/T2/T3**, todas `checked_out` o `cancelled` (columnas: facturas con
hash · envíos SES; «Marca» = `booker_name`, que es lo que casa el predicado
`ilike '%audit%'` — RES-00036/41 no llevan booker y entran por sus huéspedes):

| Código | Estado | Marca | hash · SES |
| --- | --- | --- | --- |
| RES-00021 | checked_out | AUDIT Fiscal | 2 · 2 |
| RES-00028 | checked_out | AUDIT-T0 Three | 0 · 8 (todas `failed`) |
| RES-00036 | cancelled | AUDIT-T0R | 1 · 0 |
| RES-00041 | checked_out | AUDIT-T1 | 1 · 0 |
| RES-00051 | cancelled | AUDIT-T2 | 3 · 0 |
| RES-00056 / 57 / 58 | cancelled | AUDIT-T2 / T2R | 2 · 0, 1 · 0, 1 · 0 |
| RES-00062 / 65 | cancelled | AUDIT-T2R | 1 · 0 cada una |
| RES-00077 | checked_out | AUDIT-T3 impuestos | 1 · 0 |
| RES-00079 … 83 | cancelled | AUDIT-T3 series-verifactu | 1-2 · 0 cada una |
| RES-00084 / 85 | checked_out | AUDIT-T3 ses-registro | 0 · 6, 0 · 3 |

Más las 2 KEEP de la verificación adversarial (T4, §6.3): AUDIT-T4-REG-001 y
RES-00034 → **20 reservas AUDIT en Faranda** en total. Consulta que reproduce
la lista (el predicado debe mirar también a los huéspedes, si no RES-00036 y
RES-00041 se pierden):

```sql
select r.code, r.status,
       (select count(*) from invoices i
         where i.reservation_id = r.id and i.verifactu_hash is not null) as hash,
       (select count(*) from ses_hospedajes_submissions s
         where s.reservation_id = r.id) as ses
from reservations r
where r.property_id = 'cmrhw9jy40003fyvbuu2ec2w7'
  and (r.code ilike 'AUDIT%'
    or coalesce(r.booker_name, '') ilike '%audit%'
    or coalesce(r.group_code, '') ilike '%audit%'
    or coalesce(r.notes, '') ilike '%audit%'
    or exists (select 1 from reservation_guests rg
                 join guests g on g.id = rg.guest_id
               where rg.reservation_id = r.id
                 and (g.first_name ilike 'audit%' or g.surname_1 ilike 'audit%')))
order by r.code;   -- 20 filas: 18 T0..T3 + AUDIT-T4-REG-001 + RES-00034
```

Además RES-00002 (prop_123, `cancelled`, FAC-000001 con hash; §3 B′). Del
mismo modo permanecen **11 de los 26 huéspedes «Audit…»** originales por estar
enlazados a esas reservas KEEP: Audit TresA, Audit TresB, AUDIT-T0 Three,
AUDIT-T0R, AUDIT-T2 (×3: «AUDIT-T2», «AUDIT-T2 Dinero», «AUDIT-T2 Nif»),
AUDIT-T2R Facturas / Facturas2 / Facturas3400 y «Prueba AUDIT» (4 reservas;
todos en la org Faranda), más «Audit CuatroReg» (T4, enlazado a
AUDIT-T4-REG-001 / RES-00034). Conservarlos es el comportamiento esperado, no
un fallo del refresco; un segundo `demo:refresh --apply` los reporta de nuevo
como KEEP.

**Anomalía conocida · RES-00028:** está `checked_out` con fechas
**2027-07-10 → 2027-07-12** (un año en el futuro) y 8 envíos SES, todos
`failed`. El auditor T0 la creó con esas fechas y el refresco la cerró por
servicio porque la regla KEEP (parte SES, en cualquier estado) prima sobre la
coherencia de fechas. No se corrige a mano (rompería la trazabilidad SES); es
un residuo de sandbox aceptado y documentado.

### 6.3 · Fixtures AUDIT-T4 de la verificación (limpiados el 2026-09-14 ~20:20 CEST)

Los creó la verificación adversarial **después** del primer `--apply` de la
sección 4 y los retiró el segundo `demo:refresh --apply` (nota de cierre al
inicio de §6); los predicados del script (`name ILIKE 'AUDIT%'`, marcas AUDIT
en reservas/huéspedes/roles/usuarios) los recogieron sin ajustes manuales. Lo
que había y lo que quedó:

- Organización «AUDIT-T4 Plantillas SL» (`cmu1j1jke0015fywho08009co`) con la
  propiedad «AUDIT-T4 Hotel Plantillas» (0 habitaciones) y sus roles plantilla
  Owner (211) / Manager (85) / Recepción (18) / Housekeeping (2) → la borró la
  **Fase A** (precondición 0 facturas con hash cumplida). Hoy `organizations
  WHERE name ILIKE 'audit%'` = 0.
- Usuarios `audit-t4-recepcion@example.com` y `audit-t4-owner@example.com` y
  los roles «AUDIT-T4 Recepción» (`receptionist`, 18) / «AUDIT-T4 Admin-cross»
  (`housekeeper`, 2) de Faranda → borrados por la **Fase B**. Hoy `users` = 2
  y `roles` = 2 (§6.1); Faranda solo conserva su «Owner».
- `group_bookings`: **AUDIT-T4-REG** (`cmu1jf3sc00b7fywh37ofpbd5`, «AUDIT-T4
  Regresion (fixture)», `draft`) **sigue existiendo** porque su única reserva
  es KEEP (regla: un grupo AUDIT solo se borra si todas sus reservas son
  borrables); AUDIT-T4-REG2 y AUDIT-T4-REG2-001 se borraron (árbol completo).
  - **AUDIT-T4-REG-001** (`checked_out`, 1 folio `open` + 1 `closed`) →
    **KEEP vigente** por **FAC-2026-000022** (F1, `cancelled`, con
    `verifactu_hash` y `cancellation_hash`).
  - Nota: el informe del auditor atribuía la factura a REG2-001 y «sin folio» a
    REG-001; la BD decía lo contrario y así se aplicó.
- **RES-00034** («AUDIT-T4 Dataset», FAC-2026-000021 `issued` con hash) →
  **KEEP vigente**: pasó de `checked_in` a `checked_out` por servicio
  (1 folio `open`). RES-00035 (`cancelled`, sin factura) se borró.
- Huéspedes: «Audit CuatroReg» queda enlazado a las dos KEEP anteriores;
  «Audit CuatroRegTres» se borró. **Residuo:** «Audit CuatroRegDos»
  (`guests`, org Faranda, **0 `reservation_guests`**) sobrevivió porque su
  reserva (AUDIT-T4-REG2-001) cayó en la misma pasada y el barrido de
  huéspedes solo miraba «exclusivos del conjunto borrado»; el lote *api-codigo*
  de la re-verificación hace borrables los huéspedes `Audit*` sin reservas, de
  modo que la **siguiente ejecución** de `demo:refresh --apply` lo retira
  (hasta entonces el dry-run lo lista como 1 fila en `guests`).

Cifras vigentes (SELECT 2026-09-14 tras el cierre): reservas AUDIT KEEP en
Faranda 20 (§6.2), `group_bookings` AUDIT 1, huéspedes `Audit*` 13 (12 con
reserva + CuatroRegDos), usuarios/roles/orgs AUDIT 0.

### 6.4 · Edificios de Faranda (confirmado)

Faranda tenía **0 edificios** al ejecutar el refresco, por lo que el readiness
`default_building_exists` (blocking) estaba en `fail` («Se necesita al menos un
edificio (o edificio por defecto)»). Era un defecto **preexistente** al
dataset, no lo introducía el refresco. Cierre de la Tanda 4: el edificio se
creó por API (`POST /backoffice/properties/:id/buildings` con la sesión de
Carmen en :3400 → `bld_4bdad9e6` «Edificio principal», código `PRINCIPAL`) y
se recalculó el readiness (`POST …/readiness/recalculate`, que es lo que
actualiza `property_readiness_checks`; el GET sirve la última foto):
`default_building_exists = pass`. Faranda queda `blocked` solo por los dos
checks de SES.HOSPEDAJES (`ses_hospedajes_credentials`,
`ses_establishment_profile`: número de registro y credenciales reales que
solo puede aportar el hotel) y el aviso `verifactu_software_declared`
(`VERIFACTU_SOFTWARE_*` por rellenar antes de salir de sandbox).
