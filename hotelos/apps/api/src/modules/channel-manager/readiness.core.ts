// Pure part of the channel readiness texts (rate grid v2). No database: the
// hub and the grid header render these strings verbatim, so they must be
// Spanish, with dates the hotelier reads («15/09/2026 01:29», Europe/Madrid)
// and never raw ISO timestamps, internal sync-type codes or capitals — a CSS
// `text-transform` on a pill once turned an ISO stamp into
// «ÚLTIMO TEST_CREDENTIALS CORRECTO EL 2026-09-14T23:29:32.044Z».
//
// What the sandbox mode means is worded honestly everywhere: the local
// simulator performs a STRUCTURAL validation of the payload (element /
// attribute scanner plus the documented business rules), it is not a
// certification by the provider.
//
// `productCodesCheck` is the pure half of check (f) of readiness.service.ts
// (shared external codes); the rows come from mapping.service.ts.

import type { ChannelMode } from "./adapter.types.js";
import { addressesByRatePlanOnly, providerLabelEs, type SharedProductCodes } from "./mapping.core.js";

export type ReadinessCheckStatus = "ok" | "warn" | "error";

export type ReadinessCheck = {
  key: string;
  label: string;
  status: ReadinessCheckStatus;
  detail: string;
};

export const SANDBOX_MEANING = "validación estructural del payload (no sustituye la certificación del proveedor)";

