# Tanda L7 · Huésped y móvil — informe de cierre (2026-09-20)

**Encargo** (`scratchpad/tandaL7-brief.md`; Tanda 5 `docs/audits/TANDA-5-PLAN-2026-09-15.md` fila L7): cerrar el recorrido del
huésped de punta a punta sobre lo que ya existía —`apps/guest-web` (portal de la Tanda CHK: sesión por enlace, pre-check-in,
kiosco `?kiosk=1`, documentos e identidad, firma, pago o garantía con el contrato PSP sandbox, llave, bot), `apps/mobile`
(estado real), notificaciones al huésped y el «guest journey» del back office—: portal completo y accesible (WCAG 2.2, móvil
primero, ≥ 44 px), estados honestos (sin PSP real: «pago en recepción»), conexión con CHK (sesiones, identidad, firma), con
T8 (encuesta post-estancia) y con el asistente, e2e del portal con tenant propio y capturas sin nombres reales; `apps/mobile`
solo si aportaba valor demostrable en el plazo (si no, documentar). Worktree `~/anfitorio-demo-wt-l7/hotelos` (rama `tanda-l7`,
base `a069906` = main con CHK y T9 fusionadas), BD propia `hotelos_l7` (copia completa: Faranda + OPERA + tenants de prueba),
puertos `:3937` (API) · `:5207` (admin-web) · `:5237` (guest-web). Plan: recon delta de solo lectura
(`scratchpad/L7/recon-delta.md`: §0 receta de runtime, §1-17 delta frente a diseño y dosieres, §18 decisiones D1-D10, §19
contratos de rutas y tipos) → 4 olas · 10 lotes con ficheros exclusivos → puerta rápida por ola → cierre documental (L7-10)
→ revisión del carril en runtime (dos revisores: funcional-runtime y seguridad/datos/regresiones; 8 hallazgos medium
confirmados + 10 low, 0 refutados) → corrector L7-REV (18 corregidos con test, migración aditiva
`20260920210000_guest_portal_session_purpose`) → integrador (este informe definitivo, bloque final de
`docs/audits/ESTADO-VERIFICADO.md`, puertas y commit en la rama `tanda-l7`). Los hallazgos y su corrección están en §8.

**Working tree en el momento del commit** (`git -C ~/anfitorio-demo-wt-l7 status --porcelain`, integrador 2026-09-20
16:27): **65 ficheros modificados (+4.111 / −969) y 37 nuevos (10.649 líneas)**; `pnpm-lock.yaml` limpio (ningún lote lo
tocó; el recon lo vio `M` heredado y hoy no aparece) y excluido del commit por construcción (`git reset -q
hotelos/pnpm-lock.yaml` antes de `commit`). Hitos: tras L7-09 48 modificados (+3.353 / −893) + 33 nuevos (9.374 líneas);
tras L7-10 51 (+3.520 / −894) + 36 (10.034); tras el corrector 65 (+4.111 / −969) + 37 (10.649). Lista completa en §9.

**Datos:** toda verificación con escritura se hizo en el tenant aislado `org_chk` / `prop_chk` (`db:seed:checkin`, usuarios
`recepcion@chk.test` / `direccion@chk.test`, contraseña `chk-demo`) o en tenants `org_l2_*` que las suites de integración
crean y destruyen; Faranda solo lectura (invariantes idénticas al cierre de CHK: 13.457 reservas · 13.436 huéspedes, medidas
hoy por SQL de solo lectura). Titulares de las fixtures inventados («Prueba Portal», `prueba.portal.<marca>@chk.test`, MRZ
sintética); ningún nombre de persona real en código, tests, capturas, logs ni en este informe.

## 0. Resumen

- **Entregado:** portal del huésped completo en español (+ inglés) y accesible: acceso por código + correo o por enlace,
  asistente de 6 pasos de CHK con «Firmar en recepción», páginas nuevas «Salida y cuenta» (folio real, facturas PDF por
  token, peticiones de salida `SRQ-<8>`), «Información del hotel» y «Encuesta post-estancia» (NPS 0-10), pago honesto sin
  PSP, kiosco con aviso de inactividad accesible y ticket para el mostrador; API `modules/guest-portal/*` (6 rutas de
  huésped + `survey-invite` + `guest-journey`, legado `/session/:token` verificado, prefijos públicos), migración
  `20260920190000_portal_huesped_l7` (2 columnas), plantilla `post_stay_survey`, paso 5 del tick del check-in; back office:
  «Recorrido» de la reserva con 13 pasos reales, ajustes «Portal del huésped» honestos, copy de `/activity` en español;
  proyecto Playwright `guest` con 5 specs, helpers y README; runbook `docs/runbooks/portal-huesped.md`; inventario del móvil
  (`apps/mobile/README.md`, congelada como demo interna, D5).
- **Revisión y corrección:** dos revisores en runtime sobre el árbol cerrado (instancias propias, tenant CHK, SQL de solo
  lectura) → 8 hallazgos medium confirmados (3 funcionales: recorrido que heredaba la encuesta de otra reserva por
  prefijo de id, encuesta ofrecida a una confirmada con la salida pasada, reserva cancelada con «Salida y cuenta» y
  pago; 5 de seguridad/datos: sesión del enlace de la encuesta de 30 días con acceso a TODO el portal, peticiones de
  salida aceptadas tras el check-out, `settled/paid` con folio vacío, `GuestJourneyView` sin contrato documentado,
  ticket `K-nnnn` del kiosco inexistente en el servidor) + 10 low; 0 refutados; **18 corregidos** por el corrector
  L7-REV con test unitario/integración/e2e por corrección y segunda migración aditiva
  `20260920210000_guest_portal_session_purpose` (`guest_portal_sessions.purpose`); tabla completa en §8.
- **Puertas:** rápida 11/12 en las tres olas y al cierre (solo `nav-tree --check` rojo por el CSV compartido cambiado por
  la Tanda ACT; ajeno); **completa final 13/14 el 2026-09-20 a las 16:23** tras el corrector (`scratchpad/L7/gates-final.json`):
  typecheck 15 PASS · 0 FAIL · 1 SKIP (guest-web) · 21,0 s · api unit 3.637 (3.636 pass · 0 fail · 1 skip) · admin-web unit
  2.040 (2.039 · 0 · 1) · ai-core 119 · worker 34 · contratos raíz 796 (794 · 0 · 2 skip) · discoverability 197 URL ·
  route-access 15 × 197 · cocoa waves §6 al día · rbac dry-run OK · migrate status + drift «No difference detected.» (26/26) ·
  admin-web build OK (2,85 s) · integración 1.016 (1.008 pass · 0 fail · 8 skip); única roja `nav-tree --check` (CSV
  compartido de 304 filas con 10 pantallas de los carriles RRHH/ACT que no existen en este worktree; ajeno) (§4).
- **Runtime:** e2e `guest` 5/5 en 42,9 s al cierre L7-10 y **5/5 en 39,6 s tras el corrector** (16:09,
  `scratchpad/L7/corr-e2e-run2.log`, 32 capturas en `corr-e2e/`) contra `:3937/:5237/:5207` (§5); 97 capturas sintéticas
  de los lotes en `scratchpad/L7/` (`l701-*` 24, `l705-*` 21, `l706-*` 13, `l707-*` 2, `l708-*` 5, `e2e/` 32) + 32 del
  cierre (`l710-e2e/shots`) + 32 del corrector y 90 JSON de objetivos táctiles (57 + 33): 0 objetivos < 24 px en las 32
  pantallas del portal; sondas de API del corrector en `corr-probe.json` (sesión `survey` → 401 en 8 rutas,
  `no_charges`, 409 `STAY_CLOSED` / `STAY_REQUEST_NOT_ALLOWED`, handoff → `handed_off` + ticket → `resolve-handoff`).
- **Móvil:** sin valor demostrable en el plazo (maqueta con `prop_123`, sin `AuthProvider` montado, check-in por IA sin
  cámara ni firma): inventario verificado hoy en §6 y en `apps/mobile/README.md`; sin código.
- **Fusión:** ficheros aditivos en `server.ts`, `route-permissions.ts`, `auth-context.ts`, `system-templates.ts`,
  `checkin-jobs.ts`, `checkin.routes.ts`, `checkin-session.service.ts`, `front-desk-queue.service.ts`,
  `playwright.config.ts`, `api-contracts.md`; dos migraciones aditivas (`…190000_portal_huesped_l7`,
  `…210000_guest_portal_session_purpose`); regenerar `nav-tree.generated.json`, censo de variables y §6 de Cocoa 22 en la
  fusión; renumerar las migraciones si L8 aporta una marca posterior (§9).
- **Commit:** un único commit del integrador en la rama `tanda-l7` (título `feat(huesped): …`, cuerpo por lote, §10);
  nunca en `main`, sin `push`; `pnpm-lock.yaml` fuera; el sha va en el informe del orquestador.

## 1. Inventario por etapa: antes (recon 2026-09-20 11:02) → después

