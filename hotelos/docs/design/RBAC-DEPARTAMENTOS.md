# RBAC · Departamentos, niveles y ámbito — mínimo privilegio, separación de funciones y gestión del activo

Diseño de la **Tanda 10 · RBAC por departamento y nivel** para el encargo de César (2026-09-17): «limitar el acceso a los distintos módulos dependiendo del usuario: los recepcionistas solo pueden ver lo que atañe a sus funciones, igual los administrativos, el director del hotel, el director de operaciones, el director general», más el módulo de **gestión del activo** (finca, documentación legal, planos, proyectos, licencias, impuestos de la propiedad) cuando la sociedad es propietaria. Faranda = CELUISMA S.A., oficina central + 7 centros hoteleros bajo un NIF (8 `Property` en la BD local: OC office + AS, FN, LL, LT, MC, PG, RA hotel [V SQL]). Fecha: 2026-09-17. Este documento fija el modelo objetivo del control de acceso; el módulo de gestión del activo se diseña en su documento hermano y aquí solo se le asignan claves, plantillas y ámbito. Se apoya en la Tanda 6b (`docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md`: `LegalEntity`, centros, ámbito R11) y en la Tanda 9 (`docs/design/DOCUMENTOS-DIGITALIZACION.md` §4.2/§8: almacén de documentos, pendiente de construir).

Leyenda: **[V]** verificado (código leído con fichero:línea, SQL sobre la BD local, cálculo sobre el manifiesto/el árbol, o fuente oficial citada: BOE, docs de OPERA Cloud/Mews) · **[S]** supuesto o decisión de diseño pendiente de confirmar con César.

Fuentes de trabajo: `packages/shared/src/permissions.ts` (catálogo 3-232, plantillas 318-743, claves de plantilla 747-759, etiquetas 768-780, `ORGANIZATION_TEMPLATE_ROLE_KEYS` 804-815, `assertPermissions` 838), `packages/shared/src/types.ts:275-288` (`RoleKey`), `apps/api/src/lib/rbac-catalog.ts` (`syncPermissionCatalog` 101, `applyRoleTemplate` 226, `createRoleFromTemplate` 347, `provisionDefaultTemplateRoles` 461, `ensureRoleHasPermissions` 526, `backfillTemplateRoles` 700), `apps/api/src/security/route-permissions.ts` (manifiesto 118-1358, `assertRoutePermission` 1421-1444), `apps/api/src/server.ts:1356-1363,1410`, `apps/api/src/modules/auth/auth.service.ts` (61, 81, 86, 116-147, 328, 340, 430), `apps/api/src/lib/{tenancy.ts:93-125, finance-scope.ts:189-249, env.ts:248-278, auth-context.ts:170-242}`, `apps/api/src/modules/backoffice/backoffice.service.ts` (5052, 5095, 5156-5199, 5237-5247), `apps/api/src/modules/payables/route-permissions.partial.ts:18-26`, `apps/api/src/modules/night-audit/route-permissions.partial.ts:10-14`, `packages/database/prisma/schema.prisma` (`User` 433, `UserInvitation` 460, `UserDepartment` 728, `Role` 2838, `Permission` 2850, `RolePermission` 2858, `UserPropertyRole` 2867, `AuditEvent` 4684), `apps/admin-web/src/navigation/{role-tokens.ts, nav-tree.generated.json, useEnabledModules.ts, Sidebar.tsx, view-as.ts}`, `apps/admin-web/src/routes/backoffice.routes.tsx:406-421`, `apps/admin-web/src/screens/UserRoleManager.tsx`, `tests/{rbac-nav-contract, api-route-permissions-contract, nav-tree-contract}.test.mjs`, `docs/runbooks/{rbac-sync.md, navegacion-tanda-5.md}`, `.env` local y la BD local (SELECT).

---

## §1 · Resumen y principio de mínimo privilegio

1. **Principio.** Cada usuario recibe, por defecto, **nada** («No permissions», patrón Mews) y solo las claves que su puesto necesita en el hotel o sociedad donde trabaja; toda acción sensible (anular, reembolsar, descontar, cerrar el día, cambiar tarifas, aprobar facturas, nóminas, exportar) es una clave propia (patrón OPERA: la acción crítica como tarea aparte) y se ejecuta con motivo codificado y traza; nadie aprueba lo que solicitó ni se concede permisos a sí mismo (NIST SoD estática y dinámica; PCI DSS req. 7 «deny by default», revisión trimestral). Base normativa española que lo exige de facto: RD 1007/2023 art. 8/11 (anulación = registro, nunca borrado; registro de eventos), RD 933/2021 (registro de viajeros 24 h / 3 años), LOPDGDD art. 31 [V fuentes externas de la investigación].
2. **Dos dimensiones, una fuente de verdad.** El rol es **plantilla × nivel** (qué puede hacer) y la asignación es **plantilla × ámbito** (dónde): propiedad, grupo de propiedades, sociedad u organización. Menú, router del front y API leen la **misma** decisión (`templateKey` + ámbito + módulos activos); ninguna lista paralela.
3. **Lo que ya existe se conserva** [V §3]: catálogo de 223 claves, 10 plantillas por organización, roles por propiedad (`UserPropertyRole`), manifiesto ruta → claves con `riskLevel`, `RBAC_STRICT`, `rbac:sync`, navegación por tokens y los dos contratos de test. Esta tanda **añade** niveles, ámbitos, 12 plantillas, 27 claves (maker/checker, cierre del día, proveedores, nóminas, tarifas, 4 del activo inmobiliario con los nombres del documento hermano, 3 de lectura para plantillas de solo lectura, break glass), umbrales parametrizables y doble aprobación.
4. **Huecos que cierra** [V §3.4]: permisos calculados solo para la primera propiedad del usuario; sin ámbito multi-hotel ni sociedad; sin niveles (jefe/auxiliar); «Cambiar rol» que escribe texto libre sin efecto RBAC; sin endpoint para cambiar o retirar una asignación; plantillas con conflicto inherente (emitir + anular factura, cobrar + reembolsar, asentar + conciliar + nóminas); aprobaciones sin cuatro ojos; claves maker/checker muertas; top-up de arranque que nunca estrecha; modo demo que enmascara el RBAC en local; router del front que no consulta roles.
5. **Separación de funciones con umbrales** (§4.7): solicita ≠ aprueba ≠ ejecuta; T1 operativo con motivo, T2 supervisor, T3 dirección de hotel, T4 dirección financiera/operaciones, > T4 dirección general + propiedad (doble aprobación). Los importes son parámetros por organización (ningún PMS trae cifras [V investigación]); los propuestos son [S].
6. **Break glass** (§4.8): dos cuentas de emergencia sin persona, sesión limitada con motivo, alerta inmediata y revisión en 24 h; nunca una plantilla «admin con todo» de uso diario.
7. **Ámbito por petición**: la API calcula los permisos para la propiedad sobre la que se actúa (parámetro de ruta, entidad resuelta o cabecera `x-property-id`), no para la primera asignación; la sociedad y el grupo son ámbitos de asignación reales, no efectos colaterales de «usuario sin asignaciones».
8. **Navegación**: 6 tokens nuevos (`administracion`, `rrhh`, `propiedad`, `activos`, `auditoria`, `sistemas`) en el CSV del árbol; el token `admin` queda solo para plataforma; el router aplica la misma `accessDecision` que el menú; «Ver como» disponible para quien gestiona usuarios en su ámbito; pantalla de usuarios y roles por hotel y por sociedad con el rol RBAC real, asignaciones multi-hotel, invitaciones con ámbito y caducidad.
9. **Migración sin sorpresas**: `user_property_roles` se conserva y se lee en unión con la tabla nueva hasta el último lote; backfill de Faranda (Carmen Owner ×8 → una asignación de organización) y de la demo; `RBAC_STRICT=true` también en local; unión demo desacoplada de `NODE_ENV`; `rbac:sync --prune` solo para `capex.approve` (muerta y sustituida), tras `--dry-run` y copia; las 12 claves sin ruta ni servicio se cablean, no se podan.
10. **Entregables**: schema + migración, versión de plantilla con revocación controlada, motor de aprobaciones, 5 rutas de asignaciones + 4 de aprobaciones + 2 de break glass, front (usuarios y roles, bandeja de aprobaciones, PIN de supervisor), 19 usuarios ficticios de Faranda, contratos ampliados (`rbac-nav`, `api-route-permissions`, nuevo `rbac-sod-contract`).

### 1.1 Alternativas descartadas

| Alternativa | Por qué se descarta | Conf. |
|---|---|---|
| Un rol «director de operaciones» asignado hotel a hotel con `UserPropertyRole` repetido (como Carmen hoy: 8 filas) | Sin ámbito real no hay consolidado ni alta/baja de hoteles en bloque; los permisos siguen calculándose para la primera fila (`auth.service.ts:123-130`) | V |
| Filtrar el menú por permiso en vez de por token (`permissionsAny` en el CSV) | Rompe la premisa fijada por `tests/rbac-nav-contract.test.mjs:17-22,631` y `docs/runbooks/navegacion-tanda-5.md:253-257`; el token sigue siendo suficiente si cada plantilla nueva tiene token y la prueba «cada plantilla abre todas sus GET» se amplía | V |
| Umbrales como claves distintas (`payment.refund_100`, `_500`…) | Explosión de claves y de plantillas; OPERA/Mews son binarios por tarea y los importes vienen de SOP: tabla `role_thresholds` por organización | V |
| Borrar `user_property_roles` en la primera migración | 6 escritores en producción (`auth-pilot.service.ts:234`, `invitations.service.ts:466`, `backoffice.service.ts:5198`, `tenant-admin.service.ts:696`, `property-provisioning.service.ts:850`, `bootstrap.service.ts:228` [V]); dual-read hasta L6 | V |
| Impersonación real («Ver como» con permisos del servidor) | Riesgo de exfiltración y de auditoría ambigua; «Ver como» simula solo el menú (hoy ya así, `view-as.ts:70`) y las aprobaciones se prueban con usuarios de demo | V |
| Plantilla `admin` de organización con las 222 claves | Colisiona con el token de plataforma (`role-tokens.ts:75`) y rompe la SoD «sistema ≠ finanzas»; se convierte en «Administración de sistema» sin claves financieras | V |

---

## §2 · Funciones por departamento y puesto (investigación)

Marco: áreas funcionales y grupos profesionales del ALEH VI (BOE-A-2023-6344, arts. 12, 14 y 17: Grupo 1 mando «con propia iniciativa», Grupo 2 «ejecución autónoma», Grupo 3 «bajo dependencia y supervisión»), departamentos USALI (Rooms, F&B, A&G, S&M, POM, Non-operating), tareas de OPERA Cloud (Bookings, Financials, Inventory, Reports) y permisos de Mews, SOP de rebates/income audit y controles de Lund/HFTP [V fuentes de la investigación «departamentos» y «rbac-pms»]. Filas = puestos objetivo de ehotelOS; el mapeo a plantillas es [S].

| Departamento · puesto (ALEH grupo) | Ve | Hace | No puede |
|---|---|---|---|
| Recepción · Recepcionista (G2) | Llegadas/salidas/in-house, tablero, folio del huésped (tarjeta enmascarada), tarifas vigentes, partes de viajeros, informes de su turno | Reservas, check-in/out, cargos, cobros, enlaces de pago, registro de viajeros y envío SES, descuento ≤ T1 con motivo, ajuste de folio ≤ T1, solicitar reembolso, parte de avería, fichar | Anular pago o factura, reembolsar, override de tarifa/restricción/overbooking, cerrar el día, exportar listados, informes de ingresos, contabilidad, nóminas, usuarios |
| Recepción · Auditor nocturno (G2, turno noche) | Lo de recepción + preflight y corridas del cierre, pack de ajustes/voids del día | Cierre del día (room & tax, no-shows, cuadre por departamento), ajustes de auditoría con motivo, factura del día | Verificar/depositar efectivo, aprobar rebates, reabrir un día cerrado, tocar días anteriores (Lund: cuadre ≠ depósito) |
| Recepción · Jefe/a de recepción (G1) | Todo recepción + cajas de su equipo, over/short, informes de cajero, cancelaciones masivas | Aprobar descuentos/ajustes/reembolsos ≤ T2, override de tarifa/restricción/overbooking con motivo (también por PIN a petición de un recepcionista), anular ticket del día, reinstatar reservas, turnos de recepción | Aprobar sus propios ajustes, cerrar/ reabrir el día, pagar proveedores, nóminas, cambiar plantillas de tarifas |
| Pisos · Camarera/o de pisos (G2/G3) | Sus habitaciones asignadas, estado, cronograma sin datos de pago ni contacto | Cambiar estado sucia/limpia/repaso, parte de avería, objetos perdidos, fichar | Ver folios, tarifas, datos personales, cambiar reservas, OOO/OOS |
| Pisos · Gobernante/a (G1) | Ocupación prevista, llegadas VIP, estado global, partes, inventario de lencería/amenities | Asignar tareas, inspeccionar, OOO/OOS con motivo, pedidos a economato, recepción de lencería, turnos de pisos | Folios, tarifas, cobros, aprobar sus propios pedidos |
| Mantenimiento · Técnico (G2) / Auxiliar (G3) | Partes, OOO/OOS, plan preventivo, calendario de inspecciones | Ejecutar y cerrar sus órdenes, solicitar compra | Recibir o aprobar sus compras, cambiar estado de limpieza, tarifas |
| Mantenimiento · Encargado/a (G1) | Todo mantenimiento + energía, seguridad, activos técnicos, actas OCA/legionella | Planificar preventivo, solicitar y recibir compras, proponer CAPEX, subir actas e inspecciones al activo | Aprobar compras ni CAPEX, pagar, folios |
| A&B · Camarero/a, barman (G2) | Comandas, cartas, existencias de su punto | Tickets, cargo a habitación, cobro, recuento | Anular tickets cerrados, cambiar cartas/precios, compras |
| A&B · Jefe/a de sala o cocina (G1) | Todo A&B + cierre de caja del punto, mermas | Anular ticket con motivo, cartas y precios, pedidos y recepciones, inventario, turnos | Aprobar sus pedidos, pagar, contabilidad |
| Comercial (G1/G2) | Pipeline, cuentas, grupos, eventos, CRM, reputación, canales (lectura) | Ofertas, cupos de grupo, campañas, encuestas, responder reseñas, exportar CRM con traza | Cobrar, reembolsar, cambiar tarifas o restricciones, facturación |
| Administración de hotel · Administrativo/a (G2) | Facturas de proveedor, caja del hotel, extractos, tasa turística, recibos del inmueble | Registrar facturas y gastos, conciliar caja/depósitos, ejecutar reembolsos aprobados, revisar el pack del cierre (income audit), subir recibos IBI/tasas al activo, exportar a gestoría | Aprobar facturas, pagar, asentar, cerrar periodos, nóminas, tarifas, usuarios |
| Dirección de hotel · Director/a (G1) | Flash diario, P&L USALI del hotel, STR, forecast, pack de rebates/voids/comps, variaciones de nómina, accesos | Aprobar ajustes/reembolsos/descuentos ≤ T3 y facturas ≤ T3, comps, override puntual de tarifa dentro de banda, cerrar/reabrir el día con motivo, anular factura (registro de anulación), aprobar turnos y variaciones de nómina de su hotel, proponer CAPEX, invitar/asignar usuarios ≤ su nivel en su hotel | Procesar nóminas, pagar proveedores, asentar, editar días cerrados, autoconcederse permisos, anular la factura que emitió |
| Dirección de operaciones (multi-hotel) | Consolidado y comparativa de sus hoteles (KPIs, GOP, STR, incidencias, auditorías, accesos) | Aprobar presupuestos/forecasts, facturas ≤ T4, cambios de tarifa fuera de banda, contrataciones de jefes, usuarios de sus hoteles | Operar transacciones del PMS (solo lectura salvo override auditado), pagar, nóminas |
| Revenue corporativo | Tarifas, restricciones, canales, pace, forecast de todos los hoteles | Tarifas, restricciones, paridad, recomendaciones, exportes de revenue | Folios, caja, cobros, usuarios |
| Contabilidad central (jefe de administración, G1) | Diario, mayor, libros de IVA, bancos, inmovilizado de la sociedad | Asentar, registrar facturas, conciliar bancos, inmovilizado, exportar a gestoría, rectificativas | Aprobar facturas/pagos, ordenar remesas, cerrar periodos, nóminas, tarifas |
| Dirección financiera / controller | Todo finanzas de la sociedad, aprobaciones pendientes, ratios | Aprobar facturas ≤ T4, ordenar pagos/remesas, cerrar periodos, aprobar anulaciones y reembolsos > T3, reabrir un día | Registrar facturas, conciliar bancos, asentar manualmente (SoD con contabilidad) |
| RRHH / nóminas | Contratos, jornada, costes por centro | Preparar nóminas, cambios salariales con autorización escrita, exportar a la gestoría | Aprobar el registro de nómina (lo hace dirección), cambiar su propio salario |
| Cumplimiento | Registro de viajeros, SES, RGPD, obligaciones, licencias e inspecciones del inmueble | Configurar cumplimiento, anular partes, RGPD, tareas y documentos de obligaciones | Cobros, asientos, nóminas, tarifas |
| Gestión del activo (asset manager) | Finca, título y cargas, contratos, seguros, IBI/IAE, inspecciones, CAPEX, valoraciones, USALI bajo GOP | Mantener el expediente del inmueble, documentos, calendario de vencimientos, propuestas de CAPEX y reserva FF&E | Aprobar CAPEX (propiedad), operar el PMS, contabilidad |
| Dirección general | Todo en lectura + aprobaciones estratégicas | Presupuesto consolidado, CAPEX y reserva, facturas > T4, nóminas mensuales, contratación de directores, tarifas fuera de banda | Transacciones operativas, cambiar sus propios permisos |
| Propiedad | P&L USALI por hotel y consolidado bajo GOP (rentas, IBI, seguros, amortización), CAPEX, valor del activo | Aprobar CAPEX/presupuesto (HMA), ver documentación de la finca | Operar, pagar, usuarios |
| Auditoría interna | Todo en lectura, logs, informe «roles y claves configurados» | Exportar evidencias | Cualquier escritura |
| Administración de sistema | Usuarios, roles, módulos, integraciones, webhooks | Alta/baja de usuarios y asignaciones, plantillas, integraciones | Tareas financieras u operativas (SoD sistema ≠ finanzas) |

