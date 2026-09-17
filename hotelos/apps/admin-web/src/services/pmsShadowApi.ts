// OPERA Cloud · modo sombra (Tanda 7b · L4). Typed client of
// apps/api/src/modules/pms-shadow/pms-shadow.routes.ts on the contracts of
// packages/shared/src/pms-shadow-types.ts (design
// docs/design/OPERA-CLOUD-MODO-SOMBRA.md §6.5 and §6.6; runbook
// docs/runbooks/opera-modo-sombra.md). The 14 property routes (the public
// ingest by API key is not a browser call):
//
//   GET  /properties/:propertyId/pms-shadow/overview              fetchPmsShadowOverview         integrations.read
//   GET  /properties/:propertyId/pms-shadow/profile               fetchPmsShadowProfile          integrations.read
//   PUT  /properties/:propertyId/pms-shadow/profile               savePmsShadowProfile           integrations.connect
//   GET  /properties/:propertyId/pms-shadow/runs                  listPmsShadowRuns              integrations.read
//   POST /properties/:propertyId/pms-shadow/runs                  uploadPmsShadowRun (202)       integrations.connect
//   GET  /properties/:propertyId/pms-shadow/runs/:id              getPmsShadowRun                integrations.read
//   GET  /properties/:propertyId/pms-shadow/alerts                listPmsShadowAlerts            integrations.read
//   POST /properties/:propertyId/pms-shadow/alerts/:id/resolve    resolvePmsShadowAlert          integrations.connect
//   GET  /properties/:propertyId/pms-shadow/reconciliation        fetchPmsShadowReconciliation   accounting.read
//   POST /properties/:propertyId/pms-shadow/revenue/preview       previewPmsShadowRevenue        accounting.journal.post (never writes)
//   POST /properties/:propertyId/pms-shadow/revenue               importPmsShadowRevenue (201)   accounting.journal.post
//   GET  /properties/:propertyId/pms-shadow/revenue               listPmsShadowRevenueImports    accounting.read
//   GET  /properties/:propertyId/pms-shadow/revenue/:id           getPmsShadowRevenueImport      accounting.read
//   POST /properties/:propertyId/pms-shadow/revenue/:id/reverse   reversePmsShadowRevenue        accounting.journal.post
//
// Files ALWAYS travel as `contentBase64` (the API decides the encoding and the
// feed; the browser never decodes the bytes). Query strings mirror the zod
// schemas of schemas/pms-shadow.schemas.ts (`.strict()`): `open` is the literal
// "true" / "false" (an enum there, so it never goes through compactQuery's
// "1" / "0"). Errors arrive as details.code (PMS_SHADOW_* / OPERA_*) and are
// mapped by pmsShadowErrorMessage on top of finance-contracts; a 413 of Fastify
// (bodyLimit 8 MiB) reads as the «5 MB» sentence. Only `import type` from
// @hotelos/shared: the Spanish sentences per code are redeclared here, typed
// against the contract.

import type {
  IsoDate,
  PmsShadowAlertCode,
  PmsShadowAlertRecord,
  PmsShadowErrorCode,
  PmsShadowFeed,
  PmsShadowFeedStatus,
  PmsShadowOverview,
  PmsShadowProfileRecord,
  PmsShadowProfileStatus,
  PmsShadowPropertyMapping,
  PmsShadowReconciliationRow,
  PmsShadowRevenueImportRecord,
  PmsShadowRevenuePreview,
  PmsShadowRevenueSource,
  PmsShadowRevenueStatus,
  PmsShadowRunAlert,
  PmsShadowRunRecord,
  PmsShadowRunStatus,
  PmsShadowSchedule,
  PmsShadowTrxCodeMapping
} from "@hotelos/shared";
import { number } from "../lib/format";
import { getActivePropertyId } from "./activeProperty";
import { apiRequest } from "./api-client";
import { compactQuery, financeErrorCode, financeErrorDetails, financeErrorMessage, financeErrorStatus } from "./finance-contracts";

export type {
  PmsShadowAlertCode,
  PmsShadowAlertRecord,
  PmsShadowFeed,
  PmsShadowFeedStatus,
  PmsShadowOverview,
  PmsShadowProfileRecord,
  PmsShadowProfileStatus,
  PmsShadowPropertyMapping,
  PmsShadowReconciliationRow,
  PmsShadowRevenueImportRecord,
  PmsShadowRevenuePreview,
  PmsShadowRevenueSource,
  PmsShadowRevenueStatus,
  PmsShadowRunAlert,
  PmsShadowRunRecord,
  PmsShadowRunStatus,
  PmsShadowSchedule,
  PmsShadowTrxCodeMapping
} from "@hotelos/shared";

