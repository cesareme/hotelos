# Runbook · `rbac:sync` (catálogo de permisos, plantillas de rol y `--prune`)

Fuente: `apps/api/src/lib/rbac-catalog.ts` (lógica) y
`apps/api/src/scripts/rbac-sync.ts` (CLI). Tanda 1 lo creó; Tanda 4 añade
`Role.templateKey` y el top-up aditivo de los roles plantilla; Tanda 5 (L1a
rbac + L1b api-side) amplía las plantillas al árbol de navegación, añade
`sales`/`fnb`, las claves de lectura `folio.read` / `pos.read` /
`tourist_tax.read`, el CLI `reseed-property-roles` (§7) y las 10 plantillas
por organización en `createTenant`.

## 1. Qué hace y cuándo corre

| Paso | Qué hace | Cuándo |
| --- | --- | --- |
| `syncPermissionCatalog` | La tabla `permissions` converge a `PERMISSIONS` (`packages/shared/src/permissions.ts`): crea las claves que faltan, refresca descripciones. Las claves que están en BD pero no en el catálogo se reportan como **stale** y **nunca** se borran salvo `--prune`. | En cada arranque del API (`server.ts`, fail-closed: si falla, el API no arranca) y con el CLI. |
| `backfillTemplateRoles` | Ver §2. | Igual. |

Ninguno de los dos pasos quita permisos a nadie salvo `--prune`. Los dos son
idempotentes: la segunda ejecución reporta `+0`.

CLI (desde cualquier sitio del monorepo, `DATABASE_URL` en `.env`):

```bash
corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run   # solo informe, sin escrituras
corepack pnpm --filter @hotelos/api rbac:sync                # sync + backfill
corepack pnpm --filter @hotelos/api rbac:sync -- --json      # salida máquina
corepack pnpm --filter @hotelos/api rbac:sync -- --prune     # DESTRUCTIVO, ver §3
```

Códigos de salida: `0` ok · `1` fallo (BD inaccesible, invariante de plantilla
roto) · `2` flag desconocido. Flags reconocidos por `parseFlags`: `--prune`,
`--dry-run`, `--json` (cualquier otro → exit 2).

### Estado actual (BD demo, 2026-09-15 · Tanda 5 · L1b api-side)

- Catálogo (2026-09-16, Tanda 6 · Finanzas): **221 claves** (220 org + 1
  plataforma) — Tanda 6 añadió `accounting.reports.read` (lectura de libros e
  informes con importes; `accounting.read` queda como clave de calendario) y las
  plantillas `accountant` (+`banking.reconcile`, `payroll.manage`,
  `procurement.read/manage`, `assets.read/manage`, `analytics.export`,
  `accounting.reports.read`), `manager` y `compliance` (+`accounting.reports.read`)
  crecieron; `--dry-run` en la BD demo: 8 roles por completar hasta ejecutar el
  sync (Faranda Owner +1, Dirección +1, Contabilidad +6, Cumplimiento +1; org_123
  ídem; Local Super Admin +1) — ver `docs/runbooks/finanzas-contabilidad.md` §14.
  Estado anterior (Tanda 5): 215 claves (214 org + 1 plataforma). El `--prune` de §3 **ya se
  ejecutó** en Tanda 4 (216 → 212); Tanda 5 (L1b) añadió **3 claves de
  lectura** — `folio.read`, `pos.read`, `tourist_tax.read` — para los GET que
  hasta L1a estaban gateados por claves de escritura (`folio.charge.post`,
  `compliance.ses.submit`, `compliance.configure`): folios y balances,
  enrutamiento, TPV (salas, comandas, cierre de caja), tasa turística,
  envíos VeriFactu / TicketBAI / IGIC (`billing.compliance.view`) y registro
  de viajeros / SES / bandeja de cumplimiento (`guest_register.read`). Ningún
  GET del manifiesto exige ya `folio.charge.post` ni `compliance.ses.submit`
  (`tests/rbac-nav-contract.test.mjs` y
  `apps/api/src/security/__tests__/route-read-keys.test.mts` lo fijan).