---

## §3 · Estado actual del RBAC de ehotelOS

### 3.1 Catálogo, plantillas y ámbito

| Pieza | Estado verificado |
|---|---|
| Catálogo | `PERMISSIONS` = **223 claves** (222 de organización + `admin.tenants.manage`, `permissions.ts:231`), **81 prefijos**; `isPlatformPermission` = `admin.*`/`platform.*` (L246-252) [V cálculo]. BD local: 223 filas en `permissions`, 0 huérfanas [V SQL] |
| Plantillas (`ROLE_PERMISSION_MAP` L318-743) | owner 222 · admin 222 · manager 111 · receptionist 33 · housekeeper 6 · maintenance 8 · accountant 34 · compliance 33 · revenue 35 · sales 34 · fnb 15 [V cálculo]; etiquetas ES L768-780; `ORGANIZATION_TEMPLATE_ROLE_KEYS` = 10 (sin `admin`, L804-815). Planas por departamento: **no existe nivel** (jefe/auxiliar/director); «Jefe de recepción» resuelve por alias a `receptionist` (`rbac-catalog.ts:575-628`) |
| Roles en BD | `Role { organizationId, name, templateKey? }` (schema 2838-2848) = definición de **ámbito organización**; 10 roles por organización convergidos exactamente al tamaño del código en Faranda y org_123; org_123 además «Local Super Admin» (223, `template_key NULL`) [V SQL] |
| Asignación | `UserPropertyRole { userId, propertyId, roleId }` (2867-2874) = **solo por propiedad**; 6 escritores `create/upsert`, **ningún `update/delete`** [V grep]; 3 usuarios: Carmen Vázquez Rey = Owner en las 8 propiedades (8 filas), `recepcion.tilos@faranda.test` = Recepción solo en LT, `reception@example.com` = Local Super Admin en `prop_123`; 1 invitación (usada); 8 `user_departments` [V SQL] |
| Ámbito «organización» | Solo por efecto colateral: usuario **sin** asignaciones = todo (`tenancy.ts:93-97 isPropertyAssigned` devuelve `true` con lista vacía; `finance-scope.ts:189-194`), clave `accounting.entity.read` para finanzas de toda la sociedad (`finance-scope.ts:202-249`), `organization.structure.manage`, `/dashboards/portfolio` gateado solo por `analytics.read` (que tienen todas las plantillas). Sin grupos ni clúster de propiedades |
| Permisos de sesión | `loadUserContext` (`auth.service.ts:116-147`) calcula `permissions` **solo para la primera asignación ordenada por id** (L123-130) y `assignedPropertyIds`; el guard de tenencia solo comprueba pertenencia (`tenancy.ts:110-125`). No hay endpoint de cambio de propiedad activa: el front cambia por `localStorage` + reload (`services/activeProperty.ts`) |
| Modo demo | `isDemoPermissionUnionEnabled` (L81-84) = `NODE_ENV development|dev` **o** `HOTELOS_ALLOW_DEMO_AUTH=true` → cada sesión real recibe sus claves ∪ baseline demo (208 claves) (L86-114). `.env` local: `HOTELOS_ALLOW_DEMO_AUTH=true` (L7), `NODE_ENV=development` (L50), **sin `RBAC_STRICT`** → Recepción Los Tilos tiene 33 claves reales pero ~222 efectivas en la API; solo `grantedPermissions`/`templateKeys` del perfil reflejan el rol real [V] |

### 3.2 Evaluación en la API

- Manifiesto: **969 entradas** (776 propias + 17 partials): public 25 · low 208 · medium 368 · high 297 · critical 71; **171 claves usadas → 52 sin ninguna ruta** (entre ellas `payments.refund_request/approve`, `payments.capture`, `capex.read/create/approve`, `billing.invoice.*`, `pos.order.*`); 37 rutas no públicas con `permissions: []` (solo autenticación) [V cálculo sobre `route-permissions.ts` + partials].
- `assertRoutePermission` (L1421-1444): exige **todas** las claves (AND); GET sin entrada → 403 solo si `isRbacStrictMode()` (L1391-1404: `RBAC_STRICT="true"`, o `NODE_ENV=production` si vacío), si no aviso y pasa; mutación sin entrada → 403 siempre; el preHandler usa `request.userContext?.permissions ?? []` (`server.ts:1363`) y devuelve 401 al fallback demo en high/critical.
- Nivel de servicio: `requirePermissions` (`auth.service.ts:328`) sobre el mismo contexto; los aprobadores solo se sellan (`supplier-bills.service.ts:718 approvedBy`, `payments.service.ts:343`, `assets.service.ts:418`): **ningún servicio comprueba aprobador ≠ solicitante** [V].
- Auditoría: `AuditEvent` con cadena hash (schema 4684-4707); eventos existentes: `ROLE_CREATED_FROM_TEMPLATE` (`rbac-catalog.ts:404`), `USER_INVITED` (`invitations.service.ts:314`), `USER_INVITATION_ACCEPTED` (`invitations.service.ts:501`), `USER_CREATED` (`auth-pilot.service.ts:249`), `AUTH_LOGIN` (`auth.service.ts:249,290`; 1.255 filas en local) y, en camelCase legacy, `UserDisabled` (`backoffice.service.ts:5253`; 3 filas) y `UserDepartmentAssigned` (`:4964`) [V grep + SQL]; **no se audita** el acceso denegado, la asignación/retirada de roles, el cambio de propiedad activa ni el login fallido [V grep]. 19.674 `audit_events` en local [V SQL].

### 3.3 Navegación y pantalla de usuarios

- Árbol generado desde `pilots/tanda5-nav-tree.csv` (286 filas): 9 categorías, 67 ítems, 100 pestañas, 21 dev-only, 2 públicas, 205 legacy [V `nav-tree.generated.json` meta]; 10 tokens (`role-tokens.ts:14-37`); `ROLE_TEMPLATE_TO_TOKEN` L73-85 (owner+manager→direccion, accountant+compliance→finanzas, receptionist→recepcion, housekeeper→pisos, maintenance→mantenimiento, revenue→revenue, sales→comercial, fnb→fnb, **admin→admin** L75); `resolveRoleTokens` L303 usa `templateKeys` de la propiedad activa y el fallback por permisos L242. Visibilidad con todos los módulos: direccion 67/96, admin 67/100, finanzas 31/44, recepcion 22/16, revenue 20/9, comercial 14/18, mantenimiento 8/2, pisos 5/4, fnb 5/5 [V cálculo].
- El menú **nunca** filtra por permiso (premisa testada, `rbac-nav-contract.test.mjs:17-22,631`); el router (`backoffice.routes.tsx:406-421 resolveLocation`) solo distingue home/legacy/screen/dev-locked/not-found: **no consulta roles ni módulos**; un usuario que teclea `/finanzas/nominas` monta la pantalla y recibe 403 del API [V].
- «Ver como…» solo para `gate.isPlatformAdmin` (`Sidebar.tsx:141`), en memoria (`view-as.ts:21-80`), no aplicado al router ni al aterrizaje (`App.tsx:426-428`) [V].
- `UserRoleManager.tsx`: propiedad activa fija (L66); «Cambiar rol» escribe `UserDepartment.roleLabel` **texto libre** (`handleChangeRole` L344-377, `apiRequest` L359-366) y la columna «Rol» (L406) muestra ese texto vía `primaryRole` (L116-121), no el rol RBAC; «Desactivar» apaga el **usuario entero** (`backoffice.service.ts:5247 status "disabled"`) aunque el diálogo hable de «esta propiedad»; invitar asigna solo en la propiedad del path (L5198) [V].

### 3.4 Huecos verificados

| # | Hueco | Evidencia |
|---|---|---|
| H1 | Permisos por primera asignación, no por propiedad de la petición | `auth.service.ts:123-130`; front por `localStorage` |
| H2 | Sin ámbito sociedad/grupo ni «director de operaciones multi-hotel» (ni plantilla, ni token, ni tabla) | schema 2838-2874; `role-tokens.ts:73-85` |
| H3 | Sin niveles: `roleLabel` texto libre; alias «jefe de recepción» → receptionist | schema 728-736; `rbac-catalog.ts:600`; `UserRoleManager.tsx:344-377` |
| H4 | Sin endpoint para cambiar/retirar asignaciones ni editar claves de un rol (`permissions.manage`: 1 ruta GET, 0 servicios) | grep `userPropertyRole.update/delete` vacío; manifiesto |
| H5 | Conflictos inherentes en plantillas: manager y accountant con `invoice.issue`+`invoice.cancel` y `payment.capture`+`payment.refund`; accountant con `accounting.journal.post`+`banking.reconcile`+`payroll.manage`; manager con `payments.refund_request`+`payments.refund_approve` | `permissions.ts:324-450, 523-588` |
| H6 | Facturas de proveedor: registrar y aprobar con la **misma** clave `procurement.manage`; contabilizar, pagar y anular con `accounting.journal.post` | `payables/route-permissions.partial.ts:19-26` |
| H7 | Cierre del día gateado por `accounting.journal.post` (lo tienen owner/admin/accountant, **no** recepción ni dirección) | `night-audit/route-permissions.partial.ts:12` |
| H8 | Claves maker/checker muertas (0 rutas): `payments.refund_request/approve`, `capex.create/approve`; reembolso real = `payment.refund` + `ai.high_risk.confirm` (critical); CAPEX usa `asset.capex.approve` también para leer y crear | manifiesto L738, L832-841 |
| H9 | Top-up de arranque y `rbac:sync` solo aditivos: estrechar una plantilla no revoca nada en roles existentes | `rbac-catalog.ts:226-241`; `permissions.ts:314-316` |
| H10 | Modo demo local enmascara el RBAC (unión con 208 claves; GET sin manifiesto pasa) | `auth.service.ts:81-114`; `.env:7,50` |
| H11 | Token `admin` ambiguo: plantilla org `admin` (sin `admin.tenants.manage`) → mismas pestañas Sistema y dev-only que plataforma | `role-tokens.ts:75`; ninguna fila en BD la usa |
| H12 | Router del front sin roles; «Sin acceso» solo en contenedores de pestañas | `backoffice.routes.tsx:406-421`; `nav-item-tabs.ts:201-216` |
| H13 | Sin auditoría de accesos denegados ni de asignaciones; `AuditEvent` sin `action` para ello | grep §3.2 |
| H14 | Solo 3 usuarios de demo: pisos, mantenimiento, revenue, finanzas, comercial y fnb no tienen login real | SQL |

---

## §4 · Modelo objetivo

### 4.1 Niveles × ámbito

| Nivel (`RoleLevel`) | Quién | Ámbito de asignación por defecto (`ScopeType`) | Umbral de aprobación |
|---|---|---|---|
| `operative` (N1) | Recepcionista, auditor nocturno, camarera, técnico, camarero, comercial, administrativo | `property` | Ejecuta ≤ T1 con motivo; solicita el resto |
| `supervisor` (N2) | Jefe de recepción, gobernanta, encargado de mantenimiento, jefe de A&B | `property` | Aprueba ≤ T2 |
| `hotel_director` (N3) | Dirección de hotel | `property` (una o varias) | Aprueba ≤ T3; cierra/reabre el día |
| `operations_director` (N4) | Dirección de operaciones multi-hotel; revenue corporativo | `property_group` (p. ej. Galicia = LT+RA; Asturias-Cantabria = PG+MC+AS) o `organization` | Aprueba ≤ T4; tarifas fuera de banda |
| `general_management` (N5) | Dirección general; dirección financiera/controller | `legal_entity` (CELUISMA) / `organization` | Aprueba > T4 (doble con propiedad); nóminas mensuales; cierres de periodo |
| `ownership` (N6) | Propiedad / consejo | `organization` | CAPEX y presupuesto; segundo aprobador > T4 |
| `central_admin` (N7) | Contabilidad central, RRHH/nóminas, cumplimiento, gestión del activo, auditoría interna, administración de sistema | `legal_entity` / `organization` | Sin aprobaciones de importe (salvo controller); ejecutan y preparan |