const enc = encodeURIComponent;

/** Base path of the property routes. */
export function pmsShadowPath(propertyId: string = getActivePropertyId()): string {
  return `/properties/${enc(propertyId)}/pms-shadow`;
}

// ---------------------------------------------------------------------------
// Wire shapes the shared contract does not name (query / body / composite answers)
// ---------------------------------------------------------------------------

/** `GET …/overview`: the KPIs plus, when a counter failed server-side, the `degraded[]` labels (lib/degraded.ts convention). */
export type PmsShadowOverviewResponse = PmsShadowOverview & { degraded?: string[] };

/** `PUT …/profile` (ProfileUpsertSchema): every key optional but the OPERA hotel code. */
export type PmsShadowProfileUpsertBody = {
  operaHotelCode: string;
  status?: PmsShadowProfileStatus;
  mappingJson?: PmsShadowPropertyMapping;
  trxMappingJson?: PmsShadowTrxCodeMapping[];
  scheduleJson?: PmsShadowSchedule;
  inboxEmail?: string | null;
  sftpFolder?: string | null;
};

/** `GET …/runs` (RunsQuerySchema): limit 1..200, 50 by default. */
export type PmsShadowRunsQuery = {
  feed?: PmsShadowFeed;
  status?: PmsShadowRunStatus;
  businessDate?: IsoDate;
  limit?: number;
};

/** Metrics OPERA declares alongside a stats / revenue file (DeclaredStatsSchema, camelCase keys of §5.4). */
export type PmsShadowDeclaredStats = Partial<
  Record<
    | "arrivalRooms"
    | "departureRooms"
    | "roomsOccupied"
    | "occupancyPct"
    | "noShowRooms"
    | "roomRevenue"
    | "totalRevenue"
    | "taxTotal"
    | "adr"
    | "revpar"
    | "transactionTotalToday"
    | "reservationsMadeToday"
    | "cancellationsMadeToday",
    string | number | null
  >
>;

/** Trial Balance / Manager Report figures of the same day for the revenue importer (RevenueReconciliationSchema). */
export type PmsShadowRevenueDeclared = {
  transactionTotalToday?: string | null;
  roomRevenue?: string | null;
  totalRevenue?: string | null;
};

/** `POST …/runs` (ManualRunSchema): the ingest body without propertyId. */
export type PmsShadowManualRunBody = {
  feed: PmsShadowFeed | "auto";
  businessDate?: IsoDate;
  fileName: string;
  contentBase64: string;
  force?: boolean;
  horizonDays?: number;
  declared?: PmsShadowDeclaredStats | null;
  reconciliation?: PmsShadowRevenueDeclared | null;
};

/** 202 of the manual upload: the run is already closed (done · partial · failed). */
export type PmsShadowManualRunResult = {
  runId: string;
  status: PmsShadowRunStatus;
  counts: { created: number; updated: number; unchanged: number; transitioned: number; skipped: number; error: number };
  alerts: PmsShadowRunAlert[];
  run: PmsShadowRunRecord;
};

/** `GET …/alerts` (AlertsQuerySchema): open by default is the API's choice when `open` is omitted. */
export type PmsShadowAlertsQuery = {
  open?: boolean;
  code?: PmsShadowAlertCode;
  businessDate?: IsoDate;
  limit?: number;
};

/** `GET …/reconciliation?businessDate=` (pms-shadow.service.ts PmsShadowReconciliation). */
export type PmsShadowReconciliation = {
  propertyId: string;
  businessDate: IsoDate;
  rows: PmsShadowReconciliationRow[];
  /** No `mismatch` row (the `missing` ones do not count: one side is absent). */
  ok: boolean;
  mismatches: { count: number; revenue: number };
  declared: Record<string, unknown>;
  computed: Record<string, unknown>;
  sources: { statsRunId: string | null; revenueImportId: string | null; revenueStatus: string | null };
  alerts: Array<{ code: PmsShadowAlertCode; alertId: string; created: boolean }>;
};

