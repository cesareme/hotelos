# Runbook · Auditoría y flujo de eventos (`audit_events` / `event_stream`)

Fuente: `apps/api/src/modules/audit/audit.service.ts` (sellado, cola de persistencia, verificación),
`apps/api/src/lib/ids.ts` (ids), `apps/api/src/lib/audit-chain-cli.ts` (disciplina de la cadena en los CLI). Contrato
público: `docs/api-contracts.md` «Audit Integrity». Tests: `apps/api/src/modules/audit/__tests__/audit-chain.test.mts`
(cadena), `audit-persist.test.mts` (persistidores, fusión T8 · E1), `apps/api/src/lib/__tests__/ids.test.mts`.

## 1 · Qué son

- **`audit_events`** (`recordAuditEvent`): quién hizo qué sobre qué entidad (`action`, `entityType`, `beforeJson` /
  `afterJson`, IP, dispositivo, correlación). **`event_stream`** (`recordDomainEvent`): eventos de dominio
  (`ReservationCreated`, `InvoiceIssued`…) de los que cuelgan las proyecciones contables, VeriFactu y las notificaciones.
- Ambas tablas son **append-only**: no hay API de actualización ni borrado. Cada registro se sella con SHA-256 sobre su
  contenido más el `previousHash` del registro anterior → `currentHash`; el siguiente enlaza con ese hash (cadena).
- La **punta de la cadena vive en memoria** por proceso (`demoStore.auditEvents` / `demoStore.events`). Al arrancar,
  `hydrateAuditChainFromPostgres` lee el último hash de cada tabla y siembra un centinela `__CHAIN_TIP__` para que el
  primer evento del proceso enlace con la punta de Postgres. Dos procesos escribiendo a la vez sobre la misma base de
  datos bifurcan la cadena (limitación conocida: un solo escritor en producción).
- La escritura es **síncrona en memoria y encolada hacia Postgres** (`queueAuditPersist` / `queueDomainEventPersist`, una
  cola serializada por tabla). Un CLI que escriba eventos debe hidratar antes de escribir y vaciar la cola con
  `flushAuditQueues` **antes** de `prisma.$disconnect()` (`withAuditChain` en `lib/audit-chain-cli.ts`): si desconecta
  antes, los eventos aún encolados se pierden («Engine is not yet connected», 2026-09-18).

## 2 · Ids

`createId(prefix)` en `lib/ids.ts` genera `<prefijo>_` + **16 hex** (64 bits de `randomBytes`) para **todos** los prefijos
(`aud_`, `evt_`, `corr_`, `res_`…; ninguna columna del esquema limita la longitud). Hasta la fusión T8 (E1) eran 8 hex
(32 bits, prefijo de un UUID v4). Los ids anteriores siguen siendo válidos: conviven ambas longitudes en las tablas.

## 3 · Qué pasó el 2026-09-19

Carga real de reservas de OPERA (Tanda 7d): con **~184.000 filas** entre `audit_events` y `event_stream`, 8 hex daban
**4 colisiones reales** (`Unique constraint failed on the fields: (id)` / `(event_id)`, Prisma **P2002**) con eventos
previos del mismo día. Los persistidores solo hacían `console.error` y seguían: los 4 eventos **se perdieron** (las
reservas y asignaciones sí están en base de datos; falta el evento) y la **cadena de Postgres quedó rota en esos
puntos**: el registro siguiente enlaza (`previousHash`) con un hash que ninguna fila tiene. Detalle y horas UTC en
`docs/runbooks/reservas-importacion.md` y `docs/design/OPERA-CLOUD-MODO-SOMBRA.md` (tabla de incidencias).

**No se repara**: son datos; una cadena append-only no se reescribe. Queda documentado aquí y en los informes citados.
Cambio aplicado en la fusión T8 (E1): ids a 64 bits, persistidores con registro del fallo y contador (§4).

## 4 · Cómo se vigila