Ámbitos: `property` (un centro) · `property_group` (clúster, tabla nueva) · `legal_entity` (sociedad: todos los centros de la `LegalEntity`; hoy una por organización [V FINANZAS-ESTRUCTURA-SOCIETARIA §Decisión 2]) · `organization` (grupo). Un usuario puede tener **varias asignaciones** con plantillas distintas por ámbito (Recepción en LT y Contabilidad en OC; patrón Mews local roles / protel).

### 4.2 Plantillas (23: 11 existentes, 12 nuevas)

| `RoleKey` | Etiqueta ES | Nivel | Ámbito | Token nav | Origen |
|---|---|---|---|---|---|
| `receptionist` | Recepción | N1 | property | recepcion | existente (+descuento/ajuste ≤ T1; **conserva** `accounting.read` solo-calendario: `permissions.ts:495-498` lo deja a propósito y la Bandeja de cumplimiento `/cumplimiento/bandeja`, que el token `recepcion` ve, lo exige [V cálculo §4.10]) |
| `night_auditor` | Auditoría nocturna | N1 | property | recepcion | **nueva** |
| `front_office_manager` | Jefatura de recepción | N2 | property | recepcion | **nueva** (sustituye al alias) |
| `housekeeper` | Pisos | N1 | property | pisos | existente |
| `housekeeping_manager` | Gobernanta | N2 | property | pisos | **nueva** |
| `maintenance` | Mantenimiento | N1 | property | mantenimiento | existente |
| `maintenance_manager` | Encargado de mantenimiento | N2 | property | mantenimiento | **nueva** |
| `fnb` | Punto de venta | N1 | property | fnb | existente |
| `fnb_manager` | Jefatura de A&B | N2 | property | fnb | **nueva** |
| `sales` | Comercial | N1/N2 | property / group | comercial | existente |
| `admin_clerk` | Administración de hotel | N1 | property | administracion | **nueva** («administrativos» de César) |
| `manager` | Dirección de hotel | N3 | property | direccion | existente, estrechada (SoD H5) |
| `operations_director` | Dirección de operaciones | N4 | property_group / organization | direccion | **nueva** |
| `revenue` | Revenue corporativo | N4 | organization | revenue | existente (renombrada) |
| `accountant` | Contabilidad | N7 | legal_entity | finanzas | existente, estrechada (sin nóminas ni pagos) |
| `controller` | Dirección financiera | N5 | legal_entity | finanzas | **nueva** |
| `payroll_hr` | RRHH y nóminas | N7 | legal_entity | rrhh | **nueva** (nóminas salen de `accountant`) |
| `compliance` | Cumplimiento | N7 | legal_entity | finanzas | existente |
| `asset_manager` | Gestión del activo | N7 | legal_entity / organization | activos | **nueva** |
| `general_manager` | Dirección general | N5 | organization | direccion | **nueva** |
| `owner` | Propiedad | N6 | organization | propiedad | existente, **estrechada** (deja de ser «todo») |
| `auditor` | Auditoría interna | N7 | organization | auditoria | **nueva**, solo lectura |
| `admin` | Administración de sistema | N7 | organization | **sistemas** (token nuevo; `admin` queda solo para plataforma) | existente, **sin claves financieras ni operativas** |

Se mantienen `ROLE_TEMPLATE_LABELS_ES`, descripciones y alias (`resolveTemplateKeyForRoleName`: «jefe de recepción»→`front_office_manager`, «gobernanta»→`housekeeping_manager`, «controller|dirección financiera»→`controller`, «rrhh|nóminas»→`payroll_hr`, «director general|ceo»→`general_manager`, «operaciones»→`operations_director`, «activos|patrimonio»→`asset_manager`, «auditor»→`auditor`). Subdirección = `manager` con umbrales T2 en `role_thresholds` (decisión D3). **Cuidado con los alias actuales** (`rbac-catalog.ts:575-612`, resolución exacta y luego por palabra completa en el orden de `ROLE_TEMPLATE_KEYS`, L613-628): `administracion` → `accountant` (L604) capturaría «Administración de hotel»; `director`/`direccion`/`gestion` → `manager` (L586-590) capturarían «Dirección financiera», «Dirección de operaciones», «Dirección general» y «Gestión del activo». Las etiquetas nuevas entran como alias exactos y las plantillas nuevas se colocan **antes** de `manager` y `accountant` en `ROLE_TEMPLATE_KEYS` (`permissions.ts:747-759`, «más específico primero») [V].

### 4.3 Diccionario módulo → claves (catálogo completo: las 223 claves actuales + las nuevas de §4.6, marcadas ✚)

Letras: **V** ver · **C** crear/ejecutar · **E** editar/configurar · **S** solicitar · **A** aprobar · **X** anular/reembolsar/reabrir · **P** exportar.

| Módulo | V | C | E | S | A | X | P |
|---|---|---|---|---|---|---|---|
| M1 Reservas y recepción | pms.reservation.read, guests.read, guest_experience.inbox.read | pms.reservation.create, pms.checkin.execute, pms.checkout.execute, guest_experience.message.send | pms.reservation.modify, guests.manage, guest_experience.ai_reply, guest_experience.handoff | pms.reservation.discount ✚ | pms.reservation.override ✚ | — | — |
| M2 Folios y cobros | folio.read | folio.charge.post, payment.capture, payments.capture, payments.create_link | folio.adjust ✚ | payments.refund_request | folio.adjust_approve ✚, payments.refund_approve | payment.refund | — |
| M3 Facturación | invoice.read, billing.compliance.view | invoice.issue, billing.invoice.issue | billing.invoice.rectify | invoice.cancel_request ✚ | invoice.cancel_approve ✚ | invoice.cancel, billing.invoice.cancel | — |
| M4 Cierre del día | (analytics.read sobre `/night-audit/*`) | night_audit.run ✚ | — | — | night_audit.review ✚ | night_audit.reopen ✚ | — |
| M5 Pisos | pms.reservation.read, housekeeping.read ✚ | — | housekeeping.task.manage, rooms.manage (OOO/OOS) | — | — | — | — |
| M6 Mantenimiento, energía y seguridad | maintenance.read ✚, incidents.read, safety_checks.read, energy.read, sustainability.read | maintenance.workorder.create ✚ | maintenance.workorder.manage, incidents.manage, safety_checks.manage, energy.manage, iot.manage, insurance_cases.manage, sustainability.report | — | — | — | — |
| M7 TPV y A&B | pos.read | pos.order.create, pos.order.charge_to_room, pos.order.pay | pos.product.manage | — | — | pos.order.void ✚ | — |
| M8 Compras e inventario | procurement.read, inventory.read | purchase_orders.receive, inventory.stock_count | procurement.manage, inventory.manage, inventory.adjust | purchase_orders.create | purchase_orders.approve | — | — |
| M9 Facturas de proveedor y pagos | payables.read ✚ | payables.create ✚ | — | — | payables.approve ✚ | payables.pay ✚ (ordenar pago/remesa) | — |
| M10 Contabilidad | accounting.read, accounting.reports.read | accounting.journal.post | accounting.configure | — | accounting.period.close ✚ | — | analytics.export (gestoría) |
| M11 Tesorería y bancos | banking.read | — | banking.reconcile | — | — | — | — |
| M12 Nóminas y personal | payroll.read, workforce.read, workforce.labor_cost.view | workforce.timeclock.use | payroll.manage, workforce.schedule.manage, workforce.timeclock.manage | — | payroll.approve ✚ | — | workforce.payroll_export |
| M13 Inmovilizado y CAPEX | assets.read, capex.read | — | assets.manage | capex.create | asset.capex.approve (aprobación en servicio, `assets.service.ts:407`; `capex.approve` está muerta y se poda en L6) | — | — |
| M14 Gestión del activo (inmueble) | real_estate.read ✚ | real_estate.documents.manage ✚ | real_estate.manage ✚, property_tax.manage ✚ | — | — | — | — (sin clave de exportación: el documento hermano no la define) |
| M15 Cumplimiento y registro de viajeros | compliance.read ✚, guest_register.read, guest_register.view_sensitive, tourist_tax.read | guest_register.create, guest_register.sign, guest_register.submit, compliance.ses.submit | guest_register.edit, guest_register.correct, compliance.ses.export | — | — | guest_register.annul | guest_register.export |
| M15b Configuración de cumplimiento y fiscal (separada de M15 para que la `E` de recepción no arrastre configuración) | — | — | compliance.configure, compliance.ses.configure, compliance.gdpr.manage, guest_register.configure, tax.configure, compliance_setup.manage | — | — | — | — |
| M16 Revenue y distribución | revenue.read, revenue.forecast.read, revenue.history_forecast.read, revenue.forecast_confidence.read, revenue.comparison.read, revenue.visual_alerts.read, channel_manager.read, channel_manager.parity.read, distribution.read | revenue.recommend, revenue.history_forecast.saved_views.manage, distribution.ai_recommend | revenue.manage_rates, revenue.manage_restrictions, revenue.apply_recommendations, revenue.automation.manage, revenue.configure, revenue.history_forecast.configure, revenue.scheduled_reports.manage, revenue_setup.manage, channel_manager.manage, channel_manager.sync, channel_manager.mappings.manage, distribution.manage_rates, distribution.manage_inventory, distribution.sync | — | revenue.rates.approve ✚ | — | revenue.history_forecast.export |
| M17 Comercial, grupos y CRM | crm.read, groups.read, events.read, sales.pipeline.read, reputation.read, surveys.read, quality_cases.read, guest_self_service.read, commissions.read | — | crm.manage_profiles, crm.manage_campaigns, crm.manage_loyalty, groups.manage, groups.block_inventory, groups.manage_billing, events.manage, events.manage_spaces, sales.pipeline.manage, reputation.respond, surveys.manage, quality_cases.manage, guest_self_service.manage, guest_portal.configure | — | — | — | crm.export |
| M18 Informes y analítica | analytics.read | analytics.ai_ask | analytics.configure, metrics.manage | — | — | — | analytics.export |
| M18b Cuadro del propietario | owner.dashboard.read | owner.ai_ask | — | — | — | — | — |
| M19 Configuración de la propiedad | configuration.read, categories.read, custom_fields.read, property.map.read, templates.read | — | property.configure, property.map.manage, property.import, property.go_live, configuration.manage, categories.manage, categories.import, custom_fields.manage, property_profile.edit, room_types.manage, spaces.manage, departments.manage, operations_setup.manage, ai_category_setup.use, templates.manage, notifications.manage, kiosk.configure, digital_key.configure | — | — | — | categories.export |
| M20 Estructura societaria y fiscal | accounting.entity.read (ámbito sociedad), backoffice.access | — | organization.structure.manage, billing.configure, payments.configure | — | — | — | — |
| M21 Usuarios, roles y auditoría | users.read, audit.read | users.invite, users.assign ✚ | roles.manage, permissions.manage | — | — | users.disable | — |
| M22 Módulos | modules.read | — | modules.enable, modules.disable, modules.configure | — | — | — | — |
| M22b Integraciones y desarrollo | integrations.read, integrations.view_logs, developer.read, developer.view_api_logs | integrations.test | integrations.connect, integrations.disconnect, integrations.manage_credentials, integrations.configure, developer.manage_apps, developer.manage_webhooks, developer.manage_sandbox | — | — | — | — |
| M23 IA | ai_governance.read, ai_incidents.read | ai.tool.execute | ai.configure, ai_governance.configure, ai_evals.manage, ai_incidents.manage, ai_prompts.manage, ai_tool_registry.manage | — | ai.high_risk.confirm | — | — |
| M24 Puesta en marcha y migración | onboarding.read, onboarding.view_sensitive | onboarding.create, onboarding.upload, onboarding.connect_source, onboarding.ai_extract, onboarding.ai_map | onboarding.review, onboarding.apply, onboarding.manage_cutover | — | onboarding.go_live | onboarding.rollback | — |
| Plataforma / emergencia | — | security.break_glass ✚ (§4.8) · admin.tenants.manage (solo plataforma, nunca en plantillas de hotel) | — | — | — | — | — |

Los 81 prefijos del catálogo quedan asignados a un módulo [V cálculo 2026-09-17 sobre `PERMISSIONS`: las 223 claves aparecen en la tabla (222 en celdas más `capex.approve`/`asset.capex.approve` en M13-A); tres claves figuran en dos módulos a propósito: `pms.reservation.read` (M1/M5), `analytics.read` (M4/M18) y `analytics.export` (M10/M18)]. `backoffice.access` va en M20 y no en M19 porque `tests/rbac-nav-contract.test.mjs:459` exige que `receptionist` no la tenga.

### 4.4 Matriz hotel (ámbito propiedad) · plantilla → módulo

Rec = receptionist · AudN = night_auditor · JRec = front_office_manager · CamP = housekeeper · Gob = housekeeping_manager · Tec = maintenance · EncM = maintenance_manager · TPV = fnb · JAB = fnb_manager · Com = sales · AdmH = admin_clerk · DirH = manager. `–` = ninguna clave del módulo. ¹ = fila propia (sus habitaciones / sus órdenes, filtro de servicio) · ² = C sin `payment.capture`/`payments.capture` (SoD estática con `payments.refund_approve`, §4.7) · ³ = solo `accounting.read` (calendario fiscal de la bandeja; los importes van por `accounting.reports.read`) · ⁴ = E solo `workforce.*` (sin `payroll.manage`, SoD con `payroll.approve`) · ⁵ = C sin `pms.checkin.execute`/`pms.checkout.execute` (comercial no opera el mostrador) · ⁶ = V solo `workforce.read` (sus turnos en Personal y turnos, sin `payroll.read` ni coste laboral).

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

### 4.5 Matriz central (sociedad / grupo) · plantilla → módulo

DirOps = operations_director · Rev = revenue · Cont = accountant · DirFin = controller · RRHH = payroll_hr · Cumpl = compliance · Act = asset_manager · DG = general_manager · Prop = owner · Aud = auditor · Adm = admin. ⁴ CIERRE-1 (2026-09-20, aditiva sin bump de `ROLE_TEMPLATE_VERSION`): solo `users.read` (selector «Persona» de la ficha de personal → `GET /rbac/users`); efecto colateral aceptado: `/configuracion/usuarios` por URL en solo lectura (`docs/runbooks/accesos-por-departamento.md` §2.2 y nota CIERRE-1).

| Módulo | DirOps | Rev | Cont | DirFin | RRHH | Cumpl | Act | DG | Prop | Aud | Adm |
|---|---|---|---|---|---|---|---|---|---|---|---|
| M1 Reservas | V | V | V | V | – | V | – | V | V | V | – |
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
| M21 Usuarios y roles | V C X | – | – | – | V⁴ | – | – | V C X | V | V | V C E X |
| M22 Módulos | V | V | V | V | V | V | V | V E | V | V | V E |
| M22b Integraciones y desarrollo | V | – | V | V | – | V | – | V | – | V | V C E |
| M23 IA | V C A | V C A | V C A | V C A | C A | V C A E | C A | V C A E | C | V | C A E |
| M24 Puesta en marcha | V C E A | – | – | – | – | – | – | V A | – | V | V C E A X |

