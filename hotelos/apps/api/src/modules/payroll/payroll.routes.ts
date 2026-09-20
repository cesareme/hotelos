// Nómina · rutas de la Tanda RRHH (RRHH-6): incidencias del mes para la
// gestoría y el modo del periodo en las respuestas de periodos.
//
// Registradas desde server.ts con `registerPayrollRoutes(app)` justo después de
// registerHrRoutes(app). Permisos en route-permissions.partial.ts (entrada
// `GET /payroll/incidences` · workforce.payroll_export · medium). Las rutas
// heredadas de nómina (/payroll/contracts, /payroll/periods*) siguen en
// server.ts y treasury.routes.ts.
//
//   GET /payroll/incidences?period=YYYY-MM[&propertyId][&format=json|csv]
//     → PayrollIncidencesDto (+ `propertyCode`, `warnings`) y, con `format=csv`,
//       `filename`, `contentType` y `text` (CSV `;` con BOM) como la exportación
//       de nóminas: el navegador descarga `text` con downloadText. Nunca NIF.
//   GET /payroll/labor-cost-panel?from=YYYY-MM&to=YYYY-MM[&propertyId]
//     (PANEL-A · payroll.read · medium) → LaborCostPanelDto: coste de personal
//       por centro × mes × departamento USALI frente a ventas, RN y plantilla
//       (labor-cost-panel.service.ts). Ámbito como el informe de coste: con
//       `propertyId` el centro debe estar en el ámbito (404 opaco); sin él, toda
//       la sociedad (accounting.entity.read o ámbito de organización; si no, 404
//       ENTITY_SCOPE_REQUIRED). Rango ≤ PAYROLL_COST_REPORT_MAX_MONTHS meses.
//
// `mode` (external | calculated) y `closedAt` viajan en todo PayrollPeriodRecord
// desde mapPeriod (periods.service.ts; corrector RRHH · SEC-12): GET/POST
// /payroll/periods, calculate, GET /payroll/periods/:id, approve y pay los llevan
// sin envoltorio.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertFinanceReadScope } from "../../lib/finance-scope.js";
import { createId } from "../../lib/ids.js";
import { HR_STRICT_QUERY, PayrollIncidencesQuerySchema } from "../../schemas/hr.schemas.js";
import { PERIOD_CODE } from "../../schemas/payroll-cost.schemas.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { buildPayrollIncidences, incidencesFilename, renderIncidencesCsv } from "./incidences.service.js";
import { buildLaborCostPanel } from "./labor-cost-panel.service.js";

/** Consulta de `GET /payroll/labor-cost-panel` (estricta: cualquier parámetro extra → 400 VALIDATION_ERROR). */
export const LaborCostPanelQuerySchema = z
  .object({
    from: z.string({ required_error: "from es obligatorio.", invalid_type_error: "from debe ser un mes YYYY-MM." }).trim().regex(PERIOD_CODE, { message: "from debe ser un mes YYYY-MM." }),
    to: z.string({ required_error: "to es obligatorio.", invalid_type_error: "to debe ser un mes YYYY-MM." }).trim().regex(PERIOD_CODE, { message: "to debe ser un mes YYYY-MM." }),
    propertyId: z.string({ invalid_type_error: "propertyId debe ser un texto." }).trim().min(1, { message: "propertyId no puede estar vacío." }).max(64, { message: "propertyId no puede superar 64 caracteres." }).optional()
  })
  .strict(HR_STRICT_QUERY);

export type LaborCostPanelQuery = z.infer<typeof LaborCostPanelQuerySchema>;

export function registerPayrollRoutes(app: FastifyInstance): void {
  // Incidencias del mes (altas, bajas, cambios de contrato, ausencias aprobadas): JSON o CSV sin NIF.
  app.get("/payroll/incidences", async (request) => {
    const query = parseOr400(PayrollIncidencesQuerySchema, request.query ?? {}, "query");
    const result = await buildPayrollIncidences({ context: request.userContext, periodCode: query.period, propertyId: query.propertyId ?? null, correlationId: createId("corr") });
    if (query.format !== "csv") return result;
    return { ...result, filename: incidencesFilename(result.periodCode, result.propertyCode), contentType: "text/csv", text: renderIncidencesCsv(result.rows) };
  });

  // Panel de costes de personal de dirección (PANEL-A): centros × meses × departamentos USALI
  // frente a ventas (70x / referencia), habitaciones ocupadas reales y plantilla del lote.
  app.get("/payroll/labor-cost-panel", async (request) => {
    const query = parseOr400(LaborCostPanelQuerySchema, request.query ?? {}, "query");
    assertFinanceReadScope(request.userContext, query.propertyId ?? null);
    return buildLaborCostPanel({ context: request.userContext, from: query.from, to: query.to, propertyId: query.propertyId ?? null });
  });
}
