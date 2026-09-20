# Runbook · Portal del huésped, kiosco y recorrido (Tanda L7 · 2026-09-20)

Operación del portal del huésped `apps/guest-web` (sesión por enlace o por código, pre-check-in, llegada, estancia, salida,
facturas, encuesta post-estancia, bot, modo kiosco), de las rutas `/guest-portal/*` del API que lo sirven
(`apps/api/src/modules/guest-portal/*` + `modules/checkin/*`), de las notificaciones al huésped y del «recorrido del
huésped» que ve recepción. Complementa —no repite— `docs/runbooks/checkin-automatizado.md` (asistente de 6 pasos,
identidad, firma, pago, asignación, kiosco §9, bot §10, seed `org_chk` §11) y `docs/api-contracts.md` («Portal del
huésped · estancia y salida» y «Encuesta post-estancia»: cuerpos y respuestas exactos). Informe de cierre:
`docs/audits/TANDA-L7-HUESPED-MOVIL-2026-09-20.md`. La app móvil `apps/mobile` queda como demo interna (su
`README.md`); nada de este runbook la afecta.

Cifras del árbol (2026-09-20): portal 8.925 líneas en `apps/guest-web/src` (9 páginas, asistente `CheckInWizardPage.tsx`
1.149, `api/client.ts` 1.117, `checkin/wizard.ts` 1.318 con 384 claves de copy es/en, `stay/stay.ts` 666,
`styles.css` 1.438); módulo `apps/api/src/modules/guest-portal/*` 3.184 líneas (6 rutas nuevas del huésped + 2 de
personal: encuesta manual y recorrido); 5 specs e2e (1.921 líneas) en `apps/admin-web/e2e/guest-portal/`.

## 1 · Configuración (`.env`) y qué pasa sin cada variable

Contrato en `scripts/env-contract.json` (`node scripts/env-census.mjs --write` lo regenera junto a `.env.example`).
El API lee estas variables; el portal (Vite) solo lee las `VITE_*` en tiempo de build/dev.

| Variable | Defecto | Efecto · qué pasa sin ella |
|---|---|---|
| `GUEST_WEB_BASE_URL` | `http://localhost:5174` | Origen público del portal. Con él se construyen los tres enlaces que salen del hotel: invitación al check-in `<base>/checkin?token=…&property=<id>` (`checkin/checkin-session.service.ts:703-704`), enlace de la encuesta `<base>/?survey=1&token=…&property=<id>` (`guest-portal/post-stay-survey.service.ts:78,147`) y el enlace del bot/bienvenida (`messaging.service.ts`, `event-hooks.service.ts`). Sin ella los enlaces apuntan a `localhost:5174` (solo vale en local). En el carril se pasa por variable (`GUEST_WEB_BASE_URL=http://127.0.0.1:5237`), nunca escribiendo el `.env`. En producción es `https://huesped.ehotelos.com` (D4, dominio que crea César). |
| `VITE_GUEST_API_BASE` | — (`""`) | Base del API que usa el portal (`config/guest-config.ts:38-46`, `api/client.ts`). Sin ella `isApiConfigured()` es `false`: el portal funciona con stubs en memoria («vista previa sin API»: cualquier código entra, estancia de demostración con folio 186 € y pago «en recepción») y pinta el aviso `demoNoApi` en la estancia, la salida y la información del hotel. Nunca se despliega así. |
| `VITE_GUEST_PROPERTY_ID` | — | Hotel del portal (`guest-config.ts:14-30`). Orden de resolución: `?property=<id>` en la URL (enlaces de invitación y de encuesta lo llevan) → esta variable → `""`. Sin ninguno de los dos la pantalla de acceso avisa y `POST /guest-portal/sign-in` responde `ok:false` (el código de reserva solo es único por hotel). |
| `EMAIL_PROVIDER` + `EMAIL_PROVIDER_KEY` + `EMAIL_FROM` | — | Correo real (`notifications/providers/email.provider.ts:16-21`). Sin los tres, fuera de producción cada entrega queda `sent` con `errorMessage "SIMULADO: proveedor no configurado; no se envió de verdad."` (`dispatcher.service.ts:270`) y nada sale de la máquina; en producción queda `failed` y no se reintenta sola. Afecta a invitación, recordatorio, OTP por correo, bienvenida y encuesta post-estancia. Con envío simulado el API devuelve el enlace en claro para probarlo: `InvitationResult.checkInUrl` (invitación) y `surveyUrl` en la ruta manual de la encuesta (nunca en el tick). |
| `GUEST_PORTAL_RETURN_TOKEN` | `false` | Con `true` la invitación devuelve `token` / `checkInUrl` aunque el correo sea real (`checkin-session.service.ts:769`). Solo para pruebas. |
| `WHATSAPP_PHONE_ID` + `WHATSAPP_PROVIDER_TOKEN` (+ `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` para el webhook de entrada) | — | Canal WhatsApp (`providers/whatsapp.provider.ts:14-18,53-58`): sin ellos `simulated` fuera de producción y `failed` en producción. La invitación y la bienvenida admiten `whatsapp`; la **encuesta solo sale por correo** (`POST_STAY_SURVEY_CHANNEL = "email"`, aunque exista la plantilla `post_stay_survey` de WhatsApp y SMS). Detalle del webhook y de las plantillas *utility* en `checkin-automatizado.md` §1 y §13. |
| `RUN_SCHEDULERS` · `CHECKIN_INVITATION_DISABLED` · `CHECKIN_INVITATION_INTERVAL_MS` · `CHECKIN_ASSIGNMENT_RUN_AT` | `true` · `false` · 1 h · `18:00` | El tick del check-in (`checkin/checkin-jobs.ts`, solo la instancia líder) invita, recuerda, sugiere habitación, purga y —paso 5, independiente— **invita a la encuesta post-estancia** (`postStaySurveyAll`, :386-389). Los carriles arrancan con `RUN_SCHEDULERS=false`: no hay envíos automáticos; se usan las rutas manuales (invitar: `POST /properties/:propertyId/check-in/sessions`; encuesta: `POST /reservations/:id/post-stay/survey-invite`). |
| `AI_PROVIDER` · `AI_PROVIDER_API_KEY` · `AI_MODEL` | `none` | Bot del huésped por reglas (`mode: "rules"`) y captura de documento solo por MRZ (lector o texto pegado); con clave, visión y clasificación con modelo. `checkin-automatizado.md` §1 y §10. |
| `HOTELOS_ALLOW_DEMO_AUTH` | — | Fuera de producción y con `true`, el OTP de identidad devuelve `debugCode`. |
| `RBAC_STRICT` | — | Con `true` (carriles) toda ruta sin entrada en el manifiesto responde 403: las 6 rutas del huésped y las 2 de personal de este módulo están en `modules/guest-portal/route-permissions.partial.ts` y `journey-route-permissions.partial.ts`. |
| `RATE_LIMIT_MAX` | — | Solo en pruebas (e2e): sube el límite global para que un recorrido de 30-40 peticiones no tropiece con el 429. |
| `E2E_API_URL` · `E2E_GUEST_BASE_URL` · `E2E_ADMIN_BASE_URL` · `E2E_CHK_PASSWORD` · `E2E_SHOTS_DIR` · `TARGET_SIZE_OUT` · `E2E_GUEST_ARRIVAL_OFFSET_DAYS` · `E2E_KIOSK_ARRIVAL_OFFSET_DAYS` · `PLAYWRIGHT_BROWSERS_PATH` | ver §8 | Solo para las specs del proyecto Playwright `guest`. |

