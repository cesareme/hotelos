// Configuración › Módulos e integraciones › Modo sombra OPERA —
// /configuracion/modulos/modo-sombra (Tanda 7b · L4; design
// docs/design/OPERA-CLOUD-MODO-SOMBRA.md §6.6 with §10 nº 14: a tab of
// ModulosTabs, not an item of its own). Born without inline styles (Cocoa 22
// contract), everything through services/pmsShadowApi:
//
//   KPIs          último corte · reservas enlazadas · alertas abiertas · último día
//                 conciliado (CocoaKpi `degraded` + DegradedBanner when the API
//                 marks a counter in `degraded[]`).
//   Feeds         one row per scheduled / seen feed: hora esperada, último fichero,
//                 estado, contadores. «Subir corte manual»: a reservation feed opens
//                 the Tanda 7 wizard in sync mode (buildSyncImportUrl); revenue /
//                 stats / profiles open the upload dialog (CocoaFileInput → base64
//                 → uploadPmsShadowRun, 202 with the run already closed).
//   Cortes        listPmsShadowRuns with feed / status filters; «Ver lote» deep-links
//                 the reservation import lot (?lote=<id> of the wizard).
//   Reconciliación GET …/reconciliation?businessDate= (CocoaInput type="date"):
//                 métrica · OPERA · ehotelOS · diferencia · estado.
//   Alertas       open by default, code filter, «Resolver» → CocoaDialog with a
//                 mandatory note (audited) → resolvePmsShadowAlert + toast.
//   Perfil        CocoaDrawer «Perfil de mapeo»: OPERA hotel code, estado, master
//                 dictionaries (room types, rate codes, market, source, payment),
//                 transaction codes → cuenta PGC + USALI with «sin mapear» badges,
//                 schedule of feeds; row editing with CocoaInput / CocoaSelect,
//                 savePmsShadowProfile (integrations.connect).
//   Ingresos      revenue lots (posted / reversed) with «Revertir» (reason,
//                 accounting.journal.post only).
//
// Permissions through canDo(useNavGate()): integrations.read to read,
// integrations.connect to write (profile, manual upload, resolve),
// accounting.journal.post for the revenue lots; the reconciliation reads with
// accounting.reports.read / accounting.read like the API. Files are never
// stored: the API keeps the run and its counters (GDPR, design §6.5).

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IsoDate, PmsShadowFeed, PmsShadowProfileStatus, PmsShadowScheduleFeed, PmsShadowTrxCodeMapping, PmsShadowTrxKind, PmsShadowUsaliRevenueDepartment } from "@hotelos/shared";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFileInput,
  CocoaFormRow,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  DegradedBanner,
  isDegraded,
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { EMPTY, date, dateTime, isoDate, money, number, plural } from "../../lib/format";
import { urlForScreen } from "../../navigation/nav-tree";
import { useNavGate } from "../../navigation/useEnabledModules";
import { useActiveProperty } from "../../services/activeProperty";
import {
  fetchPmsShadowOverview,
  fetchPmsShadowReconciliation,
  listPmsShadowAlerts,
  listPmsShadowRevenueImports,
  listPmsShadowRuns,
  pmsShadowErrorMessage,
  resolvePmsShadowAlert,
  reversePmsShadowRevenue,
  savePmsShadowProfile,
  uploadPmsShadowRun,
  type PmsShadowAlertCode,
  type PmsShadowAlertRecord,
  type PmsShadowFeedStatus,
  type PmsShadowOverviewResponse,
  type PmsShadowProfileRecord,
  type PmsShadowReconciliation,
  type PmsShadowReconciliationRow,
  type PmsShadowRevenueImportRecord,
  type PmsShadowRunRecord,
  type PmsShadowRunStatus
} from "../../services/pmsShadowApi";
import { canDo } from "../accounting/accounting-ui";
import { base64OfArrayBuffer } from "../reservations/reservation-import-helpers";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { useTabHost } from "../tabs/TabHost";
import {
  DICTIONARY_KEYS,
  DICTIONARY_LABELS,
  IMPORT_WIZARD_PATH,
  UPLOAD_ACCEPT,
  UPLOAD_MAX_BYTES,
  alertCodeLabel,
  alertCodeOptions,
  alertDetailLines,
  alertResolutionLabel,
  alertSeverityLabel,
  alertSeverityTone,
  buildSyncImportUrl,
  dictionaryRows,
  expectedTimeLabel,
  feedBusinessDateFor,
  feedDescription,
  feedLabel,
  feedOptions,
  feedStateLabel,
  feedStateTone,
  formatCounts,
  groupTrxMapping,
  isPmsShadowFeed,
  isReservationFeed,
  isTrxMappingComplete,
  lastFileLabel,
  overviewKpis,
  profileStatusOptions,
  profileStatusTone,
  profileSummary,
  reconciliationMetricLabel,
  reconciliationStatusLabel,
  reconciliationSummary,
  reconciliationTone,
  revenueStatusLabel,
  revenueStatusTone,
  rowsToDictionary,
  runSourceLabel,
  runStatusLabel,
  runStatusOptions,
  runStatusTone,
  trxKindOptions,
  trxRowsToMapping,
  unmappedTrxCount,
  uploadSummary,
  usaliDepartmentLabel,
  usaliDepartmentOptions,
  type DictionaryKey
} from "./pms-shadow-helpers";
import { BRAND } from "../../config/brand";

const HEADER = treeHeaderFor("PmsShadowScreen", { eyebrow: "Configuración · Módulos e integraciones", title: "Modo sombra OPERA" });
const RUNS_LIMIT = 50;
const ALERTS_LIMIT = 100;
const REVENUE_LIMIT = 30;
const TABLE_MAX_HEIGHT = 420;
const NOTE_MAX = 500;
/** Feeds the upload dialog offers (the reservation feeds go through the wizard; `profiles` and `ohip_delta` are phase 2: the API answers «no implementado» with a failed run, FUX-7B-06). */
const UPLOAD_FEEDS: readonly PmsShadowFeed[] = ["revenue", "stats"];
/** Feeds the API declares «fase 2»: no manual upload, the row action is disabled with an explanation. */
const PHASE_TWO_FEEDS: readonly PmsShadowFeed[] = ["profiles", "ohip_delta"];
/** Reservation feeds whose columns the OPERA profile confirms (arrivals: RESPONSYS_RESV_AUTO; departures: departure_all); `inhouse` and `changes` wait for a real sample (FUX-7B-08). */
const WIZARD_FEEDS: readonly PmsShadowFeed[] = ["arrivals", "departures"];
const ALERT_VIEW_OPTIONS = [
  { value: "open", label: "Abiertas" },
  { value: "resolved", label: "Resueltas" }
];
const OFFSET_OPTIONS = [
  { value: "-1", label: "Día anterior (tras el night audit)" },
  { value: "0", label: "Mismo día" }
];

type PickedFile = { name: string; contentBase64: string; bytes: number };

type DictionaryDraftRow = { id: string; key: string; value: string };
type TrxDraftRow = PmsShadowTrxCodeMapping & { id: string };
type ScheduleDraftRow = PmsShadowScheduleFeed & { id: string };

/** Everything the drawer edits; built from the profile (or empty for the first save). */
type ProfileDraft = {
  operaHotelCode: string;
  status: PmsShadowProfileStatus;
  dictionaries: Record<DictionaryKey, DictionaryDraftRow[]>;
  pseudoRoomTypes: string;
  trx: TrxDraftRow[];
  schedule: ScheduleDraftRow[];
  inboxEmail: string;
  sftpFolder: string;
};

