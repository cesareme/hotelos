# Runbook · Check-in automatizado y recepcionista IA (Tanda CHK · módulo `guest_self_service`)

Fuente: diseño [`docs/design/CHECKIN-AUTOMATIZADO-IA.md`](../design/CHECKIN-AUTOMATIZADO-IA.md) (§4 flujo, §4b motor,
§5 recepcionista IA, §6 modelo, §7 API y privacidad, §8 front, §10 demo y necesidades, §11 decisiones; el apéndice
final recoge los deltas de la implementación). Código: `apps/api/src/modules/checkin/*` (sesión `checkin-session.service.ts`,
captura `identity-capture.service.ts`, firma `signature.service.ts` + `signature-storage.ts` + `entry-form-pdf.ts`,
llegada `arrival.service.ts`, OTP `otp.service.ts`, kiosco `kiosk.service.ts`, política `checkin-policy.service.ts`,
bot `guest-bot.service.ts`, jobs `checkin-jobs.ts`, contexto `service-context.ts`, entorno `checkin-config.ts` +
`env.partial.ts`, adaptadores `adapters/*`, rutas `checkin.routes.ts` + `route-permissions.partial.ts`, esquemas
`checkin.schemas.ts`); motor y servicio de asignación `apps/api/src/modules/pms/room-assignment.{engine,service,routes}.ts`
+ `room-assignment-route-permissions.partial.ts`; webhook `apps/api/src/routes/webhooks-whatsapp.routes.ts`; parser MRZ
`packages/compliance/src/spain/mrz.ts`; tipos wire `packages/shared/src/checkin-types.ts`; migración
`packages/database/prisma/migrations/20260920150000_checkin_automatizado/`; seed `packages/database/prisma/seed-checkin.ts`;
front de recepción `apps/admin-web/src/screens/operations/{FrontDeskDashboard,FrontDeskActionQueue,QuickCheckInDrawer,ArrivalPreCheckInDrawer,CheckInAutomationSettingsScreen}.tsx`
+ `services/checkinApi.ts` + `components/cocoa-extras/SignaturePad.tsx`; portal y kiosco `apps/guest-web/src/{pages/CheckInWizardPage,pages/ArrivalPage,components/DocumentCamera,components/SignaturePad}.tsx`
+ `checkin/wizard.ts` + `kiosk/*`. Rutas, cuerpos, permisos y códigos: `docs/api-contracts.md` «Check-in automatizado (Tanda CHK · 2026-09-19)».

**Todos los datos de este documento son ficticios**: tenant de prueba `org_chk` / `prop_chk` («Hotel CHK (prueba)»),
reservas `CHK-01…CHK-10`, usuarios `*@chk.test`, MRZ sintéticas. Nunca se pega aquí un documento ni el nombre de una
persona real; sobre los datos de Faranda el módulo solo se lee.

Estado 2026-09-19/20: construido en el worktree del carril CHK (rama `tanda-chk`, base `f77820d`, BD `hotelos_chk`,
API `:3919` · Vite `:5189`) en cuatro olas (W1 modelo/MRZ/motor/seed · W2 sesión/captura/firma/asignación/plantillas ·
W3 llegada/rutas/jobs/cola · W4 front, portal, kiosco y bot). Los jobs del líder están cableados en `server.ts`
(W4-D). Pendiente de fusión a `main` por el orquestador (§12 y §13).

## 1 · Configuración (`.env`) y qué pasa sin cada variable

Lectura única en `checkin-config.ts` (`readCheckInConfig`); ningún otro fichero del módulo lee `process.env`. Contrato en
`env.partial.ts` (spread en `lib/env.ts`); `node scripts/env-census.mjs --write` regenera `scripts/env-contract.json`,
`.env.example` y `deploy/.env.production.example`. Un valor ilegible cae al defecto (`validateEnv` lo avisa al arrancar).

| Variable | Defecto | Efecto · qué pasa sin ella |
|---|---|---|
| `GUEST_WEB_BASE_URL` | `http://localhost:5174` | Origen del portal: la invitación enlaza `<base>/checkin?token=<opaco>` y el bot `<base>/?property=<id>`. Sin ella los enlaces apuntan a localhost (solo válido en local). |
| `CHECKIN_INVITATION_DISABLED` | `false` | `true` apaga el tick de jobs (§8) en el líder. Sin variable, el tick corre con `RUN_SCHEDULERS=true`. |
| `CHECKIN_INVITATION_INTERVAL_MS` | `3600000` (1 h; 1 min–24 h) | Cadencia del tick (invitación, recordatorio, lote de asignación, purga). |
| `CHECKIN_ASSIGNMENT_RUN_AT` | `18:00` (HH:MM, Europe/Madrid) | Hora local a partir de la cual la vuelta del tick ejecuta el lote de sugerencias para las llegadas de mañana. |
| `CHECKIN_OTP_TTL_MS` | `600000` (10 min) | Vida del OTP de identidad. |
| `CHECKIN_OTP_MAX_ATTEMPTS` | `5` (1–20) | Intentos de `otp/verify` antes de `429 OTP_RATE_LIMITED`. |
| `KIOSK_PAIRING_TTL_MS` | `600000` (10 min) | Vida del código de 8 dígitos de emparejamiento (solo se guarda su hash). |
| `CHECKIN_CAPTURE_PURGE_DAYS` | `30` (1–365) | Días tras los que la purga vacía `fields_json` / `confidence_json` de `document_captures`. |
| `CHECKIN_DOCUMENT_MAX_BYTES` | `6291456` (6 MiB) | Tamaño decodificado máximo de la imagen del documento (la ruta lleva `bodyLimit` 8 MB). |
| `CHECKIN_SIGNATURE_MAX_BYTES` | `524288` (512 KiB) | Tamaño decodificado máximo del PNG/SVG de la firma (`413 SIGNATURE_TOO_LARGE`). |
| `WHATSAPP_APP_SECRET` | — | Firma `X-Hub-Signature-256` del webhook de entrada. Sin él `POST /webhooks/whatsapp` responde `503 WHATSAPP_WEBHOOK_NOT_CONFIGURED` en cualquier entorno (corrector SEC-5; mismo criterio que el webhook de pagos). |
| `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED` | `false` | Solo demo/staging (etiqueta *dangerous*): con `1`/`true`, sin secreto y `NODE_ENV≠production`, el webhook procesa cuerpos SIN firma como SIMULADO (`simulated: true`). En producción no tiene efecto. |
| `WHATSAPP_VERIFY_TOKEN` | — | Verificación de la suscripción en Meta (`GET /webhooks/whatsapp` con `hub.verify_token`). Sin él `503`; distinto `403 WHATSAPP_VERIFY_TOKEN_INVALID`. |
| `WHATSAPP_PHONE_ID` + `WHATSAPP_PROVIDER_TOKEN` | — | Salida por WhatsApp (invitación, recordatorio, bienvenida, respuestas del bot). Sin ellos las entregas quedan `simulated` en `notification_deliveries` y `metadata.delivery`. Las respuestas del bot fuera de la ventana de 24 h exigen plantillas *utility* aprobadas (R11): hoy el proveedor envía texto libre. |
| `AI_PROVIDER` · `AI_PROVIDER_API_KEY` · `AI_MODEL` | `none` | Con `anthropic` + clave: visión sobre la imagen del documento (`extractGuestIdentityFieldsTemporary`, persistida como `identity_capture`), clasificación de intención del bot (`llmClassify`) y respuesta `answerGuestQuestion`. Sin clave: MRZ por reglas (lector o texto pegado), formulario manual etiquetado, bot en `mode: "rules"`; la captura por imagen responde `source: manual` con 0 campos y la ruta del portal lo convierte en `400 DOCUMENT_UNREADABLE`. |
| `EMAIL_PROVIDER` (+ `EMAIL_PROVIDER_KEY`, `EMAIL_FROM`) | — | Invitación, recordatorio, bienvenida y OTP por correo. Sin proveedor el dispatcher marca la entrega `simulated` y, fuera de producción, `InvitationResult.token` / `checkInUrl` devuelven el enlace en claro para probarlo (`GUEST_PORTAL_RETURN_TOKEN=true` fuerza lo mismo). |
| `HOTELOS_FIELD_KEY` → `ENCRYPTION_KEY` | — | Cifrado AES-256-GCM de la PII de `checkin_guests` (§5). En producción sin clave el API aborta; en desarrollo avisa y guarda en claro. |
| `RUN_SCHEDULERS` | `true` | Solo la instancia líder (lease `scheduler_leases`) ejecuta el tick. Los carriles arrancan con `RUN_SCHEDULERS=false`. |
| `HOTELOS_ALLOW_DEMO_AUTH` | — | Fuera de producción y con `true`, `POST …/otp/request` devuelve `debugCode` (demo sin proveedor). |
| `RBAC_STRICT` | — | Con `true` (carriles) todo `GET` sin entrada en el manifiesto responde 403: las 30 + 10 + 2 rutas del módulo están en los partials. |

