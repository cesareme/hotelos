// RRHH · plantilla, convenio, estándares, plantilla máxima, previsión, KPIs,
// alertas y ausencias (Tanda RRHH · RRHH-6) · entradas de permisos de las
// rutas /hr/* (hr.routes.ts).
//
// Entradas fusionadas en routePermissionManifest (security/route-permissions.ts,
// `...hrRoutePermissions`, junto a las de nómina); los contratos
// (tests/api-route-permissions-contract.test.mjs, tests/rbac-nav-contract.test.mjs,
// apps/api/src/security/__tests__/route-read-keys.test.mts) leen este fichero:
// una ruta nueva en hr.routes.ts va con su entrada aquí, una por línea.
//
// Claves (diseño docs/design/RRHH-PLANTILLA-NOMINA.md §9; catálogo v5 de
// packages/shared/src/permissions.ts, RRHH-1): el manifiesto exige TODAS las
// claves de la entrada, así que cada ruta pide UNA clave, la más amplia de las
// que su servicio acepta (`*_READ_KEYS`):
//   · expediente: lectura hr.employee.read (medium; dirección, dirección general,
//     dirección de operaciones, propiedad y payroll_hr), escritura hr.employee.manage
//     (high; baja critical: revoca accesos y cierra contratos);
//   · convenios: lectura hr.employee.read (el selector de convenio de la ficha lo
//     necesita quien lee la plantilla), escritura hr.config.manage (high);
//   · estándares, planes y previsión: lectura workforce.read (medium: es la clave
//     de los cuadros de personal y la tienen dirección, finanzas y payroll_hr);
//     estándares y borrador del plan hr.standards.manage (high); aprobación del
//     plan hr.staffing.approve (high; SoD dinámica preparador ≠ aprobador en el
//     servicio); generar la previsión workforce.schedule.manage (high: escribe
//     labor_forecasts; nunca con el contexto demo sin token);
//   · KPIs (llevan coste del mes) workforce.labor_cost.view (medium); alertas
//     workforce.read (medium);
//   · ausencias: lista workforce.read (medium; los tipos de salud se enmascaran
//     sin hr.employee.read y, sin schedule.manage / timeclock.manage /
//     hr.employee.read, solo las fichas del actor: RF-03), decisión
//     workforce.schedule.manage (high: como PATCH /workforce/absences/:id),
//     solicitud propia POST /workforce/me/absences con workforce.timeclock.use.
// high / critical rechazan el contexto demo sin token (H1).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const hrRoutePermissions: ApiRoutePermission[] = [
  // Expediente (employees.service.ts): listado y detalle sin PII salvo `?pii=1` auditado.
  { method: "GET", path: "/hr/employees", permissions: ["hr.employee.read"], riskLevel: "medium" },
  { method: "GET", path: "/hr/employees/:id", permissions: ["hr.employee.read"], riskLevel: "medium" },
  { method: "POST", path: "/hr/employees", permissions: ["hr.employee.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/hr/employees/:id", permissions: ["hr.employee.manage"], riskLevel: "high" },
  { method: "POST", path: "/hr/employees/:id/terminate", permissions: ["hr.employee.manage"], riskLevel: "critical" },
  // Convenios y reglas (agreements.service.ts).
  { method: "GET", path: "/hr/agreements", permissions: ["hr.employee.read"], riskLevel: "medium" },
  { method: "POST", path: "/hr/agreements", permissions: ["hr.config.manage"], riskLevel: "high" },
  { method: "GET", path: "/hr/agreements/:id/rules", permissions: ["hr.employee.read"], riskLevel: "medium" },
  { method: "PUT", path: "/hr/agreements/:id/rules", permissions: ["hr.config.manage"], riskLevel: "high" },
  // Estándares de dotación (standards.service.ts).
  { method: "GET", path: "/hr/properties/:propertyId/standards", permissions: ["workforce.read"], riskLevel: "medium" },
  { method: "PUT", path: "/hr/properties/:propertyId/standards", permissions: ["hr.standards.manage"], riskLevel: "high" },
  { method: "POST", path: "/hr/properties/:propertyId/standards/reset-defaults", permissions: ["hr.standards.manage"], riskLevel: "high" },
  // Plantilla máxima (staffing.service.ts): borrador por RRHH, aprobación por dirección general.
  { method: "GET", path: "/hr/properties/:propertyId/staffing-plans", permissions: ["workforce.read"], riskLevel: "medium" },
  { method: "POST", path: "/hr/properties/:propertyId/staffing-plans", permissions: ["hr.standards.manage"], riskLevel: "high" },
  { method: "POST", path: "/hr/properties/:propertyId/staffing-plans/:id/approve", permissions: ["hr.staffing.approve"], riskLevel: "high" },
  // Previsión de plantilla (labor-forecast.service.ts): único escritor de LaborForecast.
  // Escritura (upsert de labor_forecasts): high, como toda escritura de la casa — sin fallback demo sin token (corrector SEC-09).
  { method: "POST", path: "/hr/properties/:propertyId/labor-forecast/generate", permissions: ["workforce.schedule.manage"], riskLevel: "high" },
  { method: "GET", path: "/hr/properties/:propertyId/labor-forecast", permissions: ["workforce.read"], riskLevel: "medium" },
  // KPIs y alertas (kpis.service.ts).
  { method: "GET", path: "/hr/kpis", permissions: ["workforce.labor_cost.view"], riskLevel: "medium" },
  { method: "GET", path: "/hr/alerts", permissions: ["workforce.read"], riskLevel: "medium" },
  // Ausencias (advanced-record-store.ts `workforce_labor:absence_requests` / `absence_request`).
  { method: "GET", path: "/hr/absences", permissions: ["workforce.read"], riskLevel: "medium" },
  { method: "POST", path: "/hr/absences/:id/decide", permissions: ["workforce.schedule.manage"], riskLevel: "high" },
  // Solicitud propia (corrector RRHH · RF-03, D §9): el empleado pide su ausencia con la clave de fichar; la ficha es siempre la suya.
  { method: "POST", path: "/workforce/me/absences", permissions: ["workforce.timeclock.use"], riskLevel: "medium" }
];
