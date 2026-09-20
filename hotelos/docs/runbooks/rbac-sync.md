# Runbook · `rbac:sync` (catálogo de permisos, plantillas de rol y `--prune`)

Fuente: `apps/api/src/lib/rbac-catalog.ts` (lógica) y
`apps/api/src/scripts/rbac-sync.ts` (CLI). Tanda 1 lo creó; Tanda 4 añade
`Role.templateKey` y el top-up aditivo de los roles plantilla; Tanda 5 (L1a
rbac + L1b api-side) amplía las plantillas al árbol de navegación, añade
`sales`/`fnb`, las claves de lectura `folio.read` / `pos.read` /
`tourist_tax.read`, el CLI `reseed-property-roles` (§7) y las plantillas por
organización en `createTenant`; **Tanda 8a** (L0 catálogo y plantillas
versión 2, L3 scripts; diseño
[`docs/design/RBAC-DEPARTAMENTOS.md`](../design/RBAC-DEPARTAMENTOS.md) §6.5)
añade la **versión de plantilla** (`Role.templateVersion`, `Role.managed`,
`ROLE_TEMPLATE_VERSION = 2`, `ROLE_TEMPLATE_REVOCATIONS`), el flag
`rbac:sync --upgrade-templates` (la única operación que **revoca** claves de
un rol), el CLI `rbac:migrate-assignments` (§8) y las 24 plantillas (22 por
organización). El uso operativo del RBAC (alta de personas, umbrales,
separación de funciones, break glass) está en
[`accesos-por-departamento.md`](./accesos-por-departamento.md).

## 1. Qué hace y cuándo corre

| Paso | Qué hace | Cuándo |
| --- | --- | --- |
| `syncPermissionCatalog` | La tabla `permissions` converge a `PERMISSIONS` (`packages/shared/src/permissions.ts`): crea las claves que faltan, refresca descripciones. Las claves que están en BD pero no en el catálogo se reportan como **stale** y **nunca** se borran salvo `--prune`. | En cada arranque del API (`server.ts`, fail-closed: si falla, el API no arranca) y con el CLI. |
| `backfillTemplateRoles` | Ver §2: top-up **aditivo** de los roles con `template_key`, adopción por nombre, detección de roles de plataforma, e **informe** de los roles gestionados que van por detrás de `ROLE_TEMPLATE_VERSION` (qué claves les retiraría un upgrade: `revocationsByRole`). Nunca revoca. | Igual. |
| `upgradeRoleTemplate` (por rol) | Solo con `rbac:sync --upgrade-templates` (L3). Ver §2. | Manual, tras `--dry-run` y copia. |

Ninguno de los pasos de arranque quita permisos a nadie; solo `--prune` (§3)
y `--upgrade-templates` (§2) escriben bajas, y los dos son manuales. Todos son
idempotentes: la segunda ejecución reporta `+0`.

CLI (desde cualquier sitio del monorepo, `DATABASE_URL` en `.env`):

```bash
corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run              # solo informe, sin escrituras
corepack pnpm --filter @hotelos/api rbac:sync                           # sync + backfill aditivo
corepack pnpm --filter @hotelos/api rbac:sync -- --json                 # salida máquina
corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run --upgrade-templates   # qué revocaría (L3)
corepack pnpm --filter @hotelos/api rbac:sync -- --upgrade-templates    # aplica la versión 2, ver §2 (L3)
corepack pnpm --filter @hotelos/api rbac:sync -- --prune                # DESTRUCTIVO, ver §3
```

Códigos de salida: `0` ok · `1` fallo (BD inaccesible, invariante de plantilla
roto) · `2` flag desconocido. Flags reconocidos por `parseFlags`: `--prune`,
`--dry-run`, `--json` y, desde L3, `--upgrade-templates` (hasta que L3 aterrice,
`parseFlags` lo rechaza con exit 2: `Unknown flag`).

### Estado actual (BD local, 2026-09-18 · Tanda 8a · L0 aplicado, API :3000 sin reiniciar)

> Instantánea **anterior al corte** (mañana del 2026-09-18). El corte completo
> (reseed §7, migración §8, seed de demo y `--upgrade-templates` §2) se ejecutó
> ese mismo día: el recuento posterior está en §8 «Ejecutado el 2026-09-18».

- Catálogo: **250 claves** (249 org + 1 plataforma). Tanda 8a (L0) añadió las
  **27 claves** de §4.6 del diseño: `pms.reservation.discount`,
  `pms.reservation.override`, `folio.adjust`, `folio.adjust_approve`,
  `invoice.cancel_request`, `invoice.cancel_approve`, `night_audit.run`,
  `night_audit.review`, `night_audit.reopen`, `housekeeping.read`,
  `maintenance.read`, `maintenance.workorder.create`, `pos.order.void`,
  `payables.read`, `payables.create`, `payables.approve`, `payables.pay`,
  `accounting.period.close`, `payroll.approve`, `revenue.rates.approve`,
  `real_estate.read`, `real_estate.manage`, `real_estate.documents.manage`,
  `property_tax.manage`, `users.assign`, `compliance.read`,
  `security.break_glass` (223 → 250). Las rutas y servicios que las gatean
  llegan con L1/L2; hasta entonces son catálogo + plantilla.
