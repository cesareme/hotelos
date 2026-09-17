# Rebrand → ehotelOS · informe de integración (2026-09-17)

Informe fechado del cambio de marca Anfitorio/HotelOS → **ehotelOS** en
`~/anfitorio-demo/hotelos` (7 lotes de `rebrand-plan.json`, decisiones D1-D16 de
`rebrand-decisions.md`). Es un documento histórico: cita a propósito los nombres
anteriores y vive en `docs/audits/`, que el contrato de marca no barre.

Grafía exacta de la marca: `ehotelOS` (e minúscula, hotel, OS mayúsculas; también
a principio de frase). Dominio `ehotelos.com`; demo `https://demo.ehotelos.com`.

## 1. Alcance

- **Sí cambia**: todo lo visible por personas — interfaz del back office (PWA:
  título, manifest, icono «e», service worker), portal del huésped, app móvil,
  correos y PDFs de la API, mensajes de error y de CLI, simulador `demo/`,
  documentación viva (README, CLAUDE.md, README-INSTALL, runbooks, specs de
  diseño de `docs/design/*.md` salvo `olas/`), deploy (banners, `Description=`
  de las unidades, Caddyfile, instalador) y los nombres de los datos ficticios
  de demo (BD local por SQL, seeds y demo-store con nombres neutros de D3).
- **No cambia**: identificadores técnicos y de protocolo, la infraestructura del
  VPS, la razón social/NIF del productor VeriFactu, los registros VeriFactu ya
  remitidos, los documentos históricos y las migraciones Prisma (§3).
- Fuente única de la marca: `apps/admin-web/src/config/brand.ts`
  (`name: "ehotelOS"`, `legalSuffix: ""`, `domain`, `demoUrl`,
  `supportEmail: soporte@ehotelos.com`, `helpUrl: https://ayuda.ehotelos.com`,
  `guestPortalHost: huesped.ehotelos.com`), con copias mínimas en
  `apps/guest-web/src/config/brand.ts`, `apps/mobile/src/config/brand.ts` y
  `apps/api/src/lib/brand.ts`. Importan `BRAND`: 34 ficheros de
  `apps/admin-web/src` (fuera de tests), 22 de `apps/api/src`, 3 de guest-web y
  4 de mobile. El contrato `tests/brand-contract.test.mjs` (10 aserciones) fija
  la fuente, exige las 4 copias iguales, barre el inventario visible
  (`VISIBLE_ROOTS`, 45 raíces) y vigila grafía, dominios antiguos, superficies
  fijas y el SIF VeriFactu por defecto.

## 2. Lotes y ficheros

Cambios en el árbol (sin commit, una sola rama, D12): 184 ficheros modificados
en `hotelos/` (+966/−695 líneas, sin contar `apps/api/docs/openapi.yaml`
regenerado: +1.919/−1.276) más 6 ficheros nuevos (742 líneas) y 2 workflows en
el repo padre. Lista completa en el apéndice A.

| Lote | Contenido | Ficheros principales |
|---|---|---|
| 1 · brand-core | Fuente de marca, 3 copias, contrato | `apps/admin-web/src/config/brand.ts`; nuevos `apps/{guest-web,mobile}/src/config/brand.ts`, `apps/api/src/lib/brand.ts`, `tests/brand-contract.test.mjs` (486 líneas) |
| 2 · admin-web | Codemod literal → `BRAND.name`, PWA, icono «e», nav CSV, dominios D2, Sage 200 (Tanda 7c, posterior al plan), glosario | 42 ficheros de `apps/admin-web/**` (Sidebar, AuthShell, Login/AcceptInvite/ChangePassword, About, help-articles, rate-grid, pms-shadow, reservations, Sage200ImportScreen + helpers, CocoaSearchableHelpModal, GuestPortalSettingsScreen, e2e/login.spec.ts); `dist/` regenerado con `build` |
| 3 · guest-web, mobile, worker | Título del portal, wordmark, `app.json` name, textos y mocks con nombres D3 | `apps/guest-web/{index.html,src/api/client.ts,src/components/Layout.tsx}`, `apps/mobile/{app.json,App.tsx}` + 12 pantallas/servicios; worker sin cambios de código |
| 4 · API, ai-gateway, packages | Correos, PDFs (`/Producer`), mensajes, OpenAPI `title: ehotelOS API`, SIF por defecto, env-contract regenerado, seeds y demo-store D3, docs/compliance §4.7 | 45 ficheros de `apps/api/**`, `apps/ai-gateway/src/onboarding-agents.ts`, `packages/{compliance,shared,product,ui,onboarding,integrations}`, `packages/database/{prisma/seed.ts,prisma/seed-operations.ts,seeds/local-demo.seed.ts,MIGRATIONS_README.md}`, `docs/compliance/*.md`, `.env.example`, `deploy/.env.production.example`, `scripts/env-{census.mjs,contract.json}` |
| 5 · deploy y docs vivos | `demo.ehotelos.com`, bloque 301 en `Caddyfile.native`, sed del instalador sincronizado, banners, `Description=` systemd, README-INSTALL §9, CLAUDE.md «Marca y despliegue», runbooks, specs `docs/design/*.md` (D16) | `README.md`, `CLAUDE.md`, `deploy/**` (18 ficheros), `scripts/*.{sh,mjs}`, `docs/runbooks/{opera-modo-sombra,finanzas-contabilidad,finanzas-importacion-sage200,rate-grid-v2,vps-demo-actualizacion-2026-09-17}.md`, 9 specs de `docs/design/*.md`, `docs/api-contracts.md`, `../.github/workflows/{ci,deploy}.yml` (solo comentario :1) |
| 6 · tests existentes y simulador | Marcadores de contratos raíz, integración (CORS, structure-l5), Playwright, `demo/` | 8 tests raíz, 3 de `tests/integration/`, `apps/admin-web/e2e/*`, `demo/{public/index.html,public/app.js,server.mjs}` |
| 7 · datos de demo por SQL | 4 filas ficticias + verificación | nuevos `scripts/sql/rebrand-ehotelos-demo.sql` (127 líneas) y `rebrand-ehotelos-demo.verify.sql` (89) |

