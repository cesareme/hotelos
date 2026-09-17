// Modo sombra OPERA · helpers puros del panel (Tanda 7b · L4; diseño
// docs/design/OPERA-CLOUD-MODO-SOMBRA.md §6.6 con §10 nº 14). Sin React, sin
// api-client, sin import.meta: etiquetas y tonos de feeds / cortes / alertas /
// reconciliación, contadores de un corte, la URL del asistente de importación en
// modo sincronizar, el agrupado del mapeo de transaction codes con las entradas
// «sin mapear» resaltadas y los KPI de la cabecera. Todo formatea por lib/format.
// Solo `import type` de @hotelos/shared (los .js stubs del contrato ganan bajo
// node --import tsx): los diccionarios en español se redeclaran aquí tipados.

import type {
  IsoDate,
  PmsShadowAlertCode,
  PmsShadowAlertRecord,
  PmsShadowAlertSeverity,
  PmsShadowFeed,
  PmsShadowFeedState,
  PmsShadowFeedStatus,
  PmsShadowOverview,
  PmsShadowProfileRecord,
  PmsShadowProfileStatus,
  PmsShadowPropertyMapping,
  PmsShadowReconciliationRow,
  PmsShadowReservationFeed,
  PmsShadowRevenueStatus,
  PmsShadowRunRecord,
  PmsShadowRunSource,
  PmsShadowRunStatus,
  PmsShadowScheduleFeed,
  PmsShadowTrxCodeMapping,
  PmsShadowTrxKind,
  PmsShadowUsaliRevenueDepartment
} from "@hotelos/shared";
import type { CocoaSelectOption, CocoaTone } from "../../components/cocoa";
import { EMPTY, date, dateTime, number, plural, relativeTime } from "../../lib/format";
import { BRAND } from "../../config/brand";

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

export const PMS_SHADOW_FEEDS: readonly PmsShadowFeed[] = ["arrivals", "inhouse", "departures", "changes", "revenue", "profiles", "stats", "ohip_delta"];

/** Feeds the sync mode of the reservation importer processes (the manual upload goes to the wizard). */
export const PMS_SHADOW_RESERVATION_FEEDS: readonly PmsShadowReservationFeed[] = ["arrivals", "inhouse", "departures", "changes"];

/** Short labels for tables and selects (the long ones of the contract explain the feed in the profile). */
export const FEED_LABELS: Readonly<Record<PmsShadowFeed, string>> = Object.freeze({
  arrivals: "Llegadas",
  inhouse: "En casa",
  departures: "Salidas",
  changes: "Cambios de ayer",
  revenue: "Ingresos del día",
  profiles: "Perfiles",
  stats: "Estadísticas y cuadre",
  ohip_delta: "Delta OHIP"
});

/** What the feed carries, for the profile schedule and the manual upload dialog. */
export const FEED_DESCRIPTIONS: Readonly<Record<PmsShadowFeed, string>> = Object.freeze({
  arrivals: "Llegadas de hoy y de los próximos 30 días (snapshot de reservas)",
  inhouse: "Reservas en casa (snapshot de reservas)",
  departures: "Salidas del día (snapshot de reservas)",
  changes: "Nuevas, canceladas y no-show de ayer (snapshot de reservas)",
  revenue: "Ingresos del día por transaction code (XML de Revenue, findeptcodes o RESPONSYS_TRX)",
  profiles: "Perfiles de huésped",
  stats: "Manager Report / Trial Balance / estadísticas para la reconciliación",
  ohip_delta: "Ciclo asíncrono dailySummary de OHIP (fase 2)"
});

export function isPmsShadowFeed(value: unknown): value is PmsShadowFeed {
  return typeof value === "string" && (PMS_SHADOW_FEEDS as readonly string[]).includes(value);
}

