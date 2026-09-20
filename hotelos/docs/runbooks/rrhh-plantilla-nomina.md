# Runbook · RRHH: plantilla, previsión y nómina (Tanda RRHH · 2026-09-20)

Fuente: diseño [`docs/design/RRHH-PLANTILLA-NOMINA.md`](../design/RRHH-PLANTILLA-NOMINA.md) (§4 modelo, §5 motor de
previsión, §6 parametrización y estándares, §7 nómina, §8 reglas laborales, §9 API y privacidad, §10 front; el apéndice
final «Estado tras la implementación (2026-09-20)» recoge los deltas). Código: `apps/api/src/modules/hr/*`
(expediente `employees.service.ts`, convenios `agreements.service.ts`, estándares `standards.service.ts`, plantilla máxima
`staffing.service.ts`, drivers `drivers.service.ts`, motor puro `labor-forecast.engine.ts`, escritor de previsión
`labor-forecast.service.ts`, KPIs y alertas `kpis.service.ts`, reglas `rules.engine.ts`, errores `hr-errors.ts`, rutas
`hr.routes.ts` + `route-permissions.partial.ts`); nómina `apps/api/src/modules/payroll/{incidences.service,payroll.routes,
contracts.service,periods.service}.ts`; turnos, fichajes y ausencias `apps/api/src/modules/advanced/advanced-record-store.ts`;
esquemas `apps/api/src/schemas/hr.schemas.ts`; tipos wire y constantes `packages/shared/src/hr-types.ts`; migración
`packages/database/prisma/migrations/20260920173000_rrhh_plantilla_nomina/`; seed `packages/database/prisma/seed-hr.ts`;
front `apps/admin-web/src/screens/hr/{HrEmployeesScreen,EmployeeDrawer,HrForecastScreen,HrOverviewScreen}.tsx` +
`employee-form.ts` + `hr-forecast-helpers.ts`, `screens/payroll/PayrollScreen.tsx`, `screens/operations/WorkforceDashboard.tsx`,
contenedor `screens/tabs/finanzas/NominasTabs.tsx`, clientes `services/{hrApi,hr-contracts,hrForecastApi,payrollApi,
workforceApi}.ts`. Rutas, cuerpos y códigos: `docs/api-contracts.md` «RRHH · plantilla y previsión (Tanda RRHH · RRHH-6)».
Manual de uso: `docs/manual/30-rrhh.md`. Panel de costes de dirección: `docs/runbooks/finanzas-contabilidad.md` §20.

**Todos los datos de este documento son ficticios**: tenant de prueba `org_hr` / `le_hr` / `prop_hr` («Hotel HR (prueba)»),
usuarios `*@hr.test`, expedientes con NIE sintéticos. Nunca se pega aquí un dato ni el nombre de una persona real; sobre los
datos reales de la sociedad piloto el módulo solo lee (0 fichas, 0 contratos, 0 turnos: únicamente el coste agregado de
nómina es real, y entra por «Coste de personal»).

Estado 2026-09-20: construido en la rama `tanda-rrhh` (base `a069906`, BD `hotelos_rrhh`, API `:3923` · Vite `:5193`) en
seis olas y doce lotes (RRHH-1 esquema y RBAC · RRHH-2 expedientes y convenios · RRHH-3 motor, estándares, plantilla máxima
y KPIs · RRHH-4 turnos, fichajes y ausencias · RRHH-7 seed · RRHH-6 rutas · RRHH-8/9/10 front · RRHH-11 navegación y docs ·
PANEL-A/B panel de costes). Pendiente de fusión a `main` por el orquestador (§11).

## 1 · Modelo y migración

Migración única y aditiva `20260920173000_rrhh_plantilla_nomina` (posterior a `20260920160000_checkin_pago_en_recepcion`;
el nombre `20260918100000_…` del diseño §4 colisiona con `20260918100000_rbac_departamentos`). SQL de `prisma migrate diff`
verbatim bajo la cabecera de la casa + un único añadido a mano: `CHECK absence_requests_requested_ne_approved`
(`requested_by IS NULL OR approved_by IS NULL OR requested_by <> approved_by`; Prisma no declara CHECKs y `db:drift:check`
sigue en «No difference detected.»). Sin `DROP`, sin funciones ni triggers (`scripts/check-fresh-install.sh` sigue
censando los 4 triggers de la Tanda 6b).

| Tabla | Cambio | Claves |
|---|---|---|
| `employees` (**nuevo**, `Employee`) | organización, sociedad, número de empleado, `user_id?`, nombre y apellidos, `tax_id` + `tax_id_lookup_hash`, `social_security_number?`, `email?`, `phone?`, `iban?`, `gender?`, centro principal, departamento USALI, puesto, `status` active · inactive · leave, `hired_at`, `terminated_at?`, `termination_reason?` | unique `(legal_entity_id, employee_number)` · unique `(legal_entity_id, tax_id_lookup_hash)` · índice `(organization_id, status)` |
| `collective_agreements` (**nuevo**) | código, nombre, ámbito, referencia publicada, vigencia, ultraactividad | unique `(organization_id, code)` |
| `agreement_rules` (**nuevo**) | `key` ∈ `HR_AGREEMENT_RULE_KEYS` (21: `annual_hours`, `max_daily_hours`, `rest_between_shifts_h`, `weekly_rest_days`, `break_minutes`, `break_counts_as_work`, `extra_pay_count`, `extra_pay_months`, `overtime_*`, `night_*`, `vacation_days`, `fd_*`, `it_complement_rules`, `part_time_min_hours`), `value_json`, `valid_from`, `valid_to?` | unique `(agreement_id, key, valid_from)` |
| `labor_standards` (**nuevo**) | centro, departamento USALI, `driver` ∈ `LABOR_STANDARD_DRIVERS` (`occupied_rooms`, `departures`, `stayovers`, `arrivals`, `pax`, `covers_breakfast`, `covers_restaurant`, `rooms_inventory`, `fixed`), `unit` (`minutes_per_unit` · `units_per_shift` · `fte_per_100` · `posts_by_band`), valor, tramos, suplementos %, factor de cobertura, `source` (`sector_default` · `measured` · `agreement`), vigencia | unique `(property_id, usali_department, driver, valid_from)` — **sin `unit`** (§12) |
| `staffing_plans` + `staffing_plan_lines` (**nuevos**) | centro × año × temporada (high · shoulder · low), meses, `status` draft · approved, `created_by` / `approved_by`; líneas por departamento con `max_fte`, `max_headcount?`, `budget_monthly_cost?` | unique `(property_id, year, season)` · unique `(plan_id, usali_department)` |
| `staff_profiles` | `+ employee_id?` (→ expediente), `+ usali_department?`, `+ job_title?`; `user_id` sigue NOT NULL | índice `(employee_id, active)` |
| `employment_contracts` | `+ agreement_id?`, `+ weekly_hours Decimal(5,2)?`, `+ part_time_pct Decimal(5,2)?`, `+ fixed_discontinuous` (default false), `+ contribution_group Int?`, `+ end_reason?` | — |
| `absence_requests` | `+ requested_by?`, `+ decided_at?`, `+ reason?` + CHECK de separación de funciones | — |
| `labor_forecasts` | `+ usali_department` (default `"all"`), `+ source?`, `+ drivers_json` (default `{}`), `+ required_fte?`, `+ estimated_cost?`, `+ generated_at?` | unique `(property_id, forecast_date, usali_department)` |
| `payroll_periods` | `+ mode` (default `"external"`), `+ closed_at?` | — |
| `properties` | `+ agreement_id?` (convenio del centro) | — |