- **24 plantillas** (`ROLE_TEMPLATE_KEYS`, orden «más específico primero»:
  general_manager, operations_director, front_office_manager,
  housekeeping_manager, maintenance_manager, fnb_manager, night_auditor,
  admin_clerk, controller, payroll_hr, asset_manager, auditor, break_glass,
  owner, admin, manager, receptionist, housekeeper, maintenance, accountant,
  compliance, revenue, sales, fnb), **versión 2** (`ROLE_TEMPLATE_VERSION`).
  **22 se materializan por organización** (`ORGANIZATION_TEMPLATE_ROLE_KEYS`:
  todas menos `admin`, reservada al administrador de plataforma en el árbol, y
  `break_glass`, que solo crea `ensureBreakGlassRole`). Etiquetas en español
  (`ROLE_TEMPLATE_LABELS_ES`): Dirección general, Dirección de operaciones,
  Jefatura de recepción, Gobernanta, Encargado de mantenimiento, Jefatura de
  A&B, Auditoría nocturna, Administración de hotel, Dirección financiera, RRHH
  y nóminas, Gestión del activo, Auditoría interna, Emergencia, Propiedad,
  Administración de sistema, Dirección de hotel, Recepción, Pisos,
  Mantenimiento, Contabilidad, Cumplimiento, Revenue corporativo, Comercial,
  Punto de venta.
- La BD local **hoy** (SQL 2026-09-18, antes de reiniciar el API): 223 filas en
  `permissions` (las 27 nuevas entran en el siguiente arranque o con
  `rbac:sync`), **21 roles** (Faranda `cmrhw9jy30002fyvb6tsdiugt` → Owner +
  Dirección, Recepción, Pisos, Mantenimiento, Contabilidad, Cumplimiento,
  Revenue, Comercial, Punto de venta; org_123 → Local Super Admin (plataforma,
  `template_key` `NULL`) + Propietario + las mismas 9), todos con
  `template_version = 0` y `managed = true` (valores por defecto de la
  migración `20260918100000_rbac_departamentos`), **10 `user_property_roles`**
  (Carmen Owner ×8, `recepcion.tilos@faranda.test` Recepción en LT,
  `reception@example.com` Local Super Admin en `prop_123`) y **0
  `user_role_assignments`** (tabla creada, vacía hasta §8). Los 12 roles
  nuevos por organización (las 13 plantillas nuevas menos `break_glass`) los
  crea `reseed-property-roles` (§7), no `rbac:sync`.
- Comando de verificación (sin escrituras) y salida **literal** del
  2026-09-18 (solo varía el tiempo en ms; se omiten las 20 líneas `topped up:`):

  ```bash
  corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run
  # [rbac] template roles: 20 following a template (20 topped up [dry-run]), 0 template_key stamped by name, 0 custom (untouched), 0 EMPTY without template
  # [rbac] 20 template role(s) behind template version 2 (12 still hold keys the version revokes; the boot top-up never revokes) — run rbac:sync --upgrade-templates after --dry-run and a backup (docs/runbooks/rbac-sync.md)
  # [rbac:sync] DRY-RUN (no writes) · 86 ms
  #   catalog: 250 keys (249 org + 1 platform)
  #   permissions: +27 created · 0 descriptions updated · 0 stale
  #   template roles: 20 following a template · 20 topped up · 0 template_key stamped by name · 0 custom (untouched) · 0 EMPTY without template
  #     topped up: Owner (cmrhw9jy30002fyvb6tsdiugt) ← owner: +5
  #     topped up: Dirección (cmrhw9jy30002fyvb6tsdiugt) ← manager: +110
  #     topped up: Recepción (cmrhw9jy30002fyvb6tsdiugt) ← receptionist: +42
  #     … (Pisos +6 · Mantenimiento +17 · Contabilidad +29 · Cumplimiento +29 · Revenue +18 · Comercial +18 · Punto de venta +8; org_123 ídem)
  #   platform roles: 1 (1 topped up)
  #     Local Super Admin (org_123) ← full catalog: +27
  #   templates: general_manager=117 operations_director=110 front_office_manager=101 housekeeping_manager=34 maintenance_manager=47 fnb_manager=48 night_auditor=51 admin_clerk=51 controller=80 payroll_hr=11 asset_manager=27 auditor=68 break_glass=249 owner=65 admin=70 manager=205 receptionist=75 housekeeper=12 maintenance=25 accountant=57 compliance=58 revenue=53 sales=51 fnb=22
  ```

  Lectura: el top-up aditivo del arranque **añade** a cada rol las claves
  nuevas de su plantilla (Dirección +110, Recepción +42…) pero **no retira**
  las que la versión 2 revoca: por eso, tras aplicar el sync, el segundo
  dry-run reporta `+0 created · 0 topped up` y sigue avisando `20 template
  role(s) behind template version 2` hasta que se ejecute
  `--upgrade-templates` (§2). Cualquier `stale > 0`, `created > 0` o `stamped
  > 0` después del corte significa que la BD y el código han divergido: leer
  §2/§3/§4 antes de escribir. `following a template` sube en 1 por cada rol
  plantilla que se cree (un tenant nuevo añade 22).
- Estado anterior (Tanda 6, 2026-09-16): 221 claves (220 org + 1 plataforma),
  11 plantillas, 10 por organización; Tanda 5 (2026-09-15): 215 claves; el
  `--prune` de §3 se ejecutó en Tanda 4 (216 → 212). Los deltas de Tanda 6/6b
  (`accounting.reports.read`, `accounting.entity.read`,
  `organization.structure.manage`) ya están aplicados en la BD local.

## 2. `Role.templateKey` y el backfill de roles

`roles.template_key` (nullable) dice de qué plantilla compartida
(`ROLE_PERMISSION_MAP`, 24 claves de plantilla de §1) nace un rol. `NULL` =
rol custom (o rol de plataforma). Desde Tanda 8a el rol lleva además:

