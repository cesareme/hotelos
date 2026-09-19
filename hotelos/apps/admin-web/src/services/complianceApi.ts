// Frontend client for the Compliance Center.
import { ApiError, apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";
import { toArray } from "../utils/toArray";

export type ComplianceStatus =
  | "COMPLIANT" | "NON_COMPLIANT" | "PENDING" | "EXPIRED" | "EXPIRING_SOON" | "NOT_APPLICABLE" | "UNDER_REVIEW";

export type ComplianceControl = {
  code: string;
  title: string;
  areaCode: string;
  areaName: string;
  riskLevel: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  jurisdiction: string;
  autonomousCommunity?: string | null;
  hotelTypes?: string[];
  legalReference?: string | null;
  appliesWhen?: string | null;
  requiredDocuments: string[];
  documentsCount: number;
  applies: boolean;
  status: ComplianceStatus;
  responsibleName?: string | null;
  externalAdvisorName?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  lastReviewDate?: string | null;
  nextReviewDate?: string | null;
  notes?: string | null;
  correctiveAction?: string | null;
  notApplicableReason?: string | null;
};

export type ComplianceAreaSummary = {
  code: string; name: string; total: number; compliant: number; pending: number; expiringSoon: number; expired: number; nonCompliant: number; critical: number;
};

export type ComplianceKpis = {
  total: number; applicable: number; compliant: number; nonCompliant: number; expired: number; expiringSoon: number; pending: number; underReview: number; notApplicable: number; criticalOpen: number; compliancePct: number;
};

export type ComplianceProfile = {
  propertyId: string;
  autonomousCommunity?: string | null;
  hotelType?: string | null;
  hasRestaurant: boolean; hasKitchen: boolean; hasPool: boolean; hasSpa: boolean;
  hasParking: boolean; hasEvents: boolean; hasTerrace: boolean; hasLaundry: boolean;
  buildingProtected: boolean; expiringSoonDays: number;
};

export type ComplianceCenter = {
  propertyId: string;
  asOf: string;
  profile: ComplianceProfile | null;
  kpis: ComplianceKpis;
  areas: ComplianceAreaSummary[];
  controls: ComplianceControl[];
};

export type ComplianceTask = {
  id: string; propertyId: string; requirementCode?: string | null; title: string; description?: string | null;
  assignedToName?: string | null; status: string; priority: string; dueDate?: string | null; completedAt?: string | null; createdAt: string;
};

export type ComplianceDocument = {
  id: string; propertyId: string; requirementCode?: string | null; areaCode?: string | null;
  title: string; documentType?: string | null; fileName: string; mimeType?: string | null; fileSize: number;
  issueDate?: string | null; expiryDate?: string | null; issuingAuthority?: string | null; providerName?: string | null;
  isCurrent: boolean; uploadedAt: string; tags: string[]; notes?: string | null;
};

export type ComplianceAlertKind = "EXPIRED" | "EXPIRING_SOON" | "NON_COMPLIANT" | "MISSING_DOCUMENT" | "TASK_OVERDUE";
export type ComplianceAlertSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type ComplianceAlert = {
  id: string; kind: ComplianceAlertKind; severity: ComplianceAlertSeverity;
  requirementCode?: string | null; areaCode?: string | null; areaName?: string | null;
  title: string; detail: string; dueDate?: string | null; daysOverdue?: number | null;
};
export type ComplianceAlertsResponse = {
  propertyId: string; asOf: string; count: number;
  byKind: Record<string, number>; bySeverity: Record<string, number>; alerts: ComplianceAlert[];
};

export function fetchComplianceCenter(propertyId = getActivePropertyId()) {
  return apiRequest<ComplianceCenter>(`/compliance/properties/${propertyId}/center`);
}
export function updateComplianceItem(requirementCode: string, patch: Record<string, unknown>, propertyId = getActivePropertyId()) {
  return apiRequest(`/compliance/properties/${propertyId}/items/${requirementCode}`, { method: "PATCH", body: patch });
}
export function updateComplianceProfile(patch: Partial<Omit<ComplianceProfile, "propertyId">>, propertyId = getActivePropertyId()) {
  return apiRequest<ComplianceProfile>(`/compliance/properties/${propertyId}/profile`, { method: "PATCH", body: patch });
}
export function fetchComplianceTasks(propertyId = getActivePropertyId()) {
  return apiRequest<ComplianceTask[]>(`/compliance/properties/${propertyId}/tasks`);
}
export function createComplianceTask(payload: { requirementCode?: string; title: string; priority?: string; dueDate?: string; assignedToName?: string }, propertyId = getActivePropertyId()) {
  return apiRequest<ComplianceTask>(`/compliance/properties/${propertyId}/tasks`, { method: "POST", body: payload });
}
export function updateComplianceTask(id: string, patch: { status?: string; priority?: string }) {
  return apiRequest<ComplianceTask>(`/compliance/tasks/${id}`, { method: "PATCH", body: patch });
}
export function deleteComplianceTask(id: string) {
  return apiRequest<{ ok: boolean; id: string }>(`/compliance/tasks/${id}`, { method: "DELETE" });
}

export async function fetchComplianceDocuments(requirementCode?: string, propertyId = getActivePropertyId()) {
  const qs = requirementCode ? `?requirementCode=${encodeURIComponent(requirementCode)}` : "";
  const res = await apiRequest<{ items: ComplianceDocument[] }>(`/compliance/properties/${propertyId}/documents${qs}`);
  return res.items;
}
export function createComplianceDocument(payload: {
  requirementCode?: string; areaCode?: string; title: string; documentType?: string;
  fileName?: string; mimeType?: string; fileSize?: number; issueDate?: string; expiryDate?: string;
  issuingAuthority?: string; providerName?: string; notes?: string; tags?: string[]; syncControl?: boolean;
}, propertyId = getActivePropertyId()) {
  return apiRequest<ComplianceDocument>(`/compliance/properties/${propertyId}/documents`, { method: "POST", body: payload });
}
export function deleteComplianceDocument(id: string) {
  return apiRequest<{ ok: boolean; id: string }>(`/compliance/documents/${id}`, { method: "DELETE" });
}
export function fetchComplianceAlerts(propertyId = getActivePropertyId()) {
  return apiRequest<ComplianceAlertsResponse>(`/compliance/properties/${propertyId}/alerts`);
}

export type InspectionFolder = {
  filename: string;
  generatedAt: string;
  summary: { applicable: number; compliancePct: number; expired: number; criticalOpen: number; documents: number; openAlerts: number };
  html: string;
};
export function fetchInspectionFolder(preparedBy?: string, propertyId = getActivePropertyId()) {
  const qs = preparedBy ? `?preparedBy=${encodeURIComponent(preparedBy)}` : "";
  return apiRequest<InspectionFolder>(`/compliance/properties/${propertyId}/inspection-folder${qs}`);
}

export type ComplianceSuggestion = {
  id: string;
  kind: "MISSING_DOCUMENT" | "RENEW" | "CORRECT" | "REVIEW";
  priority: "HIGH" | "MEDIUM" | "LOW";
  requirementCode: string;
  controlTitle: string;
  areaName: string;
  action: string;
  taskTitle: string;
  taskPriority: "HIGH" | "MEDIUM" | "LOW";
};
export type ComplianceAssistant = {
  propertyId: string;
  generatedAt: string;
  provider: string;
  narrativeSource: "ai" | "rules";
  narrative: string;
  count: number;
  byPriority: Record<string, number>;
  suggestions: ComplianceSuggestion[];
};
export function fetchComplianceAssistant(propertyId = getActivePropertyId()) {
  return apiRequest<ComplianceAssistant>(`/compliance/properties/${propertyId}/assistant`);
}

export type OcrDatesResult = {
  aiGenerated: boolean;
  provider: string;
  reason?: string;
  fields: { documentType?: string; issuingAuthority?: string; issueDate?: string; expiryDate?: string };
};
export function extractDocumentDates(imageDataUrl: string) {
  return apiRequest<OcrDatesResult>(`/compliance/ocr/extract-dates`, { method: "POST", body: { imageDataUrl } });
}

// ---------------------------------------------------------------------------
// Tanda 3 · lote front-fiscal: compliance settings, compliance health, SES
// establishment and the SES submission history (paginated).

/**
 * GET/PATCH /backoffice/properties/:propertyId/compliance-settings.
 * The Tanda 3 fields (postalCode, ineMunicipalityCode, fiscalTerritory,
 * sesRegistryNumber, touristTaxTreatment, ipsiOrdinanceConfirmedAt) are
 * optional: hotels answered by the pre-Tanda-3 service simply omit them.
 */
export type ComplianceSettings = {
  id: string;
  propertyId: string;
  country: string;
  taxRegion?: string | null;
  vatRegime?: string | null;
  tourismTaxRegion?: string | null;
  sesHospedajesEnabled: boolean;
  verifactuEnabled: boolean;
  ticketbaiEnabled: boolean;
  siiEnabled: boolean;
  b2bEinvoiceEnabled: boolean;
  configurationJson: Record<string, unknown>;
  updatedAt: string;
  provisioned?: boolean;
  // Tanda 3 (Property.postalCode / ineMunicipalityCode / fiscalTerritory and
  // PropertyComplianceSetting.sesRegistryNumber / touristTaxTreatment /
  // ipsiOrdinanceConfirmedAt), surfaced by the settings endpoint.
  postalCode?: string | null;
  ineMunicipalityCode?: string | null;
  fiscalTerritory?: string | null;
  sesRegistryNumber?: string | null;
  touristTaxTreatment?: "included_10" | "not_subject" | "none" | null;
  ipsiOrdinanceConfirmedAt?: string | null;
};

/**
 * PATCH body. Null semantics of the fiscal text fields (postalCode,
 * ineMunicipalityCode, sesRegistryNumber): an explicit `null` CLEARS the
 * stored value, `undefined` (key omitted) keeps it, and "" is never sent —
 * the screens turn an emptied input into `null` so the deletion is explicit
 * and the following GET answers `null` for that field.
 */
export type ComplianceSettingsPatch = Partial<
  Pick<
    ComplianceSettings,
    | "country"
    | "taxRegion"
    | "vatRegime"
    | "tourismTaxRegion"
    | "sesHospedajesEnabled"
    | "verifactuEnabled"
    | "ticketbaiEnabled"
    | "siiEnabled"
    | "b2bEinvoiceEnabled"
    | "configurationJson"
    | "postalCode"
    | "ineMunicipalityCode"
    | "fiscalTerritory"
    | "sesRegistryNumber"
    | "touristTaxTreatment"
  >
> & {
  /** true stamps ipsiOrdinanceConfirmedAt = now, false clears it. */
  ipsiOrdinanceConfirmed?: boolean;
};

export function fetchComplianceSettings(propertyId = getActivePropertyId()) {
  return apiRequest<ComplianceSettings>(`/backoffice/properties/${propertyId}/compliance-settings`);
}

export function patchComplianceSettings(propertyId: string, patch: ComplianceSettingsPatch) {
  return apiRequest<ComplianceSettings>(`/backoffice/properties/${propertyId}/compliance-settings`, { method: "PATCH", body: patch });
}

/** GET /compliance/health (apps/api/src/modules/compliance/compliance-health.service.ts). */
export type ComplianceIntegrationHealth = {
  integration: "verifactu" | "ses_hospedajes" | "tbai" | "igic" | string;
  enabled: boolean;
  mode: "sandbox" | "preproduction" | "production";
  readyForReal: boolean;
  cert: { configured: false; reason: string } | { configured: true; certPathExists: boolean };
  endpoint: string;
  notes?: string;
  /** VeriFactu SistemaInformatico block (contract E · resolveVerifactuSoftware), when the health endpoint exposes it. */
  software?: { ok: boolean; errors: string[] };
};

export type ComplianceHealthReport = {
  generatedAt: string;
  overall: "sandbox_only" | "mixed" | "production_ready";
  integrations: ComplianceIntegrationHealth[];
  stats: {
    verifactuSubmissionsLast24h: number | null;
    sesSubmissionsLast24h: number | null;
    tbaiSubmissionsLast24h: number | null;
    verifactuRejectedLast24h: number | null;
    sesRejectedLast24h: number | null;
  };
  degraded: string[];
  /** Top-level variant of the VeriFactu software block (either location is accepted by the UI). */
  verifactuSoftware?: { ok: boolean; errors: string[] };
};

export function fetchComplianceHealth() {
  return apiRequest<ComplianceHealthReport>(`/compliance/health`);
}

/** VeriFactu software readiness wherever the health report carries it; null when the API does not expose it yet. */
export function verifactuSoftwareStatus(health: ComplianceHealthReport | null | undefined): { ok: boolean; errors: string[] } | null {
  if (!health) return null;
  if (health.verifactuSoftware) return health.verifactuSoftware;
  const verifactu = health.integrations?.find((integration) => integration.integration === "verifactu");
  return verifactu?.software ?? null;
}

/** GET /properties/:propertyId/ses/establishment (contract F · resolveSesEstablishment). */
export type SesEstablishment = {
  ok: boolean;
  missing: string[];
  establishment: {
    registryNumber: string | null;
    taxId: string | null;
    legalName: string | null;
    address: string | null;
    municipality: string | null;
    municipalityCode: string | null;
    province: string | null;
    postalCode: string | null;
    country: string;
  };
};

export function fetchSesEstablishment(propertyId = getActivePropertyId()) {
  return apiRequest<SesEstablishment>(`/properties/${propertyId}/ses/establishment`);
}

/** Row of GET /properties/:propertyId/ses/submissions (SesHospedajesSubmission). */
export type SesSubmissionRow = {
  id: string;
  guestRegisterRecordId?: string | null;
  reservationId?: string | null;
  externalReference?: string | null;
  submissionType?: string | null;
  status: string;
  endpoint?: string | null;
  acknowledgementCode?: string | null;
  trackingNumber?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  /** Establishment fields that blocked the communication (SES_ESTABLISHMENT_INCOMPLETE). */
  missing?: string[];
  attempts?: number;
  submittedAt?: string | null;
  acknowledgedAt?: string | null;
  nextRetryAt?: string | null;
  createdAt?: string | null;
};

export type SesSubmissionsPage = { items: SesSubmissionRow[]; nextCursor: string | null; total: number };

// ---------------------------------------------------------------------------
// Check-in parte: POST /properties/:propertyId/ses/submissions
// (apps/api/src/server.ts · Tanda 3 cierre)
//
// 2xx: { status: "queued" | "partial", queued, submissions[], failed[] }.
//   `queued` counts the partes actually queued; `failed[]` lists the partes the
//   pipeline could not queue ({ guestRegisterRecordId, code, message, missing[],
//   submissionId }). A total failure is NEVER a 200:
// 409 SES_NO_GUEST_REGISTER_RECORDS → the reservation has no partes to send.
// 409 with details.code = SES_ESTABLISHMENT_INCOMPLETE / ISSUER_TAX_ID_MISSING
//   (every parte failed for the same cause) → details.missing[] names the
//   establishment fields; details also carries the summary
//   { status: "failed", queued: 0, submissions: [], failed[] }.
// 409 SES_QUEUE_FAILED → mixed causes, details.failed[] per parte.
// The UI only claims "encolado" when queued > 0 and failed is empty.

export type SesQueueFailure = {
  guestRegisterRecordId?: string | null;
  code?: string | null;
  message?: string | null;
  missing?: string[];
  /** The `failed` SesHospedajesSubmission row left for a recoverable cause (retry after fixing), when any. */
  submissionId?: string | null;
};

export type SesQueueResponse = {
  status: "queued" | "no_records" | "partial" | "failed" | string;
  queued: number;
  submissions: SesSubmissionRow[];
  /** Absent on the pre-cierre API (failed rows then travel inside `submissions` with status "failed"). */
  failed?: SesQueueFailure[];
};

/** 409 code of the queue route when the reservation has no partes de viajeros. */
export const SES_NO_GUEST_REGISTER_RECORDS_CODE = "SES_NO_GUEST_REGISTER_RECORDS";
/** 409 code of the queue route when the partes failed for mixed causes (details.failed[]). */
export const SES_QUEUE_FAILED_CODE = "SES_QUEUE_FAILED";

export function queueSesSubmissions(propertyId: string, reservationId: string): Promise<SesQueueResponse> {
  return apiRequest<SesQueueResponse>(`/properties/${propertyId}/ses/submissions`, { method: "POST", body: { reservationId } });
}

/** Error codes the API uses when the establishment block cannot be produced. */
export const SES_ESTABLISHMENT_ERROR_CODES: readonly string[] = ["SES_ESTABLISHMENT_INCOMPLETE", "ISSUER_TAX_ID_MISSING"];

/** Spanish labels of the `missing[]` keys (packages/compliance SesEstablishmentIssue). */
const SES_ESTABLISHMENT_ISSUE_LABELS: Record<string, string> = {
  registryNumber: "número de registro SES.HOSPEDAJES",
  taxId: "NIF de la organización",
  legalName: "razón social del titular",
  address: "dirección del establecimiento",
  municipality: "municipio",
  municipalityCode: "código INE de municipio",
  "municipalityCode.format": "código INE de municipio (5 dígitos, provincia 01–52)",
  province: "provincia",
  postalCode: "código postal",
  "postalCode.format": "código postal (5 dígitos, provincia 01–52)",
  "postalCode.provinceMismatch": "código postal e INE de provincias distintas",
  country: "país"
};

export function sesEstablishmentIssueLabel(issue: string): string {
  return SES_ESTABLISHMENT_ISSUE_LABELS[issue] ?? issue;
}

// Tanda L5 (L5-B2): the pipeline refuses WITHOUT creating a row when the
// property has SES switched off or the parte does not validate over its
// persisted columns; both travel as typed 409 codes (details.submissionId null).
/** 409 code when Property.sesHospedajesEnabled is false: nothing queued, no row. */
export const SES_DISABLED_CODE = "SES_DISABLED";
/** 409 code when the parte fails validateSpainGuestRegisterRecord: nothing queued, no row. */
export const GUEST_REGISTER_INVALID_CODE = "GUEST_REGISTER_INVALID";

export type SesQueueOutcome =
  | { kind: "queued"; queued: number }
  | { kind: "no_records" }
  | { kind: "partial"; queued: number; failed: SesQueueFailure[]; missing: string[] }
  | { kind: "incomplete"; missing: string[]; message: string; failed: SesQueueFailure[] }
  /** SES.HOSPEDAJES is switched off for the property (SES_DISABLED). */
  | { kind: "disabled"; message: string; failed: SesQueueFailure[] }
  /** The parte is incomplete (GUEST_REGISTER_INVALID): `issues` are the validator codes, labelled by guestRegisterIssueLabel. */
  | { kind: "invalid"; message: string; issues: string[]; failed: SesQueueFailure[] }
  | { kind: "error"; message: string; code: string | null; failed: SesQueueFailure[] };

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.length > 0)));
}