PII: `PII_FIELDS.Employee = [taxId, socialSecurityNumber, email, phone, iban]` y `LOOKUP_HASH_FIELDS.Employee = { taxId:
"taxIdLookupHash" }` (`packages/database/src/crypto-fields.ts`, patrón `Guest`): la extensión del cliente cifra al escribir y
el hash de búsqueda se calcula solo; el listado (`EmployeeSummaryDto`) hace `select` de columnas en claro y **nunca** descifra.

Comandos (desde `hotelos/`): `corepack pnpm --filter @hotelos/database db:migrate:deploy` · `db:migrate:status` (25
aplicadas) · `db:drift:check` («No difference detected.») · `corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run`
(+5 claves `hr.*`; el `--upgrade-templates` real sobre la BD viva lo lanza el orquestador tras el commit).

Relación entre entidades: el **expediente** (`Employee`) es la persona ante la sociedad; la **ficha de personal**
(`StaffProfile`, `payroll/staff-profiles.service`, FIX-1 F10) es esa persona en un centro y sigue siendo la entidad de turnos,
fichajes, ausencias y contratos (apunta al expediente por `employeeId`). No hay `employeeId` nuevo en `Shift`, `TimeClockEntry`
ni `AbsenceRequest`. Un expediente puede existir sin usuario (`Employee.userId?`); una ficha exige usuario.

## 2 · Escritores y lectores

| Entidad | Escritor | Lectores |
|---|---|---|
| `Employee` | `employees.service.ts` (`createEmployee` · `patchEmployee` · `terminateEmployee`: cierra contratos, desactiva fichas y revoca asignaciones RBAC con `revokeAssignmentsOnLeave`; contractId `employee:<id>` cuando no hay contrato) y `seed-hr.ts` | listado / detalle (`?pii=1` auditado `HR_PII_READ` por campo), `incidences.service` (altas y bajas del mes), `kpis.service` (vencimientos), `HrEmployeesScreen` / `EmployeeDrawer`, `HrOverviewScreen` (nombres solo con `hr.employee.read`) |
| `CollectiveAgreement` / `AgreementRule` | `agreements.service.ts` (`createAgreement`, `putAgreementRules` versiona por `(key, validFrom)` y nunca borra, `assignAgreementToProperty`, `seedAgreementCatalog` desde `HR_AGREEMENT_DEFAULTS`: ES-15-HOST, ES-33-HOST, ES-39-HOST, ES-28-HOSP) | `contracts.service` (`payCount` = 12 + `extra_pay_count`; 14 sin convenio), `labor-forecast.service` (`annual_hours`), `rules.engine` vía `advanced-record-store` (topes y descansos), selector de convenio del cajón (`hr-contracts.ts`: 40 h como jornada completa) |
| `LaborStandard` | `standards.service.ts` (`putLaborStandards` = foto completa versionada por `validFrom`; `resetLaborStandardDefaults` según `Property.starRating`); el seed lo llama (corrector SEC-08: ya no escribe por su cuenta) | `labor-forecast.service`, `HrForecastScreen` («Estándares de dotación») |
| `StaffingPlan` | `staffing.service.ts` (`upsertStaffingPlan` reescribe borradores; `approveStaffingPlan` con SoD) y `seed-hr.ts` | `labor-forecast.service` (`approvedFte`), `kpis.service` (máximo aprobado), `checkStaffingHeadroom` (aviso `HR_STAFFING_EXCEEDED` en `warnings` de contratos: nunca bloquea) |
| `LaborForecast` | `labor-forecast.service.ts` (**único escritor**: `upsert` por la clave única, borra las filas del día que ya no proceden, sigue rellenando `requiredLaborHours` y `requiredStaffCount`; `deps.now` inyectable); el seed lo llama (corrector SEC-08) | `dashboards/workforce.service.ts` (Σ `requiredLaborHours` por día), `kpis.service` (FTE necesario del mes), `HrForecastScreen`, `HrOverviewScreen` |
| `Shift` / `TimeClockEntry` / `AbsenceRequest` | `advanced-record-store.ts` (`resolveStaff`: `staffProfileId` o alias resoluble → 400 `HR_EMPLOYEE_REQUIRED`; `createTimeClock`: con solo `timeclock.use` la ficha propia y la hora del servidor, otra ficha → 403 `HR_TIMECLOCK_SELF_ONLY` (RF-01); `createShift` devuelve `warnings` del `rules.engine`; `createAbsence` persiste `requestedBy` y `reason`; `transitionAbsence` exige `requestedBy ≠ decisor` en approved / rejected → 409 `APPROVAL_SELF_DECISION`, fija `decidedAt`) y `POST /workforce/me/absences` (ausencia propia, RF-03) | `GET /hr/absences` y `GET …/time-clock` (`workforce_labor:absence_requests` / `time_clock_entries`; con solo `workforce.read` solo las fichas del actor —`workforceSelfScope`, RF-03—; tipos de salud enmascarados sin `hr.employee.read`), `dashboards/workforce.service` (misma máscara, SEC-07), `incidences.service` (ausencias aprobadas), `labor-forecast.service` (`plannedHours`, `availableFte`), `WorkforceDashboard` |
| `PayrollPeriod` | `periods.service.ts` (`createPeriod` · `calculatePeriod` con `PAYROLL_RATES_2026` —tipos temporales y jornada parcial (RF-06)—, 409 `PAYROLL_PERIOD_APPROVED` sobre un periodo aprobado / exportado (RF-02) y 409 `PAYROLL_MODE_CONFLICT` sobre una celda con lote `posted` (RF-10) · `approvePeriod` con SoD calculadora ≠ aprobador · `export.service.exportPeriod` exige `approved` (409 `PAYROLL_NOT_APPROVED`) · `payPeriod` exige `approved`); `mapPeriod` expone `mode` y `closedAt` (SEC-12) | `treasury.routes.ts`, `payroll.routes.ts`, `PayrollScreen` (callout por `mode`), `kpis.service` (coste del mes calculado, RF-09) |
| Incidencias del mes | ninguno (lectura agregada de expedientes, contratos y ausencias; auditoría `PAYROLL_INCIDENCES_EXPORTED` solo con recuentos) | `GET /payroll/incidences`, diálogo «Incidencias del mes» |