/** `POST …/revenue/preview` and `POST …/revenue` (RevenuePreviewSchema / RevenueImportSchema): the file as base64. */
export type PmsShadowRevenueFileBody = {
  source?: PmsShadowRevenueSource | "auto";
  fileName?: string;
  contentBase64: string;
  businessDate?: IsoDate | null;
  includePayments?: boolean;
  force?: boolean;
  mapping?: PmsShadowTrxCodeMapping[] | null;
  reconciliation?: PmsShadowRevenueDeclared | null;
  /** `replace`: reverse the posted lot of the day and post the new one in the same transaction. */
  replace?: boolean;
};

/** `GET …/revenue` (RevenueListQuerySchema): `businessDate` wins over `from` / `to`. */
export type PmsShadowRevenueListQuery = {
  businessDate?: IsoDate;
  from?: IsoDate;
  to?: IsoDate;
  status?: PmsShadowRevenueStatus;
  limit?: number;
};

/** `POST …/revenue/:id/reverse` (RevenueReverseSchema). */
export type PmsShadowRevenueReverseBody = {
  reason: string;
  entryDate?: IsoDate | null;
};

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** KPIs (último corte, reservas enlazadas, alertas abiertas, último día conciliado) and the feed table. */
export function fetchPmsShadowOverview(propertyId: string = getActivePropertyId()): Promise<PmsShadowOverviewResponse> {
  return apiRequest<PmsShadowOverviewResponse>(`${pmsShadowPath(propertyId)}/overview`);
}

/** Mapping profile of the property (404 PMS_SHADOW_PROFILE_NOT_FOUND before the first save). */
export function fetchPmsShadowProfile(propertyId: string = getActivePropertyId()): Promise<PmsShadowProfileRecord> {
  return apiRequest<PmsShadowProfileRecord>(`${pmsShadowPath(propertyId)}/profile`);
}

/** Creates or updates the profile (integrations.connect). */
export function savePmsShadowProfile(body: PmsShadowProfileUpsertBody, propertyId: string = getActivePropertyId()): Promise<PmsShadowProfileRecord> {
  return apiRequest<PmsShadowProfileRecord>(`${pmsShadowPath(propertyId)}/profile`, { method: "PUT", body });
}

/** Runs of the property, newest first; filters by feed / status / business date. */
export function listPmsShadowRuns(query: PmsShadowRunsQuery = {}, propertyId: string = getActivePropertyId()): Promise<PmsShadowRunRecord[]> {
  return apiRequest<PmsShadowRunRecord[]>(`${pmsShadowPath(propertyId)}/runs`, { query: compactQuery({ feed: query.feed, status: query.status, businessDate: query.businessDate, limit: query.limit }) });
}

/** One run (opaque 404 outside the property or the organisation). */
export function getPmsShadowRun(runId: string, propertyId: string = getActivePropertyId()): Promise<PmsShadowRunRecord> {
  return apiRequest<PmsShadowRunRecord>(`${pmsShadowPath(propertyId)}/runs/${enc(runId)}`);
}

/** Manual upload of a file (revenue / stats / profiles, or a reservation feed): 202 with the run already closed. 409 PMS_SHADOW_RUN_DUPLICATE without `force`. */
export function uploadPmsShadowRun(body: PmsShadowManualRunBody, propertyId: string = getActivePropertyId()): Promise<PmsShadowManualRunResult> {
  return apiRequest<PmsShadowManualRunResult>(`${pmsShadowPath(propertyId)}/runs`, { method: "POST", body });
}

/** Alerts of the property (open ones by default on the API side); `open` travels as the literal "true" / "false". */
export function listPmsShadowAlerts(query: PmsShadowAlertsQuery = {}, propertyId: string = getActivePropertyId()): Promise<PmsShadowAlertRecord[]> {
  return apiRequest<PmsShadowAlertRecord[]>(`${pmsShadowPath(propertyId)}/alerts`, {
    query: compactQuery({ open: query.open === undefined ? undefined : query.open ? "true" : "false", code: query.code, businessDate: query.businessDate, limit: query.limit })
  });
}

/** Resolves an alert with a mandatory note (audited). 409 PMS_SHADOW_ALERT_ALREADY_RESOLVED. */
export function resolvePmsShadowAlert(alertId: string, note: string, propertyId: string = getActivePropertyId()): Promise<PmsShadowAlertRecord> {
  return apiRequest<PmsShadowAlertRecord>(`${pmsShadowPath(propertyId)}/alerts/${enc(alertId)}/resolve`, { method: "POST", body: { note } });
}