| Columna | Valor | Quién la escribe |
| --- | --- | --- |
| `level` (`RoleLevel`) y `department` | nivel N1-N7 y departamento en español de la plantilla (`templateRoleMetadata`) | creación desde plantilla, `--upgrade-templates` |
| `template_version` (`Int`, default 0) | versión de `ROLE_PERMISSION_MAP` a la que el rol convergió por última vez | solo `upgradeRoleTemplate` (y la creación desde plantilla, que sella la versión actual) |
| `managed` (`Boolean`, default true) | `true` = sigue su plantilla y el upgrade puede tocarlo; `false` = rol personalizado: **nunca** lo toca ni el backfill ni el upgrade | editor de roles (`PATCH /rbac/roles/:id/permissions` lo pone a `false` al quitar claves de la plantilla) |

En cada arranque, `backfillTemplateRoles`:

1. **Roles con `template_key`** → `applyRoleTemplate` SIEMPRE (aditivo,
   idempotente, `+0` cuando converge). Así, cuando una tanda añade una clave
   a una plantilla, los roles existentes (Faranda incluida) la reciben en el
   siguiente arranque en vez de responder 403.
2. **Roles sin `template_key` cuyo nombre casa con una plantilla**
   (`resolveTemplateKeyForRoleName`: alias en español, sin acentos ni
   mayúsculas — «Propietaria», «Dirección», «Jefe de Recepción», «Gobernanta»,
   «Dirección financiera», «RRHH»…) y que no tienen ninguna clave fuera de esa
   plantilla → se **adoptan**: se sella `template_key` y se hace el top-up.
   Fue el caso del «Owner» de Faranda. Ojo con los alias: las plantillas
   nuevas van **antes** de `manager` y `accountant` en `ROLE_TEMPLATE_KEYS`
   para que «Dirección financiera» no adopte `manager` ni «Administración de
   hotel» adopte `accountant`.
3. **Roles con permisos que no casan con ninguna plantilla, o con claves
   fuera de la plantilla que sugiere su nombre** → custom: **nunca se tocan**.
4. **Roles vacíos sin plantilla** → se listan como `EMPTY without template`.
   Un usuario asignado a uno de ellos recibe 403 en todo en producción; por
   eso `ensureRoleHasPermissions` bloquea la invitación con 409
   `ROLE_WITHOUT_PERMISSIONS` hasta que el rol tenga plantilla.
5. **Roles de plataforma** (detección conservadora: ya tienen una clave
   `admin.*`/`platform.*`, o se llaman «Local Super Admin»/«Super Admin»/… y
   viven en una org que ya posee un rol de plataforma) → catálogo completo,
   `template_key` se queda `NULL`; el upgrade nunca los toca.
6. **Informe de versión** (nuevo): para cada rol gestionado con
   `template_version < ROLE_TEMPLATE_VERSION` calcula qué claves de
   `ROLE_TEMPLATE_REVOCATIONS[template]` **todavía** tiene (`revocationsByRole`)
   y avisa `N template role(s) behind template version 2 (M still hold keys
   the version revokes)`. No escribe nada.

### `rbac:sync --upgrade-templates`: la versión 2 y las revocaciones

Regla de `packages/shared/src/permissions.ts`: **añadir** claves a una
plantilla es aditivo y lo entrega el arranque; **quitar** claves es una
**versión nueva**: se sube `ROLE_TEMPLATE_VERSION` y las claves retiradas se
listan en `ROLE_TEMPLATE_REVOCATIONS[template]` (`tests/rbac-sod-contract.test.mjs`
exige que ninguna revocación esté también en la plantilla). Solo
`upgradeRoleTemplate` las aplica, y solo a roles **gestionados**
(`managed = true`, `template_key` conocido, `template_version < 2`): retira
exactamente esas claves si aún las tiene, concede las que le faltan, sella
`level`, `department` y `template_version = 2` y escribe el evento
`ROLE_TEMPLATE_UPGRADED` (`beforeJson` con `revoked`, `afterJson` con `added`).
Roles con `managed = false`, sin plantilla o de plataforma: intactos
(`skippedReason: custom | no_template | platform`).

Historial de cambios **aditivos** posteriores (sin versión nueva; los entrega
el top-up del paso 1 en el siguiente arranque o `rbac:sync`; el `--dry-run`
los anticipa como `topped up: <rol> ← <plantilla>: +N`):

- CIERRE-1 · C4b (2026-09-20): `payroll_hr` + `users.read` (selector «Persona»
  de la ficha de personal, `GET /rbac/users`; `ROLE_TEMPLATE_VERSION` sigue
  en 4). La clave abre además `GET /rbac/assignments` y
  `GET /backoffice/properties/:propertyId/users` (que devuelve el teléfono):
  efecto aceptado para RRHH (revisión REV-06). Dry-run contra la BD viva antes de aplicar: `+0 created · 3 topped up`
  (los tres roles «RRHH y nóminas» de Faranda, org_123 y org_uxday, `+1` cada
  uno); tras el primer arranque del API (o `rbac:sync` real) la segunda
  pasada debe reportar `+0 created · 0 topped up`.

Procedimiento (una vez por entorno, tras L3; en Faranda dentro del orden de
§8):