Regenerados con su script, nunca a mano: `apps/admin-web/src/navigation/nav-tree.generated.json`
(`build-nav-tree.mjs`, desde el CSV canónico `~/anfitorio-demo/pilots/tanda5-nav-tree.csv`,
D15), `.env.example` / `deploy/.env.production.example` / `scripts/env-contract.json`
(`env-census.mjs --write`), `apps/api/docs/openapi.yaml` (`generate-openapi.mjs`),
`docs/design/cocoa-22-inventory.json` (`cocoa-22-inventory.mjs`), el bloque §6 de
`docs/design/COCOA-22-MIGRACION.md` (`cocoa-22-waves.mjs --write`) y `apps/admin-web/dist`
(`vite build`).

## 3. Conservado a propósito (y por qué)

Barrido final de la marca anterior con límite de palabra (`\b(Anfitorio|ANFITORIO|HotelOS|hotelOS|Hotel OS)\b`)
sobre todo el árbol (código, docs, deploy, tests, `demo/`, `figma/`, `.github`; sin
`node_modules`, `dist`, `.expo`, `.git`): **641 líneas en 162 ficheros, 0 residuos visibles**.
Clasificación:

| Clase | Líneas / ficheros | Motivo |
|---|---|---|
| Históricos (allowlist `HISTORICAL` del contrato + `docs/chat-transcript-readable.md`) | 432 / 68 | Auditorías fechadas (`docs/audits`), estrategia, olas Cocoa 22, `docs/cocoa-design`, piloto, READMEs marcados OBSOLETO (fijados por `deployment-contract`), `demo/partner-demo`, `design-tokens/hotelos.tokens.json` (fijado por `front-ui-aurora-contract`), dos addenda de 2026-05 |
| Comentarios de código que empiezan línea | 120 / 56 | No visibles; el contrato los blanquea. 9 cabeceras «Directriz HotelOS (Nov 2026)» (nombre propio de la directriz), 8 en `schema.prisma`, 9 en los espejos `.js` gitignorados de `packages/shared/src` y `packages/compliance/.../verifactu` (borrado en tanda aparte, D16), resto prosa interna de modo sombra/Sage/OPERA |
| Documentación interna fuera del inventario | 29 / 14 | Specs y addenda de primera generación en inglés (`docs/product-spec.md`, `backoffice-addendum`, `advanced-modules-addendum`, `revenue-*-addendum`, `spain-guest-register-compliance`, `property-configuration-category-manager`, `ai-onboarding-migration.md:3`), guías `docs/CLAUDE-CODE-{GUIA,PRO}.md`, `docs/rate-manager/DESIGN-PROPOSAL.md`, `figma/*.md` y `docs/design-system/DESIGN-SYSTEM-DECISION.md` (nombre propio «HotelOS Aurora» del sistema de diseño y cita literal de una cabecera CSS). Mismo criterio que los dos addenda de `HISTORICAL`: no son UI. Decisión pendiente (§9) |
| Identificadores técnicos y de protocolo | 23 / 12 | `X-HotelOS-Idempotency/Signature/Event/Delivery`, `X-Anfitorio-Webhook-Secret/Signature/Simulator` (D7, visibles a integradores: cambiarlos rompe clientes), y su documentación |
| Productor VeriFactu | 15 / 9 | Razón social del productor «Anfitorio Software SL» y `ANFITORIO-VRF-01` en fixtures (`software.test.mjs`, `xml.test.mjs`, `env.test.mts`, `structure-l3-invoicing.test.mts`, `xml-rectificativa.test.mjs`) y el pin `VERIFACTU_SYSTEM_NAME=Anfitorio` documentado (README-INSTALL §9, CLAUDE.md, compliance §4.7.5, runbook del VPS): §4 |
| El propio contrato | 10 / 1 | Expresiones regulares de `tests/brand-contract.test.mjs` |
| Guardas SQL | 5 / 1 | `WHERE name IN ('HotelOS Demo Group', …)` del lote 7: idempotencia por valor antiguo |
| Migraciones Prisma | 4 / 3 | Inmutables (`20260914000000_baseline_squash`, `20260917110000_sage200_importacion`, `migrations-archive`) |
| Fixtures de tests fijados por contratos | 3 / 2 | `front-ui-aurora-contract.test.mjs:25,108` («HotelOS Aurora Design System», nombre del DS) y `modular-suite-contract.test.mjs:36` (lee un addendum histórico) |

