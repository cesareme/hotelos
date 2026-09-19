# Runbook · Accesos por departamento, nivel y ámbito (RBAC de ehotelOS)

Guía operativa del control de acceso de ehotelOS tras la **Tanda 8a · RBAC
por departamento y nivel** (2026-09-18). Fuente de verdad del diseño:
[`docs/design/RBAC-DEPARTAMENTOS.md`](../design/RBAC-DEPARTAMENTOS.md)
(§4 modelo, §5 navegación y UI, §6 API y migración, §8 datos de demo, §10
correcciones y decisiones de planificación). Contrato de valores y códigos:
`packages/shared/src/rbac-types.ts` (L0); catálogo y plantillas:
`packages/shared/src/permissions.ts`. La sincronización del catálogo, la
versión de plantilla y la migración de asignaciones tienen runbook propio:
[`rbac-sync.md`](./rbac-sync.md). Navegación por tokens:
[`navegacion-tanda-5.md`](./navegacion-tanda-5.md). Manifiesto de rutas y
modo estricto: [`../api-contracts.md`](../api-contracts.md).

Principios que este runbook aplica y que ningún procedimiento puede saltarse:
**fail-secure** (sin permiso = 403; ruta sin entrada en el manifiesto = 403
con `RBAC_STRICT=true`), **aislamiento por organización y ámbito** en cada
consulta (una propiedad fuera del ámbito responde 404 opaco, nunca 403 con
pista), **auditoría** de cada cambio de rol y de cada sesión de emergencia, y
**nadie aprueba lo que solicitó ni se concede permisos a sí mismo**.

Cuentas de este runbook: todas ficticias (`@faranda.test`, `@example.com`).
Faranda = organización `cmrhw9jy30002fyvb6tsdiugt`, sociedad CELUISMA S.A.,
8 centros (oficina central OC + AS, FN, LL, LT, MC, PG, RA).

---

## 1. El modelo en una página: plantilla × nivel × ámbito

Un **rol** es una plantilla (`Role.templateKey`, qué puede hacer) con un
**nivel** (`Role.level`, hasta dónde aprueba y a quién puede asignar). Una
**asignación** (`user_role_assignments`) es un rol en un **ámbito** (dónde).
Un usuario puede tener varias asignaciones con plantillas distintas (Recepción
en Los Tilos y Contabilidad en la oficina central); para cada propiedad sus
permisos son la **unión** de las asignaciones que la cubren. Menú, router del
front y API leen la misma decisión (plantilla + ámbito + módulos activos).

### 1.1 Los 7 niveles (`RoleLevel`, `ROLE_LEVEL_RANK`)

Regla de asignación («nivel ≤ propio», `canAssignRoleLevel`): quien tiene
rango *r* solo asigna o retira roles de rango **≤ r**, dentro de su ámbito, y
nunca a sí mismo. `central_admin` y `operations_director` comparten el rango 4
(ninguno manda sobre el otro); `general_management` (5) solo lo asigna
dirección general, propiedad o la plataforma; `ownership` (6) solo propiedad o
la plataforma.

| Nivel | Rango | Quién | Ámbito habitual | Aprueba hasta |
|---|---|---|---|---|
| `operative` (N1) | 1 | Recepcionista, auditor nocturno, camarera de pisos, técnico, camarero, comercial, administrativo de hotel | `property` | T1 con motivo; solicita el resto |
| `supervisor` (N2) | 2 | Jefatura de recepción, gobernanta, encargado de mantenimiento, jefatura de A&B | `property` | T2 |
| `hotel_director` (N3) | 3 | Dirección de hotel | `property` (una o varias) | T3; cierra y reabre el día |
| `central_admin` (N7) | 4 | Contabilidad, RRHH, cumplimiento, gestión del activo, auditoría interna, administración de sistema | `legal_entity` / `organization` | T1 (preparan y ejecutan; no aprueban importes) |
| `operations_director` (N4) | 4 | Dirección de operaciones multi-hotel; revenue corporativo | `property_group` / `organization` | T4; tarifas fuera de banda |
| `general_management` (N5) | 5 | Dirección general; dirección financiera (controller, T4) | `legal_entity` / `organization` | > T4 (doble con propiedad); nóminas mensuales; cierres de periodo |
| `ownership` (N6) | 6 | Propiedad / consejo | `organization` | CAPEX y presupuesto; segundo aprobador > T4 |

### 1.2 Los 4 ámbitos (`ScopeType`, `SCOPE_TYPE_RANK`)

| Ámbito | Cubre | Columna de la asignación |
|---|---|---|
| `property` (1) | un centro | `propertyId` |
| `property_group` (2) | un clúster de centros (`property_groups`: p. ej. Galicia = LT + RA; Asturias-Cantabria = PG + MC + AS) | `propertyGroupId` |
| `legal_entity` (3) | todos los centros de la sociedad (CELUISMA) | `legalEntityId` |
| `organization` (4) | todo el grupo | solo `organizationId` |

Un ámbito más ancho cubre a los más estrechos. Quien asigna solo puede dar
ámbitos **contenidos en el suyo** (403 `RBAC_SCOPE_EXCEEDED`).

### 1.3 Las 24 plantillas (`ROLE_TEMPLATE_KEYS`, versión 3)

Etiqueta = `ROLE_TEMPLATE_LABELS_ES` (nombre del rol que se crea en cada
organización); nivel = `ROLE_TEMPLATE_LEVEL`; ámbito por defecto =
`ROLE_TEMPLATE_DEFAULT_SCOPE`; umbral máximo = `TEMPLATE_MAX_TIER` (el techo de
aprobación de la plantilla, parametrizable por debajo en `role_thresholds`);
token = `ROLE_TEMPLATE_NAV_TOKEN` (lo que ve en el menú); claves = tamaño de la
plantilla en `ROLE_PERMISSION_MAP` (salida `templates:` de `rbac:sync --dry-run`
del 2026-09-18).

| `RoleKey` | Etiqueta | Nivel | Ámbito por defecto | Umbral máx. | Token | Claves |
|---|---|---|---|---|---|---|
| `receptionist` | Recepción | N1 operative | property | T1 | recepcion | 75 |
| `night_auditor` | Auditoría nocturna | N1 operative | property | T1 | recepcion | 51 |
| `front_office_manager` | Jefatura de recepción | N2 supervisor | property | T2 | recepcion | 101 |
| `housekeeper` | Pisos | N1 operative | property | T1 | pisos | 12 |
| `housekeeping_manager` | Gobernanta | N2 supervisor | property | T2 | pisos | 34 |
| `maintenance` | Mantenimiento | N1 operative | property | T1 | mantenimiento | 25 |
| `maintenance_manager` | Encargado de mantenimiento | N2 supervisor | property | T2 | mantenimiento | 47 |
| `fnb` | Punto de venta | N1 operative | property | T1 | fnb | 22 |
| `fnb_manager` | Jefatura de A&B | N2 supervisor | property | T2 | fnb | 48 |
| `sales` | Comercial | N1 operative | property | T1 | comercial | 51 |
| `admin_clerk` | Administración de hotel | N1 operative | property | T1 | administracion | 51 |
| `manager` | Dirección de hotel | N3 hotel_director | property | T3 | direccion | 205 |
| `operations_director` | Dirección de operaciones | N4 operations_director | property_group | T4 | direccion | 110 |
| `revenue` | Revenue corporativo | N4 operations_director | organization | T4 | revenue | 53 |
| `accountant` | Contabilidad | N7 central_admin | legal_entity | T1 | finanzas | 57 |
| `controller` | Dirección financiera | N5 general_management | legal_entity | T4 | finanzas | 80 |
| `payroll_hr` | RRHH y nóminas | N7 central_admin | legal_entity | T1 | rrhh | 13 |
| `compliance` | Cumplimiento | N7 central_admin | legal_entity | T1 | finanzas | 58 |
| `asset_manager` | Gestión del activo | N7 central_admin | legal_entity | T1 | activos | 29 |
| `general_manager` | Dirección general | N5 general_management | organization | > T4 | direccion | 117 |
| `owner` | Propiedad | N6 ownership | organization | > T4 | propiedad | 65 |
| `auditor` | Auditoría interna | N7 central_admin | organization | T1 (solo lectura) | auditoria | 68 |
| `admin` | Administración de sistema | N7 central_admin | organization | T1 (sin dinero) | sistemas | 72 |
| `break_glass` | Emergencia | N5 general_management | organization | > T4 | direccion | 249 (todo lo org) |