CORS: en desarrollo el API admite cualquier origen `localhost` / `127.0.0.1` y las cabeceras `x-guest-token` /
`x-kiosk-token` (`tests/cors-contract.test.mjs`); en producción el portal es *same-origin* tras Caddy.

## 2 · Etapas del huésped: pre-llegada → estancia → salida → post-estancia

La etapa la calcula el API con la fecha LOCAL del hotel (`Property.timezone`) y el estado de la reserva
(`guest-stay.service.ts:83`, espejo `stay/stay.ts:126-136`): `pre_arrival` (confirmada, hoy < llegada) ·
`arrival_day` (confirmada, llegada ≤ hoy < salida, sin check-in) · `in_house` (alojada, hoy < salida) ·
`departure_day` (alojada, hoy ≥ salida) · `post_stay` (salida hecha, o confirmada con la salida pasada: en ese caso el
portal NO da las gracias ni ofrece la encuesta —«La fecha de salida ya pasó sin registrar tu llegada»—, corrector
REV-L7-02) · `cancelled` (cancelada o no-show). `StayOverviewPage` pinta la etapa, una acción principal y una secundaria
(`stay.ts stayActions`), habitación, llave, saldo real del folio y el chat (salvo cancelada).

| Etapa | Qué ve y hace el huésped (`apps/guest-web/src/pages`) | Rutas del huésped (token opaco; `permissions: []`, `riskLevel: "public"`) | Qué ve recepción |
|---|---|---|---|
| Acceso | `SignInPage`: código de reserva + correo con el que reservó; o enlace de invitación (`/checkin?token=…`), enlace de la encuesta (`/?survey=1&token=…`) o kiosco (`?kiosk=1&device=…`). El token de la URL se consume UNA vez (`App.tsx consumeUrlToken`), pasa a `sessionStorage` y desaparece de la barra. | `POST /guest-portal/sign-in { propertyId, reservationCode, email }` (24 h; anti-enumeración) · `POST /guest-portal/sign-out` · `GET /guest-portal/reservation` | `guest_portal_sessions` activas y `lastCreatedAt` en el recorrido (`portalSessions`) |
| Pre-llegada (`pre_arrival`) | Acción «Empezar / Continuar / Revisar el pre-check-in» → asistente de 6 pasos `CheckInWizardPage` (Viajeros → Documento → Datos → Firma → Pago y extras → Llegada) si hay `CheckInSession`; si el hotel no invitó, formulario clásico `PreCheckInPage` (ETA, preferencias, consentimientos). Secundaria: «Pedir un servicio» (`ServiceRequestPage`). | Asistente: `GET/PATCH /guest-portal/check-in`, `…/guests`, `…/guests/:id/{mrz,document,signature}`, `…/payment-link`, `…/complete` (tabla completa en `checkin-automatizado.md` §3). Clásico: `POST /guest-portal/pre-check-in`, `POST /guest-portal/service-request`. | Mi día › Llegadas: columna «Pre-check-in» (invitado · en curso · listo · llegado); `ArrivalPreCheckInDrawer`; ficha › **Recorrido** (§9): invitación con su aviso, viajeros completos n/m, firmados n/m, identidad, pago. Invitar o reenviar: `POST /properties/:propertyId/check-in/sessions` (`pms.reservation.modify`, medium). |
| Día de llegada (`arrival_day`) | Acción «Ya estoy en el hotel» → `ArrivalPage`: habitación, llave (QR de demo o «Recoge tu llave en recepción»), o el motivo honesto (409 fuera de ventana, identidad no verificada, saldo, habitación no lista → «Acércate al mostrador»). «Firmar en recepción» en el kiosco → `POST /guest-portal/check-in/handoff` y la pantalla pinta SOLO el ticket `K-nnnn` que devuelve el API (§6). En kiosco, lo mismo con botones ≥ 56 px. | `POST /guest-portal/check-in/arrive`, `…/handoff`, `…/otp/request`, `…/otp/verify`, `…/kiosk/claim` | Cola de Mi día (`self_checkin_done`, `identity_review`, `room_not_ready`, `payment_failed`, `signature_pending` con el ticket); cajón de check-in cierra lo que el huésped no cerró (`resolve-handoff`); Recorrido: habitación, check-in, llave, bienvenida. |
| Estancia (`in_house`) | Principal «Pedir un servicio»; secundaria «Salida y cuenta» (`CheckOutPage`: cargos y pagos REALES del folio principal, saldo; «Quiero pagar ahora» → sin PSP «Se cobra en recepción», nunca «pagado»); «Información del hotel» (`StayInfoPage`: wifi, desayuno, hora de salida, teléfono, dirección; lo no configurado no se inventa); chat con el bot (`ChatWidget`). | `GET /guest-portal/stay` · `POST /guest-portal/stay/payment-link` · `POST /guest-portal/service-request` · `POST /guest-portal/chat` (30/min por IP) | Peticiones en `GET /reservations/:id/activity` (kind `service_request`, título en español) y `PATCH /service-requests/:id`; mensajes del bot en Mensajes de huéspedes; Recorrido: «Estancia · el huésped está en casa», peticiones abiertas. |
| Día de salida (`departure_day`) | Principal «Salida exprés» → `CheckOutPage`: peticiones `express_checkout` · `late_checkout` · `invoice_email` · `luggage` con nota y hora preferida → «Petición recibida · SRQ-xxxxxxxx»; la salida la cierra recepción (D2). El API exige las MISMAS listas por etapa que ofrece el portal (`GUEST_STAY_REQUEST_KINDS_BY_STAGE`: antes de llegar solo salida tardía y consigna; tras la salida solo la factura por correo). | `POST /guest-portal/stay/requests` → 201 `{ id, ticketNumber: "SRQ-<8>", kind, status: "open" }`; 409 `STAY_CLOSED` si la reserva está cerrada o ya salió (salvo `invoice_email`); 409 `STAY_REQUEST_NOT_ALLOWED { stage, kind }` fuera de la etapa | `ServiceRequest` `front_office` + evento `GuestCheckoutRequested`; Mi día › Salen hoy → «Cobrar … y cerrar» / «Hacer check-out» (`docs/manual/70-recepcion.md`). |
| Post-estancia (`post_stay`) | «Estancia terminada»: «Cuenta y facturas» (facturas emitidas para descargar, PDF propio; petición de factura por correo), «Responder la encuesta» (`SurveyPage`, §5) como acción principal si el hotel invitó y no hay respuesta, secundaria si entró con su código; «Gracias por tu opinión» tras responder. Sin «Pedir un servicio». Una `confirmed` con la salida pasada (nunca se alojó): aviso honesto, sin encuesta. Con la sesión del ENLACE de la encuesta solo se ve la encuesta; el resto del portal pide el código (§3). | `GET /guest-portal/invoices/:id/pdf` (solo `Invoice.reservationId` de la sesión, `status ≠ draft`; `?token=` admitido SOLO aquí en todo el módulo) · `GET /guest-portal/survey` · `POST /guest-portal/survey` (solo reserva `checked_out`) | Recorrido: «Check-out y factura · salida hecha», «Encuesta post-estancia · enviada / respondida · puntuación n/10», botón «Enviar encuesta ahora» (`POST /reservations/:id/post-stay/survey-invite`, `pms.reservation.modify`, medium); NPS en `/dashboards/surveys`. |
| Cancelada / no-show (`cancelled`) | Etapa «Reserva cancelada», sin acciones ni chat: sin «Salida y cuenta» ni «Pedir un servicio»; si abre la cuenta, cabecera «Reserva cancelada · cargos de cancelación» sin CTA de pago («se gestionan en recepción», D3). | Las escrituras responden 409 `STAY_CLOSED` (también `POST /guest-portal/service-request` y `POST /guest-portal/chat`). | — |

