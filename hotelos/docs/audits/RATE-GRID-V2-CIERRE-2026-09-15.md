# Rate Grid v2 · Cierre de la verificación adversarial — 15 de septiembre de 2026

**Para:** César. **Alcance:** parrilla de tarifas (`rate-manager`), outbox y
conectividad de canales (`channel-manager`), recomendaciones RMS
(`revenue/recommendations`) y el editor `cocoa-rate-grid` de admin-web.
**Método:** seis dimensiones de verificación independientes y adversariales
(14-15/09/2026) sobre la demo local (API :3000 dev y :3400 «producción real»,
Vite :5173, Postgres local) con Carmen (Owner de Faranda) y el admin de
plataforma, seguidas de seis lotes de corrección en paralelo y de este cierre
documental. Todo lo verificado en vivo se hizo sobre ventanas de fechas
acotadas y se restauró exactamente; las tarifas reales del piloto Los Tilos
quedan idénticas al baseline.

Este documento resume qué hay, cómo se comprobó, qué queda y —lo más
importante— qué solo puedes aportar tú para pasar de «preparado para
integrar» a «conectado». Referencia operativa: `docs/runbooks/rate-grid-v2.md`
(contrato acordado en su §6); conectividad: `docs/channel-manager-connectivity.md`.

## 1. Qué se construyó

| Pieza | Qué hace hoy | Dónde |
|---|---|---|
| Parrilla de tarifas | Una celda por (plan, tipo, día) con precio base, precio efectivo por canal (base × recargo), restricciones en capas (`"*"` / plan / canal), disponibilidad, demanda (OTB, forecast, STLY, pickup, compset, eventos) y estado de sincronización por canal. Ventana ≤ 366 días. | `apps/api/src/modules/rate-manager/rate-grid.service.ts` |
| Edición masiva y por celda | `bulk-update` en UNA transacción por propiedad: operaciones masivas (`ops`) + celdas, rematerialización de planes derivados, journal con before/after por campo, idempotencia por `clientRequestId`, concurrencia optimista (`expected`), conflictos tipados (409 `ALL_CELLS_CONFLICT`, `RATE_GRID_BUSY`, `JOURNAL_STALE`). | `rate-grid.engine.ts`, `bulk-ops.ts`, `journal.core.ts` |
| Historial y reversión | Cada guardado es un asiento; revertir crea otro asiento y no pisa cambios posteriores sin `force`. Restaura procedencia (`import`/`rms`) y overrides manuales. | `journal.service.ts` |
| Planes derivados | Hijo = padre ± %/importe con redondeo; celdas manuales respetadas; una derivación que da 0 € no se materializa y la regla se rechaza al configurarla. | `derivation.ts`, `rate-plan.service.ts` |
| Outbox de canales | Publicar = encolar `ChannelDelivery` por (canal, tipo, plan, día, kind); drenaje atómico multi-instancia (`FOR UPDATE SKIP LOCKED`), reintentos con backoff, invariante «la entrega más reciente por celda lleva el valor actual de la parrilla», estado por celda para el editor. | `modules/channel-manager/delivery.*`, `drain.*` |
| Canales y credenciales | Alta, credenciales cifradas de solo escritura, mapeo de productos a códigos externos, readiness, archivado lógico, auditoría de cambios de modo. `CHANNEL_MAX_MODE` (por defecto `sandbox`) impide que nada salga a Internet. | `channels.service.ts`, `mapping.service.ts`, `readiness.service.ts` |
| Adaptadores | Booking.com (OTA 2003B XML + token exchange), Expedia (EQC XML), Channex (REST JSON, agregador) y Airbnb/Vrbo/Hotelbeds vía Channex. Modos `stub` / `sandbox` (simulador local con validación estructural) / `real` (HTTPS). Webhook público firmado (HMAC sobre bytes originales). | `adapters/*`, `sandbox/simulator.ts` |
| Recomendaciones | RMS por día × tipo con confianza; `apply` registra decisiones y devuelve parches para la parrilla (nunca escribe tarifas por su cuenta). | `modules/revenue/rate-recommendation.service.ts` |
| Editor | Parrilla tipo hoja de cálculo (F2, multi-selección, hoja masiva, vistas Tarifas/Restricciones/Canales, capa de recomendaciones y demanda), «Guardar sin enviar a canales» vs «Revisar y publicar», historial con reversión, estado de sincronización, hub de canales y mapeos en español. | `apps/admin-web/src/components/cocoa-rate-grid/*`, `screens/revenue/*`, `screens/channelManager/*` |

Estado en la BD local al cierre documental: 62 asientos de journal (39 de Los
Tilos, 23 de `prop_123`), 718 entregas (714 `confirmed`, 1 `rejected`, 3
`superseded`; 630 de Los Tilos, todas contra canales sandbox), 65
`channel_sync_jobs`. Tras la verificación final (§6): 87 asientos (63 de Los
Tilos, 24 de `prop_123`), 778 entregas (774 `confirmed`, 1 `rejected`, 3
`superseded`; 690 de Los Tilos), 110 `channel_sync_jobs`, 38
`revenue_recommendations`. Tras el recorrido final en navegador (§6.5): Los
Tilos 69 asientos, 723 entregas (todas `confirmed`) y 8
`revenue_recommendations` (sin cambios); `prop_123` sin recontar, en uso por
las puertas de integración del integrador en ese momento. Los Tilos con
1.460 `rate_days` BAR (2026-09-14 →
2027-09-13) intactos (diff GET-before/after de tarifas vacío en cada sonda) y
4 canales sandbox (booking_com, expedia, channex activos con 4 mapeos cada
uno; airbnb «Prueba UX» inactivo, residuo de la auditoría de UX, archivado y
revivido en la verificación final con el mismo id).

## 2. Cómo se verificó

### 2.1 Seis dimensiones (94 hallazgos: 3 alta · 24 media · 67 baja)