1. `corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run --upgrade-templates`
   y leer el informe por rol. Salida esperada en la BD local (una línea por
   rol gestionado; las cifras son las de `ROLE_TEMPLATE_REVOCATIONS` de L0,
   iguales en Faranda y en org_123):

   ```
   [rbac:sync] DRY-RUN (no writes) + upgrade-templates
     template version: 2 · 20 role(s) behind · 12 would lose keys
     would upgrade: Dirección (cmrhw9jy30002fyvb6tsdiugt) ← manager: −16 revoked · +… added → version 2
       revoked: payment.capture, payments.capture, payment.refund, invoice.issue, billing.invoice.issue, billing.invoice.rectify, guest_register.export, assets.manage, backoffice.access, roles.manage, billing.configure, accounting.configure, payments.configure, payroll.manage, banking.reconcile, accounting.entity.read
     would upgrade: Contabilidad (…) ← accountant: −6 (invoice.cancel, billing.configure, folio.charge.post, audit.read, commissions.read, payroll.manage)
     would upgrade: Cumplimiento (…) ← compliance: −4 (audit.read, inventory.read, pos.read, commissions.read)
     would upgrade: Comercial (…) ← sales: −1 (analytics.export)
     would upgrade: Punto de venta (…) ← fnb: −1 (pos.product.manage)
     would upgrade: Owner (…) ← owner: −162 (todo lo operativo y de configuración; quedan 65 claves de lectura y aprobación)
     would upgrade: Propietario (org_123) ← owner: −162
     would upgrade: Recepción / Pisos / Mantenimiento / Revenue (…) ← −0 revoked (solo sello de versión, nivel y departamento)
   ```

   Nota de cifras: el diseño (§6.5) estimó **owner −164** y **admin −155**;
   `ROLE_TEMPLATE_REVOCATIONS` de L0 fija **owner −162** y **admin −154**
   (dos y una clave menos, al cuadrar las matrices con las claves nuevas
   que `owner`/`admin` sí conservan). La cifra buena es siempre la que
   imprime el dry-run. `admin` no aparece en la BD local (ninguna
   organización tiene ese rol materializado): su −154 solo se aplicaría a un
   rol «Administración de sistema» creado bajo demanda. Las revocaciones no
   dependen de la organización: Faranda y org_123 reportan lo mismo.
2. **Copia** de la BD (`pg_dump -Fc "$DATABASE_URL" > backups/hotelos-pre-upgrade-$(date +%F).dump`).
3. Aplicar: `corepack pnpm --filter @hotelos/api rbac:sync -- --upgrade-templates`.
4. Verificar: un segundo `--dry-run` sin el aviso `behind template version`;
   la línea `templates:` del dry-run coincide con el recuento por rol:

   ```sql
   SELECT r.organization_id, r.name, r.template_key, r.level, r.template_version, r.managed, count(rp.*) AS grants
   FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
   GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 2;
   -- esperado tras L3 + §7 + §8 en Faranda: 22 roles con template_version = 2, managed = true,
   --   Owner owner 65 · Dirección manager 205 · Recepción receptionist 75 · Pisos housekeeper 12 ·
   --   Mantenimiento maintenance 25 · Contabilidad accountant 57 · Cumplimiento compliance 58 ·
   --   Revenue revenue 53 · Comercial sales 51 · Punto de venta fnb 22 · + los 12 nuevos (§7) ·
   --   + Emergencia break_glass 249 (solo si se ha creado la cuenta de emergencia, accesos-por-departamento.md §6)
   -- org_123: Local Super Admin (NULL, plataforma) 250 · Propietario owner 65 · y los mismos 21
   SELECT count(*) FROM audit_events WHERE action = 'ROLE_TEMPLATE_UPGRADED';   -- = roles subidos
   ```

   Las sesiones vivas ven el cambio en la siguiente petición
   (`Organization.rbacVersion` invalida la caché de permisos).

Log de arranque esperado tras el corte (ya estampado, sin roles por detrás de
la versión; `stamped by name` solo vuelve a ser > 0 si aparece un rol nuevo sin
`template_key` cuyo nombre case con un alias):

```
[rbac] permission catalog synced: created=0 updated=0 stale=0
[rbac] template roles: 44 following a template (0 topped up), 0 template_key stamped by name, 0 custom (untouched), 0 EMPTY without template
[rbac] platform roles topped up: 0 of 1 platform role(s) (Local Super Admin (org_123) ← full catalog: +0)
```

## 3. `--prune`: procedimiento obligatorio

> Estado: **ejecutado el 2026-09-14** en la BD demo (216 → 212 claves, 4
> `role_permissions` de «Local Super Admin» eliminadas). Hoy `--dry-run
> --prune` reporta `0 stale` y no borraría nada. **Tanda 8a no poda nada**:
> el diseño (§6.5, lote L6) preveía podar `capex.approve` (muerta: 0 rutas, 0
> servicios) pero `packages/product/src/modules/module-manifest.ts:377` la
> sigue referenciando en el módulo de CAPEX (`permissions: ["capex.read",
> "capex.create", "capex.approve"]`), así que **no se poda mientras esa
> referencia exista** (regla general de abajo: nunca `--prune` con una
> referencia viva). Queda en el catálogo y en `owner`; retirarla es una tarea
> aparte que empieza por `module-manifest.ts`. Las otras 12 claves sin ruta
> (`distribution.ai_recommend`, `pos.product.manage`, `integrations.configure`,
> `integrations.view_logs`, `tax.configure`, `revenue.history_forecast.configure`,
> `revenue.scheduled_reports.manage`, `crm.export`, `groups.manage_billing`,
> `kiosk.configure`, `iot.manage`, `developer.manage_sandbox`) se **cablean** a
> rutas en L2, no se podan.