- **11 plantillas** (`ROLE_TEMPLATE_KEYS`): owner, admin, manager,
  receptionist, housekeeper, maintenance, accountant, compliance, revenue,
  sales, fnb. **10 se materializan por organización**
  (`ORGANIZATION_TEMPLATE_ROLE_KEYS`: todas menos `admin`, que §3 del árbol
  reserva al administrador de plataforma) con nombre en español
  (`ROLE_TEMPLATE_LABELS_ES`: Propietario, Dirección, Recepción, Pisos,
  Mantenimiento, Contabilidad, Cumplimiento, Revenue, Comercial, Punto de
  venta). `createTenant` las provisiona en tenants nuevos
  (`DEFAULT_TENANT_ROLE_TEMPLATES` = esa lista; el «Owner» que crea antes se
  reconoce por `template_key`, no se duplica como «Propietario») y
  `reseed-property-roles` (§7) las materializa en organizaciones existentes.
- La BD demo tiene **21 roles**: Faranda (`cmrhw9jy30002fyvb6tsdiugt`) →
  Owner (owner) + Dirección, Recepción, Pisos, Mantenimiento, Contabilidad,
  Cumplimiento, Revenue, Comercial, Punto de venta (creados por el reseed de
  L1a); org_123 → Local Super Admin (plataforma, `template_key` `NULL`, 215
  grants) + Propietario + las mismas 9. Usuario de prueba
  `recepcion.tilos@faranda.test` (Recepción en Los Tilos, 27 claves).
- Comando de verificación (sin escrituras) y salida esperada **hoy** (literal,
  ejecutada el 2026-09-15 tras aplicar el sync de L1b; solo varía el tiempo
  en ms):

  ```bash
  corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run
  # [rbac] template roles: 20 following a template (0 topped up [dry-run]), 0 template_key stamped by name, 0 custom (untouched), 0 EMPTY without template
  # [rbac] platform roles topped up: 0 of 1 platform role(s) [dry-run] (Local Super Admin (org_123) ← full catalog: +0)
  # [rbac:sync] DRY-RUN (no writes) · 75 ms
  #   catalog: 215 keys (214 org + 1 platform)
  #   permissions: +0 created · 0 descriptions updated · 0 stale
  #   template roles: 20 following a template · 0 topped up · 0 template_key stamped by name · 0 custom (untouched) · 0 EMPTY without template
  #   platform roles: 1 (0 topped up)
  #     Local Super Admin (org_123) ← full catalog: +0
  #   templates: owner=214 admin=214 manager=99 receptionist=27 housekeeper=4 maintenance=3 accountant=19 compliance=28 revenue=34 sales=31 fnb=14
  ```

  Cualquier `stale > 0`, `created > 0` o `stamped > 0` significa que la BD y el
  código han divergido desde este cierre: leer §2/§3/§4 antes de escribir.
  `following a template` sube en 1 por cada rol plantilla que se cree (un
  tenant nuevo añade 10). Lo que hizo L1b el 2026-09-15 (registro): dry-run
  `+3 created · 12 topped up` (Dirección +3, Recepción +4, Contabilidad +3,
  Cumplimiento +4, Punto de venta +1 en las dos orgs; Propietario +3; Local
  Super Admin +3) → `rbac:sync` aplicado → segundo dry-run `+0`.

## 2. `Role.templateKey` y el backfill de roles

`roles.template_key` (nullable) dice de qué plantilla compartida
(`ROLE_PERMISSION_MAP`: `owner`, `admin`, `manager`, `receptionist`,
`housekeeper`, `maintenance`, `accountant`, `compliance`, `revenue`, `sales`,
`fnb`) nace un rol. `NULL` = rol custom (o rol de plataforma).

En cada arranque, `backfillTemplateRoles`:

1. **Roles con `template_key`** → `applyRoleTemplate` SIEMPRE (aditivo,
   idempotente, `+0` cuando converge). Así, cuando una tanda añade una clave
   a `PERMISSIONS`, los Owner existentes (Faranda incluida) la reciben en el
   siguiente arranque en vez de responder 403.