| Dimensión | Método | Hallazgos | Destacados |
|---|---|---|---|
| Contrato del API en vivo | 11 comprobaciones contra :3400 con Carmen y el admin (Los Tilos 2026-12-01..14, solo tipo IND; restaurado por API) | 11 (1 alta, 1 media, 9 baja) | El revert restauraba el valor intermedio cuando un asiento tocaba la misma celda dos veces; el loopback público del simulador respondía 403 (había perdido su entrada del manifiesto) |
| Outbox y drenaje | Encolados, drenajes manuales y concurrentes sobre `prop_123` (2027-01-05..12) con psql y dos APIs; restauración columna a columna | 6 (1 alta, 2 media, 3 baja) | Volver a un valor ya confirmado dejaba el intermedio en cola (el canal se quedaba con 130 € y la parrilla con 97 €); el SQL crudo comparaba fechas en `Europe/Madrid` (backoff 2 h antes) |
| Especificación de adaptadores | Lectura de builders/parsers frente a la documentación de Booking, Expedia y Channex + sonda con 17 casos | 18 (1 alta, 8 media, 9 baja) | Tres `RestrictionStatus` en un mensaje (el XSD admite uno); una respuesta EQC `<Success>` con avisos se trataba como fallo; un 422 de Channex confirmaba items que Channex no había aplicado |
| Código: seguridad y concurrencia | Revisión adversarial + 90 unitarios + un GET reproducible (cursor → 500) | 18 (4 media, 14 baja) | `journalId` de otra propiedad marcado como publicado (escritura cross-tenant); revert sin control de concurrencia; carrera re-push/drenaje; derivación que publica 0 € |
| Documentación y runbook | Cruce de runbook/connectivity/CLAUDE.md con código, SQL de solo lectura y GETs en :3000 | 19 (2 media, 17 baja) | Rutas y límites no documentados; el contract test de permisos contaba una línea comentada como entrada del manifiesto |
| Experiencia en navegador | Como Carmen en :5173 a 1024×768 (Los Tilos 15-31 dic, restaurado a baseline) | 22 (7 media, 15 baja) | Tras «Guardar borrador» no se podía publicar; «Programar la publicación» era decorativo; tras revertir, la celda seguía «Confirmado» aunque el canal conservaba el precio antiguo; jerga técnica en inglés |

### 2.2 Corrección (seis lotes en paralelo) y verificación de cada lote

| Lote | Asignados | Resultado | Cómo se comprobó |
|---|---|---|---|
| `api-rate-manager` | 20 | 18 corregidos, 1 justificado (`clientRequestId` repetido con cuerpo distinto devuelve la respuesta guardada: es el contrato documentado y el editor genera un uuid por guardado), 1 solo acotado (la expansión de ops se limita a 366 días / 5.000 parches; el agrupado de escrituras queda pendiente) | 77 unitarios del módulo (antes 40); 32/32 escenarios en vivo con los servicios parcheados en proceso sobre `prop_123` (datos restaurados); integración 57/57 |
| `api-channel-manager` | 35 | 25 corregidos, 3 refutados con argumento (modo `real` por encima del tope: doble llave documentada; `hotelId` en metadata no es secreto; 422 de Channex no existe según su doc), 7 parciales con traspaso (retención, `pushStatus` ampliado, seed de Channex, front del archivado) | 753 unitarios del API (752 pass, 1 skipped; +66); sondas transaccionales con ROLLBACK; 17/17 con `app.inject`; integración 60/60; manifiesto 28/28; censo de env 127/127 |
| `api-revenue` | 1 | corregido (`roomTypeIds` ajenos → 400 `UNKNOWN_IDS`) | 4 unitarios nuevos + script de solo lectura contra la BD |
| `tests` | 2 | corregidos (parser del manifiesto; 19 casos de integración en rate-grid y 10 en outbox, antes 12 y 7) | integración 60/60; diff de datos `prop_123`/`prop_canary` = baseline |
| `docs` | 16 | corregidos | script de 45 comprobaciones docs ↔ código (hoy convertido en `tests/rate-grid-docs-contract.test.mjs`) |
| `admin-web` | 20 | 10 corregidos en el lote, 9 parciales con traspaso (programación retirada en vez de implementada, «pendiente de reenvío» solo en sesión, fan-out del API, URL propia del historial, componentes compartidos, toasts, formato de fecha nativo) y 1 traspasado íntegro (reglas BAR «sin tarifario»: `pricing.service.ts` y `RevenueRulesScreen.tsx`, fuera del lote) | typecheck OK; 59 unitarios de `cocoa-rate-grid`; recorrido completo en navegador como Carmen (1024×768) con restauración |

Puertas al cierre de los lotes: `typecheck` del API y de admin-web en verde;
contratos `corepack pnpm test` 293/293 en 48 suites al cerrar este documento
(282 antes del cierre; incluye los 11 casos del contrato documental nuevo);
integración `corepack pnpm test:integration` 60/60 (antes de la tanda: 31/31);
unitarios del API 752/753 (1 `skipped` deliberado) en el último lote que los
corrió; censo de entorno 128/128 (`CHANNEL_DELIVERY_RETENTION_DAYS` incluida)
con los ficheros generados en sincronía; discoverability OK (0 rutas rotas,
placeholders 71/80). Este cierre documental no reinició ningún servidor ni
escribió en la base de datos (solo lecturas SQL para las cifras).

Cambios en el working tree al cierre: 69 ficheros modificados o borrados y 61
nuevos (10.292 inserciones / 10.161 borrados en lo modificado), sin commit.

### 2.3 Lo que este cierre documental deja atado

- El runbook describe el contrato acordado entre lotes (§6). Al terminar el
  cierre, TODOS sus elementos están en el working tree, verificados por
  lectura de código: `CellSyncStatus` `stale` (por hash del valor entregado),
  `pushStatus` `draft|queued|pushed|partial|failed|superseded` recalculado
  desde las entregas, encolado acotado desde los parches del `bulk-update`
  (`derivePushScope`) y replay que no vuelve a encolar,
  `currentPrice`/`suggestedPrice` en `recommendations/apply` llamado después
  del `bulk-update`, `CHANNEL_DELIVERY_RETENTION_DAYS` con purga horaria de
  `superseded` en la pasada sin ámbito, `@@unique([propertyId,
  clientRequestId])` aplicado en la BD local (duplicados 0, drift 0), la
  etiqueta `413 Payload Too Large`, el seed de Channex con `RP-<plan>-<tipo>`
  (Los Tilos resembrado) y los avisos del front («Forzar reversión» en
  `JournalStaleDialog`, «Estado de sincronización no disponible», códigos en
  `RATE_GRID_ERROR_CODES`). La puesta en vigor (typecheck + contratos +
  integración + reinicio de :3000/:3400) y el recorrido en navegador de los
  comportamientos que este cierre solo pudo leer se hicieron el mismo día
  (§6).