Portal (`apps/guest-web`): `VITE_GUEST_PROPERTY_ID` o `?property=<id>` fijan la propiedad del sign-in; `VITE_GUEST_API_BASE`
apunta al API. En producción el portal es *same-origin* tras Caddy; en desarrollo (`:5189 → :3919`) el CORS del API aún
no admite las cabeceras `x-guest-token` / `x-kiosk-token` (§13), así que el portal usa el respaldo `?token=`.

## 2 · Modelo y estados

Migración única `20260920150000_checkin_automatizado`: 9 `CREATE TABLE`, 14 índices + 3 únicos, 1 FK
(`checkin_guests.session_id → checkin_sessions ON DELETE CASCADE`), 0 `CREATE TYPE` (estados como `String` con `///`),
0 columnas nuevas en tablas existentes, sin backfill; reversible con `DROP TABLE` de las 9 (primero `checkin_guests`).

| Tabla (`@@map`) | Modelo | Para qué |
|---|---|---|
| `checkin_sessions` | `CheckInSession` | 1 por reserva (`reservation_id` único): estado del pre-check-in y de la llegada, canal, ETA declarada, preferencias (`string[]`), consentimientos, estado de pago, `handoff_kind`/`handoff_reason`, kiosco. |
| `checkin_guests` | `CheckInGuest` | 1 por viajero (titular + acompañantes; huecos hasta `adults + children`): datos del Anexo I, menor/adulto que lo declara, método y fecha de verificación, PII cifrada (`document_number`, `document_support_number`, `email`, `phone_mobile`, `residence_full_address`) con hash de búsqueda. |
| `document_captures` | `DocumentCapture` | Resultado de cada lectura: `source`, `mrz_format`, `checks_json`, `fields_json` (SOLO no PII), `confidence_json`, `needs_review_json`, telemetría (`model`, tokens, `cost_eur`, `processing_ms`), `image_stored=false`, `image_discarded_at`, `purge_at`. Nunca la imagen. |
| `signatures` | `Signature` | Firma con evidencias: `object_key`, `sha256`, `pdf_object_key`/`pdf_sha256`, `signed_at`, `ip`, `user_agent`, `session_id`, `stroke_meta_json`, `method`, `retention_until`. |
| `assignment_suggestions` | `AssignmentSuggestion` | Top-3 con motivos (`candidates_json`), `rejected_count`, `chosen_room_id`, `confidence`, `rules_version`, `source`, `automation_level`, `status`, `decided_by/at`, `ai_tool_call_id`. |
| `kiosk_devices` | `KioskDevice` | Tablet/kiosco: hash del código de emparejamiento y del token, `status`, `capabilities_json`, `lock_provider`, `config_json`, `last_seen_at`. |
| `property_checkin_policies` | `PropertyCheckInPolicy` | Política por propiedad (§3 y §4): self check-in, días de invitación/recordatorio, métodos de verificación admitidos, cotejo visual en kiosco, habitación inspeccionada, depósito, walk-in, mejora, nivel de asignación, pesos, orden de canales de bienvenida, textos RGPD/IA. |
| `room_blocks` | `RoomBlock` | Bloqueo con fechas y motivo (`maintenance` · `deep_clean` · `owner` · `event` · `other`), opcionalmente ligado a una orden de trabajo. |
| `room_connections` | `RoomConnection` | Par ordenado (`room_a_id`, `room_b_id`) `connecting` · `adjacent`. |

**Máquina de estados de la sesión** (`CHECKIN_SESSION_STATUSES`, `packages/shared`):

```
invited ──(primera escritura del huésped)──▶ in_progress ──(complete)──▶ ready_for_arrival ──(arrive)──▶ checked_in
   │                                                                          │
   │ (purga: reserva ya salida) ▶ expired                                     └─(habitación no lista)─▶ arrived [handoffKind room_not_ready]
   │                                                                                                          └─(reintento de arrive)─▶ checked_in
   └─ handed_off / cancelled: valores reservados (§13: ningún paso automático los escribe todavía)
```

- `invited`: la crea `inviteReservation` (personal o job) con el `GuestPortalSession` y su token opaco (hash `sha256`,
  TTL = salida + 1 día). Cada reinvitación o recordatorio revoca el token anterior y emite otro.
- `in_progress`: cualquier `PATCH /guest-portal/check-in`, alta/edición de viajero, MRZ, captura o firma.
- `ready_for_arrival`: `POST …/complete` cuando todos los viajeros tienen los datos del parte (validador sin exigir la
  firma; menores < 14 sin firma) → crea/actualiza el parte por viajero y emite `CheckInPreArrivalCompleted`.
- `arrived`: `POST …/arrive` (o `/reservations/:id/check-in/complete`) con la habitación no lista y sin alternativa:
  `handoffKind = room_not_ready`, `409 ROOM_NOT_READY { etaReady }`; la sesión admite reintentos.
- `checked_in`: `completeCheckIn` terminado (habitación, llave, SES, bienvenida).
- Cierre al portal (`CLOSED_SESSION_STATUSES`): `arrived` · `checked_in` · `handed_off` · `expired` · `cancelled` → las
  escrituras del huésped responden 409 «La sesión de check-in ya no admite cambios desde el portal».
- `expired`: la purga del tick (§8) sobre sesiones `invited` cuya reserva ya salió (auditoría `CheckInSessionExpired`).

**Máquina del viajero** (`CHECKIN_GUEST_STATUSES`): `pending` (hueco sin datos) → `document_captured` (MRZ válida o
captura vinculada) → `data_complete` (validador del parte en verde) → `signed` (`signGuest`) → `verified`
(`verify-identity` de recepción, OTP acertado o `arrive` con método admitido). Una edición posterior de un viajero
`signed|verified` no retrocede su estado (§13). `status` de la sugerencia: `suggested` → `confirmed` (primera candidata) |
`changed` (otra habitación) | `expired` (nueva ejecución del motor o del lote); `auto_assigned` reservado (§13).
Pago (`paymentStatus`): `none` · `link_sent` · `paid` · `authorized` (reservado) · `failed` · `at_reception`.

## 3 · Flujo por etapas, rutas y permisos

Rutas de huésped: `permissions: []`, `riskLevel: "public"`; el token opaco del portal ES la autenticación (cabecera
`x-guest-token` o `?token=`); prefijos `/guest-portal/check-in` y `/guest-portal/chat` en `PUBLIC_PREFIXES`
(`lib/auth-context.ts`). Todas exigen el módulo `guest_self_service` activado en la propiedad de la sesión (403 «El módulo
guest_self_service no está activado en esta propiedad.»). Las escrituras de dominio van con el contexto de servicio
(`service-context.ts`: `guest:<sessionId>` · `kiosk:<deviceId>` · `system:checkin:<job>`, permisos fijos sin claves de
dinero ni de override; auditoría `actorType: "system"`).

| Etapa | Ruta de huésped (token) | Efecto · errores |
|---|---|---|
| Acceso | `GET /guest-portal/check-in` | `CheckInSessionDto` + `policy` + `steps[]` (`travellers · identity · details · preferences · signature · payment · complete`). `401 GUEST_SESSION_INVALID`. |
| Preferencias y llegada | `PATCH /guest-portal/check-in` `{ eta?, preferences?: { codes[], freeText? }, consent?: { gdpr, aiDisclosure, marketing, whatsappOptIn } }` | ETA → `Reservation.eta`; códigos del vocabulario cerrado a la sesión y al titular (`Guest.preferencesJson` `string[]`); texto libre → `specialRequests` si no existe; consentimientos fechados. |
| Viajeros | `POST /guest-portal/check-in/guests` (201) · `PATCH …/guests/:id` · `DELETE …/guests/:id` | Rellena primero el hueco `pending`; `409 CHECKIN_GUEST_LIMIT` al superar `adults + children`; un menor exige `providedByCheckInGuestId` adulto de la sesión; no se borra un viajero con parte (409). |
| Identidad (lector/manual) | `POST …/guests/:id/mrz` `{ lines }` | `parseMrz` determinista → `MrzApplyResult { guest, missing[], capture }`; `400 MRZ_CHECKSUM_FAILED`. Marca `mrz_checksum` SIN `identityVerifiedAt`. |
| Identidad (cámara) | `POST …/guests/:id/document` `{ imageDataUrl?, mrzLines?, documentType? }` (bodyLimit 8 MB) | `{ capture: DocumentCaptureResult, guest, session }`; `400 DOCUMENT_UNREADABLE { captureId, needsReview, warnings }` si ni MRZ ni visión. La imagen no se guarda. |
| Firma | `POST …/guests/:id/signature` `{ pngBase64, svg?, strokeMeta: { points, durationMs, bbox } }` (201) | `SignGuestResult { signatureId, sha256, pdfSha256, signedAt, retentionUntil, method }`; `409 SIGNATURE_NOT_REQUIRED` (< 14), `409 GUEST_REGISTER_INCOMPLETE`, `413 SIGNATURE_TOO_LARGE`. `touch_kiosk` si llega `x-kiosk-token` de un kiosco de la misma propiedad. |
| Pago | `POST …/payment-link` `{ returnUrl?, clientRequestId? }` | `{ status: no_folio \| settled \| link_sent (202/200) \| at_reception, paymentStatus, link? }`; `PSP_NOT_CONFIGURED` → `at_reception` sin fingir. |
| Cierre | `POST …/complete` | `ready_for_arrival` + partes; `409 CHECKIN_INCOMPLETE { missing[] }`. |
| OTP | `POST …/otp/request` `{ channel: email \| phone }` · `POST …/otp/verify` `{ code }` | `409 OTP_METHOD_NOT_ALLOWED`, `429 OTP_RATE_LIMITED` (reenvío < 60 s o intentos agotados), `409 OTP_INVALID`. |
| Llegada | `POST …/arrive` `{ verification?: { method? } }` | `CompleteCheckInResult { room, reassigned, key, ses, welcome, checkedInAt, warnings[] }`; `409 IDENTITY_NOT_VERIFIED { reason }`, `GUEST_REGISTER_INCOMPLETE`, `CHECK_IN_DATE_OUT_OF_RANGE`, `BALANCE_DUE`, `ROOM_NOT_READY { etaReady, handoffKind }`, `CHECKIN_ALREADY_DONE`. |
| Kiosco | `POST /guest-portal/check-in/kiosk/claim` `{ code }` (10/min por IP) | `{ deviceToken, device, capabilities }` una sola vez; `409 KIOSK_PAIRING_INVALID`. |
| Bot | `POST /guest-portal/chat` `{ text, conversationId?, language? }` (30/min por IP) | `GuestBotResult` (§10). |