- **22 se materializan por organización** (`ORGANIZATION_TEMPLATE_ROLE_KEYS`):
  todas menos `admin` (se crea bajo demanda; el token `admin` del árbol es el
  administrador de **plataforma**) y `break_glass` (solo la crea
  `ensureBreakGlassRole`, §6; nunca aparece en el selector de invitación ni en
  «Ver como»).
- Alias de nombre (`resolveTemplateKeyForRoleName`, `apps/api/src/lib/rbac-catalog.ts`):
  «jefe/jefa de recepción» → `front_office_manager`, «gobernanta» →
  `housekeeping_manager`, «controller | dirección financiera» → `controller`,
  «rrhh | nóminas» → `payroll_hr`, «director general | ceo» →
  `general_manager`, «operaciones» → `operations_director`, «activos |
  patrimonio» → `asset_manager`, «auditoría interna | auditor» → `auditor`,
  «administrativo/a» → `admin_clerk`. Las plantillas nuevas van **antes** de
  `manager` y `accountant` en `ROLE_TEMPLATE_KEYS` («más específico primero»)
  para que «Dirección financiera» no resuelva a `manager` ni «Administración de
  hotel» a `accountant`.
- Subdirección = `manager` con umbrales T2 en `role_thresholds` (D3).

---

## 2. Matriz plantilla → módulo

Letras: **V** ver · **C** crear/ejecutar · **E** editar/configurar · **S**
solicitar · **A** aprobar · **X** anular/reembolsar/reabrir · **P** exportar.
El diccionario módulo → claves está en el diseño §4.3; las celdas de aquí,
expandidas con ese diccionario, son exactamente `ROLE_PERMISSION_MAP` (versión
3, `tests/rbac-sod-contract.test.mjs` lo fija).

Nota de la versión 3 (fusión TL · Live Timeline, 2026-09-19): cambio **aditivo**.
`payroll_hr`, `asset_manager` y `admin` ganan `pms.reservation.read` +
`guests.read` (solo lectura: habitaciones, tipos, reservas y nombre del huésped)
para que Hoy › Live Timeline (`/hoy/live-timeline`, primera entrada del menú
para todos los perfiles) pinte con nombres en vez de «Huésped no visible»; las
dos claves salen de `ROLE_TEMPLATE_REVOCATIONS.admin`. Ninguna plantilla pierde
claves; `rbac:sync -- --upgrade-templates` sella la versión 3 y entrega las dos
claves en una pasada auditada (`ROLE_TEMPLATE_UPGRADED`, revoked = []).
Administración de sistema pasa de 70 a 72 claves y sigue sin dinero ni folio.

Notas de la versión 2 respecto a las plantillas anteriores:

- **Corrección H5.** El hueco H5 del diseño atribuía a `accountant`
  `payment.capture` + `payment.refund`; en la versión 1 Contabilidad **nunca**
  tuvo esas claves (sí tenía `invoice.issue` + `invoice.cancel` y
  `accounting.journal.post` + `banking.reconcile` + `payroll.manage`, que son
  los pares que la versión 2 rompe: pierde `invoice.cancel`, `payroll.manage`,
  `folio.charge.post`, `audit.read`, `commissions.read` y
  `billing.configure`). El par cajero ≠ aprobador de reembolsos solo afectaba a
  `manager`, que en la versión 2 pierde `payment.capture`/`payments.capture` y
  `invoice.issue` y conserva `payments.refund_approve` e `invoice.cancel`
  (aprueba y ejecuta lo que solicitan Recepción y Administración de hotel).
- **`owner` y `admin` quedan estrechadas.** Propiedad pasa de las 222 claves de
  organización a 65 (lectura + aprobaciones estratégicas: CAPEX, presupuesto,
  segundo aprobador > T4); Administración de sistema pasa a 70 claves de
  sistema (usuarios, roles, módulos, integraciones, IA, puesta en marcha) **sin
  ninguna clave financiera ni operativa** (SoD sistema ≠ finanzas) y con el
  token `sistemas`. Las revocaciones exactas están en
  `ROLE_TEMPLATE_REVOCATIONS` y se aplican con `rbac:sync --upgrade-templates`
  ([`rbac-sync.md`](./rbac-sync.md) §2), nunca en el arranque.
- Las 13 plantillas nuevas no tienen versión anterior; `receptionist`,
  `housekeeper`, `maintenance` y `revenue` no pierden ninguna clave.

### 2.1 Hotel (ámbito propiedad)

Rec = receptionist · AudN = night_auditor · JRec = front_office_manager · CamP = housekeeper · Gob = housekeeping_manager · Tec = maintenance · EncM = maintenance_manager · TPV = fnb · JAB = fnb_manager · Com = sales · AdmH = admin_clerk · DirH = manager. `–` = ninguna clave del módulo. ¹ = fila propia (sus habitaciones / sus órdenes, filtro de servicio) · ² = C sin `payment.capture`/`payments.capture` (SoD estática con `payments.refund_approve`, §5) · ³ = solo `accounting.read` (calendario fiscal de la bandeja; los importes van por `accounting.reports.read`) · ⁴ = E solo `workforce.*` (sin `payroll.manage`, SoD con `payroll.approve`) · ⁵ = C sin `pms.checkin.execute`/`pms.checkout.execute` (comercial no opera el mostrador) · ⁶ = V solo `workforce.read` (sus turnos, sin `payroll.read` ni coste laboral).