/** Reconciliation of one business date: declared by OPERA vs computed by Anfitorio, row per metric. */
export function fetchPmsShadowReconciliation(businessDate: IsoDate, propertyId: string = getActivePropertyId()): Promise<PmsShadowReconciliation> {
  return apiRequest<PmsShadowReconciliation>(`${pmsShadowPath(propertyId)}/reconciliation`, { query: { businessDate } });
}

/** Parses the revenue file and resolves the transaction codes without writing anything. */
export function previewPmsShadowRevenue(body: PmsShadowRevenueFileBody, propertyId: string = getActivePropertyId()): Promise<PmsShadowRevenuePreview> {
  return apiRequest<PmsShadowRevenuePreview>(`${pmsShadowPath(propertyId)}/revenue/preview`, { method: "POST", body });
}

/** Posts the daily revenue entry (201). 400 OPERA_TRX_CODE_UNMAPPED · 409 PMS_SHADOW_REVENUE_ALREADY_POSTED without `replace`. */
export function importPmsShadowRevenue(body: PmsShadowRevenueFileBody, propertyId: string = getActivePropertyId()): Promise<PmsShadowRevenueImportRecord> {
  return apiRequest<PmsShadowRevenueImportRecord>(`${pmsShadowPath(propertyId)}/revenue`, { method: "POST", body });
}

/** Revenue lots of the property (posted / reversed / draft), newest first. */
export function listPmsShadowRevenueImports(query: PmsShadowRevenueListQuery = {}, propertyId: string = getActivePropertyId()): Promise<PmsShadowRevenueImportRecord[]> {
  return apiRequest<PmsShadowRevenueImportRecord[]>(`${pmsShadowPath(propertyId)}/revenue`, {
    query: compactQuery({ businessDate: query.businessDate, from: query.from, to: query.to, status: query.status, limit: query.limit })
  });
}

/** One revenue lot with its lines and journal entry ids. */
export function getPmsShadowRevenueImport(importId: string, propertyId: string = getActivePropertyId()): Promise<PmsShadowRevenueImportRecord> {
  return apiRequest<PmsShadowRevenueImportRecord>(`${pmsShadowPath(propertyId)}/revenue/${enc(importId)}`);
}