- `tests/rate-grid-docs-contract.test.mjs` (node --test, sin BD) mantiene la
  tabla de rutas/permisos/riesgo del runbook sincronizada con los tres
  `route-permissions.partial.ts` (34 entradas hoy), los límites de §4 con las
  constantes del código, las reglas del outbox con `delivery.core` /
  `drain.core` y el contrato compartido con `rate-manager-types.ts`.
- `CLAUDE.md` §Deuda 13, `DESIGN-PROPOSAL.md` (nota de cabecera) y
  `PLAN-MAESTRO.md` (dos notas) quedan alineados: la Deuda 7 «OTAs son MOCK»
  está cerrada, pero el guardarraíl comercial —no prometer sincronización en
  vivo— sigue vigente hasta certificar Channex.

## 3. Límites conocidos (honestos)

1. **Nada está conectado a un proveedor real.** Los tres canales de Los Tilos
   son `sandbox`: el simulador local hace una validación estructural del
   payload (escáner por regex, sin XSD) y no sustituye la certificación de
   Booking, Expedia ni Channex. Diferencias conocidas y pendientes de
   comprobar en staging: base del `RecordID` de Booking (0 vs 1), forma exacta
   del objeto `warning` de Channex, tope de fechas de Expedia.
2. **Booking.com** tiene pausadas las altas de nuevos connectivity providers y
   **Expedia EQC** exige contrato de proveedor (+ PCI si hay tarjetas)
   (externo · consultado 2026-09-14; revalidar). La vía realista es
   **Channex** como agregador.
3. **Precios por canal**: no existen overrides de precio por celda y canal
   (`RateDay` no tiene dimensión canal); el precio por canal es base ×
   recargo del canal. La fila de canal del editor solo admite restricciones.
4. **Programar publicaciones** (`scheduleAt`) no está implementado; el
   control decorativo se retiró del editor.
5. **Reservas de OTA**: `pull-reservations` deja las reservas en la bandeja
   `ExternalReservation`; no crea reservas PMS (falta mapeo inverso de
   producto, huésped y folio).
6. **Servidores vivos**: los APIs :3000 y :3400 se reiniciaron el 2026-09-15
   (dos veces: tras el cierre y tras los lotes de corrección finales) y sirven
   el working tree completo, igual que el front (Vite HMR); los VPS siguen
   con el código anterior hasta el despliegue (§5).
7. **Rendimiento**: el `bulk-update` escribe celda a celda dentro de la
   transacción (acotado a 366 días / 5.000 parches); el agrupado de escrituras
   queda como refactor. El limitador por canal es por proceso.
8. **Zona horaria en SQL crudo**: el drenaje ya liga sus fechas en UTC
   explícito, pero el mismo patrón sigue sin revisar en otros 11 ficheros del
   API (lista en CLAUDE.md §13); alternativa global: `TimeZone=UTC` en
   `DATABASE_URL`.
9. **Residuos de la verificación** (deliberados, sin efecto en tarifas):
   asientos de journal marcados «auditoría»/«front-close»/«Corrección» en Los
   Tilos y `prop_123`, entregas confirmadas contra canales sandbox, el canal
   airbnb «Prueba UX» inactivo con 4 mapeos (borrable por SQL). El par de
   asientos `draft` duplicados por `clientRequestId` que dejó la auditoría
   (`prop_123` / `csc-refute-9-1789426774979`) ya se deduplicó antes de
   aplicar la migración `unique` en local; el VPS tendrá que hacer lo mismo.
   La verificación final añadió residuos del mismo tipo, declarados en §6.4.
10. **Asimetría de permisos**: `POST /channel-manager/deliveries/enqueue` exige
    `channel_manager.sync` y `POST …/rate-grid/push` exige `distribution.sync`
    (documentada, decisión pendiente).

## 4. Lo que solo tú puedes aportar (para pasar de «preparado» a «conectado»)

| # | Qué | Para qué | Cómo se usa en Anfitorio |
|---|---|---|---|
| 1 | **Cuenta staging de Channex** (`https://staging.channex.io`, alta self-service) y su **API key** (Settings → API keys, cabecera `user-api-key`) | Certificar el push ARI y el feed de reservas sin paso comercial | `POST /channel-manager/channels {providerCode:"channex", mode:"sandbox"}` + `PATCH …/credentials { apiKey, propertyId }`; nadie más puede abrir la cuenta ni ver la clave |
| 2 | **Ids de Channex** de la propiedad, de cada room type y de cada rate plan (`property_id`, `room_type_id`, `rate_plan_id`), creados por ti en Channex para Rías Altas y Los Tilos | Mapear productos: `externalRoomCode` = `room_type_id`, `externalRateCode` = `rate_plan_id` (un rate plan por tipo: el seed de demo comparte `RP-BAR` y la readiness lo marca) | `POST /channel-manager/channels/:id/product-mappings`; `channels:seed-sandbox` solo siembra códigos ficticios |
| 3 | **Extranet ids de Booking.com y Expedia** de **Rías Altas** y **Los Tilos** (hotel id de Booking, hotel id EQC) | Conectar cada OTA dentro de Channex (paso 7 del procedimiento de certificación) y, si algún día hubiera credenciales directas, el campo `hotelId` de las credenciales de los adaptadores | Sin `hotelId` los adaptadores directos rechazan el push (no se inventa ningún código) |
| 4 | **Si Faranda ya tiene channel manager** (SiteMinder, Cloudbeds, otro) y con qué OTAs | Decidir convivencia o sustitución: dos gestores empujando ARI al mismo hotel se pisan; si hay uno, Anfitorio debe empujar solo a Channex/al gestor o no empujar | Cambia el alcance del piloto y el mensaje comercial |
| 5 | **Modelo comercial de Channex**: la cifra de referencia del encargo es 130 $/mes + 7 $/hotel (no verificada en esta revisión: sin navegador; confirmar en la web de Channex antes de contratar) — quién lo paga (Anfitorio o el hotel) y para cuántos hoteles | Con esa cifra, 2 hoteles ≈ 144 $/mes; condiciona precio y contrato del piloto | Decisión de negocio, no técnica |
| 6 | **`CHANNEL_MAX_MODE=real` SOLO en producción**, y el momento de activarlo | Hoy todos los entornos (Mac, VPS dev, VPS demo) quedan en `sandbox` y nada sale a Internet; `real` en el canal Y en el entorno es la doble llave | Requiere `.env` de producción + reinicio del API; nunca en el demo público |
| 7 | **Decisiones de producto pendientes**: unificar el permiso de `enqueue` en `distribution.sync`; querer o no programar publicaciones (`scheduleAt`); querer o no overrides de precio por canal; días de retención de entregas `superseded` (30 por defecto) | Cierran deudas abiertas o las archivan | Cada una tiene su traspaso en el runbook §5/§6 |
| 8 | **Backup y ventana en el VPS** para la migración `20260915100000_rate_grid_v2_journal_unique` (ya aplicada en local con drift 0; en el VPS hay que deduplicar `(propertyId, client_request_id)` antes) y para el reinicio de los API con el working tree | Poner en vigor todos los lotes fuera del Mac | `prisma migrate deploy` + `db:drift:check` = 0 + reinicio; en local ya está hecho (:3000/:3400 reiniciados el 2026-09-15) |