2. **Roles sin `template_key` cuyo nombre casa con una plantilla**
   (`resolveTemplateKeyForRoleName`: alias en español, sin acentos ni
   mayúsculas — «Propietaria», «Dirección», «Jefe de Recepción», «Gobernanta»…)
   y que no tienen ninguna clave fuera de esa plantilla → se **adoptan**: se
   sella `template_key` y se hace el top-up. Fue el caso del «Owner» de
   Faranda (y de los Owner de las orgs AUDIT, ya borradas), creados antes de
   que existiera la columna.
3. **Roles con permisos que no casan con ninguna plantilla, o con claves
   fuera de la plantilla que sugiere su nombre** → custom: **nunca se tocan**.
4. **Roles vacíos sin plantilla** → se listan como `EMPTY without template`.
   Un usuario asignado a uno de ellos recibe 403 en todo en producción; por
   eso `ensureRoleHasPermissions` bloquea la invitación con 409
   `ROLE_WITHOUT_PERMISSIONS` hasta que el rol tenga plantilla.
5. **Roles de plataforma** (detección conservadora: ya tienen una clave
   `admin.*`/`platform.*`, o se llaman «Local Super Admin»/«Super Admin»/… y
   viven en una org que ya posee un rol de plataforma) → catálogo completo,
   `template_key` se queda `NULL`.

Verificación (BD demo, 2026-09-15 tras L1b: 21 filas, 20 con plantilla; el
tamaño de cada rol plantilla coincide con la línea `templates:` del dry-run
de §1):

```sql
SELECT r.organization_id, r.name, r.template_key, count(rp.*) AS grants
FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
GROUP BY 1, 2, 3 ORDER BY 1, 2;
-- Faranda (cmrhw9jy30002fyvb6tsdiugt): Owner owner 214 · Dirección manager 99 ·
--   Recepción receptionist 27 · Pisos housekeeper 4 · Mantenimiento maintenance 3 ·
--   Contabilidad accountant 19 · Cumplimiento compliance 28 · Revenue revenue 34 ·
--   Comercial sales 31 · Punto de venta fnb 14
-- org_123: Local Super Admin (NULL) 215 · Propietario owner 214 · y las mismas 9
```

Log de arranque esperado hoy (ya estampado y podado; `stamped by name` solo
vuelve a ser > 0 si aparece un rol nuevo sin `template_key` cuyo nombre case
con un alias):

```
[rbac] permission catalog synced: created=0 updated=0 stale=0
[rbac] template roles: 20 following a template (0 topped up), 0 template_key stamped by name, 0 custom (untouched), 0 EMPTY without template
[rbac] platform roles topped up: 0 of 1 platform role(s) (Local Super Admin (org_123) ← full catalog: +0)
```

## 3. `--prune`: procedimiento obligatorio

> Estado: **ejecutado el 2026-09-14** en la BD demo (216 → 212 claves, 4
> `role_permissions` de «Local Super Admin» eliminadas). Hoy `--dry-run
> --prune` reporta `0 stale` y no borraría nada. El procedimiento queda como
> referencia para la próxima vez que una clave salga del catálogo.

`--prune` borra las filas de `permissions` que no están en el catálogo **y
todas las `role_permissions` que apuntan a ellas** (no hay FK entre las
tablas RBAC: si no se borraran, quedarían huérfanas). Es la única operación
destructiva de este runbook y **nunca** va en `deploy/scripts/deploy.sh` ni en
CI.

> Advertencia · el seed recreaba las claves stale. Hasta Tanda 4,
> `packages/database/prisma/seed.ts` (lista `DEMO_PERMISSIONS`) sembraba las
> 4 claves `pms.reservation.update / .cancel / .check_in / .check_out` y las
> concedía al rol «Local Super Admin», de modo que cualquier re-seed deshacía
> un `--prune` anterior. El lote *dataset-seeds* de Tanda 4 las retiró del
> seed (aplicado antes del prune). Regla general: **nunca `--prune` mientras
> un seed o fixture siga creando la clave** o el siguiente seed la recreará.

Orden obligatorio:

1. **Quitar las claves del seed** (`DEMO_PERMISSIONS` en
   `packages/database/prisma/seed.ts`) y comprobar que ningún código las
   referencia: `grep -rn "pms.reservation.update" apps packages` debe devolver
   0 resultados fuera de tests/documentación.
2. **Dry-run** y leer el informe:

   ```bash
   corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run --prune
   ```

   Lo que reportó el 2026-09-14 antes del prune: `4 stale` · `grants on stale
   keys: 4 role_permissions row(s) on 1 role(s)` · `--prune WOULD delete 4
   key(s) and 4 role_permissions row(s)`. Hoy reporta `0 stale`. Si el número
   de grants o de roles no es el esperado, **parar** y revisar qué rol depende
   de esas claves.
3. **Backup** de la BD (en el VPS, `pg_dump -Fc "$DATABASE_URL" >
   backups/hotelos-pre-prune-$(date +%F).dump`; en el Mac, `pg_dump -Fc
   hotelos > ...`).
4. **Prune**:

   ```bash
   corepack pnpm --filter @hotelos/api rbac:sync -- --prune
   ```

5. **Verificar**:

   ```sql
   SELECT count(*) FROM permissions;                       -- = nº de claves de PERMISSIONS (215 desde L1b, 2026-09-15; 212 tras el prune del 2026-09-14)
   SELECT count(*) FROM role_permissions rp
     LEFT JOIN permissions p ON p.id = rp.permission_id
   WHERE p.id IS NULL;                                     -- = 0 (sin huérfanas)
   SELECT count(*) FROM role_permissions
   WHERE role_id = 'role_local_super_admin';               -- = 215 (214 org + 1 plataforma)
   ```

   y un segundo `rbac:sync -- --dry-run` debe reportar `0 stale`.

Si algo no cuadra: restaurar el backup (`pg_restore -d hotelos --clean
--if-exists <dump>`) y abrir incidencia; no reintentar `--prune` a ciegas.

## 4. Cuando aparece una permission nueva en el catálogo

Flujo normal de una tanda que añade una clave (`PERMISSIONS` en
`packages/shared/src/permissions.ts`); no hace falta `--prune` ni SQL manual:

1. Añadir la clave a `PERMISSIONS` **y** a las plantillas de
   `ROLE_PERMISSION_MAP` que deban tenerla (`owner`/`admin` reciben todo lo
   org; `manager`, `receptionist`… solo lo que corresponda). Las claves
   `admin.*`/`platform.*` nunca entran en una plantilla
   (`assertTemplatesExcludePlatformKeys` aborta el sync si ocurre).
2. `corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run`: esperado
   `permissions: +1 created` y `template roles: N topped up` (uno por rol cuya
   plantilla incluye la clave); los roles custom (`template_key` NULL) salen
   como `custom (untouched)` y **no** la reciben.
3. Aplicar: reiniciar el API (el boot ejecuta los dos pasos, fail-closed) o
   `corepack pnpm --filter @hotelos/api rbac:sync`. `deploy/scripts/deploy.sh`
   solo imprime el informe `--dry-run` en su paso `rbac`; la escritura la hace
   el arranque del paso `restart`.
4. Verificar: `SELECT count(*) FROM permissions` = nuevo total (213, 214…) y
   un segundo `--dry-run` con `+0 created · 0 topped up`. Actualizar la cifra
   «215» en este runbook (§1, §3 paso 5) y en `deploy/README-INSTALL.md` (§8;
   hoy dice 212, pendiente). El `catalogKeys: 212` de
   `apps/api/src/lib/__tests__/rbac-catalog.test.mts` es un fixture del
   informe humano, no la cifra real: no hace falta tocarlo.
5. Roles custom que deban tener la clave: concederla desde el editor de roles
   (`roles.manage`) o sellar `template_key` como en §5; nunca por `UPDATE`
   masivo en `role_permissions`.

Si en vez de aparecer una clave **desaparece** del catálogo: el sync la
reporta como `stale` y la conserva; retirarla es el procedimiento de §3.

## 5. Reparaciones puntuales