export function isReservationFeed(feed: PmsShadowFeed | string | null | undefined): feed is PmsShadowReservationFeed {
  return typeof feed === "string" && (PMS_SHADOW_RESERVATION_FEEDS as readonly string[]).includes(feed);
}

export function feedLabel(feed: PmsShadowFeed | string | null | undefined): string {
  if (!feed) return EMPTY;
  return (FEED_LABELS as Record<string, string>)[feed] ?? feed;
}

export function feedDescription(feed: PmsShadowFeed | string | null | undefined): string {
  if (!feed) return "";
  return (FEED_DESCRIPTIONS as Record<string, string>)[feed] ?? "";
}

/** Options of a feed select; `withAll` prepends «Todos los feeds» with value "". */
export function feedOptions(options: { withAll?: boolean; only?: readonly PmsShadowFeed[] } = {}): CocoaSelectOption[] {
  const feeds = options.only ?? PMS_SHADOW_FEEDS;
  const out: CocoaSelectOption[] = feeds.map((feed) => ({ value: feed, label: FEED_LABELS[feed] }));
  return options.withAll ? [{ value: "", label: "Todos los feeds" }, ...out] : out;
}

// ---------------------------------------------------------------------------
// Runs (cortes)
// ---------------------------------------------------------------------------

export const RUN_STATUS_LABELS: Readonly<Record<PmsShadowRunStatus, string>> = Object.freeze({
  received: "Recibido",
  processing: "En proceso",
  done: "Procesado",
  partial: "Parcial",
  failed: "Fallido"
});

export const RUN_STATUS_TONES: Readonly<Record<PmsShadowRunStatus, CocoaTone>> = Object.freeze({
  received: "info",
  processing: "info",
  done: "success",
  partial: "warning",
  failed: "danger"
});