`--prune` borra las filas de `permissions` que no están en el catálogo **y
todas las `role_permissions` que apuntan a ellas** (no hay FK entre las
tablas RBAC: si no se borraran, quedarían huérfanas). Es la única operación
destructiva sobre el catálogo y **nunca** va en `deploy/scripts/deploy.sh` ni
en CI. Retirar una clave de una **plantilla** (no del catálogo) no es un
prune: es una versión nueva y `--upgrade-templates` (§2).

> Advertencia · el seed recreaba las claves stale. Hasta Tanda 4,
> `packages/database/prisma/seed.ts` (lista `DEMO_PERMISSIONS`) sembraba las
> 4 claves `pms.reservation.update / .cancel / .check_in / .check_out` y las
> concedía al rol «Local Super Admin», de modo que cualquier re-seed deshacía
> un `--prune` anterior. El lote *dataset-seeds* de Tanda 4 las retiró del
> seed (aplicado antes del prune). Regla general: **nunca `--prune` mientras
> un seed, fixture o manifiesto de módulo siga creando o referenciando la
> clave** o el siguiente seed la recreará. El mismo `seed.ts` sigue sembrando
> el rol «Local Super Admin» (L233-245) y una fila de `user_property_roles`
> para `usr_123` en `prop_123` (L247-251): es el **7.º escritor** de
> `user_property_roles` (los otros 6: `auth-pilot.service.ts`,
> `invitations.service.ts`, `backoffice.service.ts`, `tenant-admin.service.ts`,
> `property-provisioning.service.ts`, `bootstrap.service.ts`) y hay que
> tenerlo en cuenta en §8.

Orden obligatorio (vigente): **seed → dry-run → copia → prune → recuento**.

1. **Quitar las claves del seed** (`DEMO_PERMISSIONS` en
   `packages/database/prisma/seed.ts`) y de cualquier manifiesto de módulo
   (`module-manifest.ts`) y comprobar que ningún código las referencia:
   `grep -rn "<clave>" apps packages` debe devolver 0 resultados fuera de
   tests/documentación.
2. **Dry-run** y leer el informe:

   ```bash
   corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run --prune
   ```

   Lo que reportó el 2026-09-14 antes del prune: `4 stale` · `grants on stale
   keys: 4 role_permissions row(s) on 1 role(s)` · `--prune WOULD delete 4
   key(s) and 4 role_permissions row(s)`. Hoy reporta `0 stale`. Si el número
   de grants o de roles no es el esperado, **parar** y revisar qué rol depende
   de esas claves.
3. **Copia** de la BD (en el VPS, `pg_dump -Fc "$DATABASE_URL" >
   backups/hotelos-pre-prune-$(date +%F).dump`; en el Mac, `pg_dump -Fc
   hotelos > ...`).
4. **Prune**:

   ```bash
   corepack pnpm --filter @hotelos/api rbac:sync -- --prune
   ```

5. **Recuento**:

   ```sql
   SELECT count(*) FROM permissions;                       -- = nº de claves de PERMISSIONS (250 desde L0, 2026-09-18; 223 antes; 212 tras el prune del 2026-09-14)
   SELECT count(*) FROM role_permissions rp
     LEFT JOIN permissions p ON p.id = rp.permission_id
   WHERE p.id IS NULL;                                     -- = 0 (sin huérfanas)
   SELECT count(*) FROM role_permissions
   WHERE role_id = 'role_local_super_admin';               -- = 250 (249 org + 1 plataforma)
   ```

   y un segundo `rbac:sync -- --dry-run` debe reportar `0 stale`.

Si algo no cuadra: restaurar la copia (`pg_restore -d hotelos --clean
--if-exists <dump>`) y abrir incidencia; no reintentar `--prune` a ciegas.

## 4. Cuando aparece una permission nueva en el catálogo

Flujo normal de una tanda que añade una clave (`PERMISSIONS` en
`packages/shared/src/permissions.ts` y `PermissionKey` en `types.ts`); no hace
falta `--prune` ni SQL manual:

1. Añadir la clave a `PERMISSIONS` **y** a las plantillas de
   `ROLE_PERMISSION_MAP` que deban tenerla según las matrices §4.4/§4.5 del
   diseño (`owner` y `admin` ya **no** reciben todo lo org: Propiedad es
   lectura + aprobaciones y Administración de sistema no tiene claves
   financieras ni operativas; `break_glass` sí recibe todo lo org por
   construcción). Las claves `admin.*`/`platform.*` nunca entran en una
   plantilla (`assertTemplatesExcludePlatformKeys` aborta el sync si ocurre).
   Si la clave rompe un par de `SOD_STATIC_PAIRS` en alguna plantilla,
   `tests/rbac-sod-contract.test.mjs` lo rechaza.
2. `corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run`: esperado
   `permissions: +1 created` y `template roles: N topped up` (uno por rol cuya
   plantilla incluye la clave); los roles custom (`template_key` NULL o
   `managed = false`) salen como `custom (untouched)` y **no** la reciben.
3. Aplicar: reiniciar el API (el boot ejecuta los dos pasos, fail-closed) o
   `corepack pnpm --filter @hotelos/api rbac:sync`. `deploy/scripts/deploy.sh`
   solo imprime el informe `--dry-run` en su paso `rbac`; la escritura la hace
   el arranque del paso `restart`.