| Etapa | Antes (fichero:línea del recon) | Después (fichero:línea hoy · lote) |
|---|---|---|
| Acceso y marco | Portal en inglés fuera del asistente (`App.tsx:18-19,171`, `Layout.tsx:30`, `SignInPage.tsx:35-79`, `StayOverviewPage.tsx:13-18,133-206`, `PreCheckInPage.tsx:9-25`, `ServiceRequestPage.tsx:9-14`); `index.html:2 lang="en"` fijo; solo el asistente tenía es/en (`wizard.ts:380-712`); sin skip link; `.gp-chip` 40 px, `.gp-header-top` 32 px, `.gp-link` sin altura; texto secundario `#9a8a78` ≈ 3,2:1 | Todo el portal es/en desde `wizard.ts` (384 claves, `COPY_ES` :347, `COPY_EN` :739, `t()` :1129); selector en cabecera (`Layout.tsx:57-63`) sincronizado con `<html lang>` (`App.tsx:214-222`, `index.html` `lang="es"`); skip link (`Layout.tsx:43`); `min-height: 44px` (`styles.css:110,145,175,709,1028,1363`); `--gp-muted #726250` ≈ 5,7:1 (`styles.css:10`); `isApiConfigured()` y aviso «vista previa sin API» (`guest-config.ts:38-46`, `wizard.ts:603`) · **L7-01** |
| Sesión y token | Token en `sessionStorage` (ya desde CHK L0); `GET /guest-portal/session/:token` devolvía `active` para cualquier token (`server.ts:3275`); prefijos públicos solo `check-in` y `chat` (`auth-context.ts:78-101`) | Legado verifica y redacta (`server.ts:3287-3297`; `redactTokenInUrl` cubre también `/guest-portal/session/<token>` desde el corrector); prefijos `/guest-portal/stay`, `/invoices`, `/survey` (`auth-context.ts:107-109`); `issueGuestPortalSession` de 30 días para la encuesta (`guest-portal-auth.service.ts`, `POST_STAY_SURVEY_SESSION_TTL_MS`) con ámbito `purpose = survey` (columna `guest_portal_sessions.purpose`, migración `…210000`; `verifyGuestToken(token, { purposes })`: esa sesión SOLO abre `GET|POST /guest-portal/survey`, el resto 401); `?token=` únicamente en el PDF de la factura · **L7-02 · L7-04 · corrector** |
| Pre-llegada (asistente) | 6 pasos de CHK (`CheckInWizardPage.tsx` 1.017 líneas; `StepProgress` :137-163, `SignatureStep` :537-569); `SignaturePad` sin alternativa (2.5.7); toggle de idioma solo en el asistente; cámara no operable por teclado; `KioskShell.tsx:65-113` aviso de inactividad sin `role=alert` | `role="progressbar"` + `aria-current="step"` (`CheckInWizardPage.tsx:201-206`), foco al título del paso, «Firmar en recepción» (`SignaturePad.tsx:43-44,204-206`; `deferredSignatureMessage` `CheckInWizardPage.tsx:615-616`; `deferSignature` :1055-1062), cámara por teclado (`DocumentCamera.tsx`), códigos con `inputMode numeric` + `one-time-code`; kiosco: alerta a 75 s con «Continuar» (`KioskShell.tsx:221`; `kiosk-mode.ts:14-18`), selector de idioma propio; «Firmar en recepción» en el kiosco deriva en el SERVIDOR desde el corrector (`POST /guest-portal/check-in/handoff` → `handed_off · signature_pending · ticket K-nnnn` calculado por `handoffTicketFor` en `checkin-session.service.ts`, `kioskDeviceId`, auditoría `CheckInHandedOff`; la tablet solo pinta el ticket que devuelve el API y `kiosk-mode.ts` ya no calcula ninguno); contrato `tests/guest-portal-a11y-contract.test.mjs` (11) · **L7-05 · corrector** |
| Llegada y llave | `ArrivalPage` + `POST …/arrive` (CHK); llave `unavailable` sin proveedor | Sin cambio funcional; `StayOverviewPage.tsx:153,233-235` pinta `keyIssued` de `GET /guest-portal/stay` (`GuestPortalAction mobile_key`); recorrido de recepción muestra serie, validez y «QR de demo (sin certificado de Apple)» · **L7-06 · L7-07** |
| Estancia (folio, info, chat) | Folio real solo en `GET /guest-portal/session/:token/folio` sin consumidor (`server.ts:3280-3299`); `downloadInvoice` generaba un `.txt` (`client.ts:445-470`); teléfono/wifi inventados; sin página de información; chat solo con `CheckInSession` (`StayOverviewPage.tsx:209`) | `GET /guest-portal/stay` (`guest-portal.routes.ts:122`; `getGuestStayView` `guest-stay.service.ts:243`: etapa por fecha local :83, folio :95, info desde la faq del bot :116-156, `survey`, `requests`); `GET /guest-portal/invoices/:id/pdf` (:149; `renderGuestInvoicePdf` :281; `invoicePdfBlob`/`saveInvoicePdf` `client.ts:485-512`); `StayInfoPage.tsx` (113), `CheckOutPage.tsx` (343), `stay/stay.ts` (666: `stageOf` :126-136, `stayActions` :206-238, `checkOutOptions`); chat en toda etapa salvo cancelada (`StayOverviewPage.tsx:365`); `ChatWidget` con 403 → «no disponible» · **L7-02 · L7-06** |
| Salida | Sin check-out ni petición de salida por el portal (recon §12); `ServiceRequest` sin columna de descripción | `POST /guest-portal/stay/requests` (`guest-portal.routes.ts:129`; `createGuestStayRequest` `guest-stay.service.ts:302`: `ServiceRequest front_office` + evento `GuestCheckoutRequested`; tipos permitidos por etapa `GUEST_STAY_REQUEST_KINDS_BY_STAGE` desde el corrector: `checked_out` → 409 `STAY_CLOSED` salvo `invoice_email`, fuera de etapa → 409 `STAY_REQUEST_NOT_ALLOWED { stage, kind, allowed }`; cancelada/no-show → 409 `STAY_CLOSED` también en `/service-request` y `/chat`) y `POST /guest-portal/stay/payment-link` (:139; :346, `at_reception` sin PSP; folio sin líneas → `{ status: "no_charges", paymentStatus: "none" }`, nunca `paid`; `returnUrl` solo `http(s)`); recepción lo ve en `/activity` en español (`pms/guest-activity.service.ts`) · **L7-02 · L7-06 · corrector** |
| Post-estancia | 0 rutas públicas de encuesta; `POST /surveys/:id/responses` exigía `surveys.manage` (`route-permissions.ts:438`); sin plantilla; NPS del panel leía `score` (`dashboards/surveys.service.ts:137-148`) (recon §5) | Migración `20260920190000_portal_huesped_l7`; política `postStaySurveyEnabled/DelayHours` (`checkin-policy.service.ts:51-52,86-87,115-116`; `checkin.schemas.ts:136-138`); plantilla `post_stay_survey` (`system-templates.ts:281-345`); `runPostStaySurveyStep` (`post-stay-survey.service.ts:337`; ventana :113, consentimiento :139, enlace :147) como paso 5 del tick (`checkin-jobs.ts:386-389`); `POST /reservations/:id/post-stay/survey-invite` (`guest-portal.routes.ts:183`); `GET|POST /guest-portal/survey` (:165-181; `getGuestSurveyView` :450, `submitGuestSurvey` :466; desde el corrector `surveyOpenFor` exige `Reservation.status = checked_out`: una confirmada con la salida pasada recibe `available:false` y 409 `SURVEY_NOT_AVAILABLE { stage, status }`, y el portal no le da las gracias por una estancia que no hubo); `SurveyPage.tsx` (332; `radiogroup` :73-88; con sesión `survey` el Router monta SOLO la encuesta y ofrece «Entrar en el portal con mi código»); `App.tsx wantsSurvey` :71; seed: `Survey chk_survey_post_stay` y política activa en `prop_chk` (`seed-checkin.ts`) · **L7-04 · L7-08 · corrector** |
| Recorrido en recepción | `GuestJourneyWorkspace.tsx` 673 líneas: 7 pasos derivados de reserva + folio + huésped (`computeJourney` :102-197), sin leer CHK, avisos, llave ni encuesta; copy inglés en `guest-activity.service.ts:98-107` | `GET /reservations/:id/guest-journey` (`guest-journey.routes.ts:28`; `getGuestJourney` en `guest-journey.service.ts`; `GuestJourneyView` en `packages/shared/src/guest-portal-types.ts` desde el corrector, con tabla propia en `api-contracts.md`; avisos con «Simulado»; la encuesta `post_stay_survey:<id>` se busca por igualdad —antes por prefijo y `chk_res_07` heredaba la de `chk_res_07p`—, solo `welcome:<id>:` sigue como prefijo); `journey.ts` (481) con 13 pasos y `unknown` sin recorrido; `guestJourneyApi.ts` (90, importa el wire type de `@hotelos/shared`; `sendPostStaySurveyNow`, `isRouteUnavailable`); botones «Invitar / Reenviar invitación» y «Enviar encuesta ahora» (`GuestJourneyWorkspace.tsx`); kind `signature_pending` en la cola de Mi día (`front-desk-queue.service.ts`, `FrontDeskActionQueue.tsx`, `frontdesk-labels.ts`) · **L7-07 · corrector** |
| Ajustes «Portal del huésped» | `GuestPortalSettingsScreen.tsx:9-10,41-53,102-135` estado local, «Guardar» no persistía (CHK D13) | `guestPortalApi.ts` (111): solo las 3 claves reales de la política (`GUEST_PORTAL_POLICY_KEYS` :32) con `PUT /properties/:id/check-in/policy`; validación 0-72 h; pantalla 292 → 270 líneas (`cocoaInputs` 10 → 3) · **L7-08** |
| e2e | Playwright solo en admin-web (`playwright.config.ts:45-66`: measure/chromium/touch); sin specs del portal | Proyecto `guest` (`playwright.config.ts:82-84`; `chromium` excluye `guest-portal` :72); `e2e/guest-portal/{_guest-helpers.ts 434, precheckin 306, stay-checkout 342, kiosk 213, journey 323, survey 197}.spec.ts` + `README.md` (106) · **L7-03 · L7-08 · L7-09** |
| Móvil | `App.tsx` sin `AuthProvider` (`AuthContext.tsx:42` lo define, :22 `prop_123`), 20+ `prop_123`/`org_123` en `services/api.ts:43-686`, `sig_mobile_demo` :98, `demo.jwt.token` :648, `screens/ai/checkin/*` maqueta, `GuestJourneyScreen.tsx:5-19` inventado | Igual (sin código, D5): verificado hoy y documentado en `apps/mobile/README.md` (§6) · **L7-10** |
| Docs | `checkin-automatizado.md` §1-14; `api-contracts.md` sin rutas de estancia ni encuesta | `api-contracts.md` «Portal del huésped · estancia y salida» + «Encuesta post-estancia» (+94 líneas, L7-02/L7-04); `ux-recepcion-pruebas.md` §7 (L7-03); `docs/runbooks/portal-huesped.md` (262), `docs/manual/70-recepcion.md` (2 párrafos), bloques `CLAUDE.md` / `ESTADO-VERIFICADO.md` (L7-10) |

## 2. Qué construyó cada lote (qué · cómo · tests · verificación)

Ola 1 (portal en español y accesible, API de estancia, arnés e2e) · ola 2 (encuesta post-estancia, asistente y kiosco
accesibles, estancia y salida, recorrido) · ola 3 (encuesta en el portal, ajustes honestos, e2e completo) · ola 4 (cierre).

### L7-01 · Portal base: español, a11y y textos honestos (páginas fuera del asistente) — done
- **Qué:** `index.html`, `App.tsx`, `styles.css`, `guest-config.ts`, `Layout.tsx`, `StatusPill.tsx`, `SignInPage`, `StayOverviewPage`, `PreCheckInPage`, `ServiceRequestPage`, `wizard.ts` (+ claves es/en), contrato `tests/guest-portal-ui-contract.test.mjs`.
- **Cómo:** `LangContext` con `pickLanguage(navigator.language)` y `<html lang>`; selector es/en en cabecera (`.gp-lang` 44 px); skip link; `isApiConfigured()`; `country` a ISO-2 en `POST /guest-portal/pre-check-in`; `--gp-muted` a 5,7:1; modo oscuro y `prefers-reduced-motion` conservados.
- **Tests:** `wizard.test.mts` (paridad es/en) + contrato UI; build de guest-web.
- **Verificación:** capturas `scratchpad/L7/l701-*.png` (21: sign-in es/en/error/foco del skip link/oscuro, estancia es/en/clásica, pre-check-in es/en/hecho, servicio es/hecho, sign-out, stub sin API) y `l701-runtime.json` (`hasMain`, `hasSkip`, `live`, `inlineStyle 0`, `small []` por página).
- **Abiertos:** `client.ts:179/:203` `signIn` lanza `Error` con texto inglés; el asistente conserva su toggle de idioma; `KioskShell` gestiona `lang` aparte; typecheck del portal en SKIP (D7).