Rutas de personal de la tanda (claves RBAC existentes, sin `rbac:sync`): `GET /reservations/:id/guest-journey`
(`pms.reservation.read`, low, `assertEntityAccess`; `journey-route-permissions.partial.ts`) y
`POST /reservations/:id/post-stay/survey-invite` (`pms.reservation.modify`, medium; `route-permissions.partial.ts`).
Los ajustes «Portal del huésped» (`/comercial/ventas-adicionales/portal`, pestaña gateada por `guest_self_service`)
guardan SOLO las tres claves de `PropertyCheckInPolicy` que gobiernan el portal fuera del asistente
(`postStaySurveyEnabled`, `postStaySurveyDelayHours`, `allowPayAtReception`) con `PUT /properties/:id/check-in/policy`
(`guest_self_service.manage`); el resto de la política vive en `/hoy/check-in-automatizado`.

## 3 · Sesión del huésped y token

- El token es un aleatorio de 32 bytes en hex; en BD solo su hash (`guest_portal_sessions.token_hash`). Vigencia 24 h
  para el sign-in y la invitación; **30 días** para el enlace de la encuesta (`POST_STAY_SURVEY_SESSION_TTL_MS`,
  `guest-portal-auth.service.ts`). Revocar = `POST /guest-portal/sign-out` o reenviar la invitación (revoca el anterior).
