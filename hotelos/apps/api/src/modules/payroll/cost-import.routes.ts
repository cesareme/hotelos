// Coste de personal importado · Tanda 6c · L3 · superficie HTTP (diseño §5).
//
// Registradas desde server.ts con `registerPayrollCostRoutes(app)` justo después
// de registerStructureRoutes(app). Permisos: route-permissions.partial.ts
// (spread en routePermissionManifest; los contratos leen ese fichero). Todo
// cuerpo y consulta pasa por un esquema zod `.strict()` de
// schemas/payroll-cost.schemas.ts con parseOr400 → 400 VALIDATION_ERROR en
// español (clave desconocida, formato inválido, rango > 24 meses, motivo corto).
//
// Tenencia y ámbito: `:id` pasa por assertEntityAccess("payrollCostImport")
// (404 opaco fuera de la organización; un administrador de plataforma queda
// re-apuntado a la organización del lote para el resto de la petición); los
// `propertyId` anidados en `mapping.centres` no los ve el hook global, así que
// el servicio comprueba tenencia por organización y ámbito R11
// (assertFinanceReadScopeMany → 404 opaco). El informe de toda la sociedad
// (sin propertyId) exige accounting.entity.read o un contexto sin asignaciones
// (assertFinanceReadScope antes del servicio, patrón financial-statements.routes.ts).
//
// Códigos de dominio (PAYROLL_COST_ERROR_CODES de @hotelos/shared): los emite
// cost-import.service.ts / cost-report.service.ts; aquí solo se valida la
// frontera y se enruta.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PayrollCostMapping } from "@hotelos/shared";
import { assertFinanceReadScope } from "../../lib/finance-scope.js";
import { BadRequestError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import {
  CreatePayrollCostImportSchema,
  PayrollCostImportListQuerySchema,
  PayrollCostReportQuerySchema,
  PostPayrollCostImportSchema,
  PreviewPayrollCostImportSchema,
  ReversePayrollCostImportSchema,
  type PayrollCostMappingInput
} from "../../schemas/payroll-cost.schemas.js";
import {
  PAYROLL_COST_DETAIL_DEFAULT_LIMIT,
  PAYROLL_COST_DETAIL_MAX_LIMIT,
  createPayrollCostImport,
  getPayrollCostImport,
  listPayrollCostImports,
  postPayrollCostImport,
  previewPayrollCostImport,
  reversePayrollCostImport
} from "./cost-import.service.js";
import { buildPayrollCostReport } from "./cost-report.service.js";

type ImportParams = { id: string };

// Tanda L2 (L2-05): página de líneas del detalle, `?offset=&limit=` como
// GET /accounting/ledger-imports/:id (500 por defecto, 2.000 máximo). El cuerpo
// sigue siendo el detalle que lee el front (`lines`, `references`,
// `byCentreMonth`, `entries`, `reversals`) más `lineTotal` / `lineOffset`;
// X-Total-Count lleva el total de líneas. Un `cursor` (de otra ruta) responde
// el 400 canónico de paginación: el detalle pagina por desplazamiento.
const DetailQuerySchema = z
  .object({
    offset: z.coerce
      .number({ invalid_type_error: "offset debe ser un entero ≥ 0." })
      .int({ message: "offset debe ser un entero ≥ 0." })
      .min(0, { message: "offset debe ser un entero ≥ 0." })
      .default(0),
    limit: z.coerce
      .number({ invalid_type_error: `limit debe ser un entero entre 1 y ${PAYROLL_COST_DETAIL_MAX_LIMIT}.` })
      .int({ message: `limit debe ser un entero entre 1 y ${PAYROLL_COST_DETAIL_MAX_LIMIT}.` })
      .min(1, { message: `limit debe ser un entero entre 1 y ${PAYROLL_COST_DETAIL_MAX_LIMIT}.` })
      .max(PAYROLL_COST_DETAIL_MAX_LIMIT, { message: `limit debe ser un entero entre 1 y ${PAYROLL_COST_DETAIL_MAX_LIMIT}.` })
      .default(PAYROLL_COST_DETAIL_DEFAULT_LIMIT)
  })
  .strict({ message: "Parámetro de consulta no admitido." });

function rejectCursor(raw: Record<string, unknown>): void {
  if (raw.cursor !== undefined) throw new BadRequestError("El cursor de paginación no es válido.");
}

/**
 * El esquema admite cualquier departamento del catálogo USALI (también los que no
 * admiten la línea `labor`) para que el servicio responda 400
 * USALI_LINE_NOT_ADMITTED con el departamento en `details`; el contrato wire
 * (`PayrollCostMapping`) solo nombra los siete que la admiten. El servicio
 * vuelve a comprobar cada valor (isAdmittedUsali), así que el estrechamiento es
 * solo de tipos.
 */
function wireMapping(mapping: PayrollCostMappingInput | undefined): PayrollCostMapping | undefined {
  return mapping as PayrollCostMapping | undefined;
}

export function registerPayrollCostRoutes(app: FastifyInstance): void {
  // Previsualización: filas normalizadas, centros / departamentos sin mapear con
  // sugerencias, celdas centro × mes, duplicado y solapes. Nunca escribe.
  app.post("/payroll/cost-imports/preview", async (request) => {
    const body = parseOr400(PreviewPayrollCostImportSchema, request.body ?? {}, "body");
    return previewPayrollCostImport({ context: request.userContext, body: { ...body, mapping: wireMapping(body.mapping) } });
  });

  // Importar (+ contabilizar salvo `post: false`): 201 con el lote, sus asientos y
  // los lotes sustituidos por `replace`.
  app.post("/payroll/cost-imports", async (request, reply) => {
    const body = parseOr400(CreatePayrollCostImportSchema, request.body ?? {}, "body");
    const result = await createPayrollCostImport({
      context: request.userContext,
      body: { ...body, mapping: wireMapping(body.mapping) },
      correlationId: createId("corr")
    });
    return reply.code(201).send(result);
  });

  // Listado (createdAt desc; solo lotes cuyos centros están TODOS en ámbito).
  app.get("/payroll/cost-imports", async (request) => {
    const query = parseOr400(PayrollCostImportListQuerySchema, request.query ?? {}, "query");
    return listPayrollCostImports({ context: request.userContext, query });
  });

  // Detalle: lote + líneas (paginadas) + referencias + asientos y reversos.
  app.get("/payroll/cost-imports/:id", async (request, reply) => {
    const { id } = request.params as ImportParams;
    await assertEntityAccess(request, { entity: "payrollCostImport", id });
    const raw = (request.query ?? {}) as Record<string, unknown>;
    rejectCursor(raw);
    const query = parseOr400(DetailQuerySchema, raw, "query");
    const detail = await getPayrollCostImport({ context: request.userContext, importId: id, query });
    reply.header("X-Total-Count", String(detail.lineTotal));
    return detail;
  });

  // Borrador → contabilizado (misma transacción: lock, duplicado, solape, asientos).
  app.post("/payroll/cost-imports/:id/post", async (request) => {
    const { id } = request.params as ImportParams;
    await assertEntityAccess(request, { entity: "payrollCostImport", id });
    const body = parseOr400(PostPayrollCostImportSchema, request.body ?? {}, "body");
    return postPayrollCostImport({ context: request.userContext, importId: id, body, correlationId: createId("corr") });
  });

  // Reverso completo e idempotente del lote (solo sus propios asientos).
  app.post("/payroll/cost-imports/:id/reverse", async (request) => {
    const { id } = request.params as ImportParams;
    await assertEntityAccess(request, { entity: "payrollCostImport", id });
    const body = parseOr400(ReversePayrollCostImportSchema, request.body ?? {}, "body");
    return reversePayrollCostImport({ context: request.userContext, importId: id, body, correlationId: createId("corr") });
  });

  // Informe centros × meses: bruto, SS, total, empleados, coste por empleado,
  // ventas del libro y de referencia, % personal s/ ventas, habitaciones
  // disponibles, desglose por grupo y departamento USALI.
  app.get("/payroll/cost-report", async (request) => {
    const query = parseOr400(PayrollCostReportQuerySchema, request.query ?? {}, "query");
    assertFinanceReadScope(request.userContext, query.propertyId ?? null);
    return buildPayrollCostReport({
      context: request.userContext,
      from: query.from,
      to: query.to,
      propertyId: query.propertyId ?? null,
      group: query.group ?? null
    });
  });
}