- **Log a nivel error** por cada fallo de persistencia (nunca se relanza; la cola sigue). En el API sale por pino
  (`setAuditLogger(app.log.child({ module: "audit" }))` en `server.ts`, con `{ eventId, action, code, error }`);
  sin logger inyectado (CLI de `scripts/`, tests) es una línea JSON por `console.error`:
  `{"level":"error","msg":"[audit] persistencia fallida: id duplicado (P2002); evento perdido y cadena hash rota",
  "eventId":"aud_…","action":"…","code":"P2002","error":"…"}` (`[event] …` para `event_stream`; `msg` sin el sufijo
  P2002 y `code` = código Prisma o `UNKNOWN` para cualquier otro fallo).
- **Contador en memoria desde el arranque**: `getAuditPersistStats()` → `{ failures, lastError: { eventId, action,
  code, at } | null }`. `GET /health` lo expone en **`checks.audit`**: `ok=false` (y `status: "degraded"`) si ha habido
  algún fallo desde que arrancó el proceso, con el recuento y el último error en `message`. Reiniciar el proceso pone
  el contador a cero: **anota el incidente antes de reiniciar**.
- **`GET /audit-events/integrity`** y **`GET /events/integrity`** (permiso `audit.read`): recorren el anillo **en
  memoria** del proceso anclado a la punta hidratada (`valid`, `count`, `anchoredTo`, `brokenAt`, `reason`). Detectan
  manipulación o bifurcación en memoria; una fila perdida en Postgres NO aparece aquí (el anillo la conserva): se ve
  recorriendo la tabla y buscando un `previousHash` sin fila.

## 5 · Si vuelve a ocurrir

1. Localiza la línea `persistencia fallida` en el log del API: `eventId`, `action`, `code`, `error`. Con `code` P2002
   tras E1 (16 hex) sospecha de un evento encolado dos veces o de un CLI/replay que reutiliza ids, no del azar.
2. Comprueba que la escritura de negocio existe (la auditoría es un espejo: la reserva, factura o rol están en su tabla).
3. Registra el hueco (tabla, `eventId`, `action`, hora UTC) en el informe de la operación en curso (`docs/audits/`).
   No intentes reinsertar el evento ni reescribir hashes.
4. Con otros códigos (P1001/P1017 conexión, «Engine is not yet connected»): el proceso o CLI perdió Postgres con eventos
   encolados; en los CLI usa `withAuditChain` (hidratar → ejecutar → `flushAuditQueues` → `$disconnect`).
5. `GET /health` seguirá `degraded` hasta el siguiente reinicio; reinicia solo cuando el incidente esté anotado.

## 6 · Acciones nuevas (Tanda T9 y Tanda CHK, 2026-09-19/20)

Catálogo de las acciones de `audit_events.action` añadidas por la Tanda T9 (documentos y digitalización), la Tanda CHK
(check-in automatizado) y FIX-1, con la entidad (`entityType`), el punto de emisión y lo que el `afterJson` guarda y lo
que NUNCA guarda. Las listas canónicas viven en `docs/api-contracts.md` (párrafos «Auditoría» de «Documentos y
digitalización (Tanda T9 · 2026-09-19)» y «Check-in automatizado (Tanda CHK · 2026-09-19)»); esta sección las fija con su
origen en código (Tanda CIERRE-1, lote C3b). Regla común: identificadores, estados, recuentos, hashes y fechas; nunca
bytes, claves del almacén, secretos, imágenes ni textos con datos personales.

### 6.1 · Tanda T9 · documentos y digitalización

Entidad `incoming_document` (`DOCUMENT_AUDIT_ENTITY`, `apps/api/src/modules/documents/documents-audit.ts:15`) salvo
`DOCUMENT_SETTINGS_UPDATED`, `GOODS_RECEIPT_*` y `BILL_MATCHED` (la lista de `docs/api-contracts.md` las agrupa bajo
`incoming_document`; la entidad real es la de esta tabla). Forma fija del `afterJson` (`documentAuditSummary`, `documents-audit.ts:28-40`): `registryNumber`,
`status`, `kind`, `sha256`, `sizeBytes`, `pageCount`, `physicalStatus`, `source` más los ids del paso; **nunca** bytes, la
clave del almacén, el texto extraído, la nota de captura ni —en el correo— remitente, asunto o nombre del adjunto
(T9 · SEC-02: la auditoría es inmutable; ni la purga ni `executeErasure` la tocan).

