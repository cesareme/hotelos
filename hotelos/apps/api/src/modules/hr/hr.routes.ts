// RRHH · plantilla, convenio, estándares, plantilla máxima, previsión, KPIs,
// alertas y ausencias (Tanda RRHH · RRHH-6) · superficie HTTP `/hr/*`.
//
// Registradas desde server.ts con `registerHrRoutes(app)` justo después de
// registerStaffProfileRoutes(app) (diseño docs/design/RRHH-PLANTILLA-NOMINA.md
// §9; recon RRHH/recon-delta.md §3.6). Permisos en route-permissions.partial.ts
// (fusionado en security/route-permissions.ts; los contratos leen ese fichero):
// la clave EFECTIVA de cada ruta es la del manifiesto; el servicio acepta
// además las suyas (`*_READ_KEYS`), así que la del manifiesto es siempre la
// más amplia de las que el servicio admite — nunca más estrecha.
//
// Cuerpo y consulta pasan por zod `.strict()` en español (schemas/hr.schemas.ts,
// parseOr400 → 400 VALIDATION_ERROR que nombra la clave). Tenencia:
//   · `:propertyId` (y `?propertyId=`) lo concede el hook global
//     (grantPropertyAccess: 404 opaco «Propiedad no encontrada.» fuera de la
//     organización o del ámbito) y el servicio lo repite (requireHrProperty →
//     404 PROPERTY_NOT_FOUND) para los llamadores directos;
//   · las rutas por id de entidad (expediente, convenio, plan, ausencia) pasan
//     por assertEntityAccess (lib/tenancy.ts: resolvers employee /
//     collectiveAgreement / staffingPlan / absenceRequest, 404 opaco, re-apunte
//     de plataforma) y el servicio aplica el ámbito por centro.
// Códigos de dominio (`details.code` ∈ HR_ERROR_CODES): los emiten los servicios
// de modules/hr (400 HR_TAXID_INVALID / HR_STANDARD_INVALID / HR_AGREEMENT_RULE_INVALID,
// 404 opacos HR_EMPLOYEE_NOT_FOUND / HR_AGREEMENT_NOT_FOUND / HR_STAFFING_PLAN_NOT_FOUND
// / PROPERTY_NOT_FOUND, 409 HR_EMPLOYEE_TAXID_DUPLICATE / HR_EMPLOYEE_NUMBER_DUPLICATE /
// HR_EMPLOYEE_TERMINATED / HR_AGREEMENT_CODE_DUPLICATE / HR_STAFFING_PLAN_ALREADY_APPROVED /
// APPROVAL_SELF_DECISION, 503 HR_PII_KEY_MISSING); HR_STAFFING_EXCEEDED va en
// `warnings` de POST /payroll/contracts, nunca bloquea.
//
// Privacidad: los listados nunca llevan NIF, NAF, correo, teléfono ni IBAN; el
// detalle solo los descifra con `?pii=1` y clave (auditoría HR_PII_READ). Las
// ausencias de tipo salud (ABSENCE_HEALTH_TYPES: IT, nacimiento y cuidado) se
// muestran como `absenceType: null, restricted: true` a quien no tiene
// hr.employee.read (art. 9 RGPD). Los helpers `redactHrPii*` de abajo los usa
// server.ts (Sentry beforeSend y serializador de `req`) para que ningún campo
// PII de Employee llegue a los logs ni al gestor de errores.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UserContext } from "../../lib/demo-store.js";
import { ABSENCE_HEALTH_TYPES, HR_PII_FIELDS, type AbsenceType, type HrAgreementRuleValues, type PermissionKey } from "@hotelos/shared";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { pageHeaders } from "../../lib/pagination.js";
import { assertEntityAccess, assertPropertyEntityAccess, type EntityAccessInput, type TenantRequest } from "../../lib/tenancy.js";
import {
  AbsenceDecideSchema,
  AbsenceListQuerySchema,
  AgreementRulesQuerySchema,
  CreateAgreementSchema,
  CreateEmployeeSchema,
  CreateStaffingPlanSchema,
  EmployeeGetQuerySchema,
  EmployeeListQuerySchema,
  HrAlertsQuerySchema,
  HrKpisQuerySchema,
  LaborForecastGenerateSchema,
  LaborForecastQuerySchema,
  PatchEmployeeSchema,
  PutAgreementRulesSchema,
  PutStandardsSchema,
  ResetStandardsSchema,
  StaffingPlansQuerySchema,
  StandardsQuerySchema,
  TerminateEmployeeSchema
} from "../../schemas/hr.schemas.js";
import { createAdvancedRecord, listAdvancedRecords, transitionAdvancedRecord } from "../advanced/advanced-modules.service.js";
import { ownStaffProfileIds } from "../advanced/advanced-record-store.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { createAgreement, listAgreementRules, listAgreements, putAgreementRules } from "./agreements.service.js";
import { createEmployee, getEmployee, listEmployees, patchEmployee, terminateEmployee } from "./employees.service.js";
import { hrNotFound } from "./hr-errors.js";
import { getHrKpis, listHrAlerts } from "./kpis.service.js";
import { generateLaborForecast, listLaborForecast } from "./labor-forecast.service.js";
import { approveStaffingPlan, listStaffingPlans, upsertStaffingPlan } from "./staffing.service.js";
import { listLaborStandards, putLaborStandards, resetLaborStandardDefaults } from "./standards.service.js";