/** Reverses a posted lot with a mandatory reason (critical: a reversal entry). 409 PMS_SHADOW_REVENUE_NOT_POSTED. */
export function reversePmsShadowRevenue(importId: string, body: PmsShadowRevenueReverseBody, propertyId: string = getActivePropertyId()): Promise<PmsShadowRevenueImportRecord> {
  return apiRequest<PmsShadowRevenueImportRecord>(`${pmsShadowPath(propertyId)}/revenue/${enc(importId)}/reverse`, { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Errors (details.code → Spanish; mirror of PMS_SHADOW_ERROR_LABELS_ES)
// ---------------------------------------------------------------------------

export const PMS_SHADOW_ERROR_MESSAGES: Readonly<Record<PmsShadowErrorCode, string>> = Object.freeze({
  VALIDATION_ERROR: "La petición no es válida.",
  PMS_SHADOW_PROFILE_NOT_FOUND: "Esta propiedad no tiene configurado el modo sombra.",
  PMS_SHADOW_PROFILE_PAUSED: "El modo sombra de esta propiedad está en pausa: reactívalo para recibir cortes.",
  PMS_SHADOW_FEED_UNKNOWN: "No se reconoce el tipo de corte del fichero: indícalo o revisa la cabecera.",
  PMS_SHADOW_FILE_UNREADABLE: "No se ha podido leer el fichero recibido.",
  PMS_SHADOW_FILE_TOO_LARGE: "El fichero supera el tamaño admitido (5 MB).",
  PMS_SHADOW_RUN_DUPLICATE: "Este fichero ya se recibió para ese corte y ese día.",
  PMS_SHADOW_RUN_NOT_FOUND: "Corte no encontrado.",
  PMS_SHADOW_ALERT_NOT_FOUND: "Alerta no encontrada.",
  PMS_SHADOW_ALERT_ALREADY_RESOLVED: "La alerta ya estaba resuelta.",
  PMS_SHADOW_INGEST_UNAUTHORIZED: "Clave de API no válida o sin permiso para enviar cortes a esta propiedad.",
  OPERA_TRX_CODE_UNMAPPED: "Hay transaction codes sin mapear: complétalos en el perfil antes de contabilizar el día.",
  PMS_SHADOW_REVENUE_EMPTY: "El fichero de ingresos no contiene ninguna línea.",
  PMS_SHADOW_REVENUE_DUPLICATE: "Este fichero de ingresos ya se importó: revierte el lote anterior o usa «sustituir».",
  PMS_SHADOW_REVENUE_ALREADY_POSTED: "Los ingresos de ese día ya están contabilizados: usa «sustituir» (reverso + nuevo).",
  PMS_SHADOW_REVENUE_NOT_FOUND: "Lote de ingresos no encontrado.",
  PMS_SHADOW_REVENUE_NOT_POSTED: "El lote de ingresos no está contabilizado: no hay nada que revertir.",
  PMS_SHADOW_REVENUE_DAY_MISMATCH: "El fichero corresponde a otro día distinto del indicado.",
  PMS_SHADOW_REVENUE_HOTEL_MISMATCH: "El código de hotel del fichero no es el de esta propiedad.",
  PMS_SHADOW_REVENUE_ENTRY_EXISTS: "Ya existe un asiento de ingresos de OPERA para ese día.",
  FISCAL_YEAR_CLOSED: "El ejercicio está cerrado: no se puede contabilizar ni revertir en él.",
  FISCAL_PERIOD_CLOSED: "El periodo contable está cerrado.",
  WORK_CENTER_REQUIRED: "Las líneas de ingreso exigen un centro de trabajo."
});

const DEFAULT_SHADOW_ERROR = "No se pudo completar la operación del modo sombra.";

function isShadowErrorCode(code: string | null): code is PmsShadowErrorCode {
  return code !== null && Object.prototype.hasOwnProperty.call(PMS_SHADOW_ERROR_MESSAGES, code);
}

function detailString(details: Record<string, unknown> | null, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function detailCodes(details: Record<string, unknown> | null): string[] {
  const value = details?.codes;
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry : typeof entry === "object" && entry !== null ? (entry as { code?: unknown }).code : null))
    .filter((code): code is string => typeof code === "string" && code.trim() !== "");
}

/** Whether the error carries the given `details.code` (a 409 duplicate the caller can retry with `force`, a 404 profile the panel can create). */
export function hasPmsShadowErrorCode(error: unknown, code: PmsShadowErrorCode): boolean {
  return financeErrorCode(error) === code;
}

/**
 * Spanish message of a shadow-mode error: the sentence of `details.code` plus
 * the datum the code carries — the unmapped transaction codes, the two dates
 * of a day mismatch, the two hotel codes, the run of a duplicate — and the
 * 413 of the body limit as the «5 MB» sentence. Anything else falls back to
 * finance-contracts (API message, then `fallback`).
 */
export function pmsShadowErrorMessage(error: unknown, fallback: string = DEFAULT_SHADOW_ERROR): string {
  if (financeErrorStatus(error) === 413) return PMS_SHADOW_ERROR_MESSAGES.PMS_SHADOW_FILE_TOO_LARGE;
  const code = financeErrorCode(error);
  const details = financeErrorDetails(error);
  const base = isShadowErrorCode(code) ? PMS_SHADOW_ERROR_MESSAGES[code] : financeErrorMessage(error, fallback);
  switch (code) {
    case "OPERA_TRX_CODE_UNMAPPED": {
      const codes = detailCodes(details);
      return codes.length > 0 ? `Transaction codes sin mapear (${number(codes.length)}): ${codes.join(", ")}. Complétalos en el perfil antes de contabilizar el día.` : base;
    }
    case "PMS_SHADOW_REVENUE_DAY_MISMATCH": {
      const fileDate = detailString(details, "fileDate");
      const businessDate = detailString(details, "businessDate");
      return fileDate && businessDate ? `El fichero es del día ${fileDate} y se indicó ${businessDate}: corrige la fecha de negocio.` : base;
    }
    case "PMS_SHADOW_REVENUE_HOTEL_MISMATCH": {
      const fileHotel = detailString(details, "fileHotelCode");
      const profileHotel = detailString(details, "profileHotelCode");
      return fileHotel && profileHotel ? `El fichero es del hotel «${fileHotel}» y el perfil de esta propiedad es «${profileHotel}».` : base;
    }
    case "PMS_SHADOW_RUN_DUPLICATE": {
      const runId = detailString(details, "runId");
      return runId ? `${base} Corte ${runId}. Activa «Subir de todos modos» para registrarlo otra vez.` : base;
    }
    case "PMS_SHADOW_FEED_UNKNOWN": {
      const feed = detailString(details, "feed");
      return feed ? `No se reconoce el tipo de corte «${feed}»: indícalo o revisa la cabecera del fichero.` : base;
    }
    default:
      return base;
  }
}