Rutas de personal (manifiesto `modules/checkin/route-permissions.partial.ts` + `modules/pms/room-assignment-route-permissions.partial.ts`;
claves existentes, sin `rbac:sync`; `:propertyId` con 404 opaco y las rutas por `:id` cruzan la tenencia con `assertEntityAccess`):

| Ruta | Permiso · riesgo | Efecto |
|---|---|---|
| `GET /properties/:propertyId/check-in/arrivals?date=` | `pms.reservation.read` · low | `{ date, items: ArrivalDto[] }` con `preCheckIn`, `suggestion` y `key` (alimenta Mi día y las métricas de §14). |
| `POST /properties/:propertyId/check-in/sessions` `{ reservationId, channel: email \| whatsapp \| sms }` | `pms.reservation.modify` · medium | Invitar: `InvitationResult { session, notification { dispatched, simulated, channel, recipient, reason, deliveryId }, token?, checkInUrl? }`. |
| `GET /properties/:propertyId/check-in/sessions/:id` · `POST …/sessions/:id/resend` `{ channel? }` | `pms.reservation.read` · low · `pms.reservation.modify` · medium | Detalle de la sesión; reenvío (revoca el token anterior). |
| `GET /properties/:propertyId/check-in/policy` · `PUT …/policy` | `guest_self_service.read` · low · `guest_self_service.manage` · medium | Política (`PropertyCheckInPolicyDto`); el `PUT` es un patch parcial `.strict()` auditado `CheckInPolicyUpdated`. |
| `GET/POST /properties/:propertyId/kiosks` · `PATCH …/kiosks/:id` · `POST …/kiosks/:id/pair` | `kiosk.configure` · low/medium | Dispositivos y código de emparejamiento (8 dígitos, TTL). |
| `GET /reservations/:id/check-in` | `pms.reservation.read` · low | Vista de personal: sesión + viajeros + capturas y firmas sin PII (checks, `needsReview`, hashes). |
| `POST /reservations/:id/check-in/scan` `{ imageDataUrl?, mrzLines?, checkInGuestId? }` | `ai.tool.execute` + `guest_register.create` · medium | Misma tubería que el portal con el usuario; sin `checkInGuestId` devuelve `persisted: false` (evento + auditoría). |
| `POST /reservations/:id/check-in/signature` `{ checkInGuestId \| guestRegisterRecordId, pngBase64, … }` | `guest_register.sign` · high | Firma en recepción (`touch_reception`). |
| `POST /reservations/:id/check-in/verify-identity` `{ checkInGuestId, method = visual_reception }` | `guest_register.edit` · medium | Cotejo visual: marca el viajero y su parte (`CHECKIN_IDENTITY_VERIFIED`). |
| `POST /reservations/:id/check-in/complete` `{ roomId?, verification?, allowEarlyCheckIn?, overrideReason? }` | `pms.checkin.execute` · high | `completeCheckIn` actor `user` (recepción nunca bloqueada por saldo; `at_reception` vale siempre). |
| `POST /reservations/:id/assignment-suggestions` `{ sessionId? }` (201) · `GET …` | `pms.reservation.read` · low | Ejecuta el motor y persiste; `GET` → `{ current, history }`. `409 ASSIGNMENT_NO_CANDIDATES`. |
| `POST /assignment-suggestions/:id/confirm` `{ roomId? }` | `pms.reservation.modify` · high | `assignRoom` con la candidata (o la elegida) → `confirmed` / `changed`; `409 ASSIGNMENT_SUGGESTION_DECIDED`. |
| `POST /properties/:propertyId/check-in/assignments/run` `{ date? }` | `pms.reservation.modify` · high | Lote manual (sin `date`: mañana según la fecha de negocio) → `{ suggested, skipped, failed[] }`. |
| `GET/POST /properties/:propertyId/room-blocks` · `DELETE /room-blocks/:id` | read · low / modify · medium | `{ items }`; `409 ROOM_BLOCK_OVERLAP`. |
| `GET/POST /properties/:propertyId/room-connections` · `DELETE /room-connections/:id` | read · low / modify · medium | `{ items }`; `409 ROOM_CONNECTION_EXISTS`. |
| `POST /ai/tool-calls/:id/confirm` `{ decision: approve \| reject, notes? }` | `ai.tool.execute` (+ los de la herramienta; high/critical exige `ai.high_risk.confirm`) · high | Única confirmación de IA del bot/copiloto (§10). |
| `GET/POST /webhooks/whatsapp` | público (firma) | Verificación y entrada de mensajes (§10). |

Quién puede qué (plantillas de `packages/shared/src/permissions.ts`): **recepción** invita, escanea, firma en recepción,
coteja, completa el check-in, ejecuta el motor y confirma sugerencias, lee la política y confirma herramientas *medium*;
**jefatura de recepción** además escribe la política y confirma *high* (`ai.high_risk.confirm`), pero **no** empareja
kioscos (`kiosk.configure` solo en dirección y administración de sistema); **dirección** todo; **auditoría interna** solo
lectura. Front: pestaña `/hoy/check-in-automatizado` (`CheckInAutomationSettingsScreen`, roles `recepcion · direccion ·
admin · auditoria`); guardar la política exige `guest_self_service.manage` y la tabla de kioscos `kiosk.configure`.

## 4 · Asignación explicable

Motor puro `room-assignment.engine.ts` (`suggestRooms`, sin Prisma, determinista, `rulesVersion = "chk-rules-1"`) +
lector `room-assignment.service.ts` (una instantánea de la propiedad con consultas agregadas, nunca una por habitación).

Fase A · filtros duros (cada descarte con motivo en `rejected[]`): inactiva / no vendible / `maintenanceStatus blocked` /
fuera de servicio; orden de trabajo abierta; `RoomBlock` que solape; ocupada u asignada a reserva solapada; tipo distinto
del reservado (las superiores solo entran cuando no queda ninguna del tipo reservado y `allowUpgradeSuggestion`);
`maxOccupancy` < adultos + niños; accesible si la reserva lo exige; comunicadas exigidas sin par libre; sucia con llegada
a ≤ 2 h (`DIRTY_DISCARD_HOURS`, va a `housekeepingAlerts[]`).

Fase B · puntuación (`DEFAULT_ASSIGNMENT_WEIGHTS`; `score = Σ reasons.weight`):

| Regla (`reasons[].rule`) | Peso | Motivo visible |
|---|---|---|
| `hk_inspected` / `hk_clean` | +30 / +20 | «Inspeccionada» / «Limpia» (sucia con ETA 2–4 h: 0 con aviso fuerte; > 4 h o sin ETA: 0 con aviso) |
| `preference` (tope `preference_cap`) | +15 por preferencia, máx. +45 | «Planta alta como pidió», … (vocabulario `PREFERENCE_VOCABULARY`: `floor_high · floor_low · quiet · near_elevator · far_elevator · view_sea · view_city · bed_twin · bed_king · accessible · connecting · crib`) |
| `vip` | +25 | «Cliente VIP: mejor vista/planta disponible» (`Guest.vipCode`, `loyaltyTier` platinum/gold/diamond, `Reservation.vipFlag`) |
| `returning` | +20 | «Se alojó aquí en su última visita» (última `Stay`) |
| `group` | +15 | «Junto al resto del grupo (planta N)» (mismo `groupCode`/`groupBookingId` ya asignado en la ventana) |
| `inventory_protection` | −20 | «Se reserva para otra llegada» (solo tipos distintos del reservado con demanda pendiente) |
| `rotation` | +5 | «Reparte el uso (N estancias en 30 días)» (por propiedad) |
| `free_upgrade` | −10 | «Mejora sin coste: no quedaba del tipo reservado» |
| `special_request` | 0 | «Pidió: …» (texto de `specialRequests`, sin puntuar; puede contener texto libre del huésped) |

