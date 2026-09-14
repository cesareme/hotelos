# Runbook · `rbac:sync` (catálogo de permisos, plantillas de rol y `--prune`)

Fuente: `apps/api/src/lib/rbac-catalog.ts` (lógica) y
`apps/api/src/scripts/rbac-sync.ts` (CLI). Tanda 1 lo creó; Tanda 4 añade
`Role.templateKey` y el top-up aditivo de los roles plantilla.

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

### Estado actual (BD demo, 2026-09-14 · cierre de Tanda 4)

- Catálogo: **212 claves** (211 org + 1 plataforma). El `--prune` de §3 **ya se
  ejecutó** (216 → 212: `pms.reservation.update / .cancel / .check_in /
  .check_out`); el seed ya no las recrea (`grep -rn pms.reservation.update apps
  packages` solo devuelve el test de `rbac-catalog`).
- La BD demo tiene **2 roles en total** (re-verificación adversarial,
  2026-09-14 tras el segundo `demo:refresh --apply`): el «Owner» de Faranda
  (`template_key = 'owner'`, 211 grants) y «Local Super Admin» (plataforma,
  org_123, `template_key` `NULL`, 212 grants). Faranda **solo** tiene el rol
  Owner: Manager / Recepción / Housekeeping **no existen** hoy en la BD demo
  (los roles `AUDIT-T4 *` y los Owner de las orgs AUDIT se borraron con el
  refresco). Se crean bajo demanda con `POST
  /backoffice/properties/:id/roles {name, templateKey}` o, al crear un tenant,
  con `provisionDefaultTemplateRoles` (§5). org_123 no tiene rol Owner: usr_123
  opera con «Local Super Admin».
- Comando de verificación (sin escrituras) y salida esperada **hoy** (literal,
  ejecutada el 2026-09-14; solo varía el tiempo en ms):

  ```bash
  corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run
  # [rbac] template roles: 1 following a template (0 topped up [dry-run]), 0 template_key stamped by name, 0 custom (untouched), 0 EMPTY without template
  # [rbac] platform roles topped up: 0 of 1 platform role(s) [dry-run] (Local Super Admin (org_123) ← full catalog: +0)
  # [rbac:sync] DRY-RUN (no writes) · 42 ms
  #   catalog: 212 keys (211 org + 1 platform)
  #   permissions: +0 created · 0 descriptions updated · 0 stale
  #   template roles: 1 following a template · 0 topped up · 0 template_key stamped by name · 0 custom (untouched) · 0 EMPTY without template
  #   platform roles: 1 (0 topped up)
  #     Local Super Admin (org_123) ← full catalog: +0
  #   templates: owner=211 admin=211 manager=85 receptionist=18 housekeeper=2 maintenance=2 accountant=9 compliance=19 revenue=33
  ```

  Cualquier `stale > 0`, `created > 0` o `stamped > 0` significa que la BD y el
  código han divergido desde este cierre: leer §2/§3/§4 antes de escribir.
  `following a template` sube en 1 por cada rol plantilla que se cree (por
  ejemplo, provisionar Manager/Recepción/Housekeeping en Faranda lo dejaría
  en 4).

## 2. `Role.templateKey` y el backfill de roles

`roles.template_key` (nullable) dice de qué plantilla compartida
(`ROLE_PERMISSION_MAP`: `owner`, `admin`, `manager`, `receptionist`,
`housekeeper`, `maintenance`, `accountant`, `compliance`, `revenue`) nace un
rol. `NULL` = rol custom (o rol de plataforma).

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

Verificación (BD demo tras el cierre de Tanda 4: exactamente 2 filas — el
recon de la mañana contaba 4 «Owner», llegó a 6 antes del refresco y a 7 roles
con los fixtures AUDIT-T4; todo eso ya se borró):

```sql
SELECT r.name, r.template_key, count(rp.*) AS grants
FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
GROUP BY 1, 2 ORDER BY 1, 2;
--        name        | template_key | grants
-- -------------------+--------------+-------
--  Local Super Admin |              |    212
--  Owner             | owner        |    211
```

Log de arranque esperado hoy (ya estampado y podado; `stamped by name` solo
vuelve a ser > 0 si aparece un rol nuevo sin `template_key` cuyo nombre case
con un alias):

```
[rbac] permission catalog synced: created=0 updated=0 stale=0
[rbac] template roles: 1 following a template (0 topped up), 0 template_key stamped by name, 0 custom (untouched), 0 EMPTY without template
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
   SELECT count(*) FROM permissions;                       -- = nº de claves de PERMISSIONS (212 desde el prune del 2026-09-14)
   SELECT count(*) FROM role_permissions rp
     LEFT JOIN permissions p ON p.id = rp.permission_id
   WHERE p.id IS NULL;                                     -- = 0 (sin huérfanas)
   SELECT count(*) FROM role_permissions
   WHERE role_id = 'role_local_super_admin';               -- = 212 (211 org + 1 plataforma)
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
   «212» en este runbook, en `deploy/README-INSTALL.md` (§8) y en
   `apps/api/src/lib/__tests__/rbac-catalog.test.mts` (`catalogKeys: 212`).
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
- **Un tenant antiguo sin roles Manager/Recepción/Housekeeping**:
  `createTenant` los provisiona desde Tanda 4; para orgs anteriores ejecutar
  `provisionDefaultTemplateRoles(organizationId)` (idempotente) desde un
  script o crear los roles con el POST anterior.

## 6. Qué NO hace este runbook

- No cambia el contenido de las plantillas: ampliar `manager` (ver el TODO en
  `packages/shared/src/permissions.ts`) es una decisión de producto pendiente;
  cuando se aplique, el top-up de §2 la propagará solo en el siguiente
  arranque.
- No borra usuarios ni roles: eso pertenece al refresco del dataset
  (DATA-06/09).