- Viaja en la cabecera `x-guest-token` (`api/client.ts`). `?token=` se admite ÚNICAMENTE en `GET /guest-portal/invoices/:id/pdf`
  (el enlace de descarga no puede llevar cabeceras; corrector L7-REV-09: `/stay` y `/survey` lo rechazan también en GET);
  las escrituras lo rechazan siempre. El logger redacta `token=` de la URL y el token del path legado
  `/guest-portal/session/<token>` (corrector REV-L7-07).
- **Ámbito (`guest_portal_sessions.purpose`, corrector L7-REV-01)**: `sign_in` (código + correo) e `invitation` (enlace
  del check-in) abren el portal completo; `survey` (enlace de la encuesta, 30 días) SOLO abre `GET|POST /guest-portal/survey`
  —el resto (estancia, folio, wifi, facturas, peticiones, pago, check-in, chat) responde 401 `GUEST_SESSION_INVALID`—.
  El portal, con `?survey=1&token=…`, verifica el enlace contra la encuesta (`GET /guest-portal/survey` devuelve
  `reservation` mínima y `sessionPurpose`), monta solo `SurveyPage` y ofrece «Entrar en el portal con mi código», que
  cierra la sesión y lleva al acceso. Migración `20260920210000_guest_portal_session_purpose` (aditiva, `DEFAULT 'sign_in'`).
- En el navegador vive en `sessionStorage` (`GuestSessionContext`), nunca en `localStorage`; el kiosco borra las claves
  del huésped al reiniciar y conserva solo la credencial del dispositivo (`kiosk/kiosk-mode.ts:131-140`).
- Prefijos sin JWT de personal (`lib/auth-context.ts:88-109` `PUBLIC_PREFIXES`): `/guest-portal/{sign-in,sign-out,
  reservation,pre-check-in,service-request,check-in,chat,stay,invoices,survey}`; cada handler llama a `verifyGuestToken` y
  responde `401 { message, details: { code: "GUEST_SESSION_INVALID" } }` si el token no vale, caducó o fue revocado. El
  `reservationId` y el `propertyId` salen siempre de la sesión verificada.
- Legado (D8): `GET /guest-portal/session/:token` ahora verifica (401 si no) y devuelve `{ token: "[redacted]", status,
  reservationId }` (`server.ts:3287-3297`); `…/:token/folio` y `…/:token/pay` se conservan. El portal no las usa.
- Las rutas `/guest-portal/check-in*` y `/chat` exigen el módulo `guest_self_service` en la propiedad; `/stay`, `/invoices`
  y `/survey` no (como `/guest-portal/reservation`).

## 4 · Notificaciones al huésped y modo simulado

| Aviso | Quién lo dispara | `notificationId` | Plantilla de sistema (`notifications/system-templates.ts`) |
|---|---|---|---|
| Invitación al check-in en línea | recepción (`POST …/check-in/sessions`) o el tick del líder | `checkin_invitation:<guestPortalSessionId>` | `checkin_invitation` (email es/en, whatsapp, sms) |
| Recordatorio J-1 | tick | `checkin_reminder:<guestPortalSessionId>` | `checkin_reminder` |
| Bienvenida | `completeCheckIn` (llegada) | `welcome:<reservationId>:<canal>` | `checkin_welcome` |
| Encuesta post-estancia | paso 5 del tick o `POST /reservations/:id/post-stay/survey-invite` | `post_stay_survey:<reservationId>` | `post_stay_survey` (email es/en; whatsapp y sms es, sin uso hoy) |