- **Un rol plantilla no recibe claves nuevas**: comprobar
  `SELECT template_key FROM roles WHERE id = '…'`. Si es `NULL` y el nombre no
  casa con ningún alias, sellarlo a mano (`UPDATE roles SET template_key =
  'manager' WHERE id = '…'`) y reiniciar el API o correr `rbac:sync`: el
  top-up es aditivo.
- **Rol vacío custom** («Equipo noche» con 0 permisos): la invitación devuelve
  409 `ROLE_WITHOUT_PERMISSIONS`. Opciones: sellar `template_key` como arriba,
  o crear el rol desde plantilla con `POST
  /backoffice/properties/:propertyId/roles {name, templateKey}` (permiso
  `roles.manage`) y usar ese.
- **`template_key` con un valor desconocido** (typo manual): el arranque lo
  avisa (`carries unknown template_key`) y salta el rol sin abortar; corregir
  la fila o ponerla a `NULL`.
- **Una organización sin las 10 plantillas** (Dirección, Recepción, Pisos,
  Mantenimiento, Contabilidad, Cumplimiento, Revenue, Comercial, Punto de
  venta + Propietario/Owner): `createTenant` las provisiona desde Tanda 5
  (`provisionDefaultTemplateRoles`, idempotente: top-up por `template_key`,
  adopción por nombre español, creación; un nombre ya usado por un rol de otra
  plantilla se reporta como `conflict` y no se toca); para organizaciones
  existentes usar el CLI de §7.

## 6. Qué NO hace este runbook

- No cambia el contenido de las plantillas: los deltas de Tanda 5 (§10 del
  árbol de navegación: `manager` 85 → 99 claves, `receptionist` 18 → 27,
  nuevas `sales`/`fnb`, claves de lectura de L1b) ya están aplicados en
  `packages/shared/src/permissions.ts`; cualquier ampliación futura se
  propaga sola con el top-up de §2 en el siguiente arranque o `rbac:sync`.
  Retirar una clave de una plantilla NO la retira de los roles (todo es
  aditivo): hacerlo exige `--prune` (§3) o edición manual del rol.
- No borra usuarios ni roles: eso pertenece al refresco del dataset
  (DATA-06/09).

## 7. `reseed-property-roles`: las 10 plantillas en una organización existente

Fuente: `apps/api/src/scripts/reseed-property-roles.ts` (Tanda 5 · L1a rbac;
unitarios en `src/scripts/__tests__/reseed-property-roles.test.mts`). Para
UNA organización, materializa un rol por plantilla de
`ORGANIZATION_TEMPLATE_ROLE_KEYS` y lo sube a su plantilla: `top-up` (rol con
`template_key`), `adopt` (sin `template_key`, nombre que resuelve por alias y
sin claves ajenas → se sella), `create` (nombre de `ROLE_TEMPLATE_LABELS_ES`,
auditoría `ROLE_CREATED_FROM_TEMPLATE`) o `conflict` (un rol con ese nombre es
custom o sigue otra plantilla: se reporta, no se toca y bloquea `--apply`).
Nunca borra grants ni roles, nunca crea ni asigna usuarios; los roles de
plataforma se saltan. No hace falta reiniciar el API (roles y grants se leen
de Postgres por petición).

```bash
cd apps/api
node --env-file-if-exists=../../.env --import tsx src/scripts/reseed-property-roles.ts --org <organizationId>            # dry-run (por defecto)
node --env-file-if-exists=../../.env --import tsx src/scripts/reseed-property-roles.ts --org <organizationId> --apply --confirm <organizationId>
#   --templates owner,manager,...   subconjunto de ORGANIZATION_TEMPLATE_ROLE_KEYS
#   --json                          salida máquina
```

Códigos de salida: `0` ok · `1` fallo (org inexistente, conflictos,
post-condición, BD) · `2` flag desconocido. Procedimiento: dry-run → leer el
plan (una línea por plantilla con acción, rol y `+n` claves; informe por
propiedad de `user_property_roles` afectados) → `--apply --confirm` → segundo
dry-run con todo `top-up +0`. Ejecutado en local el 2026-09-15 (L1a) para
Faranda y org_123: 9 y 10 roles creados; segunda pasada `+0`.