Auditoría (`HR_AUDIT_ACTIONS`): `HR_EMPLOYEE_CREATED` · `HR_EMPLOYEE_UPDATED` (nombres de los campos, nunca valores) ·
`HR_EMPLOYEE_TERMINATED` · `HR_PII_READ` (una por minuto, usuario, expediente y ámbito: `afterJson.windowMs`, RF-12) ·
`HR_AGREEMENT_CHANGED` · `HR_STANDARDS_CHANGED` · `HR_STAFFING_PLAN_CREATED` · `HR_STAFFING_PLAN_UPDATED` ·
`HR_STAFFING_PLAN_APPROVED` · `HR_FORECAST_GENERATED` · `HR_ABSENCE_DECIDED` · `PAYROLL_INCIDENCES_EXPORTED` (los servicios
tipan `action` con `HrAuditAction`, SEC-11). Logs y Sentry: `redactHrPii` / `redactHrPiiInUrl` (`hr.routes.ts`) quitan NIF, NAF, correo, teléfono,
IBAN y `taxIdLookupHash` de `req.url`, `query_string`, `extra` y `contexts`.

## 3 · Rutas y claves

Manifiesto en `modules/hr/route-permissions.partial.ts` (spread `...hrRoutePermissions` en `security/route-permissions.ts`)
y una entrada en `modules/payroll/route-permissions.partial.ts`. Cada ruta pide UNA clave (la más amplia que acepta su
servicio); `high` / `critical` rechazan el contexto demo sin token (401). Tenencia: `:propertyId` / `?propertyId` por el
hook global (404 opaco «Propiedad no encontrada.» fuera de la organización o del ámbito) y `requireHrProperty` en el servicio;
ids de entidad por `assertEntityAccess` con los resolvers `employee`, `collectiveAgreement`, `staffingPlan` y `absenceRequest`
de `lib/tenancy.ts`, con el MISMO 404 que el servicio (sin oráculo entre organizaciones).

| Método · ruta | Clave efectiva | Riesgo | Servicio · notas |
|---|---|---|---|
| `GET /hr/employees?propertyId&legalEntityId&status&fixedDiscontinuous&search` | `hr.employee.read` | medium | `listEmployees` → `EmployeeSummaryDto[]` sin PII; búsqueda por nombre o número, nunca por NIF |
| `GET /hr/employees/:id[?pii=1]` | `hr.employee.read` | medium | `getEmployee`; `pii` solo si se pide: NIF, NAF e IBAN exigen `hr.employee.manage`; correo y teléfono, `hr.employee.read`; 503 `HR_PII_KEY_MISSING` sin clave de cifrado |
| `POST /hr/employees` | `hr.employee.manage` | high | `createEmployee`: NIF/NIE con letra válida (400 `HR_TAXID_INVALID`), duplicado por hash (409 `HR_EMPLOYEE_TAXID_DUPLICATE`), número «0001»… por sociedad si falta |
| `PATCH /hr/employees/:id` | `hr.employee.manage` | high | parcial (≥ 1 campo); expediente de baja → 409 `HR_EMPLOYEE_TERMINATED` |
| `POST /hr/employees/:id/terminate` | `hr.employee.manage` | **critical** | `{ terminatedAt?, reason? ∈ HR_END_REASONS }` → cierra contratos, desactiva fichas, revoca accesos |
| `GET /hr/agreements` · `GET /hr/agreements/:id/rules?asOf` | `hr.employee.read` | medium | catálogo y reglas vigentes (el selector de convenio del cajón las necesita) |
| `POST /hr/agreements` · `PUT /hr/agreements/:id/rules` | `hr.config.manage` | high | código único por organización; reglas versionadas, nunca borradas |
| `GET /hr/properties/:propertyId/standards?at` | `workforce.read` | medium | `listLaborStandards` → `{ standards, starBand }` |
| `PUT …/standards` · `POST …/standards/reset-defaults` | `hr.standards.manage` | high | foto completa versionada (`validFrom`); defaults por estrellas (9 estándares en 4★) |
| `GET …/staffing-plans?year` | `workforce.read` | medium | planes por centro |
| `POST …/staffing-plans` | `hr.standards.manage` | high | borrador; aprobado → 409 `HR_STAFFING_PLAN_ALREADY_APPROVED` |
| `POST …/staffing-plans/:id/approve` | `hr.staffing.approve` | high | SoD preparador ≠ aprobador → 409 `APPROVAL_SELF_DECISION` |
| `POST …/labor-forecast/generate` | `workforce.schedule.manage` | **high** | `{ from, to }` ≤ 92 días; único escritor de `labor_forecasts`; auditoría `HR_FORECAST_GENERATED` (escritura: nunca con el contexto demo sin token, SEC-09) |
| `GET …/labor-forecast?from&to` | `workforce.read` | medium | `LaborForecastDayDto[]`: necesario vs planificado vs disponible vs máximo aprobado, `source` y `degraded` por día |
| `GET /hr/kpis?propertyId&period` | `workforce.labor_cost.view` | medium | `HrKpisDto` con `degraded[]`; `activeHeadcount` = personas (RF-07); el coste del mes solo con `payroll.read` / `payroll.manage`: lote contabilizado (`monthLaborCostSource: "import"`) o, si no, nómina calculada del mes (`"payroll"`, bruto + SS empresa, sin % s/ ventas; RF-09) |
| `GET /hr/alerts?propertyId` | `workforce.read` | medium | `HrAlertDto[]`: overstaffed · understaffed · over_approved · forecast_degraded · contract_expiring · rule_violation · headcount_threshold |
| `GET /hr/absences?propertyId&status&limit&cursor` | `workforce.read` | medium | página `{ items, total, nextCursor }`; con solo `workforce.read` (sin `schedule.manage` / `timeclock.manage` / `hr.employee.read`) solo las fichas del actor (RF-03); IT / nacimiento y cuidado → `absenceType: null, restricted: true` sin `hr.employee.read` |
| `POST /hr/absences/:id/decide` | `workforce.schedule.manage` | high | `{ status: approved · rejected · cancelled, note? }`; SoD y 409 `INVALID_TRANSITION` (motor genérico; el front lo traduce como `HR_INVALID_TRANSITION`) si ya decidida |
| `POST /workforce/me/absences` | `workforce.timeclock.use` | medium | ausencia PROPIA (`{ absenceType, startDate, endDate, reason? }` sobre la ficha activa del actor → 201; `staffProfileId` / `staffName` → 400; sin ficha → 400 `HR_EMPLOYEE_REQUIRED`); RF-03 |
| `GET /workforce/properties/:propertyId/staff-profiles` | `workforce.read` | medium | fichas del centro para fichar / planificar sin `hourlyCost` ni `userEmail` (`WorkforceStaffProfileDto`); SEC-02 |
| `GET /payroll/incidences?period=YYYY-MM[&propertyId][&format=json·csv]` | `workforce.payroll_export` | medium | `PayrollIncidencesDto` (altas, bajas, cambios de contrato, ausencias aprobadas; sin `overtime`); CSV `;` con BOM, cabecera `centro;numero_empleado;empleado;tipo;codigo;desde;hasta;dias;horas;detalle`; sin `propertyId` = sociedad (`accounting.entity.read` o 404 `ENTITY_SCOPE_REQUIRED`) |
| `POST /payroll/periods/:id/approve` (existente) | `payroll.approve` | high | `approvePeriod`; `POST …/:id/export` y `payPeriod` exigen `approved` (409 `PAYROLL_NOT_APPROVED`); `POST …/:id/calculate` sobre un periodo aprobado / exportado → 409 `PAYROLL_PERIOD_APPROVED` (RF-02) |
| `GET /payroll/periods` · `POST /payroll/periods` · `POST …/:id/calculate` · `GET …/:id` · `…/approve` · `…/pay` | `payroll.read` / `payroll.manage` / … | — | todo `PayrollPeriodRecord` lleva `mode` y `closedAt` desde `mapPeriod` (SEC-12); `calculate` sobre una celda con lote de coste `posted` → 409 `PAYROLL_MODE_CONFLICT` (RF-10) y deja el periodo en `mode: calculated` |
| `POST /payroll/contracts` | `payroll.manage` | high | pasa `agreementId`, `weeklyHours`, `partTimePct`, `fixedDiscontinuous`, `contributionGroup` (RRHH-2 / RRHH-6); responde `warnings` (`HR_STAFFING_EXCEEDED` del position control, segundo contrato activo; RF-05 / RF-07) |
| `GET /payroll/staff-profiles` · `POST /payroll/staff-profiles` (FIX-1 F10) | `payroll.read` / `payroll.manage` | medium / high | selector de fichas de Plantilla › Contrato; `userId` obligatorio y `employeeId?` (expediente de la organización y de la sociedad del centro; 404 / 400 `STAFF_PROFILE_EMPLOYEE_MISMATCH`; hereda departamento USALI y puesto; SEC-01) |
| `POST /workforce/properties/:id/shifts` · `…/time-clock/clock-in\|out` · `PATCH …/absences/:id` (existentes) | `workforce.schedule.manage` · `workforce.timeclock.use` · `workforce.schedule.manage` | — | cuerpo `{ staffProfileId }` (o alias resoluble); fichaje solo propio y con hora del servidor sin `timeclock.manage` (403 `HR_TIMECLOCK_SELF_ONLY`; RF-01); `warnings` del motor de reglas; SoD en la decisión |