let draftSeq = 0;
function draftId(): string {
  draftSeq += 1;
  return `d${draftSeq}`;
}

function draftFromProfile(profile: PmsShadowProfileRecord | null): ProfileDraft {
  const dictionaries = {} as Record<DictionaryKey, DictionaryDraftRow[]>;
  for (const key of DICTIONARY_KEYS) dictionaries[key] = dictionaryRows(profile?.mapping[key]).map((row) => ({ id: draftId(), key: row.key, value: row.value }));
  return {
    operaHotelCode: profile?.operaHotelCode ?? "",
    status: profile?.status ?? "active",
    dictionaries,
    pseudoRoomTypes: (profile?.mapping.pseudoRoomTypes ?? []).join(", "),
    trx: (profile?.trxMapping ?? []).map((entry) => ({ ...entry, id: draftId() })),
    schedule: (profile?.schedule.feeds ?? []).map((entry) => ({ ...entry, id: draftId() })),
    inboxEmail: profile?.inboxEmail ?? "",
    sftpFolder: profile?.sftpFolder ?? ""
  };
}

function wizardPath(): string {
  return urlForScreen("ReservationImportScreen") ?? IMPORT_WIZARD_PATH;
}

/** Deep link to a lot of the Tanda 7 wizard («Importaciones anteriores» opens it in read mode). */
function importLotPath(importId: string): string {
  return `${wizardPath()}?lote=${encodeURIComponent(importId)}`;
}

function PanelSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[12], [12]]} height={220} />
    </div>
  );
}

const FEED_COLUMNS_BASE: CocoaTableColumn<PmsShadowFeedStatus>[] = [
  { key: "feed", label: "Feed", fit: true, render: (row) => <span title={feedDescription(row.feed)}>{feedLabel(row.feed)}</span> },
  { key: "expectedTime", label: "Hora esperada", fit: true, render: (row) => expectedTimeLabel(row) },
  { key: "lastFile", label: "Último fichero", truncate: 260, render: (row) => (row.lastRun ? <span className="cocoa-mono">{lastFileLabel(row.lastRun)}</span> : EMPTY) },
  {
    key: "state",
    label: "Estado",
    fit: true,
    render: (row) => (
      <CocoaBadge tone={feedStateTone(row.state)} size="small">
        {feedStateLabel(row.state)}
      </CocoaBadge>
    )
  },
  { key: "created", label: "Creadas", fit: true, align: "right", hideOnNarrow: true, render: (row) => (row.lastRun ? number(row.lastRun.createdCount) : EMPTY) },
  { key: "updated", label: "Actualizadas", fit: true, align: "right", hideOnNarrow: true, render: (row) => (row.lastRun ? number(row.lastRun.updatedCount) : EMPTY) },
  { key: "unchanged", label: "Sin cambios", fit: true, align: "right", showFrom: "laptop", render: (row) => (row.lastRun ? number(row.lastRun.unchangedCount) : EMPTY) },
  { key: "errors", label: "Errores", fit: true, align: "right", showFrom: "laptop", render: (row) => (row.lastRun ? number(row.lastRun.errorCount) : EMPTY) }
];

const RUN_COLUMNS: CocoaTableColumn<PmsShadowRunRecord>[] = [
  { key: "createdAt", label: "Recibido", nowrap: true, render: (row) => dateTime(row.createdAt) },
  { key: "feed", label: "Feed", fit: true, render: (row) => feedLabel(row.feed) },
  { key: "businessDate", label: "Fecha de negocio", fit: true, hideOnNarrow: true, render: (row) => (row.businessDate ? date(row.businessDate) : EMPTY) },
  { key: "source", label: "Origen", fit: true, showFrom: "laptop", render: (row) => runSourceLabel(row.source) },
  { key: "fileName", label: "Fichero", truncate: 220, showFrom: "tablet", render: (row) => <span className="cocoa-mono">{row.fileName ?? EMPTY}</span> },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (row) => (
      <CocoaBadge tone={runStatusTone(row.status)} size="small" title={row.errorMessage ?? undefined}>
        {runStatusLabel(row.status)}
      </CocoaBadge>
    )
  },
  { key: "counts", label: "Filas", truncate: 320, render: (row) => formatCounts(row) },
  { key: "alerts", label: "Alertas", fit: true, align: "right", showFrom: "laptop", render: (row) => (row.alerts.length > 0 ? number(row.alerts.length) : EMPTY) }
];

const RECON_COLUMNS: CocoaTableColumn<PmsShadowReconciliationRow>[] = [
  { key: "metric", label: "Métrica", render: (row) => reconciliationMetricLabel(row.metric) },
  { key: "opera", label: "OPERA", fit: true, align: "right", render: (row) => row.opera ?? EMPTY },
  { key: "anfitorio", label: BRAND.name, fit: true, align: "right", render: (row) => row.anfitorio },
  { key: "delta", label: "Diferencia", fit: true, align: "right", render: (row) => row.delta ?? EMPTY },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (row) => (
      <CocoaBadge tone={reconciliationTone(row.status)} size="small">
        {reconciliationStatusLabel(row.status)}
      </CocoaBadge>
    )
  }
];

const ALERT_COLUMNS: CocoaTableColumn<PmsShadowAlertRecord>[] = [
  { key: "createdAt", label: "Fecha", nowrap: true, render: (row) => dateTime(row.createdAt) },
  { key: "businessDate", label: "Fecha de negocio", fit: true, hideOnNarrow: true, render: (row) => (row.businessDate ? date(row.businessDate) : EMPTY) },
  {
    key: "severity",
    label: "Gravedad",
    fit: true,
    render: (row) => (
      <CocoaBadge tone={alertSeverityTone(row.severity)} size="small">
        {alertSeverityLabel(row.severity)}
      </CocoaBadge>
    )
  },
  { key: "code", label: "Alerta", truncate: 260, render: (row) => <span title={row.code}>{alertCodeLabel(row.code)}</span> },
  { key: "message", label: "Detalle", truncate: 360, showFrom: "tablet", render: (row) => [row.message, ...alertDetailLines(row)].join(" · ") },
  { key: "confirmationNo", label: "Confirmación", fit: true, showFrom: "laptop", render: (row) => <span className="cocoa-mono">{row.confirmationNo ?? EMPTY}</span> },
  { key: "resolution", label: "Resolución", truncate: 260, showFrom: "laptop", render: (row) => alertResolutionLabel(row) }
];

const REVENUE_COLUMNS: CocoaTableColumn<PmsShadowRevenueImportRecord>[] = [
  { key: "businessDate", label: "Fecha de negocio", fit: true, render: (row) => date(row.businessDate) },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (row) => (
      <CocoaBadge tone={revenueStatusTone(row.status)} size="small" title={row.reversalReason ?? undefined}>
        {revenueStatusLabel(row.status)}
      </CocoaBadge>
    )
  },
  { key: "fileName", label: "Fichero", truncate: 220, showFrom: "tablet", render: (row) => <span className="cocoa-mono">{row.fileName ?? EMPTY}</span> },
  { key: "revenue", label: "Ingresos", fit: true, align: "right", render: (row) => money(row.totals.revenue) },
  { key: "tax", label: "Impuestos", fit: true, align: "right", hideOnNarrow: true, render: (row) => money(row.totals.tax) },
  { key: "payments", label: "Cobros", fit: true, align: "right", showFrom: "laptop", render: (row) => money(row.totals.payments) },
  { key: "lines", label: "Líneas", fit: true, align: "right", showFrom: "laptop", render: (row) => number(row.lines.length) },
  { key: "entries", label: "Asientos", fit: true, align: "right", showFrom: "laptop", render: (row) => (row.journalEntryIds.length > 0 ? number(row.journalEntryIds.length) : EMPTY) },
  { key: "postedAt", label: "Contabilizado", nowrap: true, showFrom: "desktop", render: (row) => (row.postedAt ? dateTime(row.postedAt) : EMPTY) }
];