| Módulo | Rec | AudN | JRec | CamP | Gob | Tec | EncM | TPV | JAB | Com | AdmH | DirH |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| M1 Reservas | V C E S | V | V C E S A | V | V | V | V | V | V | V C⁵ E | V | V C E S A |
| M2 Folios y cobros | V C E S | V C E | V C² E S A | – | – | – | – | C | V C | – | V X | V C² E S A |
| M3 Facturación | V C S | V C | V C E S | – | – | – | – | – | V | V | V C E S | V A X |
| M4 Cierre del día | V | V C | V C | – | – | – | – | – | – | – | V A | V A X |
| M5 Pisos | V | V | V | V E¹ | V E | V | V E | – | – | – | – | V E |
| M6 Mantenimiento | V C | V C | V C | C | V C | V C E¹ | V C E | C | V C | – | V | V C E |
| M7 TPV y A&B | V C | V | V | – | – | – | – | V C | V C E X | – | V | V C E X |
| M8 Compras | – | – | V S | – | V S C | V S | V S C | V S C | V S C E | – | V C E | V A |
| M9 Facturas proveedor | – | – | – | – | – | – | V | – | V | – | V C | V A |
| M10 Contabilidad | V³ | V³ | V³ | – | – | – | – | – | – | – | V | V |
| M11 Tesorería | – | – | – | – | – | – | – | – | – | – | V E | V |
| M12 Nóminas y personal | C | C | V C E⁴ | V⁶ C | V C E⁴ | V⁶ C | V C E⁴ | V⁶ C | V C E⁴ | C | V C | V C E⁴ A |
| M13 Inmovilizado/CAPEX | – | – | – | – | – | – | V S | – | – | – | V | V S |
| M14 Gestión del activo | – | – | – | – | – | – | V C | – | – | – | V C | V C |
| M15 Cumplimiento | V C E | V C | V C E X | – | – | – | – | – | – | – | V | V C E X |
| M15b Config. cumplimiento | – | – | – | – | – | – | – | – | – | – | – | E |
| M16 Revenue | V | V | V | – | – | – | – | – | – | V | – | V E |
| M17 Comercial y CRM | V C | – | V E | – | – | – | – | – | – | V C E P | – | V E |
| M18 Informes | V | V | V | V | V | V | V | V | V | V | V | V C |
| M18b Cuadro del propietario | – | – | – | – | – | – | – | – | – | – | – | V C |
| M19 Configuración | V | V | V | – | V | – | V | – | V | V | V | V E |
| M20 Estructura y fiscal | – | – | – | – | – | – | – | – | – | – | – | – |
| M21 Usuarios y roles | – | – | V | – | V | – | V | – | V | – | – | V C X |
| M22 Módulos | V | V | V | V | V | V | V | V | V | V | V | V E |
| M22b Integraciones y desarrollo | – | – | – | – | – | – | – | – | – | – | – | V C E |
| M23 IA | V C | V C | V C A | C | C A | C | C A | C | C A | C | C | V C A E |
| M24 Puesta en marcha | – | – | – | – | – | – | – | – | – | – | – | V C E |

### 2.2 Central (sociedad / grupo)

DirOps = operations_director · Rev = revenue · Cont = accountant · DirFin = controller · RRHH = payroll_hr · Cumpl = compliance · Act = asset_manager · DG = general_manager · Prop = owner · Aud = auditor · Adm = admin. ³ Versión 3 (fusión TL): solo `pms.reservation.read` + `guests.read` para el Live Timeline de Hoy.

| Módulo | DirOps | Rev | Cont | DirFin | RRHH | Cumpl | Act | DG | Prop | Aud | Adm |
|---|---|---|---|---|---|---|---|---|---|---|---|
| M1 Reservas | V | V | V | V | V³ | V | V³ | V | V | V | V³ |
| M2 Folios y cobros | V | – | V | V A X | – | V | – | V A | V | V | – |
| M3 Facturación | V | – | V C E S | V A X | – | V | – | V | V | V | – |
| M4 Cierre del día | V | – | V A | V A X | – | – | – | V | – | V | – |
| M5 Pisos | V | – | – | – | – | – | – | V | – | V | – |
| M6 Mantenimiento | V | – | – | – | – | V | V | V | V | V | – |
| M7 TPV y A&B | V | – | V | V | – | – | – | V | V | V | – |
| M8 Compras | V A | – | V C E | V A | – | – | – | V A | V | V | – |
| M9 Facturas proveedor | V A | – | V C | V A X | – | – | – | V A | V A | V | – |
| M10 Contabilidad | V | – | V C E P | V A | – | V | V | V | V | V | – |
| M11 Tesorería | V | – | V E | V | – | – | – | V | V | V | – |
| M12 Nóminas y personal | V A | C | V | V | V E P | – | – | V A | V | V | – |
| M13 Inmovilizado/CAPEX | V S | – | V E | V A | – | – | V S E | V A | V A | V | – |
| M14 Gestión del activo | V | – | V | V E | – | V E | V C E P | V | V | V | – |
| M15 Cumplimiento | V | – | V | V | – | V C E X P | V | V | V | V | – |
| M15b Config. cumplimiento | – | – | – | – | – | E | – | – | – | – | – |
| M16 Revenue | V A | V C E A P | – | V | – | – | – | V A | V | V | – |
| M17 Comercial y CRM | V | V | – | V | – | – | – | V | V | V | – |
| M18 Informes | V C P | V C P | V P | V C P | V | V | V C | V C P | V C | V P | V |
| M18b Cuadro del propietario | V C | – | – | V | – | – | V | V C | V C | V | – |
| M19 Configuración | V E | V | V | V | – | V | – | V E | V | V | V E |
| M20 Estructura y fiscal | V | – | V | V E | – | V | V | V E | V | V | E (solo `organization.structure.manage`) |
| M21 Usuarios y roles | V C X | – | – | – | – | – | – | V C X | V | V | V C E X |
| M22 Módulos | V | V | V | V | V | V | V | V E | V | V | V E |
| M22b Integraciones y desarrollo | V | – | V | V | – | V | – | V | – | V | V C E |
| M23 IA | V C A | V C A | V C A | V C A | C A | V C A E | C A | V C A E | C | V | C A E |
| M24 Puesta en marcha | V C E A | – | – | – | – | – | – | V A | – | V | V C E A X |

Lectura rápida: `V` en M18 y M22 en todas las plantillas (invariantes de
`tests/rbac-nav-contract.test.mjs`); `modules.enable` solo DirH, DG y Adm;
`accounting.entity.read` y `backoffice.access` (M20 V) solo en plantillas de
ámbito sociedad/organización; `folio.read`, `pos.read` y `tourist_tax.read` no
llegan a Pisos, Mantenimiento, Revenue ni Comercial.

---

## 3. Cómo dar de alta a una persona

Pantalla: **Configuración › Usuarios y roles** (`/configuracion/usuarios`,
token `direccion` / `sistemas` / plataforma). Pestañas «Este hotel» (ámbito
`property` de la propiedad activa) y «Sociedad» (visible con `users.read` en
ámbito `legal_entity` u `organization`; lista a **toda** persona con una
asignación viva en la organización, sea de hotel, grupo, sociedad u
organización — corrector 8a · FSOD-02). «Cambiar rol» crea primero la
asignación nueva y después revoca la anterior del mismo ámbito: si la nueva
se rechaza (409 `RBAC_SOD_CONFLICT`, 403 de nivel o ámbito) nadie se queda sin
rol, y el cajón no envía mientras pinte un aviso de nivel o de separación de
funciones (FX-05). Una dirección de operaciones sin
`organization.structure.manage` asigna a sus propios grupos (los `ref` de
`profile.scopes`, FX-07). La tabla muestra la plantilla RBAC
real (`Role.templateKey`, nunca el texto libre `UserDepartment.roleLabel`),
nivel, ámbito, hoteles, último acceso, estado y 2FA.

### 3.1 Invitar con ámbito