Además, sin marca visible pero conservados por diseño: `@hotelos/*` (paquetes),
`HOTELOS_*` (entorno), `HotelOSTabs`, `HotelOSTokens`/`hotelOSTokens`/`hotelOSFlowTokens`,
`HotelOsToolName`, claves localStorage `hotelos.*`/`anfitorio.*` (D11: renombrarlas perdería
preferencias y borradores), eventos `hotelos-*`, `hotelos://` (deep links y QR de activos),
`secret://hotelos/…`, funciones SQL `hotelos_*()`, unidades `anfitorio-api`/`anfitorio-worker`,
rutas `/opt|/etc|/srv|/var/backups|/var/log/anfitorio`, usuario/BD/rol `anfitorio`,
sudoers `anfitorio-deploy`, `service: hotelos-api|hotelos-worker` en `/health`
(observability-contract), MsgId SEPA `HOTELOS-…`, placeholders `erased+<id>@hotelos.example`
del borrado RGPD (D9), contraseña demo `hotelos-demo`, `admin@hotelos.local`, código
`HOTELOS_DEMO`, slug/scheme/bundleId de la app móvil (D13), el id de gradiente `anf-g` del
icono, el directorio `docs/strategy/anfitorio-equipo-2026-06` (lo lee
`rate-grid-docs-contract`) y el nombre de fichero `packages/ui/src/tokens/hotelos-flow.tokens.ts`.
Grafía: 0 grafías incorrectas de «ehotelOS» en todo el árbol (ni la e ni la h en mayúscula;
minúsculas solo dentro de dominios e identificadores).

## 4. Cautela VeriFactu / TicketBAI y variable de producción

- El nombre del sistema informático (`NombreSistemaInformatico`) es un dato **declarado ante la
  AEAT**, no un texto de marca: por eso el SIF **no** usa `BRAND.name`. Los valores por defecto
  en código han pasado a `ehotelOS` / `1.0.0` (`packages/compliance/src/spain/verifactu/software.ts`
  `VERIFACTU_SOFTWARE_DEFAULTS` :108-111; `apps/api/src/lib/env.ts` `VERIFACTU_SYSTEM_NAME`
  default/example :470-472; `VERIFACTU_SYSTEM_VERSION` vacía = `APP_VERSION` y, en su defecto,
  `1.0.0`). Contrato: `it("SIF VeriFactu por defecto")` y `tests/env-contract.test.mjs`.
- **Registros existentes intactos**: ninguna fila de `verifactu_submissions` (41 con `xml_payload`,
  22 con `software_json`), `invoices` (8 con el emisor antiguo en el snapshot fiscal) ni
  `audit_events` se ha editado; el verify del lote 7 lo prueba por md5 (§6). El bloque
  `SistemaInformatico` no entra en la huella ni en `RegistroAnterior`: el encadenamiento no se
  rompe por cambiar el nombre. Los PDF de FAC-2026-000001…000006 seguirán mostrando el emisor
  antiguo (esperado, R5).
- **Variable de producción (D4)**: hasta que César firme la nueva declaración responsable,
  `/etc/anfitorio/api.env` del VPS debe llevar (añadir si faltan)
  `VERIFACTU_SYSTEM_NAME=Anfitorio` y `VERIFACTU_SYSTEM_VERSION=0.1.0` — el nombre y la
  versión de la declaración vigente, los mismos de los registros ya remitidos. Sin el pin, el
  siguiente despliegue emitiría `<sum1:NombreSistemaInformatico>ehotelOS</…>` y
  `<sum1:Version>1.0.0</…>` sin declaración firmada, y las filas `pending`/`retrying` se
  reconstruyen con el bloque vigente en cada intento: drenar la cola antes del cambio.
  Documentado en `docs/compliance/verifactu-declaracion-responsable.md` §4.7 (puntos i-v),
  `deploy/README-INSTALL.md` §9 paso 4, `CLAUDE.md` «Marca y despliegue» y el runbook del VPS
  (§4.1 tabla de claves y §4.2 generador). El contrato admite ese literal solo como
  `VERIFACTU_SYSTEM_NAME=Anfitorio` (excepción explícita en `TECHNICAL`).
- **Secuencia para el cambio**: mantener `VERIFACTU_SYSTEM_ID=01` y los `NumeroInstalacion`;
  firmar la declaración con `ehotelOS` / `1.0.0`; retirar los dos pines juntos; comprobar
  `GET /compliance/health` → `verifactu.software.ok` y un envío en `preproduction`.
- **TicketBAI**: `resolveTbaiSoftware` copia `nombreSistema` en `<Software><Nombre>`; misma
  secuencia ante la diputación foral y **no cambiar el nombre en `TBAI_MODE=production`** sin
  confirmar que `TBAI_LICENSE_KEY` no está ligada al nombre anterior (§4.7.4).
- La razón social y el NIF del productor (`VERIFACTU_SOFTWARE_NAME` / `_NIF`) no cambian con la
  marca (solo con una cesión del producto, §4.5).

## 5. Dominio y DNS

- El código apunta ya a `https://demo.ehotelos.com` (D5a). `deploy/caddy/Caddyfile.native`:
  `email admin@ehotelos.com` (ACME), bloque `demo.ehotelos.com {` y bloque **aparte** de
  transición `demo.hotelos.es { redir https://demo.ehotelos.com{uri} permanent }` (un fallo
  ACME de un host no bloquea al otro). `deploy/scripts/install-from-scratch.sh:466` aplica el
  `sed` sincronizado (R3): primero `/^demo\.hotelos\.es {$/,/^}$/d` (las instalaciones nuevas
  no piden certificado para el dominio anterior), después `s#demo\.ehotelos\.com#$DOMAIN#g`,
  `s#admin@ehotelos\.com#$ACME_EMAIL#` y la ruta del front. Dry-run verificado: con
  `DOMAIN=x.example` queda un solo sitio y 0 apariciones del dominio anterior. `caddy validate`
  no se ha podido ejecutar en este Mac (sin `caddy` ni `docker`): queda para el VPS.