Con 1 + 2 + 6 se puede hacer la ronda de certificación de Channex descrita en
`docs/channel-manager-connectivity.md` §7 (push de un rango corto → `confirmed`
→ comprobar en Channex → conectar la cuenta de pruebas de Booking → revisión de
Channex). Con 3 se conecta la OTA real desde Channex. Sin 4 y 5 no conviene
prometer nada al hotel.

## 5. Siguientes pasos del integrador (orden)

Hecho el 2026-09-15 (§6): puesta en vigor del runbook §6 (typecheck, contratos,
integración), dos reinicios de :3000/:3400, los lotes de corrección finales y
el recorrido final en navegador como Carmen que cerró los marcadores de
pantalla (§6.5). Queda:

1. **Commit** del working tree (nada se ha confirmado desde el inicio de la
   tanda; `hotelos/pnpm-lock.yaml` aparece modificado desde antes de los lotes:
   revisarlo antes de incluirlo). Antes del commit: repetir `corepack pnpm
   test:integration` (80/80 esperado; los lotes de corrección finales tocaron
   el API después de la última pasada y este cierre no la repitió porque
   escribe en la BD) y dejar que el hook pre-commit corra discoverability +
   typecheck-all (hoy 15 PASS · 1 SKIP).
2. **VPS** (dev y demo): backup → deduplicar `rate_change_journals` por
   (`propertyId`, `client_request_id`) → `prisma migrate deploy` de
   `20260915100000_rate_grid_v2_journal_unique` → `db:drift:check` = 0 →
   reinicio del API con el working tree.
3. **Channex**: cuenta staging + API key (punto 4.1); ids reales de
   propiedad, room types y rate plans en los mapeos de Los Tilos en lugar de
   `RP-BAR-<tipo>` / `CX-<tipo>` (4.2); `PATCH …/channels/:id {mode:"real"}`
   solo en el entorno con `CHANNEL_MAX_MODE=real` (4.6); publicar un rango
   corto y seguir `GET /channel-manager/deliveries`; después la ronda de
   certificación de `docs/channel-manager-connectivity.md` §7.

## 6. Verificación final tras el reinicio (15/09/2026)

Tras el cierre documental el integrador humano reinició :3000 (dev, líder de
schedulers) y :3400 (`RUN_SCHEDULERS=false`) con el working tree y se
lanzaron dos verificaciones independientes: una en navegador como Carmen
(`browser-ux-final`; Los Tilos 2027-08-01..14, 1280×800) y una sonda del API
con `curl`/`psql` como Carmen y el admin de plataforma (`api-live-final`;
Los Tilos 2027-09-01..07 y `prop_123`). Les siguieron cuatro lotes de
corrección (`fix:admin-web`, `fix:api-channel-manager`,
`fix:api-rate-manager`, `fix:docs`), un segundo reinicio de los API, este
cierre documental y un recorrido final en navegador tras ese reinicio (6.5)
que cerró los marcadores de pantalla. Todas las escrituras se hicieron sobre
ventanas acotadas y se restauraron (diff GET-before/after de tarifas = 0;
canales y mapeos iguales a los previos).

### 6.1 Puertas

| Puerta | Integrador (tras el reinicio, antes de los lotes finales) | Cierre documental final (tras los lotes finales) |
|---|---|---|
| `corepack pnpm test:integration` | 80/80 | no repetida (escribe en la BD): pendiente antes del commit (§5) |
| unitarios del API (`corepack pnpm --filter @hotelos/api test`) | 815 (814 pass · 1 skipped) | 840 (839 pass · 1 skipped; los 25 nuevos son de los lotes finales) |
| contratos (`corepack pnpm test`) | 293/293 | 293/293 en 48 suites |
| `typecheck-all` | 15 PASS · 0 FAIL · 1 SKIP (apps/guest-web) | 15 PASS · 0 FAIL · 1 SKIP; `typecheck` de `@hotelos/api` y `@hotelos/admin-web` limpios |
| censo de entorno (`env-census`) | 128/128 | 128/128, ficheros generados en sincronía |
| discoverability | OK | 190 screens · 0 broken links · placeholders 71/80 |
| migraciones | 3/3 aplicadas en local, drift 0 | sin cambios |

Cierre de marcadores (15/09/2026, tras el recorrido final de 6.5; solo
documentación y el guard del contrato documental): `corepack pnpm test` →
294/294 en 48 suites (293 + el guard nuevo).

### 6.2 Lo verificado en vivo

Integrador (y contrastado después por las dos verificaciones): publicar 1
celda encola 1 entrega `rates` por canal (antes del cierre: 4); tras
revertir, `sync-status` devuelve `stale`; `recommendations/apply` acepta
`currentPrice`/`suggestedPrice` (rechazo → `rejected: 1, recorded: 1`).

Navegador (13 recorridos, en verde salvo los hallazgos de 6.3): publicar 1
celda desde «Revisar y publicar» (drawer, toast, 3 entregas `confirmed`,
panel de sincronización, celda «Confirmado»); revertir desde el historial →
«Pendiente de reenvío» → «Enviar a canales» (6 entregas, historial
«Reversión: … · revierte la entrada …», `pushStatus: pushed`); 409
`JOURNAL_STALE` → diálogo «La parrilla cambió después de este asiento» con
Cancelar / «Forzar reversión»; conflicto de concurrencia (edición por `curl`
bajo un borrador) → «Ninguna celda se aplicó: 1 conflicto», borrador
conservado y re-basado, segundo intento publicado; recomendaciones (aceptar,
aceptar con ajuste, rechazar con motivo) → «Guardar sin enviar a canales» →
`apply` 200 con las tres filas correctas en `revenue_recommendations`; vista
Canales de solo lectura (F2 avisa, `aria-readonly`) y «Precio visto por»; hub
(readiness en español, fechas es-ES, «Efectivo: modo de pruebas (solicitado
real…)», Archivar → alta → Desactivar sin cambiar de id); Mapeos (modelos
«por día»/«por ocupación», aviso de Channex, códigos restaurados); historial
con recarga; guard de navegación con borrador y ⌘K con una sola paleta; foco
inicial en «Cancelar» de los diálogos `danger`, Esc cierra los drawers; sin
errores de consola, red 200/204, sin scroll horizontal a 1280×800.