| Acción | Entidad | Dónde se emite | Qué guarda / qué NO guarda |
| --- | --- | --- | --- |
| `DOCUMENT_CAPTURED`, `DOCUMENT_FILE_ADDED`, `DOCUMENT_SENT`, `DOCUMENT_DOWNLOADED`, `DOCUMENT_RECAPTURED` | `incoming_document` | `DOCUMENT_AUDIT_ACTIONS` (`documents-audit.ts:17-23`) desde `documents.service.ts` (captura web / correo, ficheros añadidos, envío a oficina, descarga, recaptura); el envío automático también en `pipeline.service.ts:651` (`automatic: true`) | El resumen fijo + ids de mensaje / adjunto / conexión en la captura por correo. NO la nota de captura ni el remitente, asunto o nombre del adjunto (SEC-02). |
| `DOCUMENT_CLASSIFIED`, `DOCUMENT_EXTRACTED`, `DOCUMENT_ACTION_PROPOSED` | `incoming_document` | `pipeline.service.ts:129-131` (`DOCUMENT_PIPELINE_AUDIT_ACTIONS`); emisión en `:717` / `:831` (actor `ai` si la clasificación viene del modelo, si no `system`), `:845` / `:884` (extracción, incluido `status: "failed"` con el error), `:934` (`{ proposedAction, checks, autonomy, runNo }`) | Clase, `runNo`, estado de la pasada y de las comprobaciones. NO el texto del documento ni la respuesta íntegra del modelo. |
| `DOCUMENT_ASSIGNED`, `DOCUMENT_REVIEWED`, `DOCUMENT_APPROVED`, `DOCUMENT_REJECTED`, `DOCUMENT_ARCHIVED`, `DOCUMENT_ACTION_CREATED`, `DOCUMENT_ACTION_UPDATED`, `DOCUMENT_AUTONOMOUS_DECISION` | `incoming_document` | `actions.service.ts:84-91` (`DOCUMENT_ACTIONS_AUDIT`), helper `audit()` `:364-374`; emisión `:457`, `:494`, `:572` / `:609` (aprobación: recepción o factura creada), `:669` (rechazo: `reason`, `returnToCentre`, `duplicateOfId`), `:701` (archivo: `retentionUntil`, `legalHold`), `:746`, `:766`, `:816` (actor `ai`, `beforeJson.status`) | Resumen fijo + `reviewedKeys` (nombres de campo revisados), `reproposed`, nota de revisión / motivo de rechazo, ids de la recepción o factura creadas. NO los valores extraídos. |
| `DOCUMENT_SPLIT`, `DOCUMENT_MERGED` | `incoming_document` | `split-merge.service.ts:52` | Ids del origen y de los trozos / absorbidos y páginas (el troceo es lógico: comparten bytes). |
| `DOCUMENT_DISPATCHED`, `DOCUMENT_DISPATCH_RECEIVED`, `DOCUMENT_DISPATCH_SHEET_DOWNLOADED` | `incoming_document` | `dispatch.service.ts:46` (remesa centro → oficina; la hoja cuelga del primer documento del lote) | Id y recuento de la remesa, recepción en oficina y descarga de la hoja. |
| `DOCUMENT_BLOCKED`, `DOCUMENT_UNBLOCKED`, `DOCUMENT_PURGED`, `DOCUMENT_GDPR_ERASED` | `incoming_document` | `retention.service.ts:58-63` (`DOCUMENT_RETENTION_AUDIT_ACTIONS`); emisión `:444` (bloqueo por retención vencida, `reason: "retention_expired"`), `:566` (bloqueo manual: `legalHold`, `reason`), `:587` (desbloqueo), `:344` (purga: `filesDeleted`, `deletedAt`, `reason`), `:384` (borrado RGPD: `extractions`, `pages`, `reason`) | Resumen fijo + fechas, `legalHold`, recuentos de ficheros / extracciones / páginas borrados y motivo. La purga y el borrado NO reescriben eventos anteriores (append-only). |
| `DOCUMENT_BLOCKED_READ` | `incoming_document` | `archive.service.ts:42` (`DOCUMENT_ARCHIVE_AUDIT_ACTIONS.blockedRead`; lectura de un documento bloqueado desde el archivo) | Resumen fijo del documento leído. |
| `DOCUMENT_SETTINGS_UPDATED` | `document_settings` (`DOCUMENT_SETTINGS_AUDIT_ENTITY`, `settings.service.ts:32`) | `settings.service.ts:33` (`DOCUMENT_SETTINGS_AUDIT_ACTIONS.updated`) | Ajustes del módulo por organización antes / después. |
| `GOODS_RECEIPT_CREATED`, `GOODS_RECEIPT_DISPUTED` | `goods_receipt` (`GOODS_RECEIPT_AUDIT_ENTITY`, `goods-receipts.service.ts:51`) | `goods-receipts.service.ts:569`, `:636` | Recepción (id, documento / albarán de origen, estado, disputa y motivo). |
| `BILL_MATCHED` | `supplier_bill` | `bill-matching.service.ts:45`, `:390-391` | Cotejo factura ↔ recepción a 2 vías (ids y diferencias). |