- Pasos manuales en el VPS (README-INSTALL §9 «Corte de dominio», en este orden): 1) DNS
  `A demo.ehotelos.com → 76.13.55.180` (VPS demo; 72.61.194.216 es el VPS de desarrollo) y
  `dig +short` antes de recargar Caddy; 2) buzón `admin@ehotelos.com` existente; 3) `deploy.sh`
  no regenera `/etc/caddy/Caddyfile` en `production-native`: `sudo cp deploy/caddy/Caddyfile.native
  /etc/caddy/Caddyfile` + `sudo caddy validate` + `sudo systemctl reload caddy`; 4)
  `/etc/anfitorio/api.env`: `APP_BASE_URL`, `API_PUBLIC_URL`, `CORS_ALLOWED_ORIGINS` (origen nuevo
  y, en transición, el antiguo) y el pin VeriFactu de §4; reiniciar unidades y reconstruir el
  front con `VITE_API_URL=https://demo.ehotelos.com/api`; 5) GitHub: VALOR de `vars.PUBLIC_DOMAIN`
  → `demo.ehotelos.com`; 6) `bash deploy/scripts/smoke.sh --base-url https://demo.ehotelos.com/api
  --web-url https://demo.ehotelos.com` y `curl -I` al dominio anterior → 301; 7) retirar el bloque
  de transición cuando caduque; 8) infraestructura intacta (§3).
- Vía compose (secundaria): `deploy/Caddyfile` con `{$DOMAIN:ehotelos.com}` y
  `docker-compose.production.yml` con `demo.ehotelos.com` como placeholder.

## 6. Datos de demo cambiados por SQL (lote 7)

`scripts/sql/rebrand-ehotelos-demo.sql` (una transacción, idempotente, guardas por id y por
valor antiguo o nuevo; `ROLLBACK` si alguna fila lleva otro valor) renombra **solo 4 filas
ficticias** con los nombres neutros de D3 (el producto no es razón social del emisor de
facturas de demo): `organizations.org_123` «Grupo Hotelero Demo» / «Grupo Hotelero Demo SL»
(tax_id B12345674 intacto); `legal_entities` seleccionada por `(organization_id='org_123',
code='HD')` (único en Prisma; el id `le_cd71d66e` es un cuid solo de la BD local) → «Grupo
Hotelero Demo SL»; `properties.prop_123` «Hotel Demo Madrid Centro» / «… SL» / trade_name
«… SL» (código AMC intacto); `properties.prop_canary` «Hotel Demo Tenerife Sur» (código ATS
intacto). Después: reinicio del API (espejos in-memory), `POST /backoffice/properties/{prop_123,
prop_canary}/readiness/recalculate` y `rbac:sync`.

Estado de la BD local (`verify.sql`, solo lectura, 2026-09-17): residuos 0/0/0; readiness
`pass` «Razón social del emisor (sociedad): Grupo Hotelero Demo SL.» en prop_123 y
prop_canary (17 filas cada una); `rbac admin.tenants.manage` = «Manage platform tenants
(ehotelOS staff console…)». Invariantes intactas: `invoices` con marca antigua 8
(md5 0018a4eb…), `verifactu_submissions` xml 41 (ec5ec56b…) / software_json 22 (ac3744ff…),
`verifactu_installations` 3, `notification_deliveries` 95, `audit_events` 27.731
(4071935c…), `journal_entries` 5.004 / `journal_lines` 21.231, Faranda (1 organización, 8
propiedades) y CELUISMA S.A. intactas, códigos AMC/ATS/HD, `assets.qr_code_value hotelos://` y
`secret://hotelos/` conservados. NO editados por diseño: 8 `invoices.issuer_legal_name`, 8
`verifactu_submissions.xml_payload` y 1 `notification_deliveries.body_rendered` con la marca
antigua, y los huérfanos de tests (candidatos a `demo:refresh`).

Pendiente en el VPS demo tras desplegar el lote 5: `scripts/backup-postgres.sh` (o `pg_dump`),
`psql $DATABASE_URL -v ON_ERROR_STOP=1 -f scripts/sql/rebrand-ehotelos-demo.sql` con el verify
antes y después, reinicio del API, recálculo de readiness y `rbac:sync`. Si el VPS ya fue
re-sembrado con `prisma db seed`, el script sigue haciendo falta para `legal_entities` y
`trade_name` (el upsert del seed no los converge).

## 7. Puertas (última pasada, árbol final)