Códigos (`HR_ERROR_CODES` · mensajes `HR_ERROR_MESSAGES_ES`): 400 `VALIDATION_ERROR`, `HR_EMPLOYEE_REQUIRED`, `HR_TAXID_INVALID`,
`HR_AGREEMENT_RULE_INVALID`, `HR_STANDARD_INVALID`; 404 opacos `HR_EMPLOYEE_NOT_FOUND`, `HR_AGREEMENT_NOT_FOUND`,
`HR_STAFFING_PLAN_NOT_FOUND`, `PROPERTY_NOT_FOUND`, `ENTITY_SCOPE_REQUIRED`; 409 `HR_EMPLOYEE_TAXID_DUPLICATE`,
`HR_EMPLOYEE_NUMBER_DUPLICATE`, `HR_EMPLOYEE_TERMINATED`, `HR_AGREEMENT_CODE_DUPLICATE`, `HR_STAFFING_PLAN_ALREADY_APPROVED`,
`APPROVAL_SELF_DECISION`, `HR_INVALID_TRANSITION`; 503 `HR_PII_KEY_MISSING`; `HR_STAFFING_EXCEEDED` y `HR_RULE_VIOLATION` solo
en `warnings`. Sin token: `medium` responde 403 con `HOTELOS_ALLOW_DEMO_AUTH=true` (el contexto demo no tiene `hr.*`) y 401
en `RBAC_STRICT` / producción; `high` y `critical` siempre 401.

## 4 · Motor de previsión y estándares

`labor-forecast.engine.ts` es puro (`computeLaborRequirement(drivers, standards, rules)`): por día × departamento USALI,
según la unidad del estándar (diseño §5):

- `minutes_per_unit` → horas = unidades × minutos × (1 + suplementos %) / 60. Pisos: salidas × t_salida + estancias ×
  t_cliente + llegadas × t_repaso (estancias = ocupadas − salidas); F&B: cubiertos × minutos de sala.
- `units_per_shift` → driver `fixed`: puestos × horas por turno (bar, administración); otro driver: unidades / cupo por turno
  × horas por turno (cocina: 1 por 45 cubiertos).
- `fte_per_100` → valor × inventario / 100 × horas por turno (mantenimiento).
- `posts_by_band` → tramo por habitaciones ocupadas → puestos [mañana, tarde, noche] × 8 h; la noche siempre ≥ 1 (recepción).
- FTE del día = horas / 8 × `coverageFactor` (1,4: siete días, descansos, absentismo); puesto 24/7 = horas × 365 / jornada
  anual del convenio (5 puestos × 8 h × 365 / 1.792 = 8,1 FTE). FTE del mes = Σ horas / (jornada anual / 12).
- Un driver ausente (`null`) **no** se sustituye por 0: la línea queda `degraded` con `requiredHours = null` (nunca un FTE
  inventado). Ejemplo pinado (`labor-forecast-engine.test.mts`, diseño §5): 55,7 ocupadas · 27,6 llegadas · 27,3 salidas con
  los estándares 4★ → pisos 29,5 h/día → 5,2 FTE (4,7 sin repaso); recepción 2-2-1 → 40 h/día → 8,1 FTE.

Drivers (`drivers.service.ts`, un driver por centro y día con `source` y motivos): pasado por `getRealizedByDay`
(`revenue/actuals.ts`: cierre auditado primero, reservas como fallback → `actual`); futuro por OTB (`expand` de
`pace.service.ts`) fusionado con la previsión por día (`revenue_forecasts` top-level `pms_import:*` → `pms_forecast`, o
`deterministic` SOLO con OTB corroborante); sin OTB ni previsión → `no_otb_no_forecast` y día degradado. Llegadas / salidas
futuras = habitaciones / LOS medio de los 28 días reales (o de las reservas OTB; sin ninguno, `los_unknown`); pax = habitaciones
× pax por habitación real; cubiertos por régimen (`boardType` × pax: desayuno RO 0 · BB/HB/FB/AI 1; restaurante HB 1 ·
FB/AI 2; sin régimen conocido, `covers_unknown`). Los snapshots `dataSource = demo` y las previsiones `seed-hr-demo` **se
excluyen** (§12: el tenant de demo genera degradado).

Estándares por defecto (`HR_STANDARD_DEFAULTS`, `source: sector_default`, por `Property.starRating` 2 / 3 / 4; 4★): pisos 20
min salida · 32 min cliente · 5 min repaso · 12 % suplementos; recepción por tramos de habitaciones ocupadas 60 → 1-1-1, 150 →
2-2-1, 250 → 2-2-2, más → 3-3-3; F&B 25 min por cubierto de desayuno (sala + cocina fundidos, §12) · 45 por cubierto de
restaurante · 20 (bar); mantenimiento 1,4 FTE por 100 habitaciones; administración 2 puestos fijos. `HR_PLANNING_OCCUPANCY_PCT`
(alta 85 % / baja 30-35 %) alimenta la plantilla máxima resultante del diseño §6.3. Jornada anual: `annual_hours` del
convenio del centro (`Property.agreementId`); sin convenio, 1.792 h con entrada en `degraded[]`.