- Todas pasan por el dispatcher con `redact` del token (`checkInUrl` / `surveyUrl`): el enlace NUNCA se persiste en
  `notification_deliveries`; `GET /notifications/deliveries` no devuelve cuerpo salvo `notifications.manage`.
- **Simulado**: sin proveedor, fuera de producción, la entrega queda `status sent` + `errorMessage "SIMULADO…"`. El
  recorrido de recepción lee ese prefijo (`guest-journey.service.ts:43,154`) y pinta el badge «Simulado» junto al
  destinatario enmascarado (`h***@…`); el recepcionista sabe que tiene que hacer llegar el enlace por otro medio (con
  invitación simulada el API devuelve `checkInUrl` / `surveyUrl` en claro). En producción sin proveedor la entrega queda
  `failed`, el paso de la encuesta la cuenta como fallo y **no reintenta** (la fila `failed` bloquea `already_invited`):
  configurar el proveedor y borrar o ignorar esas filas es decisión de César (§10).
- El recorrido lista las entregas de la reserva por prefijo (`journeyNotificationIds`, :133-141) y nunca su cuerpo ni PII.

## 5 · Encuesta post-estancia y NPS

1. **Política por hotel** (`property_checkin_policies`, migración `20260920190000_portal_huesped_l7`):
   `post_stay_survey_enabled` (defecto `false`; `true` en `prop_chk`) y `post_stay_survey_delay_hours` (0-72, defecto 24 =
   horas desde las 00:00 local del día de salida). Se editan en «Portal del huésped» o con
   `PUT /properties/:id/check-in/policy { postStaySurveyEnabled, postStaySurveyDelayHours }`.
2. **Paso del tick** (`runPostStaySurveyStep`, `post-stay-survey.service.ts:337`): propiedades con la encuesta activa →
   reservas `checked_out` con salida en `[hoy − 3 días, día local de (ahora − delay)]` (`surveyWindowFor`, :113) → titular
   con correo y consentimiento (`surveyConsentOf`, :139: `gdprAt` del pre-check-in, o `marketing !== false` del huésped;
   `refused` → `consent_refused`) → sesión de portal de 30 días → correo `post_stay_survey` con
   `${GUEST_WEB_BASE_URL}/?survey=1&token=…&property=<id>`. Idempotente por `notificationId` (`skipped
   already_invited`); resumen `summary.postStaySurvey = { invited, skipped, failed }`; auditoría `PostStaySurveyInvited`.
   Sin líder (`RUN_SCHEDULERS=false`) no hay envíos automáticos.
3. **Ruta manual** `POST /reservations/:id/post-stay/survey-invite` (recepción, `pms.reservation.modify`): mismo paso con la
   reserva forzada (ignora política y ventana; exige `checked_out` → 409 `RESERVATION_NOT_CHECKED_OUT`). Devuelve
   `{ status: invited | skipped | failed, reason, dispatched, simulated, channel, recipient enmascarado, deliveryId,
   surveyUrl? }`; `surveyUrl` SOLO con envío simulado. Botón «Enviar encuesta ahora» del recorrido.
4. **Portal** (`SurveyPage`, `?survey=1`): `GET /guest-portal/survey` → cuestionario (la `Survey` `post_stay` activa del
   hotel —`chk_survey_post_stay` en el seed— o el cuestionario por defecto NPS + comentario), `answered`, `available`
   (solo en `post_stay` y sin respuesta). NPS 0-10 como `radiogroup` de botones ≥ 44 px (`SurveyPage.tsx:73-88`),
   comentario ≤ 2000, preguntas `scale` 1-5 validadas en cliente; `POST /guest-portal/survey { score, answers }` → 201
   `{ responseId, surveyId, score, answeredAt }`; segunda respuesta → 409 `SURVEY_ALREADY_ANSWERED` y la página muestra
   «Ya has respondido»; fuera de `post_stay` → 409 `SURVEY_NOT_AVAILABLE`; enlace caducado → pantalla de acceso con aviso.
5. **NPS**: `SurveyResponse.score` (columna) + `responsesJson { …answers, score, source: "guest_portal" }`; el panel
   `/dashboards/surveys` aplica la regla NPS (promotores ≥ 9, detractores ≤ 6) sobre `score`; el recorrido muestra
   «respondida · n/10». Auditoría `SurveyResponseReceived` con las claves respondidas, nunca el texto libre.
6. Qué NO hace: no crea un `QualityCase survey_detractor` con puntuación ≤ 6 (REPUTACION-REVIEWS §6.4, pendiente sin
   dueño); no valida en servidor el rango de `scale`/`nps` de cuestionarios personalizados (solo `score` 0-10); no envía
   por WhatsApp ni SMS.

## 6 · Kiosco