| Puerta | Resultado |
|---|---|
| `corepack pnpm typecheck:all` | 15 PASS · 0 FAIL · 0 XFAIL · 1 SKIP explícito (guest-web) · 18,2 s |
| `corepack pnpm --filter @hotelos/api test` | 2.051 tests · 2.050 pass · 0 fail · 1 skipped · 629 suites · 5,2 s (base del brief 2.043/2.044: +7 tests nuevos verdes) |
| Front admin-web (`cd apps/api && TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test $(find ../admin-web/src -path '*/__tests__/*.test.mts')`, 93 ficheros) | 1.149 / 1.149 · 341 suites · 1,47 s |
| Tests raíz (`node --test tests/*.test.mjs`, 57 ficheros) | 468 / 468 · 97 suites · 1,63 s; **contrato de marca 10/10** (fuente, 4 copias, raíces, allowlist, ningún Anfitorio/HotelOS visible, grafía, literales acotados ≤ 4, superficies fijas, SIF, dominios) |
| Integración (`tests/integration/*.test.mts`, 33 ficheros, API :3000 en `/health` 200) | 463 tests · 457 pass · 0 fail · 6 skipped conocidos (folios H2 sin folio abierto; 4 sin `INTEGRATION_RECEPTION_*`; 1 sin `INTEGRATION_FNB_EMAIL`) · 7,5 s |
| `node scripts/check-discoverability.mjs` | OK: aliases 24 (missing 0), retired 0, sin URL 0, broken links 0; placeholders 16/20 |
| `node scripts/build-nav-tree.mjs --check` | up to date (67 items, 101 tabs, 205 legacy routes) |
| Cocoa 22 (`cocoa-22-inventory.mjs` regenerado → JSON sin cambios; `cocoa-22-waves.mjs --write` → solo la línea de totales, `--check` «§6 al día») | 222 pantallas · 92.353 líneas · 194 puntos · bo-card 0 · `<button>` 0 · `<table>` 2 · inputs crudos 0 · colores literales 0 · `style={}` 682 = techo `GLOBAL_CEILING.inlineStyles` (0 nuevos); `tests/cocoa-22-contract.test.mjs` 18/18 |
| `corepack pnpm --filter @hotelos/admin-web build` | ✓ built in 2,50 s; `dist/{index.html,manifest.webmanifest,icon.svg,sw.js}` 0 «Anfitorio»; contienen «ehotelOS · Back Office», `"name": "ehotelOS"`, `aria-label="ehotelOS"`, `ehotelos-shell-v1`; bundles sin residuos fuera de identificadores |
| `corepack pnpm --filter @hotelos/worker typecheck` / `@hotelos/mobile typecheck` | EXIT 0 / EXIT 0 (mobile y guest-web no tienen script `build`; el `build` del worker falla por 65×TS6059 preexistentes) |
| `corepack pnpm --filter @hotelos/guest-web typecheck` | exit 2 con **266 errores preexistentes** (233 TS7026, 21 TS7016, 10 TS7006, 2 TS7053: falta `@types/react`; arreglarlo exige regenerar `pnpm-lock.yaml`, prohibido); 0 atribuibles al rebrand |
| `node scripts/env-census.mjs --write` · `node apps/api/scripts/generate-openapi.mjs` | sin diff en `.env.example`, `deploy/.env.production.example`, `scripts/env-contract.json`, `apps/api/docs/openapi.yaml` (`title: ehotelOS API`) |
| `bash -n deploy/scripts/*.sh scripts/*.sh` · sed dry-run del instalador | 12/12 OK · 0 apariciones del dominio anterior; `shellcheck`, `caddy validate` y `docker` no disponibles en este Mac (CI y VPS) |
| `psql … -f scripts/sql/rebrand-ehotelos-demo.verify.sql` (BD local) | residuos 0/0/0, invariantes de §6 |

## 8. Hallazgos y correcciones

Cerrados por los lotes y verificados en esta integración (una pasada previa de la misma
ronda había dejado el contrato 10/10 sin reportarlo): contrato contradictorio en
`TECHNICAL` (el `sed` escapado del instalador disparaba «grafía exacta» → barra opcional
`ehotelos\\?\.`); orden del `sed` del instalador (el rango `d` va primero: con
`DOMAIN=demo.hotelos.es` borraría el bloque principal); 15 etiquetas «Anfitorio» de Sage 200
(Tanda 7c, posterior al plan) en `Sage200ImportScreen.tsx` y `sage200-import-helpers.ts` +
test, coherentes con `packages/shared/src/ledger-import-types.ts`; dominios `hotelos.app` →
`BRAND.supportEmail` / `helpUrl` / `guestPortalHost`; 63 literales `ehotelOS` del codemod
rehechos con `${BRAND.name}` (quedan 32, todos en comentarios blanqueados o en
`nav-tree.generated.json`, ALLOWED_LITERALS); runbook `finanzas-importacion-sage200.md`
27 → 0; `glossary.ts:124` («el PMS de ${BRAND.name}»); nombres demo cruzados mobile/seed
(«Hotel Demo»); MV-09 (el producto ya no es nombre de entidad demo: «Proyecto de onboarding
de demo», organización de respaldo «Grupo Hotelero Demo», propiedad de respaldo «Hotel
Demo»); TF-07 (`legal_entities` por `(org, code)` en vez del cuid local); D16 aplicado al
runbook del VPS (36 apariciones de `demo.ehotelos.com`, 0 del anterior; 12 líneas con nombres
D3; nota de rebrand en la cabecera) y retirado de `HISTORICAL`.