### 6.2 · Tanda CHK · check-in automatizado

Módulo `apps/api/src/modules/checkin/*` salvo donde se indica (`pms/room-assignment.service.ts`,
`messaging/messaging.service.ts`, `ai/check-in.command.ts`). Secretos (CHK · SEC-1): el token del enlace mágico de la
invitación y el código OTP **no se persisten** en ningún evento ni en `notification_deliveries` (allí queda
`token=[redacted]`); las imágenes del documento y de la firma nunca viajan en el `afterJson`; el PAN nunca se escribe
(`looksLikePan` bloquea token, últimos 4 e identificador antes de escribir).

| Acción | Entidad | Dónde se emite | Qué guarda / qué NO guarda |
| --- | --- | --- | --- |
| `CheckInSessionCreated` | `checkin_session` | `checkin-session.service.ts:599` | `{ reservationId, channel, travellers, linked }`. |
| `CheckInInvited` | `checkin_session` | `checkin-session.service.ts:753` (actor `user`) | `{ reservationId, channel, dispatched, simulated, reason }`. NO el token del enlace (SEC-1). |
| `CheckInReminderSent`, `CheckInSessionExpired` | `checkin_session` | `checkin-jobs.ts:261`, `:357` (actor `system`; la caducidad la escribe `system:checkin:purge`) | Recordatorio: canal y resultado del envío; caducidad: `{ status: "expired", reservationId, reason: "departure_passed" }`. |
| `CheckInSessionUpdated` | `checkin_session` | `checkin-session.service.ts:864` | `{ changed, etaDeclared, preferences, status }`. |
| `CheckInGuestAdded` / `CheckInGuestUpdated` | `checkin_guest` | `checkin-session.service.ts:1068` (portal, quiosco o mostrador; `PATCH /reservations/:id/check-in/guests/:guestId`, corrector REV3-04, con actor `user`) | `{ sessionId, fields (nombres de los campos tocados), status, isMinor, missing }`. NO los valores del documento. |
| `CheckInGuestRemoved` | `checkin_guest` | `checkin-session.service.ts:1092` | Ids de sesión y viajero. |
| `CheckInMrzApplied`, `CheckInMrzMismatch` | `checkin_guest` | `checkin-session.service.ts:1250`, `:1183` | `{ sessionId, captureId, format, checks, documentType, status, missing }` / `needsReview: ["identity_mismatch"]`. NO la MRZ ni la imagen. |
| `CheckInGuestProfileFilled` | `checkin_session` | `arrival.service.ts:858` (actor `user` o `system`) | `{ reservationId, profiles }` (perfiles volcados). |
| `CheckInPreArrivalCompleted` | `checkin_session` (+ evento de dominio homónimo en `event_stream`) | `checkin-session.service.ts:1385` | `{ status, travellers, guestRegisterRecordIds }`. |
| `CheckInPaymentStatusChanged` | `checkin_session` | `checkin-payment.service.ts:235` y `checkin.routes.ts:374` (actor `system`) | `{ paymentStatus, …extra }` (`authorized` / `link_sent` / `failed`…). NO datos de tarjeta. |
| `CheckInHandedOff` | `checkin_session` | `arrival.service.ts:703` (pago fallido: `{ handoffKind, reason, required, paid, balanceDue, depositPolicy }`), `:795` (actor `system`) | Motivo y saldo de la derivación a recepción. |
| `CheckInHandoffResolved` | `checkin_session` | `checkin-session.service.ts:971` (`POST /reservations/:id/check-in/resolve-handoff`, corrector REV3-04, actor `user`) | `{ status (resolvedTo), note, missing[{ checkInGuestId, fields }] }`. |
| `CheckInPolicyUpdated` | `property_checkin_policy` | `checkin-policy.service.ts:132` (actor `user`) | Política de la propiedad antes / después. |
| `CHECKIN_GUEST_SIGNED` | `signature` | `signature.service.ts:384` (actor `user`) | `{ guestRegisterRecordId, checkInGuestId, sha256, pdfSha256, method, points, durationMs, retentionUntil }`. NO la imagen de la firma. |
| `CHECKIN_IDENTITY_VERIFIED` | `checkin_guest` | `checkin.routes.ts:599` (`POST …/verify-identity`, actor `user`) | `beforeJson` / `afterJson` `{ method, verifiedAt, status, guestRegisterRecordId }`. |
| `CHECKIN_OTP_REQUESTED`, `CHECKIN_OTP_FAILED`, `CHECKIN_OTP_VERIFIED` | `checkin_session` | `otp.service.ts:322`, `:347`, `:365` (helper `audit()` `:341`, actor `system`) | `{ channel, method, recipient, expiresAt, dispatched, simulated, reason }` / `{ reason, attempts, maxAttempts }` / `{ checkInGuestId, method, policyAllowed, guestStatus, guestRegisterRecordId }`. NO el código OTP ni su hash (SEC-1). |
| `ID_IMAGE_DISCARDED` | `guest_identity_scan` | `identity-capture.service.ts:752` (segunda entidad emisora; la primera es `ai/check-in.command.ts:103`; actor `system`) | `{ imageStored: false, imageDiscarded: true, extractedFields (nombres), source, mediaType, bytes, checkInGuestId }`. NO la imagen ni los valores. |
| `GUEST_SELF_CHECKED_IN`, `GUEST_CHECKED_IN_ASSISTED` | `checkin_session` | `arrival.service.ts:906` (portal / quiosco → `GUEST_SELF_CHECKED_IN`; mostrador, `POST /reservations/:id/check-in/complete`, → `GUEST_CHECKED_IN_ASSISTED`) | Sesión `checked_in` con `checkedInAt` y `CheckInSession.id`. |
| `GUEST_WELCOME_MESSAGE_SENT` (sustituye a `WELCOME_MESSAGE_QUEUED`) | `reservation` | `messaging/messaging.service.ts:738` (actor `system`) | Canal y resultado del envío. NO el cuerpo del mensaje. |
| `KioskDeviceCreated`, `KioskDeviceUpdated`, `KioskPairingStarted`, `KioskPaired` | `kiosk_device` | `kiosk.service.ts:167`, `:204`, `:239` (`{ expiresAt }`; actor `user`), `:282` (`{ status, pairedAt }`; actor `system`) | Dispositivo, caducidad del emparejamiento, estado. NO el código de emparejamiento ni el token opaco del dispositivo. |
| `ASSIGNMENT_SUGGESTION_DECIDED` | `assignment_suggestion` | `pms/room-assignment.service.ts:739` (actor `user`) | La sugerencia decidida (`decidedBy` / `decidedAt`, habitación aceptada u otra). |
| `ROOM_BLOCK_CREATED`, `ROOM_BLOCK_DELETED` | `room_block` | `pms/room-assignment.service.ts:870`, `:893` (actor `user`) | El DTO del bloqueo (habitación, fechas, motivo). |
| `ROOM_CONNECTION_CREATED`, `ROOM_CONNECTION_DELETED` | `room_connection` | `pms/room-assignment.service.ts:950`, `:973` (actor `user`) | El DTO de la pareja de habitaciones comunicadas. |
| `GUEST_CONVERSATION_HANDED_OFF` (+ evento de dominio `GuestConversationHandedOff`) | `conversation` | `guest-bot.service.ts:685` (`GUEST_BOT_HANDOFF_ACTION`) | `{ reason, intent, confidence, channel, reservationId }`. NO el texto de la conversación. |
| `GUEST_ETA_UPDATED` | `reservation` | `guest-bot.service.ts:528` (`GUEST_BOT_ETA_ACTION`) | `{ eta, channel: "whatsapp" }`. |
| `PAYMENT_AUTHORIZATION_CREATED` | `payment_intent` | `checkin-payment.service.ts:333` (actor `system`) | `{ folioId, amount, currency, provider, status, providerReference, captureWindowDays, expiresAt, usedStoredToken, depositPolicy, error }`; el estado es el que devuelve el adaptador, nunca inventado. |
| `PAYMENT_TOKEN_STORED` | `payment_token` | `checkin-payment.service.ts:441` (actor `system`) | `{ provider, brand, last4, expiryMonth, expiryYear, guestId, source: "checkin_authorization" }`. NO el PAN ni `tokenRef` (cifrado en reposo por `PII_FIELDS.PaymentToken`). |
| `GUEST_REGISTER_PAYMENT_RECORDED` | `guest_register_record` | `checkin-payment.service.ts:482` (actor `system`) | `{ paymentType: "card", paymentMethodIdentifier («<marca> ****<últimos 4>»), paymentCardExpiryMonth, paymentCardExpiryYear, paymentTokenId, paymentReference (id del PaymentIntent propio) }`. |