`labor-forecast.service.ts` (`generateLaborForecast`): drivers × estándares vigentes cada día × jornada → una fila por día ×
departamento (`requiredLaborHours`, `requiredFte`, `estimatedCost` = FTE × coste mensual medio por empleado del último lote
`posted` de `payroll_cost_lines`, si existe; `source`, `driversJson`, `reasonJson`, `generatedAt`); ventana ≤
`LABOR_FORECAST_MAX_DAYS` (92); las filas del día que ya no proceden se borran (la previsión es una foto).
`listLaborForecast` añade las columnas de comparación: `plannedHours` (Σ turnos por departamento vía
`StaffProfile.usaliDepartment`; `null` sin cuadrante), `availableFte` (contratos activos × `partTimePct` − ausencias aprobadas
del día) y `approvedFte` (plan aprobado de la temporada; `null` sin plan). Alertas calculadas (no persistidas) en
`kpis.service.ts` sobre los 14 días siguientes: `understaffed` (planificado < 85 % de lo necesario), `overstaffed`,
`over_approved`, `forecast_degraded`, más `contract_expiring` (≤ 30 días) y `headcount_threshold` (≥ 50 contratos activos:
RD 901/2020). Cifras no disponibles → `null` + `degraded[]` (nunca un 0 verde); el front las pinta con `DegradedValue` /
`DegradedBanner` y traduce los motivos con `DEGRADED_REASON_LABELS_ES` (`hr-forecast-helpers.ts`).

## 5 · Plantilla máxima aprobada

Un `StaffingPlan` por (centro, año, temporada) con una línea de `maxFte` por departamento. Flujo: RRHH prepara el borrador
(`hr.standards.manage`; un borrador se reescribe, `createdBy` = quien preparó la versión vigente) → dirección general aprueba
(`hr.staffing.approve`; SoD dinámica: quien preparó el plan no lo aprueba → 409 `APPROVAL_SELF_DECISION`, sin excepción de
plataforma; ya aprobado → 409). Usos: columna «Máximo aprobado» y KPI «FTE disponible · de n FTE máximo», alerta
`over_approved`, y `checkStaffingHeadroom(propertyId, dept, date?, extraFte?)` al dar de alta un contrato (position control
del diseño §6.3: contratos activos ponderados por `partTimePct` + el alta frente a `maxFte` → aviso `HR_STAFFING_EXCEEDED` en
`warnings`; **nunca bloquea**: `hr.staffing.enforce` queda fuera de la tanda). Ninguna plantilla reúne `hr.standards.manage`
y `hr.staffing.approve` (`tests/rbac-sod-contract.test.mjs`).

## 6 · Nómina: modo externo, aprobación e incidencias

- `PayrollPeriod.mode` = `external` por defecto (diseño §7.1): los recibos que calcula el ERP son una preparación; el registro
  oficial lo emite la gestoría y el coste real entra por «Coste de personal» (`docs/runbooks/finanzas-contabilidad.md` §18).
  `calculated` = preparación interna a validar con la gestoría. La pantalla lo explica con un `CocoaCallout` por modo
  (`PAYROLL_PERIOD_MODE_LABELS_ES`).
- Flujo de estados: `open` → `calculated` (`payroll.manage`; recalculable) → `approved` (`payroll.approve`, dirección; SoD
  calculadora ≠ aprobadora; nota opcional auditada) → `exported` (`POST …/export` exige la aprobación: 409 `PAYROLL_NOT_APPROVED`;
  la etiqueta «Aprobado» se conserva) → pago (`payables.pay`, exige `approved`: 409 `PAYROLL_NOT_APPROVED`). Un periodo
  aprobado o exportado **no se recalcula** (409 `PAYROLL_PERIOD_APPROVED`, corrector RF-02): la aprobación nunca se borra en
  silencio; la vista previa `GET …/export` sigue abierta a `payroll.read`. ⌘K «Aprobar el periodo». La bandeja de aprobaciones
  NO recibe una solicitud automática de tipo `payroll`.
- Bloqueo de modo (diseño §7.1 (3), corrector RF-10): una celda (centro, mes) con lote de coste `posted` no admite
  `calculatePeriod` (409 `PAYROLL_MODE_CONFLICT { mode: "external", imports[] }`), y contabilizar un lote (`POST
  /payroll/cost-imports` con `post`, `POST …/:id/post`) sobre una celda con nómina calculada aprobada / exportada es 409
  `PAYROLL_MODE_CONFLICT { mode: "calculated", periods[] }`; una `calculated` sin aprobar sigue siendo solo aviso
  (`payrollPeriodsPosted`). El periodo que calcula el ERP queda en `mode: calculated`.
- Cálculo (`periods.service.ts`): `PAYROLL_RATES_2026` (Orden PJC/297/2026) 6,50 % trabajador · 32,15 % empresa (indefinidos y
  fijos discontinuos) y **6,55 / 33,35 para `temporal` y `sustitucion`** (`PAYROLL_TEMPORARY_CONTRACT_TYPES`; prácticas y
  formación en alternancia siguen con los tipos generales y `validateWithAdvisor`; corrector RF-06); base mínima 1.424,40 ·
  máxima 5.101,20 y cuota de contratos ≤ 30 días 33,62 € declaradas pero no aplicadas (§12). `grossSalary` es el bruto **a
  jornada completa** del puesto: bruto y bases × `partTimePct` / 100 (diseño §7.2; el recibo lo anota «(jornada 62.5 %)» y el
  tramo de IRPF por defecto mira el bruto contratado); las descripciones de línea dicen «Seguridad Social trabajador 6.55 %
  (tipos 2026, contrato de duración determinada)». Sin IRPF por algoritmo AEAT (§12). `payCount` por defecto = 12 +
  `extra_pay_count` del convenio del centro (14 sin convenio); las pagas extra no se prorratean en el recibo.
- Incidencias del mes (`incidences.service.ts`): altas (`hiredAt` en el mes; código = modalidad del contrato vigente o
  `sin_contrato`), bajas (`terminatedAt`; código = causa), cambios (contrato que empieza para una persona contratada antes ·
  contrato que termina sin baja → `fin_<causa>`), ausencias aprobadas que solapan el mes (tipo y días dentro del mes); `overtime`
  previsto en `PAYROLL_INCIDENCE_KINDS` pero sin origen (sin `WorkdayRecord`: ninguna fila, nunca un 0). Persona = número de
  empleado + nombre; NUNCA NIF, NAF, correo, teléfono ni IBAN. Fichas sin expediente → `warnings`. Descarga con `downloadText`
  desde «Incidencias del mes» (gate `workforce.payroll_export`: solo `payroll_hr`).

## 7 · Turnos, fichajes y ausencias con ficha