Correcciones de esta ejecución (barrido final fuera del inventario del contrato):
`package.json:5` description «Mobile-first ehotelOS monorepo…»; `docs/ai-onboarding-migration.md:128`
(el seed ya no expone «HotelOS Demo Onboarding Project» sino «Proyecto de onboarding de demo»);
`docs/booking-adapter.md:11` y `docs/channel-manager-connectivity.md:277` (docs vivos en
español que describen el producto actual, leídos por `rate-grid-docs-contract`);
`packages/compliance/.../timestamp/__tests__/xml-rectificativa.test.mjs:38` (`nombreRazon`
del productor alineado con el resto de fixtures: «Anfitorio Software SL»; 8/8 tests).
Regenerado `docs/design/COCOA-22-MIGRACION.md` §6 (línea de totales: 92.339 → 92.353 líneas).

Observaciones que no son del rebrand: `pnpm-lock.yaml` aparece modificado en el árbol (+52
líneas: `@fontsource-variable/inter`, `zod`, `@playwright/test` en admin-web y
`qrcode-terminal`) por trabajo anterior no commiteado — no se ha tocado; `packages/shared/src/.index.ts.swp`
(swap de vim, ignorado por el contrato) debería borrarse; ESLint 9 sin `eslint.config.*` en
ningún workspace (`pnpm -r lint` no ejecutable, preexistente); `apps/worker build` con 65×TS6059
(deuda CLAUDE.md §10); e2e Playwright: 4 de 5 specs se saltan en la puerta de login (TODO
dev-bypass), no ejecutada en esta pasada; el API :3000 sigue con el proceso anterior al lote 4
(lo reinicia el orquestador; correos, PDFs y espejos in-memory con la marca nueva solo tras el
reinicio); los cambios de `.github/workflows` viven en el repo git padre (commit aparte, R11) y el
CSV del menú en `~/anfitorio-demo/pilots` (git-ignored).

## 9. Decisiones que quedan para César

1. **Razón social titular (D1)**: `BRAND.legalSuffix` está vacío y el «Acerca de» imprime
   «© 2026 ehotelOS». Cuando se confirme la sociedad, editar `legalSuffix` en `brand.ts` y sus
   3 copias (el contrato exige que coincidan) y revisar `env.ts:461`. La razón social/NIF del
   productor VeriFactu no cambia.
2. **Buzones y hosts (D2)**: crear `soporte@ehotelos.com`, `https://ayuda.ehotelos.com`,
   `huesped.ehotelos.com` (portal del huésped), `admin@ehotelos.com` (ACME) y el remitente real
   de SendGrid (nombre visible «ehotelOS», dominio por env) antes del corte.
3. **Declaración responsable VeriFactu (D4)**: fecha de firma con
   `NombreSistemaInformatico = ehotelOS` y `Version = 1.0.0`; hasta entonces mantener el pin
   `VERIFACTU_SYSTEM_NAME=Anfitorio` / `VERIFACTU_SYSTEM_VERSION=0.1.0` en `api.env`, drenar
   la cola `pending`/`retrying` antes de retirarlo y verificar `/compliance/health` y un envío en
   `preproduction`.
4. **Licencia TicketBAI (D4d)**: confirmar con la diputación foral si `TBAI_LICENSE_KEY` está
   ligada al nombre anterior antes de cambiarlo en `TBAI_MODE=production`.
5. **Momento del cambio de dominio (D5)**: crear el registro `A demo.ehotelos.com → 76.13.55.180`
   y ejecutar el corte de §5; después aplicar el SQL del lote 7 en el VPS (§6) y decidir cuándo
   retirar el bloque de transición 301 de `Caddyfile.native`.
6. Menores: borrar en una tanda aparte los 21 espejos `.js` gitignorados (D16); decidir si las
   14 docs internas de §3 (29 líneas) entran en `HISTORICAL` o se renombran en bloque; los
   textos de la app móvil siguen en inglés (fuera del rebrand); cablear ESLint 9 y
   `@types/react` de guest-web cuando se permita tocar el lockfile.

## Apéndice A · Ficheros cambiados (estado del árbol, sin commit)

