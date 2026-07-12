// Cliente frontend para CRM · Segmentos, Campañas y Fidelización.
//
// Endpoints reales (apps/api/src/server.ts:2183-2191, módulo guest_data_crm_loyalty):
//   GET   /crm/segments                — lista de segmentos de la organización
//   POST  /crm/segments                — crear segmento (entityType crm_segment)
//   PATCH /crm/segments/:id            — actualizar segmento
//   GET   /crm/campaigns               — lista de campañas
//   POST  /crm/campaigns               — crear campaña (nace en status "draft")
//   PATCH /crm/campaigns/:id           — transición/actualización de campaña
//   GET   /crm/loyalty                 — programas de fidelización + membresías embebidas
//   POST  /crm/loyalty/programs        — publicar (nueva versión de) programa
//   PATCH /crm/loyalty/memberships/:id — actualizar membresía
//
// Shapes: apps/api/src/lib/demo-store.ts (CrmSegmentRecord, CrmCampaignRecord,
// LoyaltyProgramRecord, LoyaltyMembershipRecord). Los GET devuelven un envelope
// { items: [...] } (phaseRecordResponse en advanced-modules.service.ts) —
// `toArray` absorbe cualquier drift de envelope.
//
// Permisos (apps/api/src/security/route-permissions.ts): lecturas con crm.read;
// mutaciones con crm.manage_profiles / crm.manage_campaigns / crm.manage_loyalty.

import { apiRequest } from "./api-client";
import { toArray } from "../utils/toArray";

export type CrmSegment = {
  id: string;
  organizationId: string;
  name: string;
  description?: string;
  /** Reglas de segmentación libres; esta UI guarda { criteria: [...], color }. */
  rulesJson: Record<string, unknown>;
  active: boolean;
  createdAt: string;
};

export type CampaignStatus = "draft" | "scheduled" | "sent" | "paused";

export type CrmCampaign = {
  id: string;
  organizationId: string;
  name: string;
  campaignType: string;
  segmentId?: string;
  channel: string;
  status: CampaignStatus;
  scheduleJson: Record<string, unknown>;
  contentJson: Record<string, unknown>;
  createdAt: string;
};

export type LoyaltyMembership = {
  id: string;
  loyaltyProgramId: string;
  guestProfileId: string;
  tier?: string;
  pointsBalance: number;
  status: "active" | "paused" | "cancelled";
  joinedAt: string;
};

export type LoyaltyProgram = {
  id: string;
  organizationId: string;
  name: string;
  /** Configuración libre del programa; esta UI guarda config global + tiers. */
  configurationJson: Record<string, unknown>;
  active: boolean;
  createdAt: string;
  /** GET /crm/loyalty embebe las membresías de cada programa. */
  memberships?: LoyaltyMembership[];
};

// ---------------------------------------------------------------------------
// Segmentos
// ---------------------------------------------------------------------------

export async function fetchSegments(): Promise<CrmSegment[]> {
  const response = await apiRequest<unknown>("/crm/segments");
  return toArray<CrmSegment>(response);
}

export function createSegment(payload: {
  name: string;
  description?: string;
  rulesJson: Record<string, unknown>;
}): Promise<CrmSegment> {
  return apiRequest<CrmSegment>("/crm/segments", { method: "POST", body: payload });
}

export function updateSegment(
  id: string,
  payload: {
    name?: string;
    description?: string;
    rulesJson?: Record<string, unknown>;
    active?: boolean;
  }
): Promise<unknown> {
  // La respuesta del PATCH varía según backend (registro o acuse de transición):
  // no confiar en ella — refrescar la lista con GET tras la mutación.
  return apiRequest<unknown>(`/crm/segments/${encodeURIComponent(id)}`, { method: "PATCH", body: payload });
}

// ---------------------------------------------------------------------------
// Campañas
// ---------------------------------------------------------------------------

export async function fetchCampaigns(): Promise<CrmCampaign[]> {
  const response = await apiRequest<unknown>("/crm/campaigns");
  return toArray<CrmCampaign>(response);
}

export function createCampaign(payload: {
  name: string;
  campaignType: string;
  channel: string;
  segmentId?: string;
  scheduleJson?: Record<string, unknown>;
  contentJson?: Record<string, unknown>;
}): Promise<CrmCampaign> {
  return apiRequest<CrmCampaign>("/crm/campaigns", { method: "POST", body: payload });
}

export function updateCampaign(
  id: string,
  payload: { status?: CampaignStatus } & Record<string, unknown>
): Promise<unknown> {
  // Igual que en segmentos: refrescar con GET tras la mutación.
  return apiRequest<unknown>(`/crm/campaigns/${encodeURIComponent(id)}`, { method: "PATCH", body: payload });
}

// ---------------------------------------------------------------------------
// Fidelización
// ---------------------------------------------------------------------------

export async function fetchLoyaltyPrograms(): Promise<LoyaltyProgram[]> {
  const response = await apiRequest<unknown>("/crm/loyalty");
  return toArray<LoyaltyProgram>(response);
}

/**
 * Publica la configuración del programa. El backend no expone PATCH de
 * programas — cada guardado crea una nueva versión vía POST y la lectura
 * (GET /crm/loyalty) resuelve la versión activa más reciente.
 */
export function createLoyaltyProgram(payload: {
  name: string;
  configurationJson: Record<string, unknown>;
}): Promise<LoyaltyProgram> {
  return apiRequest<LoyaltyProgram>("/crm/loyalty/programs", { method: "POST", body: payload });
}

export function updateLoyaltyMembership(id: string, payload: Record<string, unknown>): Promise<unknown> {
  return apiRequest<unknown>(`/crm/loyalty/memberships/${encodeURIComponent(id)}`, { method: "PATCH", body: payload });
}