4. Verificar: `SELECT count(*) FROM permissions` = nuevo total (251, 252…) y
   un segundo `--dry-run` con `+0 created · 0 topped up`. Actualizar la cifra
   «250» en este runbook (§1, §3 paso 5) y en `deploy/README-INSTALL.md` (§8;
   hoy dice 212, pendiente). El `catalogKeys: 212` de
   `apps/api/src/lib/__tests__/rbac-catalog.test.mts` es un fixture del
   informe humano, no la cifra real: no hace falta tocarlo.
5. Roles custom que deban tener la clave: concederla desde el editor de roles
   (`roles.manage`, `PATCH /rbac/roles/:id/permissions`) o sellar
   `template_key` como en §5; nunca por `UPDATE` masivo en `role_permissions`.

Si en vez de aparecer una clave **desaparece** del catálogo: el sync la
reporta como `stale` y la conserva; retirarla es el procedimiento de §3. Si
una clave **sale de una plantilla** pero sigue en el catálogo: subir
`ROLE_TEMPLATE_VERSION`, listarla en `ROLE_TEMPLATE_REVOCATIONS` y aplicar
`--upgrade-templates` (§2).

## 5. Reparaciones puntuales

- **Un rol plantilla no recibe claves nuevas**: comprobar
  `SELECT template_key, managed FROM roles WHERE id = '…'`. Si `template_key`
  es `NULL` y el nombre no casa con ningún alias, sellarlo a mano (`UPDATE
  roles SET template_key = 'manager' WHERE id = '…'`) y reiniciar el API o
  correr `rbac:sync`: el top-up es aditivo. Si `managed = false`, el rol es
  personalizado a propósito: conceder la clave desde el editor de roles.
- **Un rol sigue con claves que su plantilla ya no tiene** (403 que no llega,
  o aviso `behind template version`): `--dry-run --upgrade-templates` para
  ver qué se retiraría y `--upgrade-templates` tras copia (§2). Nunca
  `DELETE` a mano en `role_permissions`.
- **Rol vacío custom** («Equipo noche» con 0 permisos): la invitación devuelve
  409 `ROLE_WITHOUT_PERMISSIONS`. Opciones: sellar `template_key` como arriba,
  o crear el rol desde plantilla con `POST
  /backoffice/properties/:propertyId/roles {name, templateKey}` o `POST
  /rbac/roles` (permiso `roles.manage`) y usar ese. `break_glass` no es
  creable por esa vía (solo `ensureBreakGlassRole`).
- **`template_key` con un valor desconocido** (typo manual): el arranque lo
  avisa (`carries unknown template_key`) y salta el rol sin abortar; corregir
  la fila o ponerla a `NULL`.
- **Una organización sin las 22 plantillas**: `createTenant` las provisiona
  desde Tanda 5 (`provisionDefaultTemplateRoles`, idempotente: top-up por
  `template_key`, adopción por nombre español, creación con nivel,
  departamento y versión; un nombre ya usado por un rol de otra plantilla se
  reporta como `conflict` y no se toca); para organizaciones existentes usar
  el CLI de §7.
- **Un usuario con permisos «de otra propiedad»**: desde L1 los permisos se
  calculan para la propiedad de la petición; si un usuario ve más de lo que
  su asignación en esa propiedad permite, comprobar `HOTELOS_DEMO_PERMISSION_UNION`
  (debe ser `false`) y `user_property_roles` residuales (§8).

## 6. Qué NO hace este runbook

- No cambia el contenido de las plantillas: las matrices de la Tanda 8a
  (§4.4/§4.5 del diseño) ya están aplicadas en
  `packages/shared/src/permissions.ts`; cualquier **ampliación** futura se
  propaga sola con el top-up de §2 en el siguiente arranque o `rbac:sync`.
  **Retirar** una clave de una plantilla NO la retira de los roles con el
  arranque (sigue siendo aditivo): exige versión nueva + `--upgrade-templates`
  (§2); retirarla del catálogo exige `--prune` (§3).
- No crea ni migra asignaciones de usuarios: eso es `rbac:migrate-assignments`
  (§8) y la pantalla de usuarios y roles
  ([`accesos-por-departamento.md`](./accesos-por-departamento.md) §3).
- No borra usuarios ni roles: eso pertenece al refresco del dataset
  (DATA-06/09). No crea las cuentas de emergencia ni los usuarios de demo
  (`db:seed:rbac-demo`, L5).

## 7. `reseed-property-roles`: las 22 plantillas en una organización existente