Salida: `candidates[0..2] { roomId, number, score, reasons[], warnings[] }`, `rejected[]`, `confidence` =
(score₁ − score₂) / score₁ (empate → 0 y aviso «elige a mano»), `dataNotes[]` (datos ausentes: sin vista/planta/rasgos en
las habitaciones, sin titular…), `housekeepingAlerts[]`, `source: "rules"`. `rejected`, `dataNotes` y `housekeepingAlerts`
solo viajan en la respuesta del `POST` (no hay columna); el `GET` devuelve el DTO persistido.

**Cambiar los pesos:** `PUT /properties/:id/check-in/policy { assignmentWeights: { "vip": 40, "rotation": 0 } }` (clave =
regla o `preference_cap`; vacío = defectos) — pestaña «Check-in automatizado» › Pesos. Cambiar la semántica exige subir
`ASSIGNMENT_RULES_VERSION` (queda en cada fila `rules_version` para explicar sugerencias antiguas). Niveles
(`autoAssignLevel`): `suggest` (filas visibles) · `suggest_and_confirm` (defecto: «Confirmar» en un clic desde Mi día, la
cola `assignment_suggested` o el cajón) · `preassign` (aceptado en la política pero el lote NO asigna: D4 pendiente, §13).
Modo lote: vuelta del tick ≥ `CHECKIN_ASSIGNMENT_RUN_AT` para las llegadas de mañana sin habitación de cada propiedad con
`selfCheckInEnabled`, una instantánea para todo el lote, la primera candidata de cada llegada queda ocupada virtualmente
para las siguientes; fila `worker_job_runs` `jobName = checkin.assignment` (`queueName api.checkin`, una por propiedad y
día local). `assignRoom` NO conoce `room_blocks`: una asignación manual (`PATCH` o `confirm { roomId }`) puede caer en una
habitación bloqueada (§13).

## 5 · Identidad

- **MRZ determinista** (`packages/compliance/src/spain/mrz.ts`, ICAO 9303): TD1 (3×30, DNI/TIE), TD2 (2×36) y TD3 (2×44,
  pasaporte); dígitos de control 7-3-1 mod 10, autocorrección O↔0 en campos numéricos; `parseMrz` → `{ format, valid,
  fields, checks { document, birth, expiry, composite, personal? }, warnings }`. En el DNI el parser expone los dos
  candidatos (número de soporte en la posición del documento y número de DNI en el campo opcional; disposición tomada de
  fuentes secundarias, §2.2 del diseño): recepción coteja con el anverso antes de fiarse de `documentNumber`. Siglo de
  caducidad fijado a 20YY. `buildMrz` genera MRZ sintéticas válidas para pruebas (§11).
- **Visión opcional** (`identity-capture.service.ts`): con `AI_PROVIDER` la imagen (`data:` URL ≤
  `CHECKIN_DOCUMENT_MAX_BYTES`) pasa por el tool runner (`extractGuestIdentityFieldsTemporary`, persistida como
  `identity_capture`; la telemetría solo lleva claves leídas y confianza). Fusión: la MRZ manda (confianza 1,0,
  `source mrz_ai` / `mrz_reader`); los campos visuales entran con confianza ≥ 0,85 (`VISION_CONFIDENCE_THRESHOLD`) y si no
  van a `needsReview[]`; sin MRZ válida ni visión → `manual` con todo en revisión.
- **Nunca la imagen**: vive en la petición y muere con ella; `DocumentCapture.imageStored = false`, `imageDiscardedAt`,
  evento `recordIdentityDiscardEvent` + auditoría `ID_IMAGE_DISCARDED` (solo cuando llegó imagen). Documento caducado →
  aviso «documento caducado» sin bloquear. Nombre distinto del titular y de los acompañantes → aviso + `identity_mismatch`
  en revisión y el viajero NO recibe los datos (la captura se persiste como métrica).
- **PII**: `PII_FIELDS.CheckInGuest` (`documentNumber`, `documentSupportNumber`, `email`, `phoneMobile`,
  `residenceFullAddress`) cifrados en reposo con hash de búsqueda (`documentNumberLookupHash`, `emailLookupHash`,
  `phoneMobileLookupHash`); `fields_json` de la captura solo admite `DOCUMENT_CAPTURE_NON_PII_FIELDS` (`documentType ·
  mrzFormat · issuingCountry · nationality · sex · dateOfBirth · documentExpiryDate`). Ningún DTO saca por la API más que
  nombre y `documentNumberLast3`. Las filas de `checkin_guests` se leen con consultas de primer nivel (la extensión de
  cifrado no descifra las alcanzadas por `include`; §13 anota el resto del W2-A).
- **Purga a 30 días**: `purgeExpiredCaptures` en cada vuelta del tick vacía `fields_json` / `confidence_json` de las filas
  con `purge_at` vencido; queda la métrica (`source`, `checks`, tiempos, coste).
- **Verificación de la persona** (`IDENTITY_VERIFICATION_METHODS`): `visual_reception` (cotejo en recepción,
  `verify-identity`), `mrz_checksum` (solo si la política lo admite; en kiosco con `requireVisualCheckAtKiosk` no basta),
  `otp_email` / `otp_phone` (§3 OTP: código de 6 dígitos, hash `sha256(sessionId:código)` en `consentJson.otp`, plantilla
  `checkin_otp`), `payment_match` · `midni_qr` · `reader_hardware` (valores admitidos sin adaptador real). Defecto de la
  política: `visual_reception · mrz_checksum · otp_email`. `identityVerified` nunca lo marca el modelo.
- **EIPD pendiente**: tratamiento con ≥ 2 criterios de la lista AEPD (art. 35.4): la evaluación de impacto, el RAT, el
  texto de consentimiento y el aviso de IA por hotel (`guestConsentText` / `aiDisclosureText` de la política) los aporta
  César (§13, necesidad 8). Con proveedor Anthropic: DPA aceptado y ZDR solicitado antes del primer documento real.

## 6 · Firma y PDF del parte

- `signGuest` (`signature.service.ts`): PNG del trazo (cabecera PNG comprobada, `SIGNATURE_MIN_POINTS = 8`) + SVG
  opcional + `strokeMeta { points, durationMs, bbox }` + `ip`, `userAgent`, `sessionId`, `method` (`touch_portal ·
  touch_kiosk · touch_reception · paper_scanned`) → menor < 14 → `409 SIGNATURE_NOT_REQUIRED`; parte inexistente o
  incompleto → `409 GUEST_REGISTER_INCOMPLETE` → almacén → fila `signatures` (`sha256`, `retentionUntil` = salida + 3 años,
  `calculateSpainGuestRegisterRetentionUntil`, art. 5.3 RD 933/2021) → `markGuestRegisterSigned` con
  `signatureObjectKey = signatures.id` (sustituye los literales `sig_drawer_checkin` / `sig_manual_checkin` /
  `sig_demo_guest`) → PDF → viajero `signed` → auditoría `CHECKIN_GUEST_SIGNED`.
- **Evidencias**: hash del PNG y del PDF, sello de tiempo, trazo con tiempos, IP, user-agent y sesión = firma simple con
  prueba; sin presión (biometría = categoría especial). SES.Hospedajes no recibe la firma: el parte firmado se conserva en
  el hotel.
- **Retención 3 años**: `signatures.retention_until` indexado; la purga la hará el job de retención del registro
  (`GuestRegisterRetentionSettingsScreen`) cuando lea esta tabla (hoy no la lee: §13).
- **Almacén provisional** (`signature-storage.ts`): contrato `SignatureStorage { put, get }` con una sola implementación,
  `dataUriSignatureStorage`, que devuelve como `objectKey` la propia `data:` URI (no existe almacén de objetos en el API);
  la clave lógica `org/<org>/prop/<prop>/checkin/<sesión>/signature-<viajero>.png` se valida pero no se persiste. Solo
  admite `image/png`, `image/svg+xml` y `application/pdf` con prefijo de clave: nunca es un almacén de imágenes de
  documentos. **Punto de extensión T9**: implementar la misma interfaz sobre `documents/storage/*` y sustituir
  `getSignatureStorage()`; `signature.service.ts` solo conoce `SignatureStorage`.
- **PDF** (`entry-form-pdf.ts`): parte de entrada (modelo Orden INT/1922/2003, Anexo I A.3) con el escritor propio
  `financial-statements/pdf-writer.ts` (PDF 1.4, texto y reglas, sin imágenes): la firma NO va incrustada como bitmap; el
  PDF lleva el hash SHA-256 del PNG, fecha/hora, método e id de la firma (incrustar el PNG exige ampliar el escritor con
  `XObject /Image`, §13). Una página; `pdfSha256` en la misma fila.

## 7 · Pagos