API (12 bloques contra :3400, con :3000 drenando la misma BD): `expected`
obsoleto → 409 `ALL_CELLS_CONFLICT` sin asiento; `JOURNAL_STALE` con
`cells[].fields`, `force`, `JOURNAL_ALREADY_REVERTED`; `NO_CELLS`,
`TOO_MANY_CELLS` (5.844 > 5.000, 0 escrituras), `INACTIVE_RATE_PLANS`,
`UNKNOWN_IDS` en bulk-update, recommendations, sync-status y push;
idempotencia por `clientRequestId` (repetición → mismo `journalId`, sin
`queued`, aviso «petición repetida»; dos POST concurrentes → 1 asiento);
`pushStatus` `queued` → `pushed`; `stale` tras revertir y `confirmed` tras
reenviar el inverso; simuladores `_sandbox/*` y webhook (HMAC sobre bytes
originales, 401 neutros, 413 a 1 MiB); archivado con
`CHANNEL_HAS_PENDING_DELIVERIES`, `keptDeliveries`, revival y `PATCH mode:
real` limitado a sandbox con auditoría; readiness en español; purga de
`superseded` (`purgedSuperseded: 1`, throttle horario); 19 sondas de
validación en español; ningún secreto en ninguna respuesta.

### 6.3 Hallazgos finales y estado

Navegador (`browser-ux-final`, 14) y API (`api-live-final`, 5). «Corregido» =
en el working tree con unitarios y typecheck, servido por :5173 y por
:3000/:3400 tras el segundo reinicio; «verificado en navegador el 15/09/2026»
= visto en el recorrido final tras el segundo reinicio (6.5); «pendiente de
verificar en navegador (motivo: …)» = lo que ese recorrido no pudo cubrir.

| Id | Sev. | Hallazgo | Estado |
|---|---|---|---|
| BUX-01 | alta | «Revisar y publicar» ofrecía «0 canales» para los tipos no sincronizados en la ventana (mapeos inferidos de `cell.sync`) | corregido (`fix:admin-web`: mapeos reales por canal vía `product-mappings`, precedencia documentada); verificado en navegador el 15/09/2026 (DBM·20 ago sin entregas previas → 3 canales ofrecidos con 1 celda, «Publicar en 3 canales» habilitado) |
| BUX-02 | alta | Popover de recomendación fuera del viewport a 1280×800 | corregido (`placePopover` + `ResizeObserver`, `max-height`); verificado en navegador el 15/09/2026 en la rama «Rechazar → Otro» (botón «Rechazar recomendación» dentro del viewport a 1280×800, sin scroll); ramas «Fijar otro precio»/«Aceptar con ajuste» pendientes de verificar en navegador (motivo: solo se midió la rama pedida y el popover no se confirmó) |
| BUX-03 | media | Con recomendación `hold` «Aceptar» aplicaba −5 % | corregido (sin «Aceptar» en `hold`/`no_data`; «Fijar otro precio» + «Rechazar»); verificado en navegador el 15/09/2026 (68/68 `hold`: banner «Sin recomendaciones accionables…», «Aceptar todas» deshabilitado, popover «Sin cambio sugerido» sin «Aceptar»); deuda: no hay decisión explícita «mantener» en `apply` |
| BUX-04 | media | El drawer «Historial» no refrescaba tras publicar | corregido (`journal.refresh()` tras bulk-update/push/«Recargar»); verificado en navegador el 15/09/2026 también «tras publicar» (el asiento nuevo aparece en el drawer sin recargar la página; ídem tras cada revert y envío) |
| BUX-05 | media | Enter/Espacio no activan «Rechazar recomendación» | atribuido al driver del navegador (el mismo Enter sintético no activa ConfirmDialog); sin cambio; pendiente de verificar en navegador (motivo: exige teclado físico, fuera del alcance del driver del pane) |
| BUX-06 | media | Código de habitación externo duplicado entre tipos sin aviso | corregido (`fix:api-channel-manager`: `mapping.core.ts#productMappingWarnings`; check `product_codes` en todos los proveedores); verificado en navegador el 15/09/2026 (Expedia · IND → `EX-DBL`: «Mapeos guardados con un aviso», restaurado a `EX-IND` sin aviso) |
| BUX-07 | baja | Recuentos incoherentes toast/drawer | corregido en el front (entregas encoladas vs celdas del rango visible); verificado en navegador el 15/09/2026 en el envío manual («6/21 entregas encoladas (tarifas y disponibilidad)…», etiquetas «(recuento del rango visible)»); parcial mientras `sync-status` no filtre por `journalId`; la rama `bulk-update` + `publish` pendiente de verificar en navegador (motivo: su toast es «Guardado en Anfitorio: N celdas. Publicación en cola.» y los recuentos por asiento dependen del filtro `journalId`) |
| BUX-08 | baja | Aviso de conflicto con campos en inglés y fechas ISO | corregido en el API (`fix:api-rate-manager`: `staleReason` en español, es-ES, Europe/Madrid) y en el front (`formatDateLong` para la fecha de la celda); verificado en navegador el 15/09/2026 (aviso en español con moneda y fechas es-ES, fecha de la celda en formato largo, borrador re-basado) |
| BUX-09 | baja | El toast solapa 6 px la barra sticky | corregido (`--hotelos-toast-offset` según la altura de la barra); verificado en navegador el 15/09/2026 a 1280×800 (barra de 1 y 2 filas → `129px`/`163px`, ningún solape) |
| BUX-10 | baja | El drawer mezclaba la publicación con el `pendingPush` de otra celda | corregido (`resolveReviewDrawerMode`); verificado en navegador el 15/09/2026 (publicación con `pendingPush` previo: flujo de publicación de principio a fin, sin la cabecera ni el callout del envío pendiente) |
| BUX-11 | baja | Etiquetas de modo inconsistentes en el hub | corregido (`CHANNEL_MODE_LABELS`, mismo vocabulario que «Efectivo»); verificado en navegador el 15/09/2026 (selects de canales y alta; línea «Efectivo» provocada con Prueba UX inactivo en `real`); con un canal activo por encima de `CHANNEL_MAX_MODE` pendiente de verificar en navegador (motivo: solo se provocó con el canal inactivo) |
| BUX-12 | baja | Enum crudo del proveedor/tipo en la tarjeta legacy y en Mapeos | corregido (`providerLabel`/`channelTypeLabel`; `archived` filtrados de la lista legacy); verificado en navegador el 15/09/2026 («Airbnb · alquiler vacacional», «Expedia · OTA»; enum crudo solo en `title`) |
| BUX-13 | baja | El select de Mapeos no actualizaba `#channel=` | corregido (`lib/channel-hash.ts`); verificado en navegador el 15/09/2026 (`#channel=` al cargar y al cambiar el select) |
| BUX-14 | baja | Marcadores de navegador sin fecha ni motivo en el runbook | corregido (`fix:docs` + este cierre + cierre de marcadores tras el recorrido final de 6.5; el contrato documental impide desde entonces marcadores sin motivo) |
| ALF-1 | media | `clientRequestId` repetido SIN `publish` devuelve la respuesta almacenada sin el aviso «petición repetida» | abierto (runbook §1.3 y §5) |
| ALF-2 | baja | Un plan inactivo en `scope.ratePlanIds` de una op se reportaba como «desconocido» | corregido (`fix:api-rate-manager`: aviso «plan tarifario inactivo»; 400 `INACTIVE_RATE_PLANS` solo si todas las ops son de planes inactivos) |
| ALF-3 | baja | `GET /channel-manager/deliveries?channelId` sin `propertyId` → 404 para un usuario multipropiedad | corregido (`deliveriesScope`: el canal concedido fija la propiedad) |
| ALF-4 | baja | «se recibió nan» en parámetros numéricos coaccionados | corregido en channel-manager (`channelErrorMapEs`); abierto en `rate-grid.schemas.ts#typeNameEs` |
| ALF-5 | baja | Un webhook autenticado sobre un canal stub/sandbox importa reservas simuladas | comportamiento deliberado (la demo depende de él); documentado en el código y en runbook §1.8 |