export function runStatusLabel(status: PmsShadowRunStatus | string): string {
  return (RUN_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function runStatusTone(status: PmsShadowRunStatus | string): CocoaTone {
  return (RUN_STATUS_TONES as Record<string, CocoaTone>)[status] ?? "neutral";
}

export function runStatusOptions(): CocoaSelectOption[] {
  return [{ value: "", label: "Todos los estados" }, ...(Object.keys(RUN_STATUS_LABELS) as PmsShadowRunStatus[]).map((status) => ({ value: status, label: RUN_STATUS_LABELS[status] }))];
}

export const RUN_SOURCE_LABELS: Readonly<Record<PmsShadowRunSource, string>> = Object.freeze({
  email: "Correo",
  sftp: "SFTP",
  api_key: "Clave de API",
  manual: "Subida manual",
  ohip: "OHIP",
  cli: "Línea de comandos"
});

export function runSourceLabel(source: PmsShadowRunSource | string | null | undefined): string {
  if (!source) return EMPTY;
  return (RUN_SOURCE_LABELS as Record<string, string>)[source] ?? source;
}

type RunCounts = Pick<PmsShadowRunRecord, "createdCount" | "updatedCount" | "unchangedCount" | "transitionedCount" | "skippedCount" | "errorCount">;

/**
 * «3 creadas · 12 actualizadas · 40 sin cambios»: the three sync counters
 * always, then transitions / omitted / errors only when they are not zero.
 * A revenue or stats run (every counter 0) reads «sin filas».
 */
export function formatCounts(run: RunCounts | null | undefined): string {
  if (!run) return EMPTY;
  // FUX-7B-07: «1 creada», «1 actualizada», «1 omitida», «1 con error» (plural only from 2; 0 reads plural).
  const one = (count: number, singular: string, pluralForm: string): string => `${number(count)} ${count === 1 ? singular : pluralForm}`;
  const parts = [one(run.createdCount, "creada", "creadas"), one(run.updatedCount, "actualizada", "actualizadas"), `${number(run.unchangedCount)} sin cambios`];
  if (run.transitionedCount > 0) parts.push(`${number(run.transitionedCount)} con cambio de estado`);
  if (run.skippedCount > 0) parts.push(one(run.skippedCount, "omitida", "omitidas"));
  if (run.errorCount > 0) parts.push(`${number(run.errorCount)} con error`);
  const total = run.createdCount + run.updatedCount + run.unchangedCount + run.transitionedCount + run.skippedCount + run.errorCount;
  return total === 0 ? "sin filas" : parts.join(" · ");
}

/** «llegadas_2026-09-17.csv · 17/09/2026 08:12» for a feed row; «—» when the feed never arrived. */
export function lastFileLabel(run: Pick<PmsShadowRunRecord, "fileName" | "createdAt"> | null | undefined): string {
  if (!run) return EMPTY;
  const name = run.fileName?.trim() || "sin nombre";
  return `${name} · ${dateTime(run.createdAt)}`;
}

// ---------------------------------------------------------------------------
// Feed states (overview table)
// ---------------------------------------------------------------------------

export const FEED_STATE_LABELS: Readonly<Record<PmsShadowFeedState, string>> = Object.freeze({
  ok: "Recibido",
  late: "Retrasado",
  failed: "Con errores",
  pending: "Pendiente",
  unscheduled: "Sin programar"
});

export const FEED_STATE_TONES: Readonly<Record<PmsShadowFeedState, CocoaTone>> = Object.freeze({
  ok: "success",
  late: "warning",
  failed: "danger",
  pending: "info",
  unscheduled: "neutral"
});

export function feedStateLabel(state: PmsShadowFeedState | string): string {
  return (FEED_STATE_LABELS as Record<string, string>)[state] ?? state;
}

export function feedStateTone(state: PmsShadowFeedState | string): CocoaTone {
  return (FEED_STATE_TONES as Record<string, CocoaTone>)[state] ?? "neutral";
}

/** «06:30 (obligatorio)» · «07:00» · «—» for the expected time column. */
export function expectedTimeLabel(feed: Pick<PmsShadowFeedStatus, "expectedTime" | "required">): string {
  if (!feed.expectedTime) return EMPTY;
  return feed.required ? `${feed.expectedTime} (obligatorio)` : feed.expectedTime;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export const ALERT_SEVERITY_LABELS: Readonly<Record<PmsShadowAlertSeverity, string>> = Object.freeze({
  info: "Información",
  warning: "Aviso",
  error: "Error"
});

export const ALERT_SEVERITY_TONES: Readonly<Record<PmsShadowAlertSeverity, CocoaTone>> = Object.freeze({
  info: "info",
  warning: "warning",
  error: "danger"
});

export function alertSeverityLabel(severity: PmsShadowAlertSeverity | string): string {
  return (ALERT_SEVERITY_LABELS as Record<string, string>)[severity] ?? severity;
}

export function alertSeverityTone(severity: PmsShadowAlertSeverity | string): CocoaTone {
  return (ALERT_SEVERITY_TONES as Record<string, CocoaTone>)[severity] ?? "neutral";
}

export const ALERT_CODE_LABELS: Readonly<Record<PmsShadowAlertCode, string>> = Object.freeze({
  OPERA_MISSING_IN_SNAPSHOT: "Reserva ausente del corte de OPERA",
  OPERA_CONFLICT_LOCAL_RESERVATION: `Conflicto con una reserva creada en ${BRAND.name}`,
  OPERA_CHECKIN_WITHOUT_ROOM: "Check-in en OPERA sin habitación válida",
  OPERA_TRX_CODE_UNMAPPED: "Transaction code sin mapear",
  OPERA_ROOM_TYPE_UNMAPPED: "Tipo de habitación de OPERA sin mapear",
  OPERA_RATE_CODE_UNMAPPED: "Rate code de OPERA sin mapear",
  OPERA_RECON_COUNT_MISMATCH: "Los conteos del día no cuadran con OPERA",
  OPERA_RECON_REVENUE_MISMATCH: "Los ingresos del día no cuadran con OPERA",
  OPERA_FEED_LATE: "Corte de OPERA no recibido a la hora prevista",
  OPERA_FEED_COLUMNS_CHANGED: "La cabecera del informe ha cambiado",
  OPERA_FEED_UNRECOGNIZED: "Fichero o correo sin corte reconocible"
});

export function alertCodeLabel(code: PmsShadowAlertCode | string): string {
  return (ALERT_CODE_LABELS as Record<string, string>)[code] ?? code;
}

export function alertCodeOptions(): CocoaSelectOption[] {
  return [{ value: "", label: "Todos los códigos" }, ...(Object.keys(ALERT_CODE_LABELS) as PmsShadowAlertCode[]).map((code) => ({ value: code, label: ALERT_CODE_LABELS[code] }))];
}

/** «Resuelta el 17/09/2026 · motivo» · «Abierta» for the alert table. */
export function alertResolutionLabel(alert: Pick<PmsShadowAlertRecord, "resolvedAt" | "resolutionNote">): string {
  if (!alert.resolvedAt) return "Abierta";
  const when = dateTime(alert.resolvedAt);
  return alert.resolutionNote ? `Resuelta el ${when} · ${alert.resolutionNote}` : `Resuelta el ${when}`;
}

/** Expected / obtained pairs of an alert as «clave: valor» lines (never personal data: the API only stores metrics and codes). */
export function alertDetailLines(alert: Pick<PmsShadowAlertRecord, "expected" | "actual">): string[] {
  const lines: string[] = [];
  const describe = (prefix: string, record: Record<string, unknown>) => {
    const entries = Object.entries(record ?? {}).filter(([, value]) => value !== null && value !== undefined && value !== "");
    if (entries.length === 0) return;
    lines.push(`${prefix}: ${entries.map(([key, value]) => `${key} ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ")}`);
  };
  describe("Esperado", alert.expected);
  describe("Obtenido", alert.actual);
  return lines;
}

// ---------------------------------------------------------------------------
// Reconciliation (§5.4)
// ---------------------------------------------------------------------------

export const RECON_STATUS_LABELS: Readonly<Record<PmsShadowReconciliationRow["status"], string>> = Object.freeze({
  ok: "Cuadra",
  mismatch: "No cuadra",
  missing: "Sin dato de OPERA"
});

export const RECON_STATUS_TONES: Readonly<Record<PmsShadowReconciliationRow["status"], CocoaTone>> = Object.freeze({
  ok: "success",
  mismatch: "danger",
  missing: "neutral"
});

export function reconciliationTone(status: PmsShadowReconciliationRow["status"] | string): CocoaTone {
  return (RECON_STATUS_TONES as Record<string, CocoaTone>)[status] ?? "neutral";
}

export function reconciliationStatusLabel(status: PmsShadowReconciliationRow["status"] | string): string {
  return (RECON_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

/** `PmsShadowReconciliationRow.metric` → Spanish label (pms-shadow.rules.ts PMS_SHADOW_RECON_METRICS). */
export const RECON_METRIC_LABELS: Readonly<Record<string, string>> = Object.freeze({
  arrivals: "Llegadas (habitaciones)",
  departures: "Salidas (habitaciones)",
  rooms_occupied: "Habitaciones ocupadas",
  occupancy_pct: "% de ocupación",
  no_shows: "No-shows",
  revenue_rooms: "Ingresos de alojamiento",
  revenue_total: "Ingresos totales",
  tax_total: "Impuestos",
  adr: "ADR",
  revpar: "RevPAR",
  transaction_total_today: "Total de transacciones del día",
  reservations_made: "Reservas hechas",
  cancellations: "Cancelaciones"
});

export function reconciliationMetricLabel(metric: string): string {
  return RECON_METRIC_LABELS[metric] ?? metric;
}

/** «7 métricas cuadran · 2 no cuadran · 4 sin dato» for the section meta. */
export function reconciliationSummary(rows: readonly Pick<PmsShadowReconciliationRow, "status">[]): string {
  const ok = rows.filter((row) => row.status === "ok").length;
  const mismatch = rows.filter((row) => row.status === "mismatch").length;
  const missing = rows.filter((row) => row.status === "missing").length;
  return [`${number(ok)} cuadran`, `${number(mismatch)} no cuadran`, `${number(missing)} sin dato`].join(" · ");
}

// ---------------------------------------------------------------------------
// Link to the reservation import wizard in sync mode (§6.6, §10 nº 14)
// ---------------------------------------------------------------------------

/** URL of Recepción › Reservas › Importar (nav tree); the helper stays pure so the caller may pass `urlForScreen(...)`. */
export const IMPORT_WIZARD_PATH = "/recepcion/reservas/importar";

export type SyncImportLink = {
  feed: PmsShadowReservationFeed;
  /** "YYYY-MM-DD"; omitted → the wizard takes the business date of the property. */
  businessDate?: IsoDate | null;
};

/**
 * `/recepcion/reservas/importar?modo=sync&perfil=opera_cloud&feed=<feed>&fecha=<YYYY-MM-DD>`:
 * what ReservationImportScreen reads with parseSyncSearchParams. A business date
 * that is not `YYYY-MM-DD` is dropped (the wizard falls back to the property's).
 */
export function buildSyncImportUrl(link: SyncImportLink, basePath: string = IMPORT_WIZARD_PATH): string {
  const params = [`modo=sync`, `perfil=opera_cloud`, `feed=${encodeURIComponent(link.feed)}`];
  if (link.businessDate && /^\d{4}-\d{2}-\d{2}$/.test(link.businessDate)) params.push(`fecha=${link.businessDate}`);
  return `${basePath}?${params.join("&")}`;
}

/**
 * Business date the wizard link is pre-filled with for a feed: today (local, `YYYY-MM-DD`)
 * plus the feed's `businessDateOffset` in the profile schedule (SC-07: `departures` is −1 by
 * default — the report of yesterday's departures, already «Checked Out»); a feed without a
 * schedule entry keeps today. The operator can still change the date in the wizard.
 */
export function feedBusinessDateFor(feed: PmsShadowFeed, schedule: readonly Pick<PmsShadowScheduleFeed, "feed" | "businessDateOffset">[], today: string | null): IsoDate | null {
  if (!today || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const offset = schedule.find((entry) => entry.feed === feed)?.businessDateOffset ?? 0;
  if (offset === 0) return today as IsoDate;
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day) + offset * 86_400_000).toISOString().slice(0, 10) as IsoDate;
}

// ---------------------------------------------------------------------------
// Profile: master dictionaries and transaction codes
// ---------------------------------------------------------------------------

export const PROFILE_STATUS_LABELS: Readonly<Record<PmsShadowProfileStatus, string>> = Object.freeze({
  active: "Activo",
  paused: "En pausa"
});

export function profileStatusOptions(): CocoaSelectOption[] {
  return (Object.keys(PROFILE_STATUS_LABELS) as PmsShadowProfileStatus[]).map((status) => ({ value: status, label: PROFILE_STATUS_LABELS[status] }));
}

export function profileStatusTone(status: PmsShadowProfileStatus | string | null | undefined): CocoaTone {
  return status === "active" ? "success" : status === "paused" ? "warning" : "neutral";
}

export type DictionaryKey = keyof Pick<PmsShadowPropertyMapping, "roomTypes" | "rateCodes" | "marketCodes" | "sourceCodes" | "paymentTypes">;

export const DICTIONARY_KEYS: readonly DictionaryKey[] = ["roomTypes", "rateCodes", "marketCodes", "sourceCodes", "paymentTypes"];

export const DICTIONARY_LABELS: Readonly<Record<DictionaryKey, { title: string; opera: string; anfitorio: string }>> = Object.freeze({
  roomTypes: { title: "Tipos de habitación", opera: "Room type OPERA", anfitorio: `Tipo de ${BRAND.name}` },
  rateCodes: { title: "Rate codes", opera: "Rate code OPERA", anfitorio: "Plan de tarifas" },
  marketCodes: { title: "Segmentos de mercado", opera: "Market code OPERA", anfitorio: "Segmento" },
  sourceCodes: { title: "Fuentes y canales", opera: "Source code OPERA", anfitorio: "Canal" },
  paymentTypes: { title: "Métodos de pago", opera: "Payment type OPERA", anfitorio: "Método de pago" }
});

export type DictionaryRow = { key: string; value: string; unmapped: boolean };

/** Dictionary → editable rows (a blank value is «sin mapear»), sorted by OPERA code. */
export function dictionaryRows(dictionary: Record<string, string> | null | undefined): DictionaryRow[] {
  return Object.entries(dictionary ?? {})
    .map(([key, value]) => ({ key, value: value ?? "", unmapped: !(value ?? "").trim() }))
    .sort((a, b) => a.key.localeCompare(b.key, "es"));
}

/** Editable rows → dictionary; blank keys are dropped, values trimmed (a blank value stays as an explicit «sin mapear» entry). */
export function rowsToDictionary(rows: readonly Pick<DictionaryRow, "key" | "value">[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    out[key] = row.value.trim();
  }
  return out;
}

export const TRX_KIND_LABELS: Readonly<Record<PmsShadowTrxKind, string>> = Object.freeze({
  revenue: "Ingreso",
  tax: "Impuesto repercutido",
  payment: "Cobro",
  ignore: "Sin asiento"
});

export const TRX_KINDS: readonly PmsShadowTrxKind[] = ["revenue", "tax", "payment", "ignore"];

export function trxKindLabel(kind: PmsShadowTrxKind | string | null | undefined): string {
  if (!kind) return EMPTY;
  return (TRX_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

export function trxKindOptions(): CocoaSelectOption[] {
  return TRX_KINDS.map((kind) => ({ value: kind, label: TRX_KIND_LABELS[kind] }));
}

export const USALI_DEPARTMENT_LABELS: Readonly<Record<PmsShadowUsaliRevenueDepartment, string>> = Object.freeze({
  rooms: "Habitaciones",
  fnb: "Alimentos y bebidas",
  other_operated: "Otros departamentos operativos",
  misc_income: "Ingresos diversos"
});

export function usaliDepartmentLabel(department: string | null | undefined): string {
  if (!department) return EMPTY;
  return (USALI_DEPARTMENT_LABELS as Record<string, string>)[department] ?? department;
}

export function usaliDepartmentOptions(): CocoaSelectOption[] {
  return [{ value: "", label: "Sin departamento" }, ...(Object.keys(USALI_DEPARTMENT_LABELS) as PmsShadowUsaliRevenueDepartment[]).map((department) => ({ value: department, label: USALI_DEPARTMENT_LABELS[department] }))];
}

/** A transaction code is mapped when it is `ignore` or when it names a PGC account (a revenue line needs its USALI department too). */
export function isTrxMappingComplete(entry: Pick<PmsShadowTrxCodeMapping, "kind" | "accountCode" | "usaliDepartment">): boolean {
  if (entry.kind === "ignore") return true;
  if (!(entry.accountCode ?? "").trim()) return false;
  if (entry.kind === "revenue") return Boolean(entry.usaliDepartment);
  return true;
}

export type TrxMappingRow = PmsShadowTrxCodeMapping & { unmapped: boolean };

export type TrxMappingGroup = { kind: PmsShadowTrxKind; label: string; rows: TrxMappingRow[]; unmappedCount: number };

/**
 * Groups the profile's transaction codes by accounting kind (ingreso · impuesto ·
 * cobro · sin asiento), each row flagged `unmapped` when it has no PGC account
 * (or no USALI department for a revenue line) so the drawer can paint the
 * «sin mapear» badge. Groups keep the catalogue order; codes sort inside each.
 */
export function groupTrxMapping(mapping: readonly PmsShadowTrxCodeMapping[] | null | undefined): TrxMappingGroup[] {
  const entries = mapping ?? [];
  return TRX_KINDS.map((kind) => {
    const rows = entries
      .filter((entry) => entry.kind === kind)
      .map((entry) => ({ ...entry, unmapped: !isTrxMappingComplete(entry) }))
      .sort((a, b) => a.code.localeCompare(b.code, "es"));
    return { kind, label: TRX_KIND_LABELS[kind], rows, unmappedCount: rows.filter((row) => row.unmapped).length };
  }).filter((group) => group.rows.length > 0);
}

/** Total of «sin mapear» transaction codes of a profile. */
export function unmappedTrxCount(mapping: readonly PmsShadowTrxCodeMapping[] | null | undefined): number {
  return (mapping ?? []).filter((entry) => !isTrxMappingComplete(entry)).length;
}

/** Sanitises the editable rows before `PUT …/profile`: blank codes dropped, blanks → absent keys (the zod schema rejects empty strings). */
export function trxRowsToMapping(rows: readonly PmsShadowTrxCodeMapping[]): PmsShadowTrxCodeMapping[] {
  const out: PmsShadowTrxCodeMapping[] = [];
  for (const row of rows) {
    const code = row.code.trim();
    if (!code) continue;
    const entry: PmsShadowTrxCodeMapping = { code, kind: row.kind };
    if (row.description?.trim()) entry.description = row.description.trim();
    if (row.transactionType?.trim()) entry.transactionType = row.transactionType.trim();
    if (row.accountCode?.trim()) entry.accountCode = row.accountCode.trim();
    if (row.usaliDepartment) entry.usaliDepartment = row.usaliDepartment;
    if (row.taxRateCode?.trim()) entry.taxRateCode = row.taxRateCode.trim();
    out.push(entry);
  }
  return out;
}

/** Profile summary for the drawer trigger: «RIAS · Activo · 3 sin mapear». */
export function profileSummary(profile: Pick<PmsShadowProfileRecord, "operaHotelCode" | "status" | "trxMapping"> | null | undefined): string {
  if (!profile) return "Sin perfil: crea el perfil de mapeo para empezar";
  const unmapped = unmappedTrxCount(profile.trxMapping);
  const parts = [profile.operaHotelCode || "sin código OPERA", PROFILE_STATUS_LABELS[profile.status] ?? profile.status];
  parts.push(unmapped > 0 ? `${number(unmapped)} sin mapear` : "transaction codes completos");
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Revenue lots
// ---------------------------------------------------------------------------

export const REVENUE_STATUS_LABELS: Readonly<Record<PmsShadowRevenueStatus, string>> = Object.freeze({
  draft: "Previsualizado",
  posted: "Contabilizado",
  reversed: "Revertido"
});

export const REVENUE_STATUS_TONES: Readonly<Record<PmsShadowRevenueStatus, CocoaTone>> = Object.freeze({
  draft: "neutral",
  posted: "success",
  reversed: "warning"
});

export function revenueStatusLabel(status: PmsShadowRevenueStatus | string): string {
  return (REVENUE_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function revenueStatusTone(status: PmsShadowRevenueStatus | string): CocoaTone {
  return (REVENUE_STATUS_TONES as Record<string, CocoaTone>)[status] ?? "neutral";
}

// ---------------------------------------------------------------------------
// KPI strip
// ---------------------------------------------------------------------------

export type OverviewKpiKey = "lastRun" | "linked" | "alerts" | "reconciled";

export type OverviewKpi = { key: OverviewKpiKey; label: string; value: string; tone?: CocoaTone; caption?: string; degradedLabel: string };

/** Caption of one KPI: relative time of the last run, what the linked count means, whether alerts wait, when the last green day was. */
export function kpiCaption(overview: Pick<PmsShadowOverview, "lastRunAt" | "linkedReservations" | "openAlerts" | "lastReconciledDate">, key: OverviewKpiKey, now?: Date): string | undefined {
  switch (key) {
    case "lastRun":
      return overview.lastRunAt ? relativeTime(overview.lastRunAt, now) : "Ningún corte recibido todavía";
    case "linked":
      return overview.linkedReservations > 0 ? "Reservas con enlace a OPERA" : "Todavía sin reservas sincronizadas";
    case "alerts":
      return overview.openAlerts > 0 ? plural(overview.openAlerts, "pendiente de resolver", "pendientes de resolver") : "Ninguna alerta abierta";
    case "reconciled":
      return overview.lastReconciledDate ? "Reconciliación en verde" : "Ningún día conciliado todavía";
    default:
      return undefined;
  }
}

/** The four KPIs of §6.6: último corte · reservas enlazadas · alertas abiertas · último día conciliado. */
export function overviewKpis(overview: Pick<PmsShadowOverview, "lastRunAt" | "linkedReservations" | "openAlerts" | "lastReconciledDate">, now?: Date): OverviewKpi[] {
  return [
    { key: "lastRun", label: "Último corte", value: overview.lastRunAt ? dateTime(overview.lastRunAt) : EMPTY, tone: overview.lastRunAt ? "info" : undefined, caption: kpiCaption(overview, "lastRun", now), degradedLabel: "lastRunAt" },
    { key: "linked", label: "Reservas enlazadas", value: number(overview.linkedReservations), tone: overview.linkedReservations > 0 ? "success" : undefined, caption: kpiCaption(overview, "linked"), degradedLabel: "linkedReservations" },
    { key: "alerts", label: "Alertas abiertas", value: number(overview.openAlerts), tone: overview.openAlerts > 0 ? "warning" : "success", caption: kpiCaption(overview, "alerts"), degradedLabel: "openAlerts" },
    { key: "reconciled", label: "Último día conciliado", value: overview.lastReconciledDate ? date(overview.lastReconciledDate) : EMPTY, tone: overview.lastReconciledDate ? "success" : undefined, caption: kpiCaption(overview, "reconciled"), degradedLabel: "lastReconciledDate" }
  ];
}

// ---------------------------------------------------------------------------
// Manual upload
// ---------------------------------------------------------------------------

export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** Accepted extensions of a manual upload (the API sniffs the format). */
export const UPLOAD_ACCEPT = ".csv,.txt,.xml,.xlsx";

/** «llegadas_2026-09-17.csv» → "csv"; used only to hint the user, never to decide the feed. */
export function fileExtension(fileName: string | null | undefined): string {
  const name = (fileName ?? "").trim();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** «Corte de ingresos del 17/09/2026 registrado (procesado)»: toast of a manual upload. */
export function uploadSummary(result: { status: PmsShadowRunStatus; counts: RunCountsLike; run: Pick<PmsShadowRunRecord, "feed" | "businessDate"> }): string {
  const day = result.run.businessDate ? ` del ${date(result.run.businessDate)}` : "";
  return `Corte de ${feedLabel(result.run.feed).toLowerCase()}${day} registrado (${runStatusLabel(result.status).toLowerCase()}) · ${formatCounts({
    createdCount: result.counts.created,
    updatedCount: result.counts.updated,
    unchangedCount: result.counts.unchanged,
    transitionedCount: result.counts.transitioned,
    skippedCount: result.counts.skipped,
    errorCount: result.counts.error
  })}`;
}

type RunCountsLike = { created: number; updated: number; unchanged: number; transitioned: number; skipped: number; error: number };