### L7-02 · API del huésped: estancia, folio, facturas, peticiones de salida, pago honesto — partial → cerrado por lotes posteriores
- **Qué:** `guest-stay.service.ts` (371), `guest-portal.routes.ts`, `route-permissions.partial.ts`, `packages/shared/src/guest-portal-types.ts` (+ `export *` en `packages/shared/src/index.ts`, fuera de su lista pero imprescindible), `auth-context.ts` (3 prefijos), `server.ts` (registro + legado 19.6), `pms/guest-activity.service.ts` (copy español), `docs/api-contracts.md`.
- **Cómo:** `GuestStayDeps` inyectables; etapa por `Property.timezone`; folio principal real (`findReservationFolio`); PDF por `renderInvoicePdf` solo si `Invoice.reservationId` = sesión; `paymentLinkServiceContext` sin PSP → `at_reception`.
- **Tests:** `guest-stay.test.mts` 21; `tests/integration/guest-stay.test.mts` 11 (tenant aislado, 200/401, PDF por cabecera y `?token=`, 404 ajeno/borrador, 400/409, legado, invariantes de Faranda).
- **Verificación:** `scratchpad/L7/rt-l7-02/` (curl contra `:3937`).
- **Abiertos (resueltos después):** eco inglés de `GET /guest-portal/stay` en `api-reference` (corregido en el árbol: `stay` en `SINGLETON_LABELS`); `nav-tree --check` rojo por el CSV compartido (sigue, ajeno).

### L7-03 · Arnés e2e del portal (proyecto Playwright `guest`) y spec del pre-check-in — done
- **Qué:** `playwright.config.ts` (proyecto `guest`, `chromium` excluye `guest-portal`), `e2e/guest-portal/_guest-helpers.ts` (`loginAsChk`, `createSyntheticReservation`, `invite`, `guestUrl`, `syntheticMrz`, `assertTargets`, `shot`, `watchConsole`), `precheckin.spec.ts`, `docs/runbooks/ux-recepcion-pruebas.md` §7.
- **Cómo:** Pixel 5 emulado (393 × 851, `hasTouch`, es-ES); reserva sintética a +3 días por API + invitación; enlace mágico → token fuera de la URL → viajeros → «foto» sin proveedor (400 `DOCUMENT_UNREADABLE`) → MRZ sintética → datos y consentimientos → complete → firma → pago honesto → llegada (409 fuera de ventana o 200 con `E2E_GUEST_ARRIVAL_OFFSET_DAYS=0`) → estancia; en cada paso `assertTargets` (0 < 24 px afirmado; < 44 px a JSON) y captura; al final 0 excepciones, ninguna respuesta ≥ 400 no declarada, token nunca en una URL.
- **Verificación:** 12 capturas `scratchpad/L7/e2e/precheckin-*.png` + `targets-01…12.json`; `chromium_headless_shell-1243` desde `scratchpad/pw-browsers` (`PLAYWRIGHT_BROWSERS_PATH`).
- **Hallazgos:** `DELETE …/guests/:id` fallaba con 400 por `Content-Type` sin cuerpo (corregido en L7-06); `settled`/«Todo pagado» con folio vacío (L7-06 lo cambia a «sin cargos todavía»); `--reset` no borra las `RES-*` (deuda 19c); casillas `.gp-check` 26 px.

### L7-04 · Encuesta post-estancia: política, plantilla, paso del tick y rutas — done
- **Qué:** `post-stay-survey.service.ts` (501), rutas `survey`/`survey-invite`, `guest-portal-auth.service.ts` (`issueGuestPortalSession`), `system-templates.ts` (`post_stay_survey` × 4), `checkin-jobs.ts` (paso 5), `checkin-policy.service.ts`, `checkin.schemas.ts`, `checkin-types.ts`, `guest-portal-types.ts`, `schema.prisma` + migración `20260920190000_portal_huesped_l7`, `seed-checkin.ts` (política activa 24 h, `Survey chk_survey_post_stay`, `--reset` borra respuestas), `tests/seed-checkin-contract.test.mjs`, `docs/api-contracts.md`.
- **Cómo:** ventana `[hoy − 3 d, día local de (ahora − delay)]`, consentimiento `gdprAt` o `marketing !== false`, sesión de 30 días, `dispatch` con `redact` del token, idempotencia por `notificationId`, `summary.postStaySurvey`; ruta manual = mismo paso con la reserva forzada (`surveyUrl` solo si simulado).
- **Tests:** `post-stay-survey.test.mts` 17, `checkin-jobs.test.mts` 17, `checkin-templates.test.mts` 14, `seed-checkin-contract` 14, `tests/integration/guest-survey.test.mts` 11.
- **Verificación:** `scratchpad/L7/l704-runtime.json` (invite simulado con token redactado en `notification_deliveries`, GET/POST del portal 201 → 409, NPS en `/dashboards/surveys`); `migrate status` 25/25, drift «No difference detected.».
- **Abiertos:** `survey_detractor` no se crea; `answers` sin validar rango de `scale`/`nps`; en producción sin proveedor `failed` sin reintento; ecos de `api-reference` y censo de variables (regenerados después en el árbol).

### L7-05 · Asistente de 6 pasos y kiosco accesibles (WCAG 2.2 AA) — done
- **Qué:** `CheckInWizardPage.tsx`, `ArrivalPage.tsx`, `KioskShell.tsx`, `kiosk-mode.ts`, `DocumentCamera.tsx`, `SignaturePad.tsx`, `QrCode.tsx`, `ChatWidget.tsx`, `tests/guest-portal-a11y-contract.test.mjs` (11).
- **Cómo:** solo claves de copy existentes (wizard.ts es de L7-01): «Firmar en recepción» = `sign` + `statusHandedOff`; etiquetas explícitas, regiones vivas, foco al título del paso, `progressbar`, aviso del kiosco como `role="alert"` con botón grande, códigos numéricos de un solo uso, cámara por teclado, 0 `style=`.
- **Verificación:** `l705-runtime.json` (15 KB: por pantalla `active`, `live`, `alerts`, `unlabeled []`, `invalid []`, `inlineStyle 0`, `small`), 20 capturas `l705-kiosk-00…09` y `l705-movil-01…10`; typecheck real de guest-web con `@types/react` de admin-web (`l705-tsconfig.json`): 0 errores.
- **Abiertos:** handoff del kiosco solo en cliente (deuda 19a); `.gp-check` 26 px y `<input type=date>` 39 px; la casilla de consentimiento es controlada por el servidor (Playwright `.check()` no vale; se usa click + espera del PATCH).

### L7-06 · Portal: estancia y salida (folio real, facturas, peticiones, pago honesto) — done
- **Qué:** `App.tsx` (páginas `checkout`, `info`, `survey` preparada), `styles.css`, `api/client.ts` (`getStay`, `requestStayAction`, `requestStayPaymentLink`, `invoicePdfBlob`, `saveInvoicePdf`; `request()` sin `Content-Type` sin cuerpo), `wizard.ts` (claves), `StayOverviewPage`, `CheckOutPage`, `StayInfoPage`, `stay/stay.ts` + `stay.test.mts`, contrato UI.
- **Cómo:** módulo puro `stay.ts` (etapa → acciones, opciones de salida, formato del folio, resultado honesto del pago, etiquetas); stubs marcados «demo sin API»; «Pagar ahora» solo con `link_sent` real; folio sin líneas = «sin cargos todavía».
- **Tests:** `stay.test.mts` 32; contrato UI ampliado (páginas, funciones, espejo de `STAY_STAGES`/`STAY_REQUEST_KINDS`).
- **Verificación:** 13 capturas `l706-*.png` (estancia pre-llegada / en casa / salida / post-estancia / con petición / chat, salida y cuenta con pago y petición, información es/en) y `l706-runtime-rerun.json` (`GET /guest-portal/stay` 200 `departure_day`, folio `balance_due` 123 €, info completa desde la faq, `payment-link` → `at_reception PSP_NOT_CONFIGURED`, chat sin sesión de check-in → `answered`).
- **Abiertos:** `GET /guest-portal/check-in` crea sesiones `invited` al vuelo en reservas alojadas/salidas (deuda 19b); `signIn` con `Error` inglés; sin captura del modo stub.