// ---------------------------------------------------------------------------
// Redacción de PII de Employee (puros; server.ts los aplica a logs y Sentry)
// ---------------------------------------------------------------------------

/** Claves que nunca deben verse en logs ni en el gestor de errores: los campos PII de Employee y su hash de búsqueda. */
export const HR_PII_REDACT_KEYS: readonly string[] = [...HR_PII_FIELDS, "taxIdLookupHash"];
const HR_PII_KEY_SET = new Set(HR_PII_REDACT_KEYS.map((key) => key.toLowerCase()));
const HR_PII_QUERY_PATTERN = new RegExp(`([?&](?:${HR_PII_REDACT_KEYS.join("|")})=)[^&#]*`, "gi");
export const HR_PII_REDACTED = "<redacted>";

/** `?taxId=…&iban=…` → `?taxId=<redacted>&iban=<redacted>` (el resto de la URL intacto); no-op sin PII. */
export function redactHrPiiInUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string") return url;
  return url.replace(HR_PII_QUERY_PATTERN, `$1${HR_PII_REDACTED}`);
}

/** Copia del valor con todo campo PII de Employee (a cualquier profundidad, sin distinguir mayúsculas) sustituido por `<redacted>`. */
export function redactHrPii<T>(value: T, depth = 0): T {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactHrPii(item, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = HR_PII_KEY_SET.has(key.toLowerCase()) ? (item === null || item === undefined ? item : HR_PII_REDACTED) : redactHrPii(item, depth + 1);
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Ausencias: datos de salud
// ---------------------------------------------------------------------------

const ABSENCE_HEALTH_READ_KEYS: readonly PermissionKey[] = ["hr.employee.read", "hr.employee.manage"];

/** Sin hr.employee.read, las ausencias de tipo salud pierden el tipo y el motivo (`restricted: true`). */
export function maskHealthAbsence<T extends { payload?: Record<string, unknown> }>(item: T, permissions: readonly PermissionKey[]): T {
  if (ABSENCE_HEALTH_READ_KEYS.some((key) => permissions.includes(key))) return item;
  const payload = item.payload;
  if (!payload || !ABSENCE_HEALTH_TYPES.includes(payload.absenceType as AbsenceType)) return item;
  return { ...item, payload: { ...payload, absenceType: null, reason: null, restricted: true } };
}

// ---------------------------------------------------------------------------
// Ausencias y fichajes: «el empleado solo ve lo suyo» (D §1.7 / §9; corrector RRHH · RF-03)
// ---------------------------------------------------------------------------

/** Claves que ven las ausencias y fichajes de TODO el centro; con solo workforce.read / timeclock.use la lista se ciñe a las fichas del actor. */
export const WORKFORCE_WHOLE_CENTRE_KEYS: readonly PermissionKey[] = ["workforce.schedule.manage", "workforce.timeclock.manage", "hr.employee.read", "hr.employee.manage"];

export function seesWholeWorkforce(permissions: readonly PermissionKey[] | null | undefined): boolean {
  return (permissions ?? []).some((key) => WORKFORCE_WHOLE_CENTRE_KEYS.includes(key));
}

/**
 * Filtro de fichas para las listas de personas: `{}` (todo el centro) con una clave de
 * WORKFORCE_WHOLE_CENTRE_KEYS; si no, las fichas activas del actor en el centro (lista
 * vacía → página vacía: sin ficha no se ve nada, nunca lo de los compañeros).
 */
export async function workforceSelfScope(context: Pick<UserContext, "userId" | "permissions"> | undefined, propertyId: string): Promise<{ staffProfileIds?: string[] }> {
  if (!context || seesWholeWorkforce(context.permissions)) return {};
  return { staffProfileIds: await ownStaffProfileIds({ propertyId, userId: context.userId }) };
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

type PropertyParams = { propertyId: string };
type IdParams = { id: string };
const params = <T>(request: FastifyRequest): T => request.params as T;
const corr = () => createId("corr");

/**
 * assertEntityAccess con el MISMO 404 que emite el servicio (`details.code` de
 * HR_ERROR_CODES y mensaje de HR_ERROR_MESSAGES_ES): una fila de otra
 * organización y una fuera del ámbito del actor responden idéntico.
 */
async function grantHrEntity(request: TenantRequest, input: EntityAccessInput, code: "HR_EMPLOYEE_NOT_FOUND" | "HR_AGREEMENT_NOT_FOUND" | "HR_STAFFING_PLAN_NOT_FOUND"): Promise<void> {
  try {
    await assertEntityAccess(request, input);
  } catch (error) {
    if (error instanceof NotFoundError) throw hrNotFound(code);
    throw error;
  }
}

export function registerHrRoutes(app: FastifyInstance): void {
  // ── Expediente ───────────────────────────────────────────────────────────
  // Listado sin PII (nombre, número, centro, puesto, departamento, estado, contrato vigente).
  app.get("/hr/employees", async (request) => {
    const query = parseOr400(EmployeeListQuerySchema, request.query ?? {}, "query");
    return listEmployees({ context: request.userContext, query });
  });

  // Detalle; `?pii=1` descifra los campos que el ámbito permite y audita HR_PII_READ.
  app.get("/hr/employees/:id", async (request) => {
    const { id } = params<IdParams>(request);
    await grantHrEntity(request, { entity: "employee", id }, "HR_EMPLOYEE_NOT_FOUND");
    const query = parseOr400(EmployeeGetQuerySchema, request.query ?? {}, "query");
    return getEmployee({ context: request.userContext, employeeId: id, pii: query.pii === true, correlationId: corr() });
  });

  // Alta: 201 con el detalle (sin PII); 409 HR_EMPLOYEE_TAXID_DUPLICATE por sociedad.
  app.post("/hr/employees", async (request, reply: FastifyReply) => {
    const body = parseOr400(CreateEmployeeSchema, request.body ?? {}, "body");
    const created = await createEmployee({ context: request.userContext, body, correlationId: corr() });
    return reply.code(201).send(created);
  });

  app.patch("/hr/employees/:id", async (request) => {
    const { id } = params<IdParams>(request);
    await grantHrEntity(request, { entity: "employee", id }, "HR_EMPLOYEE_NOT_FOUND");
    const body = parseOr400(PatchEmployeeSchema, request.body ?? {}, "body");
    return patchEmployee({ context: request.userContext, employeeId: id, body, correlationId: corr() });
  });

  // Baja en cascada (fichas, contratos, asignaciones RBAC); segunda baja → 409 HR_EMPLOYEE_TERMINATED.
  app.post("/hr/employees/:id/terminate", async (request) => {
    const { id } = params<IdParams>(request);
    await grantHrEntity(request, { entity: "employee", id }, "HR_EMPLOYEE_NOT_FOUND");
    const body = parseOr400(TerminateEmployeeSchema, request.body ?? {}, "body");
    return terminateEmployee({ context: request.userContext, employeeId: id, terminatedAt: body.terminatedAt ?? null, reason: body.reason ?? null, correlationId: corr() });
  });

  // ── Convenios y reglas ───────────────────────────────────────────────────
  app.get("/hr/agreements", async (request) => listAgreements({ context: request.userContext }));

  app.post("/hr/agreements", async (request, reply: FastifyReply) => {
    const body = parseOr400(CreateAgreementSchema, request.body ?? {}, "body");
    // Los VALORES de las reglas los valida el servicio (HR_AGREEMENT_RULE_INVALID); el esquema solo cierra las claves.
    const created = await createAgreement({ context: request.userContext, body: { ...body, rules: (body.rules ?? null) as Partial<HrAgreementRuleValues> | null }, correlationId: corr() });
    return reply.code(201).send(created);
  });

  // Reglas vigentes en `asOf` (por defecto hoy): una versión por clave.
  app.get("/hr/agreements/:id/rules", async (request) => {
    const { id } = params<IdParams>(request);
    await grantHrEntity(request, { entity: "collectiveAgreement", id }, "HR_AGREEMENT_NOT_FOUND");
    const query = parseOr400(AgreementRulesQuerySchema, request.query ?? {}, "query");
    return listAgreementRules({ context: request.userContext, agreementId: id, asOf: query.asOf ?? null });
  });

  // Crea o sustituye versiones por (clave, validFrom); nunca borra las anteriores.
  app.put("/hr/agreements/:id/rules", async (request) => {
    const { id } = params<IdParams>(request);
    await grantHrEntity(request, { entity: "collectiveAgreement", id }, "HR_AGREEMENT_NOT_FOUND");
    const body = parseOr400(PutAgreementRulesSchema, request.body ?? {}, "body");
    const rules = body.rules.map((rule) => ({ key: rule.key, value: rule.value, validFrom: rule.validFrom, validTo: rule.validTo ?? null }));
    return putAgreementRules({ context: request.userContext, agreementId: id, rules, correlationId: corr() });
  });

  // ── Estándares de dotación ───────────────────────────────────────────────
  app.get("/hr/properties/:propertyId/standards", async (request) => {
    const { propertyId } = params<PropertyParams>(request);
    const query = parseOr400(StandardsQuerySchema, request.query ?? {}, "query");
    return listLaborStandards({ context: request.userContext, propertyId, at: query.at });
  });

  app.put("/hr/properties/:propertyId/standards", async (request) => {
    const { propertyId } = params<PropertyParams>(request);
    const body = parseOr400(PutStandardsSchema, request.body ?? {}, "body");
    return putLaborStandards({ context: request.userContext, propertyId, standards: body.standards, validFrom: body.validFrom, correlationId: corr() });
  });

  // Valores del sector por estrellas (HR_STANDARD_DEFAULTS según Property.starRating).
  app.post("/hr/properties/:propertyId/standards/reset-defaults", async (request) => {
    const { propertyId } = params<PropertyParams>(request);
    const body = parseOr400(ResetStandardsSchema, request.body ?? {}, "body");
    return resetLaborStandardDefaults({ context: request.userContext, propertyId, validFrom: body.validFrom, correlationId: corr() });
  });

  // ── Plantilla máxima ─────────────────────────────────────────────────────
  app.get("/hr/properties/:propertyId/staffing-plans", async (request) => {
    const { propertyId } = params<PropertyParams>(request);
    const query = parseOr400(StaffingPlansQuerySchema, request.query ?? {}, "query");
    return listStaffingPlans({ context: request.userContext, propertyId, year: query.year });
  });

  // Crea o reescribe el borrador (año × temporada); un plan aprobado no se reescribe (409).
  app.post("/hr/properties/:propertyId/staffing-plans", async (request, reply: FastifyReply) => {
    const { propertyId } = params<PropertyParams>(request);
    const body = parseOr400(CreateStaffingPlanSchema, request.body ?? {}, "body");
    const saved = await upsertStaffingPlan({ context: request.userContext, propertyId, body, correlationId: corr() });
    return reply.code(201).send(saved);
  });

  // Aprobación con separación de funciones: quien preparó la versión no la aprueba (409 APPROVAL_SELF_DECISION).
  app.post("/hr/properties/:propertyId/staffing-plans/:id/approve", async (request) => {
    const { propertyId, id } = params<PropertyParams & IdParams>(request);
    await grantHrEntity(request, { entity: "staffingPlan", id, propertyId }, "HR_STAFFING_PLAN_NOT_FOUND");
    return approveStaffingPlan({ context: request.userContext, propertyId, planId: id, correlationId: corr() });
  });

  // ── Previsión de plantilla ───────────────────────────────────────────────
  // Único escritor de LaborForecast (upsert por centro × día × departamento); ventana ≤ 92 días.
  app.post("/hr/properties/:propertyId/labor-forecast/generate", async (request) => {
    const { propertyId } = params<PropertyParams>(request);
    const body = parseOr400(LaborForecastGenerateSchema, request.body ?? {}, "body");
    return generateLaborForecast({ context: request.userContext, propertyId, from: body.from, to: body.to, correlationId: corr() });
  });

  app.get("/hr/properties/:propertyId/labor-forecast", async (request) => {
    const { propertyId } = params<PropertyParams>(request);
    const query = parseOr400(LaborForecastQuerySchema, request.query ?? {}, "query");
    return listLaborForecast({ context: request.userContext, propertyId, from: query.from, to: query.to });
  });

  // ── KPIs y alertas ───────────────────────────────────────────────────────
  // Sin `propertyId` = centros en ámbito de la organización; `period` YYYY-MM (por defecto el mes actual).
  app.get("/hr/kpis", async (request) => {
    const query = parseOr400(HrKpisQuerySchema, request.query ?? {}, "query");
    return getHrKpis({ context: request.userContext, propertyId: query.propertyId ?? null, periodCode: query.period ?? null });
  });

  app.get("/hr/alerts", async (request) => {
    const query = parseOr400(HrAlertsQuerySchema, request.query ?? {}, "query");
    return listHrAlerts({ context: request.userContext, propertyId: query.propertyId });
  });

  // ── Ausencias ────────────────────────────────────────────────────────────
  // Lista del centro (`workforce_labor:absence_requests`) con filtro `status`; página `{ items, total, nextCursor }` + cabeceras.
  // Con solo workforce.read (plantillas operativas) la página se ciñe a las fichas del actor (RF-03: nunca las ausencias, motivos y decisores de los compañeros).
  app.get("/hr/absences", async (request, reply: FastifyReply) => {
    const query = parseOr400(AbsenceListQuerySchema, request.query ?? {}, "query");
    const scope = await workforceSelfScope(request.userContext, query.propertyId);
    const page = await listAdvancedRecords(query.propertyId, "workforce_labor", "absence_requests", { limit: query.limit, cursor: query.cursor ?? null, status: query.status ?? null, ...scope });
    reply.headers(pageHeaders(page));
    const permissions = request.userContext?.permissions ?? [];
    return { ...page, items: page.items.map((item) => maskHealthAbsence(item as { payload?: Record<string, unknown> }, permissions)) };
  });

  // Solicitud de ausencia del propio empleado (D §9 «solicitar»; RF-03): workforce.timeclock.use, siempre sobre su ficha activa
  // del centro activo (400 HR_EMPLOYEE_REQUIRED sin ficha; el cuerpo no puede nombrar a otra persona). Decide otro usuario.
  app.post("/workforce/me/absences", async (request, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.staffProfileId !== undefined || body.staffName !== undefined) throw new BadRequestError("La solicitud propia no admite staffProfileId ni staffName: la ficha es la tuya.");
    const propertyId = request.userContext.propertyId;
    const own = await ownStaffProfileIds({ propertyId, userId: request.userContext.userId });
    if (own.length === 0) {
      const error = new BadRequestError("No tienes ficha de personal activa en este centro: pide a RRHH que la cree antes de solicitar una ausencia.");
      error.details = { code: "HR_EMPLOYEE_REQUIRED" };
      throw error;
    }
    const created = await createAdvancedRecord({
      context: request.userContext,
      propertyId,
      moduleCode: "workforce_labor",
      entityType: "absence_request",
      auditAction: "AbsenceRequested",
      requiredPermissions: ["workforce.timeclock.use"],
      payload: { ...body, staffProfileId: own[0]! } as never,
      correlationId: corr()
    });
    return reply.code(201).send(created);
  });

  // Decisión (approved | rejected | cancelled): requestedBy ≠ decisor (409 APPROVAL_SELF_DECISION); fija decidedAt.
  app.post("/hr/absences/:id/decide", async (request) => {
    const { id } = params<IdParams>(request);
    const propertyId = await assertPropertyEntityAccess(request, { entity: "absenceRequest", id });
    const body = parseOr400(AbsenceDecideSchema, request.body ?? {}, "body");
    return transitionAdvancedRecord({
      context: request.userContext,
      propertyId,
      moduleCode: "workforce_labor",
      entityType: "absence_request",
      entityId: id,
      status: body.status,
      // Misma acción del catálogo ADVANCED_AUDIT_EVENTS que PATCH /workforce/absences/:id; el estado resultante viaja en afterJson.
      auditAction: "AbsenceApproved",
      requiredPermissions: ["workforce.schedule.manage"],
      payload: body as never,
      correlationId: corr()
    });
  });
}