Reglas de lectura: `V` en M18 y M22 en todas las plantillas conserva los invariantes de `rbac-nav-contract.test.mjs:454-455` (`analytics.read`) y del menú (`modules.read`); `modules.enable` solo DirH, DG y Adm; `accounting.entity.read` y `backoffice.access` (M20 V) en DirOps, Cont, DirFin, Cumpl, Act, DG, Prop y Aud (ámbito sociedad/organización); `owner` deja de ser el spread de las 222 claves y `admin` pierde todo lo financiero/operativo y pasa al token `sistemas` (H11). Invariantes negativos del test que estas matrices respetan [V cálculo]: `receptionist` sin `backoffice.access` ni `inventory.read` (L459-460), `manager` y `compliance` sin `accounting.journal.post` (L461-462), `compliance` sin `folio.charge.post`/`billing.configure` (L463-464), `accountant` sin `compliance.configure`/`gdpr.manage`/`ses.submit` (L465-467), `sales`/`fnb` sin `property.configure`, `roles.manage`, `users.invite`, `modules.enable`, `billing.configure`, `payment.refund`, `invoice.issue`, `accounting.journal.post` (L468-472), `sales` sin `folio.charge.post`/`payment.capture` (L473-474), `fnb` sin `pms.reservation.create` y con `pos.order.charge_to_room` (L475-476); `folio.read`, `pos.read` y `tourist_tax.read` no llegan a `housekeeper`, `maintenance`, `revenue` ni `sales` (L544-552): por eso Rev y Com no tienen `V` en M2.

### 4.6 Claves nuevas (✚, 27) y claves reutilizadas

| Clave | Uso | Ruta/servicio que la gatea (nuevo o cambiado) |
|---|---|---|
| `pms.reservation.discount` / `pms.reservation.override` | descuento ≤ T1 con código de motivo / override de tarifa, restricción, overbooking, ocupación máxima (también vía PIN de supervisor) | `POST /properties/:propertyId/reservations` (`pms.reservation.create`, medium) y `PATCH /reservations/:id` (`pms.reservation.modify`, medium) [V manifiesto]; validación de servicio por umbral |
| `folio.adjust` / `folio.adjust_approve` | ajuste/rebate ≤ T1 con motivo / aprobación > T1 | `POST /folios/:id/adjustments` (nueva) + `approval_requests` |
| `payments.refund_request` / `payments.refund_approve` (existentes, muertas) + `payment.refund` | solicitar / aprobar / ejecutar reembolso; `requestedBy ≠ approvedBy ≠ executedBy` | `POST /payments/:id/refund-requests`, `…/approve` (nuevas); `POST /payments/:id/refund` pasa de [`payment.refund`, `ai.high_risk.confirm`] (L738, critical) a [`payment.refund`] + `approval_requests` aprobado: la aprobación sustituye a la confirmación de alto riesgo (si no, AdmH, que ejecuta reembolsos ≤ T3, necesitaría `ai.high_risk.confirm`) |
| `invoice.cancel_request` / `invoice.cancel_approve` + `invoice.cancel` | anulación como registro de anulación/rectificativa (RD 1007/2023 art. 11), emisor ≠ aprobador | `POST /invoices/:id/cancel` pasa a exigir aprobación previa |
| `night_audit.run` / `night_audit.review` / `night_audit.reopen` | correr el cierre / income audit a la mañana siguiente / reabrir con motivo | `night-audit/route-permissions.partial.ts:12` deja `accounting.journal.post` |
| `pos.order.void` | anular ticket TPV del día con motivo | `POST /pos/tickets/:id/void` (nueva: hoy los tickets van por `POST /pos/tickets`, `…/lines`, `…/close` con `folio.charge.post` y `pos.service.ts` no tiene anulación; `pos.order.create`/`pos.order.charge_to_room` siguen sin ruta y se cablean aquí) |
| `maintenance.workorder.create` | cualquier empleado abre un parte | `POST /work-orders` (hoy `maintenance.workorder.manage`, low; servicio `maintenance.service.ts:155`) |
| `payables.read` / `payables.create` / `payables.approve` / `payables.pay` | registrar ≠ aprobar (por importe) ≠ pagar | `payables/route-permissions.partial.ts:18-26` (sustituye `procurement.manage` y `accounting.journal.post` en pay/approve) |
| `accounting.period.close` | cierre de periodo/ejercicio separado del asiento manual | `POST /accounting/fiscal-periods/:id/close` (hoy `accounting.journal.post`, high) y `POST /accounting/fiscal-years/:id/close` (hoy + `ai.high_risk.confirm`, critical); las reaperturas conservan `ai.high_risk.confirm` |
| `payroll.approve` | aprobar registro mensual y cambios salariales (formulario escrito, Lund) | `POST /payroll/periods/:id/approve` (nueva) antes de `…/pay` |
| `revenue.rates.approve` | cambios masivos o fuera de banda (± % sobre BAR, parametrizable) | `POST /revenue/rate-changes/:id/approve` (nueva) y gatea `POST /properties/:propertyId/rate-grid/bulk-update` (hoy `revenue.manage_rates`, critical); las recomendaciones ya tienen aprobación propia (`POST /revenue/properties/:propertyId/recommendations/:id/approve`, `revenue.apply_recommendations`, critical) [V manifiesto] |
| `capex.read` / `capex.create` (existentes, muertas) + `asset.capex.approve` (existente) | `GET /properties/:propertyId/capex` → `capex.read`; `POST /capex-projects`, `POST …/items` y `PATCH /capex-projects/:id` → `capex.create` (`route-permissions.ts:832,839-841`); la aprobación sigue en el servicio con `asset.capex.approve` (`assets.service.ts:407`, fijado por `tests/assets-owner-contract.test.mjs:24-26`), igual que `ASSET-MANAGEMENT-INMOBILIARIO.md` §7; `capex.approve` (muerta) es la única clave que se poda en L6 | rutas en `server.ts` (el test :6-18 las busca ahí) |
| `real_estate.read` / `real_estate.manage` / `real_estate.documents.manage` / `property_tax.manage` (4; nombres y descripciones de `docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md` §7, catálogo 223 → 227) | módulo de gestión del activo: finca, título y cargas, contratos, seguros, IBI/IAE/tasas, inspecciones, planos, licencias | `GET/POST/PATCH /properties/:propertyId/real-estate/*` y `GET /organizations/:organizationId/real-estate/overview` del documento hermano (§7); documentos sobre el almacén de la Tanda 9 |
| `users.assign` | asignar/retirar roles dentro del propio ámbito y nivel ≤ el propio | `POST/DELETE /rbac/assignments` (§6.3) |
| `compliance.read` / `housekeeping.read` / `maintenance.read` (lectura) | las plantillas de solo lectura (N4+, `auditor`) y las N1 abren lo que su token ve sin recibir claves de escritura: hoy 11 GET exigen `compliance.configure` (`/compliance/properties/:propertyId/center`, `/backoffice/properties/:propertyId/taxes`, `…/compliance-settings`, ESRS, TBAI verify…), `GET /properties/:propertyId/housekeeping/board` exige `housekeeping.task.manage`, `GET /properties/:propertyId/work-orders` y `…/assets` exigen `maintenance.workorder.manage`, `GET /gdpr/requests*` `compliance.gdpr.manage` (→ `compliance.read`), `GET …/billing-settings`, `…/accounting-settings`, `/legal-entities/:id/series`, `…/verifactu/installations` exigen `billing.configure`/`accounting.configure` (→ `configuration.read`/`accounting.read`) y `GET /audit-events`, `…/facets`, `…/integrity`, `/events`, `/events/integrity`, `/ai/tool-calls` exigen `ai.high_risk.confirm` (→ `audit.read`; `route-permissions.ts:1038-1043`) [V manifiesto] | manifiesto y partials (L2); amplía `READ_GATED_GETS` de `tests/rbac-nav-contract.test.mjs:524-554` |
| `security.break_glass` | abrir una sesión de emergencia | `POST /rbac/break-glass` (§4.8) |

### 4.7 Separación de funciones, umbrales y doble aprobación

Estática (roles incompatibles, validada por `tests/rbac-sod-contract.test.mjs`): ninguna plantilla contiene a la vez {`invoice.issue`, `invoice.cancel_approve`}, {`payment.capture`, `payments.refund_approve`}, {`payables.create`, `payables.approve`}, {`payables.approve`, `payables.pay`} salvo `controller` (pagar lo aprobado por otro; dinámica), {`accounting.journal.post`, `payables.pay`}, {`banking.reconcile`, `payables.pay`}, {`payroll.manage`, `payroll.approve`}, {`purchase_orders.create`, `purchase_orders.approve`}, {`purchase_orders.receive`, `purchase_orders.approve`}, {`night_audit.run`, `night_audit.review`}, {`roles.manage` o `permissions.manage`, cualquier clave `payables.*`/`payment.*`/`accounting.journal.post`} (sistema ≠ finanzas; `users.assign` queda fuera del par porque DirH, DirOps y DG asignan dentro de su ámbito y nivel, §6.3, y sí tienen dinero). Dinámica (servicio + `CHECK` en `approval_requests`): `requestedBy ≠ decidedBy`, `issuedBy ≠ canceller`, `createdBy ≠ payer`, quien solicita un pedido ≠ quien lo recepciona (Gob, EncM y JAB tienen S y C en M8; Lund: solicitar/aprobar/recibir/pagar en personas distintas), quien corre el cierre ≠ quien lo revisa ese día. Las matrices §4.4/§4.5 cumplen los pares estáticos [V cálculo 2026-09-17 sobre las celdas expandidas a claves]; la única excepción declarada es `controller` (`payables.approve` + `payables.pay`).

| Operación | ≤ T1 (50 €, motivo) | ≤ T2 (300 €) | ≤ T3 (3.000 €) | ≤ T4 (15.000 €) | > T4 |
|---|---|---|---|---|---|
| Ajuste de folio / rebate | Rec, AudN ejecutan | JRec aprueba | DirH aprueba | DirFin aprueba | DG + DirFin |
| Reembolso | — (siempre aprobado) | JRec aprueba, AdmH ejecuta | DirH aprueba, AdmH ejecuta | DirFin aprueba y ejecuta (si no es el solicitante) | DG + DirFin |
| Descuento en reserva | Rec ≤ 10 % con código | JRec ≤ 25 % | DirH | DirOps | DG |
| Anulación de factura | — | — | DirH aprueba (emisor ≠ aprobador) | DirFin | DG |
| Cierre del día | AudN corre; AdmH o Cont revisa a la mañana siguiente | — | DirH reabre con motivo (≤ 7 días, ventana Mews) | DirFin reabre > 7 días | — |
| Cambio de tarifa | DirH puntual dentro de banda ± 15 % con motivo; Rev en su plan | — | — | DirOps/DG aprueban fuera de banda o masivo | — |
| Factura de proveedor (importe) | AdmH/Cont registran | — | DirH aprueba | DirFin aprueba | DG aprueba + Prop segundo aprobador > 60.000 € |
| Pedido de compra | Solicita quien necesita | JRec/Gob/EncM/JAB ≤ T2 | DirH ≤ T3 | DirOps | DG |
| Nómina | RRHH prepara; cambio salarial con autorización escrita | — | DirH aprueba variaciones de su hotel | — | DG aprueba el registro mensual; Cont contabiliza; DirFin paga |
| CAPEX | EncM/DirH proponen | — | — | DirFin ≤ T4 | DG + Prop (reserva FF&E, HMA) |
| Exportación contable / gestoría | — | — | Cont exporta tras `accounting.period.close` de DirFin; cada exportación auditada | — | — |

Todos los importes son [S], parametrizables en `role_thresholds` por organización y moneda; los motivos obligatorios son catálogos (`adjustment_reason`, `void_reason`, `cancel_reason`, `rate_override_reason`, `reopen_reason`) editables por DirFin/Adm.

### 4.8 «Break glass» auditado

Dos cuentas por organización sin persona (`emergencia-1@`, `emergencia-2@`), plantilla `break_glass` no listada en `ORGANIZATION_TEMPLATE_ROLE_KEYS`, credencial en sobre/gestor de secretos con doble custodia, TOTP obligatorio, excluidas de invitaciones y de «Ver como». Abrir: `POST /rbac/break-glass { reason, ticket }` con `security.break_glass` desde una sesión real de DG o Adm → sesión de **4 h máximo** con las 222 claves org (nunca plataforma), evento `BREAK_GLASS_OPENED` + notificación inmediata a DG, Adm y Aud; cada petición de esa sesión se audita con `correlationId` de la sesión de emergencia; cierre automático o manual (`BREAK_GLASS_CLOSED`); revisión obligatoria en 24 h (tarea en la bandeja de Aud); prueba cada 180 días (`BREAK_GLASS_DRILL`). [S sobre práctica de identidad corporativa; ningún PMS lo documenta]

### 4.9 Vista por defecto por rol

`roleHome` (`role-tokens.ts:153-176`) se extiende con los tokens nuevos: `administracion` → `/finanzas/facturacion` (bandeja de facturas de proveedor pendientes), `rrhh` → `/finanzas/nominas`, `propiedad` → `/hoy/propietario`, `activos` → `/finanzas/activo-inmobiliario` (ítem del documento hermano, §8; no existe `/activos`), `auditoria` → `/configuracion/sistema` (Auditoría), `sistemas` → `/configuracion/usuarios`. `rrhh`, `activos` y `sistemas` no ven Mi día (`/hoy` exige `pms.reservation.read`, que no tienen) y aterrizan en su `roleHome`; `administracion`, `propiedad` y `auditoria` sí lo ven. Prioridad multi-rol (`ROLE_TOKEN_PRIORITY` L94-105): admin, sistemas, direccion, propiedad, auditoria, finanzas, rrhh, activos, revenue, comercial, administracion, recepcion, fnb, mantenimiento, pisos. La bandeja «Pendientes de aprobación» aparece como tarjeta en Mi día de todo rol con alguna clave `*.approve` o `*_approve`.

### 4.10 Cobertura del árbol de navegación: pantalla → módulo → plantilla [V cálculo 2026-09-17]

Cálculo reproducible: `nav-tree.generated.json` (67 ítems, 100 pestañas) × `pilots/screens-inventory.csv` (columna `api_paths_principales`) × manifiesto (969 entradas), con la misma regla que `tests/rbac-nav-contract.test.mjs:415-427` (`readRoutesFor`: rutas GET de la pantalla, o la primera mutación si no hay GET), y las celdas de §4.4/§4.5 expandidas a claves con el diccionario §4.3. Resultados: los 67 ítems y las 100 pestañas tienen entrada en el inventario y **ninguno queda sin ruta de lectura mapeada**; todas las claves que exigen esas rutas caen en un módulo M1-M24 (ninguna «sin módulo» salvo `admin.tenants.manage`, plataforma). Bajo las matrices **antes** de esta revisión había 453 pares `pending` (plantilla sin la clave y sin hermana que la tenga): 143 de la plantilla `admin` con token `admin` (H11), `ai_governance.read` en Informe IA / Pendientes de la IA para todas las plantillas de dirección, revenue y finanzas (M23 sin V), `accounting.read` en Bandeja de cumplimiento para recepción (por quitarles `accounting.read`), y GET de Centro de cumplimiento, Pisos, Mantenimiento, Protección de datos, Facturación y pagos, Contabilidad y fiscal y Sistema › Auditoría gateados por claves de escritura para `auditor`, `general_manager` y `operations_director`. Con las correcciones aplicadas (M23 `V`, `compliance.read`/`housekeeping.read`/`maintenance.read` y GET con clave de lectura §4.6, `admin` → token `sistemas`, Rec conserva `accounting.read`, Act con M10 `V`, filas M15b/M18b/M22b separadas para que la `E` de recepción no arrastre `compliance.configure`/`gdpr.manage`/`tax.configure` ni la `V` de todos arrastre `audit.read`/`developer.*`, tokens nuevos sin Mi día salvo `administracion`/`propiedad`/`auditoria`) el resultado es **0 pares `pending`**, 6 pares `write` (Conciliación bancaria › Extractos y remesas solo tiene rutas POST con `banking.reconcile`, una por plantilla de los tokens finanzas/direccion/auditoria) y 78 pares `sister` (N1 sin una clave que su hermana N2 del mismo token sí tiene: p. ej. `night_auditor` sin `groups.read` en Grupos y eventos, `housekeeper` sin `payroll.read` en Personal y turnos), que el test admite. Tamaños resultantes (claves por plantilla, expandiendo las letras): receptionist 76 · night_auditor 51 · front_office_manager 102 · housekeeper 14 · housekeeping_manager 34 · maintenance 27 · maintenance_manager 47 · fnb 24 · fnb_manager 48 · sales 55 · admin_clerk 51 · manager 201 · operations_director 107 · revenue 54 · accountant 56 · controller 80 · payroll_hr 11 · compliance 58 · asset_manager 27 · general_manager 114 · owner 64 · auditor 68 · admin 68.

