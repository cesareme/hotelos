// Máquinas de estado del activo inmobiliario (Tanda ACT · L0a, diseño §5.1).
// Puras: tablas `de → [a…]` y `canTransition`. Los estados son columnas String
// del schema; los catálogos viven en packages/shared/src/real-estate-types.ts.
// Los efectos (caché de tenencia, asiento 631, alta de la siguiente inspección,
// capitalización) los aplican los servicios de L1/L3, no estas tablas.

import type { CapexProjectStatus, PropertyTaxReceiptStatus, RealEstateErrorCode, RealEstateInspectionStatus, RealEstateTenureStatus } from "@hotelos/shared";
import { realEstateError } from "./errors.js";

/** borrador → «Activar» → vigente → «Resolver» | fin de plazo → resuelto | vencido. */
export const TENURE_TRANSITIONS: Record<RealEstateTenureStatus, readonly RealEstateTenureStatus[]> = {
  borrador: ["vigente"],
  vigente: ["resuelto", "vencido"],
  vencido: [],
  resuelto: []
};

/**
 * previsto → recibido | domiciliado | pagado | recurrido; recibido | domiciliado →
 * pagado | recurrido; recurrido → pagado; pagado → recurrido (diseño §5.1: «Recurrir»
 * desde cualquier estado; ACT-REV-10: el recurso sobre un recibo pagado conserva
 * paidAt / paidWith). «vencido» es derivado.
 */
export const RECEIPT_TRANSITIONS: Record<PropertyTaxReceiptStatus, readonly PropertyTaxReceiptStatus[]> = {
  previsto: ["recibido", "domiciliado", "pagado", "recurrido"],
  recibido: ["pagado", "recurrido"],
  domiciliado: ["pagado", "recurrido"],
  recurrido: ["pagado"],
  pagado: ["recurrido"]
};

/** programada → «Registrar acta» → realizada | con_defectos → «Subsanar» / cerrar → cerrada. */
export const INSPECTION_TRANSITIONS: Record<RealEstateInspectionStatus, readonly RealEstateInspectionStatus[]> = {
  programada: ["realizada", "con_defectos"],
  realizada: ["cerrada"],
  con_defectos: ["cerrada"],
  cerrada: []
};

/** proposed → approved → in_progress → completed; cancelled solo desde proposed | approved. */
export const CAPEX_WORK_TRANSITIONS: Record<CapexProjectStatus, readonly CapexProjectStatus[]> = {
  proposed: ["approved", "cancelled"],
  approved: ["in_progress", "cancelled"],
  in_progress: ["completed"],
  completed: [],
  cancelled: []
};

export const REAL_ESTATE_STATE_MACHINES = {
  TENURE: TENURE_TRANSITIONS,
  RECEIPT: RECEIPT_TRANSITIONS,
  INSPECTION: INSPECTION_TRANSITIONS,
  CAPEX_WORK: CAPEX_WORK_TRANSITIONS
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type RealEstateStateMachine = keyof typeof REAL_ESTATE_STATE_MACHINES;

/** Código de error por defecto de una transición inválida (sobrescribible en `assertTransition`). */
export const INVALID_TRANSITION_CODES: Record<RealEstateStateMachine, RealEstateErrorCode> = {
  TENURE: "TENURE_INVALID_TRANSITION",
  RECEIPT: "RECEIPT_NOT_PAYABLE",
  INSPECTION: "INSPECTION_INVALID_TRANSITION",
  CAPEX_WORK: "CAPEX_NOT_COMPLETED"
};

/** Estados alcanzables desde `from` (vacío si el estado es final o desconocido). */
export function nextStates(machine: RealEstateStateMachine, from: string): readonly string[] {
  const table = REAL_ESTATE_STATE_MACHINES[machine] as Record<string, readonly string[]>;
  return Object.prototype.hasOwnProperty.call(table, from) ? table[from] : [];
}

/** True si la tabla de `machine` permite `from → to` (estados desconocidos → false; `from === to` → false). */
export function canTransition(machine: RealEstateStateMachine, from: string, to: string): boolean {
  return nextStates(machine, from).includes(to);
}

/**
 * Lanza 409 tipado si la transición no está permitida. El código por defecto
 * es el de `INVALID_TRANSITION_CODES[machine]`; `details` lleva `from`, `to`
 * y `allowed` para que el front explique qué acciones quedan.
 */
export function assertTransition(machine: RealEstateStateMachine, from: string, to: string, options: { code?: RealEstateErrorCode; message?: string } = {}): void {
  if (canTransition(machine, from, to)) return;
  const allowed = nextStates(machine, from);
  const message = options.message ?? `Transición no permitida: ${from} → ${to}${allowed.length > 0 ? ` (desde ${from} solo se admite: ${allowed.join(", ")})` : ` (${from} es un estado final)`}.`;
  throw realEstateError(409, options.code ?? INVALID_TRANSITION_CODES[machine], message, { machine, from, to, allowed });
}