- `POST /guest-portal/check-in/payment-link` reutiliza `createPaymentLink` del folio de la reserva con
  `paymentLinkServiceContext` (contexto de servicio con SOLO `payment.capture`; el mismo contexto lo usa ya
  `POST /guest-portal/session/:token/pay`), `methodCode = payment_link`, `clientRequestId` idempotente
  (`checkin:<sessionId>:<saldo>`): `no_folio` · `settled` (`paid`) · `link_sent` (202; 200 si idempotente; `paymentIntentId`
  en la sesión) · `at_reception` cuando el PSP responde `409 PSP_NOT_CONFIGURED` (sin fingir). Auditoría
  `CheckInPaymentStatusChanged`.
- `depositPolicy` en `completeCheckIn` (solo actor `guest`/`kiosk`; recepción nunca queda bloqueada por saldo): `none` no
  exige; `balance` → folio saldado o `paymentStatus ∈ { paid, authorized, at_reception }`; `first_night` = total / noches y
  `fixed` = `depositAmount` frente a lo cobrado en el folio → `409 BALANCE_DUE`.
- **Preautorización**: el contrato PSP (`payments/psp/psp.types.ts`) sigue con `createPaymentLink / capture / refund /
  verifyWebhook`; no existe `authorize` ni sandbox de preautorización. El estado `authorized` está reservado en el modelo y
  ninguna ruta lo escribe (decisión D3 de César). Sin `STRIPE_*` / `REDSYS_*` todo saldo termina en «se cobra en recepción».
- `PaymentToken` (marca, últimos 4) → `GuestRegisterRecord.payment*` (Anexo I A.4): la captura por webhook del PSP existe
  desde L3; el enlace del pre-check-in la hereda; sin PSP real nada se rellena.

## 8 · Jobs del líder y cómo lanzarlos a mano

`checkin-jobs.ts` (cableado en `server.ts` con `shouldStartCheckinJobs` / `startCheckinJobs`): viven en el API, no en
`apps/worker` (catálogo cerrado a 5 colas pg-boss; el worker no depende de `@hotelos/api`). Solo el líder
(`RUN_SCHEDULERS=true` + `holdsSchedulerLease` en cada vuelta) y bajo el advisory lock global `checkin.jobs`
(`pg_try_advisory_xact_lock(hashtext('checkin.jobs'))`, tope 30 min; otra réplica → vuelta `skipped`). El trabajo corre
fuera de la transacción del lock (cada invitación se confirma por sí sola). Cadencia `CHECKIN_INVITATION_INTERVAL_MS`;
apagado con `CHECKIN_INVITATION_DISABLED=true`. Ámbito: SOLO las propiedades con `property_checkin_policies.self_check_in_enabled = true`.

Una vuelta (`runCheckinJobsTick`) por propiedad, con `catch` propio (`failed[]` no detiene el resto):

1. **Invitación J-3**: reservas `confirmed` con llegada entre hoy y hoy + `inviteDaysBefore` (días locales Europe/Madrid)
   sin sesión → `inviteReservation` (plantilla `checkin_invitation`, actor `system:checkin:invitation`; canal pedido
   `email`, cae a `whatsapp` con opt-in o `sms`).
2. **Recordatorio J-1**: sesiones `invited` con `reminderAt` nulo cuya reserva llega entre hoy y hoy + `reminderDaysBefore`
   y que NO se invitaron hoy → `inviteReservation` con `checkin_reminder` (revoca el token anterior; el nuevo va en el
   recordatorio) + `reminderAt = ahora` (una sola vez aunque no haya destinatario; motivo en `CheckInReminderSent`).
3. **Lote de asignación**: hora local ≥ `CHECKIN_ASSIGNMENT_RUN_AT` y sin `worker_job_runs` `checkin.assignment`
   (`propertyId`, `scheduledFor` = día local) en `running|completed` → `runBatchForDate(mañana)` → `completed` con el
   resumen; un fallo deja `failed` y la siguiente vuelta reintenta (hasta ~6 filas `failed`/día visibles en la pantalla de
   jobs por `jobName`; `pruneJobRuns` del worker no las borra: §13).
4. **Purga** (global): `purgeExpiredCaptures` + sesiones `invited` con salida pasada → `expired`
   (`CheckInSessionExpired`, actor `system:checkin:purge`).

A mano, sin esperar al tick (todas con usuario de personal):

- Invitar / reenviar: `POST /properties/:id/check-in/sessions { reservationId, channel }` ·
  `POST /properties/:id/check-in/sessions/:sid/resend { channel? }` (Mi día › fila › «Invitar al pre-check-in» /
  cajón «Invitar de nuevo»).
- Lote de sugerencias: `POST /properties/:id/check-in/assignments/run { date? }` (sin `date` = mañana; un `run` posterior
  del mismo día expira las `suggested` y las recrea). Por reserva: `POST /reservations/:id/assignment-suggestions`.
- Una vuelta completa del tick desde código (BD del carril, API parado o con `RUN_SCHEDULERS=false`): importar
  `runCheckinJobsTick` de `apps/api/src/modules/checkin/checkin-jobs.ts` con `node --env-file-if-exists=../../.env --import
  tsx` (acepta `now`, `timeZone` y `log` inyectados: así lo hacen `__tests__/checkin-jobs.test.mts`); devuelve
  `{ skipped, summary { invited, reminded, assigned, purged }, failed[] }`. Para repetir el lote de un día, borrar antes su
  fila `worker_job_runs` (`jobName = checkin.assignment`, propiedad y `scheduledFor`).
- Zona horaria fija `Europe/Madrid` (`CHECKIN_JOBS_TIMEZONE`), no `Property.timezone` (§13).

## 9 · Kiosco y adaptadores `none` / `sandbox`

Emparejamiento sin hardware ni proveedor: dirección da de alta el dispositivo (`POST /properties/:id/kiosks { name,
capabilities?, lockProvider?, config? }`) y pide un código (`POST …/kiosks/:id/pair` → 8 dígitos, se muestra UNA vez, hash
`sha256` con `KIOSK_PAIRING_TTL_MS`); la tablet lo teclea (`POST /guest-portal/check-in/kiosk/claim { code }`, 10/min por
IP) y recibe `deviceToken` (hash en BD; `updateMany` condicionado: dos claims simultáneos no obtienen dos tokens). Desde
entonces envía `x-kiosk-token`: `authenticateKiosk` → `KioskDeviceDto` (`status ≠ disabled`) y solo cuenta si el kiosco es
de la MISMA propiedad que la sesión (si no, actor `guest`; nunca 401). Estados `unpaired · online · offline · disabled`
(`PATCH` admite `disabled | offline`); `lastSeenAt` con el heartbeat.

Portal en modo kiosco (`apps/guest-web/src/kiosk/*`): `?kiosk=1&device=<KioskDevice.id>` (el token manda; `device` es
informativo), pantalla completa, botones grandes, inactividad 90 s (`IDLE_TIMEOUT_MS`, aviso a 15 s) → reinicio y borrado
de la sesión del huésped en memoria + `sessionStorage` (la credencial del dispositivo se conserva), mensaje de handoff con
número de ticket para el mostrador. La sesión del huésped nunca va a `localStorage`.

Adaptadores (`modules/checkin/adapters/*`, contrato + implementación local, la clave real la pone César):

| Adaptador | `none` (producción sin proveedor) | `sandbox` (solo con `mode: "sandbox"` explícito) |
|---|---|---|
| `MrzReader` (`none` · `keyboard_wedge` · `sdk`) | `read()` → `null`: el kiosco ofrece cámara o formulario manual | `bufferedMrzReader`: cola en memoria; `push(texto)` normaliza (`normalizeMrzText`) y `read()` entrega las líneas a `parseMrz` sin interpretarlas |
| `CardEncoder` (`none` · `salto_space` · `assa_vostio` · `dormakaba`) | `{ status: "unavailable", message: "Recoge tu tarjeta en recepción." }` | `{ status: "encoded", cardId: "sandbox_<proveedor>_<id>" }` — el prefijo declara que ninguna cerradura la abre |
| `LockAdapter` (mismos proveedores) | `issueMobileKey()` → `unavailable` («Recoge tu llave en recepción.»), `revoke()` → `false` | llaves `sandbox_<proveedor>_<id>` con QR `demo://key/<id>`; `revoke()` honesto (true solo si existía y seguía activa) |

`resolveHardware(kiosk, { mode })` es **fail-closed**: sin `mode: "sandbox"` resuelve `production` → `none`; el lector de
MRZ no depende del modo. Terminal de pago e impresora no tienen adaptador: se exponen en `capabilities` para que el
kiosco decida (pago por enlace al móvil, sin ticket impreso). La llave móvil de la llegada sigue siendo `issueWalletPass`
(pass Apple/Google sin certificado → sin firmar, y se dice; QR de demo); no existe `MobileKey` (§13). Puente futuro con
`packages/integrations/src/adapters/locks/*` documentado en `lock.adapter.ts` (3 pasos).

## 10 · Recepcionista IA: bot del huésped y copiloto

