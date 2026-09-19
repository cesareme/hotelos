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
