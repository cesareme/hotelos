# Persistir el backoffice en Prisma — hallazgos + plan ejecutable

> Fase 0 · bloqueador #1. Investigado a fondo en 2026-06 (sesión equipo Anfitorio).
> NO ejecutado todavía: requiere la app corriendo para verificación round-trip por
> pantalla. Esta nota es el handoff para hacerlo limpio en una sesión dedicada.

## Objetivo
Que el setup de propiedad (edificios, plantas, zonas, espacios, habitaciones,
departamentos) introducido en la demo **sobreviva al reinicio** del contenedor.
Hoy `backoffice.service.ts` usa 203 `demoStore` / 0 Prisma → se borra al reiniciar.

## Hallazgos (verificados en código, commit ~0d8d391)

1. **Las shapes en memoria coinciden con Prisma** (buena noticia): `Building`,
   `Floor`, `PropertyZone`, `PropertySpace` existen en `schema.prisma` con campos
   idénticos a los record (`id, propertyId, name, code, description, sortOrder,
   active, createdAt, updatedAt`). `Room` es superset (tiene buildingId/floorId/
   zoneId/sortOrder). `RoomType` y `Department` también existen. → sin db push.

2. **GOTCHA crítico — fuente de verdad**: el seed de Prisma (`seed.ts`,
   `seed-commercial-demo.ts`) **NO crea** Building/Floor/Zone/Space; solo viven en
   el seed in-memory de `demoStore`. (Solo `Department` se hace upsert en
   `seed-operations.ts:65`.) → Si `getPropertyMap` pasa a leer de Prisma SIN más,
   el mapa de la propiedad sembrada aparece **vacío** = regresión visible en la demo.

3. **Blast radius (todo en `backoffice.service.ts`)** — lectores de
   `demoStore.{buildings,floors,propertyZones,propertySpaces}`:
   - `getPropertyMap` (1954) — el árbol anidado edificio→planta→zona→hab/espacio.
   - `formExistingData` (874) — switch que lista entidades por tipo (setup forms).
   - `applyPropertySetupForm` (917) — crea entidades desde formularios + lee
     defaults (líneas 959/973/974/1010-1040); llama a `createBuilding/Floor/Zone/Space`.
   - `recalculateReadiness` (1864) — check `default_building_exists` (1889).
   - enriquecido de habitaciones en `bulkUpdateRooms` (2236-2238).
   Ningún módulo EXTERNO los lee (confirmado). `prisma` NO está importado aquí.

4. **Ripple async**: `createBuilding/Floor/Zone/Space` son sync y se llaman dentro de
   `applyPropertySetupForm` (943/956/970/1032) → hacerlas async obliga a
   `applyPropertySetupForm` → `savePropertySetupForm`/`saveManualSetupOption` → async.
   Sus únicos callers son rutas async (server.ts 2684-2727) → el typecheck caza
   cualquier `await` olvidado (Promise no asignable). Ripple acotado y guardado.

5. **Habitaciones doble-almacén**: `bulkCreateRooms` (backoffice) escribe a
   `demoStore.rooms`; `createRoom` (pms.service.ts) escribe a `prisma.room`. Hay que
   reconciliar a una sola fuente (prisma.room) — tarea aparte, más delicada.

## Plan recomendado

### Opción A — Correcta (sesión dedicada, con app corriendo)
1. Añadir Building/Floor/Zone/Space al **seed de Prisma** (para que la demo sembrada
   tenga datos en Prisma) — o un `demo:reset` que los cree.
2. Importar `prisma` en backoffice.service.ts.
3. Convertir a async + Prisma: `createBuilding/Floor/Zone/Space`, `getPropertyMap`,
   `formExistingData` (casos building/floor/zone/space), `applyPropertySetupForm`
   (creates + defaults), `recalculateReadiness` (default_building_exists).
4. Reconciliar habitaciones: `bulkCreateRooms`/`bulkUpdateRooms` → `prisma.room`;
   `getPropertyMap.rooms` lee `prisma.room`.
5. Verificación **round-trip por pantalla** (app corriendo): crear edificio/planta/
   habitación → ver en el mapa → reiniciar API → siguen ahí → readiness lo refleja.

### Opción B — Band-aid rápido (menor riesgo, mantiene demoStore)
1. Importar `prisma`. `createX` = **dual-write**: `demoStore.X.push(record)` +
   `await prisma.X.create({ data: {id, propertyId, name, code, sortOrder, active, ...} })`
   (omitir createdAt/updatedAt; Prisma los pone). Hacerlas async + await en el aplicador.
2. `getPropertyMap` = **hybrid-read**: merge `demoStore.X` (sembrado) + `prisma.X`
   (creado), dedup por `id`. Así no se pierde lo sembrado y lo creado persiste.
3. Resto de lectores siguen leyendo demoStore (poblado en sesión por el push).
   Limitación conocida: tras reiniciar, esos lectores secundarios (readiness, defaults)
   reseedan; solo `getPropertyMap` muestra lo persistido. Aceptable para demo.

## Verificación obligatoria (cualquier opción)
- `pnpm --filter @hotelos/api typecheck` PASS (caza el ripple async).
- Round-trip en VPS: `POST` crear edificio → `GET /backoffice/properties/:id/map`
  lo muestra → `tmux kill` + relanzar API → `GET` map **sigue mostrándolo**.