/** Spanish labels of the validator issue codes (packages/compliance guest-register-validator). */
const GUEST_REGISTER_ISSUE_LABELS: Record<string, string> = {
  missing_firstName: "nombre",
  missing_surname1: "primer apellido",
  missing_sex: "sexo",
  missing_nationality: "nacionalidad",
  missing_dateOfBirth: "fecha de nacimiento",
  missing_documentType: "tipo de documento",
  missing_documentNumber: "número de documento",
  missing_documentSupportNumber: "número de soporte del documento",
  missing_residenceFullAddress: "dirección de residencia",
  missing_residenceLocality: "localidad de residencia",
  missing_residenceCountry: "país de residencia",
  missing_phone_contact: "teléfono de contacto",
  missing_travellerCount: "número de viajeros",
  missing_contractReference: "referencia del contrato",
  missing_checkinAt: "fecha de entrada",
  missing_providedByAdultGuestId: "adulto responsable del menor",
  missing_kinshipRelationIfMinor: "parentesco del menor",
  signature_required: "firma del viajero",
  id_image_stored_blocked: "imagen del documento almacenada (no permitida)",
  id_image_discard_event_missing: "descarte de la imagen del documento",
  cvv_storage_blocked: "CVV almacenado (no permitido)",
  pan_storage_blocked: "PAN almacenado (no permitido)"
};