Balance: 19 hallazgos; 16 corregidos (BUX-07 y ALF-4 parciales), 1 nota de
comportamiento (ALF-5), 1 atribuido al driver del navegador (BUX-05), 1
abierto (ALF-1). De los 13 BUX corregidos, 12 se verificaron en navegador el
15/09/2026 en el recorrido final (6.5; BUX-14 es documental); sin
regresiones.

### 6.4 Residuos declarados (sin efecto en tarifas)

Los Tilos: los asientos pasan de 39 a 63 (18 de las dos verificaciones
finales —11 `bux-*`, 7 `alf:*`, con sus reversiones—; el resto, por
diferencia, de las comprobaciones en vivo del integrador), 33 entregas
`confirmed` nuevas de las verificaciones (agosto y septiembre de 2027) con
sus `channel_sync_jobs`, 3 `revenue_recommendations` (`applied/accept`,
`applied/adjust`, `rejected`), eventos de auditoría del canal «Prueba UX»
(modo, archivado, alta, desactivación) y de los mapeos; `lastModifiedBy` de
5 celdas IND de agosto de 2027 pasa de `usr_system_pms_import` a Carmen
(inevitable con reversiones); `lastSyncAt` de los 3 canales avanza con cada
drenaje. `prop_123`: el canal temporal `vrbo`, su mapeo, sus entregas y
jobs, las reservas simuladas y el plan `ALF-TMP` se borraron por SQL (filas
creadas por la sonda). Ninguna verificación tocó `pnpm-lock.yaml`, los
servidores ni los VPS; los lotes de corrección no escribieron en la BD. Los
residuos del recorrido final en navegador se declaran en 6.5.

### 6.5 Recorrido final tras el segundo reinicio (15/09/2026)

Con :3000/:3400 reiniciados con el working tree final y :5173 (HMR), un
recorrido en navegador como Carmen (Los Tilos, ventana 2027-08-15..31,
1280×800; `prop_123` reservada a las puertas de integración del integrador,
que corrían en paralelo) ejercitó las correcciones de pantalla de los lotes
finales. Datos restaurados: diff `GET rate-grid` 15–31 ago frente al
baseline = 0 en las 68 celdas (todos los campos, metadatos incluidos),
`roomTypes`/`ratePlans` iguales, diff SQL de `rate_days` (14 columnas)
vacío, `restriction_days` 0/0, mapeos de los 3 canales iguales (salvo
`updatedAt` de Expedia · IND), canal «Prueba UX» igual al baseline
(`inactive | sandbox | {} | last_sync_at NULL | markup 0.00`), sin borrador
ni `pending-push` en `localStorage`, capas Demanda/Recomendaciones/Estado de
envío desactivadas. Evidencia en el scratchpad de la sesión (`bux-verify/`:
`baseline-*` y `after-*`).

Verificado en navegador (12 hallazgos y el estado general):

- **BUX-01** — DBM·20 ago (tipo sin entregas previas en la ventana) 125,14 →
  130 €: «Revisar y publicar» con cabecera «1 celda · 1 tipo · 1 plan · 20
  ago», Cambios «Doble Estándar matrimonio · 1 celda / BAR · BAR Flexible /
  20 ago · Precio 125,14 €→130 €», Canales «Booking.com · 1 celda»,
  «Expedia · 1 celda», «Channex · agregador · 1 celda» (chip «modo de
  pruebas», marcados y habilitados), aviso «Vas a publicar 1 celda en 3
  canales. Algunos canales están en modo de pruebas: nada llega al canal
  real.» y «Publicar en 3 canales» habilitado; `GET
  /channel-manager/channels/{booking,expedia,channex}/product-mappings` 200
  por canal al montar y al abrir el drawer.
- **BUX-08** — con el drawer abierto, `bulk-update` por `curl` (Carmen,
  :3000; DBM·20 → 126) y «Publicar en 3 canales» → drawer «No se pudo
  publicar / Ninguna celda se pudo aplicar: todas las celdas entran en
  conflicto.» y aviso «Ninguna celda se aplicó: 1 conflicto / El servidor no
  escribió nada (sin entrada en el historial). El borrador se conserva sobre
  los valores actuales del servidor (la parrilla se ha recargado)… / BAR ·
  Doble Estándar matrimonio · 20 de agosto de 2027: la celda cambió desde
  que se cargó: precio actual 126,00 € (esperado 125,14 €); última
  modificación actual 15/09/2026 09:18:32 (esperado 14/09/2026 21:59:29)».
  Español, moneda y fechas es-ES, fecha de la celda en formato largo; el
  borrador se re-basó («126 € → 130 €» al reabrir el drawer).
