// Modo «sincronizar» del asistente de importación (Tanda 7b · L4; diseño
// docs/design/OPERA-CLOUD-MODO-SOMBRA.md §6.3 y §10 nº 14). Helpers puros de
// ReservationImportScreen: la query `?modo=sync&perfil=opera_cloud&feed=…&fecha=…`
// que abre el panel «Modo sombra OPERA» (window.location.search: el admin-web no
// usa react-router), los campos que viajan en los cuerpos de preview y commit, el
// texto del aviso, la columna «Acción», los contadores del resumen y las líneas
// del bloque `sync` del resultado. Sin React, sin api-client, sin import.meta; solo
// `import type` de @hotelos/shared y lib/format para formatear.

import type {
  PmsShadowReservationFeed,
  ReservationImportMode,
  ReservationImportOptions,
  ReservationImportPreview,
  ReservationImportProfile,
  ReservationImportRowOutcome,
  ReservationImportSummary,
  ReservationImportSyncResult,
  ReservationSyncAction
} from "@hotelos/shared";
import type { CocoaTone } from "../../components/cocoa";
import { EMPTY, date, number, plural } from "../../lib/format";
import { feedLabel, isReservationFeed } from "../integrations/pms-shadow-helpers";
import { BRAND } from "../../config/brand";

// ---------------------------------------------------------------------------
// Query string
// ---------------------------------------------------------------------------