`resolveStaff` (`advanced-record-store.ts`): `staffProfileId` válido del centro, o `staffName` como ALIAS exacto e insensible a
mayúsculas (código de empleado o nombre completo de un usuario de la organización) → id real; sin resolución → 400
`HR_EMPLOYEE_REQUIRED`; nunca se guarda texto como id ni en `metadataJson.staffName`. `createShift` evalúa `rules.engine.ts`
sobre los turnos de la persona con las reglas del convenio del contrato o del centro (defectos del Estatuto de los
Trabajadores: `rest_between_shifts` 12 h, `max_daily_hours` 9 h sobre el día UTC de inicio, `weekly_rest` 1,5 días por semana
ISO, `overtime_annual` 80 h) y devuelve `warnings` (avisan, nunca bloquean; `SchedulePeriod` con bloqueo queda fuera).
`createAbsence` persiste `requestedBy = scope.userId`, `reason` y `absenceType` tasado (`ABSENCE_TYPES`; IT y nacimiento y
cuidado son datos de salud: solo visibles con `hr.employee.read`); `transitionAbsence` a approved / rejected exige `requestedBy
≠ scope.userId` (409 `APPROVAL_SELF_DECISION`, CHECK en BD) y fija `decidedAt`; `cancelled` lo hace el solicitante.
`headcountThreshold` (RD 901/2020 art. 3): personas activas + una por cada 100 días de temporales extinguidos en los 6 meses
anteriores; ≥ 50 → alerta y obligaciones LAB-007 / LAB-008 del Centro de cumplimiento (cuenta personas, no contratos:
RF-07). Fichaje por persona (corrector RF-01): con solo `workforce.timeclock.use` `createTimeClock` usa la ficha activa del
actor (el cuerpo puede ir vacío; sin ficha → 400 `HR_EMPLOYEE_REQUIRED`), rechaza otra ficha (403 `HR_TIMECLOCK_SELF_ONLY`) e
ignora `at` (hora del servidor); `workforce.timeclock.manage` ficha por terceros y fija `at`. El empleado solo ve lo suyo
(RF-03): `GET /hr/absences` y `GET …/time-clock` sin `schedule.manage` / `timeclock.manage` / `hr.employee.read` se ciñen a sus
fichas (`workforceSelfScope`, `PageInput.staffProfileIds`) y `POST /workforce/me/absences` solicita la ausencia propia. Front:
`WorkforceDashboard` crea turnos y fichajes con `CocoaSelect` de fichas (`GET /workforce/properties/:id/staff-profiles`,
clave `workforce.read`: las plantillas operativas fichan sin `payroll.read`, SEC-02; sin `timeclock.manage` el selector del
fichaje solo ofrece la ficha propia), muestra los avisos y los tipos de ausencia de salud enmascarados (SEC-07).

## 8 · RBAC (plantillas v5)

Claves nuevas (`packages/shared/src/permissions.ts`, `ROLE_TEMPLATE_VERSION = 5`): `hr.employee.read` (medium),
`hr.employee.manage`, `hr.config.manage`, `hr.standards.manage`, `hr.staffing.approve` (high). `module-manifest.ts`
(`workforce_labor`) las declara; `rbac:sync -- --dry-run` limpio (+5 claves). Quién tiene qué (efectivo tras revocaciones):

| Plantilla | hr.employee.read | hr.employee.manage | hr.config.manage | hr.standards.manage | hr.staffing.approve | workforce.read | workforce.labor_cost.view | workforce.schedule.manage | workforce.payroll_export | payroll.read | payroll.approve | accounting.entity.read |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `payroll_hr` (RRHH y nóminas) | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| `general_manager` | ✓ | — | — | — | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | ✓ |
| `manager` | ✓ | — | — | — | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| `operations_director` | ✓ | — | — | — | — | ✓ | ✓ | — | — | ✓ | ✓ | ✓ |
| `owner` | ✓ | — | — | — | — | ✓ | ✓ | — | — | ✓ | — | ✓ |
| `accountant` · `controller` · `auditor` | — | — | — | — | — | ✓ | ✓ | — | — | ✓ | — | ✓ |
| `compliance` | — | — | — | — | — | — | — | — | — | — | — | ✓ |
| `housekeeping_manager` | — | — | — | — | — | ✓ | ✓ | ✓ | — | ✓ | — | — |
| `housekeeper` · `fnb` · `maintenance` | — | — | — | — | — | ✓ | — | — | — | — | — | — |

Consecuencias visibles: `payroll_hr` prepara (estándares, borradores, generar previsión, expedientes, incidencias) y no
aprueba nada; `general_manager` aprueba la plantilla máxima y el registro de nómina pero no genera la previsión (sin
`workforce.schedule.manage`); `accountant` / `controller` / `auditor` ven Previsión y Panel pero no los nombres ni la
Plantilla («Sin acceso a la plantilla»); `compliance` ve las pestañas con sus estados de sin acceso (§11: pares por clasificar
en `JUSTIFIED_GAPS`). SoD estática `{payroll.manage, payroll.approve}` (existente) y `{payroll.manage, hr.staffing.approve}`
(cubierta a nivel de plantilla en `rbac-sod-contract`; pendiente en `SOD_STATIC_PAIRS`, §12). `payroll_hr` sigue sin
`users.read` (decisión de T8a) y sin `accounting.entity.read`.

## 9 · Navegación y front (RRHH-11)

Sin categoría `/rrhh` (`scripts/build-nav-tree.mjs` fija las nueve categorías): RRHH vive en **Finanzas › RRHH y nóminas**
(`/finanzas/nominas`, ítem `PayrollScreen`, pestaña base «Nóminas») con las pestañas **Plantilla** (`/finanzas/nominas/plantilla`,
`HrEmployeesScreen` + `EmployeeDrawer`), **Previsión de plantilla** (`/finanzas/nominas/prevision`, `HrForecastScreen`) y **Panel
RRHH** (`/finanzas/nominas/panel`, `HrOverviewScreen`); roles `finanzas | direccion | admin | rrhh | auditoria`; `core`. El token
`rrhh` aterriza en `/finanzas/nominas` (`role-tokens.ts` `roleHome`). `/operaciones/personal` (`WorkforceDashboard`) se conserva
con el selector de ficha; el panel de costes de dirección es la pestaña `/hoy/costes-personal` de Mi día (PANEL-B).