Base en `checkin-automatizado.md` §9 (emparejamiento con código de 8 dígitos, `x-kiosk-token`, adaptadores `none` /
`sandbox`). Lo que añade la tanda (`apps/guest-web/src/kiosk/*`, lote L7-05):

- Aviso de inactividad como `role="alert"` a los 75 s (`IDLE_TIMEOUT_MS` 90 s − `IDLE_WARNING_MS` 15 s,
  `kiosk-mode.ts:14-18`) con un botón grande «Continuar» que prolonga; a los 90 s reinicio, borrado de la sesión del
  huésped (memoria + `sessionStorage`) y credencial del dispositivo intacta. Selector de idioma es/en propio del kiosco.
- Código de emparejamiento y códigos OTP con `inputMode="numeric"` + `autocomplete="one-time-code"`; foco visible 2 px;
  todos los objetivos del kiosco ≥ 56 px (`.gp-button-big` / `.gp-button-huge`).
- «Firmar en recepción» en el paso de firma (`SignaturePad.tsx:43-44` `deferSignatureLabel`): en el kiosco el asistente
  llama a `POST /guest-portal/check-in/handoff { kind: "signature" }` (corrector L7-REV-05): la sesión pasa a `handed_off`
  con `handoffKind signature_pending`, `handoffReason «Firma en recepción · ticket K-nnnn»`, `kioskDeviceId` y auditoría
  `CheckInHandedOff`; la pantalla de llegada pinta SOLO el ticket que devuelve el API (determinista por sesión,
  `handoffTicketFor`) y recepción lo ve en la cola de Mi día (`signature_pending`, prioridad hoy) y en la ficha; lo cierra
  con `resolve-handoff` desde el cajón. Sin ticket del servidor (otros 409 de la llegada) la tablet dice «Acércate al
  mostrador» sin número. En el móvil la firma diferida sigue siendo un aviso local (el parte lo cierra recepción).
- `requestFullscreen()` con ventana máxima de espera (`KioskShell.tsx:53-59`): en tablets que no resuelven la promesa el
  kiosco sigue; en Chromium headless deja de emular `pointer: coarse` tras la pantalla completa (solo afecta a la medida
  e2e, no a la app).

## 7 · Accesibilidad (WCAG 2.2 AA, móvil primero)

Contratos que lo fijan: `tests/guest-portal-ui-contract.test.mjs` (32: páginas, `sessionStorage`, retención RD 933/2021,
funciones de `client.ts`, espejo de tipos wire, 0 `style=` inline) y `tests/guest-portal-a11y-contract.test.mjs` (11:
etiquetas explícitas, regiones vivas, foco al título del paso, firma con alternativa, aviso del kiosco como alerta, cámara
por teclado, sin literales ingleses, solo claves de copy existentes). Medidas en runtime: contrato `assertTargets` de las
specs e2e (0 objetivos < 24 px en 32 pantallas medidas; los < 44 px se listan en `targets-<pantalla>.json`).

| Criterio | Cómo se cumple (`apps/guest-web/src`) |
|---|---|
| 1.3.1 Información y relaciones · 4.1.2 | `<label for>` / `aria-labelledby` en todos los campos; `role="group"` «Paso n de 6» y `role="progressbar"` con `aria-valuenow` en el asistente (`CheckInWizardPage.tsx:201-206`); NPS como `radiogroup` (`SurveyPage.tsx:74`); `<main id="gp-main">` |
| 1.4.3 Contraste | Texto secundario `--gp-muted #726250` sobre `#fdfbf7` ≈ 5,7:1 (antes `#9a8a78` ≈ 3,2:1); modo oscuro por `prefers-color-scheme` (`styles.css:37`) |
| 1.4.4 · 1.4.10 | Unidades relativas, una columna en 390 px, sin desplazamiento horizontal (specs a 390-393 px de ancho) |
| 2.1.1 Teclado | Cámara operable por teclado (`input[type=file]` alcanzable), «Firmar en recepción» como botón, chips NPS y selector de idioma como botones; Tab/Espacio en consentimientos |
| 2.2.1 Tiempo ajustable | Aviso del kiosco 15 s antes con «Continuar» (`role="alert"`, `KioskShell.tsx:221`) |
| 2.3.3 Animaciones | `prefers-reduced-motion` (`styles.css:657`) |
| 2.4.1 Saltar bloques | Enlace «Ir al contenido» (`.gp-skip`, `Layout.tsx:43`) |
| 2.4.3 · 2.4.7 Foco | Foco al título del paso al cambiar; contorno visible 2 px; `aria-current="step"` |
| 2.5.7 Movimientos de arrastre | **Excepción declarada**: la firma manuscrita es esencial (el trazo es la evidencia del parte de viajeros, `strokeMeta`), así que el trazo no tiene equivalente por teclado; la alternativa es «Firmar en recepción» (D6) y en el mostrador firma con el pad del cajón. El resto del portal no arrastra nada |
| 2.5.8 Tamaño del objetivo | `.gp-button`, `.gp-chip`, `.gp-link`, selector de idioma y cabecera con `min-height: 44px` (`styles.css:110,145,175,709,1028,1363`); e2e: 0 < 24 px en 32 pantallas; < 44 px solo las 3 casillas `.gp-check` de «Datos» (26 px, ≥ 24 OK) y los `<input type=date>` (39 px) |
| 3.1.1 · 3.1.2 Idioma | `<html lang>` sincronizado con el selector (`App.tsx:221`; `index.html` `lang="es"`); es por defecto, en si el navegador lo pide (D9); 384 claves en `wizard.ts` `COPY_ES` / `COPY_EN` |
| 3.3.1 · 3.3.2 · 3.3.3 Errores | `aria-invalid` + `aria-describedby` (código de emparejamiento, campos del asistente); mensajes en el idioma del huésped; campos con ejemplo |
| 3.3.7 Entrada redundante | La MRZ rellena los datos del viajero; el titular y el correo vienen de la reserva |
| 4.1.3 Mensajes de estado | `aria-live="polite"` / `role="status"` en cada página (33 regiones en 11 ficheros), `role="alert"` en errores |