1. Elegir plantilla (solo las de nivel ≤ el propio: el selector oculta las
   demás y la API responde 403 `RBAC_LEVEL_EXCEEDED`), ámbito (contenido en el
   propio: 403 `RBAC_SCOPE_EXCEEDED`) y caducidad (≤ 7 días,
   `INVITATION_MAX_DAYS`).
2. API: `POST /backoffice/properties/:propertyId/users/invite` (`users.invite`,
   riesgo high) con `{ email, fullName, roleId, scopeType, scopeRef, expiresAt? }`.
   `scopeType` ∈ `property | property_group | legal_entity | organization`;
   `scopeRef` = id de la propiedad, del grupo, de la sociedad o de la
   organización (`UserInvitation.scopeType/scopeRef/invitedByUserId`). Sin
   `scopeType` la invitación es `property` sobre el `:propertyId` de la ruta.
3. Rechazos: 409 `ROLE_WITHOUT_PERMISSIONS` (rol vacío sin plantilla), 409
   `RBAC_SOD_CONFLICT` (la nueva asignación, unida a las que ya tiene la
   persona, viola un par de §5.1), 403 `RBAC_BREAK_GLASS_FORBIDDEN` (la
   plantilla `break_glass` no se asigna a personas), 403
   `RBAC_SELF_ASSIGNMENT` (nadie se invita ni se asigna a sí mismo).
4. Auditoría: `USER_INVITED`. Reenviar: `POST
   /backoffice/properties/:propertyId/users/:userId/reissue-invite` (el token
   nunca viaja en el listado; se emite uno nuevo).

### 3.2 Aceptación, contraseña y 2FA

- Al aceptar el enlace se crea la asignación en `user_role_assignments`
  (`validFrom` = ahora, `grantedByUserId` = quien invitó) y se audita
  `USER_INVITATION_ACCEPTED`.
- `mustChangePassword = true`: la primera sesión obliga a cambiar la
  contraseña de un solo uso.
- **2FA (TOTP) obligatoria para rango ≥ 2** (`supervisor` en adelante, D8):
  `POST /auth/mfa/challenge` + `POST /auth/mfa/verify` en el primer acceso; sin
  2FA activa la sesión no pasa de la pantalla de alta. Los operativos (N1)
  entran con contraseña y, si su hotel usa PIN de supervisor, nunca
  comparten login (PCI DSS req. 8).

### 3.3 Cambiar el rol, añadir un hotel o un grupo

- **Cambiar rol** (acción de la pantalla) = `POST /rbac/assignments`
  (`users.assign`, high) con la plantilla nueva en el mismo ámbito y
  `DELETE /rbac/assignments/:id` con motivo sobre la anterior. Dos eventos:
  `ROLE_ASSIGNED` y `ROLE_REVOKED`. Nunca se edita `roleLabel` (texto sin
  efecto RBAC).
- **Añadir hotel/grupo** = otra asignación: `POST /rbac/assignments { userId,
  roleId, scopeType: "property" | "property_group", propertyId |
  propertyGroupId, reason }`. Los grupos se consultan en `GET
  /rbac/property-groups` y se crean con `organization.structure.manage`.
- Los permisos por propiedad son la unión de todas las asignaciones que la
  cubren; las rutas de organización (sin propiedad) usan la unión de las
  asignaciones `legal_entity` / `organization`. Cada escritura incrementa
  `Organization.rbacVersion`, que invalida la caché de permisos de las
  sesiones vivas en la siguiente petición.
- `GET /users/me` expone `properties[].grantedPermissions`, `templateKeys` por
  propiedad y `scopes[]` (ámbitos expandidos a `propertyIds`).

### 3.4 Retirar de un hotel frente a desactivar al usuario

| Acción | Ruta | Efecto | Auditoría |
|---|---|---|---|
| **Retirar de este hotel** | `DELETE /rbac/assignments/:id { reason }` (`users.assign`) | Revoca **esa** asignación (`revokedAt`, `revokedByUserId`, `reason`); el usuario conserva las demás; se cierran sus sesiones en esa propiedad | `ROLE_REVOKED` |
| **Desactivar usuario** | `POST /backoffice/properties/:propertyId/users/:userId/disable` (`users.disable`, high) | `User.status = disabled` en **toda** la organización; cierra todas las sesiones; las asignaciones quedan con `validTo` | `USER_DISABLED` |
| Baja en nóminas | `POST /payroll/contracts/:id/deactivate` | Sella `validTo` en las asignaciones del centro (baja inmediata) | `ROLE_REVOKED` |

Nunca se borran filas de `user_role_assignments`: la revocación es una marca
con autor y motivo (retención de §7).

### 3.5 Qué ve cada rol al entrar (`roleHome` por token)

| Token | Plantillas | Aterrizaje | Mi día |
|---|---|---|---|
| `recepcion` | receptionist, night_auditor, front_office_manager | `/hoy` | sí |
| `pisos` | housekeeper, housekeeping_manager | `/hoy/operaciones` (móvil `/operaciones/pisos/mi-turno`) | sí |
| `mantenimiento` | maintenance, maintenance_manager | `/hoy/operaciones` (móvil `/operaciones/mantenimiento/mis-averias`) | sí |
| `fnb` | fnb, fnb_manager | `/hoy/operaciones` | sí |
| `comercial` | sales | `/hoy/direccion` | sí |
| `administracion` | admin_clerk | `/finanzas/facturacion` (bandeja de facturas de proveedor pendientes) | sí |
| `direccion` | manager, operations_director, general_manager, break_glass | `/hoy/direccion` | sí |
| `revenue` | revenue | `/hoy/direccion` | sí |
| `finanzas` | accountant, controller, compliance | `/hoy/direccion` | sí |
| `rrhh` | payroll_hr | `/finanzas/nominas` | no (Mi día no lista `rrhh`; desde la fusión TL sí ve Hoy › Live Timeline) |
| `activos` | asset_manager | `/finanzas/proveedores/inmovilizado` hasta que exista Finanzas › Activo inmobiliario (documento hermano) | no (sí ve Hoy › Live Timeline) |
| `propiedad` | owner | `/hoy/propietario` | sí |
| `auditoria` | auditor | `/configuracion/sistema` (Auditoría) | sí |
| `sistemas` | admin (organización) | `/configuracion/usuarios` | no (sí ve Hoy › Live Timeline) |
| `admin` | plataforma (`admin.tenants.manage`) | `/hoy/direccion` + `/desarrollo/*` | sí |

Con varios tokens decide la prioridad `ROLE_TOKEN_PRIORITY`: admin, sistemas,
direccion, propiedad, auditoria, finanzas, rrhh, activos, revenue, comercial,
administracion, recepcion, fnb, mantenimiento, pisos. La tarjeta «Pendientes
de aprobación» aparece en Mi día de todo rol con alguna clave `*.approve` /
`*_approve`. «Ver como…» (solo menú y router, nunca permisos) se ofrece a
quien tiene `users.assign` o `roles.manage` en el ámbito activo, limitado a
plantillas de nivel ≤ el propio, con banner «Viendo como … · solo menú».

---

## 4. Cómo cambiar umbrales