> **Tanda L6b (2026-09-20)**: el bot y el copiloto consumen ahora el núcleo conversacional único (`modules/assistant/assistant-core.service.ts`,
> `runAssistantTurn`) con su propio prompt (`assistant_guest` / `assistant_reception`) y permisos: la respuesta con modelo del bot
> (`answerWithModelViaCore`) y su clasificación (`classifyWithCore`, misma puerta de propiedad `assistant-gate.ts`) y el alias `/copilot/ask`
> (con el `UserContext` real de la petición). Lo que sigue describe el flujo de reglas, identidad, HITL y canales, que no cambia; el detalle
> del núcleo está en `docs/runbooks/asistente-ia.md` (§5 memoria y privacidad, §12 límites).

**Bot** (`guest-bot.service.ts`, `handleGuestMessage`): un punto de entrada para dos canales — web (`POST /guest-portal/chat`,
el token identifica la reserva) y WhatsApp (`POST /webhooks/whatsapp`: número resuelto por `Guest.phoneLookupHash` +
reserva activa de la propiedad, con respaldo `CheckInGuest.phoneMobileLookupHash`; sin coincidencia pide código de reserva
y correo por `requestSignIn` y no responde datos de nadie; el número nunca se guarda en claro). Reglas: primer mensaje de
cada conversación con el aviso de IA (`PropertyAiSetting.guestFacingDisclosure` o `GUEST_AI_DISCLOSURE`, AI Act art. 50)
en el idioma del huésped; `PropertyAiSetting.aiEnabled` y `Conversation.aiEnabled` respetados (con cualquiera en `false`:
lecturas por reglas, escrituras a recepción); intención por reglas (`mode: "rules"`, confianza 0,9) y, con clave,
`llmClassify` (`mode: "llm"` SOLO cuando un modelo ha respondido). Intents: `faq · reservation_status · precheckin_link ·
eta_change · late_checkout · upgrade · service_request · complaint · handoff`. Lecturas → datos de SU reserva
(`answerGuestQuestion`, low, a través del runner con el contenido redactado); ETA → escritura directa auditada
(`GUEST_ETA_UPDATED`, dato del propio huésped); late check-out y peticiones → `createServiceRequest`, upgrade →
`sendGuestMessage`: SIEMPRE `AiToolCall awaiting_confirmation` con el contexto de servicio y respuesta «lo hemos pasado a
recepción». `handoffToHuman`: regex queja/reembolso/urgente, petición explícita de persona, confianza < 0,85 o > 2 turnos
sin resolver → `Conversation.status handoff` + `aiEnabled false`, auditoría `GUEST_CONVERSATION_HANDED_OFF`, evento
`GuestConversationHandedOff`. Resultado `GuestBotResult { conversationId, messageId, reply, intent, confidence, mode,
action: answered | updated | pending_confirmation | handoff | identify | duplicate | disabled, toolCallId, disclosureShown,
identified, language, duplicate, delivery? }`. Deduplicación por `message.id` de WhatsApp (`Message.metadataJson.externalId`).

**Webhook** (`routes/webhooks-whatsapp.routes.ts`): `GET` verifica `hub.mode=subscribe` + `hub.verify_token` y devuelve
`hub.challenge`; `POST` lee el cuerpo CRUDO, comprueba `X-Hub-Signature-256` (HMAC-SHA256 con `WHATSAPP_APP_SECRET`,
`401 WHATSAPP_SIGNATURE_INVALID`), resuelve la propiedad por `metadata.phone_number_id` →
`PropertyAiSetting.configurationJson.whatsappPhoneId` y responde SIEMPRE 200 `{ received, processed, failed, simulated }`
(Meta reintenta ante cualquier otro código); los `statuses` se ignoran. Respuesta al huésped con `whatsapp.provider
send({ recipient, body })`: dentro de la ventana de 24 h abierta por él; fuera de ella hacen falta plantillas *utility*
(§13).

**Confirmaciones** (tool runner de L6a, `ai-operations/tool-runner.service.ts` + `packages/ai-core/runner`):
`POST /ai/tool-calls/:id/confirm { decision: approve | reject, notes? }` es el único punto de ejecución de una llamada
`awaiting_confirmation`; `confirmTool` re-evalúa las puertas al confirmar y exige los `requiredPermissions` de la
herramienta más `ai.high_risk.confirm` para `high | critical` (y el rol de aprobación si la fila o el ajuste lo fijan):
**recepción confirma *medium*** (`createServiceRequest`, `sendGuestMessage`, `assignRoom`) y **jefatura/dirección
confirman *high*** (`checkInReservation`); faltas → `403 AI_TOOL_CONFIRM_FORBIDDEN { missing, requiresApprovalRole? }`;
fila caducada → `409 AI_CONFIRMATION_EXPIRED`; IA apagada en la propiedad → `403 AI_DISABLED_FOR_PROPERTY`; presupuesto →
`403 AI_BUDGET_EXCEEDED`. La revisión humana de la cola (`POST /ai-operations/review/:id/approve|reject`) exige
`ai.high_risk.confirm`. `GET /ai/tool-calls` exige `audit.read` (recepción no lista la cola por esa ruta: su vista es la
cola de Mi día). El comando heredado `POST /ai/commands/check-in-from-scan` + `POST /ai/confirmations/:id/execute` sigue
vivo para el escaneo del cajón clásico (`docs/api-contracts.md` «Assisted Check-In»).

**Copiloto** (herramientas en `packages/ai-tools/src/registry.ts`, presets del asistente): `findReservation` ·
`matchGuestToReservation` (medium, lectura; ahora acotada a la organización y a la propiedad: `propertyId` desconocido →
404 «Propiedad no encontrada.», un documento de otra organización no localiza a nadie) · `suggestRoomAssignment`
(`pms_core`, `pms.reservation.read`, medium, lectura: explica `reasons`, nunca cambia el ranking) · `assignRoom` (medium,
confirmación) · `checkInReservation` (high, confirmación) · `answerGuestQuestion` (`ai_concierge`, low) ·
`sendGuestMessage` y `createServiceRequest` (`ai_concierge`, medium, confirmación). Cola de Mi día (`front-desk-queue`):
`kind` nuevos `precheckin_ready · assignment_suggested (acción confirm_assignment) · self_checkin_done · identity_review ·
minor_without_guardian · room_not_ready · payment_failed · ses_rejected`; `degraded[]` con `checkin_sessions ·
assignment_suggestions · assignment_suggestions_tomorrow · ses_rejected` cuando una consulta falla.

## 11 · Seed y walkthrough

Tenant aislado (`db:seed:checkin`, allowlist de `demo-guard.ts` ampliada a `org_chk` / `prop_chk`; nunca Faranda):

```
corepack pnpm --filter @hotelos/database db:seed:checkin -- --reset     # con el API parado; --dry-run solo imprime el plan
```

Crea `org_chk` / `le_chk` / `prop_chk` («Hotel CHK (prueba)», 36 habitaciones en 4 plantas DBL/SUP/STE con vistas, rasgos
y accesibilidad), tres usuarios `recepcion@chk.test` (recepción), `jefe.recepcion@chk.test` (jefatura) y
`direccion@chk.test` (dirección) con contraseña `chk-demo` (`SEED_CHK_PASSWORD` la sustituye; con `NODE_ENV=production`
aborta salvo `SEED_CHK_ALLOW_PRODUCTION=1`), SES en sandbox con número de registro, IA y módulos activados, tarifa BAR y
diez reservas relativas a HOY: `CHK-01` titular + acompañante llega hoy con saldo y ETA 16:30 · `CHK-02` titular + menor de
9 años (hijo), mañana · `CHK-03/04/05` grupo `CHK-G1`, mañana · `CHK-06` VIP con saldo, mañana · `CHK-07` recurrente
(estancia previa en la 204) · `CHK-08` con `accessibilityNeeds` · `CHK-09` en 2 días sin documento ni teléfono ·
`CHK-10` alojada en la 305. Huéspedes ficticios (apellidos griegos «Alfa», «Beta»…, documentos sintéticos `CHK000001…`,
móviles `+34600000xxx`). `--reset` borra SOLO las reservas `CHK-*` de `prop_chk` y sus satélites, incluida la capa del check-in acotada a
`prop_chk` (W5-B: `checkin_sessions` en cascada `checkin_guests`, `document_captures`, `signatures`,
`assignment_suggestions`, `room_blocks`, `notification_deliveries`, `worker_job_runs checkin.assignment` y los kioscos
ajenos). Contrato: `tests/seed-checkin-contract.test.mjs`. El walkthrough de integración
(`tests/integration/checkin-seed-walkthrough.test.mts`) lanza este seed y SOLO corre contra una BD cuyo nombre termina
en `_chk` (o con `CHK_WALKTHROUGH=1`); en cualquier otra se salta con el motivo impreso.