Cableado: filas del CSV compartido `pilots/tanda5-nav-tree.csv` (fuera del repo: etiqueta de `PayrollScreen` → «RRHH y
nóminas» con `tab` «Nóminas»; tres filas `merge-into PayrollScreen` con orden 1-3) + `pilots/tanda5-nav-tree.md` §1 (fila 8 de
Finanzas) y §3 (rrhh 2 · 3 · 2) + `pilots/screens-inventory.csv` (una fila por pantalla con `api_paths_principales` `/hr/*`) →
`node scripts/build-nav-tree.mjs --csv <ruta del CSV>` regenera `apps/admin-web/src/navigation/nav-tree.generated.json`;
contenedor `screens/tabs/finanzas/NominasTabs.tsx` (patrón `TesoreriaTabs`: `NavItemTabs` + `LOADERS` de las cuatro claves);
`App.tsx` mapea `PayrollScreen`, `HrEmployeesScreen`, `HrForecastScreen` y `HrOverviewScreen` a `NominasTabs` (cargado con
`lazy(() => import("./screens/tabs/finanzas/NominasTabs"))`); `services/financeScope.ts` `entity_default` para las tres
pestañas (Previsión y Panel excluyen la oficina central con `excludeOffice`); `components/guide/guideContent.ts` narra el ítem
con sus cuatro pestañas; `.discoverability-whitelist.json` lista `EmployeeDrawer` (cajón sin clave propia). Las pantallas alojadas
leen `useTabHost()` (por `CocoaPage`) y no pintan cabecera propia; el eyebrow «Finanzas · <sociedad>» lo registra el ámbito
(`finance.eyebrow`). Puertas: `node scripts/check-discoverability.mjs` (250 pantallas · 200/200 URL), `node
scripts/check-route-access.mjs` (15 tokens × 200 URL), `node scripts/build-nav-tree.mjs --check --csv <CSV>`,
`tests/nav-tree-contract.test.mjs`, `tests/rbac-nav-contract.test.mjs` (el cruce con el inventario solo corre con
`pilots/screens-inventory.csv` presente), `tests/product-route-maps-contract.test.mjs`,
`apps/admin-web/src/navigation/__tests__/nav-tree.test.mts` (pina ítems · pestañas · URL), tests de la guía.

Verificado el 2026-09-20 en el carril (`:3923` / `:5193`, tenant `org_hr`): `rrhh@hr.test` y `direccion@hr.test` ven Finanzas ›
RRHH y nóminas con las cuatro pestañas (Nóminas: 12 contratos, periodo 2026-09; Plantilla: 23 expedientes, 2 con contrato que
vence en 30 días; Previsión: 14 días «Incompleta» por §12 con cuadrante, disponible y máximo aprobado pintados; Panel RRHH:
12 personas · 11,63 FTE de 27 · 23 alertas · 2 vencimientos); `camarera1@hr.test` (housekeeper) no ve el ítem y en
`/finanzas/nominas` recibe «Sin acceso · Tu perfil no tiene permiso para ver esta pantalla. Pide acceso a dirección.».

## 10 · Demo `org_hr` (seed)

```bash
cd hotelos
corepack pnpm --filter @hotelos/database db:seed:hr                # crea o reafirma el tenant (idempotente por id fijo)
corepack pnpm --filter @hotelos/database db:seed:hr -- --reset     # borra SOLO la capa RRHH de org_hr / prop_hr y la resiembra
corepack pnpm --filter @hotelos/database db:seed:hr -- --dry-run   # imprime el plan y sale 0 sin escribir
```

Crea `org_hr` / `le_hr` («HR Pruebas SL») / `prop_hr` («Hotel HR (prueba)», 4★, 60 habitaciones, centros de coste USALI,
módulos `pms_core` + `workforce_labor` + `housekeeping` + `maintenance`), doce usuarios `*@hr.test` con roles de plantilla
(`direccion` general_manager · `rrhh` payroll_hr · `jefe.pisos` housekeeping_manager · `camarera1-3` housekeeper ·
`recepcion1-3` receptionist · `sala1` y `cocina1` fnb · `mantenimiento1` maintenance; contraseña `hr-demo` o
`SEED_HR_PASSWORD`; con `NODE_ENV=production` aborta salvo `SEED_HR_ALLOW_PRODUCTION=1`), 24 expedientes ficticios (NIE
sintéticos con letra válida, cifrados por la extensión; 12 con usuario, ficha y contrato: 8 indefinidos, 2 fijos discontinuos y
2 temporales que vencen en 30 días), convenio ES-15-HOST con sus 21 reglas asignado al centro y a los contratos, estándares
4★ (por `resetLaborStandardDefaults`), dos planes de plantilla aprobados (alta abril-octubre, baja noviembre-marzo), 90 días
de `revenue_daily_snapshots` `demo` + 30 `revenue_forecasts` `pms_import:seed-hr-demo` (desde hoy; el prefijo `pms_import:`
es el que `drivers.service` acepta como driver) + 58 reservas demo `HRDEMO-*` con régimen BB / HB (mezcla de cubiertos, sin
huésped), 6 semanas de turnos y fichajes, 3 ausencias (pending, approved por otro usuario, rejected), 28 días de previsión
escritos por `generateLaborForecast` (0 días degradados: corrector SEC-08) y un periodo de nómina del mes en curso `open` en
modo externo; vacía la cola de auditoría (`HR_STANDARDS_CHANGED`, `HR_FORECAST_GENERATED`) antes de cerrar. Guard
`assertDemoTarget` (`org_hr` en `DEMO_ORG_IDS`, `prop_hr` en `DEMO_PROPERTY_IDS`); nunca toca otro tenant. Contrato:
`tests/seed-hr-contract.test.mjs`.

Instancia propia para probar (sin tocar los API compartidos): `cd apps/api && PORT=<p> RUN_SCHEDULERS=false
TENANT_BOOTSTRAP_SKIP=true node --env-file-if-exists=../../.env --import tsx src/server.ts` (con `TENANT_BOOTSTRAP_SKIP=true`
los espejos in-memory no se hidratan y un tenant creado por script responde 403 / 404: hidratar antes con
`hydrateTenantMirrors` de `lib/tenant-hydration.ts` en un preload, o arrancar sin `SKIP`, que ejecuta el `rbac:sync` real);
con Postgres cerca del tope de conexiones, `DATABASE_URL…?connection_limit=4`. Vite: `cd apps/admin-web &&
VITE_API_URL=http://127.0.0.1:<p> corepack pnpm dev --port <v> --strictPort`.

## 11 · Puertas y tests

- Raíz: `tests/hr-schema-contract.test.mjs`, `tests/seed-hr-contract.test.mjs`, `tests/rbac-sod-contract.test.mjs`,
  `tests/demo-seed-contract.test.mjs`, `tests/nav-tree-contract.test.mjs`, `tests/rbac-nav-contract.test.mjs`,
  `tests/product-route-maps-contract.test.mjs`, `tests/manual-contract.test.mjs`, `tests/api-route-permissions-contract.test.mjs`.
- API (`cd apps/api && node --env-file-if-exists=../../.env --import tsx --test <f>`): `modules/hr/__tests__/{agreements,
  drivers,employees,hr-schemas,kpis,labor-forecast-engine,rules-engine,staffing}.test.mts`, `modules/payroll/__tests__/
  {incidences,payroll-calc,staff-profiles}.test.mts`, `modules/dashboards/__tests__/workforce.test.mts`,
  `security/__tests__/route-read-keys.test.mts`, `lib/__tests__/{crypto,rbac-catalog}.test.mts`.
