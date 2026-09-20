// Fichas de personal · FIX-1 · F10 · superficie HTTP.
//
// Registradas desde server.ts con `registerStaffProfileRoutes(app)` justo
// después de registerPayrollCostRoutes(app). Permisos en
// route-permissions.partial.ts (GET payroll.read medium · POST payroll.manage
// high; los contratos leen ese fichero). Cuerpo y consulta pasan por zod
// `.strict()` con mensajes en español (parseOr400 → 400 VALIDATION_ERROR que
// nombra la clave). Tenencia: `propertyId` de la consulta lo concede el hook
// global (grantPropertyAccess); el `propertyId` del cuerpo pasa aquí por el
// mismo helper (404 opaco «Propiedad no encontrada.» para una propiedad ajena o
// fuera del ámbito) antes de que el servicio repita la comprobación para los
// llamadores directos. GET /workforce/properties/:propertyId/staff-profiles
// (corrector RRHH · SEC-02, workforce.read · medium) sirve la lista reducida
// del selector de Personal y turnos a las plantillas sin payroll.read. Los códigos de dominio (STAFF_PROFILE_EXISTS 409,
// STAFF_PROFILE_DEPARTMENT_MISMATCH 400, «Usuario no encontrado.» 404) los emite
// staff-profiles.service.ts.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createId } from "../../lib/ids.js";
import { grantPropertyAccess } from "../../lib/tenancy.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { STAFF_EMPLOYEE_CODE_MAX, STAFF_EMPLOYMENT_TYPES, createStaffProfile, listStaffProfiles, listWorkforceStaffProfiles } from "./staff-profiles.service.js";

const STRICT_BODY = { message: "Campo no admitido en el cuerpo de la petición." };
const STRICT_QUERY = { message: "Parámetro de consulta no admitido." };
const PROPERTY_NOT_FOUND = "Propiedad no encontrada.";
/** Importe con coma o punto y hasta dos decimales («12,50»). */
const DECIMAL_TEXT = /^\d{1,10}([.,]\d{1,2})?$/;

const id = (label: string) =>
  z
    .string({ required_error: `${label} es obligatorio.`, invalid_type_error: `${label} debe ser un texto.` })
    .trim()
    .min(1, { message: `${label} es obligatorio.` })
    .max(64, { message: `${label} no puede superar 64 caracteres.` });

export const CreateStaffProfileSchema = z
  .object({
    propertyId: id("propertyId"),
    userId: id("userId"),
    /** Expediente (Employee) de la misma sociedad que el centro (corrector RRHH · SEC-01): enlaza la ficha al expediente. */
    employeeId: id("employeeId").optional(),
    employeeCode: z
      .string({ invalid_type_error: "employeeCode debe ser un texto." })
      .trim()
      .max(STAFF_EMPLOYEE_CODE_MAX, { message: `employeeCode no puede superar ${STAFF_EMPLOYEE_CODE_MAX} caracteres.` })
      .optional(),
    departmentId: id("departmentId").optional(),
    employmentType: z
      .enum(STAFF_EMPLOYMENT_TYPES, { errorMap: () => ({ message: `employmentType debe ser uno de: ${STAFF_EMPLOYMENT_TYPES.join(", ")}.` }) })
      .optional(),
    hourlyCost: z
      .custom<number | string>(
        (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0) || (typeof value === "string" && DECIMAL_TEXT.test(value.trim())),
        { message: "hourlyCost debe ser un importe mayor o igual que 0 con dos decimales como máximo." }
      )
      .optional()
  })
  .strict(STRICT_BODY);

export type CreateStaffProfileBody = z.infer<typeof CreateStaffProfileSchema>;

export const StaffProfileListQuerySchema = z
  .object({
    propertyId: id("propertyId").optional()
  })
  .strict(STRICT_QUERY);

export function registerStaffProfileRoutes(app: FastifyInstance): void {
  // Fichas del centro (`?propertyId=`) o de los centros en ámbito de la organización.
  app.get("/payroll/staff-profiles", async (request) => {
    const query = parseOr400(StaffProfileListQuerySchema, request.query ?? {}, "query");
    return listStaffProfiles({ context: request.userContext, propertyId: query.propertyId ?? null });
  });

  // Fichas de UN centro para fichar y planificar (corrector RRHH · SEC-02): workforce.read (las plantillas
  // operativas la tienen junto a workforce.timeclock.use); sin coste hora ni correo. `:propertyId` lo concede el hook global.
  app.get("/workforce/properties/:propertyId/staff-profiles", async (request) => {
    const { propertyId } = request.params as { propertyId: string };
    return listWorkforceStaffProfiles({ context: request.userContext, propertyId });
  });

  // Alta: 201 con la ficha (persona y departamento resueltos); audita STAFF_PROFILE_CREATED.
  app.post("/payroll/staff-profiles", async (request, reply) => {
    const body = parseOr400(CreateStaffProfileSchema, request.body ?? {}, "body");
    await grantPropertyAccess(request, body.propertyId, PROPERTY_NOT_FOUND);
    const created = await createStaffProfile({ context: request.userContext, body, correlationId: createId("corr") });
    return reply.code(201).send(created);
  });
}
