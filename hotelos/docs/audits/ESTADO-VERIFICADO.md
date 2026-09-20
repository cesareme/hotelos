Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-19,
worktree `tanda-chk` sobre f77820d, BD `hotelos_chk`; pendiente de fusión a main):
- diseño `docs/design/CHECKIN-AUTOMATIZADO-IA.md` implementado en 4 olas (W1 modelo,
  MRZ, motor y seed · W2 sesión, captura, firma, asignación y plantillas · W3 llegada,
  rutas, jobs y cola · W4 front de recepción, portal, kiosco y bot); apéndice «Estado
  tras la implementación» con los deltas; runbook `docs/runbooks/checkin-automatizado.md`;
  contrato `docs/api-contracts.md` «Check-in automatizado (Tanda CHK)»
- migraciones `20260920150000_checkin_automatizado` (9 tablas: `checkin_sessions`, `checkin_guests`,
  `document_captures`, `signatures`, `assignment_suggestions`, `kiosk_devices`,
  `property_checkin_policies`, `room_blocks`, `room_connections`; 14 índices + 3 únicos, 1 FK en
  cascada, 0 enums, reversible) y `20260920160000_checkin_pago_en_recepcion` (corrector REV3-02:
  columna `allow_pay_at_reception`); `migrate status` 21/21 en el carril · `db:drift:check` «No
  difference detected.»; sin `MobileKey`, `RoomFeatureAssignment` ni el índice único de partes
  (deuda 17)
- API: 32 rutas en `modules/checkin/route-permissions.partial.ts` (15 de huésped con
  token opaco por `x-guest-token` —`?token=` solo en GET—, 17 de personal con claves existentes;
  el corrector añadió `PATCH /reservations/:id/check-in/guests/:guestId` y
  `POST /reservations/:id/check-in/resolve-handoff`) + 10 en
  `modules/pms/room-assignment-route-permissions.partial.ts` + `GET/POST /webhooks/whatsapp`;
  sin claves RBAC nuevas (`rbac:sync --dry-run` limpio); contexto de servicio
  `service-context.ts` (`guest:`/`kiosk:`/`system:checkin:`) sin claves de dinero ni de
  override; parser MRZ ICAO 9303 puro (`packages/compliance/src/spain/mrz.ts`, TD1/TD2/TD3,
  `buildMrz` para fixtures); motor de asignación puro (`room-assignment.engine.ts`,
  `rulesVersion chk-rules-1`, pesos por propiedad en `PropertyCheckInPolicy.assignmentWeightsJson`);
  captura con MRZ + visión opcional (imagen nunca persistida, `ID_IMAGE_DISCARDED`, purga
  a 30 días); firma con evidencias y PDF del parte (`signatureObjectKey` = id de
  `signatures`; almacén provisional `data:` URI); `completeCheckIn` único cierre (guest,
  kiosk y recepción) con precondiciones deterministas y 409 tipados; OTP con hash y TTL;
  kiosco con emparejamiento por código de 8 dígitos y adaptadores `none`/`sandbox`
  fail-closed; jobs in-process del líder (`checkin-jobs.ts`: invitación J-3, recordatorio
  J-1, lote de sugerencias a `CHECKIN_ASSIGNMENT_RUN_AT`, purga; `worker_job_runs`
  `checkin.assignment`); bot del huésped web + WhatsApp con aviso de IA, lecturas por
  reglas o modelo y escrituras SIEMPRE `AiToolCall awaiting_confirmation` confirmadas en
  `POST /ai/tool-calls/:id/confirm` (recepción *medium*; *high* exige `ai.high_risk.confirm`);
  `executeConfirmation` tolera `SES_DISABLED` / `GUEST_REGISTER_INVALID` /
  `SES_SUBMISSION_IN_FLIGHT` como avisos; 4 plantillas de sistema `checkin_*`;
  `matchGuestToReservation` acotada a organización y propiedad
- front: Mi día con columnas Pre-check-in / Habitación sugerida / Llave y KPI
  `preCheckInCompleted`, cola con 8 `kind` nuevos y acción `confirm_assignment`, cajón
  de check-in con escaneo/MRZ/top-3/pad/cotejo/`/complete`, `ArrivalPreCheckInDrawer`,
  pestaña `/hoy/check-in-automatizado` (`CheckInAutomationSettingsScreen`: política, pesos,
  kioscos, métricas §1.8; roles recepcion·direccion·admin·auditoria), `SignaturePad`;
  portal guest-web con asistente de 6 pasos (`/checkin?token=`), cámara, firma, llegada y
  chat; modo kiosco `?kiosk=1&device=` (90 s de inactividad, sin `localStorage`)