- Integración (Postgres, tenants aislados): `tests/integration/{hr-employees,hr-labor-forecast,hr-absences-sod,hr-routes,
  treasury-banking,l2-motor-generico,l2-rutas-api}.test.mts`.
- Front (`cd apps/admin-web && node --import ../api/node_modules/tsx/dist/loader.mjs --test <f>`): `screens/hr/__tests__/
  {employee-form,hr-employees-contract,hr-forecast-contract,hr-forecast-helpers,hr-overview-contract}.test.mts`,
  `screens/payroll/__tests__/payroll-cost-screen-contract.test.mts`, `screens/operations/__tests__/workforce-staff-select.test.mts`,
  `navigation/__tests__/nav-tree.test.mts`, `components/guide/__tests__/*`, `screens/tabs/__tests__/nav-item-tabs.test.mts`.
- Scripts: `check-discoverability.mjs`, `check-route-access.mjs`, `build-nav-tree.mjs --check --csv <CSV>`,
  `cocoa-22-inventory.mjs` (regenerar `docs/design/cocoa-22-inventory.json` tras integrar las 4 pantallas de `screens/hr`),
  `bash scripts/gates.sh --quick --json <f>` (con `NAV_TREE_CSV` apuntando al CSV compartido).
- Pendientes de fusión conocidos (2026-09-20): `navigation/__tests__/nav-tree.test.mts` pina 104 pestañas / 197 URL (hoy 107
  / 200; PANEL-B añade `/hoy/costes-personal`); `tests/rbac-nav-contract.test.mjs` × inventario deja 28 pares por clasificar en
  `JUSTIFIED_GAPS` (accountant · controller · compliance · auditor sin `hr.employee.read` en Plantilla y Panel RRHH → `pending`;
  compliance sin `workforce.read` / `workforce.labor_cost.view` / `payroll.read` en las tres pestañas → `sister`); el CSV
  compartido lleva 6 filas `RealEstate*Screen` de otra tanda sin componente en esta rama, así que `nav-tree.generated.json` de
  la rama se regeneró desde una copia filtrada (70 ítems · 107 pestañas) y `build-nav-tree --check` contra el CSV compartido
  queda rojo hasta fusionar esa tanda (el CSV completo construye limpio: 71 · 112).

## 12 · Límites, deuda y lo que solo César puede aportar

- **Esquema**: `labor_standards` sin `unit` en la clave única → sala y cocina sobre el mismo driver se funden
  (`mergeSameDriverStandards`, 13,067 min por cubierto de desayuno; 9 estándares por centro en 4★, no 10); `Shift` sin
  `breakMinutes` (`plannedHours` no descuenta pausas). Cerrado por el corrector: `mode` / `closedAt` en `mapPeriod` y
  `PayrollPeriodRecord` (SEC-12), `HR_AUDIT_ACTIONS` completo (SEC-11).
- **Escritores**: cerrado por el corrector (SEC-08): `seed-hr.ts` llama a `resetLaborStandardDefaults` y `generateLaborForecast`
  y escribe previsiones `pms_import:seed-hr-demo` + reservas demo con régimen; `db:seed:hr -- --reset` sigue borrando planes,
  estándares y runtime creados a mano en `org_hr`. Queda: `ensure` sin `--reset` no retira estándares de otra fecha creados a mano.
- **Fichas**: `POST /payroll/staff-profiles` sigue exigiendo `userId` (una ficha sin usuario no existe: expediente sin usuario →
  sin contrato desde Plantilla), pero admite `employeeId` y el alta / PATCH del expediente con `userId` retro-enlaza las fichas
  (SEC-01); el selector de fichas de Personal y turnos lee `GET /workforce/properties/:id/staff-profiles` (`workforce.read`,
  SEC-02). `payroll_hr` tiene `timeclock.manage` sin `timeclock.use` (ficha por terceros, no la suya); `receptionist`,
  `night_auditor`, `sales` y `revenue` tienen `timeclock.use` sin `workforce.read` (fichan por API o por la app del empleado
  futura, no desde Personal y turnos, que no ven).
- **Nómina**: un periodo aprobado no se recalcula (RF-02) y no existe todavía la revocación explícita de la aprobación
  (`payroll.approve`): para corregir un registro aprobado hay que pagarlo y contabilizar la diferencia, o pedir a sistemas
  que retire la aprobación en BD (auditado a mano). Bases mínimas / máximas, solidaridad y la cuota ≤ 30 días declaradas en
  `PAYROLL_RATES_2026` pero no aplicadas; prácticas y formación en alternancia cotizan aquí con los tipos generales.
- **RBAC**: `rbac:sync` real pendiente en la BD viva (roles «behind v5»); SoD `{payroll.manage, hr.staffing.approve}` ya en
  `SOD_STATIC_PAIRS` (SEC-06); `payroll_hr` sin `users.read` ni `accounting.entity.read` (incidencias «toda la sociedad» → elegir
  centro); `general_manager` sin `workforce.schedule.manage`; `hr.staffing.review` no existe (solo preparar y aprobar).
- **Motor**: `max_daily_hours` sobre el día UTC de inicio del turno y `weekly_rest` por semana ISO; los turnos que cruzan
  medianoche se atribuyen al día de inicio (aviso, nunca bloqueo); supervisión de pisos, zonas comunes fijas y cubiertos de
  eventos (diseño §5) no vienen en los defaults (se modelan como estándares `fixed` / `units_per_shift` sin código nuevo);
  `degradedReasons` son cadenas libres del motor traducidas en `DEGRADED_REASON_LABELS_ES`.
- **Fuera de la tanda** (`scratchpad/RRHH/plan-olas.md` «Fuera»): `WorkdayRecord` y trigger de fichajes, llamamientos de fijos
  discontinuos (`CallUp`), comunicaciones TGSS (`EmployeeEvent`), `EmployeeDocument` / PRL por persona, `WorkCalendar`,
  `LeaveBalance`, `SchedulePeriod` (publicación con bloqueo), `ContractSalaryVersion`, `PayrollSlipImport`, IRPF por algoritmo
  AEAT, Siltra / A3 / Sage oficiales, modelo 190, `LaborBudget`, app del empleado, `CostKpiSnapshot` / `CostBudget` / umbrales del
  panel de costes; `hr.staffing.enforce`.
- **Decisiones ya tomadas por César** (brief): sin integración con software de nóminas externo (importación de fichero como
  hoy); datos personales de empleados nunca en repo, tests ni informes (expedientes ficticios en `org_hr`); coste por
  departamento a partir del reparto del lote (agosto) y de la cuenta 640/642 sin departamento para ene-jul («sin desglose»).
- **Solo César puede aportar**: convenio real de cada centro (y si existe convenio de empresa), CCC y código de centro laboral
  de cada hotel y de la sociedad, formato que importa su gestoría (A3 / Sage / CSV) y la cuenta RED, si `payroll_hr` debe tener
  `users.read` y `accounting.entity.read`, si dirección de hotel debe aprobar plantilla máxima además de dirección general, y el
  origen real de la ocupación prevista de los hoteles sin History & Forecast importado (sin él la previsión queda degradada).