const DATE_TIME_ES = new Intl.DateTimeFormat("es-ES", {
  timeZone: "Europe/Madrid",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

/** «15/09/2026 01:29» in Europe/Madrid; an invalid date renders as «fecha desconocida» rather than "Invalid Date". */
export function formatDateTimeEs(value: Date | string | null | undefined): string {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "fecha desconocida";
  const parts = Object.fromEntries(DATE_TIME_ES.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

/** Human label of a ChannelSyncJob.syncType (never the raw code). */
export function syncTypeLabelEs(syncType: string): string {
  switch (syncType) {
    case "test_credentials":
      return "prueba de conexión";
    case "push_rates":
      return "envío de tarifas";
    case "push_restrictions":
      return "envío de restricciones";
    case "push_availability":
      return "envío de disponibilidad";
    case "pull_reservations":
      return "descarga de reservas";
    default:
      return `sincronización ${syncType.replace(/_/g, " ")}`;
  }
}

/** Human label of a ChannelDelivery.kind. */
export function deliveryKindLabelEs(kind: string): string {
  switch (kind) {
    case "rates":
      return "de tarifas";
    case "restrictions":
      return "de restricciones";
    case "availability":
      return "de disponibilidad";
    default:
      return kind;
  }
}

/** Mode wording for the hotelier («modo de pruebas», never the bare code when a sentence needs it). */
export function modeLabelEs(mode: ChannelMode): string {
  switch (mode) {
    case "real":
      return "real";
    case "sandbox":
      return "sandbox (pruebas)";
    default:
      return "stub (simulado)";
  }
}

/** Short readiness summary of the grid header (RateGridChannel.readinessSummary). */
export function readinessForGrid(input: { status: string; mode: ChannelMode; hasCredentials: boolean; mappedProducts: number; hasAdapter: boolean }): { readyToPush: boolean; summary: string } {
  if (!input.hasAdapter) return { readyToPush: false, summary: "Proveedor sin adaptador." };
  if (input.status !== "active") return { readyToPush: false, summary: "Canal inactivo." };
  if (input.mappedProducts === 0) return { readyToPush: false, summary: "Sin productos mapeados (tipo × plan)." };
  if (input.mode === "stub") return { readyToPush: true, summary: "Modo stub: el simulador local confirma sin credenciales." };
  if (!input.hasCredentials) return { readyToPush: false, summary: `Modo ${modeLabelEs(input.mode)}: faltan credenciales.` };
  if (input.mode === "sandbox") return { readyToPush: true, summary: "Modo sandbox: validado por el simulador local (validación estructural del payload, no certificación del proveedor)." };
  return { readyToPush: true, summary: "Modo real: envíos HTTPS al proveedor." };
}

export function modeCheck(requested: ChannelMode, effective: ChannelMode, maxMode: ChannelMode): ReadinessCheck {
  const capped = requested !== effective ? ` Solicitado ${requested}, limitado a ${effective} por CHANNEL_MAX_MODE=${maxMode}.` : "";
  if (effective === "real") return { key: "adapter_mode", label: "Modo", status: "ok", detail: `Modo real: tráfico HTTPS al proveedor.${capped}` };
  if (effective === "sandbox") {
    return { key: "adapter_mode", label: "Modo", status: "warn", detail: `Modo sandbox: el simulador local valida la estructura del payload (no sustituye la certificación del proveedor); nada sale a Internet.${capped}` };
  }
  return { key: "adapter_mode", label: "Modo", status: "error", detail: `Modo stub: nada sale del servidor. Pase a sandbox para validar la estructura del payload y a real para publicar.${capped}` };
}

/**
 * «Última entrega confirmada» check. Dates formatted for the hotelier; the
 * sync type in words. Both a confirmed delivery and a recent successful sync
 * job are evidence the channel answers; neither is a certification.
 */
export function recentSuccessCheck(input: { lastConfirmed: { kind: string; confirmedAt: Date } | null; recentTest: { syncType: string; createdAt: Date } | null }): ReadinessCheck {
  const label = "Última entrega confirmada";
  if (input.lastConfirmed) {
    return { key: "recent_success", label, status: "ok", detail: `Última entrega ${deliveryKindLabelEs(input.lastConfirmed.kind)} confirmada el ${formatDateTimeEs(input.lastConfirmed.confirmedAt)}.` };
  }
  if (input.recentTest) {
    return { key: "recent_success", label, status: "warn", detail: `Sin entregas confirmadas; última ${syncTypeLabelEs(input.recentTest.syncType)} correcta el ${formatDateTimeEs(input.recentTest.createdAt)}.` };
  }
  return { key: "recent_success", label, status: "warn", detail: "Sin entregas confirmadas ni pruebas recientes: ejecute «Probar conexión» y publique un rango pequeño." };
}

/**
 * «Códigos de producto» check (key `product_codes`). An external ROOM code
 * shared by several room types collides on every provider (availability is
 * keyed by room; Booking / Expedia also price by room); a shared RATE code
 * only collides on the Channex-routed ones (a Channex rate plan belongs to one
 * room type — Booking / Expedia legitimately share RP-<plan> across rooms).
 * Warn in stub/sandbox (seeded placeholders, still editable), error in `real`.
 */
export function productCodesCheck(input: { providerCode: string; mode: ChannelMode; shared: SharedProductCodes }): ReadinessCheck {
  const label = "Códigos de producto";
  const byRatePlan = addressesByRatePlanOnly(input.providerCode);
  const provider = providerLabelEs(input.providerCode);
  const rateCodes = byRatePlan ? input.shared.rateCodes : [];
  const roomCodes = input.shared.roomCodes;
  if (rateCodes.length === 0 && roomCodes.length === 0) {
    return {
      key: "product_codes",
      label,
      status: "ok",
      detail: byRatePlan ? "Cada código externo de habitación y de rate plan pertenece a un solo tipo de habitación." : "Cada código de habitación externo pertenece a un solo tipo de habitación."
    };
  }
  const parts: string[] = [];
  if (roomCodes.length > 0) {
    parts.push(
      `${roomCodes.length} código(s) de habitación compartidos entre tipos (${roomCodes.map((s) => s.code).join(", ")}): en ${provider} cada código de habitación identifica un solo tipo, así que la disponibilidad y las tarifas de los tipos que lo comparten se pisarían.`
    );
  }
  if (rateCodes.length > 0) {
    parts.push(`${rateCodes.length} código(s) de rate plan compartidos entre tipos (${rateCodes.map((s) => s.code).join(", ")}): en Channex un rate plan pertenece a un solo tipo, mapee cada tipo con su id real.`);
  }
  return { key: "product_codes", label, status: input.mode === "real" ? "error" : "warn", detail: parts.join(" ") };
}

// Per-provider required credential keys (snake_case / camelCase accepted).
export const REQUIRED_CREDENTIAL_KEYS: Record<string, string[][]> = {
  booking: [["client_id", "clientId"], ["client_secret", "clientSecret"], ["hotelId", "hotel_id", "hotelCode"]],
  expedia: [["username", "user", "eqcUsername"], ["password", "eqcPassword"], ["hotelId", "hotel_id", "resortID", "resortId"]],
  channex: [["apiKey", "api_key", "CHANNEX_API_KEY", "userApiKey"], ["propertyId", "property_id", "channexPropertyId"]],
  airbnb: [],
  hotelbeds: [],
  vrbo: []
};

function hasKey(creds: Record<string, unknown>, aliases: string[]): boolean {
  return aliases.some((alias) => {
    const v = creds[alias];
    return typeof v === "string" ? v.length > 0 : typeof v === "number";
  });
}

/** `normalizedProvider` is the canonical provider code (adapters/index normalizeProviderCode) or null. */
export function credentialsCheck(normalizedProvider: string | null, credentials: Record<string, unknown> | null, legacy: boolean, mode: ChannelMode, undecryptable = false): ReadinessCheck {
  const label = "Credenciales";
  if (mode === "stub") {
    return { key: "credentials", label, status: "ok", detail: credentials ? "Presentes (no se verifican en modo stub)." : "No necesarias en modo stub." };
  }
  if (!credentials || Object.keys(credentials).length === 0) {
    // Distinguish "never saved" from "saved but the current encryption key
    // cannot open them": the fix is different (save vs re-save after rotation).
    if (undecryptable) {
      return { key: "credentials", label, status: "error", detail: "Credenciales guardadas pero no descifrables con la clave de cifrado actual (clave rotada sin backfill): vuelva a guardarlas con PATCH /channel-manager/channels/:id/credentials." };
    }
    return { key: "credentials", label, status: "error", detail: "Sin credenciales guardadas para este canal (PATCH /channel-manager/channels/:id/credentials)." };
  }
  const required = REQUIRED_CREDENTIAL_KEYS[normalizedProvider ?? ""] ?? [];
  const missing = required.filter((aliases) => !hasKey(credentials, aliases));
  if (missing.length > 0) {
    return { key: "credentials", label, status: "error", detail: `Faltan: ${missing.map((a) => a[0]).join(", ")}.` };
  }
  if (legacy) {
    return { key: "credentials", label, status: "warn", detail: "Credenciales leídas de configurationJson (texto plano, legado): vuelva a guardarlas para cifrarlas." };
  }
  return { key: "credentials", label, status: "ok", detail: "Credenciales cifradas presentes." };
}