- **BUX-04** — tras la publicación real de DBM·20 (3 entregas `rates`
  confirmadas), sin recargar la página (`performance` navigation type
  `navigate`, misma URL), el drawer «Historial de cambios · 50 entradas ·
  hay más» mostró como primera entrada «Corrección · 1 cambio / … ✓
  publicado / Ver cambios / Revertir» y debajo el asiento del `curl`
  («guardado sin enviar a canales»); tras cada revert y envío, la entrada
  nueva al instante («Reversión: … · revierte la entrada …»).
- **BUX-07** — toasts del envío manual («Enviar a canales» de un
  `pendingPush` tras revertir): «6 entregas encoladas (tarifas y
  disponibilidad) para 1 celda en 3 canales.» y «21 entregas encoladas
  (tarifas y disponibilidad) para 2 celdas en 3 canales.» (rango completo,
  idempotente); aviso «Publicando en canales… / Booking.com: 1 celda
  pendiente · Expedia: 1 celda pendiente · Channex · agregador: 1 celda
  pendiente (recuento del rango visible)» → «Publicación procesada /
  Booking.com: 1 celda confirmada · … (recuento del rango visible)»; drawer
  «✓ 1 celda confirmada en el rango visible» por canal (después «✓ 2
  celdas…», «✓ 4 celdas…» al crecer el rango con entregas); cabecera
  «Publicación enviada 1 celda / Entrada del historial: <id>».
- **BUX-10** — con un `pendingPush` previo (DBM·20 revertido, barra «1
  celda guardada sin enviar a canales · Enviar a canales») se editó SUI·21
  ago 175,23 → 180 y se publicó: el drawer mantuvo el flujo de publicación
  de principio a fin («Revisar y publicar» · «1 celda · 1 tipo · 1 plan · 21
  ago» → «Publicación de 1 celda» · «Publicando… / Entrada del historial:
  <id> / Enviando… (1 celda pendiente)» → «Publicación enviada 1 celda / ✓ 1
  celda confirmada en el rango visible») sin el callout «Cambio
  revertido…» ni el texto del `pendingPush` de la otra celda; la barra
  siguió mostrando el `pendingPush` intacto. El flujo de envío manual sí
  muestra su callout propio en reposo («Enviar a canales / 1 celda guardada
  sin enviar · 20 ago / Cambio revertido en Anfitorio el 15 sep, 09:20…»)
  y al enviar «Envío de 1 celda guardada / Publicando… / Publicación
  enviada».
- **BUX-09** — a 1280×800: toast «Guardado en Anfitorio: 1 celda.
  Publicación en cola.» bottom 682 px frente a la barra sticky top 707,5 px
  (1 fila, 52,5 px → `--hotelos-toast-offset` 129px); toast «Cambio
  revertido en Anfitorio (1 celda restaurada)…» bottom 637 frente a barra
  top 674 (2 filas con `pendingPush`, 86,5 px → 163px); toasts «6/21
  entregas encoladas…» bottom 671 frente a barra top 707/708. Ningún
  solape; la variable vuelve a 129px al desaparecer la segunda fila.
- **BUX-03** — capa Recomendaciones (68/68 `hold` en la ventana): banner
  «Sin recomendaciones accionables en 15–31 ago / El motor sugiere mantener
  el precio en las 68 celdas del rango (confianza media 20 %)…», «Aceptar
  todas las recomendaciones visibles» deshabilitado; popover de SUI·23 ago
  «Sin cambio sugerido / Suite · BAR · 23 de agosto de 2027 · ahora 123,72 €
  / Mantener el precio actual (confianza insuficiente para sugerir un
  cambio) confianza 20 % / Por qué: … / No propone un precio nuevo: la celda
  se queda como está…» con solo «Rechazar» y «Fijar otro precio» (ni
  «Aceptar» ni «Aceptar con ajuste»).
- **BUX-02** — botón «= mantener» de SUI·23 ago en y=656 (mitad inferior)
  → popover `.crg-pop` con `max-height` 784 px (`calc(100vh − 16px)`) y
  `overflow-y: auto`, rect 262..629 → «Rechazar» → hoja «Motivo del
  rechazo» (select: Evento local no contemplado / Estrategia comercial /
  Contrato / tarifa negociada / Datos insuficientes / Otro) con «Volver» y
  «Rechazar recomendación» en y=596 → motivo «Otro» (campo «Detalle /
  Explica brevemente por qué»): popover recolocado a 160..629, botón
  «Rechazar recomendación» en (1184,596) dentro del viewport y devuelto por
  `document.elementFromPoint`, deshabilitado hasta escribir el detalle; sin
  necesidad de scroll (`scrollHeight` = `clientHeight` = 468). Cerrado con
  Escape sin rechazar (0 filas nuevas en `revenue_recommendations`).
- **BUX-06** — Mapeos → Expedia → IND «Código hab. externo» `EX-IND` →
  `EX-DBL` → «Guardar mapeos»: bloque «Mapeos guardados con un aviso / En
  Expedia cada código de habitación externo identifica un solo tipo de
  habitación: el código EX-DBL también está mapeado en DBL; la
  disponibilidad y las tarifas de ambos tipos irían a la misma habitación y
  solo se aplicaría el último valor enviado. / Cerrar avisos», toast «1
  mapeo guardado con un aviso (ver arriba).», «4/4 productos». Restaurado a
  `EX-IND` → toast «1 mapeo guardado.» sin aviso; `GET product-mappings`
  igual al baseline salvo `updatedAt` de esa fila.
- **BUX-13** — al cargar `/backoffice/channel-manager/mappings` la URL pasa
  a `#channel=<Booking.com>`; al elegir «Expedia · modo de pruebas» en el
  select «Canal», `#channel=<Expedia>`. Selects de modelo solo «por día /
  por ocupación».
- **BUX-11** — selects «Modo de Booking.com / Expedia / Channex · agregador
  / Prueba UX» y el del alta con las 3 opciones «Simulado (sin red, sin
  proveedor) / Modo de pruebas (sandbox del proveedor) / Real (producción)»;
  pills de estado con `title` «Estado: activo» / «Estado: inactivo»; línea
  «⚠ Efectivo: modo de pruebas (solicitado real; la instancia lo limita a
  modo de pruebas)» —`title` «Solicitado: real · tope de la instancia
  (CHANNEL_MAX_MODE): modo de pruebas»— provocada con Prueba UX (inactivo)
  en `real` y desaparecida al restaurar `sandbox`.