export function guestRegisterIssueLabel(code: string): string {
  return GUEST_REGISTER_ISSUE_LABELS[code] ?? code;
}

/**
 * Validator codes of a GUEST_REGISTER_INVALID refusal. The route only forwards
 * the per-parte message («El parte de viajeros no se puede enviar: a, b.»), so
 * the codes are read back from it; a message without the marker yields [].
 */
export function sesInvalidIssuesFromMessages(messages: string[]): string[] {
  const codes: string[] = [];
  for (const message of messages) {
    const match = /no se puede enviar:\s*(.+?)\.?$/.exec(message);
    if (!match) continue;
    for (const code of match[1].split(",")) {
      const trimmed = code.trim();
      if (/^[a-z_]+$/i.test(trimmed)) codes.push(trimmed);
    }
  }
  return uniqueStrings(codes);
}

/** "disabled" / "invalid" outcome for the two Tanda L5 refusal codes; null for any other code. */
function sesRefusalOutcome(code: string | null, message: string, failed: SesQueueFailure[]): SesQueueOutcome | null {
  if (code === SES_DISABLED_CODE) return { kind: "disabled", message, failed };
  if (code === GUEST_REGISTER_INVALID_CODE) {
    return { kind: "invalid", message, issues: sesInvalidIssuesFromMessages([message, ...sesFailureMessages(failed)]), failed };
  }
  return null;
}