Ítems del árbol con los módulos §4.3 que exigen sus rutas de lectura y los tokens que hoy los ven (todos = los 9 tokens autenticados; dir/rec/pis/man/rev/fin/com/fnb/adm):

| Categoría › ítem | URL | Pestañas | Módulos §4.3 | Tokens hoy |
|---|---|---|---|---|
| Hoy › Mi día | `/hoy` | 3 | M1 M18 | todos |
| Hoy › Asistente ehotelOS | `/asistente` | 0 |  | todos |
| Hoy › Turno | `/hoy/turno` | 0 | M18 | rec dir adm |
| Hoy › Cierre del día | `/hoy/cierre-del-dia` | 0 | M18 | rec fin dir adm |
| Hoy › Informe IA del día | `/hoy/informe-ia` | 0 | M18 M23 | dir rev fin adm |
| Hoy › Pendientes de la IA | `/hoy/pendientes-ia` | 0 | M23 | rec dir adm |
| Recepción › Reservas | `/recepcion/reservas` | 6 | M1 M18 | rec dir com rev pis adm |
| Recepción › Nueva reserva | `/recepcion/reservas/nueva` | 1 | M1 M19 | rec dir com adm |
| Recepción › Huéspedes | `/recepcion/huespedes` | 2 | M1 | rec dir com adm |
| Recepción › Mensajes de huéspedes | `/recepcion/mensajes` | 0 | M18 | rec dir adm |
| Recepción › Grupos y eventos | `/recepcion/grupos` | 2 | M1 M16 M17 M18 | rec com dir adm |
| Operaciones › Pisos | `/operaciones/pisos` | 2 | M5 M18 M19 M20 | pis dir adm |
| Operaciones › Mantenimiento | `/operaciones/mantenimiento` | 2 | M1 M6 M18 M19 M20 | man dir adm |
| Operaciones › Punto de venta | `/operaciones/tpv` | 3 | M7 M8 | fnb rec dir fin adm |
| Operaciones › Personal y turnos | `/operaciones/personal` | 0 | M18 | dir pis man fnb adm |
| Operaciones › Seguridad e incidentes | `/operaciones/seguridad` | 0 | M6 M18 | dir man rec adm |
| Operaciones › Compras e inventario | `/operaciones/compras` | 1 | M18 | dir fnb fin adm |
| Operaciones › Activos | `/operaciones/activos` | 0 | M18 | man dir fin adm |
| Operaciones › Energía y agua | `/operaciones/energia` | 0 | M18 | man dir adm |
| Comercial › Clientes y fidelización | `/comercial/clientes` | 4 | M17 M18 | com dir rec adm |
| Comercial › Reputación y calidad | `/comercial/reputacion` | 2 | M18 | com dir adm |
| Comercial › Ventas adicionales | `/comercial/ventas-adicionales` | 2 | M17 M18 | rec com dir adm |
| Comercial › Ventas a empresas | `/comercial/ventas-empresas` | 0 | M18 | com dir adm |
| Comercial › Canales de venta | `/comercial/canales` | 1 | M16 | rev com dir adm |
| Revenue › Panel de revenue | `/revenue` | 0 | M16 | rev dir adm |
| Revenue › Parrilla de tarifas | `/revenue/parrilla` | 1 | M1 M16 | rev dir adm |
| Revenue › Planes de tarifas | `/revenue/planes` | 0 | M16 | rev dir rec adm |
| Revenue › Reglas y recomendaciones | `/revenue/reglas` | 0 | M16 | rev dir adm |
| Revenue › Histórico y previsión | `/revenue/historico-prevision` | 2 | M16 | rev dir adm |
| Revenue › Comparativa | `/revenue/comparativa` | 0 | M16 | rev dir adm |
| Revenue › Reunión de revenue | `/revenue/reunion` | 0 | M16 | rev dir adm |
| Revenue › Competencia | `/revenue/competencia` | 0 | M16 | rev dir adm |
| Revenue › Calendario de demanda | `/revenue/calendario-demanda` | 0 | M16 | rev dir adm |
| Revenue › Políticas de cancelación | `/revenue/politicas-cancelacion` | 0 | M1 | rev dir rec adm |
| Finanzas › Facturación y cobros | `/finanzas/facturacion` | 3 | M1 M2 | rec fin dir adm |
| Finanzas › Tesorería | `/finanzas/tesoreria` | 1 | M10 M18 | fin dir adm |
| Finanzas › Conciliación bancaria | `/finanzas/conciliacion` | 1 | M11 | fin dir adm |
| Finanzas › Contabilidad | `/finanzas/contabilidad` | 5 | M10 M18 | fin dir adm |
| Finanzas › Estados contables | `/finanzas/estados-contables` | 5 | M10 | fin dir adm |
| Finanzas › Proveedores y gastos | `/finanzas/proveedores` | 3 | M8 M10 M13 | fin dir adm |
| Finanzas › Comisiones | `/finanzas/comisiones` | 0 | M17 | fin dir com adm |
| Finanzas › Nóminas | `/finanzas/nominas` | 0 | M12 | fin dir adm |
| Cumplimiento › Bandeja de cumplimiento | `/cumplimiento/bandeja` | 0 | M3 M10 M15 | rec fin dir adm |
| Cumplimiento › Centro de cumplimiento | `/cumplimiento/centro` | 0 | M15b | fin dir adm |
| Cumplimiento › VeriFactu | `/cumplimiento/verifactu` | 1 | M3 M15 M15b | fin dir adm |
| Cumplimiento › Envíos a autoridades | `/cumplimiento/envios` | 0 | M3 M15 | fin rec dir adm |
| Cumplimiento › Modelos AEAT | `/cumplimiento/modelos-aeat` | 7 | M10 | fin dir adm |
| Cumplimiento › Impuestos | `/cumplimiento/impuestos` | 1 | M15b M15 | fin dir adm |
| Cumplimiento › Registro de viajeros | `/cumplimiento/registro-viajeros` | 3 | M15 | rec fin dir adm |
| Cumplimiento › Protección de datos | `/cumplimiento/proteccion-datos` | 0 | M15b | fin dir adm |
| Cumplimiento › Sostenibilidad | `/cumplimiento/sostenibilidad` | 1 | M15b M18 | dir man fin adm |
| Informes › Centro de informes | `/informes` | 1 | M1 M16 | rec fin dir rev com adm |
| Informes › Analítica | `/informes/analitica` | 0 | M18 | dir rev fin adm |
| Informes › Rentabilidad por habitación | `/informes/rentabilidad-habitacion` | 0 | M18 | dir rev fin adm |
| Informes › Cartera de propiedades | `/informes/cartera` | 1 | M18 | dir rev fin adm |
| Informes › Rendimiento de canales | `/informes/canales` | 0 | M18 | rev com dir adm |
| Configuración › Puesta en marcha | `/configuracion/puesta-en-marcha` | 2 | M1 M10 M19 M20 M22b | dir adm |
| Configuración › Propiedad | `/configuracion/propiedad` | 8 | M19 M20 | dir adm |
| Configuración › Estructura societaria | `/configuracion/estructura-societaria` | 4 | M10 | fin dir adm |
| Configuración › Habitaciones y espacios | `/configuracion/habitaciones` | 2 | M19 M20 | dir adm |
| Configuración › Usuarios y roles | `/configuracion/usuarios` | 0 | M21 | dir adm |
| Configuración › Comunicaciones | `/configuracion/comunicaciones` | 1 | M22b | dir rec adm |
| Configuración › Facturación y pagos | `/configuracion/facturacion-pagos` | 1 | M10 M20 M22b | fin dir adm |
| Configuración › Contabilidad y fiscal | `/configuracion/contabilidad-fiscal` | 3 | M10 M15b M19 M20 M22b | fin dir adm |
| Configuración › Módulos e integraciones | `/configuracion/modulos` | 3 | M10 M22 M22b | dir adm |
| Configuración › Inteligencia artificial | `/configuracion/ia` | 4 | M18 M19 M20 M23 | dir adm |
| Configuración › Sistema | `/configuracion/sistema` | 5 | M22b M23 Plat | dir adm |

Lectura: cada pantalla queda cubierta por al menos un módulo cuyas claves `V` aparecen en la plantilla de cada token que la ve; las pantallas sin ruta de lectura propia (0 en «Módulos»: Asistente) solo exigen sesión. La columna refleja el manifiesto **de hoy**: donde aparece M15b (Centro de cumplimiento, Impuestos, Protección de datos, Sostenibilidad › ESRS, Contabilidad y fiscal › Fiscal), M22b (Comunicaciones › Correo entrante) o M23 en Sistema (Auditoría, `ai.high_risk.confirm`) es porque el GET lleva hoy una clave de escritura; tras el cambio de §4.6 esas filas pasan a M15 (`compliance.read`), M22b `V` y M21 (`audit.read`). Las 21 pantallas dev-only (`/desarrollo/*`, roles = [`admin`]) y las 2 públicas quedan fuera de la tabla.

---

## §5 · Navegación y UI

1. **Una sola fuente de verdad.** El árbol (`tanda5-nav-tree.csv` → `nav-tree.generated.json`) sigue llevando **tokens**, no permisos. Se añaden 6 tokens en `role-tokens.ts:14-37`, `scripts/build-nav-tree.mjs:57` y `tests/nav-tree-contract.test.mjs` (L99-106 rechaza tokens desconocidos), y `ROLE_TEMPLATE_TO_TOKEN` L73-85 mapea las 23 plantillas (§4.2). El CSV se revisa fila a fila para los tokens nuevos: `administracion` en Mi día, Asistente, Facturación y cobros, Proveedores y gastos, Cierre del día, Tesorería, Conciliación bancaria, Compras e inventario, Impuestos, Registro de viajeros, Bandeja de cumplimiento, Centro de informes (solo la base: la pestaña Exportaciones de revenue exige `revenue.history_forecast.read` y sigue en revenue|direccion|admin) y Finanzas › Activo inmobiliario; `rrhh` en Nóminas y Personal y turnos; `propiedad` en Mi día, Propietario, Centro de informes, Cartera, Estados contables y Finanzas › Activo inmobiliario; `activos` en Finanzas › Activo inmobiliario (ítem nuevo del documento hermano, `/finanzas/activo-inmobiliario`), Proveedores y gastos › Inmovilizado, Cumplimiento › Centro y Configuración › Estructura societaria; `auditoria` en todo salvo Configuración › Usuarios y roles, Sistema › Webhooks/Aplicaciones/Organizaciones/Organización (estas dos últimas exigen `admin.tenants.manage`) y Comunicaciones › Correo entrante (su único GET, `/email/connections/:id/authorize-url`, inicia un OAuth y lleva `integrations.connect`); `sistemas` solo en Configuración › Usuarios y roles, Módulos e integraciones (sin la pestaña Modo sombra OPERA, que exige `accounting.read`), Sistema (Auditoría, Webhooks, Aplicaciones, Referencia de API) y Comunicaciones. Ningún ítem del árbol tiene `roles` vacío (Mi día lista explícitamente los 9 tokens), así que un token nuevo no ve nada hasta que se añade a sus filas [V `nav-tree.generated.json`]. La prueba «cada plantilla abre todas las rutas GET de lo que ve» (`rbac-nav-contract.test.mjs:641-748`) amplía `TOKEN_TEMPLATES` (L45-60: `recepcion` = receptionist + night_auditor + front_office_manager, `pisos` = housekeeper + housekeeping_manager, `mantenimiento` = maintenance + maintenance_manager, `fnb` = fnb + fnb_manager, `direccion` = manager + operations_director + general_manager, `finanzas` = accountant + controller + compliance, y un token por plantilla para los nuevos) y debe cerrar los 7 huecos de tipo `pending` de los 21 `JUSTIFIED_GAPS` (L108, 133, 205-238: manager sin `procurement.read`, `analytics.export`, `configuration.read`; accountant/compliance sin `configuration.read` e `integrations.read`; manager/receptionist/sales sin `categories.read`; fnb sin `pms.reservation.read`); los 14 restantes son `write`, `sister` o `inventory` y se mantienen. Con varias plantillas bajo un mismo token, un hueco de una plantilla N1 que cubre su hermana N2 es de tipo `sister` y el test lo admite (§4.10).
2. **Router = menú.** `navVisibility` (`role-tokens.ts:219`) se generaliza en `accessDecision(entry, scope)` → `visible | locked | hidden-role | hidden-module | dev-locked | unknown`; `menuCategories` (`nav-tree.ts:430-463`) y `resolveLocation` (`backoffice.routes.tsx:406-421`, `DevGuardInput` ampliado con `tokens`, `modules`, `modulesKnown`, `isPlatformAdmin`) llaman a la misma función; `routeFromLocation`/`resolveScreenTarget` (`App.tsx:456,481`) pintan `ForbiddenScreen` (`UI_STATES.forbidden`) con «Ir a Mi día»; mientras `gate.loading` no se decide con tokens vacíos; al cambiar de propiedad se re-resuelve la ruta. Un test nuevo en `routes/__tests__` comprueba para cada URL de `allUrls()` × cada token que `resolveLocation(...).kind === "screen"` ⇔ `canSee`.
3. **«Ver como…».** Se ofrece a quien tiene `users.assign` o `roles.manage` en el ámbito activo (DirH, DirOps, DG, Adm, plataforma), limitado a las plantillas de nivel ≤ el propio; simula tokens y módulos (nunca permisos) y se aplica también al router (punto 2) pero no a `/desarrollo/*` (flag real). Banner persistente «Viendo como Recepción · solo menú». La condición `users.assign`/`roles.manage` se evalúa en `useEnabledModules.ts`/`view-as.ts`, nunca en `role-tokens.ts`: `tests/rbac-nav-contract.test.mjs:631` exige que `grantedPermissions` aparezca exactamente dos veces en ese fichero.
4. **Pantalla «Usuarios y roles»** (`/configuracion/usuarios`, sustituye a `UserRoleManager.tsx`): pestañas «Este hotel» (ámbito property activo) y «Sociedad» (visible con `users.read` en ámbito `legal_entity`/`organization`); tabla: usuario, plantilla RBAC real (`Role.templateKey`, nunca `roleLabel`), nivel, ámbito, hoteles, último acceso, estado, 2FA; acciones: **Cambiar rol** (escribe `user_role_assignments`), **Añadir hotel/grupo**, **Retirar de este hotel** (revoca la asignación, no el usuario), **Desactivar usuario** (todo), **Restablecer PIN**; drawer de rol con comparador de plantillas (claves por módulo, §4.3) y «roles con permisos idénticos» (revisión trimestral, patrón Mews); avisos de SoD en rojo si una combinación de asignaciones viola §4.7.
5. **Invitaciones** (`UserInvitation` 460-470 gana `scopeType/scopeRef`, `roleId` obligatorio, `expiresAt` ≤ 7 días, `invitedByUserId`): se invita a un ámbito y plantilla ≤ nivel propio; al aceptar se crea la asignación (hoy `invitations.service.ts:466`), `mustChangePassword` y alta de 2FA para N2+; reenvío y revocación desde la pantalla.
6. **PIN de supervisor** (patrón OPERA): cuando un operativo pulsa una acción que requiere `*.override`/`*_approve` sin tenerla, `CocoaDialog` pide usuario + PIN de un supervisor presente (`POST /rbac/supervisor-authorizations`, sesión de 60 s ligada a la acción); el evento registra actor, autorizador, motivo, importe e IP.
7. **Bandeja de aprobaciones** (`/hoy/pendientes`): `approval_requests` filtradas por ámbito y clave del usuario; aprobar/rechazar con motivo; muestra el umbral aplicable y el segundo aprobador si procede. Cocoa 22: cero `style={}` nuevos, componentes `Cocoa*`, textos en español.