Fuente: `apps/api/src/scripts/reseed-property-roles.ts` (Tanda 5 · L1a rbac;
unitarios en `src/scripts/__tests__/reseed-property-roles.test.mts`; L3 le
enseña las plantillas nuevas). Para UNA organización, materializa un rol por
plantilla de `ORGANIZATION_TEMPLATE_ROLE_KEYS` (**22**: nunca `admin` ni
`break_glass`) y lo sube a su plantilla: `top-up` (rol con `template_key`),
`adopt` (sin `template_key`, nombre que resuelve por alias y sin claves ajenas
→ se sella), `create` (nombre de `ROLE_TEMPLATE_LABELS_ES`, con `level`,
`department`, `template_version = 2` y `managed = true`; auditoría
`ROLE_CREATED_FROM_TEMPLATE`) o `conflict` (un rol con ese nombre es custom o
sigue otra plantilla: se reporta, no se toca y bloquea `--apply`). Nunca borra
grants ni roles, nunca crea ni asigna usuarios, nunca revoca (el upgrade es
§2); los roles de plataforma y los `managed = false` se saltan. No hace falta
reiniciar el API (roles y grants se leen de Postgres por petición).

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
propiedad de asignaciones afectadas) → `--apply --confirm` → segundo dry-run
con todo `top-up +0`. Ejecutado en local el 2026-09-15 (L1a) para Faranda y
org_123: 9 y 10 roles creados; segunda pasada `+0`. **Ejecutado por el integrador el 2026-09-18** (tras L3; copia previa
`../backups/hotelos-pre-rbac8a-20260918-122207.dump`) en las dos organizaciones
para crear los **12 roles nuevos**
por organización (Dirección general, Dirección de operaciones, Jefatura de
recepción, Gobernanta, Encargado de mantenimiento, Jefatura de A&B, Auditoría
nocturna, Administración de hotel, Dirección financiera, RRHH y nóminas,
Gestión del activo, Auditoría interna): esperado `create ×12 · top-up ×10
(+0 si el sync ya corrió)`, y 22 roles con plantilla por organización al
terminar (44 `following a template` en el arranque). Resultado real del
2026-09-18: Faranda y org_123 `create ×12 · top-up ×10 (+0) · 747 role_permissions`
cada una, 24 `ROLE_CREATED_FROM_TEMPLATE` (12 por organización), segundo dry-run
`0 a crear · 22 con plantilla · 0 role_permissions a añadir`; el seed de demo
(`db:seed:rbac-demo`) añadió después en Faranda «Administración de sistema»
(`admin`, 70) y «Emergencia» (`break_glass`, 249): 24 roles en Faranda, 23 en
org_123 (22 + Local Super Admin), 46 `following a template` + 1 de plataforma.

## 8. Migración de asignaciones (`rbac:migrate-assignments`)

Fuente: `apps/api/src/scripts/rbac-migrate-assignments.ts` (L3; mismo patrón
`--dry-run | --apply --confirm <id>` que `reseed-property-roles`). Convierte
cada fila de `user_property_roles` en una fila de `user_role_assignments`
de ámbito `property` (misma persona, mismo rol, `validFrom` = ahora,
`reason = "backfill 2026-09-18"` (constante `BACKFILL_REASON` del script), `grantedByUserId` NULL) y **colapsa** al
usuario que tiene el mismo rol en **todas** las propiedades de la organización
en **una** asignación de ámbito `organization`. Mientras la tabla vieja tenga
filas, el lector único (`rbac-scope.ts`) las une a las nuevas (dual-read);
la migración de borrado de `user_property_roles` es un lote posterior y
separado.

```bash
corepack pnpm --filter @hotelos/api rbac:migrate-assignments -- --org <organizationId> --dry-run
corepack pnpm --filter @hotelos/api rbac:migrate-assignments -- --org <organizationId> --apply --confirm <organizationId> [--general-manager <userId>]
#   --general-manager <userId>   además de la asignación migrada, crea a ese usuario una asignación
#                                general_manager de ámbito organization (decisión D1: Carmen = owner + general_manager)
#   --json                       salida máquina
```

Códigos de salida: `0` ok · `1` fallo (org inexistente, rol sin plantilla,
usuario del `--general-manager` fuera de la organización, post-condición) ·
`2` flag desconocido. Nunca borra `user_property_roles`, nunca toca roles ni
permisos, nunca crea usuarios; idempotente (una asignación ya viva se reporta
`ya existe (<id>)` y el resumen la cuenta en «ya existen»).

> Cadena de auditoría (integrador 8a, 2026-09-18): el primer `--apply` sobre
> Faranda creó las 3 asignaciones pero solo persistió 1 de los 3 `ROLE_ASSIGNED`
> («Engine is not yet connected»: `recordAuditEvent` encola la escritura y el
> CLI desconectaba prisma sin vaciar la cola; tampoco hidrataba la punta de la
> cadena hash antes de escribir). Los tres CLI de RBAC (`rbac:migrate-assignments`,
> `reseed-property-roles`, `rbac:sync`) pasan ahora por `withAuditChain`
> (`apps/api/src/lib/audit-chain-cli.ts`: `hydrateAuditChainFromPostgres` antes de
> escribir, `flushAuditQueues` antes de devolver; contrato
> `tests/rbac-cli-audit-contract.test.mjs`). Si un informe dice «auditoría
> ROLE_ASSIGNED: N» y `SELECT count(*) FROM audit_events WHERE action = 'ROLE_ASSIGNED'
> AND correlation_id = '<correlación>'` devuelve menos, el proceso se cerró antes
> del flush: no repetir a ciegas (la segunda pasada reporta «ya existen»).

Resultado del dry-run en la BD local (10 filas vivas el 2026-09-18; **aplicado
por el integrador ese mismo día**, ver el bloque «Ejecutado» más abajo):

- **Faranda** (`cmrhw9jy30002fyvb6tsdiugt`): 9 filas → **2 asignaciones**:
  Carmen (`direccion@farandariasaltas.es`, Owner ×8 = todas las propiedades)
  → `owner` de ámbito `organization`; `recepcion.tilos@faranda.test` →
  `receptionist` en LT (`cmu1mifcp0000fyo1wzvq7txo`). Con `--general-manager
  <userId de Carmen>` → **3** (la tercera `general_manager` / `organization`,
  D1; exige que el rol «Dirección general» exista: §7 antes).
- **org_123**: 1 fila → `reception@example.com` conserva «Local Super Admin»
  (custom, plataforma) como asignación de ámbito `organization`.

Orden obligatorio para Faranda (corte de la Tanda 8a; el orquestador reinicia
el API, nadie más):