export function PmsShadowScreen() {
  // Hosted (ModulosTabs): the container paints eyebrow + H1; standalone keeps the subtitle.
  const hosted = useTabHost() !== null;
  const gate = useNavGate();
  const canRead = canDo(gate, "integrations.read");
  const canWrite = canDo(gate, "integrations.connect");
  const canPostRevenue = canDo(gate, "accounting.journal.post");
  // The reconciliation route asks accounting.read; the border remaps it to accounting.reports.read (security/route-permissions.ts).
  const canReadAccounting = canDo(gate, "accounting.reports.read") || canDo(gate, "accounting.read");
  const { propertyId, propertyName } = useActiveProperty();
  const { showToast } = useToast();

  // ---- overview (KPIs, feeds, profile) ----
  const [overview, setOverview] = useState<PmsShadowOverviewResponse | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    if (!propertyId) return;
    setOverviewLoading(true);
    setOverviewError(null);
    try {
      setOverview(await fetchPmsShadowOverview(propertyId));
    } catch (err) {
      setOverviewError(pmsShadowErrorMessage(err, "No se pudo cargar el modo sombra."));
    } finally {
      setOverviewLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  // ---- runs ----
  const [runs, setRuns] = useState<PmsShadowRunRecord[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runFeed, setRunFeed] = useState("");
  const [runStatus, setRunStatus] = useState("");

  const loadRuns = useCallback(async () => {
    if (!propertyId) return;
    setRunsLoading(true);
    setRunsError(null);
    try {
      setRuns(await listPmsShadowRuns({ feed: isPmsShadowFeed(runFeed) ? runFeed : undefined, status: runStatus ? (runStatus as PmsShadowRunStatus) : undefined, limit: RUNS_LIMIT }, propertyId));
    } catch (err) {
      setRunsError(pmsShadowErrorMessage(err, "No se pudieron cargar los cortes."));
    } finally {
      setRunsLoading(false);
    }
  }, [propertyId, runFeed, runStatus]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  // ---- alerts ----
  const [alerts, setAlerts] = useState<PmsShadowAlertRecord[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  // FUX-7B-04: the API has no «all» mode (omitted → open only, `false` → resolved only): a select, not a switch.
  const [alertsView, setAlertsView] = useState<"open" | "resolved">("open");
  const onlyOpen = alertsView === "open";
  const [alertCode, setAlertCode] = useState("");

  const loadAlerts = useCallback(async () => {
    if (!propertyId) return;
    setAlertsLoading(true);
    setAlertsError(null);
    try {
      setAlerts(await listPmsShadowAlerts({ open: onlyOpen, code: alertCode ? (alertCode as PmsShadowAlertCode) : undefined, limit: ALERTS_LIMIT }, propertyId));
    } catch (err) {
      setAlertsError(pmsShadowErrorMessage(err, "No se pudieron cargar las alertas."));
    } finally {
      setAlertsLoading(false);
    }
  }, [propertyId, onlyOpen, alertCode]);

  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts]);

  // ---- reconciliation ----
  const [reconDate, setReconDate] = useState<string>(() => isoDate(new Date()) ?? "");
  const [recon, setRecon] = useState<PmsShadowReconciliation | null>(null);
  const [reconLoading, setReconLoading] = useState(false);
  const [reconError, setReconError] = useState<string | null>(null);

  const loadReconciliation = useCallback(
    async (businessDate: string) => {
      if (!propertyId || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return;
      setReconLoading(true);
      setReconError(null);
      try {
        setRecon(await fetchPmsShadowReconciliation(businessDate as IsoDate, propertyId));
      } catch (err) {
        setRecon(null);
        setReconError(pmsShadowErrorMessage(err, "No se pudo calcular la reconciliación del día."));
      } finally {
        setReconLoading(false);
      }
    },
    [propertyId]
  );

  useEffect(() => {
    if (canReadAccounting) void loadReconciliation(reconDate);
    // Only the first load and a property change: the date field asks with «Consultar».
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadReconciliation, canReadAccounting]);

  // ---- revenue lots ----
  const [revenue, setRevenue] = useState<PmsShadowRevenueImportRecord[]>([]);
  const [revenueLoading, setRevenueLoading] = useState(false);
  const [revenueError, setRevenueError] = useState<string | null>(null);

  const loadRevenue = useCallback(async () => {
    if (!propertyId || !canReadAccounting) return;
    setRevenueLoading(true);
    setRevenueError(null);
    try {
      setRevenue(await listPmsShadowRevenueImports({ limit: REVENUE_LIMIT }, propertyId));
    } catch (err) {
      setRevenueError(pmsShadowErrorMessage(err, "No se pudieron cargar los lotes de ingresos."));
    } finally {
      setRevenueLoading(false);
    }
  }, [propertyId, canReadAccounting]);

  useEffect(() => {
    void loadRevenue();
  }, [loadRevenue]);

  function refreshAll() {
    void loadOverview();
    void loadRuns();
    void loadAlerts();
    void loadRevenue();
    if (canReadAccounting) void loadReconciliation(reconDate);
  }

  // ---- manual upload dialog ----
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFeed, setUploadFeed] = useState<PmsShadowFeed>("revenue");
  const [uploadDate, setUploadDate] = useState("");
  const [uploadForce, setUploadForce] = useState(false);
  const [uploadFile, setUploadFile] = useState<PickedFile | null>(null);
  const [uploadFileError, setUploadFileError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  function openUpload(feed: PmsShadowFeed) {
    setUploadFeed(feed);
    setUploadDate("");
    setUploadForce(false);
    setUploadFile(null);
    setUploadFileError(null);
    setUploadError(null);
    setUploadOpen(true);
  }

  /** «Subir corte manual» of a feed row: reservation feeds with confirmed columns go to the wizard in sync mode, revenue / stats to the dialog; phase-2 and sample-pending feeds are disabled (FUX-7B-06, FUX-7B-08). */
  function manualUpload(feed: PmsShadowFeed) {
    if (!manualUploadAvailable(feed)) return;
    if (isReservationFeed(feed)) {
      // SC-07: the pre-filled date follows the feed's businessDateOffset (departures → yesterday by default).
      openTabPath(buildSyncImportUrl({ feed, businessDate: feedBusinessDateFor(feed, profile?.schedule.feeds ?? [], isoDate(new Date())) }, wizardPath()));
      return;
    }
    openUpload(feed);
  }

  function manualUploadAvailable(feed: PmsShadowFeed): boolean {
    if (PHASE_TWO_FEEDS.includes(feed)) return false;
    if (isReservationFeed(feed)) return WIZARD_FEEDS.includes(feed);
    return UPLOAD_FEEDS.includes(feed) && profile !== null;
  }

  function manualUploadTitle(feed: PmsShadowFeed): string {
    if (PHASE_TWO_FEEDS.includes(feed)) return "Fase 2: el API no procesa este feed todavía (perfiles y delta OHIP)";
    if (isReservationFeed(feed) && !WIZARD_FEEDS.includes(feed)) return "Pendiente de la muestra real del informe: el perfil OPERA aún no tiene las columnas de este feed";
    if (isReservationFeed(feed)) return "Abre el asistente de importación en modo sincronizar con el perfil OPERA Cloud";
    return profile ? "Sube el fichero de este feed" : "Crea el perfil de mapeo antes de subir cortes";
  }

  async function pickUploadFile(picked: File) {
    setUploadFileError(null);
    try {
      setUploadFile({ name: picked.name, contentBase64: base64OfArrayBuffer(await picked.arrayBuffer()), bytes: picked.size });
    } catch {
      setUploadFile(null);
      setUploadFileError("El fichero no se pudo leer.");
    }
  }

  async function confirmUpload() {
    if (!uploadFile || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      const result = await uploadPmsShadowRun(
        {
          feed: uploadFeed,
          fileName: uploadFile.name,
          contentBase64: uploadFile.contentBase64,
          ...(uploadDate ? { businessDate: uploadDate as IsoDate } : {}),
          ...(uploadForce ? { force: true } : {})
        },
        propertyId
      );
      showToast(uploadSummary(result), { variant: result.status === "failed" ? "error" : result.status === "partial" ? "warning" : "success" });
      setUploadOpen(false);
      refreshAll();
    } catch (err) {
      setUploadError(pmsShadowErrorMessage(err, "No se pudo registrar el corte."));
    } finally {
      setUploading(false);
    }
  }

  // ---- resolve alert dialog ----
  const [resolveTarget, setResolveTarget] = useState<PmsShadowAlertRecord | null>(null);
  const [resolveNote, setResolveNote] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  function openResolve(alert: PmsShadowAlertRecord) {
    setResolveTarget(alert);
    setResolveNote("");
    setResolveError(null);
  }

  async function confirmResolve() {
    if (!resolveTarget || resolving || !resolveNote.trim()) return;
    setResolving(true);
    setResolveError(null);
    try {
      await resolvePmsShadowAlert(resolveTarget.id, resolveNote.trim(), propertyId);
      showToast("Alerta resuelta.", { variant: "success" });
      setResolveTarget(null);
      void loadAlerts();
      void loadOverview();
    } catch (err) {
      setResolveError(pmsShadowErrorMessage(err, "No se pudo resolver la alerta."));
    } finally {
      setResolving(false);
    }
  }

  // ---- reverse revenue dialog ----
  const [reverseTarget, setReverseTarget] = useState<PmsShadowRevenueImportRecord | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reversing, setReversing] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);

  function openReverse(record: PmsShadowRevenueImportRecord) {
    setReverseTarget(record);
    setReverseReason("");
    setReverseError(null);
  }

  async function confirmReverse() {
    if (!reverseTarget || reversing || !reverseReason.trim()) return;
    setReversing(true);
    setReverseError(null);
    try {
      const reversed = await reversePmsShadowRevenue(reverseTarget.id, { reason: reverseReason.trim() }, propertyId);
      showToast(`Ingresos del ${date(reversed.businessDate)} revertidos.`, { variant: "success" });
      setReverseTarget(null);
      void loadRevenue();
      void loadOverview();
    } catch (err) {
      setReverseError(pmsShadowErrorMessage(err, "No se pudo revertir el lote de ingresos."));
    } finally {
      setReversing(false);
    }
  }

  // ---- profile drawer ----
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFromProfile(null));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function openDrawer() {
    setDraft(draftFromProfile(overview?.profile ?? null));
    setSaveError(null);
    setDrawerOpen(true);
  }

  function closeDrawer() {
    if (!saving) setDrawerOpen(false);
  }

  function patchDraft(patch: Partial<ProfileDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function patchDictionaryRow(key: DictionaryKey, id: string, patch: Partial<DictionaryDraftRow>) {
    setDraft((current) => ({ ...current, dictionaries: { ...current.dictionaries, [key]: current.dictionaries[key].map((row) => (row.id === id ? { ...row, ...patch } : row)) } }));
  }

  function addDictionaryRow(key: DictionaryKey) {
    setDraft((current) => ({ ...current, dictionaries: { ...current.dictionaries, [key]: [...current.dictionaries[key], { id: draftId(), key: "", value: "" }] } }));
  }

  function removeDictionaryRow(key: DictionaryKey, id: string) {
    setDraft((current) => ({ ...current, dictionaries: { ...current.dictionaries, [key]: current.dictionaries[key].filter((row) => row.id !== id) } }));
  }

  function patchTrxRow(id: string, patch: Partial<TrxDraftRow>) {
    setDraft((current) => ({ ...current, trx: current.trx.map((row) => (row.id === id ? { ...row, ...patch } : row)) }));
  }

  function addTrxRow() {
    setDraft((current) => ({ ...current, trx: [...current.trx, { id: draftId(), code: "", kind: "revenue" }] }));
  }

  function removeTrxRow(id: string) {
    setDraft((current) => ({ ...current, trx: current.trx.filter((row) => row.id !== id) }));
  }

  function patchScheduleRow(id: string, patch: Partial<ScheduleDraftRow>) {
    setDraft((current) => ({ ...current, schedule: current.schedule.map((row) => (row.id === id ? { ...row, ...patch } : row)) }));
  }

  function addScheduleRow() {
    setDraft((current) => ({ ...current, schedule: [...current.schedule, { id: draftId(), feed: "arrivals", expectedTime: "06:30", businessDateOffset: 0, required: true }] }));
  }

  function removeScheduleRow(id: string) {
    setDraft((current) => ({ ...current, schedule: current.schedule.filter((row) => row.id !== id) }));
  }

  const draftValid = draft.operaHotelCode.trim().length > 0 && draft.schedule.every((row) => /^([01]\d|2[0-3]):[0-5]\d$/.test(row.expectedTime));

  async function saveProfile() {
    if (!canWrite || saving || !draftValid) return;
    setSaving(true);
    setSaveError(null);
    try {
      const mappingJson: Record<string, unknown> = {};
      for (const key of DICTIONARY_KEYS) mappingJson[key] = rowsToDictionary(draft.dictionaries[key]);
      const pseudo = draft.pseudoRoomTypes
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (pseudo.length > 0) mappingJson.pseudoRoomTypes = pseudo;
      const saved = await savePmsShadowProfile(
        {
          operaHotelCode: draft.operaHotelCode.trim(),
          status: draft.status,
          mappingJson,
          trxMappingJson: trxRowsToMapping(draft.trx),
          scheduleJson: { feeds: draft.schedule.map(({ id: _id, ...feed }) => feed) },
          inboxEmail: draft.inboxEmail.trim() || null,
          sftpFolder: draft.sftpFolder.trim() || null
        },
        propertyId
      );
      const unmapped = unmappedTrxCount(saved.trxMapping);
      showToast(unmapped > 0 ? `Perfil guardado · ${plural(unmapped, "transaction code sin mapear", "transaction codes sin mapear")}.` : "Perfil guardado.", { variant: unmapped > 0 ? "warning" : "success" });
      setDrawerOpen(false);
      refreshAll();
    } catch (err) {
      setSaveError(pmsShadowErrorMessage(err, STATUS_LABELS.saveError));
    } finally {
      setSaving(false);
    }
  }

  // ---- derived ----
  const profile = overview?.profile ?? null;
  const degraded = overview?.degraded ?? null;
  const kpis = useMemo(() => (overview ? overviewKpis(overview) : []), [overview]);
  const trxGroups = useMemo(() => groupTrxMapping(profile?.trxMapping), [profile]);
  const unmappedTotal = unmappedTrxCount(profile?.trxMapping);
  const feedRows = overview?.feeds ?? [];
  const openAlerts = alerts.filter((alert) => !alert.resolvedAt).length;
  const pageState: "empty" | "loading" | "error" | "ready" = !propertyId ? "empty" : overviewLoading && !overview ? "loading" : overviewError && !overview ? "error" : "ready";

  const dictionaryColumns = (key: DictionaryKey): CocoaTableColumn<DictionaryDraftRow>[] => [
    {
      key: "key",
      label: DICTIONARY_LABELS[key].opera,
      render: (row) => <CocoaInput size="small" value={row.key} onChange={(value) => patchDictionaryRow(key, row.id, { key: value })} placeholder="Código OPERA" aria-label={`${DICTIONARY_LABELS[key].opera} de la fila`} disabled={saving} maxLength={80} />
    },
    {
      key: "value",
      label: DICTIONARY_LABELS[key].anfitorio,
      render: (row) => <CocoaInput size="small" value={row.value} onChange={(value) => patchDictionaryRow(key, row.id, { value })} placeholder={`Código de ${BRAND.name}`} aria-label={`${DICTIONARY_LABELS[key].anfitorio} de la fila`} disabled={saving} maxLength={80} />
    },
    {
      key: "state",
      label: "Estado",
      fit: true,
      render: (row) =>
        row.value.trim() ? (
          <CocoaBadge tone="success" size="small">
            Mapeado
          </CocoaBadge>
        ) : (
          <CocoaBadge tone="warning" size="small">
            Sin mapear
          </CocoaBadge>
        )
    }
  ];

  const trxColumns: CocoaTableColumn<TrxDraftRow>[] = [
    { key: "code", label: "Transaction code", fit: true, render: (row) => <CocoaInput size="small" value={row.code} onChange={(value) => patchTrxRow(row.id, { code: value })} placeholder="1000" aria-label="Transaction code" disabled={saving} maxLength={40} /> },
    { key: "description", label: "Descripción OPERA", render: (row) => <CocoaInput size="small" value={row.description ?? ""} onChange={(value) => patchTrxRow(row.id, { description: value })} placeholder="Room Revenue" aria-label="Descripción del transaction code" disabled={saving} maxLength={200} /> },
    { key: "kind", label: "Naturaleza", fit: true, render: (row) => <CocoaSelect size="small" inline value={row.kind} onChange={(value) => patchTrxRow(row.id, { kind: value as PmsShadowTrxKind })} options={trxKindOptions()} aria-label="Naturaleza contable" disabled={saving} /> },
    { key: "accountCode", label: "Cuenta PGC", fit: true, render: (row) => <CocoaInput size="small" value={row.accountCode ?? ""} onChange={(value) => patchTrxRow(row.id, { accountCode: value })} placeholder={row.kind === "tax" ? "477.10" : row.kind === "payment" ? "570" : "705.1"} aria-label="Cuenta PGC" disabled={saving || row.kind === "ignore"} maxLength={20} /> },
    {
      key: "usali",
      label: "USALI",
      fit: true,
      render: (row) => (row.kind === "revenue" ? <CocoaSelect size="small" inline value={row.usaliDepartment ?? ""} onChange={(value) => patchTrxRow(row.id, { usaliDepartment: value ? (value as PmsShadowUsaliRevenueDepartment) : undefined })} options={usaliDepartmentOptions()} aria-label="Departamento USALI" disabled={saving} /> : EMPTY)
    },
    {
      key: "state",
      label: "Estado",
      fit: true,
      render: (row) =>
        isTrxMappingComplete(row) ? (
          <CocoaBadge tone="success" size="small">
            Mapeado
          </CocoaBadge>
        ) : (
          <CocoaBadge tone="warning" size="small">
            Sin mapear
          </CocoaBadge>
        )
    }
  ];

  const scheduleColumns: CocoaTableColumn<ScheduleDraftRow>[] = [
    { key: "feed", label: "Feed", fit: true, render: (row) => <CocoaSelect size="small" inline value={row.feed} onChange={(value) => patchScheduleRow(row.id, { feed: isPmsShadowFeed(value) ? value : row.feed })} options={feedOptions()} aria-label="Feed programado" disabled={saving} /> },
    { key: "expectedTime", label: "Hora esperada", fit: true, render: (row) => <CocoaInput size="small" type="time" value={row.expectedTime} onChange={(value) => patchScheduleRow(row.id, { expectedTime: value })} aria-label="Hora esperada (hora local del hotel)" disabled={saving} /> },
    { key: "offset", label: "Fecha de negocio", fit: true, render: (row) => <CocoaSelect size="small" inline value={String(row.businessDateOffset)} onChange={(value) => patchScheduleRow(row.id, { businessDateOffset: value === "-1" ? -1 : 0 })} options={OFFSET_OPTIONS} aria-label="Desfase de la fecha de negocio" disabled={saving} /> },
    { key: "required", label: "Obligatorio", fit: true, render: (row) => <CocoaSwitch checked={row.required} onChange={(value) => patchScheduleRow(row.id, { required: value })} size="small" aria-label="Avisar si no llega" disabled={saving} /> }
  ];

  return (
    <CocoaPage
      eyebrow={HEADER.eyebrow}
      title={HEADER.title}
      subtitle={hosted ? undefined : "OPERA Cloud sigue siendo el sistema de registro: cada día llega un corte de reservas, los ingresos por transaction code y las cifras del cuadre. Aquí se vigilan los feeds, se resuelven las alertas y se mantiene el perfil de mapeo."}
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={openDrawer} disabled={!overview}>
            Perfil de mapeo
          </CocoaButton>
          {canWrite && canPostRevenue ? (
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openUpload("revenue")} disabled={!profile}>
              Subir fichero de ingresos
            </CocoaButton>
          ) : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll} loading={overviewLoading}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={pageState}
      skeleton={<PanelSkeleton />}
      empty={{ title: "Selecciona una propiedad", message: "El modo sombra se configura y se vigila por propiedad." }}
      error={{ title: STATUS_LABELS.loadError, message: overviewError ?? undefined, onRetry: () => void loadOverview() }}
      commands={[
        { id: "modo-sombra-refresh", label: "Actualizar el modo sombra OPERA", run: refreshAll },
        { id: "modo-sombra-perfil", label: "Abrir el perfil de mapeo de OPERA", run: openDrawer }
      ]}
    >
      {!canRead ? <p className="cocoa-note">Necesitas el permiso de lectura de integraciones para ver el modo sombra.</p> : null}
      <DegradedBanner degraded={degraded} />

      <CocoaKpiStrip aria-label="Indicadores del modo sombra">
        {kpis.map((kpi) => (
          <CocoaKpi key={kpi.key} label={kpi.label} value={kpi.value} tone={kpi.tone} caption={kpi.caption} size="compact" degraded={isDegraded(kpi.degradedLabel, degraded)} />
        ))}
      </CocoaKpiStrip>

      {overviewError && overview ? (
        <CocoaCallout tone="danger" role="alert" title={STATUS_LABELS.loadError}>
          {overviewError}
        </CocoaCallout>
      ) : null}

      {overview && !profile ? (
        <CocoaCallout
          tone="warning"
          title="Esta propiedad todavía no tiene perfil de modo sombra"
          actions={
            canWrite ? (
              <CocoaButton variant="filled" tone="accent" size="small" onClick={openDrawer}>
                Crear perfil de mapeo
              </CocoaButton>
            ) : undefined
          }
        >
          Indica el código de hotel de OPERA{propertyName ? ` de ${propertyName}` : ""}, los tipos de habitación y rate codes equivalentes, los transaction codes con su cuenta PGC y la hora a la que llega cada corte. Sin perfil no se ingiere ningún fichero.
        </CocoaCallout>
      ) : null}

      {profile ? (
        <CocoaCallout tone={profile.status === "active" ? "neutral" : "warning"} title={`Perfil ${profile.operaHotelCode} · ${profileSummary(profile)}`}>
          <div className="cocoa-cluster">
            <CocoaBadge tone={profileStatusTone(profile.status)} size="small">
              {profile.status === "active" ? STATUS_LABELS.active : "En pausa"}
            </CocoaBadge>
            {unmappedTotal > 0 ? (
              <CocoaBadge tone="warning" size="small">
                {plural(unmappedTotal, "transaction code sin mapear", "transaction codes sin mapear")}
              </CocoaBadge>
            ) : null}
            <span className="cocoa-note">
              {profile.inboxEmail ? `Buzón ${profile.inboxEmail}` : "Sin buzón de correo"} · {profile.sftpFolder ? `carpeta SFTP ${profile.sftpFolder}` : "sin carpeta SFTP"} · {plural(profile.schedule.feeds.length, "feed programado", "feeds programados")}
            </span>
          </div>
        </CocoaCallout>
      ) : null}

      <CocoaSection
        title="Feeds"
        meta={feedRows.length > 0 ? plural(feedRows.length, "feed", "feeds") : undefined}
        action={
          canWrite ? (
            <CocoaButton variant="plain" tone="accent" size="small" onClick={() => openUpload("stats")} disabled={!profile}>
              Subir corte manual
            </CocoaButton>
          ) : undefined
        }
      >
        <CocoaTable
          columns={FEED_COLUMNS_BASE}
          rows={feedRows}
          rowKey="feed"
          density="compact"
          rowTone={(row) => (row.state === "late" ? "warning" : row.state === "failed" ? "danger" : undefined)}
          rowActionsVisible="always"
          rowActions={(row) =>
            canWrite ? (
              <CocoaButton variant="plain" tone="accent" size="small" disabled={!manualUploadAvailable(row.feed)} onClick={() => manualUpload(row.feed)} title={manualUploadTitle(row.feed)}>
                Subir corte manual
              </CocoaButton>
            ) : null
          }
          emptyState="Sin feeds programados ni recibidos: programa los cortes en el perfil de mapeo."
          caption="Feeds del modo sombra"
          aria-label="Feeds del modo sombra y su último corte"
        />
      </CocoaSection>

      <CocoaSection
        title="Cortes recientes"
        meta={runs.length > 0 ? plural(runs.length, "corte", "cortes") : undefined}
        action={
          <div className="cocoa-cluster">
            <CocoaSelect size="small" inline value={runFeed} onChange={setRunFeed} options={feedOptions({ withAll: true })} aria-label="Filtrar cortes por feed" disabled={runsLoading} />
            <CocoaSelect size="small" inline value={runStatus} onChange={setRunStatus} options={runStatusOptions()} aria-label="Filtrar cortes por estado" disabled={runsLoading} />
            <CocoaButton variant="plain" tone="neutral" size="small" loading={runsLoading} onClick={() => void loadRuns()}>
              {ACTIONS.refresh}
            </CocoaButton>
          </div>
        }
      >
        {runsError ? (
          <CocoaCallout tone="danger" role="alert" title="No se pudieron cargar los cortes">
            {runsError}
          </CocoaCallout>
        ) : (
          <CocoaTable
            columns={RUN_COLUMNS}
            rows={runs}
            rowKey="id"
            density="compact"
            loading={runsLoading && runs.length === 0}
            virtualize
            maxHeight={TABLE_MAX_HEIGHT}
            rowTone={(row) => (row.status === "failed" ? "danger" : row.status === "partial" ? "warning" : undefined)}
            rowTitle={(row) => (row.alerts.length > 0 ? row.alerts.map((alert) => alert.message).join(" · ") : row.errorMessage ?? undefined)}
            rowActionsVisible="always"
            rowActions={(row) =>
              row.reservationImportId ? (
                <CocoaButton variant="plain" tone="accent" size="small" onClick={() => openTabPath(importLotPath(row.reservationImportId ?? ""))} title="Abre el lote en el asistente de importación de reservas">
                  Ver lote
                </CocoaButton>
              ) : null
            }
            emptyState="Todavía no se ha recibido ningún corte con esos filtros."
            caption="Cortes recientes"
            aria-label="Cortes recientes del modo sombra"
          />
        )}
      </CocoaSection>

      <CocoaSection
        title="Reconciliación del día"
        meta={recon ? reconciliationSummary(recon.rows) : undefined}
        action={
          canReadAccounting ? (
            <div className="cocoa-cluster">
              <CocoaInput size="small" type="date" value={reconDate} onChange={setReconDate} aria-label="Fecha de negocio a conciliar" disabled={reconLoading} />
              <CocoaButton variant="plain" tone="accent" size="small" loading={reconLoading} disabled={!/^\d{4}-\d{2}-\d{2}$/.test(reconDate)} onClick={() => void loadReconciliation(reconDate)}>
                Consultar
              </CocoaButton>
            </div>
          ) : undefined
        }
      >
        {!canReadAccounting ? (
          <CocoaState kind="empty" inline title="La reconciliación exige el permiso de lectura contable." />
        ) : reconError ? (
          <CocoaCallout tone="danger" role="alert" title="No se pudo calcular la reconciliación">
            {reconError}
          </CocoaCallout>
        ) : recon ? (
          <div className="cocoa-stack" data-gap="3">
            <CocoaCallout tone={recon.ok ? "success" : "warning"} role="status" title={recon.ok ? `El ${date(recon.businessDate)} cuadra con OPERA` : `El ${date(recon.businessDate)} tiene ${plural(recon.mismatches.count + recon.mismatches.revenue, "desviación", "desviaciones")}`}>
              {recon.sources.statsRunId ? "Cifras declaradas por el corte de estadísticas del día" : "OPERA todavía no ha declarado las cifras del día (corte de estadísticas pendiente)"}
              {recon.sources.revenueImportId ? ` · ingresos ${revenueStatusLabel(recon.sources.revenueStatus ?? "draft").toLowerCase()}` : " · sin lote de ingresos del día"}.
            </CocoaCallout>
            <CocoaTable columns={RECON_COLUMNS} rows={recon.rows} rowKey="metric" density="compact" rowTone={(row) => (row.status === "mismatch" ? "danger" : undefined)} emptyState="Sin métricas para ese día." caption="Reconciliación del día" aria-label={`Reconciliación del día: OPERA frente a ${BRAND.name}`} />
          </div>
        ) : (
          <CocoaState kind={reconLoading ? "loading" : "empty"} inline title={reconLoading ? STATUS_LABELS.loading : "Elige una fecha de negocio y pulsa Consultar."} />
        )}
      </CocoaSection>

      <CocoaSection
        title="Alertas"
        meta={alerts.length > 0 ? `${plural(alerts.length, "alerta", "alertas")} · ${plural(openAlerts, "abierta", "abiertas")}` : undefined}
        action={
          <div className="cocoa-cluster">
            <CocoaSelect value={alertsView} onChange={(value) => setAlertsView(value === "resolved" ? "resolved" : "open")} options={ALERT_VIEW_OPTIONS} disabled={alertsLoading} aria-label="Alertas abiertas o resueltas" />
            <CocoaSelect size="small" inline value={alertCode} onChange={setAlertCode} options={alertCodeOptions()} aria-label="Filtrar alertas por código" disabled={alertsLoading} />
            <CocoaButton variant="plain" tone="neutral" size="small" loading={alertsLoading} onClick={() => void loadAlerts()}>
              {ACTIONS.refresh}
            </CocoaButton>
          </div>
        }
      >
        {alertsError ? (
          <CocoaCallout tone="danger" role="alert" title="No se pudieron cargar las alertas">
            {alertsError}
          </CocoaCallout>
        ) : (
          <CocoaTable
            columns={ALERT_COLUMNS}
            rows={alerts}
            rowKey="id"
            density="compact"
            loading={alertsLoading && alerts.length === 0}
            virtualize
            maxHeight={TABLE_MAX_HEIGHT}
            rowTone={(row) => (row.resolvedAt ? undefined : row.severity === "error" ? "danger" : "warning")}
            rowTitle={(row) => [row.message, ...alertDetailLines(row)].join(" · ")}
            rowActionsVisible="always"
            rowActions={(row) =>
              !row.resolvedAt && canWrite ? (
                <CocoaButton variant="plain" tone="accent" size="small" onClick={() => openResolve(row)}>
                  Resolver
                </CocoaButton>
              ) : null
            }
            emptyState={onlyOpen ? "Ninguna alerta abierta." : "Ninguna alerta resuelta con esos filtros."}
            caption="Alertas del modo sombra"
            aria-label="Alertas del modo sombra"
          />
        )}
      </CocoaSection>

      <CocoaSection
        title="Ingresos diarios"
        meta={revenue.length > 0 ? plural(revenue.length, "lote", "lotes") : undefined}
        action={
          canReadAccounting ? (
            <CocoaButton variant="plain" tone="neutral" size="small" loading={revenueLoading} onClick={() => void loadRevenue()}>
              {ACTIONS.refresh}
            </CocoaButton>
          ) : undefined
        }
      >
        {!canReadAccounting ? (
          <CocoaState kind="empty" inline title="Los lotes de ingresos exigen el permiso de lectura contable." />
        ) : revenueError ? (
          <CocoaCallout tone="danger" role="alert" title="No se pudieron cargar los lotes de ingresos">
            {revenueError}
          </CocoaCallout>
        ) : (
          <CocoaTable
            columns={REVENUE_COLUMNS}
            rows={revenue}
            rowKey="id"
            density="compact"
            loading={revenueLoading && revenue.length === 0}
            rowTone={(row) => (row.status === "reversed" ? "neutral" : undefined)}
            rowTitle={(row) => (row.warnings.length > 0 ? row.warnings.join(" · ") : undefined)}
            rowActionsVisible="always"
            rowActions={(row) =>
              row.status === "posted" && canPostRevenue ? (
                <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => openReverse(row)}>
                  {ACTIONS.revert}
                </CocoaButton>
              ) : null
            }
            emptyState="Ningún día de ingresos contabilizado todavía: sube el XML de Revenue o el informe findeptcodes."
            caption="Lotes de ingresos diarios"
            aria-label="Lotes de ingresos diarios de OPERA"
          />
        )}
      </CocoaSection>

      <CocoaDialog
        open={uploadOpen}
        onClose={() => {
          if (!uploading) setUploadOpen(false);
        }}
        title="Subir corte manual"
        description="El fichero se procesa al momento y no se guarda: solo queda el corte con sus contadores y sus alertas."
        confirmLabel="Registrar corte"
        cancelLabel={ACTIONS.cancel}
        busy={uploading}
        confirmDisabled={!uploadFile}
        onConfirm={() => void confirmUpload()}
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaFormRow columns={2}>
            <CocoaField label="Feed" help={feedDescription(uploadFeed)}>
              <CocoaSelect value={uploadFeed} onChange={(value) => setUploadFeed(isPmsShadowFeed(value) ? value : "revenue")} options={feedOptions({ only: UPLOAD_FEEDS })} disabled={uploading} />
            </CocoaField>
            <CocoaField label="Fecha de negocio" hint="opcional" help="Sin fecha, el API la toma del fichero o de la fecha de negocio de la propiedad.">
              <CocoaInput type="date" value={uploadDate} onChange={setUploadDate} disabled={uploading} />
            </CocoaField>
          </CocoaFormRow>
          <div className="cocoa-row">
            <CocoaFileInput accept={UPLOAD_ACCEPT} maxBytes={UPLOAD_MAX_BYTES} fileName={uploadFile?.name ?? null} onPick={(picked) => void pickUploadFile(picked)} onReject={setUploadFileError} disabled={uploading} label="Elegir fichero" />
            {uploadFile ? (
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setUploadFile(null)} disabled={uploading}>
                Quitar fichero
              </CocoaButton>
            ) : null}
          </div>
          <CocoaSwitch checked={uploadForce} onChange={setUploadForce} label="Subir de todos modos (mismo fichero, feed y día ya registrados)" size="small" disabled={uploading} />
          {uploadFileError ? (
            <CocoaCallout tone="danger" role="alert" title="No se pudo leer el fichero">
              {uploadFileError}
            </CocoaCallout>
          ) : null}
          {uploadError ? (
            <CocoaCallout tone="danger" role="alert" title="No se pudo registrar el corte">
              {uploadError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDialog>

      <CocoaDialog
        open={resolveTarget !== null}
        onClose={() => {
          if (!resolving) setResolveTarget(null);
        }}
        title={resolveTarget ? `Resolver «${alertCodeLabel(resolveTarget.code)}»` : "Resolver alerta"}
        description={resolveTarget ? [resolveTarget.message, ...alertDetailLines(resolveTarget)].join(" · ") : undefined}
        confirmLabel="Resolver"
        cancelLabel={ACTIONS.cancel}
        busy={resolving}
        confirmDisabled={!resolveNote.trim()}
        onConfirm={() => void confirmResolve()}
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Motivo" required help="Queda registrado en la alerta y en la auditoría.">
            <CocoaInput value={resolveNote} onChange={setResolveNote} multiline rows={3} maxLength={NOTE_MAX} placeholder="Comprobado en OPERA: la reserva se movió fuera de la ventana" disabled={resolving} />
          </CocoaField>
          {resolveError ? (
            <CocoaCallout tone="danger" role="alert" title="No se pudo resolver">
              {resolveError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDialog>

      <CocoaDialog
        open={reverseTarget !== null}
        onClose={() => {
          if (!reversing) setReverseTarget(null);
        }}
        tone="destructive"
        title={reverseTarget ? `Revertir los ingresos del ${date(reverseTarget.businessDate)}` : "Revertir ingresos"}
        description="Se contabiliza un asiento de reverso del asiento diario de OPERA; el lote queda como revertido y el día se puede volver a importar. Nada se borra."
        confirmLabel={ACTIONS.revert}
        cancelLabel={ACTIONS.cancel}
        busy={reversing}
        confirmDisabled={!reverseReason.trim()}
        onConfirm={() => void confirmReverse()}
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Motivo" required help="Queda en el lote y en el asiento de reverso.">
            <CocoaInput value={reverseReason} onChange={setReverseReason} multiline rows={3} maxLength={NOTE_MAX} placeholder="Fichero de Revenue regenerado por OPERA" disabled={reversing} />
          </CocoaField>
          {reverseError ? (
            <CocoaCallout tone="danger" role="alert" title="No se pudo revertir">
              {reverseError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDialog>

      <CocoaDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        title="Perfil de mapeo"
        subtitle={profile ? `${profile.operaHotelCode} · actualizado ${dateTime(profile.updatedAt)}` : "Primer perfil de modo sombra de la propiedad"}
        side="right"
        size="lg"
        dismissible={!saving}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={closeDrawer} disabled={saving}>
              {ACTIONS.cancel}
            </CocoaButton>
            {canWrite ? (
              <CocoaButton variant="filled" tone="accent" onClick={() => void saveProfile()} loading={saving} disabled={!draftValid}>
                {ACTIONS.save}
              </CocoaButton>
            ) : null}
          </>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          {!canWrite ? <p className="cocoa-note">Solo lectura: editar el perfil exige el permiso de conectar integraciones.</p> : null}
          <CocoaFormRow columns={2}>
            <CocoaField label="Código de hotel OPERA" required help="Hotel Code de Property Controls; el XML de Revenue trae el mismo código.">
              <CocoaInput value={draft.operaHotelCode} onChange={(value) => patchDraft({ operaHotelCode: value })} placeholder="RIAS" maxLength={20} disabled={saving || !canWrite} />
            </CocoaField>
            <CocoaField label="Estado" help="En pausa no se ingiere ningún corte ni se vigila la puntualidad de los feeds.">
              <CocoaSelect value={draft.status} onChange={(value) => patchDraft({ status: value === "paused" ? "paused" : "active" })} options={profileStatusOptions()} disabled={saving || !canWrite} />
            </CocoaField>
            <CocoaField label="Buzón de correo" hint="opcional" help="Dirección a la que el Report Scheduler de OPERA envía los informes.">
              <CocoaInput value={draft.inboxEmail} onChange={(value) => patchDraft({ inboxEmail: value })} placeholder="opera-ra@example.com" inputMode="email" maxLength={200} disabled={saving || !canWrite} />
            </CocoaField>
            <CocoaField label="Carpeta SFTP" hint="opcional" help="Carpeta del VPS que recorre pms-shadow:pull.">
              <CocoaInput value={draft.sftpFolder} onChange={(value) => patchDraft({ sftpFolder: value })} placeholder="/srv/sftp/rias/incoming" maxLength={200} disabled={saving || !canWrite} />
            </CocoaField>
            <CocoaField label="Pseudo rooms" hint="opcional" fullWidth help="Room types de OPERA que no son inventario (PM, HOUSE…), separados por comas: sus filas se omiten con aviso.">
              <CocoaInput value={draft.pseudoRoomTypes} onChange={(value) => patchDraft({ pseudoRoomTypes: value })} placeholder="PM, HOUSE" disabled={saving || !canWrite} />
            </CocoaField>
          </CocoaFormRow>

          {DICTIONARY_KEYS.map((key) => (
            <CocoaSection
              key={key}
              headingLevel={3}
              title={DICTIONARY_LABELS[key].title}
              meta={draft.dictionaries[key].length > 0 ? `${plural(draft.dictionaries[key].filter((row) => !row.value.trim()).length, "sin mapear", "sin mapear")}` : undefined}
              action={
                canWrite ? (
                  <CocoaButton variant="plain" tone="accent" size="small" onClick={() => addDictionaryRow(key)} disabled={saving}>
                    Añadir fila
                  </CocoaButton>
                ) : undefined
              }
            >
              <CocoaTable
                columns={dictionaryColumns(key)}
                rows={draft.dictionaries[key]}
                rowKey="id"
                density="compact"
                rowActions={(row) =>
                  canWrite ? (
                    <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => removeDictionaryRow(key, row.id)} disabled={saving}>
                      {ACTIONS.remove}
                    </CocoaButton>
                  ) : null
                }
                emptyState={`Sin ${DICTIONARY_LABELS[key].title.toLowerCase()} mapeados: sin entrada, la fila usa el valor plegado o el valor por defecto con aviso.`}
                caption={DICTIONARY_LABELS[key].title}
                aria-label={`${DICTIONARY_LABELS[key].title}: código OPERA a código de ${BRAND.name}`}
              />
            </CocoaSection>
          ))}

          <CocoaSection
            headingLevel={3}
            title="Transaction codes"
            meta={draft.trx.length > 0 ? `${plural(draft.trx.length, "código", "códigos")} · ${plural(draft.trx.filter((row) => !isTrxMappingComplete(row)).length, "sin mapear", "sin mapear")}` : undefined}
            action={
              canWrite ? (
                <CocoaButton variant="plain" tone="accent" size="small" onClick={addTrxRow} disabled={saving}>
                  Añadir transaction code
                </CocoaButton>
              ) : undefined
            }
          >
            <div className="cocoa-stack" data-gap="3">
              <p className="cocoa-note">Cada transaction code de OPERA va a una cuenta PGC (705.x ingresos, 477.x impuestos, 57x cobros) y, si es ingreso, a su departamento USALI. Un código sin mapear bloquea la contabilización del día hasta completarlo.</p>
              <CocoaTable
                columns={trxColumns}
                rows={draft.trx}
                rowKey="id"
                density="compact"
                rowTone={(row) => (isTrxMappingComplete(row) ? undefined : "warning")}
                rowActions={(row) =>
                  canWrite ? (
                    <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => removeTrxRow(row.id)} disabled={saving}>
                      {ACTIONS.remove}
                    </CocoaButton>
                  ) : null
                }
                emptyState="Sin transaction codes: el primer fichero de ingresos los lista en la alerta «Transaction code sin mapear»."
                caption="Transaction codes de OPERA y su cuenta"
                aria-label="Transaction codes de OPERA, cuenta PGC y departamento USALI"
              />
              {trxGroups.length > 0 ? (
                <p className="cocoa-caption">
                  Perfil guardado: {trxGroups.map((group) => `${group.label} ${number(group.rows.length)}${group.unmappedCount > 0 ? ` (${number(group.unmappedCount)} sin mapear)` : ""}`).join(" · ")} · departamentos USALI en uso: {[...new Set(trxGroups.flatMap((group) => group.rows.map((row) => row.usaliDepartment).filter(Boolean)))].map((department) => usaliDepartmentLabel(department)).join(", ") || EMPTY}
                </p>
              ) : null}
            </div>
          </CocoaSection>

          <CocoaSection
            headingLevel={3}
            title="Programación de feeds"
            meta={draft.schedule.length > 0 ? plural(draft.schedule.length, "feed", "feeds") : undefined}
            action={
              canWrite ? (
                <CocoaButton variant="plain" tone="accent" size="small" onClick={addScheduleRow} disabled={saving}>
                  Añadir feed
                </CocoaButton>
              ) : undefined
            }
          >
            <div className="cocoa-stack" data-gap="3">
              <p className="cocoa-note">Hora local del hotel a la que debería haber llegado cada fichero; un feed obligatorio sin fichero pasadas dos horas genera la alerta «Corte de OPERA no recibido a la hora prevista».</p>
              <CocoaTable
                columns={scheduleColumns}
                rows={draft.schedule}
                rowKey="id"
                density="compact"
                rowActions={(row) =>
                  canWrite ? (
                    <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => removeScheduleRow(row.id)} disabled={saving}>
                      {ACTIONS.remove}
                    </CocoaButton>
                  ) : null
                }
                emptyState="Sin feeds programados: no se vigila la puntualidad."
                caption="Feeds programados"
                aria-label="Feeds programados y hora esperada"
              />
            </div>
          </CocoaSection>

          {saveError ? (
            <CocoaCallout tone="danger" role="alert" title={STATUS_LABELS.saveError}>
              {saveError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDrawer>
    </CocoaPage>
  );
}

export default PmsShadowScreen;