---

## §6 · API y migración

### 6.1 Modelo de datos (migración `2026091712xxxx_rbac_departamentos`, aditiva)

| Modelo (`@@map`) | Columnas | Notas |
|---|---|---|
| `Role` (existente) | + `level RoleLevel?`, `department String?`, `templateVersion Int @default(0)`, `managed Boolean @default(true)` | `managed=false` = rol personalizado (nunca lo toca el backfill, como hoy `rbac-catalog.ts:797-806`); `templateVersion` permite **revocar** claves al subir de versión (H9) |
| `PropertyGroup` (`property_groups`) + `PropertyGroupMember` | `organizationId`, `code`, `name`; miembros `propertyId` | clúster de hoteles (Galicia, Asturias-Cantabria…) |
| `UserRoleAssignment` (`user_role_assignments`) | `userId`, `roleId`, `scopeType ScopeType (property | property_group | legal_entity | organization)`, `propertyId?`, `propertyGroupId?`, `legalEntityId?`, `organizationId`, `validFrom`, `validTo?`, `grantedByUserId?`, `revokedAt?`, `revokedByUserId?`, `reason?` | `@@unique([userId, roleId, scopeType, propertyId, propertyGroupId, legalEntityId])`; `@@index([userId, revokedAt])`; `user_property_roles` se conserva (dual-read) hasta L6 |
| `RoleThreshold` (`role_thresholds`) | `organizationId`, `roleId`, `action ThresholdAction`, `maxAmount Decimal(14,2)?`, `maxPct Decimal(5,2)?`, `currency`, `requiresSecondApproval` | valores por defecto de §4.7 en el seed |
| `ApprovalRequest` (`approval_requests`) | `organizationId`, `propertyId?`, `kind` (`refund | folio_adjust | discount | rate_change | supplier_bill | purchase_order | payroll | capex | invoice_cancel | day_reopen`), `entityType/entityId`, `amount?`, `reasonCode`, `reasonText?`, `requestedByUserId`, `status (pending | approved | rejected | expired)`, `decidedByUserId?`, `decidedAt?`, `secondApproverUserId?`, `expiresAt` | `CHECK (decided_by_user_id IS NULL OR decided_by_user_id <> requested_by_user_id)` en la migración (SQL a mano documentado, como los triggers de la Tanda 6b) |
| `SupervisorAuthorization` | `actorUserId`, `authorizerUserId`, `permissionKey`, `entityType/entityId`, `amount?`, `reasonCode`, `expiresAt`, `usedAt?` | PIN de supervisor (§5.6); `User` gana `pinHash?`, `pinUpdatedAt?` |
| `BreakGlassSession` | `organizationId`, `openedByUserId`, `accountUserId`, `reason`, `ticket?`, `openedAt`, `closesAt`, `closedAt?`, `reviewedByUserId?`, `reviewedAt?` | §4.8 |
| `Organization` | + `rbacVersion Int @default(0)` | se incrementa en cada escritura de roles/asignaciones → invalida cachés de permisos |

### 6.2 Cálculo de permisos por petición (H1)

`loadUserContext` (`auth.service.ts:116-147`) pasa a devolver `assignments[]` (ámbitos expandidos a `assignedPropertyIds`, `orgScope: boolean`) y un `permissionsFor(propertyId | null)` memorizado por `(sessionId, rbacVersion)`. El preHandler de `server.ts:1356` resuelve **antes** la propiedad de la petición: parámetro `:propertyId`, resolver de tenencia de la entidad (`lib/tenancy.ts:398-419` ya existen), cabecera `x-property-id` enviada por `api-client` desde `getActivePropertyId()` para rutas sin propiedad, o `null` (rutas de organización → unión de asignaciones de ámbito `legal_entity`/`organization`). `assertRoutePermission` recibe los permisos de esa propiedad: como `tests/api-route-permissions-contract.test.mjs:285` fija literalmente `userContext?.permissions ?? []` en el preHandler, la resolución por propiedad **reescribe `request.userContext.permissions`** en un hook previo (después de `registerAuthContext`, antes del gate) en vez de cambiar la llamada, y el test conserva su regex; `grantPropertyAccess` (`tenancy.ts:110`) deja de tratar «sin asignaciones = todo» (`isPropertyAssigned` L93-97 devuelve `false` con lista vacía; el ámbito organización es explícito). `GET /users/me` expone `properties[].grantedPermissions` y `scopes[]`; `templateKeys` por propiedad se mantiene para el menú.

### 6.3 Rutas nuevas (manifiesto + partial `modules/rbac/route-permissions.partial.ts`)

| Ruta | Claves | Riesgo |
|---|---|---|
| `GET /rbac/assignments?userId|propertyId|scope` | `users.read` | medium |
| `POST /rbac/assignments` (crear), `DELETE /rbac/assignments/:id` (revocar con motivo) | `users.assign` (ámbito ⊆ propio, nivel ≤ propio; 403 `RBAC_LEVEL_EXCEEDED`, 409 `RBAC_SOD_CONFLICT`) | high |
| `GET /rbac/roles`, `POST /rbac/roles` (desde plantilla), `PATCH /rbac/roles/:id/permissions` | `roles.manage` / `permissions.manage` (solo quitar claves de la plantilla, nunca añadir fuera de ella: patrón OPERA template) | high |
| `GET /rbac/property-groups`, `POST`, `PATCH` | `organization.structure.manage` | high |
| `GET /rbac/thresholds`, `PUT /rbac/thresholds` | `accounting.configure` + `ai.high_risk.confirm` | critical |
| `GET /approvals`, `POST /approvals/:id/approve`, `POST /approvals/:id/reject` | la clave `*_approve` del `kind` (tabla en `approvals.service.ts`) | critical |
| `POST /rbac/supervisor-authorizations` | la clave de override del `permissionKey` solicitado (del autorizador) | high |
| `POST /rbac/break-glass`, `POST /rbac/break-glass/:id/close` | `security.break_glass` | critical |
| `GET /rbac/report` (roles y claves configurados, patrón OPERA «Configured Roles and Tasks») | `audit.read` | medium |
| `GET /rbac/access-log` | `audit.read` | medium |

### 6.4 `RBAC_STRICT=true`, demo y modo estricto en local

- `.env` local y `docs/runbooks/*` pasan a `RBAC_STRICT=true`; las 37 rutas no públicas con `permissions: []` reciben clave explícita o `riskLevel: "authenticated"` (nuevo valor del tipo L52, con test de contrato).
- `isDemoPermissionUnionEnabled` (`auth.service.ts:81-84`) deja de depender de `NODE_ENV` y de `HOTELOS_ALLOW_DEMO_AUTH`: nueva variable `HOTELOS_DEMO_PERMISSION_UNION` (`env.ts`, productionForbidden), **false** en el demo local; el fallback sin token (`auth-context.ts:236-240`) sigue existiendo solo para el demoStore y sigue recibiendo 401 en high/critical.
- Contrato `api-route-permissions-contract.test.mjs` amplía L307-311: `RBAC_STRICT` documentado, `HOTELOS_DEMO_PERMISSION_UNION` presente en `env.ts` y en `docs/api-contracts.md:9`.

### 6.5 `rbac:sync`, prune, versión de plantilla y backfill

- `permissions.ts` gana `ROLE_TEMPLATE_VERSION = 2` y `ROLE_TEMPLATE_REVOCATIONS: Record<RoleKey, PermissionKey[]>` (claves que la versión 2 **quita**, calculadas plantilla actual → matrices §4.4/§4.5 [V cálculo 2026-09-17]: **manager −16** `payment.capture`, `payments.capture`, `payment.refund`, `invoice.issue`, `billing.invoice.issue`, `billing.invoice.rectify`, `guest_register.export`, `assets.manage`, `backoffice.access`, `roles.manage`, `billing.configure`, `accounting.configure`, `payments.configure`, `payroll.manage`, `banking.reconcile`, `accounting.entity.read` (el ámbito sociedad pasa a la asignación); **accountant −6** `invoice.cancel`, `billing.configure`, `folio.charge.post`, `audit.read`, `commissions.read`, `payroll.manage`; **compliance −4** `audit.read`, `inventory.read`, `pos.read`, `commissions.read`; **sales −1** `analytics.export`; **fnb −1** `pos.product.manage` (cartas y precios pasan a `fnb_manager`); **owner −164** (todo lo operativo y de configuración: queda en 64 claves de lectura y aprobación) y **admin −155** (todo lo financiero y operativo: queda en 68 de sistema); receptionist, housekeeper, maintenance y revenue no pierden ninguna). `manager` conserva `invoice.cancel` y `payments.refund_approve` (X/A de M2-M3, DirH aprueba y ejecuta lo que solicitan Rec/AdmH) y pierde `payment.capture`/`invoice.issue` (SoD emisor ≠ aprobador, cajero ≠ aprobador de reembolsos). `backfillTemplateRoles` (`rbac-catalog.ts:700`): para roles `managed` con `templateVersion < ROLE_TEMPLATE_VERSION` aplica altas **y** revocaciones y sella la versión; roles `managed=false` intactos; `--dry-run` lista los grants que se retirarían por rol; auditoría `ROLE_TEMPLATE_UPGRADED`.
- `rbac:sync --prune` (`scripts/rbac-sync.ts:59`): de las 52 claves sin ruta, 12 tampoco aparecen en `module-route-map.ts` ni en ningún servicio (`distribution.ai_recommend`, `pos.product.manage`, `integrations.configure`, `integrations.view_logs`, `tax.configure`, `revenue.history_forecast.configure`, `revenue.scheduled_reports.manage`, `crm.export`, `groups.manage_billing`, `kiosk.configure`, `iot.manage`, `developer.manage_sandbox`); 10 de ellas sí están en la baseline demo (`demo-store.ts:2386-2491`) y en `tests/backoffice-contract.test.mjs:185-190` / `tests/revenue-history-forecast-contract.test.mjs:35-40`, y solo `distribution.ai_recommend` y `pos.product.manage` carecen de referencia fuera del catálogo [V grep 2026-09-17]. Ninguna se poda: se **cablean** a rutas en L2 (manifiesto). Se poda únicamente `capex.approve` (muerta, 0 rutas, 0 servicios, ausente de la baseline) después de que L2 haya cableado `capex.read`/`capex.create`, siguiendo el orden del runbook `docs/runbooks/rbac-sync.md` (seed → dry-run → copia → prune → recuento).
- Script nuevo `rbac:migrate-assignments --org <id> [--dry-run | --apply --confirm <id>]` (mismo patrón que `reseed-property-roles.ts:33-36`): cada `user_property_roles` → `user_role_assignments` de ámbito `property`; **Faranda**: Carmen (Owner ×8) → una asignación `owner` de ámbito `organization` (y se crea `general_manager` para ella si César lo decide, D1); `recepcion.tilos` → `receptionist` en LT; **demo org_123**: `reception@example.com` conserva «Local Super Admin» (custom, plataforma) como asignación `organization`; `provisionDefaultTemplateRoles` (L461) crea las 23 plantillas en organizaciones nuevas y `createTenant` de admin-console las 23 + break glass.
- `reseed-property-roles.ts` aprende las plantillas nuevas y bloquea `--apply` si hay roles personalizados (como hoy, L21).

### 6.6 Auditoría de accesos

Acciones nuevas en `AuditEvent` (cadena hash existente, retención fiscal, nunca purga a 30-180 días como OPERA): `ACCESS_DENIED` (ruta, clave que faltaba, propiedad; limitado a 1 por minuto por usuario y ruta), `ROLE_ASSIGNED`, `ROLE_REVOKED`, `ROLE_TEMPLATE_UPGRADED`, `ROLE_PERMISSIONS_EDITED`, `USER_DISABLED` (normaliza el `UserDisabled` camelCase de `backoffice.service.ts:5253`; `UserDepartmentAssigned` :4964 pasa a `USER_DEPARTMENT_ASSIGNED`), `PROPERTY_SWITCHED`, `APPROVAL_REQUESTED/DECIDED`, `SUPERVISOR_AUTHORIZED`, `BREAK_GLASS_*`, `LOGIN_FAILED`; `ipAddress` y `deviceId` (columnas ya existentes, 4695-4696) se rellenan siempre. `GET /rbac/access-log` y el informe «roles y claves configurados» sirven la revisión trimestral (PCI req. 7) y la baja inmediata (`validTo` en la asignación al cursar la baja en nóminas, gancho en `payroll/contracts/:id/deactivate`).

---

## §7 · Lotes

Ficheros **exclusivos** por lote; tipos wire y `packages/shared` en L0 para que L1, L2 y L4 corran en paralelo. Orden: **L0 → {L1 ∥ L2 ∥ L4} → L3 (tras L1) → L5 (tras L1-L4) → L6 → L7**.