Rutas: `GET /rbac/thresholds` y `PUT /rbac/thresholds` — claves
`accounting.configure` **y** `ai.high_risk.confirm`, riesgo critical (la
confirmación de alto riesgo viaja en la petición). Quien edita umbrales nunca
edita los de su **propio** rol ni de su nivel (403, principio de
`RBAC_SELF_ASSIGNMENT`: nadie amplía sus propios límites). Fila
(`RoleThresholdDto`): `roleId` **o** `level` (nunca ambos), `action`, `tier`,
`maxAmount` (decimal como texto), `maxPct`, `currency`, `requiresSecondApproval`.
Las filas con `roleId` / `level` **se aplican** (corrector 8a · FSOD-04):
para la acción del `kind`, `tier` es el tramo máximo que ese rol o nivel
aprueba (recorta `TEMPLATE_MAX_TIER`, nunca lo amplía) y `maxAmount`, si
viene, el importe máximo; con varias asignaciones sobre la misma propiedad
decide la mejor (`approvalCapOfScope`). Ejemplo D3: `{ roleId: <Dirección de
hotel>, action: "refund", tier: "T2", maxAmount: "300.00" }` → un manager que
aprueba un reembolso de 2.500 € recibe 403 `RBAC_LEVEL_EXCEEDED`
`{ tier: "T3", maxTier: "T2", maxAmount: "300.00" }`.

Reglas que valida el `PUT` (rechazo 400 con el detalle):

- **T1 < T2 < T3 < T4** estrictos por acción y moneda; ningún importe negativo;
  todo a 0 o todo ∞ se rechaza (nada se podría hacer / nada se controlaría).
- **Doble aprobación solo > T4** (`requiresSecondApproval` en la fila
  `ABOVE_T4`): el segundo aprobador es de nivel `general_management` u
  `ownership` y nunca el solicitante ni el primer aprobador (`CHECK`
  `approval_requests_no_self_second`). Facturas de proveedor > 60.000 €
  (`DEFAULT_THRESHOLDS.secondApprovalAmount`) exigen segundo aprobador de
  **propiedad** (`ownership`).
- **Banda de tarifa** ± 15 % sobre BAR (`rateBandPct`): dentro de banda DirH
  puntual con motivo y Revenue en su plan; fuera de banda o masivo,
  `revenue.rates.approve` (DirOps/DG).
- **Descuentos** por porcentaje: `discountPctT1` = 10 % (operativo con código
  de motivo), `discountPctT2` = 25 % (supervisor); por encima, dirección.
- **Catálogos de motivos** (`adjustment_reason`, `void_reason`,
  `cancel_reason`, `rate_override_reason`, `reopen_reason`): al menos un motivo
  activo por catálogo; los edita DirFin o Adm.
- Cada `PUT` se audita y aparece en `GET /rbac/report` (§7).

Valores por defecto del seed (D2; `DEFAULT_THRESHOLDS`, EUR): T1 50 · T2 300 ·
T3 3.000 · T4 15.000 · segundo aprobador > 60.000 € (proveedor).

Acciones con umbral (`ThresholdAction`, 11): `folio_adjust`, `refund`,
`discount`, `invoice_cancel`, `day_reopen`, `rate_change`, `supplier_bill`,
`purchase_order`, `payroll`, `capex`, `accounting_export`. Tipos de solicitud
(`ApprovalKind`, 10) y sus claves:

| `kind` | Solicita (maker) | Aprueba (checker) | Umbral |
|---|---|---|---|
| `refund` | `payments.refund_request` | `payments.refund_approve` | `refund` |
| `folio_adjust` | `folio.adjust` | `folio.adjust_approve` | `folio_adjust` |
| `discount` | `pms.reservation.discount` | `pms.reservation.override` | `discount` (%) |
| `rate_change` | `revenue.manage_rates` | `revenue.rates.approve` | `rate_change` (%) |
| `supplier_bill` | `payables.create` | `payables.approve` | `supplier_bill` |
| `purchase_order` | `purchase_orders.create` | `purchase_orders.approve` | `purchase_order` |
| `payroll` | `payroll.manage` | `payroll.approve` | `payroll` |
| `capex` | `capex.create` | `asset.capex.approve` | `capex` |
| `invoice_cancel` | `invoice.cancel_request` | `invoice.cancel_approve` | `invoice_cancel` |
| `day_reopen` | `night_audit.review` | `night_audit.reopen` | `day_reopen` |

### 4.1 Operaciones × umbral (valores por defecto)

| Operación | ≤ T1 (50 €, motivo) | ≤ T2 (300 €) | ≤ T3 (3.000 €) | ≤ T4 (15.000 €) | > T4 |
|---|---|---|---|---|---|
| Ajuste de folio / rebate | Rec, AudN ejecutan | JRec aprueba | DirH aprueba | DirFin aprueba | DG + DirFin |
| Reembolso | — (siempre aprobado) | JRec aprueba, AdmH ejecuta | DirH aprueba, AdmH ejecuta | DirFin aprueba y ejecuta (si no es el solicitante) | DG + DirFin |
| Descuento en reserva | Rec ≤ 10 % con código | JRec ≤ 25 % | DirH | DirOps | DG |
| Anulación de factura | — | — | DirH aprueba (emisor ≠ aprobador) | DirFin | DG |
| Cierre del día | AudN corre; AdmH o Cont revisa a la mañana siguiente | — | DirH reabre con motivo (≤ 7 días) | DirFin reabre > 7 días | — |
| Cambio de tarifa | DirH puntual dentro de banda ± 15 % con motivo; Rev en su plan | — | — | DirOps/DG aprueban fuera de banda o masivo | — |
| Factura de proveedor (importe) | AdmH/Cont registran | — | DirH aprueba | DirFin aprueba | DG aprueba + Prop segundo aprobador > 60.000 € |
| Pedido de compra | Solicita quien necesita | JRec/Gob/EncM/JAB ≤ T2 | DirH ≤ T3 | DirOps | DG |
| Nómina | RRHH prepara; cambio salarial con autorización escrita | — | DirH aprueba variaciones de su hotel | — | DG aprueba el registro mensual; Cont contabiliza; DirFin paga |
| CAPEX | EncM/DirH proponen | — | — | DirFin ≤ T4 | DG + Prop (reserva FF&E) |
| Exportación contable / gestoría | — | — | Cont exporta tras `accounting.period.close` de DirFin; cada exportación auditada | — | — |

Cancelación y no-show con política (Tanda L3 · lote B, sin claves ni tipos de solicitud nuevos):