### L7-07 · Recorrido del huésped en recepción con datos reales — done
- **Qué:** `guest-journey.service.ts` (346), `guest-journey.routes.ts`, `journey-route-permissions.partial.ts`, `server.ts` (registro), `route-permissions.ts` (spread), `GuestJourneyWorkspace.tsx` (+202/−119), `screens/guestJourney/journey.ts` (481, fuera de la lista y declarado: cálculo puro probable bajo node), `guestJourneyApi.ts`, `journey.test.mts` (15), `tests/integration/guest-journey.test.mts` (5), `screens-fixes-contract.test.mts` (pin qa#9 → `journey.ts`), inventario Cocoa 22 regenerado.
- **Cómo:** `GuestJourneyView { checkIn, notifications[], key, requests[], survey, portalSessions }` sin PII; avisos por prefijo de `notificationId` y marca «Simulado»; 13 pasos en el orden real; sin recorrido del API los pasos quedan `unknown` y nunca se proponen como siguiente acción; «Enviar encuesta ahora» con `isRouteUnavailable` honesto.
- **Verificación:** `l707-runtime.json` (2 reservas: `chk_res_10` alojada con llave móvil y `chk_res_09` invitada con aviso simulado a `h***@chk.test` y 1 petición abierta) + 2 capturas `l707-recorrido*.png`; instancia propia en `:3957/:5227` porque `:3937/:5207` estaban ocupados por otro lote.
- **Abiertos:** `GuestJourneyView` sin sección en `api-contracts.md` (deuda 19d); `InviteSessionResult` de `checkinApi.ts` no tipa `recipient`; wire type solo en el servicio y su espejo (no en `guest-portal-types.ts`).

### L7-08 · Portal: página de encuesta; ajustes «Portal del huésped» honestos — done
- **Qué:** `SurveyPage.tsx` (332), `App.tsx` (`?survey=1`, `surveyEnabled`), `client.ts` (`getSurvey`, `submitSurvey`), `wizard.ts` (claves), `stay/stay.ts` (bloque encuesta: estado honesto, validación, cuerpo), `GuestPortalSettingsScreen.tsx` (+165/−187: 3 claves reales, sin «funciones visibles» ficticias), `guestPortalApi.ts`, `guest-portal-settings.test.mts` (11), `survey.spec.ts`, contrato UI; inventario Cocoa 22 regenerado.
- **Cómo:** NPS 0-10 como `radiogroup` de botones ≥ 44 px (`gp-chip gp-link`), `scale` 1-5 y `nps` extra validados en cliente; «Ya has respondido» tras 409; enlace caducado → acceso con aviso; `?survey=1` abre `SurveyPage`; «Responder la encuesta» principal solo con invitación.
- **Verificación:** `l708-admin-runtime.json` (política antes/después, `PUT` 200 × 2, validación sin `PUT`, restauración) + 5 capturas `l708-admin-portal-*.png`; e2e `survey.spec.ts` 6 pantallas `scratchpad/L7/e2e/survey-0*.png`.
- **Abiertos:** una pasada e2e mal acotada (`--project guest` con `--`) corrió los 4 proyectos (sin valor de puerta; corregido en README/config); el bloque «Tu opinión» de la estancia sigue siendo texto; `gp-nps` propio pendiente en `styles.css`.

### L7-09 · e2e del recorrido completo: estancia y salida, kiosco, recorrido en recepción — done
- **Qué:** `stay-checkout.spec.ts`, `kiosk.spec.ts`, `journey.spec.ts`, `e2e/guest-portal/README.md`.
- **Cómo:** fixtures por API (reserva de hoy → invitación → pre-check-in cerrado por las rutas del huésped → check-in de recepción con habitación y llave → cargo de minibar → faq del hotel si falta); kiosco con `page.clock` (aviso a 75 s, reinicio a 90 s sin restos en `sessionStorage`); recorrido de admin-web con `coarse` por CDP; cada spec re-marca limpia su habitación (`POST /rooms/:id/mark-clean`).
- **Verificación:** corrida final 5/5 en 41,2 s · 140 peticiones al API (`l709-final-figures.txt`, `l709-guest-final.json`); limpieza del tenant (`l709-cleanup-cancel.json`: 10 fixtures canceladas por API con 95 € FLEX24 cada una; `l709-cleanup-rooms.json`: 15 Dobles re-marcadas limpias); typecheck de `e2e/**` con `l709-tsconfig.json` 0 errores.
- **Abiertos:** `identityVerifiedAt` no persiste con `mrz_checksum` (deuda 19f); `CocoaSearchInput` botón de borrar 20 × 20; paso «Pago» con folio vacío; `e2e/**` sin typecheck en las puertas; `precheckin`/`survey` no re-marcan la habitación.

### L7-10 · Cierre (este lote) — done
- **Qué:** `docs/runbooks/portal-huesped.md` (262 líneas, 10 secciones), este informe, `apps/mobile/README.md` (62), bloque L7 en `docs/audits/ESTADO-VERIFICADO.md`, `CLAUDE.md` (bloque compacto «Estado verificado (Tanda L7)», deuda 19, deuda 6 actualizada, 3 líneas en «Docs prioritarios»), `docs/manual/70-recepcion.md` (2 párrafos: pre-check-in desde el portal en «Llegadas y check-in»; peticiones y encuesta en «Salidas y check-out»).
- **Cómo:** relectura de los informes y capturas de L7-01…L7-09, del recon, del runbook CHK (plantilla §1/§11-13) y de las anclas; inventario del móvil verificado hoy sobre el árbol (`grep`/lectura; typecheck ejecutado).
- **Tests:** contratos que leen estos ficheros (`brand-contract`, `manual-contract`, `migrations-squash-contract`, `rate-grid-docs-contract`): 45/45.
- **Verificación:** instancias propias `:3937` / `:5237` / `:5207` (PIDs en `scratchpad/L7/l710-*.pid`, log `l710-api.log`) y corrida completa del proyecto `guest` (§5); puerta completa `scratchpad/L7/gates-full.json` 13/14 a las 14:58 (§4).

### Revisión del carril (dos revisores, solo lectura) — 8 medium + 10 low confirmados, 0 refutados
- **Cómo:** instancias propias sobre el árbol cerrado (API `:3937`/`:3947`, portal `:5237`, admin `:5207`), tenant CHK con
  fixtures por API (reservas `RES-*` sintéticas: nunca se alojó, cancelada con penalización FLEX24, salida hecha), sondas
  con el token del enlace de la encuesta contra las 8 rutas del portal, SQL de solo lectura en `hotelos_l7`, lectura de
  pantalla con el navegador (móvil 375 px y escritorio), `grep` de docs; salidas `scratchpad/L7/rev-probe.json`,
  `rev-probe2.json`, `review-probe.log`, `rev-api.log`, `gates-review-quick.json` (11/12).
- **Resultado:** 8 hallazgos medium confirmados con evidencia reproducible (ruta, cuerpo, respuesta y fila) + 10 low; ninguno
  refutado; tabla en §8.

### Corrector L7-REV — done (18/18 corregidos)
- **Qué:** 59 ficheros (código, tests, docs) listados en §9; migración `20260920210000_guest_portal_session_purpose`
  (`guest_portal_sessions.purpose text NOT NULL DEFAULT 'sign_in'`; reversible con `DROP COLUMN`; aplicada en `hotelos_l7`:
  26/26, drift 0).
- **Cómo:** ámbito de sesión (`purpose` sign_in | invitation | survey; `verifyGuestToken(token, { purposes })`; solo
  `GET|POST /guest-portal/survey` admiten `survey`; el portal verifica `?survey=1&token=` contra `/guest-portal/survey`,
  monta solo `SurveyPage` y ofrece «Entrar en el portal con mi código»); peticiones por etapa
  (`GUEST_STAY_REQUEST_KINDS_BY_STAGE` en `@hotelos/shared`, espejo en `stay.ts`); `no_charges/none` con folio vacío en los
  dos esquemas de enlace de pago (el de CHK ya no persiste `paid`); recorrido por igualdad; encuesta solo `checked_out`;
  cancelada sin «Salida y cuenta» ni pago (`folioActionKey`, `checkOutCopy`, `canOfferPayment`); handoff del kiosco en
  servidor (`POST /guest-portal/check-in/handoff`, `handoffToReception`, `handoffTicketFor` FNV-1a por sesión, kind
  `signature_pending` en la cola); `/service-request` y `/chat` → 409 `STAY_CLOSED` con la reserva cerrada;
  `Router key` tras cerrar sesión; `redactTokenInUrl` del path legado; `returnUrl` `http(s)`; `?token=` solo en el PDF;
  `--project=guest`; `E2E_API_URL` :3937; `--reset` purga las `RES-*` de e2e (`prueba.portal.*` sin factura) y
  `releaseReservationRoom` en `finally`.
- **Tests:** api unit `guest-journey` 13 · `guest-stay` 28 · `post-stay-survey` 18 · `front-desk-checkin` 12 ·
  `checkin-session` 20; guest-web 72; contratos `guest-portal-ui` 32 · `guest-portal-a11y` 11 · `seed-checkin` 14 ·
  `cors` 12 · `api-route-permissions` 32; integración `guest-survey` 13 · `guest-stay` 14 · `kiosk-pairing` 8 (handoff de
  punta a punta).
- **Verificación:** e2e `guest` 5/5 en 39,6 s (`corr-e2e-run2.log`, capturas `corr-e2e/`); sondas `corr-probe.json`
  (script `corr-probe.py`); pantallas RES-00053 (nunca se alojó) y RES-00010 (cancelada) leídas en `:5237`; puerta completa
  `corr-gates-full.json` 12/14 (16:15; `cocoa waves` regenerado después con `cocoa-22-inventory.mjs` +
  `cocoa-22-waves.mjs --write`) y rápida `corr-gates-quick2.json` 11/12; `db:seed:checkin -- --reset` al final
  (`corr-seed-reset.sh`: 68 `RES-*` purgadas, `prop_chk` 79 → 11 reservas; total de reservas fuera de `prop_chk` 13.556
  antes y después).
- **No corregido a propósito:** `nav-tree --check` (CSV compartido, ajeno); deuda 19b (`ensureSession`),
  `survey_detractor`, rango de `answers` y `@types/react` (fuera del alcance de la revisión); en el móvil «Firmar en
  recepción» sigue siendo un aviso local y el parte lo cierra recepción a la llegada (la derivación en servidor se limita al
  kiosco, como pedía el hallazgo).

### Integrador — done
- **Qué:** confirmación del working tree (`git status`/`diff --numstat`: 65 modificados +4.111/−969, 37 nuevos 10.649
  líneas, `pnpm-lock.yaml` limpio), este informe (versión definitiva con §8 de hallazgos), bloque «Estado verificado
  (Tanda L7)» al final de `docs/audits/ESTADO-VERIFICADO.md`, commit en `tanda-l7`.
- **Verificación:** puerta completa final `scratchpad/L7/gates-final.json` 13/14 (16:23, §4); `bash .husky/pre-commit`
  ejecutado a mano desde `hotelos/` (discoverability + `typecheck-all`) porque `core.hooksPath = .husky` se resuelve contra la
  raíz del worktree (`~/anfitorio-demo-wt-l7/.husky` no existe: el directorio vive en `hotelos/`), así que git no lo dispara
  solo desde el worktree; puerta rápida tras las ediciones documentales (`gates-integrador-quick.json`, §4); SQL de solo
  lectura tras el `--reset` del corrector (§3); ningún proceso en `:3937/:5207/:5237`.

## 3. Modelo de datos, migración y datos del carril

- **Migración** `packages/database/prisma/migrations/20260920190000_portal_huesped_l7/migration.sql`: `ALTER TABLE
  property_checkin_policies ADD COLUMN post_stay_survey_enabled boolean NOT NULL DEFAULT false, ADD COLUMN
  post_stay_survey_delay_hours integer NOT NULL DEFAULT 24`; reversible con `DROP COLUMN`; sin índices ni enums;
  `surveys` / `survey_responses` sin cambios (unicidad por reserva en código, 409 `SURVEY_ALREADY_ANSWERED`). Posterior a
  `20260920160000_checkin_pago_en_recepcion`; L6b usa `…170000` y `…180000` queda libre para L8: renumerar en la fusión
  si L8 aporta una marca posterior.
- **Migración 2 (corrector L7-REV-01)** `packages/database/prisma/migrations/20260920210000_guest_portal_session_purpose/
  migration.sql`: `ALTER TABLE guest_portal_sessions ADD COLUMN purpose text NOT NULL DEFAULT 'sign_in'`
  (`sign_in` código + correo 24 h · `invitation` enlace del check-in · `survey` enlace de la encuesta 30 d); reversible con
  `DROP COLUMN`; sin índices ni enums; las filas anteriores quedan `sign_in` (un enlace de encuesta emitido antes de la
  migración conserva el acceso completo hasta caducar; desde ahora `issueGuestPortalSession` marca `survey`).
  `migrate status` **26/26** en `hotelos_l7`; `db:drift:check` «No difference detected.» (verificado por SQL el 2026-09-20
  16:27: las tres columnas existen con sus defaults; `_prisma_migrations` con 26 finalizadas, la última
  `20260920210000_guest_portal_session_purpose`).
- **Schema** (`schema.prisma:2142,2144`): `postStaySurveyEnabled Boolean @default(false)`, `postStaySurveyDelayHours Int
  @default(24)`. DTO `PropertyCheckInPolicyDto` + `PolicyPutSchema` (0-72). Tipos wire nuevos en
  `packages/shared/src/guest-portal-types.ts` (`GuestStayView`, `GuestStayStage`, `GuestSurveyView`,
  `GuestSurveySubmitInput/Result`, `PostStaySurveyInviteResult`, `GUEST_PORTAL_ERROR_CODES`, `DEFAULT_GUEST_SURVEY_QUESTIONS`).
- **Manifiesto:** +7 rutas en `modules/guest-portal/route-permissions.partial.ts` (6 públicas + `survey-invite`), +1 en
  `journey-route-permissions.partial.ts` y +1 pública en el partial de CHK (`POST /guest-portal/check-in/handoff`, 31
  rutas); 0 claves RBAC nuevas (`rbac:sync --dry-run` limpio); 3 prefijos en `PUBLIC_PREFIXES`; códigos nuevos en
  `GUEST_PORTAL_ERROR_CODES`: `STAY_CLOSED`, `STAY_REQUEST_NOT_ALLOWED`, `SURVEY_NOT_AVAILABLE`, `SURVEY_ALREADY_ANSWERED`,
  `RESERVATION_NOT_CHECKED_OUT`, `GUEST_SESSION_INVALID`.
- **Datos en `hotelos_l7` al cierre L7-10 (14:58, antes del corrector):** `prop_chk` 63 reservas (11 `CHK-*` + 52 `RES-*` de
  e2e), 54 sesiones de check-in, 4 respuestas de encuesta, 4 entregas `post_stay_survey` simuladas, 83 sesiones de portal,
  21 peticiones, 9 kioscos.
- **Datos en `hotelos_l7` en el commit (SQL de solo lectura, integrador 2026-09-20 16:27, tras el `db:seed:checkin --
  --reset` del corrector que ya purga las `RES-*` de e2e):** `prop_chk` **11 reservas** (todas `CHK-*`: 9 confirmadas · 1
  alojada · 1 con salida hecha), 9 `checkin_sessions`, 0 `survey_responses`, 8 `guest_portal_sessions` activas (todas
  `purpose = invitation`, del seed), política de `prop_chk`: `post_stay_survey_enabled = true`, 24 h,
  `allow_pay_at_reception = false`; reservas totales 13.567 = 13.556 fuera de `prop_chk` (idéntico a la medida del
  corrector antes y después del reset: Faranda + OPERA + tenants de prueba intactos) + 11 `CHK-*`. Ningún SQL de escritura
  sobre Faranda en toda la tanda.

## 4. Puertas (línea base 2026-09-20 11:57 → cierre)

`bash scripts/gates.sh --quick --json …` con `NAV_TREE_CSV=/Users/cfernandez/anfitorio-demo/pilots/tanda5-nav-tree.csv`
(`scratchpad/L7/gates-*.json`):

| Puerta | Base (11:57) | Ola 1 (13:03) | Ola 2 (13:46) | Ola 3 (14:31) | Cierre L7-10, completa (14:58, `gates-full.json`) | Corrector, completa (16:15, `corr-gates-full.json`) | **Final, completa (16:23, `gates-final.json`)** |
|---|---|---|---|---|---|---|---|
| typecheck:all | 15 PASS · 1 SKIP | 15 · 1 | 15 · 1 | 15 · 1 | 15 · 0 · 1 · 28,3 s | 15 · 0 · 1 · 20,9 s | 15 PASS · 0 FAIL · 1 SKIP · 21,0 s |
| api unit | 3.569 (1 skip) | 3.590 | 3.625 | 3.625 | 3.625 (3.624 · 0 · 1) | 3.637 (3.636 · 0 · 1) | 3.637 (3.636 pass · 0 fail · 1 skip) |
| admin-web unit | 2.014 (1 skip) | 2.014 | 2.029 | 2.040 | 2.040 (2.039 · 0 · 1) | 2.040 | 2.040 (2.039 · 0 · 1) |
| ai-core · worker | 119 · 34 | 119 · 34 | 119 · 34 | 119 · 34 | 119 · 34 | 119 · 34 | 119 · 34 |
| contratos raíz | 765 (2 skip) | 770 | 791 | 796 | 796 (794 · 0 · 2) | 796 | 796 (794 · 0 · 2 skip) |
| discoverability | 197 URL | 197 | 197 | 197 | 197 | 197 | 197 URL |
| nav-tree --check | verde (70/104/205) | **rojo** | **rojo** | **rojo** | **rojo** | **rojo** | **rojo** (CSV compartido, ajeno; §4.1) |
| route-access | 15 × 197 | OK | OK | OK | OK | OK | 15 × 197 OK |
| cocoa waves --check | §6 al día | OK | OK | OK | OK | **rojo** (§6 tras `GuestJourneyWorkspace`/`FrontDeskActionQueue`; regenerado con `--write`) | §6 al día |
| rbac:sync --dry-run | OK | OK | OK | OK | OK | OK | OK (202 ms) |
| migrate status + drift | No difference | OK | OK | 25/25 | 25/25 · No difference | 26/26 · No difference | 26/26 · No difference detected. |
| admin-web build | — | — | — | — | ✓ 3,13 s | ✓ 2,96 s | ✓ built in 2.85s |
| integración | — | — | — | — | 1.010 (1.002 · 0 · 8) | 1.016 (1.008 · 0 · 8) | 1.016 (1.008 pass · 0 fail · 8 skip) |
| **Total** | 12/12 | 11/12 | 11/12 | 11/12 | **13/14** | **12/14** | **13/14** |

Puerta rápida del integrador tras las ediciones documentales (`scratchpad/L7/gates-integrador-quick.json`, 16:35 → 16:36):
**11/12** — typecheck 15 PASS · 0 FAIL · 1 SKIP · 21,7 s · api unit 3.637 (3.636 · 0 · 1) · admin-web 2.040 (2.039 · 0 · 1) ·
ai-core 119 · worker 34 · contratos raíz 796 (794 · 0 · 2; incluye los contratos que leen este informe y
`ESTADO-VERIFICADO.md`: `brand`, `manual`, `nav-tree`, `rbac-nav`, `seed-ux-day`, `rate-grid-docs`) · discoverability 197 ·
route-access 15 × 197 · cocoa waves §6 al día · rbac dry-run OK · migrate status + drift «No difference detected.»; única
roja `nav-tree --check` (§4.1). `bash .husky/pre-commit` a mano desde `hotelos/`: discoverability OK (197 URL · 0 broken ·
placeholders 16/20) + typecheck-all 15 PASS · 1 SKIP en 22,4 s.

Incrementos atribuibles a la tanda (base → final): api unit +68 (3.569 → 3.637: `guest-stay` 28 · `post-stay-survey` 18 ·
`guest-journey` 13 · `checkin-session` +4 · `front-desk-checkin` +2 · `checkin-jobs` +2 · `checkin-templates` +3 ·
`api-reference` ajustes), admin-web +26 (`journey` 15 · `guest-portal-settings` 11), contratos raíz +31
(`guest-portal-a11y-contract` 11 nuevo; `guest-portal-ui-contract` 13 → 32, `seed-checkin-contract` 13 → 14, `cors-contract`
+4 asserts), integración +33 aprox. (`guest-stay` 14 · `guest-survey` 13 · `guest-journey` 5 · `kiosk-pairing` +1 handoff),
guest-web 72 (fuera de `gates.sh`: `wizard` + `stay`; typecheck del paquete en SKIP explícito, D7).

### 4.1 La puerta roja: una sola causa, ajena al carril
`nav-tree --check` está rojo desde la ola 1 porque `/Users/cfernandez/anfitorio-demo/pilots/tanda5-nav-tree.csv`
(compartido, fuera del worktree) cambió a las 12:19 con las filas de la Tanda ACT (`RealEstate*`: Activo inmobiliario,
Obras, Inspecciones y seguros, Grupo, Tributos, Documentación) y `apps/admin-web/src/navigation/nav-tree.generated.json`
del worktree (11:02) queda stale (71 ítems / 109 pestañas / 205 legacy al regenerar). L7 no añade rutas de admin-web (las
pantallas «Recorrido» y «Portal del huésped» ya estaban en el CSV, filas 168 y 92): regenerar con
`node scripts/build-nav-tree.mjs --csv …` en la fusión o en el carril dueño de esas filas. Los ecos ingleses de
`api-reference` (L7-02/04/07) y el censo `scripts/env-contract.json` (L7-04) que dejaron rojas «api unit» y «contratos
raíz» en puertas intermedias ya están corregidos en el árbol (11/12 desde L7-09). Diagnóstico final (16:23): el CSV tiene
304 filas frente a las 294 con las que se generó el JSON del worktree; las 10 filas nuevas son pantallas de los carriles RRHH
y ACT (`HrEmployeesScreen`, `HrOverviewScreen`, `HrForecastScreen`, `DirectorLaborCostsScreen`, `RealEstateAsset/Documents/
Group/Inspections/Taxes/WorksScreen`; lista en `scratchpad/L7/csv-screens-missing-in-l7.txt`) más el cambio de etiqueta de
`PayrollScreen`; regenerar aquí crearía entradas a pantallas inexistentes (rompería `discoverability`/`route-access`), así
que el JSON generado se dejó intacto (restaurado byte a byte tras la prueba, `nav-tree.final-before.json`). El mismo rojo
aparecerá en L6b, L8, ux3, cierre y el repo principal hasta fusionar RRHH/ACT y regenerar sobre la rama integrada.

## 5. Runtime con capturas sintéticas

Todas las capturas están fuera del repo (`scratchpad/L7/`), sobre el tenant CHK con titulares inventados; ninguna lleva
nombres reales. Corrida de este lote (2026-09-20 14:45, instancias propias `:3937` / `:5237` / `:5207`, Playwright
`--project=guest`, `scratchpad/L7/l710-e2e/results.json`, log `l710-e2e-run1.log`):

| Spec | Resultado | Pantallas medidas (< 24 px / < 44 px) | Capturas |
|---|---|---|---|
| `journey.spec.ts` (recorrido en recepción, escritorio 1280 × 900) | passed · 33,5 s (primera carga de admin-web en dev) | 1 (+1 filtrada solo registro) · 0 / 0 (filtrada: 1, botón de borrar de `CocoaSearchInput` 20 × 20) | `l710-e2e/shots/journey-01-recorrido-alojado.png` |
| `kiosk.spec.ts` (tablet 1024 × 768) | passed · 1,3 s (reloj falso) | 6 · 0 / 0 | `kiosk-01-emparejar … 06-reiniciado.png` |
| `precheckin.spec.ts` (Pixel 5) | passed · 3,7 s | 12 · 0 / 3 (casillas `.gp-check` 26 px) | `precheckin-01-viajeros … 12-estancia.png` |
| `stay-checkout.spec.ts` (390 × 844) | passed · 2,2 s | 7 · 0 / 0 | `stay-01-en-el-hotel … 07-estancia-terminada.png` |
| `survey.spec.ts` (Pixel 5) | passed · 1,2 s | 6 · 0 / 0 | `survey-01-formulario … 06-enlace-caducado.png` |
| **Total** | **5/5 · 42,9 s** | 32 · 0 / 3 | 32 PNG + 33 JSON `l710-e2e/targets/targets-*.json` |

Capturas de los lotes (mismas rutas de `scratchpad/L7/`): L7-01 `l701-*.png` (24), L7-05 `l705-kiosk-00…09.png` (10),
`l705-movil-01…10.png` (10) y `l705-error.png`, L7-06 `l706-*.png` (13), L7-07 `l707-recorrido*.png` (2), L7-08
`l708-admin-portal-01…05.png` (5), L7-09 `e2e/*.png` (32). Sondas de API en `l704-runtime.json`, `l706-runtime-rerun.json`, `l707-runtime.json`,
`l708-admin-runtime.json`, `rt-l7-02/`. Comportamientos verificados en runtime que el brief exigía: pago sin PSP →
`at_reception` y copy «Se cobra en recepción» (nunca «pagado»); enlace de invitación y de encuesta con el token fuera de la
URL tras la carga; entrega simulada con token redactado en `notification_deliveries` y badge «Simulado» en el recorrido;
409 `SURVEY_ALREADY_ANSWERED` al repetir; `GET /guest-portal/invoices/:id/pdf` ajeno → 404; kiosco: aviso a 75 s, reinicio a
90 s sin restos en `sessionStorage` y credencial intacta; 0 objetivos < 24 px en las 32 pantallas.

**Corrida del corrector (2026-09-20 16:09, `scratchpad/L7/corr-e2e-run2.log`, mismas instancias del carril, `--project=guest`):
5/5 en 39,6 s** — journey 31,9 s (134 objetivos en la pantalla canónica, 0 < 24 / 0 < 44; la lista filtrada registra el
botón de borrar de `CocoaSearchInput` 20 × 20, conocido) · kiosk 0,8 s (6 pantallas, 0 / 0) · precheckin 3,0 s (12
pantallas, 0 < 24; < 44 solo las 3 casillas `.gp-check`) · stay-checkout 2,0 s (7 pantallas, 0 / 0) · survey 1,2 s (6
pantallas, 0 / 0; la pantalla 03 termina ahora en «Entrar en el portal con mi código» y la 05 en «Estancia terminada ·
Gracias por tu opinión» sin «Pedir un servicio»); 32 capturas en `scratchpad/L7/corr-e2e/`. Sondas de API del corrector
(`corr-probe.json`, script `corr-probe.py`, RES-00060/00061 sintéticas): sesión `survey` → 401 `GUEST_SESSION_INVALID` en
`GET /guest-portal/stay`, `/reservation`, `/check-in`, `/invoices/:id/pdf` y `POST …/stay/requests`, `/stay/payment-link`,
`/chat`, `/service-request` (8/8); `GET /guest-portal/survey` 200 con `sessionPurpose: survey` y reserva mínima; peticiones
con la reserva `checked_out`: `express_checkout`/`late_checkout`/`luggage` 409 `STAY_CLOSED`, `invoice_email` 201
`SRQ-<8>`; confirmada con la salida pasada: `express_checkout` 409 `STAY_REQUEST_NOT_ALLOWED { allowed: [invoice_email] }`,
encuesta `available:false` y POST 409 `SURVEY_NOT_AVAILABLE { status: confirmed }`; enlace de pago con folio vacío →
`no_charges/none`; `returnUrl` `javascript:` → 400; `?token=` en `/stay` → 401; legado `/guest-portal/session/<token>` →
`{ token: "[redacted]" }` y log con `/guest-portal/session/<redacted>`; recorrido de `CHK-07` sin la invitación de
`CHK-07P`; handoff del kiosco → `handed_off · signature_pending · K-8754` (idempotente) → vista de personal
`handoffReason «Firma en recepción · ticket K-8754»` → `resolve-handoff` 200 → `in_progress`; cancelada: `/service-request`,
`/chat` y `/stay/requests` 409 `STAY_CLOSED`.

## 6. Inventario de `apps/mobile` verificado hoy (D5: demo interna, sin código)

Verificado sobre el árbol el 2026-09-20 (lectura + `grep`; `corepack pnpm --filter @hotelos/mobile typecheck` → 0
errores); detalle por pantalla en `apps/mobile/README.md`.

- **Tamaño:** 110 pantallas `.tsx` en `src/screens` (+ 4 duplicados `* 2.tsx` en `rooms/`), 9.243 líneas; Expo 53 / RN 0.79
  / React 19; `app.json` `slug hotelos-mobile`, `bundleIdentifier com.hotelos.mobile`, EAS `replace-with-eas-project-id`;
  cinco pestañas (`HotelOSTabs.tsx:11-15`: Hoy · Timeline · IA · Operaciones · Más) y 18 entradas en «Más».
- **Auth:** `AuthProvider` definido (`src/auth/AuthContext.tsx:42`) y **no montado** (`App.tsx` no lo importa; `useAuth`
  sin consumidores); `LoginScreen.tsx` llama a `loginDemo()` (`services/api.ts:629-660`) que ante cualquier fallo devuelve
  `token: "demo.jwt.token"` y `prop_123` («Hotel Demo Madrid Centro»); `DEFAULT_PROPERTY_ID = "prop_123"`
  (`AuthContext.tsx:22`); `src/api/client.ts:38` lee `EXPO_PUBLIC_API_BASE_URL` pero solo lo usaría el provider sin montar.
- **Datos:** `services/api.ts` (728 líneas; `API_URL = "http://localhost:3000"` fijo :10; 26 `fetch`; `prop_123` × 16,
  `org_123` × 2) con respaldo inventado en cada función (`getDashboardSnapshot` :41-64 devuelve 26 llegadas / 18 salidas /
  12.840 € sin API); 14 pantallas lo importan.
- **Check-in por IA (`screens/ai/checkin/*`, 8 pantallas + `checkInFlowData.ts`):** maqueta estática con titular,
  documento y reserva inventados; `DocumentScanScreen.tsx` botón de cámara `onPress={() => undefined}`;
  `GuestSignatureScreen.tsx` sin captura de trazo; `executeCheckInConfirmation` envía `signatureObjectKey:
  "sig_mobile_demo"` (`api.ts:98`) y responde «executed» si el API no contesta (:106-108). **No enrutadas** desde `App.tsx`
  (solo se importa `checkInSteps`, `AICommandCenterScreen.tsx:9`). `nativeCapabilities.ts`: puente
  `setNativeCapabilityBridge` sin implementación → voz y campos del documento constantes; sin cámara ni NFC (el diseño CHK
  §2 ya lo señalaba: el chip del DNI exige app nativa).
- **Guest journey móvil:** `GuestJourneyScreen.tsx:5-19` 13 pasos fijos y titular inventado; no lee
  `GET /reservations/:id/guest-journey`.
- **Copy:** inglés en su mayoría («Coming soon / In progress», «Mobile operating system for hotel teams», grupos «Finance &
  Compliance», «Guest Experience»…); ninguna pantalla en `pilots/tanda5-nav-tree.csv`; solo el typecheck y
  `tests/brand-contract.test.mjs` la vigilan (marca `ehotelOS` correcta en `src/config/brand.ts`).
- **Para quién:** recepción (Hoy, llegadas/salidas, PMS, huéspedes, IA), pisos y mantenimiento (tareas, planning), administración
  (finanzas, cumplimiento), comercial/dirección (revenue, canales, activos, propietario), sistemas (configuración, alta,
  marketplace, dev). Todo maqueta.
- **Decisión aplicada:** congelar como demo interna («no publicar en tiendas ni enseñar como producto») y documentar; lo que
  haría falta para conectarla (montar `AuthProvider`, `EXPO_PUBLIC_API_BASE_URL`, retirar `prop_123` y los respaldos,
  elegir 5-6 pantallas útiles, cámara/MRZ reales, español, CSV) queda en el README.

## 7. Decisiones para César (opción por defecto aplicada en el árbol)

| # | Decisión | Defecto aplicado | Dónde cambiarlo |
|---|---|---|---|
| D1 | Encuesta post-estancia: a quién, cuándo, remitente | `postStaySurveyEnabled=false` por hotel (`true` en `prop_chk`), 24 h tras la salida, solo titulares con correo y consentimiento; correo simulado sin `EMAIL_PROVIDER` | «Portal del huésped» / `PUT …/check-in/policy`; plantilla `post_stay_survey` por hotel |
| D2 | Salida por el portal | Petición a recepción (exprés / tardía / factura por correo / consigna); recepción cierra | `stay.ts checkOutOptions`, `createGuestStayRequest` |
| D3 | PSP para pagar desde el portal | Enlace solo con PSP; sin él «se cobra en recepción», nunca «pagado» | Contrato PSP (`payments/psp/*`) + claves |
| D4 | Dominio del portal, correo, WhatsApp | Simulado; `GUEST_WEB_BASE_URL` local por variable | `.env` (`GUEST_WEB_BASE_URL=https://huesped.ehotelos.com`, `EMAIL_*`, `WHATSAPP_*`) |
| D5 | App móvil | Congelada como demo interna y documentada; sin código | `apps/mobile/README.md` |
| D6 | Firma sin alternativa de arrastre (2.5.7) | «Firmar en recepción» como alternativa; trazo táctil como evidencia | `SignaturePad.tsx onDefer` |
| D7 | `@types/react` en guest-web | SKIP explícito; build + tests + contratos + e2e como puerta | `pnpm-lock.yaml` (sesión dueña del lockfile) |
| D8 | Rutas legadas `/guest-portal/session/:token*` | `GET …/:token` verifica (401); `/folio` y `/pay` se conservan | `server.ts:3287-3335` |
| D9 | Idiomas del portal | es (defecto) + en; fr/de fuera | `wizard.ts COPY`, `pickLanguage` |
| D10 | Hardware de kiosco, cerraduras, certificados de wallet | QR de demo + «recoge tu tarjeta en recepción» | adaptadores `none`/`sandbox` (runbook CHK §9) |

## 8. Hallazgos de la revisión: confirmados, refutados, corregidos; pendientes con dueño

### 8.1 Confirmados y corregidos (8 medium + 10 low; 0 refutados)

Los ids son los de los dos revisores (`funcional-runtime-REV-L7-nn` y `seguridad-datos-regresiones-L7-REV-nn`); la evidencia
completa (ruta, cuerpo, respuesta, fila SQL, captura de texto de la pantalla) está en `scratchpad/L7/rev-probe.json`,
`rev-probe2.json` y `review-probe.log`; la verificación de cada corrección en `corr-probe.json` y `corr-e2e-run2.log`.

| Id | Sev. | Hallazgo (fichero:línea de la revisión) | Corrección (corrector L7-REV) | Test que la fija |
|---|---|---|---|---|
| funcional REV-L7-01 | medium | `guest-journey.service.ts:136,149,285` buscaba `post_stay_survey:<id>` por **prefijo**: el recorrido de `chk_res_07` mostraba la invitación y el aviso de `chk_res_07p` (mismo `deliveryId`); recepción y huésped se contradecían | `post_stay_survey:<id>` en `exact` (`notificationId: { in }`) y comparación `===`; solo `welcome:<id>:` sigue por prefijo | `guest-journey.test.mts` caso `r1`/`r1x` (13/13); runtime `CHK-07` sin la invitación de `CHK-07P` |
| funcional REV-L7-02 | medium | `post-stay-survey.service.ts:456,472` ofrecía y aceptaba la encuesta a una `confirmed` con la salida pasada (no-show sin marcar): un score 2 entró en el NPS del hotel; la ruta manual sí exigía `checked_out` | `surveyOpenFor(reservation, stage)`: `available` y POST exigen `status = checked_out` (409 `SURVEY_NOT_AVAILABLE { stage, status }`); `GuestSurveyView.reservationStatus`; portal: `stageHintKey` «La fecha de salida ya pasó sin registrar tu llegada…», `stayActions({ stayed })` sin encuesta, bloque «Tu opinión» solo con estancia real | `post-stay-survey.test.mts` 18, `stay.test.mts` 72, `tests/integration/guest-survey.test.mts` (caso «nunca se alojó»); runtime RES-00053 |
| funcional REV-L7-03 | medium | `StayOverviewPage.tsx:281` y `CheckOutPage.tsx:211`: una cancelada (RES-00010, penalización FLEX24 95 €) tenía «Salida y cuenta» y «Quiero pagar ahora»; el API respondía `at_reception` | `folioActionKey` (cancelled → sin botón; post_stay → «Cuenta y facturas»), `checkOutCopy` («Reserva cancelada · cargos de cancelación»), `canOfferPayment(folio, stage)` false + copy `paymentCancelledAtReception` es/en | `stay.test.mts`, `guest-portal-ui-contract`; pantalla RES-00010 en `:5237` sin «Salida y cuenta», sin servicio ni chat |
| seguridad REV-01 | medium | `guest-portal-auth.service.ts:230`: el enlace de la encuesta emitía una `GuestPortalSession` de 30 días SIN ámbito: el token del correo abría folio, wifi/contraseña, facturas PDF, peticiones, enlace de pago y check-in durante un mes | `guest_portal_sessions.purpose` (migración `…210000`); `verifyGuestToken(token, { purposes })` admite `sign_in` + `invitation` por defecto; `issueGuestPortalSession({ purpose })` → `survey`; `inviteReservation` marca `invitation`; solo `GET|POST /guest-portal/survey` admiten `survey`; portal: `signInWithToken(token, { scope: "survey" })`, Router monta solo `SurveyPage` («Entrar en el portal con mi código») | `tests/integration/guest-survey.test.mts` 13/13 (8 rutas → 401 con el token del enlace); `corr-probe.json A.scoped401`; e2e `survey.spec` |
| seguridad REV-02 | medium | `guest-stay.service.ts:63` `STAY_CLOSED_STATUSES = [cancelled, no_show]`: un huésped ya salido (RES-00029) creaba `SRQ-XJOCJCJG luggage open` en la cola de recepción | `allowedStayRequestKinds(stage)` = `GUEST_STAY_REQUEST_KINDS_BY_STAGE` (shared; espejo `STAY_REQUEST_KINDS_BY_STAGE` en `stay.ts`): `checked_out` → 409 `STAY_CLOSED` salvo `invoice_email`; fuera de etapa → 409 `STAY_REQUEST_NOT_ALLOWED { stage, kind, allowed }` | `guest-stay.test.mts` 28, `tests/integration/guest-stay.test.mts` 14; runtime `A.requests` / `B.request.express` |
| seguridad REV-03 | medium | `guest-stay.service.ts:353` y `checkin.routes.ts:378-381`: `payment-link` respondía `settled/paid` (y CHK persistía `paymentStatus = paid`) con un folio sin ninguna línea | `{ status: "no_charges", paymentStatus: "none" }` cuando `folio.lines.length === 0` en los dos esquemas; `GuestStayPaymentLinkResponse` tipado (`paid` solo en `settled`); `stay.ts`/`client.ts`/`CheckInWizardPage` aceptan `no_charges`; `precheckin.spec` lo admite con folio vacío | `guest-stay.test.mts`; runtime `A.paymentLink = no_charges/none` |
| seguridad REV-04 | medium | `docs/api-contracts.md`: `GET /reservations/:id/guest-journey` y `GuestJourneyView` (L7-07) sin contrato; el wire type vivía solo en el servicio y su espejo | `GuestJourneyView` y DTOs en `packages/shared/src/guest-portal-types.ts` (el servicio re-exporta; `guestJourneyApi.ts` importa de `@hotelos/shared`); tabla «Recorrido del huésped en recepción» en `api-contracts.md` (permiso, 404 opaco, forma completa, `recipient` enmascarado, sin `qrPayload`) | typecheck shared/api/admin-web; contrato de rutas 32/32 |
| seguridad REV-05 | medium | `CheckInWizardPage.tsx:1055`, `ArrivalPage.tsx:157`, `KioskShell.tsx:215`: «Firmar en recepción» en el kiosco mostraba un ticket `K-nnnn` calculado en cliente; la sesión seguía `ready_for_arrival` sin `handoffKind` ni `kioskDeviceId` y recepción no lo veía | `POST /guest-portal/check-in/handoff { kind: "signature" }` (token del huésped + `x-kiosk-token`): `handoffToReception` en `checkin-session.service.ts` → `handed_off · handoffKind signature_pending · handoffReason «Firma en recepción · ticket K-nnnn»` (`handoffTicketFor`, FNV-1a por sesión) · `kioskDeviceId`/`arrivedAt` · auditoría `CheckInHandedOff` · idempotente · 409 `CHECKIN_SESSION_CLOSED`; manifiesto CHK (31 rutas) + `api-reference`; kind `signature_pending` en `front-desk-queue` (API + admin-web); la tablet solo pinta `outcome.ticket` del servidor; `handoffTicket` eliminado de `kiosk-mode.ts` | `checkin-session.test.mts` 20, `front-desk-checkin.test.mts` 12, `frontdesk-checkin-columns`, `guest-portal-a11y-contract`; `tests/integration/kiosk-pairing.test.mts` 8/8 (handoff → cola → `resolve-handoff`); runtime `D.handoff K-8754` |
| funcional REV-L7-04 | low | Peticiones de salida sin regla por etapa | Cubierto por REV-02 (documentado en `api-contracts.md` y runbook §2) | los de REV-02 |
| funcional REV-L7-05 | low | `submitServiceRequest` (`guest-portal.service.ts`) y `POST /guest-portal/chat` aceptaban reservas canceladas/no-show; «Pedir un servicio» visible tras la salida | `assertGuestStayOpen` → 409 `STAY_CLOSED`; `StayOverviewPage` oculta «Pedir un servicio» en `post_stay`; `ServiceRequestPage` traduce `STAY_CLOSED` | integración `guest-stay` (ruta clásica 409); runtime `C.cancelled` |
| funcional REV-L7-06 | low | Tras «Cerrar sesión» desde la encuesta el Router conservaba la página | `App.tsx`: `<Router key={session?.reservationId ?? "anon"}>` + `initialPage` a la estancia (ref `hadSession`) | e2e `survey.spec` paso 5 |
| funcional REV-L7-07 | low | El log de peticiones solo redactaba `?token=`; el path legado `/guest-portal/session/<token>` quedaba en claro | `server.ts` `redactTokenInUrl` cubre `/guest-portal/session/<token>[/folio|/pay]` | `tests/cors-contract.test.mjs` (+4 asserts); log del API con `<redacted>` |
| funcional REV-L7-08 | low | `returnUrl` del enlace de pago admitía cualquier cadena (`javascript:`, `data:`) | `z.string().trim().url().regex(/^https?:\/\//i).max(500)` (`HTTP_URL_PATTERN`) en `StayPaymentLinkSchema` y `PaymentLinkSchema` | unit `guest-stay` + integración (400); runtime `A.paymentLink.javascriptUrl` |
| seguridad REV-06 | low | Cabecera de `playwright.config.ts` con la invocación errónea (`-- --project guest`) | `e2e --project=guest` (y `--project=guest <spec>`), sin `--` | — (documental) |
| seguridad REV-07 | low | Aviso del Recorrido con número de lote («lote L7-04») visible al usuario | «Este servidor no permite el envío inmediato de la encuesta; se envía sola tras la salida cuando la política del hotel la activa.» | admin-web unit 2.040 |
| seguridad REV-08 | low | `_guest-helpers.ts` `E2E_API_URL` por defecto `:3000` (instancia intocable) | Por defecto `http://127.0.0.1:3937` (README/runbook al día) | — (documental) |
| seguridad REV-09 | low | `?token=` aceptado en todos los GET del portal (`/stay`, `/survey`): el token podía quedar en historial/proxies | `guestTokenFrom(request, { allowQueryToken })`: `?token=` SOLO en `GET /guest-portal/invoices/:id/pdf`; `/stay` y `/survey` con query → 401 | integración `guest-stay` («L7-REV-09»); runtime `A.stay.queryToken 401`; docs/runbook/ESTADO corregidos |
| seguridad REV-10 | low | `db:seed:checkin -- --reset` no purgaba las `RES-*` de e2e (63 reservas acumuladas, tipo DBL agotado); `precheckin`/`survey` dejaban su habitación sucia | `--reset` purga las reservas de `prop_chk` con `bookerEmail prueba.portal.%` sin factura (`E2E_BOOKER_EMAIL_PREFIX`, `deleteScoped`, línea en el plan `--dry-run`); `releaseReservationRoom` en `finally` de `survey.spec` y `precheckin.spec` | `tests/seed-checkin-contract.test.mjs` 14/14; ejecutado: 68 purgadas, `prop_chk` 79 → 11 |

**Refutados:** ninguno. **No corregidos a propósito:** `nav-tree --check` (ajeno), deuda 19b/`survey_detractor`/rango de
`answers`/`@types/react` (fuera del alcance), firma diferida del móvil como aviso local (§2, corrector).

### 8.2 Pendientes con dueño (deuda 19 de `CLAUDE.md`)

| # | Pendiente | Dónde | Dueño propuesto |
|---|---|---|---|
| 1 | ~~Handoff del kiosco/asistente solo en cliente~~ → **cerrado por el corrector L7-REV-05**: `POST /guest-portal/check-in/handoff` marca `handed_off · signature_pending · kioskDeviceId`, devuelve el ticket `K-nnnn` (único que pinta la tablet), audita `CheckInHandedOff` y entra en la cola de Mi día (`signature_pending`); `resolve-handoff` lo cierra | `checkin.routes.ts` / `checkin-session.service.ts` | — |
| 2 | `GET /guest-portal/check-in` (`ensureSession`) crea sesiones `invited` al vuelo en reservas alojadas, salidas o canceladas | `checkin.routes.ts guestSession/ensureSession` | CHK |
| 3 | ~~`--reset` no purga las `RES-*` de e2e; `precheckin`/`survey` no re-marcan limpia su habitación~~ → **cerrado por el corrector L7-REV-10** (purga de `bookerEmail prueba.portal.*` sin factura, solo `prop_chk`; `releaseReservationRoom` en `finally`) | `seed-checkin.ts`, `_guest-helpers.ts` | — |
| 4 | ~~`GuestJourneyView` sin sección en `docs/api-contracts.md`~~ → **cerrado por el corrector L7-REV-04** (wire type en `packages/shared/src/guest-portal-types.ts`, `guestJourneyApi.ts` lo importa de `@hotelos/shared`, tabla en `api-contracts.md`) | `docs/api-contracts.md`, `guest-portal-types.ts` | — |
| 5 | Encuesta: respuesta ≤ 6 no crea `QualityCase survey_detractor`; `answers` sin validar rango `scale`/`nps` en servidor; producción sin `EMAIL_PROVIDER` → `failed` sin reintento (`already_invited` bloquea) | `post-stay-survey.service.ts` | T8/L7 · César (proveedor) |
| 6 | `apps/guest-web` sin typecheck (`@types/react`); `signIn` lanza `Error` inglés (`client.ts:179/:203`); toggle de idioma duplicado en el asistente (`CheckInWizardPage.tsx:143`); `.gp-check` 26 px y `<input type=date>` 39 px; `DELETE …/guests/:id` sin ejercicio e2e; `gp-nps` propio | guest-web | L7 |
| 7 | `identityVerifiedAt` no se persiste con `mrz_checksum` (`arrival.service.ts`); `CocoaSearchInput` botón de borrar 20 × 20 px; paso «Pago» del recorrido propone cobrar con folio vacío; `apps/admin-web/e2e/**` sin typecheck en las puertas | CHK · Cocoa · journey.ts · tsconfig e2e | CHK / UX |
| 8 | `apps/mobile` demo interna (§6) | `apps/mobile/README.md` | César (D5) |
| 9 | Fusión: `nav-tree.generated.json` stale (CSV compartido con filas RRHH/ACT), `env-census.mjs --write`, `cocoa-22-waves.mjs --write`, renumerar las dos migraciones si L8 aporta una marca posterior | raíz | integrador de la fusión |
| 10 | Hook: `core.hooksPath = .husky` se resuelve contra la raíz del worktree (`~/anfitorio-demo-wt-l7/.husky` no existe; el directorio vive en `hotelos/`): git no dispara `.husky/pre-commit` en ningún worktree ni en el repo principal (ruta relativa); se ejecuta a mano (`bash .husky/pre-commit` desde `hotelos/`) | `.git/config` (`core.hooksPath`) / `package.json#prepare` | César (config local, fuera del repo) |
| 11 | Sesiones `survey` emitidas ANTES de la migración `…210000` quedan `sign_in` (acceso completo hasta caducar, 30 d); en `hotelos_l7` no queda ninguna (`--reset`); en una BD real conviene revocarlas o actualizarlas por SQL al desplegar | `guest_portal_sessions` | despliegue |

## 9. Fusión: ficheros, exclusiones y servidores

Inventario exacto del commit (`git -C ~/anfitorio-demo-wt-l7 diff --numstat` + `ls-files --others`, 16:27; rutas bajo
`hotelos/`):

- **Modificados (65, +4.111 / −969):** raíz `CLAUDE.md` (+86/−1), `scripts/env-contract.json` (+1); admin-web
  `playwright.config.ts` (+22/−5), `src/screens/__tests__/screens-fixes-contract.test.mts`,
  `screens/guest-portal/GuestPortalSettingsScreen.tsx` (+165/−187), `screens/guestJourney/GuestJourneyWorkspace.tsx`
  (+202/−119), `screens/operations/{FrontDeskActionQueue.tsx, frontdesk-labels.ts, __tests__/frontdesk-checkin-columns.test.mts}`
  (corrector); api `lib/auth-context.ts` (+8), `auth/__tests__/invitations.test.mts`, `checkin/{checkin-jobs.ts (+31/−2),
  checkin-policy.service.ts, checkin-session.service.ts (+87, corrector), checkin.routes.ts (+35/−2, corrector),
  checkin.schemas.ts, route-permissions.partial.ts, __tests__/checkin-jobs.test.mts, __tests__/checkin-session.test.mts}`,
  `dashboards/{front-desk-queue.service.ts, __tests__/front-desk-checkin.test.mts}` (corrector),
  `developer/{api-reference.service.ts, __tests__/api-reference.test.mts}`, `guest-portal/{guest-portal-auth.service.ts (+85/−2),
  guest-portal.service.ts}`, `notifications/{system-templates.ts (+76), __tests__/checkin-templates.test.mts}`,
  `pms/guest-activity.service.ts` (+39/−8), `security/route-permissions.ts` (+8), `server.ts` (+29/−5); guest-web
  `index.html`, `src/App.tsx` (+90/−22), `api/client.ts` (+250/−21), `checkin/{wizard.ts (+435/−1), __tests__/wizard.test.mts}`,
  `components/{ChatWidget, DocumentCamera, Layout, QrCode, SignaturePad}.tsx`, `config/guest-config.ts`,
  `kiosk/{KioskShell.tsx (+136/−80), kiosk-mode.ts (+4/−16)}`, `pages/{ArrivalPage, CheckInWizardPage (+289/−135), PreCheckInPage,
  ServiceRequestPage, SignInPage, StayOverviewPage (+282/−129)}.tsx`, `styles.css` (+264/−18); docs `api-contracts.md` (+121/−1),
  `audits/ESTADO-VERIFICADO.md` (bloque L7 al final), `design/COCOA-22-MIGRACION.md`, `design/cocoa-22-inventory.json`,
  `manual/70-recepcion.md` (+4), `runbooks/checkin-automatizado.md` (+1), `runbooks/ux-recepcion-pruebas.md` (+37); database
  `prisma/schema.prisma` (+6), `prisma/seed-checkin.ts` (+49/−5); shared `src/checkin-types.ts` (+4), `src/index.ts` (+4);
  tests `cors-contract.test.mjs` (+5), `guest-portal-ui-contract.test.mjs` (+408/−1), `seed-checkin-contract.test.mjs` (+23/−3),
  `integration/kiosk-pairing.test.mts` (+58).
- **Nuevos (37, 10.649 líneas):** `apps/admin-web/e2e/guest-portal/{README.md 109, _guest-helpers.ts 461, journey.spec.ts 323,
  kiosk.spec.ts 213, precheckin.spec.ts 321, stay-checkout.spec.ts 342, survey.spec.ts 215}`,
  `apps/admin-web/src/screens/guest-portal/__tests__/guest-portal-settings.test.mts` (205),
  `screens/guestJourney/{journey.ts 481, __tests__/journey.test.mts 378}`, `services/{guestJourneyApi.ts 90, guestPortalApi.ts 111}`;
  `apps/api/src/modules/guest-portal/{guest-journey.routes.ts 33, guest-journey.service.ts 309, guest-portal.routes.ts 209,
  guest-stay.service.ts 413, journey-route-permissions.partial.ts 25, post-stay-survey.service.ts 526,
  route-permissions.partial.ts 37}` + `__tests__/{guest-journey 315, guest-stay 362, post-stay-survey 526}.test.mts`; guest-web
  `pages/{CheckOutPage.tsx 348, StayInfoPage.tsx 113, SurveyPage.tsx 336}`, `stay/{stay.ts 718, __tests__/stay.test.mts 578}`;
  `apps/mobile/README.md` (62); `docs/audits/TANDA-L7-HUESPED-MOVIL-2026-09-20.md` (este informe), `docs/runbooks/portal-huesped.md`
  (277); `packages/database/prisma/migrations/{20260920190000_portal_huesped_l7, 20260920210000_guest_portal_session_purpose}/migration.sql`;
  `packages/shared/src/guest-portal-types.ts` (403); `tests/guest-portal-a11y-contract.test.mjs` (246);
  `tests/integration/guest-{journey 314, stay 442, survey 444}.test.mts`.
- **Exclusiones:** `pnpm-lock.yaml` (limpio en el commit; el comando de commit lo saca del índice por si apareciera). Sin
  dependencias nuevas. Ficheros compartidos con L6b/L8 tocados solo de forma aditiva y en puntos distintos: `server.ts`
  (imports y registro de `registerGuestPortalRoutes`/`registerGuestJourneyRoutes` tras `registerCheckinRoutes`; legado
  `/guest-portal/session/:token`; `redactTokenInUrl`), `route-permissions.ts` (spread de los dos partials),
  `auth-context.ts` (3 prefijos), `system-templates.ts` (`post_stay_survey` × 4), `checkin-jobs.ts` (paso 5),
  `checkin.routes.ts` (ruta `handoff` + `no_charges` + `returnUrl`), `checkin-session.service.ts` (`handoffToReception`),
  `front-desk-queue.service.ts` (kind `signature_pending`), `api-reference.service.ts` (etiquetas), `playwright.config.ts`
  (proyecto `guest`), `api-contracts.md` (tres subsecciones al final del bloque del portal), `CLAUDE.md` (bloque compacto +
  deuda 19 + 3 líneas de docs + deuda 6), `ESTADO-VERIFICADO.md` (bloque al final).
- **Post-fusión:** `node scripts/build-nav-tree.mjs --csv <CSV compartido>` (JSON stale por las filas RRHH/ACT), `node
  scripts/env-census.mjs --write`, `node scripts/cocoa-22-waves.mjs --write` (inventario regenerado tres veces durante la
  tanda; volver a regenerar sobre el árbol fusionado), `corepack pnpm --filter @hotelos/database db:migrate:deploy` (+
  `db:drift:check`), renumerar `20260920190000_portal_huesped_l7` y `20260920210000_guest_portal_session_purpose`
  (en ese orden) si L8 aporta una marca posterior, revocar o marcar por SQL las `guest_portal_sessions` de encuesta
  anteriores a la migración en BD reales (§8.2 fila 11), `playwright install chromium` (o `PLAYWRIGHT_BROWSERS_PATH`) para
  el proyecto `guest` en CI.
- **Servidores del carril:** todas las instancias propias de la tanda (lotes, revisores, corrector) paradas por PID; el
  integrador no arrancó ninguna (`lsof` en `:3937/:5207/:5237`: nada a las 16:27); `:3000` / `:5173` y el proceso ajeno del
  puerto 3000 intactos; ningún `pkill -f`.

## 10. Commit del integrador

Un único commit en la rama `tanda-l7` (nunca en `main`, sin `push`), con `git -C ~/anfitorio-demo-wt-l7 add -A hotelos`,
`git reset -q hotelos/pnpm-lock.yaml`, autor `cesareme`, sin `--no-verify` (`bash .husky/pre-commit` ejecutado a mano antes
desde `hotelos/`, ver §2 «Integrador» y §8.2 fila 10). El sha queda en el informe del orquestador. Mensaje:

```
feat(huesped): portal del huésped completo, encuesta post-estancia y recorrido en recepción (Tanda L7)

L7-01 Portal base en español (+ inglés) y accesible: selector es/en con <html lang>, skip link,
  regiones vivas, objetivos ≥ 44 px, contraste 5,7:1, «vista previa sin API», sin teléfono ni
  factura inventados; países ISO-2 en el pre-check-in clásico.
L7-02 API de estancia: GET /guest-portal/stay, POST …/stay/{requests,payment-link} (at_reception
  sin PSP), GET …/invoices/:id/pdf; prefijos públicos; legado /session/:token verificado;
  /activity en español.
L7-03 Arnés e2e: proyecto Playwright `guest` (Pixel 5, tenant CHK) y precheckin.spec.
L7-04 Encuesta post-estancia: migración 20260920190000_portal_huesped_l7 (política
  post_stay_survey_enabled / _delay_hours), plantilla post_stay_survey, paso 5 del tick,
  GET|POST /guest-portal/survey, POST /reservations/:id/post-stay/survey-invite, seed CHK.
L7-05 Asistente de 6 pasos y kiosco accesibles (WCAG 2.2 AA): foco al paso, etiquetas, cámara
  por teclado, «Firmar en recepción», aviso de inactividad como alerta, contrato a11y.
L7-06 Portal de estancia y salida: Salida y cuenta (folio real, facturas PDF, peticiones
  SRQ-<8>, pago honesto), Información del hotel, stay.ts puro, client.ts sin stubs falsos.
L7-07 Recorrido en recepción: GET /reservations/:id/guest-journey (GuestJourneyView sin PII),
  13 pasos reales, avisos «Simulado», Invitar / Reenviar / Enviar encuesta.
L7-08 SurveyPage (NPS 0-10 radiogroup, ?survey=1) y ajustes «Portal del huésped» con las 3
  claves reales de la política.
L7-09 e2e completo: stay-checkout, kiosk (reloj falso), journey; README de e2e/guest-portal.
L7-10 Cierre: runbook portal-huesped.md, informe, README de apps/mobile (demo interna, D5),
  manual de recepción, CLAUDE.md y ESTADO-VERIFICADO.
Corrector L7-REV (8 medium + 10 low, 0 refutados): sesión de la encuesta con ámbito
  (guest_portal_sessions.purpose, migración 20260920210000_guest_portal_session_purpose),
  peticiones por etapa (STAY_CLOSED / STAY_REQUEST_NOT_ALLOWED), no_charges con folio vacío,
  recorrido por igualdad, encuesta solo checked_out, cancelada sin Salida y cuenta ni pago,
  POST /guest-portal/check-in/handoff con ticket del servidor y cola signature_pending,
  /service-request y /chat cerrados con la reserva, ?token= solo en el PDF, redactTokenInUrl
  del path legado, returnUrl http(s), --reset purga las RES-* de e2e, GuestJourneyView en
  @hotelos/shared + api-contracts.
Puertas: completa 13/14 (única roja nav-tree --check por el CSV compartido con filas RRHH/ACT);
  e2e guest 5/5; migraciones 26/26 con deriva cero en hotelos_l7; pnpm-lock.yaml fuera.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
