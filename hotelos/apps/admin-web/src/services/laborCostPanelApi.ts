// Panel de costes de personal de dirección (Tanda RRHH · PANEL-B). Cliente
// tipado de la ruta del panel (apps/api/src/modules/payroll/payroll.routes.ts;
// agregador y semántica en labor-cost-panel.service.ts; DTO `LaborCostPanelDto`
// en packages/shared/src/hr-types.ts; viñeta en docs/api-contracts.md):
//
//   GET /payroll/labor-cost-panel?from=YYYY-MM&to=YYYY-MM[&propertyId]   getLaborCostPanel   payroll.read
//
// Sin `propertyId` la respuesta es toda la sociedad (exige accounting.entity.read
// o ámbito de organización; si no, 404 `details.code = ENTITY_SCOPE_REQUIRED`);
// con él, el centro debe estar en el ámbito del actor (404 opaco «Propiedad no
// encontrada.»). Un mes sin coste llega como `laborCost: "0.00"` + `source: null`
// + `LABOR_PANEL_COST_MISSING` en `degraded[]`: el front pinta «—», nunca ese 0.
// Nunca `fetch` directo: todo pasa por apiRequest (cabecera de propiedad activa,
// 401 → login). Los errores tipados se traducen aquí (laborCostPanelErrorMessage).

import type {
  HrDegradedEntry,
  LaborCostPanelCentreDto,
  LaborCostPanelDepartment,
  LaborCostPanelDepartmentDto,
  LaborCostPanelDto,
  LaborCostPanelMonthDto,
  LaborCostPanelRankingRowDto,
  LaborCostPanelSourcesDto,
  LaborCostPanelTotalsDto,
  LaborCostSource
} from "@hotelos/shared";
import { apiRequest } from "./api-client";

export type {
  HrDegradedEntry,
  LaborCostPanelCentreDto,
  LaborCostPanelDepartment,
  LaborCostPanelDepartmentDto,
  LaborCostPanelDto,
  LaborCostPanelMonthDto,
  LaborCostPanelRankingRowDto,
  LaborCostPanelSourcesDto,
  LaborCostPanelTotalsDto,
  LaborCostSource
};

/** Ruta única del panel (la pantalla la usa con useApiData). */
export const LABOR_COST_PANEL_PATH = "/payroll/labor-cost-panel";

export type LaborCostPanelQueryInput = {
  /** Primer mes de la ventana, "YYYY-MM". */
  from: string;
  /** Último mes de la ventana, "YYYY-MM" (≥ from). */
  to: string;
  /** Centro; ausente o null = toda la sociedad. */
  propertyId?: string | null;
};

/** Consulta sin claves vacías (la ruta es `.strict()`: un parámetro extra o vacío sería 400). */
export function laborCostPanelQuery(input: LaborCostPanelQueryInput): Record<string, string | undefined> {
  return {
    from: input.from,
    to: input.to,
    propertyId: input.propertyId ?? undefined
  };
}

export async function getLaborCostPanel(input: LaborCostPanelQueryInput): Promise<LaborCostPanelDto> {
  return apiRequest<LaborCostPanelDto>(LABOR_COST_PANEL_PATH, { query: laborCostPanelQuery(input) });
}

// ---------------------------------------------------------------------------
// Errores en español
// ---------------------------------------------------------------------------

export const LABOR_COST_PANEL_ERROR_FALLBACK = "No se ha podido cargar el panel de costes de personal.";
export const LABOR_COST_PANEL_FORBIDDEN = "Sin permiso para ver los costes de personal (payroll.read).";

/** Mensajes por `details.code` de los 4xx tipados de la ruta. */
export const LABOR_COST_PANEL_ERROR_MESSAGES_ES: Readonly<Record<string, string>> = Object.freeze({
  ENTITY_SCOPE_REQUIRED: "Toda la sociedad exige el permiso de lectura de la sociedad (accounting.entity.read): elige un centro en «Ámbito».",
  VALIDATION_ERROR: "Ventana de meses no válida: el primer mes debe ser anterior o igual al último y la ventana no puede superar el máximo del informe."
});

type ErrorLike = { status?: unknown; message?: unknown; details?: unknown };

function errorLike(error: unknown): ErrorLike | null {
  return typeof error === "object" && error !== null ? (error as ErrorLike) : null;
}

/** `details.code` de un 4xx tipado del API (ApiError o cualquier `{ details: { code } }`), o null. */
export function laborCostPanelErrorCode(error: unknown): string | null {
  const details = errorLike(error)?.details;
  const code = typeof details === "object" && details !== null ? (details as { code?: unknown }).code : null;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** Mensaje en español: el del código; si no, el 403 de permisos; si no, el del API; si no, `fallback`. */
export function laborCostPanelErrorMessage(error: unknown, fallback: string = LABOR_COST_PANEL_ERROR_FALLBACK): string {
  const code = laborCostPanelErrorCode(error);
  if (code && LABOR_COST_PANEL_ERROR_MESSAGES_ES[code]) return LABOR_COST_PANEL_ERROR_MESSAGES_ES[code];
  const like = errorLike(error);
  if (like?.status === 403) return LABOR_COST_PANEL_FORBIDDEN;
  if (typeof like?.message === "string" && like.message.trim()) return like.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
}