- **Penalización de cancelación / no-show** (línea `cancellation_fee` / `no_show_fee`, no sujeta, en el folio de la reserva): la carga `folio.charge.post`, comprobada ANTES de escribir nada (403 sin efectos secundarios; `pms.reservation.modify` sola cancela pero no penaliza). El folio se cierra solo si queda a saldo 0; con saldo permanece abierto y no bloquea el cierre del día.
- **Renuncia a la penalización** (`applyPolicy: false` con importe > 0; corrector L3 · DS-02): es un descuento del 100 % del importe renunciado y sigue los tramos del descuento de reserva de esta tabla: ≤ T1 (importe ≤ `discount.T1` = 50 € Y ≤ 10 % de la estancia) → Rec con `pms.reservation.discount` + motivo obligatorio (400 sin motivo); ≤ 25 % de la estancia → motor de aprobaciones `kind: discount` (JRec con `pms.reservation.override` dentro de su tramo, solicitud aprobada de otra persona o PIN de supervisor vía `supervisorAuthorizationId`); por encima → solo solicitud aprobada, sin PIN. 409 `APPROVAL_REQUIRED` antes de escribir nada; auditoría `RESERVATION_CANCELLATION_POLICY` con `policyWaived: true`, `waivedAmount` y `waiver { band, pct, tier, authorization }` más `APPROVAL_DECIDED` / `APPROVAL_CONSUMED` del motor. La primera noche de una estancia de dos (50 %) o el 100 % de una no reembolsable nunca se renuncian con la sola clave de recepción.
- **Una sola penalización por reserva** (corrector L3 · DS-01 / DS-03): una reserva ya cancelada o no presentada responde 409 `RESERVATION_NOT_ACTIVE` a /cancel y /no-show (nunca se apila una segunda línea), y las rutas heredadas `/apply-cancellation-fee` · `/apply-no-show-fee` (`folio.charge.post` + `pms.reservation.modify`) solo reparan una penalización que no llegó a asentarse en una reserva YA cancelada / no_show (409 `RESERVATION_STATUS_MISMATCH` en otro estado; idempotentes, `alreadyApplied`).
- **Folio de la penalización** (corrector L3 · FC-2): el folio saldado no se cierra hasta emitir la factura de la penalización (`pendingInvoice: true`; `POST /folios/:id/close` responde 409 `FOLIO_UNINVOICED_LINES`); recepción tiene `invoice.issue` para emitir la simplificada desde el folio.
- **No-show automático del cierre del día**: actúa con la autoridad de `night_audit.run` ya exigida al lanzar el cierre (el auditor nocturno recibe `pms.reservation.modify` solo en ese paso); auditoría con `autoNoShow: true` y `source: "night_audit"`.
- **Verificado por el integrador L3 por HTTP** (`:3903`, `RBAC_STRICT=true`, 2026-09-18; informe `docs/audits/TANDA-L3-DINERO-FISCAL-2026-09-18.md` §5.9): `recepcion.rias` crea reservas con precio desde tarifa, cobra (`payment.capture`, 201), emite la simplificada desde el folio (`invoice.issue`) y cancela con penalización; su renuncia (`applyPolicy: false` sobre 126,50 € = primera noche de 253,00) responde 409 `APPROVAL_REQUIRED { kind: discount, tier: T2 }` sin escribir nada; un segundo `/cancel` 409 `RESERVATION_NOT_ACTIVE`; `/apply-cancellation-fee` y `/apply-no-show-fee` sobre una reserva confirmada 409 `RESERVATION_STATUS_MISMATCH`. `contabilidad` lee el 303 y los libros (`accounting.reports.read`) y aprueba el arqueo (`accounting.journal.post`, cerrador ≠ aprobador) pero no cobra (403 `payment.capture`); `recepcion.rias` abre y cierra el arqueo (`pos.order.pay`) pero no lo aprueba (403 `accounting.journal.post`) ni lee el 303 (403 `accounting.reports.read`); Carmen lee el arqueo y el PDF; `direccion.rias` lee el preview de la penalización y el preflight del cierre. Todos los 403 en español con la clave que falta y auditados como `ACCESS_DENIED`.

---

## 5. Separación de funciones

### 5.1 Pares estáticos (`SOD_STATIC_PAIRS`)

Ninguna plantilla los contiene a la vez y ningún usuario puede acumularlos
sumando asignaciones (409 `RBAC_SOD_CONFLICT` al asignar; aviso en rojo en la
pantalla): {`invoice.issue`, `invoice.cancel_approve`}, {`payment.capture`,
`payments.refund_approve`}, {`payables.create`, `payables.approve`},
{`payables.approve`, `payables.pay`} salvo `controller` (paga lo que aprobó
**otro**: SoD dinámica), {`accounting.journal.post`, `payables.pay`},
{`banking.reconcile`, `payables.pay`}, {`payroll.manage`, `payroll.approve`},
{`purchase_orders.create`, `purchase_orders.approve`},
{`purchase_orders.receive`, `purchase_orders.approve`}, {`night_audit.run`,
`night_audit.review`}, y sistema ≠ finanzas: {`roles.manage` o
`permissions.manage`, cualquiera de `accounting.journal.post`, `payables.*`,
`payment.capture`, `payment.refund`, `payments.*`}. `users.assign` queda
fuera a propósito (DirH, DirOps y DG asignan dentro de su ámbito y sí tienen
dinero).

### 5.2 Reglas dinámicas (solicitante ≠ decisor ≠ ejecutor)

Se evalúan en el servicio sobre las **columnas de autor** de cada entidad
(`requestedByUserId`, `decidedByUserId`, `secondApproverUserId` en
`approval_requests`; quien emitió la factura, quien cobró el pago, quien
registró la factura de proveedor, quien solicitó o recepcionó el pedido, quien
corrió el cierre) y en base de datos (`CHECK approval_requests_no_self_decision`
y `approval_requests_no_self_second`): nadie decide lo que solicitó, el emisor
no anula su factura, quien registra no paga, quien solicita un pedido no lo
recepciona ni lo aprueba, quien corre el cierre no lo revisa ese día.

**Aprobación implícita (acotada).** Quien tiene la clave de aprobación del
`kind` (`APPROVAL_KIND_PERMISSION`), el importe cae dentro de su umbral
(`TEMPLATE_MAX_TIER` recortado por su fila de `role_thresholds`, tramo e
importe) y **no es autor** de la entidad, ejecuta sin solicitud previa y el
servicio deja la traza (`APPROVAL_REQUESTED` + `APPROVAL_DECIDED` con el
mismo actor). Nunca por encima de T4: ahí siempre hay solicitud, aprobador y
segundo aprobador distintos.

**Importe obligatorio y techo.** Los `kind` con dinero (refund, folio_adjust,
discount, supplier_bill, purchase_order, payroll, capex, invoice_cancel:
`APPROVAL_KIND_REQUIRES_AMOUNT`) exigen `amount` al solicitar y al ejecutar
(400 sin él): una solicitud sin importe nunca vale «cualquier importe» ni se
trata como T1 (corrector 8a · SEC-8A-01). Al consumir una solicitud aprobada,
su importe es un **techo**: una operación mayor responde 409
`APPROVAL_MISMATCH`. `rate_change` y `day_reopen` no llevan importe.

**Rango del decisor por `kind`.** Un módulo puede registrar una política de
decisión (`registerApprovalDecisionPolicy`): el cierre del día la usa para
que la reapertura de un día cerrado hace más de `NIGHT_AUDIT_REOPEN_WINDOW_DAYS`
(7) solo la apruebe dirección financiera o general (rango ≥
`general_management`; 403 `RBAC_LEVEL_EXCEEDED` para dirección de hotel), y
el ejecutor comprueba el rango de quien decidió (`minDeciderRank`, 409
`APPROVAL_MISMATCH` si no alcanza) — corrector 8a · FSOD-05.

### 5.3 Códigos de respuesta