Lo que queda por debajo del objetivo (no del mínimo): casillas de consentimiento 26 px y fechas 39 px en «Datos»
(`styles.css .gp-check input` 20×20); un `min-height: 44px` en `.gp-field input` y `.gp-check input` 24×24 lo cerraría.

## 8 · Pruebas y comandos exactos

Desde `<worktree>/hotelos/`:

```
corepack pnpm --filter @hotelos/guest-web build                   # puerta real del portal (typecheck SKIP por @types/react, D7)
corepack pnpm --filter @hotelos/guest-web test                    # wizard.test.mts (38) + stay.test.mts (34), node --test con el tsx del api
node --test tests/guest-portal-ui-contract.test.mjs tests/guest-portal-a11y-contract.test.mjs tests/seed-checkin-contract.test.mjs
corepack pnpm --filter @hotelos/api test                          # incluye modules/guest-portal/__tests__/{guest-stay (28), post-stay-survey (18), guest-journey (13)},
                                                                  #   checkin/__tests__/checkin-jobs (paso 5), notifications/__tests__/checkin-templates (post_stay_survey)
corepack pnpm --filter @hotelos/admin-web test                    # screens/guestJourney/__tests__/journey (15), screens/guest-portal/__tests__/guest-portal-settings (11)
(cd apps/api && node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 ../../tests/integration/{guest-stay,guest-survey,guest-journey,guest-portal}.test.mts)
                                                                  #   tenants aislados org_l2_* + invariantes de la BD real; 14 + 13 + 5 casos (+ kiosk-pairing 8: handoff)
corepack pnpm --filter @hotelos/database db:migrate:status        # 26/26 en el carril (+ 20260920190000_portal_huesped_l7, 20260920210000_guest_portal_session_purpose)
corepack pnpm --filter @hotelos/database db:drift:check           # «No difference detected.»
```

e2e (proyecto Playwright `guest`, `apps/admin-web/e2e/guest-portal/README.md` con la tabla de specs y la limpieza):

```
corepack pnpm --filter @hotelos/database db:seed:checkin -- --reset     # tenant CHK con el API parado
(cd apps/api && PORT=3937 RUN_SCHEDULERS=false TENANT_BOOTSTRAP_SKIP=true RATE_LIMIT_MAX=5000 \
  GUEST_WEB_BASE_URL=http://127.0.0.1:5237 node --env-file-if-exists=../../.env --import tsx src/server.ts &)
(VITE_GUEST_API_BASE=http://127.0.0.1:3937 VITE_GUEST_PROPERTY_ID=prop_chk \
  corepack pnpm --filter @hotelos/guest-web dev --host 127.0.0.1 --port 5237 --strictPort &)
(VITE_API_URL=http://127.0.0.1:3937 corepack pnpm --filter @hotelos/admin-web dev --host 127.0.0.1 --port 5207 --strictPort &)   # solo journey.spec
E2E_API_URL=http://127.0.0.1:3937 E2E_GUEST_BASE_URL=http://127.0.0.1:5237 E2E_ADMIN_BASE_URL=http://127.0.0.1:5207 \
  corepack pnpm --filter @hotelos/admin-web e2e --project=guest          # 5 specs; una sola: … e2e --project=guest kiosk
```

Sin `--` antes de las opciones (pnpm las pasaría literales y Playwright ignoraría `--project`, ejecutando los cuatro
proyectos; la cabecera de `playwright.config.ts` ya lo dice así); con `--project guest kiosk` Playwright leería `kiosk`
como otro proyecto. Sin `E2E_API_URL` los helpers del proyecto `guest` apuntan por defecto a :3937 (nunca al :3000 de la
BD principal). Playwright 1.63 exige `chromium_headless_shell-1243` (`PLAYWRIGHT_BROWSERS_PATH` si está fuera de la
caché). Cifras de referencia (2026-09-20, Mac, sin PSP ni correo): 5/5 en 41,2 s, 140 peticiones al API; cada corrida
deja una reserva `RES-*` por spec en `prop_chk` (`--reset` no las borra: §10).