Eventos de dominio (`event_stream`) de la tanda: `CheckInPreArrivalCompleted`, `GuestMessageSent`,
`GuestConversationHandedOff`.

### 6.3 · FIX-1 · finanzas

| Acción | Entidad | Dónde se emite | Qué guarda / qué NO guarda |
| --- | --- | --- | --- |
| `LEDGER_PII_REMASKED` (F12; ampliada a `vat_book_entries.counterparty_name` en CIERRE-1 · C2) | `ledger_import` | Herramienta fuera del repo `pilots/faranda-celuisma/sage200-real/prep/tools/remask-pii.ts` (`AUDIT_ACTION` `:33`, emisión `:286-288`), solo con `--apply --confirm`; runbook `finanzas-importacion-sage200.md` §3.2 | `afterJson = { counts.<tabla> (recuentos por tabla), tables, entries, planGeneratedAt, planFile, reason }`. NO textos, nombres ni tokens. |
| `SEPA_REMITTANCE_GENERATED` (corrector CIERRE-1 · REV-01) | `worker_job_run` (`entityId` = id de la remesa; `jobName` `treasury.sepa_remittance`) | `apps/api/src/modules/treasury/sepa-remittance.service.ts` `createRemittance`, tras `store.create` (actor `user`): `POST /treasury/sepa/remittances` (Norma 19; un Norma 34 sin procedencia de `supplier-payments` responde 403 `SUPPLIER_PAYMENT_ROUTE_REQUIRED` y no audita nada, corrector CIERRE-1 · REV-02) y `POST /treasury/sepa/supplier-payments` con `generate: true` | `{ kind, status: "generated", messageId, legalEntityId, bankAccountId, totalAmount, transactions, executionDate, billIds, sod[{ billId, creator{ rule, authorUserId, authorUnknown, privileged }, approver \| null, controllerException }] }` (`billIds`/`sod` null fuera del flujo de proveedores; `privileged` platform_admin / break_glass y la excepción controller quedan a la vista; los mismos `billIds` + `sod` van en el `payloadJson` de la remesa). NO XML, NO IBAN, NO nombres de ordenante, beneficiarios ni deudores, NO `warnings` (pueden citar un nombre). |
| `VAT_BOOKS_RECLASSIFIED` (F2) | `vat_book_entries` (`entityId` `<organizationId>:<periodo>`) | `apps/api/src/modules/accounting/vat-books-reclassify.service.ts:74`, `:323-341` (`POST /fiscal/vat-books/reclassify` con `apply: true` y filas escritas; actor `user`) | `{ periodo, includeZeroRate, candidatas, reglas[{ regla, regimen, filas, parejas?, base, cuota }], sinPareja, recibidasSinNifNoClasificadas, actualizadas }`. NO textos ni NIF. |