| Estado | `details.code` | Cuándo |
|---|---|---|
| 403 | `RBAC_LEVEL_EXCEEDED` | asignar/retirar un rol de rango superior al propio |
| 403 | `RBAC_SCOPE_EXCEEDED` | ámbito fuera del propio (asignaciones, umbrales, grupos) |
| 403 | `RBAC_BREAK_GLASS_FORBIDDEN` | asignar `break_glass` a una persona, o conceder accesos desde una sesión de emergencia |
| 403 | `RBAC_SELF_ASSIGNMENT` | concederse permisos, ámbito o umbrales a uno mismo |
| 409 | `RBAC_SOD_CONFLICT` | la unión de asignaciones viola un par de §5.1 |
| 409 | `APPROVAL_REQUIRED` | la operación supera el umbral del actor y no lleva `approvalRequestId` aprobado |
| 409 | `APPROVAL_SELF_DECISION` | aprobar o rechazar la propia solicitud (antes del `CHECK`) |
| 409 | `APPROVAL_MISMATCH` | la aprobación no corresponde a esa entidad, importe o `kind` |
| 409 | `APPROVAL_EXPIRED` | solicitud caducada (`expiresAt`); hay que volver a solicitar |
| 409 | `PAYROLL_NOT_APPROVED` | `POST /payroll/periods/:id/pay` sin `payroll.approve` previo del registro |
| 403 | `SUPERVISOR_PIN_INVALID` / `SUPERVISOR_PIN_LOCKED` | PIN incorrecto / bloqueado 15 min tras 5 fallos |
| 403 | `BREAK_GLASS_REAUTH_REQUIRED` / `BREAK_GLASS_ACCOUNT_MISSING` | abrir emergencia sin re-autenticarse / sin cuenta disponible |
| 404 | (opaco) | propiedad, grupo, sociedad o entidad fuera del ámbito del usuario: la respuesta no distingue «no existe» de «no es tuyo» |
| 403 | (manifiesto) | clave que falta en la ruta, o GET sin entrada con `RBAC_STRICT=true`; se audita `ACCESS_DENIED` (máx. 1 por minuto por usuario y ruta) |

Los mensajes en español de cada código están en `RBAC_ERROR_MESSAGES_ES`.

### 5.4 Bandeja de aprobaciones (`/hoy/pendientes`)

`GET /approvals` (filtrada por ámbito y por la clave de aprobación del
usuario), `POST /approvals/:id/approve` y `POST /approvals/:id/reject` con
motivo (riesgo critical; la clave exigida es la del `kind`). La tarjeta muestra
el umbral aplicable y, si procede, el segundo aprobador. Escalado automático al
siguiente nivel a los 30 minutos si nadie decide; caducidad en `expiresAt`.

### 5.5 PIN de supervisor (`POST /rbac/supervisor-authorizations`)

Cuando un operativo pulsa una acción que exige `*.override` / `*_approve` que
no tiene, el diálogo pide usuario + PIN de un supervisor **presente**. La
autorización dura **60 s** (`SUPERVISOR_AUTHORIZATION_TTL_SECONDS`), es de **un
solo uso** (`usedAt`) y va **ligada a la acción** (`permissionKey`,
`entityType/entityId`, `amount`): reutilizarla en otra entidad responde 409
`APPROVAL_MISMATCH`. Cinco fallos seguidos bloquean el PIN 15 minutos
(`SUPERVISOR_PIN_LOCKED`). Cada persona fija su PIN desde el **menú de usuario
› «Mi PIN de supervisor»** (`components/SupervisorPinSettingsDialog.tsx`,
`POST /rbac/pin` con su contraseña; también desde su fila de Usuarios y roles
si ve esa pantalla): los supervisores N2 (jefatura de recepción, gobernanta,
encargado de mantenimiento, jefatura de A&B) no abren Usuarios y roles, por
eso el punto de ajuste vive en el menú (corrector 8a · FX-02).
`User.pinHash`, `pinUpdatedAt`. Evento `SUPERVISOR_AUTHORIZED` con actor,
autorizador, motivo, importe e IP. En el front el diálogo de PIN se monta en la
**acción** del operativo (FX-03): la devolución de un cobro
(`components/billing/RefundDialog.tsx`) que recibe 409 `APPROVAL_REQUIRED`
ofrece «Autorizar con PIN de supervisor» y reenvía `supervisorAuthorizationId`;
las rutas de reserva (`discountReasonCode`, `supervisorAuthorizationId`),
reembolso y anulación de factura aceptan ya esos campos (FSOD-06). La bandeja
de aprobaciones no monta el PIN (las decisiones solo admiten `note`).

### 5.6 Descuentos, anulaciones y exportaciones

- **Descuento de reserva**: `pms.reservation.discount` hasta el 10 % con
  código de motivo; hasta el 25 % lo aprueba `pms.reservation.override`
  (supervisor, también por PIN); por encima, solicitud `discount` a
  dirección. Override de tarifa, restricción u overbooking = misma clave, con
  motivo de `rate_override_reason`.
- **Ticket TPV**: `pos.order.void` (`POST /pos/tickets/:id/void`) solo sobre
  tickets del día y con motivo; evento `POS_TICKET_VOIDED`.
- **Anulación de factura**: registro de anulación / rectificativa (RD
  1007/2023 art. 11), nunca borrado; `invoice.cancel_request` → aprobación
  `invoice.cancel_approve` de alguien que no la emitió → `invoice.cancel`.
- **Exportaciones contables** (`analytics.export` a la gestoría,
  `workforce.payroll_export`, `guest_register.export`, `crm.export`): cada
  exportación se audita (`ACCOUNTING_EXPORTED` en contabilidad) con el periodo
  y el actor; si el periodo fiscal sigue abierto (sin `accounting.period.close`
  de DirFin) el fichero sale marcado **provisional**.

---

## 6. Break glass (acceso de emergencia auditado)

- **Cuentas**: dos por organización, sin persona (`emergencia-1@…`,
  `emergencia-2@…`), rol «Emergencia» (`break_glass`, creado solo por
  `ensureBreakGlassRole`), **no entran por contraseña** (login directo
  rechazado), excluidas de invitaciones, de «Ver como» y de la pantalla de
  usuarios. Credencial de custodia en sobre o gestor de secretos con **doble
  custodia** (dos personas para abrir).
- **Abrir**: `POST /rbac/break-glass` (`security.break_glass`, critical) desde
  una sesión real de Dirección general o Administración de sistema con
  `{ reason, ticket, password, confirmHighRisk: true, mfaCode? }`: la
  contraseña es la del abridor (re-autenticación, si falta 403
  `BREAK_GLASS_REAUTH_REQUIRED`), `confirmHighRisk` es la confirmación de alto
  riesgo y el reto MFA se exige si el abridor tiene 2FA (rango ≥ 2, siempre).
  Sin cuenta libre: `BREAK_GLASS_ACCOUNT_MISSING`.
- **Sesión**: máximo **4 h** (`BREAK_GLASS_MAX_SESSION_HOURS`), las 249 claves
  de organización (nunca `admin.tenants.manage`), `correlationId` de emergencia
  en cada petición; **no puede conceder accesos** (`users.assign`,
  `users.invite`, `roles.manage`, `permissions.manage`, umbrales y `POST
  /rbac/break-glass` responden 403 `RBAC_BREAK_GLASS_FORBIDDEN`).
- **Eventos**: `BREAK_GLASS_OPENED` (+ notificación inmediata a DG, Adm y
  Aud), `BREAK_GLASS_CLOSED` al cierre manual (`POST
  /rbac/break-glass/:id/close`) o automático a las 4 h.