**Fixtures MRZ sintéticas**: `buildMrz({ format, documentType, documentNumber, surname, givenNames, nationality,
dateOfBirth, sex, expiryDate, … })` de `@hotelos/compliance` calcula los dígitos de control (el especimen ICAO P4 de
`tests/mrz.test.mjs` con los 5 checks `true` es el oráculo independiente del generador). Ejemplo de uso en pruebas:
`POST /guest-portal/check-in/guests/:id/mrz { lines: buildMrz({ format: "TD3", documentType: "PASSPORT", documentNumber:
"PAB000009", surname: "ALFA", givenNames: "PRUEBA", nationality: "ESP", dateOfBirth: "1980-01-01", sex: "M", expiryDate:
"2030-01-01" }) }` → `checks` todos `true`, viajero `document_captured` con `documentNumberLast3 = "009"`.

Walkthrough (BD del carril, API `PORT=3919 RUN_SCHEDULERS=false TENANT_BOOTSTRAP_SKIP=true`, portal Vite `:5189`):

1. Activar el self check-in: `PUT /properties/prop_chk/check-in/policy { selfCheckInEnabled: true }` (dirección o
   jefatura) — la política por defecto no lo activa.
2. Invitar `CHK-01`: `POST /properties/prop_chk/check-in/sessions { reservationId: "chk_res_01", channel: "email" }` →
   `notification.simulated = true` y `checkInUrl` en claro (sin `EMAIL_PROVIDER`).
3. Portal: abrir `checkInUrl` (`/checkin?token=…`) → asistente de 6 pasos (Viajeros → Documento → Datos → Firma → Pago y
   extras → Llegada): pegar la MRZ sintética (o cámara con clave de IA), completar dirección/localidad/país y contacto,
   consentimientos, ETA, firmar en el canvas, enlace de pago (sin PSP → «se cobra en recepción»), «Completar» →
   `ready_for_arrival`, evento `CheckInPreArrivalCompleted`, partes creados.
4. Mi día (`/hoy`, recepción): columna «Pre-check-in» = listo; `POST /reservations/chk_res_01/assignment-suggestions` o el
   chip «Sugerida NNN · N motivos» → «Confirmar» (`POST /assignment-suggestions/:id/confirm`).
5. Llegada: kiosco (`?kiosk=1&device=<id>` tras emparejar) o móvil → `POST …/arrive`; con `requireVisualCheckAtKiosk`
   (defecto) el kiosco exige antes `verify-identity` de recepción o un OTP admitido (`otp_email` con `debugCode` en demo) →
   `checked_in`, llave (`key.status` `unavailable` sin proveedor: «Recoge tu llave en recepción»), parte encolado en el
   sandbox SES (`ses.status queued|partial|warning`), bienvenida `simulated`.
6. Recepción alternativa: cajón de check-in (`QuickCheckInDrawer`): «Escanear documento» / «Pegar MRZ» → top-3 → firma en
   el pad → cotejo → `POST /reservations/:id/check-in/complete`; `409 ROOM_NOT_READY` ofrece «Buscar alternativa».
7. Bot: `POST /guest-portal/chat { text: "¿a qué hora es el desayuno?" }` con el token → aviso de IA en el primer mensaje,
   respuesta por reglas (`mode: "rules"`) sin clave; «quiero salir tarde» → `pending_confirmation` con `toolCallId` que
   recepción aprueba en `POST /ai/tool-calls/:id/confirm`.

Residuos de las verificaciones de la tanda en `hotelos_chk` (tenant CHK, por diseño): `chk_res_01` alojada, sugerencias
`confirmed/expired/suggested`, kioscos «Tablet W4B/W4C», entregas `checkin_welcome`, 1 `worker_job_runs checkin.assignment`
del 2026-09-19 y auditoría; `db:seed:checkin -- --reset` rearma el día (la capa del check-in de `prop_chk` incluida).

## 12 · Puertas y comandos exactos

Desde el directorio raíz del monorepo (`<worktree>/hotelos/`); en esta shell solo existe `corepack pnpm`:

```
bash scripts/gates.sh --quick --json <fichero>                      # tras cada ola (NAV_TREE_CSV=/Users/cfernandez/anfitorio-demo/pilots/tanda5-nav-tree.csv)
bash scripts/gates.sh --json <fichero>                              # completa al final (+ build admin-web + integración)
corepack pnpm run typecheck:all
corepack pnpm --filter @hotelos/api test                            # unitarios (incluye modules/checkin/__tests__/*.test.mts: arrival, checkin-jobs,
                                                                    #   checkin-session, entry-form-pdf, guest-bot, hardware-adapters, identity-capture,
                                                                    #   kiosk, otp, service-context, signature; pms/__tests__/room-assignment.{engine,service};
                                                                    #   dashboards/__tests__/front-desk-checkin; notifications/__tests__/checkin-templates)
corepack pnpm --filter @hotelos/admin-web test                      # checkin-drawer, checkin-settings-view, frontdesk-checkin-columns, signature-pad, checkin-runner
node --test tests/*.test.mjs                                        # contratos raíz: checkin-schema-contract (9 tablas, 0 enums, PII, tipos wire),
                                                                    #   seed-checkin-contract, api-route-permissions-contract (partials), brand-contract, …
node --test packages/compliance/src/spain/__tests__/mrz.test.mjs    # parser MRZ (especímenes ICAO)
(cd apps/api && node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 ../../tests/integration/{checkin-flow,checkin-session,guest-portal,kiosk-pairing,room-assignment,room-assignment-routes,guest-bot,whatsapp-webhook,checkin-corrector}.test.mts)
                                                                    #   desde la raíz sin --import tsx ni cwd apps/api falla con ERR_MODULE_NOT_FOUND (@hotelos/database);
                                                                    #   checkin-seed-walkthrough SOLO corre contra una BD *_chk o con CHK_WALKTHROUGH=1 (deja org_chk sembrado)
corepack pnpm --filter @hotelos/database db:migrate:status          # 21/21 en el carril (+ 20260920160000_checkin_pago_en_recepcion del corrector)
corepack pnpm --filter @hotelos/database db:drift:check             # «No difference detected.» en el carril (las carpetas IVA de otro carril ya están en el árbol)
node scripts/check-migrations-vs-schema.mjs                         # +9 tablas (+1 columna property_checkin_policies.allow_pay_at_reception)
node --test tests/migrations-squash-contract.test.mjs               # CREATE TABLE − DROP TABLE = modelos, 0 enums
node scripts/env-census.mjs                                         # (--write en la fusión: readBy de CHECKIN_* / WHATSAPP_* / SEED_CHK_*)
corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run          # sin claves nuevas
node scripts/build-nav-tree.mjs --check --csv <CSV>                 # pestaña /hoy/check-in-automatizado
```