- **BUX-12** — tarjeta legacy «Prueba UX / Airbnb · alquiler vacacional /
  inactivo» (sin `text-transform`; enum crudo solo en `title` «airbnb ·
  vacation_rental»), «Expedia · OTA», «Booking.com · OTA», «Channex ·
  agregador»; ningún «AIRBNB · VACATION_RENTAL» ni «EXPEDIA» visible;
  canales archivados ausentes de la lista.
- Consola y red: `read_console_messages(onlyErrors)` en editor, historial
  (`/backoffice/revenue/rate-journal`, `h1` «Historial de cambios de
  tarifas»), hub y mapeos → único error el 409 provocado a propósito
  (`ALL_CELLS_CONFLICT`); `body.scrollWidth` = `innerWidth` = 1280 en editor,
  historial y hub.
- Restauración: reverts desde el Historial de los 3 asientos (publicación
  DBM·20, publicación SUI·21 y el `bulk-update` por `curl`) con
  ConfirmDialog «Revertir este cambio» (foco inicial en Cancelar) → toast
  «Cambio revertido en Anfitorio (1 celda restaurada). Los canales conservan
  el valor anterior hasta que lo envíes.»; `pendingPush` fusionado «2 celdas
  guardadas sin enviar a canales» enviado con «Enviar 2 celdas a 3 canales».

Pendiente de verificar en navegador (motivo por punto):

- **BUX-05** con teclado físico (fuera del alcance del driver del pane).
- **BUX-02** en las ramas «Fijar otro precio» (stepper) y «Aceptar con
  ajuste»: solo se midió la rama «Rechazar → Otro» pedida; el popover no se
  confirmó (ninguna fila `rejected` creada).
- **BUX-07** en `bulk-update` + `publish`: la frase «N entregas encoladas
  (tarifas y disponibilidad)…» solo la emite el envío manual (`pendingPush`
  → «Enviar a canales», `queuedDeliveriesSummary`); al publicar desde
  «Revisar y publicar» el toast es «Guardado en Anfitorio: 1 celda.
  Publicación en cola.» y los recuentos del drawer/aviso siguen siendo
  celdas del rango visible (deuda conocida del filtro `journalId` en
  `sync-status`: tras el segundo envío el drawer decía «✓ 2 celdas
  confirmadas…» y luego «✓ 4 celdas…» para envíos de 1 y 2 celdas).
- Línea «Efectivo…» del hub con un canal ACTIVO cuyo modo solicitado supere
  `CHANNEL_MAX_MODE` (se provocó con Prueba UX inactivo, no con un canal
  activo).

Regresiones: ninguna. Observaciones menores (no regresiones): (1) el aviso
«Cambio revertido en Anfitorio · los canales conservan el valor anterior»
cerrado con ✕ reaparece tras una publicación posterior mientras el
`pendingPush` siga vivo (la barra ya lo indica; posible doble recordatorio);
(2) la línea «Efectivo…» usa la forma corta en minúsculas («modo de
pruebas», «real») frente a la larga del select («Modo de pruebas (sandbox
del proveedor)», «Real (producción)»): mismo vocabulario, distinta forma;
(3) el segundo envío manual de un `pendingPush` de 2 celdas encoló 21
entregas (rango completo por tipo/plan, idempotente), coherente con el
runbook §2.2 pero ruidoso en el log de entregas; (4) el motivo elegido por
chip se recuerda entre publicaciones de la misma sesión (la segunda
publicación de DBM·20 no volvió a pedir motivo).

Residuos declarados (Los Tilos, sin efecto en tarifas): `rate_change_journals`
63 → 69 (+6: `cmu2cbnuo000ofymoond2nh05`, `bulk-update` por `curl` «BUX-08
conflicto concurrente», `reverted`; `cmu2ccjpe000sfymo4mutlcy1` «Corrección»
DBM·20, `reverted`; `cmu2cebki0012fymopmbhnhmz` reversión, `pushed`;
`cmu2cfusq0016fymo8ly0iaqt` «Temporada» SUI·21, `reverted`;
`cmu2cj1kb001sfymoo6b4ktng` reversión, `draft`; `cmu2cjjns001wfymorztpzb21`
reversión, `pushed`); `channel_deliveries` 690 → 723 (+33, todas
`confirmed`, en 20–21 ago × DBM/SUI: 3 + 6 + 3 + 21); `channel_sync_jobs`
+18 (110 → 128 en el recuento global del recorrido; Los Tilos tiene hoy 85);
`revenue_recommendations` 8 → 8; `audit_events` +2
(`CHANNEL_MODE_CHANGED` de Prueba UX `real` → `sandbox`); `lastSyncAt` de
los 3 canales sandbox 06:10 → 07:25 UTC; el mapa `sync` de las 4 celdas
DBM/SUI 20–21 ago pasa de «sin entregas» a `confirmed` en los 3 canales al
valor base; `updatedAt` del mapeo Expedia · IND 06:29:49 → 07:29:13. Los
metadatos `updated_by`/`updated_at` de las 2 celdas revertidas (`rate_days`
`cmu1mlits0136fyyy8thnle27` DBM·20 y `cmu1mlitu013bfyyy3e6gstxh` SUI·21) se
repusieron con 2 `UPDATE` SQL a `usr_system_pms_import` / 2026-09-14
19:59:29.106|.108 (mismo procedimiento que la sonda del API) para dejar el
diff exactamente vacío; los asientos del journal conservan el `after` real.
`prop_123` no se tocó (0 asientos de Carmen). Ninguna contraseña tecleada
(sesión de Carmen ya abierta en el pane).

Cierre de marcadores (este apartado; sin código, sin navegador, sin BD salvo
`SELECT`): runbook §1.3, §2 paso 4, §2.2, §5 y §6; este informe (§1, §5,
§6.1, §6.3, §6.4, §6.5); CLAUDE.md §Deuda 13 y la línea histórica del
reinicio en «Sistema de calidad»; y un guard nuevo en
`tests/rate-grid-docs-contract.test.mjs` que impide marcadores de navegador
sin motivo («…(motivo: …)») en el runbook y en este informe y exige
la fecha del recorrido final en el runbook §6, en este §6.5 y en CLAUDE.md
§13. `corepack pnpm test` → 294 tests · 48 suites · 294 pass · 0 fail (293
+ el guard nuevo).