## 9 · Recorrido del huésped en recepción

`/recepcion/reservas/:id/recorrido` (`GuestJourneyWorkspace.tsx`, pestaña del detalle de la reserva; cálculo puro en
`screens/guestJourney/journey.ts`). Trece pasos en el orden real: reserva · invitación al check-in en línea · pre-check-in
(viajeros completos n/m, firmados n/m) · identidad y parte (SES) · pago · habitación · check-in · llave (serie, validez, «QR
de demo (sin certificado de Apple)») · bienvenida · estancia · peticiones del huésped · check-out y factura · encuesta
post-estancia. Los siete de siempre salen de reserva + folio + huésped; los seis nuevos de
`GET /reservations/:id/guest-journey` (`GuestJourneyView { checkIn, notifications[], key, requests[], survey,
portalSessions }`, sin PII; `guest-journey.service.ts:96-108`). Sin recorrido del API los pasos quedan «pendientes» marcados
`unknown` y nunca se proponen como siguiente acción. Acciones: «Invitar al check-in en línea» / «Reenviar invitación» y
«Enviar encuesta ahora», con el resultado honesto (simulado, destinatario enmascarado, «ya invitada»). Fuera de la lista de
`docs/api-contracts.md` por ahora: la forma de `GuestJourneyView` solo está documentada aquí y en el servicio (§10).

## 10 · Límites honestos y lo que solo César puede aportar

Qué NO hace el portal hoy:

- Sin PSP no hay cobro desde el portal: «Se cobra en recepción» (`at_reception`), nunca «pagado»; un folio sin líneas es
  `no_charges` / «sin cargos todavía» también en el contrato del API (corrector L7-REV-03). El cargo de alojamiento lo
  asienta el cierre del día, así que una reserva recién creada por API muestra saldo 0.
- La salida no la ejecuta el huésped: pide salida exprés / tardía / factura por correo / consigna y recepción cierra (D2).
- `GET /guest-portal/check-in` crea una sesión `invited` al vuelo incluso en reservas alojadas o salidas (el portal ya no
  la llama desde la estancia).
- `DELETE …/check-in/guests/:id` (quitar acompañante) corregido en el cliente (sin `Content-Type` sin cuerpo) pero sin
  ejercicio en e2e; el toggle de idioma del asistente duplica el de cabecera; `client.ts` `signIn` lanza `Error` con texto
  inglés para `ok:false` (la pantalla lo traduce por tipo).
- La app móvil no forma parte del portal: demo interna (`apps/mobile/README.md`).
- Datos de prueba: `db:seed:checkin -- --reset` borra `CHK-%` y, desde el corrector L7-REV-10, las `RES-*` de las
  corridas e2e del portal (titular `prueba.portal.*`, solo `prop_chk`, solo sin factura); las specs `precheckin` y `survey`
  dejan además limpia la habitación usada (`releaseReservationRoom` en `finally`).
- Typecheck del portal en SKIP (`scripts/typecheck-all.mjs`): build + tests + contratos + e2e son la puerta (D7).

Decisiones que solo César puede tomar (recon L7 §18; defecto aplicado en el árbol):

| # | Decisión | Defecto aplicado |
|---|---|---|
| D1 | Encuesta post-estancia: a quién, cuándo, remitente | `postStaySurveyEnabled=false` por hotel (`true` en `prop_chk`), 24 h tras la salida, solo titulares con correo y consentimiento; simulada sin `EMAIL_PROVIDER` |
| D2 | Salida por el portal | Petición a recepción (exprés / tardía / factura por correo / consigna); recepción cierra |
| D3 | PSP (Stripe test / Redsys) para pagar desde el portal | Enlace solo con PSP; sin él «se cobra en recepción», nunca «pagado»; los cargos de cancelación no se cobran desde el portal (la reserva cancelada no tiene CTA de pago) |
| D4 | Dominio, correo y WhatsApp (`GUEST_WEB_BASE_URL`, `EMAIL_*`, `WHATSAPP_*`) | Simulado; base local por variable |
| D5 | App móvil | Congelada como demo interna y documentada; sin código |
| D6 | Firma sin alternativa de arrastre (2.5.7) | «Firmar en recepción» como alternativa; el trazo sigue siendo táctil |
| D7 | `@types/react` en guest-web (regenerar el lockfile) | SKIP explícito; build + tests + e2e como puerta |
| D8 | Rutas legadas `/guest-portal/session/:token*` | `GET …/:token` verifica (401); `/folio` y `/pay` se conservan |
| D9 | Idiomas | es (defecto) + en; fr/de fuera |
| D10 | Hardware de kiosco, cerraduras, certificados de wallet | QR de demo + «recoge tu tarjeta en recepción» |

Además: proveedor de correo con dominio verificado (N2), WhatsApp Business con plantillas *utility* (N3), PSP (N4), hardware
(N6) y el texto legal de consentimiento y aviso de IA por hotel (N8) siguen en `checkin-automatizado.md` §13.