1. **Copia**: `pg_dump -Fc "$DATABASE_URL" > backups/hotelos-pre-rbac8a-$(date +%F).dump`.
2. **Plantillas**: `reseed-property-roles --org <faranda> --apply --confirm`
   (§7) para que existan los 22 roles; ídem org_123.
3. **Asignaciones**: `rbac:migrate-assignments --org <faranda> --dry-run` →
   leer → `--apply --confirm <faranda> --general-manager <userId de Carmen>`;
   ídem org_123 sin `--general-manager`.
4. **Versión 2**: `rbac:sync -- --dry-run --upgrade-templates` → leer →
   `rbac:sync -- --upgrade-templates` (§2). Hacerlo **después** de migrar las
   asignaciones: Carmen pasa a `owner` estrechada + `general_manager`, y sin el
   paso 3 se quedaría solo con las 65 claves de Propiedad.
5. **Verificación con Carmen** (`direccion@farandariasaltas.es`, sesión real):
   `GET /users/me` con `scopes[]` = `[organization]` y `templateKeys` =
   `owner, general_manager` en las 8 propiedades; el menú muestra las 9
   categorías; `GET /properties/:id/...` de Recepción, Finanzas y Configuración
   responden 200 en LT y en RA; la bandeja `/hoy/pendientes` carga. Y con
   `recepcion.tilos@faranda.test`: 200 en las GET de recepción de LT, **403**
   en `/finanzas/*` y `/rbac/*`, **404** opaco en cualquier ruta de RA.
6. **`.env`**: `RBAC_STRICT=true` (añadido por el corrector de la Tanda 8a el
   2026-09-18; surte efecto al reiniciar el API) y dejar
   `HOTELOS_DEMO_PERMISSION_UNION` sin definir o en `false`;
   `HOTELOS_ALLOW_DEMO_AUTH=true` se queda (solo demoStore). Pedir el reinicio
   del API al orquestador y repetir el paso 5.
7. **Recuento**:

   ```sql
   SELECT scope_type, count(*) FROM user_role_assignments WHERE revoked_at IS NULL GROUP BY 1;
   -- Faranda: organization 2 (Carmen owner + general_manager) · property 1 (LT receptionist)
   -- org_123: organization 1 (Local Super Admin)
   SELECT count(*) FROM user_property_roles;   -- sigue en 10 (dual-read) hasta la migración de borrado
   SELECT count(*) FROM audit_events WHERE action IN ('ROLE_ASSIGNED', 'ROLE_TEMPLATE_UPGRADED');
   ```

### Ejecutado el 2026-09-18 (integrador · Tanda 8a · BD local del Mac)

Orden real: copia → reseed §7 (Faranda, org_123) → `rbac:migrate-assignments
--apply --confirm --general-manager cmrhw9jyb0005fyvb4ykaumyc` (Faranda: 3
asignaciones = Carmen `owner` + `general_manager` de organización y
`recepcion.tilos` `receptionist` en LT; org_123: 1, Local Super Admin de
organización) → `db:seed:rbac-demo` (30 usuarios, 28 asignaciones, 16 espejos,
2 grupos, 45 umbrales, 2 roles, 58 eventos) → `rbac:sync -- --dry-run
--upgrade-templates` → `rbac:sync -- --upgrade-templates` (20 roles v0→v2, 380
claves revocadas: owner −162 ×2, manager −16 ×2, accountant −6 ×2, compliance
−4 ×2, sales −1 ×2, fnb −1 ×2; 20 `ROLE_TEMPLATE_UPGRADED`) → segundo dry-run
`0 role(s) behind · +0 · 0 stale`. Recuento final:

```sql
SELECT scope_type, count(*) FROM user_role_assignments
WHERE organization_id = 'cmrhw9jy30002fyvb6tsdiugt' AND revoked_at IS NULL GROUP BY 1;
-- property 17 · property_group 3 · legal_entity 5 · organization 6
SELECT count(*) FROM user_property_roles;                     -- 26 (10 previas + 16 espejos del seed; dual-read)
SELECT count(*) FROM roles WHERE template_version = 2;        -- 46 (24 Faranda + 22 org_123); Local Super Admin sigue en 0 (plataforma)
SELECT count(*) FROM audit_events WHERE action = 'ROLE_TEMPLATE_UPGRADED';   -- 20
SELECT count(*) FROM permissions;                             -- 250
```

`GET /users/me` de Carmen tras el corte: `templateKeys = [general_manager, owner]`
en las 8 propiedades, `orgScope = true`, 119 claves (unión de las dos
plantillas); `recepcion.tilos@faranda.test`: `receptionist`, 75 claves, solo LT.
La verificación completa (matriz por usuario, SoD, break glass) está en
`docs/audits/TANDA-8A-RBAC-2026-09-18.md`.

> Advertencia · `packages/database/prisma/seed.ts` sigue sembrando el rol
> «Local Super Admin» (L233-245) **y** una fila de `user_property_roles`
> (`usr_123` en `prop_123`, L247-251): es el 7.º escritor de la tabla vieja.
> Cualquier `db:seed` posterior a la migración vuelve a crear esa fila (el
> dual-read la absorbe sin duplicar la asignación, y `migrate-assignments`
> la reporta `skip`), pero la migración de borrado de `user_property_roles`
> **no puede** ejecutarse hasta que ese seed escriba en
> `user_role_assignments`. Los usuarios de demo de la Tanda 8a
> (`db:seed:rbac-demo`, `packages/database/prisma/seed-rbac-demo.ts`, L5)
> escriben directamente en la tabla nueva.