/** What `?modo=sync&perfil=opera_cloud&feed=<feed>&fecha=<YYYY-MM-DD>` resolves to; anything invalid falls back to `create`. */
export type SyncSearchParams = {
  mode: ReservationImportMode;
  profile?: ReservationImportProfile;
  feed?: PmsShadowReservationFeed;
  /** "YYYY-MM-DD" when the link carried a valid one; the screen fills today otherwise. */
  businessDate?: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CREATE: SyncSearchParams = Object.freeze({ mode: "create" }) as SyncSearchParams;

/** A real calendar day (`Date.parse` rolls «2026-02-30» over to March: the round trip through UTC catches it). */
function isIsoDate(value: string | null): value is string {
  if (!value || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Parses the search string of the wizard URL. `sync` needs the three literals
 * (`modo=sync`, `perfil=opera_cloud`, a reservation feed); `fecha` is optional
 * and dropped when it is not a real `YYYY-MM-DD`. Any other combination is the
 * plain `create` wizard of the Tanda 7 (no key of the sync travels).
 */
export function parseSyncSearchParams(search: string): SyncSearchParams {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search ?? "");
  } catch {
    return CREATE;
  }
  const mode = (params.get("modo") ?? "").trim();
  const profile = (params.get("perfil") ?? "").trim();
  const feed = (params.get("feed") ?? "").trim();
  if (mode !== "sync" || profile !== "opera_cloud" || !isReservationFeed(feed)) return CREATE;
  const fecha = (params.get("fecha") ?? "").trim();
  const out: SyncSearchParams = { mode: "sync", profile: "opera_cloud", feed };
  if (isIsoDate(fecha)) out.businessDate = fecha;
  return out;
}

export function isSyncMode(params: Pick<SyncSearchParams, "mode">): boolean {
  return params.mode === "sync";
}

const LOT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `?lote=<importId>`: the panel's «Ver lote» opens that lot in step 4 (read mode); null when absent or not an id. */
export function parseImportLotParam(search: string): string | null {
  try {
    const value = (new URLSearchParams(search ?? "").get("lote") ?? "").trim();
    return LOT_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** The four keys of the sync that go in BOTH bodies (preview and commit); `{}` in create mode so the Tanda 7 bodies do not change. */
export function syncRequestFields(params: SyncSearchParams, businessDate: string | null | undefined): Pick<ReservationImportOptions, "mode" | "profile" | "feed" | "businessDate"> | Record<never, never> {
  if (params.mode !== "sync" || !params.profile || !params.feed) return {};
  const out: Pick<ReservationImportOptions, "mode" | "profile" | "feed" | "businessDate"> = { mode: "sync", profile: params.profile, feed: params.feed };
  if (isIsoDate(businessDate ?? null)) out.businessDate = businessDate as string;
  return out;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const PROFILE_LABELS: Readonly<Record<ReservationImportProfile, string>> = Object.freeze({ opera_cloud: "OPERA Cloud" });

export function profileLabel(profile: ReservationImportProfile | string | null | undefined): string {
  if (!profile) return EMPTY;
  return (PROFILE_LABELS as Record<string, string>)[profile] ?? profile;
}

/** «Modo sincronizar: perfil OPERA Cloud · feed Llegadas · fecha de negocio 17/09/2026». */
export function syncCalloutText(params: SyncSearchParams, businessDate: string | null | undefined): string {
  const day = isIsoDate(businessDate ?? null) ? date(businessDate) : "sin fijar";
  return `Modo sincronizar: perfil ${profileLabel(params.profile)} · feed ${feedLabel(params.feed)} · fecha de negocio ${day}`;
}

export const SYNC_CALLOUT_HELP =
  "El fichero es un snapshot de OPERA: cada fila conocida por su nº de confirmación se actualiza o cambia de estado, las nuevas se crean y nada se borra (una reserva ausente del corte solo genera una alerta). El perfil resuelve las columnas por su cabecera literal, así que el paso «Columnas» se omite cuando todas quedan asignadas.";

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** The profile resolved every column (all `explicit`, nothing mandatory missing): the wizard jumps from «Fichero» to «Revisión». */
export function skipsMappingStep(preview: Pick<ReservationImportPreview, "header" | "mappingSource" | "missingRequired"> | null, params: Pick<SyncSearchParams, "mode">): boolean {
  if (!preview || params.mode !== "sync") return false;
  if (preview.missingRequired.length > 0) return false;
  if (preview.header.length === 0) return false;
  return preview.header.every((column) => preview.mappingSource[column] === "explicit");
}

// ---------------------------------------------------------------------------
// «Acción» column and summary counters
// ---------------------------------------------------------------------------

export const SYNC_ACTION_LABELS: Readonly<Record<ReservationSyncAction, string>> = Object.freeze({
  create: "Crear",
  update: "Actualizar",
  unchanged: "Sin cambios",
  transition: "Cambio de estado",
  skip: "Omitir"
});

export const SYNC_ACTION_TONES: Readonly<Record<ReservationSyncAction, CocoaTone>> = Object.freeze({
  create: "success",
  update: "info",
  unchanged: "neutral",
  transition: "warning",
  skip: "neutral"
});

export function syncActionLabel(action: ReservationSyncAction | string | null | undefined): string {
  if (!action) return EMPTY;
  return (SYNC_ACTION_LABELS as Record<string, string>)[action] ?? action;
}

export function syncActionTone(action: ReservationSyncAction | string | null | undefined): CocoaTone {
  if (!action) return "neutral";
  return (SYNC_ACTION_TONES as Record<string, CocoaTone>)[action] ?? "neutral";
}

/** «Actualizar · RES-00081 (arrivalDate, ratePlanId)» for the row tooltip: field names only, never values. */
export function syncActionTitle(sync: { action: ReservationSyncAction; reservationCode?: string; diff?: string[] } | null | undefined): string | undefined {
  if (!sync) return undefined;
  const parts = [syncActionLabel(sync.action)];
  if (sync.reservationCode) parts.push(sync.reservationCode);
  const label = parts.join(" · ");
  return sync.diff && sync.diff.length > 0 ? `${label} (${sync.diff.join(", ")})` : label;
}

export type SyncSummaryKpi = { key: "toUpdate" | "unchanged" | "toTransition"; label: string; value: string; tone?: CocoaTone; caption?: string };

/** The three sync counters that follow the six of the Tanda 7 in «Revisión». */
export function syncSummaryKpis(summary: Pick<ReservationImportSummary, "toUpdate" | "unchanged" | "toTransition">): SyncSummaryKpi[] {
  const toUpdate = summary.toUpdate ?? 0;
  const unchanged = summary.unchanged ?? 0;
  const toTransition = summary.toTransition ?? 0;
  return [
    { key: "toUpdate", label: "A actualizar", value: number(toUpdate), tone: toUpdate > 0 ? "info" : undefined, caption: "Con enlace y cambios" },
    { key: "unchanged", label: "Sin cambios", value: number(unchanged), caption: "Mismo contenido que el último corte" },
    { key: "toTransition", label: "Cambio de estado", value: number(toTransition), tone: toTransition > 0 ? "warning" : undefined, caption: "Cancelación, no-show, check-in o check-out" }
  ];
}

/** True when the snapshot has something to apply besides creations (the «no hay ninguna reserva que crear» blocker does not apply). */
export function hasSyncWork(summary: Pick<ReservationImportSummary, "toUpdate" | "unchanged" | "toTransition">): boolean {
  return (summary.toUpdate ?? 0) + (summary.unchanged ?? 0) + (summary.toTransition ?? 0) > 0;
}

/** Drops the create-only blocker of the Tanda 7 helpers when the sync snapshot only updates / confirms rows. */
export function syncBlockers(blockers: readonly string[], summary: Pick<ReservationImportSummary, "toUpdate" | "unchanged" | "toTransition"> | null | undefined): string[] {
  if (!summary || !hasSyncWork(summary)) return [...blockers];
  return blockers.filter((blocker) => blocker !== "no hay ninguna reserva que crear");
}

/** «Sincronizar 3 nuevas · 12 actualizadas» for the primary action of «Revisión» in sync mode. */
export function syncImportButtonLabel(summary: Pick<ReservationImportSummary, "toCreate" | "toUpdate" | "toTransition"> | null | undefined): string {
  if (!summary) return "Sincronizar";
  const parts: string[] = [];
  if (summary.toCreate > 0) parts.push(plural(summary.toCreate, "nueva", "nuevas"));
  if ((summary.toUpdate ?? 0) > 0) parts.push(plural(summary.toUpdate ?? 0, "actualizada", "actualizadas"));
  if ((summary.toTransition ?? 0) > 0) parts.push(plural(summary.toTransition ?? 0, "cambio de estado", "cambios de estado"));
  return parts.length > 0 ? `Sincronizar ${parts.join(" · ")}` : "Sincronizar";
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Outcomes the Tanda 7 result table does not know (updated / unchanged / transitioned); null for the classic ones. */
export const SYNC_ROW_OUTCOME_LABELS: Readonly<Partial<Record<ReservationImportRowOutcome, string>>> = Object.freeze({
  updated: "Actualizada",
  unchanged: "Sin cambios",
  transitioned: "Cambio de estado"
});

export const SYNC_ROW_OUTCOME_TONES: Readonly<Partial<Record<ReservationImportRowOutcome, CocoaTone>>> = Object.freeze({
  updated: "info",
  unchanged: "neutral",
  transitioned: "warning"
});

export function syncRowOutcomeLabel(outcome: ReservationImportRowOutcome | string): string | null {
  return (SYNC_ROW_OUTCOME_LABELS as Record<string, string | undefined>)[outcome] ?? null;
}

export function syncRowOutcomeTone(outcome: ReservationImportRowOutcome | string): CocoaTone | null {
  return (SYNC_ROW_OUTCOME_TONES as Record<string, CocoaTone | undefined>)[outcome] ?? null;
}

/** «Sincronizado el corte de Llegadas del 17/09/2026: 3 creadas · 12 actualizadas · 40 sin cambios · 2 con cambio de estado». */
export function syncResultTitle(sync: Pick<ReservationImportSyncResult, "feed" | "businessDate" | "counts">): string {
  const c = sync.counts;
  const parts = [`${number(c.created)} creadas`, `${number(c.updated)} actualizadas`, `${number(c.unchanged)} sin cambios`];
  if (c.transitioned > 0) parts.push(`${number(c.transitioned)} con cambio de estado`);
  if (c.skipped > 0) parts.push(`${number(c.skipped)} omitidas`);
  if (c.error > 0) parts.push(`${number(c.error)} con error`);
  return `Sincronizado el corte de ${feedLabel(sync.feed).toLowerCase()} del ${date(sync.businessDate)}: ${parts.join(" · ")}`;
}

function codesLabel(codes: readonly string[], max = 8): string {
  if (codes.length <= max) return codes.join(", ");
  return `${codes.slice(0, max).join(", ")} y ${number(codes.length - max)} más`;
}

/** Lines of the `sync` block of the result: absent reservations, local conflicts, check-ins without a room, unmapped OPERA codes (reservation codes and OPERA codes only, never guest data). */
export function syncResultLines(sync: Pick<ReservationImportSyncResult, "missing" | "conflicts" | "checkInWithoutRoom"> & Partial<Pick<ReservationImportSyncResult, "unmappedRateCodes" | "unmappedRoomTypes">> | null | undefined): string[] {
  if (!sync) return [];
  const lines: string[] = [];
  // SC-03: unmapped master codes (a run alert in the panel; here the wizard names them so the profile can be completed).
  if (sync.unmappedRateCodes && sync.unmappedRateCodes.length > 0) {
    lines.push(`${plural(sync.unmappedRateCodes.length, "rate code de OPERA sin mapear", "rate codes de OPERA sin mapear")} (tarifa por defecto aplicada): ${codesLabel(sync.unmappedRateCodes)}.`);
  }
  if (sync.unmappedRoomTypes && sync.unmappedRoomTypes.length > 0) {
    lines.push(`${plural(sync.unmappedRoomTypes.length, "room type de OPERA sin mapear", "room types de OPERA sin mapear")} (filas en error): ${codesLabel(sync.unmappedRoomTypes)}.`);
  }
  if (sync.missing.length > 0) {
    const streak = Math.max(...sync.missing.map((entry) => entry.missingStreak));
    lines.push(`${plural(sync.missing.length, "reserva ausente del corte", "reservas ausentes del corte")} (alerta, no se cancelan; hasta ${number(streak)} ${streak === 1 ? "corte seguido" : "cortes seguidos"}): ${codesLabel(sync.missing.map((entry) => entry.reservationCode))}.`);
  }
  if (sync.conflicts.length > 0) {
    lines.push(`${plural(sync.conflicts.length, `conflicto con una reserva creada en ${BRAND.name}`, `conflictos con reservas creadas en ${BRAND.name}`)} (filas omitidas): ${codesLabel(sync.conflicts.map((entry) => `fila ${number(entry.rowNumber)} · ${entry.reservationCode}`))}.`);
  }
  if (sync.checkInWithoutRoom.length > 0) {
    lines.push(`${plural(sync.checkInWithoutRoom.length, "check-in en OPERA sin habitación válida", "check-ins en OPERA sin habitación válida")} (permanecen confirmadas): ${codesLabel(sync.checkInWithoutRoom.map((entry) => entry.reservationCode))}.`);
  }
  return lines;
}