- **Revisión en 24 h** (`BREAK_GLASS_REVIEW_HOURS`): tarea en la bandeja de
  Auditoría interna; se sella `reviewedByUserId/reviewedAt` en
  `break_glass_sessions`. La revisan **solo** dirección general,
  administración de sistema o auditoría interna con asignación viva (las
  plantillas que reciben la alerta y pueden cerrarla), nunca quien abrió la
  sesión ni la propia sesión de emergencia; un supervisor de hotel con
  `audit.read` recibe 403 `RBAC_SCOPE_EXCEEDED` (corrector 8a · SEC-8A-04).
  Una sesión sin revisar pasadas 24 h aparece en rojo en `GET /rbac/report`
  (informe de organización: exige asignación de sociedad u organización; el
  registro de accesos se filtra por las propiedades del llamante, SEC-8A-03).
  Una sesión de emergencia tampoco recompone los grupos de propiedades
  (`POST/PATCH /rbac/property-groups` → 403 `RBAC_BREAK_GLASS_FORBIDDEN`,
  FSOD-08).
- **Simulacro cada 180 días** (`BREAK_GLASS_DRILL`): abrir, comprobar la
  alerta, cerrar y revisar; el evento distingue el simulacro del uso real.

---

## 7. Revisión trimestral y retención (PCI DSS req. 7)

Cada trimestre, Auditoría interna (o DG si no hay persona, D7) con `audit.read`:

1. `GET /rbac/report`: roles y claves configurados por organización
   (`RbacReportDto`): plantilla, nivel, `managed`, `templateVersion`, claves,
   `extraKeys` / `missingKeys` (roles personalizados), asignaciones, conflictos
   SoD, roles con permisos idénticos (candidatos a fusión) y umbrales vigentes.
2. `GET /rbac/access-log`: `ACCESS_DENIED`, `ROLE_ASSIGNED/REVOKED`,
   `ROLE_TEMPLATE_UPGRADED`, `ROLE_PERMISSIONS_EDITED`, `USER_DISABLED`,
   `PROPERTY_SWITCHED`, `APPROVAL_*`, `SUPERVISOR_AUTHORIZED`,
   `BREAK_GLASS_*`, `LOGIN_FAILED` (`RBAC_AUDIT_ACTIONS`), con `ipAddress` y
   `deviceId` siempre rellenos.
3. Revisar: asignaciones sin uso (último acceso > 90 días), personas con
   varias plantillas, sesiones de emergencia sin revisar, umbrales cambiados,
   accesos denegados repetidos (mala asignación o intento).
4. Contraste rápido en SQL (solo lectura):

   ```sql
   SELECT r.template_key, r.level, r.managed, r.template_version, count(a.id) AS asignaciones
   FROM roles r LEFT JOIN user_role_assignments a ON a.role_id = r.id AND a.revoked_at IS NULL
   WHERE r.organization_id = '<org>' GROUP BY 1, 2, 3, 4 ORDER BY 1;
   SELECT count(*) FROM break_glass_sessions WHERE reviewed_at IS NULL AND opened_at < now() - interval '24 hours';
   ```

**Retención**: los `audit_events` de accesos se conservan **6 años** (D9),
dentro de la misma cadena hash que el resto de la auditoría; no hay purga a
30-180 días ni se borran asignaciones revocadas.

---

## 8. Variables de entorno y cabeceras

| Variable | Valor | Efecto |
|---|---|---|
| `RBAC_STRICT` | `true` (producción por defecto; explícito también en el demo local) | GET sin entrada en el manifiesto → 403; mutación sin entrada → 403 siempre. `false` solo como opt-out explícito en desarrollo |
| `HOTELOS_DEMO_PERMISSION_UNION` | `false` (valor por defecto; `productionForbidden`) | `true` une a cada sesión real la baseline demo (208 claves) y enmascara el RBAC: solo para el walkthrough antiguo, nunca en un despliegue de cliente. Desacoplada de `NODE_ENV` y de `HOTELOS_ALLOW_DEMO_AUTH` |
| `HOTELOS_ALLOW_DEMO_AUTH` | `true` solo en la demo | Fallback sin token al super-usuario del demoStore; sigue recibiendo 401 en rutas high/critical; con `NODE_ENV=production` el API no arranca |
| Cabecera `x-property-id` | id de la propiedad activa | La envía `api-client` en rutas sin `:propertyId`; la API calcula los permisos para **esa** propiedad (parámetro de ruta > entidad resuelta > cabecera > `null` = ámbito organización). Fuera del ámbito del usuario: 404 opaco |

Orden del `preHandler` del API: `is404 → autenticación → propiedad de la
petición → permiso (manifiesto) → tenencia`.

---

## 9. Decisiones D1-D10 y valor adoptado

| # | Decisión | Valor adoptado en la Tanda 8a |
|---|---|---|
| D1 | Carmen (`direccion@farandariasaltas.es`): propiedad, dirección general o ambas | `owner` (estrechada) **+** `general_manager`, ámbito `organization` (sigue viéndolo todo y aprueba ≤ T4 y > T4) |
| D2 | Umbrales y bandas | T1 50 · T2 300 · T3 3.000 · T4 15.000 € · doble > 60.000 € (proveedor) · banda ± 15 % · descuento 10 % / 25 %; editables por organización (§4) |
| D3 | Subdirección | Sin plantilla propia: `manager` con umbrales T2 en `role_thresholds` |
| D4 | Quién corre y quién revisa el cierre del día | `night_auditor` corre (en un hotel sin auditoría nocturna propia, `front_office_manager` también lleva `night_audit.run`); `admin_clerk` (o `accountant` si no hay) revisa a la mañana siguiente; `manager` reabre ≤ 7 días, `controller` > 7 días. Tanda L5 (L5-D): el preflight es una puerta del API — con bloqueos, quien tiene `night_audit.run` puede cerrar de todos modos SOLO con un motivo (≥ 10 caracteres) que queda en `audit_events` (`NIGHT_AUDIT_PREFLIGHT_OVERRIDDEN`: quién, cuándo, qué bloqueos, motivo) y en el informe del cierre; reabrir ese día exige `night_audit.reopen` (`manager` ≤ 7 días desde la fecha de negocio; después la aprobación `day_reopen` de otra persona con rango ≥ dirección general — `controller` / `general_manager`) y nunca revierte cargos ni asientos |
| D5 | Grupos de propiedades | Dos grupos de ejemplo en el seed: Galicia (LT + RA) y Asturias-Cantabria (PG + MC + AS); cualquier reparto es tabla, no código |
| D6 | Plantilla `admin` de organización | Se conserva como «Administración de sistema» sin claves financieras ni operativas, token `sistemas`; 22 plantillas por organización (sin `admin` ni `break_glass`) |
| D7 | Asset manager y auditoría interna como personas | Plantillas creadas y usuarios de demo ficticios; si no hay personas, no se asignan (las claves `real_estate.*` las cubren `controller`/`compliance`) |
| D8 | 2FA / PIN | TOTP obligatoria para rango ≥ 2; PIN de supervisor en recepción; login compartido prohibido |
| D9 | Retención de `audit_events` de accesos | 6 años, en la cadena hash común |
| D10 | Nóminas de la gestoría | Dirección general aprueba el registro mensual; dirección de hotel las variaciones de su hotel |
