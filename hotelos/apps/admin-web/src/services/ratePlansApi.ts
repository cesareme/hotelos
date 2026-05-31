// Frontend client for Rate Plans CRUD.
//
// FIX 6: el modelo `RatePlan` existe en
// `packages/database/prisma/schema.prisma` con:
//   { id, propertyId, code, name, ratePlanType, parentRatePlanId,
//     derivationJson, cancellationPolicyId, mealPlan, active }
// y se referencia en `RestrictionDay` (MLOS/maxLOS/CTA/CTD) y `RateDay`.
// Pero NO existe todavía un endpoint REST CRUD bajo
// `/properties/:propertyId/rate-plans`. Hasta que el backend esté listo
// exponemos `isRatePlansBackendReady` que la UI debe consultar para
// avisar al usuario que está en modo demo (no se persiste nada real)
// y `RatePlansNotImplementedError` para que el caller pueda distinguir
// "endpoint inexistente" (404) de fallos transitorios (500/network).

import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

/**
 * FIX 6 & 7: Error específico que distingue "backend aún no implementado"
 * de cualquier otro fallo transitorio. La UI cae a demo data solo cuando
 * el error es de este tipo; si es un 500/network muestra error real para
 * que el operador no confunda datos demo con reales.
 */
export class RatePlansNotImplementedError extends Error {
  constructor(message = "El endpoint de rate plans no está disponible todavía.") {
    super(message);
    this.name = "RatePlansNotImplementedError";
  }
}

export type RatePlanType = "BAR" | "non_refundable" | "flexible" | "corporate" | "package" | "promo";

export type RestrictionPreset = {
  mlos?: number | null;   // minimum length of stay
  maxLos?: number | null; // maximum length of stay
  cta?: boolean;          // closed to arrival
  ctd?: boolean;          // closed to departure
};

export type RatePlan = {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  ratePlanType: RatePlanType | string;
  parentRatePlanId: string | null;
  /** Derivación respecto al padre: { type: "percent", value: -10 } o { type: "absolute", value: 5 }. */
  derivationJson: { type?: "percent" | "absolute"; value?: number } & Record<string, unknown>;
  cancellationPolicyId: string | null;
  mealPlan: string | null;
  active: boolean;
  createdAt: string;
  /** Restricciones por defecto (default profile aplicado en RestrictionDay). */
  restrictions?: RestrictionPreset;
};

export type CreateRatePlanPayload = Omit<RatePlan, "id" | "createdAt" | "propertyId"> & {
  propertyId?: string;
};

// ─────────────────────────────────────────────────────────────────────────
// API helpers — wired against the conventional endpoint path. Si el backend
// devuelve 404 caemos a demo data en la screen.
// ─────────────────────────────────────────────────────────────────────────

export async function fetchRatePlans(propertyId = getActivePropertyId()): Promise<RatePlan[]> {
  try {
    const res = await apiRequest<{ items: RatePlan[] }>(`/properties/${propertyId}/rate-plans`);
    return res.items;
  } catch (e) {
    // FIX 7: distinguir 404 (endpoint inexistente) de 500/network. Solo en el
    // primer caso caemos a demo data; los fallos transitorios se propagan
    // para que la UI muestre el error real, no datos demo confundibles.
    const message = e instanceof Error ? e.message : String(e);
    if (/HTTP 404|not\s*found|no\s*encontrado/i.test(message)) {
      throw new RatePlansNotImplementedError(message);
    }
    throw e;
  }
}

export function createRatePlan(payload: CreateRatePlanPayload, propertyId = getActivePropertyId()) {
  return apiRequest<RatePlan>(`/properties/${propertyId}/rate-plans`, { method: "POST", body: payload });
}

export function updateRatePlan(id: string, patch: Partial<RatePlan>) {
  return apiRequest<RatePlan>(`/rate-plans/${id}`, { method: "PATCH", body: patch });
}

export function deleteRatePlan(id: string) {
  return apiRequest<{ ok: boolean; id: string }>(`/rate-plans/${id}`, { method: "DELETE" });
}