- seed `db:seed:checkin` (tenant aislado `org_chk`/`prop_chk`, usuarios `*@chk.test`,
  contraseña `chk-demo`/`SEED_CHK_PASSWORD`, allowlist de `demo-guard.ts` ampliada);
  Faranda solo lectura en toda la tanda
- corrector (2026-09-20, revisión 3 · 16 hallazgos confirmados + 11 low): RoomBlock como filtro duro
  (`validateRoomUnderLock` → 409 `ROOM_BLOCKED`; `completeCheckIn` reasigna la asignada bloqueada);
  `at_reception` sin PSP solo satisface el depósito con `allowPayAtReception` (si no, 409 `BALANCE_DUE`
  + `handed_off payment_failed`); el cajón comprueba `/complete { dryRun }` ANTES de asignar y cobrar,
  dice el importe ya cobrado si el check-in falla después y recuerda el intento entre aperturas
  (`sessionStorage`); recepción cierra sesiones que el huésped no cerró (partes desde los viajeros
  completos en `/complete` y en la firma del mostrador; `PATCH …/guests/:guestId`;
  `POST …/resolve-handoff`); «Pegar MRZ» con el cotejo de nombre de §4d; menores < 14 sin documento
  ni móvil propios (validador, parte y XML SES); `documentNumberLast3` real; `consentJson.otp` no se
  pisa; `handed_off` fuera del KPI «Pre-check-in hecho»; bot web con `{ text }` y widget de chat en
  estancia y asistente; «Volver a leer el documento» en el paso 2; token y OTP nunca persistidos en
  `notification_deliveries` (redacción + `GET /notifications/deliveries` sin cuerpo salvo
  `notifications.manage`; filas de org_chk limpiadas); `PII_FIELDS.Signature` (trazo y PDF cifrados;
  filas de org_chk re-cifradas); supresión RGPD sobre `checkin_guests` / `document_captures` /
  `signatures` / `checkin_sessions`; `whatsappPhoneId` único entre propiedades (409) y webhook sin
  firma solo con `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=1` fuera de producción; CORS con `x-guest-token` /
  `x-kiosk-token`, `?token=` solo en GET y logger que redacta `token=`; firma idempotente (200);
  métrica de llaves solo con pase firmado; QR SVG y validez en hora del hotel; alfa-3 y `paymentType`
  en el parte; claim del kiosco con el gate antes de consumir el código; contrato `code` del
  emparejamiento; runbook §12 con el comando de integración correcto; `test:integration` con
  `--env-file-if-exists`; walkthrough del seed solo contra BD `*_chk` (o `CHK_WALKTHROUGH=1`);
  `schema.prisma.orig` eliminado; bloque de estado movido aquí (CLAUDE.md = main + deltas CHK)
- cifras de la puerta completa del corrector (2026-09-20, `scratchpad/CHK/gates-corrector-full.json`):
  10/14 puertas: typecheck:all 15 PASS · 0 FAIL · 1 SKIP (apps/guest-web) · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119/119 · worker 34/34 · admin-web unit 1.901 (1.872 pass · 28 fail: recuentos del árbol de navegación compartido con T9, idénticos a la línea base) · contratos raíz 617 (613 pass · 2 fail: `SCREEN_COMPONENTS` / `GoodsReceiptsScreen` de T9, idénticos a la línea base) · discoverability 197 URL (rojo por los 4 enlaces de T9, como antes) · nav-tree al día (70 · 104 · 205) · route-access 15 × 197 · cocoa waves §6 al día · rbac dry-run OK · migrate status 21/21 + drift «No difference detected.» · admin-web build OK · integración 881 (872 pass · 1 fail · 8 skips: en la puerta el único fallo fue el escenario nuevo SEC-4 del corrector, cuyo PATCH real pasa por backoffice.service.ts#patchAiSettings y no por el guardia recién añadido; guardia compartido `assertWhatsappPhoneIdFree` en ambos escritores y reejecución completa de tests/integration: 881 · 873 pass · 0 fail · 8 skips, `scratchpad/CHK/corrector-integration-2.log`)
- pendientes con dueño (runbook §13; informe de la tanda): `node scripts/env-census.mjs --write` y
  `node scripts/cocoa-22-waves.mjs --write` en la fusión (el corrector ya regeneró el censo con
  `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED`); renumerar las migraciones si otro carril aporta una marca
  posterior; `pnpm-lock.yaml` NO se commitea desde el carril (`git checkout -- pnpm-lock.yaml` en la
  fusión); plantillas *utility* de WhatsApp, PSP con `authorize`, certificado SES, hardware de llaves
  y EIPD (solo César, diseño §10.2 y §11.1)