/** Establishment fields collected from every failed parte (deduplicated, order kept). */
export function sesMissingFromFailures(failed: SesQueueFailure[], extra: string[] = []): string[] {
  return uniqueStrings([...extra, ...failed.flatMap((entry) => toArray<string>(entry.missing))]);
}

/** Distinct server messages of the failed partes, for the operator to read them verbatim. */
export function sesFailureMessages(failed: SesQueueFailure[]): string[] {
  return uniqueStrings(failed.map((entry) => (typeof entry.message === "string" ? entry.message : "")));
}

function isEstablishmentFailure(failed: SesQueueFailure[], missing: string[], code: string | null): boolean {
  if (missing.length > 0) return true;
  if (code && SES_ESTABLISHMENT_ERROR_CODES.includes(code)) return true;
  return failed.some((entry) => typeof entry.code === "string" && SES_ESTABLISHMENT_ERROR_CODES.includes(entry.code));
}

/**
 * Honest reading of a 2xx queue response: "queued" only when at least one
 * record was queued and none failed. Failed rows are read from `failed[]`
 * and, for the pre-cierre API, from `submissions[]` with status "failed".
 */
export function sesQueueOutcomeFromResponse(response: SesQueueResponse | null | undefined): SesQueueOutcome {
  const submissions = toArray<SesSubmissionRow>(response?.submissions);
  const failedRows = submissions.filter((row) => row.status === "failed");
  const failed: SesQueueFailure[] = [
    ...toArray<SesQueueFailure>(response?.failed),
    ...failedRows.map((row) => ({ guestRegisterRecordId: row.guestRegisterRecordId, code: row.errorCode, message: row.errorMessage, missing: row.missing }))
  ];
  const queuedRows = submissions.filter((row) => row.status !== "failed").length;
  const queued = submissions.length > 0 ? queuedRows : typeof response?.queued === "number" ? Math.max(0, response.queued) : 0;
  const missing = sesMissingFromFailures(failed);
  if (failed.length === 0) return queued > 0 ? { kind: "queued", queued } : { kind: "no_records" };
  if (queued > 0) return { kind: "partial", queued, failed, missing };
  const firstCode = failed.map((entry) => entry.code).find((code): code is string => typeof code === "string" && code.length > 0) ?? null;
  const message = sesFailureMessages(failed)[0] ?? "";
  if (isEstablishmentFailure(failed, missing, firstCode)) {
    return { kind: "incomplete", missing, message: message || "El establecimiento no está completo para SES.HOSPEDAJES.", failed };
  }
  const refusal = sesRefusalOutcome(firstCode, message || "El parte de viajeros no se pudo encolar.", failed);
  if (refusal) return refusal;
  return { kind: "error", message: message || "El parte de viajeros no se pudo encolar.", code: firstCode, failed };
}