Instancia propia del carril: `PORT=3919 RUN_SCHEDULERS=false TENANT_BOOTSTRAP_SKIP=true node --env-file-if-exists=../../.env
--import tsx src/server.ts` desde `apps/api`; Vite `--port 5189` con `VITE_API_URL=http://127.0.0.1:3919`; matar por PID.
Puerta completa del corrector (2026-09-20, `scratchpad/CHK/gates-corrector-full.json`): 10/14 puertas: typecheck:all 15 PASS · 0 FAIL · 1 SKIP (apps/guest-web) · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119/119 · worker 34/34 · admin-web unit 1.901 (1.872 pass · 28 fail: recuentos del árbol de navegación compartido con T9, idénticos a la línea base) · contratos raíz 617 (613 pass · 2 fail: `SCREEN_COMPONENTS` / `GoodsReceiptsScreen` de T9, idénticos a la línea base) · discoverability 197 URL (rojo por los 4 enlaces de T9, como antes) · nav-tree al día (70 · 104 · 205) · route-access 15 × 197 · cocoa waves §6 al día · rbac dry-run OK · migrate status 21/21 + drift «No difference detected.» · admin-web build OK · integración 881 (872 pass · 1 fail · 8 skips: en la puerta el único fallo fue el escenario nuevo SEC-4 del corrector, cuyo PATCH real pasa por backoffice.service.ts#patchAiSettings y no por el guardia recién añadido; guardia compartido `assertWhatsappPhoneIdFree` en ambos escritores y reejecución completa de tests/integration: 881 · 873 pass · 0 fail · 8 skips, `scratchpad/CHK/corrector-integration-2.log`)

## 13 · Límites honestos y lo que solo César puede aportar

Qué NO hace el módulo hoy (deltas frente al diseño; detalle en el apéndice del diseño):

- Sin `MobileKey` ni `RoomFeatureAssignment` (9 modelos, no 10/11): la llave sigue en `issueWalletPass`
  (`guest_portal_actions`) y los rasgos en `Room.featuresJson`. Sin `preassign_room` en la matriz de riesgo: el nivel
  `preassign` no asigna (D4). La confirmación de IA va por `/ai/tool-calls/:id/confirm` (nuevo flujo) y
  `/ai/confirmations/:id/execute` (cajón clásico), no se retiró ninguna. Jobs in-process en el API, no en `apps/worker`.
- Índice único `guest_register_records(reservation_id, guest_id)` NO creado (0 duplicados hoy; dedupe en código en
  `compliance.service.ts`): deuda sin dueño, fuera de la migración por decisión del brief.
- Almacén de firmas provisional (`data:` URI como `objectKey`) hasta T9 (§6); PDF sin la imagen de la firma; el job de
  retención del registro no purga `signatures`.
- CORS (corrector REV3-04): `server.ts` `allowedHeaders` admite `x-guest-token` y `x-kiosk-token` (contrato en
  `tests/cors-contract.test.mjs`); `?token=` solo vale en GET (SEC-6) y el logger redacta `token=` de la URL.
- Sin proveedor de visión la captura por imagen no extrae nada (la vía operativa es «Pegar MRZ» o lector); sin
  face-match ni prueba de vida (fuera de Claude por AUP); MiDNI y `reader_hardware` son valores admitidos sin adaptador.
- WhatsApp: sin plantillas *utility* registradas en Meta el bot y la bienvenida solo llegan dentro de la ventana de 24 h;
  el dispatcher no pasa `template` al proveedor. Los huéspedes del seed no se reconocen por número (el seed rellena
  `Guest.mobilePhone` sin hash de búsqueda, no `Guest.phone`).
- `validateRoomUnderLock` (corrector REV3-01) rechaza con 409 `ROOM_BLOCKED` cualquier RoomBlock que solape la estancia
  (asignar, alojar, mover, cambiar fechas) y `completeCheckIn` trata la asignada bloqueada como no lista (reasignación
  de la misma categoría); `housekeepingAlerts` no crea tarea a pisos; las notas del motor no se persisten; Los Tilos sin
  vista/planta/rasgos → candidatas empatadas (confianza 0).
- `handed_off` lo escriben la derivación por saldo sin PSP (`payment_failed`, corrector REV3-02) y el seed;
  `cancelled` lo escribe la supresión RGPD (`eraseCheckInData`, corrector SEC-3); `auto_assigned` / `authorized` siguen
  reservados sin escritor; cancelar una reserva no cierra su sesión; el `--reset` del seed (W5-B) borra las tablas
  `checkin_*`, capturas, firmas, sugerencias, bloqueos, entregas y kioscos de prop_chk. Corregidos por el corrector:
  `documentNumberLast3` real en todas las cargas (REV3-07), el `PATCH` de consentimientos conserva el OTP pendiente
  (REV3-08), la vía «Pegar MRZ» aplica el cotejo de nombre de §4d (REV3-05), los menores < 14 no necesitan documento ni
  teléfono propios (REV3-06), país en alfa-3 y `paymentType` del parte (REV3-15).
- Recepción cierra desde el cajón sesiones que el huésped no cerró (corrector REV3-04): `POST …/check-in/complete`
  crea los partes de los viajeros con datos completos, la firma del mostrador también, `PATCH
  /reservations/:id/check-in/guests/:guestId` corrige viajeros y `POST …/check-in/resolve-handoff` reabre una sesión
  derivada; el cajón comprueba las precondiciones (`dryRun`) ANTES de asignar y cobrar y recuerda el intento de cobro
  entre aperturas (REV3-03). Identidad exigida solo al titular; SES con error no tolerado no rompe el check-in
  (`ses.status warning`, `SES_QUEUE_FAILED`).
- Sin PSP, «pago en recepción» (`at_reception`) NO satisface `depositPolicy` para el huésped/kiosco salvo
  `allowPayAtReception` en la política (corrector REV3-02); la sesión pasa a `handed_off payment_failed` y recepción
  cobra y cierra.
- La métrica «Llaves sin recepción» solo cuenta pases firmados por Apple (`ArrivalDto.key.signed`); con el adaptador
  `none` y sin certificado es 0 % y la tarjeta se recoge en recepción (corrector REV3-13).
- Kiosco: sin heartbeat automático ni comprobación de `requireVisualCheckAtKiosk` en `/document` y `/signature` (solo en
  `arrive`); `front_office_manager` no empareja (`kiosk.configure`).
- Zona horaria de los jobs fija a Europe/Madrid; ETA del motor interpretada en UTC (como `hk_urgent` del rack).
- Sin `eslint.config.*` en el repo (solo typecheck); guest-web sin typecheck real (SKIP conocido por `@types/react`).

Lo que solo César puede aportar (diseño §10.2 necesidades 1-8 y §11.1 decisiones D1-D8):

| # | Necesidad / decisión | Bloquea |
|---|---|---|
| N1 · D1 · D8 | Clave de IA de organización (`AI_PROVIDER=anthropic`, `AI_PROVIDER_API_KEY`, `AI_MODEL`), DPA + ZDR, residencia (API directa vs Bedrock UE), presupuesto por hotel; proveedor de visión (Claude vs Azure vs solo MRZ) | Visión sobre documentos, bot y copiloto con modelo |
| N2 | Email transaccional (`EMAIL_PROVIDER`, `EMAIL_PROVIDER_KEY`, `EMAIL_FROM`) con dominio verificado | Invitación, recordatorio, OTP y bienvenida reales por correo |
| N3 · D6 | WhatsApp Business (Tech Provider o BSP), número por hotel, plantillas *utility* `checkin_invitation` / `checkin_reminder` / `checkin_welcome` aprobadas, `WHATSAPP_PHONE_ID` + `WHATSAPP_PROVIDER_TOKEN`, `WHATSAPP_APP_SECRET` + `WHATSAPP_VERIFY_TOKEN`, opt-in, presupuesto post-01/10/2026 | Canal WhatsApp (entrada y salida) |
| N4 · D3 | PSP (Stripe test / Redsys) y decidir enlace de pago vs preautorización (`authorize` en el contrato PSP) | Cobro real del saldo/depósito; estado `authorized` |
| N5 | Certificado y alta SES.Hospedajes por establecimiento (`sesRegistryNumber`, usuario del WS, certificado XAdES, `SES_HOSPEDAJES_MODE=preproduction`) y la documentación técnica oficial para contrastar `xml.ts` (R1) | Envío real del parte (hoy sandbox `stub`) |
| N6 · D5 | Hardware: cerradura (Salto / Assa / dormakaba / TESA) y licencias, tablet o tótem con lector MRZ y codificador, certificado Apple Pass Type ID, `GOOGLE_WALLET_ISSUER_ID` | Llave y tarjeta reales (hoy `none` / QR de demo) |
| N7 · D2 · D4 · D7 | Piloto (LT o RA), kiosco en esta fase, métodos de verificación en línea admitidos (OTP / medio de pago), IDV (Veriff) o MiDNI, nivel `preassign` autónomo, OCR on-device, app móvil | Alcance de la siguiente fase |
| N8 | Legal: EIPD y RAT, texto de consentimiento y aviso de IA por hotel, consulta escrita a SES sobre la firma en tablet, revisión del PDF del parte por el asesor | Producción |

## 14 · Métricas (§1.8) y dónde se leen

| Métrica | Fuente hoy |
|---|---|
| % reservas con pre-check-in completado | Pestaña «Check-in automatizado» › «Métricas del módulo» (hoy y 7 días, calculadas desde `GET /properties/:id/check-in/arrivals`: «Pre-check-in completado hoy», «Invitadas», «Con habitación asignada», «Llaves sin recepción») y `GET /dashboards/front-desk` `kpis.preCheckInCompleted`; en BD `checkin_sessions.status` por `property_id` |
| % documentos sin corrección manual | `document_captures.source` (`mrz_reader · mrz_ai · ai_vision · manual`) y `needs_review_json` vacío; confianza en `confidence_json` hasta la purga |
| Minutos de mostrador por llegada | No se mide todavía: proxy `checkin_sessions.arrived_at → checked_in_at` y `signatures.method` (`touch_portal` vs `touch_reception`); la medida instrumentada (`apps/admin-web/e2e/measure`) es de UX-1 |
| % partes SES aceptados a la primera | `ses_hospedajes_submissions.status` por reserva con sesión (`CompleteCheckInResult.ses.status`), bandeja de cumplimiento (`ses_rejected` en la cola) |
| % llegadas con habitación asignada la tarde anterior | `assignment_suggestions` (`status confirmed/changed`, `created_at` del lote de las 18:00) frente a llegadas del día; `worker_job_runs` `checkin.assignment` (`outputJson` con `suggested / skipped / failed`) |
| Tasa de automatización y CSAT del bot por canal | `messages` / `conversations` con `channel` y `status handoff`, `ai_tool_calls` (`awaiting_confirmation`, `recordAs`), auditoría `GUEST_CONVERSATION_HANDED_OFF`; CSAT no se recoge (sin encuesta del bot) |
| Conversión de upsell | No aplica: el API no expone ofertas al pre-check-in (`UPSELL_UNAVAILABLE` reservado; el bloque del asistente no se pinta) |
| % llaves emitidas sin recepción | `CompleteCheckInResult.key.status` por sesión (`guest_portal_actions` de `issueWalletPass`) y la columna «Llave» de Mi día; con adaptador `none` es 0 % por construcción |

Objetivo del piloto (referencias autoinformadas, diseño §1.8): 60-80 % de pre-check-in. Ninguna pantalla promete
«enviado» o «llave activa» sin el estado real del proveedor (`simulated`, `unavailable`).
