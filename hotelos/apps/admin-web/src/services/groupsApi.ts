// Frontend client for Groups & Events (B2B group bookings).
// Industria 2026: 7 tipos de grupos · ES specifics (REAV / IVA · llegadas confidenciales).
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

// ─── Tipos de dominio (industria · 7 categorías canónicas) ───────────────
export type GroupType =
  | "corporate"   // Empresa: kick-offs, conferencias internas, ferias
  | "mice"        // Meetings, Incentives, Conferences, Exhibitions
  | "smerf"       // Social, Military, Educational, Religious, Fraternal
  | "leisure"     // Tours, asociaciones, grupos de jubilados
  | "wedding"     // Bodas y celebraciones familiares grandes
  | "sports"      // Equipos deportivos (incluye clubs VIP confidenciales)
  | "wholesale";  // TT.OO. con bloque puntual (distinto de allotment recurrente)

export type GroupStatus = "inquiry" | "tentative" | "definite";
export type RateType = "net" | "commissionable";
export type AttritionType = "cumulative" | "nightly" | "revenue";
export type BillingMethod = "master_folio" | "split" | "individual";
export type PaymentMethod = "cc_guarantee" | "prepay_pct" | "deposit" | "credit" | "transfer";
export type MealPlan = "none" | "HD" | "FB" | "AI";

// ─── Payload de creación (todos opcionales salvo los marcados como string vacío) ─
export type CreateGroupPayload = {
  // Identificación
  code?: string;
  name?: string;
  groupType?: GroupType;
  status?: GroupStatus;
  marketCode?: string;
  sourceCode?: string;
  arrivalDate?: string;
  departureDate?: string;
  assignedToUserId?: string;
  // Contacto
  contactPersonName?: string;
  contactEmail?: string;
  contactPhone?: string;
  contactRole?: string;
  // Empresa
  companyName?: string;
  companyTaxId?: string;
  companyAddress?: string;
  industry?: string;
  // Tarifa
  contractedRate?: number;
  currency?: string;
  rateType?: RateType;
  commissionPct?: number;
  // Cancelación / release
  cutOffDate?: string;
  roomingListDueDate?: string;
  attritionType?: AttritionType;
  attritionThresholdPct?: number;
  attritionPenaltyPct?: number;
  // Billing
  billingMethod?: BillingMethod;
  paymentMethod?: PaymentMethod;
  depositPct?: number;
  // F&B
  breakfastIncluded?: boolean;
  mealPlan?: MealPlan;
  welcomeCocktail?: boolean;
  galaDinner?: boolean;
  // ES specifics
  regimenEspecialAaee?: boolean;
  confidentialArrival?: boolean;
  // Misc
  notes?: string;
};

// ─── Entidad persistida (lo que devuelve el backend) ─────────────────────
export type GroupBooking = CreateGroupPayload & {
  id: string;
  propertyId: string;
  createdAt: string;
};

export function createGroupBooking(
  payload: CreateGroupPayload,
  propertyId = getActivePropertyId()
) {
  return apiRequest<GroupBooking>(`/groups/properties/${propertyId}`, {
    method: "POST",
    body: payload
  });
}