/**
 * Honest reading of a thrown error from the queue route:
 *   · 409 SES_NO_GUEST_REGISTER_RECORDS → "no_records";
 *   · 409 SES_ESTABLISHMENT_INCOMPLETE / ISSUER_TAX_ID_MISSING (details.missing[],
 *     or details.failed[] entries carrying those codes) → "incomplete";
 *   · 409 SES_QUEUE_FAILED and anything else → "error" with the per-parte
 *     messages when details.failed[] exists, the envelope message otherwise.
 */
export function sesQueueOutcomeFromError(error: unknown): SesQueueOutcome {
  if (error instanceof ApiError) {
    const details = (error.details && typeof error.details === "object" ? error.details : {}) as { code?: unknown; missing?: unknown; failed?: unknown };
    const code = typeof details.code === "string" ? details.code : null;
    const failed = toArray<SesQueueFailure>(details.failed).filter((entry) => entry && typeof entry === "object");
    const missing = sesMissingFromFailures(failed, toArray<string>(details.missing));
    if (error.status === 409 && code === SES_NO_GUEST_REGISTER_RECORDS_CODE) return { kind: "no_records" };
    if (error.status === 409 && isEstablishmentFailure(failed, missing, code)) {
      return { kind: "incomplete", missing, message: error.message, failed };
    }
    // Tanda L5: SES switched off / parte incomplete → typed outcomes (no row was created).
    const refusal = error.status === 409 ? sesRefusalOutcome(code, error.message, failed) : null;
    if (refusal) return refusal;
    const messages = sesFailureMessages(failed);
    return { kind: "error", message: messages.length > 0 ? messages.join(" · ") : error.message, code, failed };
  }
  return { kind: "error", message: error instanceof Error ? error.message : "El parte de viajeros no se pudo encolar.", code: null, failed: [] };
}

/**
 * Paginated SES history. Always asks for the envelope; a pre-pagination API
 * still answers a bare array, which is normalised to a single page.
 */
export async function fetchSesSubmissionsPage(
  propertyId: string,
  query: { limit?: number; cursor?: string; status?: string } = {}
): Promise<SesSubmissionsPage> {
  const payload = await apiRequest<unknown>(`/properties/${propertyId}/ses/submissions`, {
    query: { envelope: 1, limit: query.limit, cursor: query.cursor, status: query.status || undefined }
  });
  if (Array.isArray(payload)) {
    return { items: payload as SesSubmissionRow[], nextCursor: null, total: payload.length };
  }
  const page = (payload ?? {}) as Partial<SesSubmissionsPage>;
  const items = Array.isArray(page.items) ? page.items : [];
  return { items, nextCursor: page.nextCursor ?? null, total: typeof page.total === "number" ? page.total : items.length };
}

/** POST /ses/submissions/:id/retry — the pipeline retry (resets the attempt counter). */
export function retrySesPipelineSubmission(submissionId: string) {
  return apiRequest<{ status: string }>(`/ses/submissions/${submissionId}/retry`, { method: "POST" });
}