| Lote | Ficheros exclusivos | Tests y puertas |
|---|---|---|
| **L0 · Catálogo, plantillas, schema, migración** | `packages/shared/src/{permissions.ts, types.ts, rbac-types.ts (nuevo), index.ts}`; `packages/database/prisma/schema.prisma`; `packages/database/prisma/migrations/2026091712xxxx_rbac_departamentos/migration.sql`; `tests/rbac-nav-contract.test.mjs` (solo el bloque de plantillas L435-491: `ORGANIZATION_TEMPLATE_ROLE_KEYS` = todas menos `admin` **y** `break_glass`, etiquetas ES = `ROLE_TEMPLATE_KEYS`, alias por plantilla) y `tests/nav-tree-contract.test.mjs:153-158` (toda plantilla mapeada a un token) | `prisma validate`; `db:migrate:status`; `db:drift:check`; `db:migrations:check` (`scripts/check-migrations-vs-schema.mjs`); `tests/{migrations-squash-contract, backoffice-contract}.test.mjs`; nuevo `tests/rbac-sod-contract.test.mjs` (pares incompatibles de §4.7 sobre `ROLE_PERMISSION_MAP`, 23 plantillas, etiquetas ES, `ORGANIZATION_TEMPLATE_ROLE_KEYS` = 22 (todas menos `admin`, decisión D6), `ROLE_TEMPLATE_REVOCATIONS` ⊆ claves, `analytics.read` y `modules.read` en todas); typecheck de shared, database, api y admin-web |
| **L1 · Contexto, ámbito y aprobaciones (API)** | `apps/api/src/modules/auth/auth.service.ts`; `apps/api/src/lib/{tenancy.ts, finance-scope.ts, rbac-catalog.ts, rbac-scope.ts (nuevo), env.ts, auth-context.ts}`; `apps/api/src/modules/rbac/{assignments.service.ts, approvals.service.ts, thresholds.service.ts, supervisor.service.ts, break-glass.service.ts, rbac.routes.ts, route-permissions.partial.ts}` (módulo nuevo; no existe hoy [V]); `apps/api/src/modules/rbac/__tests__/*`; `tests/integration/rbac-scope.test.mts` (existe desde L1c: se amplía, no se crea) | unit: permisos por propiedad (Recepción en A + Contabilidad en B), ámbito organización explícito, umbrales, `requestedBy ≠ decidedBy` (409 `RBAC_SOD_CONFLICT`), caducidad; integración con org aislada `org_rbac_<run>`: 403 en B con rol solo en A, 404 opaco, aprobación en dos pasos, break glass con cierre automático; `tests/api-route-permissions-contract.test.mjs` |
| **L2 · Servicios con SoD** | `apps/api/src/modules/{payments/payments.service.ts, invoicing/invoice.service.ts (anulación; no existe `billing/` ni `invoices/` [V]), invoicing/route-permissions.partial.ts, payables/supplier-bills.service.ts, payables/route-permissions.partial.ts, night-audit/{night-audit.service.ts, route-permissions.partial.ts}, advanced/advanced-modules.service.ts (pedidos de compra: `transitionAdvancedRecord` :2601; las rutas `/procurement/*` viven en `server.ts:2966`, no hay `modules/procurement/` [V]), payroll/{periods.service.ts, contracts.service.ts, route-permissions.partial.ts}, revenue/rate-changes.service.ts (nuevo), rate-manager/route-permissions.partial.ts (bulk-update), assets/assets.service.ts, pos/{pos.service.ts, pos.routes.ts, route-permissions.partial.ts}, maintenance/maintenance.service.ts}` + `apps/api/src/security/route-permissions.ts` (capex :832-841, audit :1038-1043, work-orders, GET de configuración) + `apps/api/src/server.ts` (rutas de capex y procurement) + `tests/assets-owner-contract.test.mjs` (solo si cambia la clave de aprobación de capex) + `tests/rbac-nav-contract.test.mjs` (`READ_GATED_GETS` L524-554 y `JUSTIFIED_GAPS` L90-271) | cada mutación sensible exige `approval_requests` aprobado o clave de ejecución con umbral; `tests/rbac-nav-contract.test.mjs` (`JUSTIFIED_GAPS` sin `pending`); integración de reembolso, anulación (registro de anulación VeriFactu intacto: `tests/integration/verifactu-*`), factura de proveedor por importe, cierre/reapertura, nómina |
| **L3 · Backfill, scripts, sync, docs de API** | `apps/api/src/scripts/{rbac-migrate-assignments.ts (nuevo), rbac-sync.ts, reseed-property-roles.ts}` + `__tests__`; `apps/api/package.json`; `apps/api/src/modules/admin-console/tenant-admin.service.ts`; `apps/api/src/modules/structure/property-provisioning.service.ts`; `apps/api/src/modules/onboarding/bootstrap.service.ts`; `apps/api/src/modules/auth/{invitations.service.ts, auth-pilot.service.ts}`; `apps/api/src/modules/backoffice/backoffice.service.ts`; `docs/api-contracts.md`; `docs/runbooks/rbac-sync.md` | dry-run sobre Faranda: 9 filas → 2 asignaciones (Carmen `organization`, LT receptionist) + informe de revocaciones por rol (manager −16, accountant −6, compliance −4, sales −1, fnb −1, owner −164, admin −155; §6.5); reseed idempotente (`rbac-nav-contract.test.mjs:589`); `rbac:sync --dry-run` con 0 stale salvo `capex.approve` |
| **L4 · Front** | `apps/admin-web/src/navigation/{role-tokens.ts, nav-tree.ts, useEnabledModules.ts, view-as.ts, Sidebar.tsx}`; `apps/admin-web/src/routes/backoffice.routes.tsx` + `__tests__/route-access.test.mts` (nuevo); `apps/admin-web/src/App.tsx`; `apps/admin-web/src/screens/{users/UsersRolesScreen.tsx (sustituye UserRoleManager.tsx), users/AssignmentDrawer.tsx, users/RoleComparePane.tsx, approvals/ApprovalsScreen.tsx}` (carpetas nuevas); `apps/admin-web/src/components/SupervisorPinDialog.tsx` (no existe `screens/components/` [V]); `apps/admin-web/src/services/{rbacApi.ts, approvalsApi.ts, api-client.ts (x-property-id)}`; `scripts/build-nav-tree.mjs`; `../pilots/tanda5-nav-tree.csv` (fuera del repo) → `nav-tree.generated.json` | `tests/{nav-tree-contract, sidebar-nav-contract, rbac-nav-contract, admin-web-spanish-copy-contract, admin-web-no-raw-fetch, cocoa-22-contract}.test.mjs`; `node scripts/check-discoverability.mjs` + nuevo `check-route-access.mjs`; typecheck admin-web; cero `style={}` nuevos (Cocoa 22 cerrado) |
| **L5 · Datos de demo** | `packages/database/prisma/seed-rbac-demo.ts` (nuevo, script `db:seed:rbac-demo` en `package.json:26` y `packages/database/package.json:15`, mismo patrón que `db:seed:commercial`); `apps/api/src/scripts/specs/faranda-*.json` (usuarios ficticios por hotel, §8.1; solo existen 7 specs: AS, FN, LL, LT, MC, OC, PG — Rías Altas no tiene spec, sus usuarios van en el seed) | 19 usuarios Faranda con `mustChangePassword`; login real de cada plantilla abre su `roleHome` y recibe 0 × 403 en las GET de su menú (script `scripts/check-role-smoke.mjs` sobre `app.inject`) |
| **L6 · Corte, prune y auditoría** | `docs/audits/TANDA-10-RBAC-2026-09-xx.md`; retirada del dual-read de `user_property_roles` (migración de borrado separada) | `RBAC_STRICT=true` + `HOTELOS_DEMO_PERMISSION_UNION=false` en local; `rbac:sync --prune` de `capex.approve`; SQL: 0 `user_property_roles` vivos, 23 roles × 2 orgs, versiones = 2, 0 claves huérfanas |
| **L7 · Gestión del activo (documento hermano)** | módulo `real-estate` (rutas `/properties/:propertyId/real-estate/*`, servicio, ítem Finanzas › Activo inmobiliario `/finanzas/activo-inmobiliario`, `ASSET-MANAGEMENT-INMOBILIARIO.md` §7-8) sobre el almacén de documentos de la Tanda 9 | usa las 4 claves `real_estate.read`, `real_estate.manage`, `real_estate.documents.manage`, `property_tax.manage` y la plantilla `asset_manager` de esta tanda; el documento hermano las reparte hoy entre `accountant`/`compliance`/`manager` (§7.1) hasta que exista `asset_manager` (D7) |

---

## §8 · Datos de demo y decisiones para César

### 8.1 Usuarios ficticios de Faranda (todos `@faranda.test`, nombres inventados, contraseña de un solo uso)

| Usuario | Plantilla | Ámbito |
|---|---|---|
| `recepcion.tilos` (existe), `recepcion.pathos` | receptionist | LT · PG |
| `auditoria.noche.tilos` | night_auditor | LT |
| `jefatura.recepcion.tilos` | front_office_manager | LT |
| `pisos.tilos`, `gobernanta.tilos` | housekeeper · housekeeping_manager | LT |
| `mantenimiento.rias`, `encargado.mantenimiento.rias` | maintenance · maintenance_manager | RA (sin spec `faranda-rias-altas.json`: se siembran desde `seed-rbac-demo.ts`) |
| `tpv.pathos`, `jefatura.ab.pathos` | fnb · fnb_manager | PG |
| `comercial.galicia` | sales | grupo Galicia (LT + RA) |
| `administracion.tilos` | admin_clerk | LT |
| `direccion.tilos`, `direccion.rias` | manager | LT · RA |
| `operaciones.norte` | operations_director | grupo Asturias-Cantabria (PG + MC + AS) |
| `revenue` | revenue | organización |
| `contabilidad`, `direccion.financiera`, `rrhh`, `cumplimiento`, `activos` | accountant · controller · payroll_hr · compliance · asset_manager | sociedad CELUISMA (todos los centros) |
| `direccion.general`, `auditoria.interna`, `sistemas` | general_manager · auditor · admin | organización |
| `direccion@farandariasaltas.es` (Carmen, existe) | owner (+ general_manager si D1) | organización |
| `emergencia-1`, `emergencia-2` | break_glass | organización, sin persona |

### 8.2 Decisiones que solo César puede tomar

| # | Decisión | Por defecto en esta tanda | Efecto si cambia |
|---|---|---|---|
| D1 | **Carmen**: ¿propiedad, dirección general o ambas? Hoy es Owner con las 222 claves en 8 hoteles [V SQL] | `owner` (estrechada) + `general_manager`, ámbito organización | Solo `owner`: pierde operaciones diarias y aprobaciones ≤ T4 |
| D2 | **Umbrales T1-T4** (50 / 300 / 3.000 / 15.000 €; doble > 60.000 €) y bandas de tarifa (± 15 %) | Valores de §4.7 en `role_thresholds` | Se editan por organización sin tocar código |
| D3 | **Subdirección**: ¿plantilla propia o `manager` con umbrales T2? | Sin plantilla; umbrales por rol | Plantilla `deputy_manager` (24.ª) sin `payroll.approve`, `users.*`, `capex.*` |
| D4 | **¿Quién corre y quién revisa el cierre del día?** Hoy exige `accounting.journal.post` [V] | Auditor nocturno corre; administrativo de hotel (o contabilidad central si no hay) revisa | Si recepción de tarde cierra: `night_audit.run` en `receptionist` y revisión obligatoria central |
| D5 | **Grupos de propiedades** (Galicia = LT + RA; Asturias-Cantabria = PG + MC + AS; FN y LL: ¿Madrid/otro?) y perímetro real (7 hoteles del brief frente a 5 en la web pública) | Dos grupos de ejemplo en el seed | Cualquier reparto: tabla, no código |
| D6 | **Plantilla `admin` de organización**: ¿se conserva como «Administración de sistema» sin finanzas o desaparece? | Se conserva sin claves financieras/operativas, con token `sistemas` | Si desaparece, `sistemas` usa `general_manager` + `roles.manage` (rompe SoD sistema ≠ finanzas) |
| D7 | **CELUISMA propietaria y explotadora**: ¿existe asset manager y auditoría interna como personas, o los asume dirección financiera? | Plantillas creadas; usuarios de demo ficticios | Sin personas: no se asignan; las claves `real_estate.*` van a `controller`/`compliance` |
| D8 | **2FA/PIN**: TOTP obligatorio para N2+ y PIN de supervisor en recepción | Sí (PCI req. 7/8, login compartido prohibido) | Sin 2FA: solo contraseña + `mustChangePassword`; el PIN se mantiene |
| D9 | **Retención de `audit_events`** de accesos (propuesta: 6 años, con el resto de la cadena) | 6 años | Menor retención exige política de purga que hoy no existe |
| D10 | **Nóminas de la gestoría**: ¿el registro mensual lo aprueba DG o cada director de hotel? | DG aprueba el registro; DirH las variaciones de su hotel | Solo DirH: `payroll.approve` también en `manager` con umbral por hotel |

---

## §9 · Riesgos

| Riesgo | Mitigación |
|---|---|
| Estrechar `manager`, `accountant`, `owner` y `admin` deja sin acceso a operaciones que hoy funcionan «por exceso» (403 nuevos) | `ROLE_TEMPLATE_REVOCATIONS` explícitas y listadas en el dry-run; smoke por plantilla (L5) sobre todas las GET del menú; `JUSTIFIED_GAPS` a 0 `pending`; despliegue con `RBAC_STRICT=true` en local antes que en el VPS |
| Permisos por propiedad de la petición cambian el comportamiento de 969 rutas | Resolución centralizada en el preHandler con orden `is404 → auth → propiedad → permiso → tenencia` (guardas Tanda 3 intactas, `api-route-permissions-contract.test.mjs:288-302`); rutas sin propiedad usan cabecera o ámbito organización; test de integración A/B |
| Dual-read `user_property_roles` ∪ `user_role_assignments` durante L1-L5 | Lector único `rbac-scope.ts`; escritores existentes (6) redirigidos en L3; borrado solo en L6 tras SQL de verificación |
| Motor de aprobaciones bloquea la operación si no hay aprobador presente (hotel pequeño, turno de noche) | PIN de supervisor presencial; escalado automático al siguiente nivel a los 30 min; `RoleThreshold.requiresSecondApproval` solo > T4; break glass como último recurso auditado |
| CSV del árbol fuera del repo (`pilots/tanda5-nav-tree.csv`, git-ignored) y `screens-inventory.csv` solo en local | El integrador regenera el JSON committed; el test `rbac-nav` sigue omitiendo la parte de inventario en CI (L641); `check-route-access.mjs` no depende del CSV |
| Token `admin` ambiguo (H11) y pantallas dev-only | El token `admin` sigue siendo el de plataforma (`tests/nav-tree-contract.test.mjs:82` exige dev-only = [`admin`] y `rbac-nav-contract.test.mjs:57` lo modela como pseudo-plantilla `platform`); la plantilla org `admin` recibe el token nuevo `sistemas` (§5.1). Con el token `admin` la plantilla estrechada vería los 67 ítems y recibiría 403 en 143 pares pantalla×clave [V cálculo §4.10] |
| Unión demo desactivada rompe el walkthrough de la demo (usuario sin token en pantallas high/critical ya recibe 401) | `HOTELOS_DEMO_PERMISSION_UNION` documentado; el walkthrough pasa a usar los 19 usuarios ficticios; `HOTELOS_ALLOW_DEMO_AUTH` intacto para el demoStore |
| `CHECK` y trigger escritos a mano en la migración (drift) | Mismo patrón y misma cabecera que `20260916102000` (Tanda 6b); `db:drift:check` en cada lote |
| Sesiones vivas con permisos antiguos (32/17/3 sesiones activas en local [V SQL]) | `rbacVersion` en la organización invalida la caché en la siguiente petición; revocar asignación cierra las sesiones del usuario en esa propiedad |
| 52 claves sin ruta (12 sin referencia en código de producto fuera de la baseline demo): podarlas rompería la baseline (`demo-store.ts:2386-2491`), `module-route-map.ts` (93 referencias a `permission`) y dos contract tests | No se poda en esta tanda salvo `capex.approve`; las claves muertas se cablean en L2; `rbac:sync --dry-run` en cada lote |
| Umbrales y motivos mal parametrizados (todo a 0 → nada se puede hacer; todo ∞ → sin control) | Seed con los valores de §4.7; validación `PUT /rbac/thresholds` (T1 < T2 < T3 < T4, motivos ≥ 1 por catálogo); informe de umbrales en `GET /rbac/report` |
| Cocoa 22 cerrado: pantallas nuevas sin `style={}`, sin `<table>` crudo, sin inglés | Solo `Cocoa*`; `tests/cocoa-22-contract.test.mjs` y `admin-web-spanish-copy-contract` en L4; el integrador regenera `cocoa-22-inventory.json` |

---

## §10 · Correcciones del recon y decisiones de planificación (Tanda 8a, 2026-09-17)

Anexo del plan de ejecución (brief de la Tanda 8a, orquestador + recon del 2026-09-17 sobre HEAD 1bdc173 y la BD local). No reescribe §1-§9: donde una cifra o una línea de aquí difiere de las de arriba, **vale esta**. Todo lo de §10.1 es [V] (código leído con fichero:línea, SQL sobre la BD local o cálculo sobre el manifiesto/el árbol el 2026-09-17/18); §10.2 son decisiones de planificación de los lotes L0-L6 (D del orquestador, no de César).

### 10.1 Correcciones del recon

| # | Punto del diseño | Corrección verificada |
|---|---|---|
| C1 | H5 (§3.4): «manager **y accountant** con `payment.capture` + `payment.refund`» | `accountant` (versión 1, 34 claves) **nunca** tuvo `payment.capture`, `payments.capture`, `payment.refund` ni `payments.refund_*`; sí `invoice.issue` + `invoice.cancel` y `accounting.journal.post` + `banking.reconcile` + `payroll.manage`. El par cajero ≠ aprobador de reembolsos solo afectaba a `manager` (111 claves, con las 7). La versión 2 rompe en `accountant` los pares que sí tenía (−6: `invoice.cancel`, `payroll.manage`, `folio.charge.post`, `audit.read`, `commissions.read`, `billing.configure`) |
| C2 | Manifiesto «969 entradas (776 propias + 17 partials)» (§3.2, §4.10, §9) | **984 entradas** (public 25 · low 209 · medium 377 · high 301 · critical 72) y **18 partials** `*route-permissions.partial.ts` (16 `route-permissions.partial.ts` en `modules/*` + `accounting/fiscal-route-permissions.partial.ts` + `accounting/ledger-import-route-permissions.partial.ts`); las Tandas 6b-7c añadieron 15 rutas tras la lectura de §3 |
| C3 | Líneas de `apps/api/src/security/route-permissions.ts` (§3.2, §4.6, §7) | tipo `riskLevel` **L58** (no L52); `assertRoutePermission` **L1434-1457** (no L1421-1444); `POST /payments/:id/refund` **L751** (no L738); capex `GET /properties/:propertyId/capex` **L845** y `POST /capex-projects`, `PATCH /capex-projects/:id`, `POST …/items` **L852-854** (no L832-841); GET de auditoría con `ai.high_risk.confirm` **L1051-1056** (no L1038-1043) |
| C4 | `server.ts:1356-1363,1410` (§3.2, §6.2) | gate de permisos (preHandler con `is404`, riesgo del fallback demo y `assertRoutePermission` con `userContext?.permissions ?? []`) **L1338-1367**; hook de tenencia (`pickPropertyId` → `grantPropertyAccess`) **L1404-1413** |
| C5 | Líneas de `schema.prisma` (§3.1, §6.1) | iban desplazadas +9/+10 en HEAD (`User` 442, `UserInvitation` 470, `UserDepartment` 738, `Role` 2848…). Tras la migración de L0 (`20260918100000_rbac_departamentos`: 5 `CREATE TYPE` en L287-350, 11 `ADD COLUMN`, 7 `CREATE TABLE`, 18 índices, 2 `CHECK` a mano) son: `User` L505 (+`pinHash` L528), `UserInvitation` L538 (`scopeType/scopeRef/invitedByUserId` L554-556), `UserDepartment` L811, `Role` L2925, `Permission` L2944, `RolePermission` L2952, `UserPropertyRole` L2961, `PropertyGroup` L2978, `PropertyGroupMember` L2991, `UserRoleAssignment` L3004, `RoleThreshold` L3029, `ApprovalRequest` L3051, `SupervisorAuthorization` L3082, `BreakGlassSession` L3104, `AuditEvent` L4941; `Organization.rbacVersion` L355 |
| C6 | Front: `Sidebar.tsx:141`, `nav-item-tabs.ts:201-216`, `App.tsx:426-428` (§3.3, §3.4, §5.2) | «Ver como…» solo plataforma en `apps/admin-web/src/navigation/Sidebar.tsx` **L147** (`gate.isPlatformAdmin`); el copy «Sin acceso» (`emptyTabsCopy`, `case "role"` → `UI_STATES.forbidden`) vive en `apps/admin-web/src/screens/tabs/nav-item-tabs.ts` **L206-218** (carpeta `screens/tabs/`, no `navigation/`); `devGuard()` de `App.tsx` **L427-429** (`search`, `storageValue`, `isPlatformAdmin`: sin tokens ni módulos, como dice H12) |
| C7 | `UserContext` (§6.2) | el tipo que el preHandler reescribe (`request.userContext.permissions`) es `UserContext` de `apps/api/src/lib/demo-store.ts:1593` (`organizationId`, `propertyId`, `userId`, `permissions`…), no un tipo de `auth.service.ts` |
| C8 | «6 escritores de `user_property_roles`» (§1.1, §9) | son **7**: `packages/database/prisma/seed.ts:247` (`prisma.userPropertyRole.upsert` de `usr_123` en `prop_123`, tras crear «Local Super Admin» en L233-245) sigue sembrando la tabla vieja; hasta que escriba en `user_role_assignments`, la migración de borrado del dual-read no puede ejecutarse (`docs/runbooks/rbac-sync.md` §8) |
| C9 | «`capex.approve` (muerta) es la única clave que se poda en L6» (§4.3, §4.6, §6.5, §7) | `packages/product/src/modules/module-manifest.ts:377` la referencia en el módulo de CAPEX (`permissions: ["capex.read", "capex.create", "capex.approve"]`): **no se poda** (regla del runbook: nunca `--prune` con una referencia viva). Queda en el catálogo (250 claves) y en `owner`; retirarla empieza por `module-manifest.ts` en una tanda posterior |
| C10 | Nóminas gateadas por `payroll.manage` (§3.4 H6/H7, §4.6) | `apps/api/src/modules/treasury/permissions.ts` evalúa **OR** (`PAYROLL_WRITE_KEYS = [payroll.manage, accounting.journal.post]`, `PAYROLL_READ_KEYS`, `PAYROLL_EXPORT_KEYS`; `anyOf.some(...)`), y la ruta de pago vive en el partial de **treasury** (`treasury/route-permissions.partial.ts:40`: `POST /payroll/periods/:id/pay`, `payroll.manage`, critical), no en `payroll/`. L2 añade `POST /payroll/periods/:id/approve` (`payroll.approve`) y hace que `pay` exija registro aprobado (409 `PAYROLL_NOT_APPROVED`) |
| C11 | Pantalla de usuarios «por propiedad» (§3.3) | `listBackOfficeUsers(propertyId)` (`backoffice.service.ts:4968`) devolvía **todos los usuarios de la organización** (`prisma.user.findMany({ where: { organizationId } })`), no los de la propiedad: la pestaña «Este hotel» de L4 filtra por asignaciones que cubran la propiedad y «Sociedad» es la que lista la organización |
| C12 | Cabecera `x-property-id` (§1.7, §6.2) | `apps/admin-web/src/services/api-client.ts` **no** la envía hoy (0 apariciones): L4 la añade desde `getActivePropertyId()`; hasta entonces las rutas sin `:propertyId` se resuelven con ámbito nulo (§10.2) |
| C13 | Claves «existentes muertas» (§4.6) | `night_audit.reopen` y `pos.order.void` no existían en el catálogo: son **capacidades nuevas** (dos de las 27 de L0), no claves recableadas |
| C14 | Alias y orden de `ROLE_TEMPLATE_KEYS` (§4.2) | confirmado el riesgo: `administracion` → `accountant` y `director|direccion|gestion` → `manager` capturaban las etiquetas nuevas; L0 coloca las 13 plantillas nuevas **antes** de `owner`, `admin`, `manager`… (`permissions.ts:2238-2262`) y `rbac-catalog.ts:801-812` añade alias exactos por plantilla («administrativo/a» → `admin_clerk`, «auditoría» → `auditor`, «operaciones» → `operations_director`, «rrhh» → `payroll_hr`…) |
| C15 | Árbol «286 filas, 100 pestañas» (§3.3, §4.10) | `nav-tree.generated.json` meta: **287 filas** del CSV, 9 categorías, 67 ítems, **101 pestañas**, 21 dev-only, 2 públicas, 205 legacy (la Tanda 7c añadió una pestaña) |
| C16 | BD local «19.674 `audit_events`, 1.255 `AUTH_LOGIN`, 32/17/3 sesiones» (§3.2, §9) | SQL 2026-09-18: **27.731 `audit_events`**, **1.663 `AUTH_LOGIN`**, **53 sesiones**; 223 `permissions`, 21 `roles`, 10 `user_property_roles`, 0 `user_role_assignments` (tabla nueva vacía) |
| C17 | Revocaciones «owner −164, admin −155» (§6.5, §7 L3) | `ROLE_TEMPLATE_REVOCATIONS` de L0 fija **owner −162** (queda en 65 claves, no 64) y **admin −154** (queda en 70, no 68) al cuadrar las matrices con las claves nuevas que ambas conservan; manager −16, accountant −6, compliance −4, sales −1 y fnb −1 coinciden. La cifra buena es la que imprime `rbac:sync --dry-run --upgrade-templates` (`docs/runbooks/rbac-sync.md` §2); tamaños reales de las 24 plantillas en la línea `templates:` del dry-run del 2026-09-18 (receptionist 75 · night_auditor 51 · front_office_manager 101 · housekeeper 12 · housekeeping_manager 34 · maintenance 25 · maintenance_manager 47 · fnb 22 · fnb_manager 48 · sales 51 · admin_clerk 51 · manager 205 · operations_director 110 · revenue 53 · accountant 57 · controller 80 · payroll_hr 11 · compliance 58 · asset_manager 27 · general_manager 117 · owner 65 · auditor 68 · admin 70 · break_glass 249), frente a los estimados de §4.10 |

### 10.2 Decisiones de planificación de los lotes

| Decisión | Detalle | Lote |
|---|---|---|
| **Manifiesto completo en L1** | `tests/api-route-permissions-contract.test.mjs` exige igualdad de conjuntos **en ambos sentidos** (rutas registradas = manifiesto): el partial `modules/rbac/route-permissions.partial.ts` y el registro de las 16 rutas de §6.3 en `server.ts` van juntos en L1; ninguna ruta se declara sin registrar ni se registra sin declarar | L1 |
| **L4 tras L2** | El front (pantalla de usuarios, bandeja, PIN) consume los códigos 409/403 y los `approvalRequestId` que fijan los servicios de L2; el orden pasa a L0 → {L1 ∥ L2} → L3 (tras L1) → L4 (tras L2) → L5 → L6 | L4 |
| **Backfill de arranque aditivo + upgrade manual** | El arranque nunca revoca: `backfillTemplateRoles` solo informa (`revocationsByRole`); `rbac:sync --upgrade-templates` aplica `ROLE_TEMPLATE_REVOCATIONS` a roles `managed` tras dry-run y copia (`rbac-sync.md` §2) | L0, L3 |
| **`HOTELOS_DEMO_PERMISSION_UNION` = false por defecto** | Variable nueva en `env.ts` (`productionForbidden`), desacoplada de `NODE_ENV` y de `HOTELOS_ALLOW_DEMO_AUTH`; la demo local corre con el RBAC real y `RBAC_STRICT=true` | L1 |
| **Recálculo de permisos por entidad siempre que difiera** | Si la propiedad resuelta de la entidad (`tenancy.ts`) difiere de la cabecera o de la primera asignación, el hook recalcula `request.userContext.permissions` para la propiedad de la entidad, en toda ruta, sin excepción por riesgo | L1 |
| **Intersección transitoria en ámbito nulo** | Ruta sin propiedad resoluble y usuario sin asignación `legal_entity`/`organization`: mientras dure el dual-read recibe la **intersección** de los permisos de sus propiedades (lo que puede hacer en todas), nunca la unión; con asignación de sociedad/organización, la unión de esas | L1 |
| **Aprobación implícita acotada** | Quien tiene la clave `*_approve` del `kind`, dentro de su umbral y sin ser autor de la entidad, ejecuta sin solicitud previa (traza `APPROVAL_REQUESTED` + `APPROVAL_DECIDED`); nunca > T4 | L2 |
| **Rutas de clave dinámica en high/critical con allowlist** | `POST /approvals/:id/approve|reject` y `POST /rbac/supervisor-authorizations` dependen del `kind`/`permissionKey` del cuerpo: el manifiesto las declara high/critical con una **allowlist** estática (los valores de `APPROVAL_KIND_PERMISSION`) y el servicio exige la clave concreta; el contrato sigue viendo una entrada estática | L1 |
| **Break glass con re-autenticación y sin concesión de accesos** | `POST /rbac/break-glass` exige contraseña del abridor, `confirmHighRisk` y reto MFA si procede (`BREAK_GLASS_REAUTH_REQUIRED`); la sesión de emergencia no puede asignar, invitar, editar roles ni umbrales (`RBAC_BREAK_GLASS_FORBIDDEN`) | L1 |
| **Columnas de autor** | Las entidades con SoD dinámica llevan columna de autor (`issuedByUserId`, `capturedByUserId`, `createdByUserId`, `requestedByUserId`, `runByUserId`…) sobre la que el servicio compara solicitante ≠ decisor ≠ ejecutor; el `CHECK` de `approval_requests` es la mitad en BD | L0, L2 |
| **`break_glass` como 24.ª `RoleKey`** | Plantilla real en `types.ts`/`permissions.ts` (249 claves org, `ROLE_TEMPLATE_LEVEL` general_management), fuera de `ORGANIZATION_TEMPLATE_ROLE_KEYS` (22) y creada solo por `ensureBreakGlassRole`; §4.2 pasa de 23 a **24** plantillas | L0 |
| **`activos` → `/finanzas/proveedores/inmovilizado`** | Hasta que exista Finanzas › Activo inmobiliario (documento hermano, L7), `roleHome("activos")` aterriza en la pestaña Inmovilizado de Proveedores y gastos (existe en el árbol), no en `/finanzas/activo-inmobiliario` (§4.9) | L4 |
| **Usuarios de demo (30) en `seed-rbac-demo.ts`** | `packages/database/prisma/seed-rbac-demo.ts` (`db:seed:rbac-demo`) siembra los **30** usuarios ficticios de Faranda (los 19 de §8.1 + hermanos por hotel, las 2 cuentas de emergencia y los grupos de propiedades de D5) escribiendo en `user_role_assignments`; las 7 specs `apps/api/src/scripts/specs/faranda-*.json` quedan **intactas** | L5 |