`M` modificado · `??` nuevo. Rutas relativas a `hotelos/` salvo `.github/`.

    M .env.example
    M .github/workflows/ci.yml
    M .github/workflows/deploy.yml
    M CLAUDE.md
    M README.md
    M apps/admin-web/e2e/_helpers.ts
    M apps/admin-web/e2e/login.spec.ts
    M apps/admin-web/src/auth/AuthShell.tsx
    M apps/admin-web/src/components/cocoa-global/CocoaAboutDialog.tsx
    M apps/admin-web/src/components/cocoa-guidance/CocoaFirstRunWelcome.tsx
    M apps/admin-web/src/components/cocoa-guidance/CocoaSearchableHelpModal.tsx
    M apps/admin-web/src/components/cocoa-rate-grid/README.md
    M apps/admin-web/src/components/cocoa-rate-grid/RateGridStatusBar.tsx
    M apps/admin-web/src/components/cocoa-rate-grid/ReviewPublishDrawer.tsx
    M apps/admin-web/src/components/guide/GuideProvider.tsx
    M apps/admin-web/src/config/brand.ts
    M apps/admin-web/src/content/help-articles/getting-started.ts
    M apps/admin-web/src/content/help-articles/glossary.ts
    M apps/admin-web/src/content/help-articles/keyboard-shortcuts.ts
    M apps/admin-web/src/content/help-articles/spanish-compliance.ts
    M apps/admin-web/src/content/persona-guides/housekeeper.ts
    M apps/admin-web/src/content/persona-guides/maintenance.ts
    M apps/admin-web/src/content/persona-guides/receptionist.ts
    M apps/admin-web/src/layouts/BackOfficeLayout.tsx
    M apps/admin-web/src/layouts/__tests__/shell-cocoa22-contract.test.mts
    M apps/admin-web/src/layouts/__tests__/shell-structure-switcher.test.mts
    M apps/admin-web/src/navigation/Sidebar.tsx
    M apps/admin-web/src/providers/CocoaGlobalProvider.tsx
    M apps/admin-web/src/screens/accounting/Sage200ImportScreen.tsx
    M apps/admin-web/src/screens/accounting/__tests__/sage200-import-helpers.test.mts
    M apps/admin-web/src/screens/accounting/sage200-import-helpers.ts
    M apps/admin-web/src/screens/assistant/AssistantChatScreen.tsx
    M apps/admin-web/src/screens/auth/AcceptInviteScreen.tsx
    M apps/admin-web/src/screens/auth/ChangePasswordScreen.tsx
    M apps/admin-web/src/screens/auth/LoginScreen.tsx
    M apps/admin-web/src/screens/errors/CocoaNotFoundScreen.tsx
    M apps/admin-web/src/screens/guest-portal/GuestPortalSettingsScreen.tsx
    M apps/admin-web/src/screens/integrations/PmsShadowScreen.tsx
    M apps/admin-web/src/screens/integrations/pms-shadow-helpers.ts
    M apps/admin-web/src/screens/operations/FrontDeskDashboard.tsx
    M apps/admin-web/src/screens/reservations/ReservationImportScreen.tsx
    M apps/admin-web/src/screens/reservations/reservation-import-sync.ts
    M apps/admin-web/src/screens/revenue/RateGridEditorScreen.tsx
    M apps/admin-web/src/screens/revenue/RateJournalScreen.tsx
    M apps/admin-web/src/screens/structure/PropertyDrawer.tsx
    M apps/admin-web/src/screens/structure/SeriesAndInstallationsTab.tsx
    M apps/admin-web/src/services/__tests__/tenant-admin-contracts.test.mts
    M apps/ai-gateway/src/onboarding-agents.ts
    M apps/api/docs/openapi.yaml
    M apps/api/scripts/generate-openapi.mjs
    M apps/api/src/lib/__tests__/rbac-catalog.test.mts
    ?? apps/api/src/lib/brand.ts
    M apps/api/src/lib/demo-store.ts
    M apps/api/src/lib/env.ts
    M apps/api/src/modules/accounting/__tests__/modelo-111.test.mts
    M apps/api/src/modules/accounting/import/__tests__/ledger-import-posting.test.mts
    M apps/api/src/modules/accounting/import/__tests__/ledger-reconciliation.test.mts
    M apps/api/src/modules/accounting/import/ledger-import.posting.ts
    M apps/api/src/modules/accounting/import/ledger-import.service.ts
    M apps/api/src/modules/accounting/vat-books.service.ts
    M apps/api/src/modules/advanced/advanced-modules.service.ts
    M apps/api/src/modules/auth/__tests__/invitations.test.mts
    M apps/api/src/modules/backoffice/backoffice.service.ts
    M apps/api/src/modules/compliance/compliance-inspection.service.ts
    M apps/api/src/modules/financial-statements/pdf-writer.ts
    M apps/api/src/modules/invoicing/__tests__/invoice-pdf.test.mts
    M apps/api/src/modules/invoicing/__tests__/invoice-snapshot.test.mts
    M apps/api/src/modules/invoicing/__tests__/qr-encoder.test.mts
    M apps/api/src/modules/invoicing/__tests__/structure-l3-invoicing.test.mts
    M apps/api/src/modules/invoicing/pdf/pdf-writer.ts
    M apps/api/src/modules/notifications/__tests__/magic-link.test.mts
    M apps/api/src/modules/notifications/system-templates.ts
    M apps/api/src/modules/onboarding/onboarding.service.ts
    M apps/api/src/modules/payroll/export.service.ts
    M apps/api/src/modules/pms-shadow/__tests__/pms-shadow-rules.test.mts
    M apps/api/src/modules/pms-shadow/pms-shadow.rules.ts
    M apps/api/src/modules/pms/reservation-import.normalize.ts
    M apps/api/src/modules/pms/reservation-import.sync.ts
    M apps/api/src/modules/revenue/__tests__/hf-board.test.mts
    M apps/api/src/modules/revenue/export-center.service.ts
    M apps/api/src/modules/revenue/hf-board.service.ts
    M apps/api/src/modules/structure/__tests__/legal-entity.service.test.mts
    M apps/api/src/modules/structure/legal-entity.service.ts
    M apps/api/src/modules/webhooks/webhooks.service.ts
    M apps/api/src/schemas/pms-shadow.schemas.ts
    M apps/api/src/scripts/__tests__/backfill-legal-structure.test.mts
    M apps/api/src/scripts/__tests__/refresh-demo-dataset.test.mts
    M apps/api/src/scripts/backfill-snapshots.ts
    M apps/api/src/scripts/fix-demo-legal-identity.ts
    M apps/api/src/scripts/generate-sage200-demo.ts
    M apps/api/src/scripts/import-sage200.ts
    M apps/api/src/scripts/pms-shadow-pull.ts
    M apps/api/src/server.ts
    M apps/guest-web/index.html
    M apps/guest-web/src/api/client.ts
    M apps/guest-web/src/components/Layout.tsx
    ?? apps/guest-web/src/config/
    M apps/mobile/App.tsx
    M apps/mobile/app.json
    ?? apps/mobile/src/config/
    M apps/mobile/src/navigation/HotelOSTabs.tsx
    M apps/mobile/src/screens/DashboardScreen.tsx
    M apps/mobile/src/screens/LoginScreen.tsx
    M apps/mobile/src/screens/backoffice/ManualSetupPreviewScreen.tsx
    M apps/mobile/src/screens/dev/LocalDevLauncherScreen.tsx
    M apps/mobile/src/screens/dev/ModuleVisibilityDebugScreen.tsx
    M apps/mobile/src/screens/more/MoreScreen.tsx
    M apps/mobile/src/screens/onboarding/AISetupWizardScreen.tsx
    M apps/mobile/src/screens/onboarding/OnboardingProjectScreen.tsx
    M apps/mobile/src/screens/timeline/LiveTimelineScreen.tsx
    M apps/mobile/src/screens/today/TodayDashboardScreen.tsx
    M apps/mobile/src/services/api.ts
    M demo/public/app.js
    M demo/public/index.html
    M demo/server.mjs
    M deploy/.env.production.example
    M deploy/Caddyfile
    M deploy/Dockerfile.admin-web
    M deploy/Dockerfile.api
    M deploy/Dockerfile.worker
    M deploy/README-INSTALL.md
    M deploy/caddy/Caddyfile.native
    M deploy/docker-compose.production.yml
    M deploy/scripts/bootstrap-dev-vps.sh
    M deploy/scripts/bootstrap-vps.sh
    M deploy/scripts/deploy.sh
    M deploy/scripts/install-from-scratch.sh
    M deploy/scripts/setup-vps.sh
    M deploy/scripts/smoke.sh
    M deploy/scripts/vps-inventory.sh
    M deploy/systemd/anfitorio-api.service
    M deploy/systemd/anfitorio-worker.service
    M docs/ai-onboarding-migration.md
    M docs/api-contracts.md
    M docs/booking-adapter.md
    M docs/channel-manager-connectivity.md
    M docs/compliance/IMPUESTOS-INDIRECTOS-ES-2026.md
    M docs/compliance/verifactu-declaracion-responsable.md
    M docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md
    M docs/design/COCOA-22-MIGRACION.md
    M docs/design/COCOA-22.md
    M docs/design/DOCUMENTOS-DIGITALIZACION.md
    M docs/design/FINANZAS-COSTE-PERSONAL.md
    M docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md
    M docs/design/FINANZAS-IMPORTACION-SAGE200.md
    M docs/design/OPERA-CLOUD-MODO-SOMBRA.md
    M docs/design/RBAC-DEPARTAMENTOS.md
    M docs/design/REPUTACION-REVIEWS.md
    M docs/design/cocoa-22-inventory.json
    M docs/runbooks/finanzas-contabilidad.md
    M docs/runbooks/finanzas-importacion-sage200.md
    M docs/runbooks/opera-modo-sombra.md
    M docs/runbooks/rate-grid-v2.md
    M docs/runbooks/vps-demo-actualizacion-2026-09-17.md
    M package.json
    M packages/compliance/src/spain/ses-hospedajes/schemas/README.md
    M packages/compliance/src/spain/verifactu/__tests__/software.test.mjs
    M packages/compliance/src/spain/verifactu/__tests__/xml.test.mjs
    M packages/compliance/src/spain/verifactu/software.ts
    M packages/compliance/src/spain/verifactu/timestamp/__tests__/xades-t.test.mjs
    M packages/compliance/src/spain/verifactu/timestamp/__tests__/xml-rectificativa.test.mjs
    M packages/database/MIGRATIONS_README.md
    M packages/database/prisma/seed-operations.ts
    M packages/database/prisma/seed.ts
    M packages/database/seeds/local-demo.seed.ts
    M packages/integrations/src/adapters/messaging/sendgrid-email.adapter.ts
    M packages/onboarding/src/data-quality/checks.ts
    M packages/product/src/modules/module-manifest.ts
    M packages/shared/src/ledger-import-types.ts
    M packages/shared/src/permissions.ts
    M packages/shared/src/pms-shadow-types.ts
    M packages/shared/src/reservation-import-types.ts
    M packages/ui/src/components/shared.tsx
    M packages/ui/src/tokens/hotelos-flow.tokens.ts
    M pnpm-lock.yaml
    M scripts/backup-postgres.sh
    M scripts/backup-restore-check.mjs
    M scripts/check-fresh-install.sh
    M scripts/deploy-pilot.sh
    M scripts/env-census.mjs
    M scripts/env-contract.json
    ?? scripts/sql/
    M scripts/test-backup-restore-cycle.sh
    M tests/advanced-modules-contract.test.mjs
    ?? tests/brand-contract.test.mjs
    M tests/demo-preview-contract.test.mjs
    M tests/front-ui-aurora-contract.test.mjs
    M tests/integration/api-integration.test.mts
    M tests/integration/ledger-import.test.mts
    M tests/integration/structure-l5.test.mts
    M tests/navigation-visibility-contract.test.mjs
    M tests/safety.test.mjs
    M tests/ui-shift-flow-contract.test.mjs

    ?? docs/audits/REBRAND-EHOTELOS-2026-09-17.md (este informe)
