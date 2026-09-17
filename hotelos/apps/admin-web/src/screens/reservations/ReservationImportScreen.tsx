// Recepción › Reservas › Importar — /recepcion/reservas/importar (Tanda 7 · L4;
// design docs/design/RESERVAS-IMPORTACION-MASIVA.md §9). A four-step wizard,
// hosted in ReservasTabs, born without inline styles (Cocoa 22 contract):
//
//   1 Fichero    CocoaFileInput (.csv / .txt / .xlsx, ≤ 5 MB) → the bytes go to
//                the API as base64 (never `file.text()`: latin1 must survive) →
//                automatic preview without mapping → step 2. Template downloads
//                (CSV / XLSX) through saveDownload, active property, notes.
//   2 Columnas   one row per column of the file: example of the sample, the
//                field select (the API proposal, editable; a field on two
//                columns is resolved client-side) and the origin badge. Every
//                change previews again (debounced 400 ms); «Aplicar y validar»
//                needs the mandatory fields mapped.
//   3 Revisión   KPI strip (válidas · avisos · errores · omitidas · histórico · a
//                crear), status filter, the rows with their verdict and issues
//                (never a value of the file in a message), availability per room
//                type (range rule of the PMS vs per-night quota), duplicates, the
//                four switches (omitir inválidas · overbooking · histórico ·
//                importar de todos modos) and the blockers. «Importar N reservas»
//                only when the API says `canImport` and the session holds
//                pms.reservation.create AND pms.reservation.modify.
//   4 Resultado  status callout, KPIs, rows with a link to each created
//                reservation, the per-row report CSV and «Deshacer importación»
//                (destructive dialog with an optional reason).
//
// «Importaciones anteriores» lists the lots of the property with «Ver» (step 4
// in read mode) and «Deshacer» (pms.reservation.modify only, like the API); its
// «Autor» is a name, never an id (importAuthorLabel over actor-label). The file
// is never stored: only the result per row (GDPR by construction, design §1.10).
//
// Ronda 1 de corrección (Tanda 7): a failed re-analysis keeps the previous
// preview on screen and only blocks «Importar» (FUX-03); the «Ejemplo» column
// shows the RAW sample cells the API now sends (FUX-04); a successful commit
// discards the spent preview so steps 2-3 cannot replay it (FUX-05); one
// CocoaLiveRegion announces the step and the analysis and the step content
// takes focus on every change of step (FUX-10).
//
// Tanda 7b (L4): modo «sincronizar». The «Modo sombra OPERA» panel opens this
// wizard with `?modo=sync&perfil=opera_cloud&feed=<feed>&fecha=<YYYY-MM-DD>`
// (window.location.search: no react-router). In that mode `mode`, `profile`,
// `feed` and `businessDate` travel in BOTH bodies (preview and commit), a
// callout names the profile, the feed and the business date (editable), the
// «Columnas» step is skipped when the profile resolves every column
// (mappingSource all `explicit`), «Revisión» paints the «Acción» column
// (crear · actualizar · sin cambios · cambio de estado · omitir) and the three
// sync counters, and «Resultado» shows the `sync` block (ausentes, conflictos,
// check-ins sin habitación). `?lote=<id>` opens a lot in read mode (the panel's
// «Ver lote»). Still born without inline styles.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ReservationImportDetail,
  ReservationImportField,
  ReservationImportFormat,
  ReservationImportMapping,
  ReservationImportOptions,
  ReservationImportPreview,
  ReservationImportPreviewRow,
  ReservationImportRecord,
  ReservationImportRowRecord,
  ReservationImportSyncResult
} from "@hotelos/shared";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaDialog,
  CocoaField,
  CocoaFileInput,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaLiveRegion,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSpan,
  CocoaStat,
  CocoaSwitch,
  CocoaTable,
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";
import { DownloadIcon } from "../../components/cocoa-icons/ActionIcons";
import { useToast } from "../../components/Toast";
import { ACTIONS } from "../../content/actions";
import { useApiData } from "../../hooks/useApiData";
import { EMPTY, date, dateRange, dateTime, isoDate, money, number, plural } from "../../lib/format";
import { urlForScreen } from "../../navigation/nav-tree";
import { useNavGate } from "../../navigation/useEnabledModules";
import { useActiveProperty } from "../../services/activeProperty";
import {
  createReservationImport,
  downloadReservationImportTemplate,
  getReservationImport,
  previewReservationImport,
  reservationImportErrorMessage,
  reservationImportsPath,
  undoReservationImport
} from "../../services/reservationImportApi";
import { useCurrentUserProfile } from "../../services/usersApi";
import { toArray } from "../../utils/toArray";
import { canDo, saveDownload } from "../accounting/accounting-ui";
import type { ActorSession } from "../accounting/actor-label";
import { useTabHost } from "../tabs/TabHost";
import {
  IMPORT_CLI_ROWS_HINT,
  IMPORT_MAX_ROWS,
  IMPORT_STEPS,
  ROW_FILTERS,
  applyMappingChoice,
  availabilityExceeded,
  availabilityLine,
  base64OfArrayBuffer,
  buildImportReportCsv,
  buildMapping,
  canUndoImport,
  detectFormatFromName,
  effectiveMapping,
  exampleForColumn,
  fieldOptions,
  fieldSelectValue,
  fileSizeLabel,
  filterRows,
  formatLabel,
  guestName,
  importAuthorLabel,
  importFileLabel,
  importStatusLabel,
  importStatusTone,
  isRowFilter,
  issuesSummary,
  issuesTitle,
  mappingSourceLabel,
  mappingSourceTone,
  missingRequiredLabels,
  previewBlockers,
  reportFileName,
  resultKpis,
  resultTitle,
  resultTone,
  rowOutcomeLabel,
  rowOutcomeTone,
  rowStatusLabel,
  rowStatusTone,
  rowsLabel,
  stepStateLabel,
  stepSummary,
  stepTone,
  summaryKpis,
  undoOutcomeLabel,
  undoSummary,
  type RowFilter
} from "./reservation-import-helpers";
import {
  SYNC_CALLOUT_HELP,
  isSyncMode,
  parseImportLotParam,
  parseSyncSearchParams,
  skipsMappingStep,
  syncActionLabel,
  syncActionTitle,
  syncActionTone,
  syncBlockers,
  syncCalloutText,
  syncImportButtonLabel,
  syncRequestFields,
  syncResultLines,
  syncResultTitle,
  syncRowOutcomeLabel,
  syncRowOutcomeTone,
  syncSummaryKpis
} from "./reservation-import-sync";

type PickedFile = { name: string; format: ReservationImportFormat; contentBase64: string; bytes: number };

/** What step 4 paints: the lot just imported (with the commit warnings and, in sync mode, the `sync` block) or a lot opened from the list. */
type ResultView = { record: ReservationImportDetail; warnings: string[]; mode: "imported" | "viewed"; sync?: ReservationImportSyncResult };

/** The four keys of the sync mode as they travel in the preview and commit bodies (`{}` in create mode). */
type SyncFields = ReturnType<typeof syncRequestFields>;

/** Outcome label / tone of a result row: the sync outcomes (updated · unchanged · transitioned) first, the Tanda 7 ones otherwise. */
function outcomeLabel(outcome: ReservationImportRowRecord["outcome"]): string {
  return syncRowOutcomeLabel(outcome) ?? rowOutcomeLabel(outcome);
}

function outcomeTone(outcome: ReservationImportRowRecord["outcome"]) {
  return syncRowOutcomeTone(outcome) ?? rowOutcomeTone(outcome);
}

type MappingRow = { column: string; field: ReservationImportField | null; source: string; example: string };

const DEFAULT_OPTIONS: ReservationImportOptions = { omitirInvalidas: false, permitirOverbooking: false, historico: false, force: false };
const PREVIEW_DEBOUNCE_MS = 400;
const LIST_LIMIT = 50;
const DETAIL_FALLBACK = "/recepcion/reservas";
const REVIEW_MAX_HEIGHT = 480;
const FILE_STEP = 0;
const COLUMNS_STEP = 1;
const REVIEW_STEP = 2;
const RESULT_STEP = 3;
const READ_FALLBACK = "El fichero no se pudo leer.";
const FIELD_OPTIONS = fieldOptions();
const NO_PROPERTY_HINT = "Selecciona una propiedad para importar.";

function openReservation(reservationId: string): void {
  openTabPath(urlForScreen("ReservationDetailWorkspace", { id: reservationId }) ?? DETAIL_FALLBACK);
}

/** «Acción» of the sync mode (Tanda 7b): what the commit will do with the row, titled with the diffed field names (never values). */
const SYNC_ACTION_COLUMN: CocoaTableColumn<ReservationImportPreviewRow> = {
  key: "action",
  label: "Acción",
  fit: true,
  render: (row) => (
    <CocoaBadge tone={syncActionTone(row.resolved?.sync?.action)} size="small" variant="tinted" uppercase={false} title={syncActionTitle(row.resolved?.sync)}>
      {syncActionLabel(row.resolved?.sync?.action)}
    </CocoaBadge>
  )
};

function reviewColumns(currency: string, syncMode = false): CocoaTableColumn<ReservationImportPreviewRow>[] {
  return [
    { key: "rowNumber", label: "Fila", fit: true, align: "right", render: (row) => number(row.rowNumber) },
    {
      key: "status",
      label: "Estado",
      fit: true,
      render: (row) => (
        <CocoaBadge tone={rowStatusTone(row.status)} size="small">
          {rowStatusLabel(row.status)}
        </CocoaBadge>
      )
    },
    ...(syncMode ? [SYNC_ACTION_COLUMN] : []),
    { key: "reference", label: "Referencia", truncate: 140, showFrom: "tablet", render: (row) => row.resolved?.externalReference ?? EMPTY },
    { key: "stay", label: "Estancia", nowrap: true, render: (row) => (row.resolved ? dateRange(row.resolved.arrivalDate, row.resolved.departureDate) : EMPTY) },
    { key: "nights", label: "Noches", fit: true, align: "right", hideOnNarrow: true, render: (row) => (row.resolved ? number(row.resolved.nights) : EMPTY) },
    { key: "roomType", label: "Tipo", fit: true, render: (row) => row.resolved?.roomTypeCode ?? EMPTY },
    { key: "ratePlan", label: "Tarifa", fit: true, showFrom: "laptop", render: (row) => row.resolved?.ratePlanCode ?? EMPTY },
    { key: "room", label: "Hab.", fit: true, showFrom: "laptop", render: (row) => row.resolved?.roomNumber ?? EMPTY },
    { key: "guest", label: "Huésped", truncate: 180, showFrom: "tablet", render: (row) => (row.normalized ? guestName(row.normalized) : EMPTY) },
    { key: "amount", label: "Importe", align: "right", render: (row) => (row.resolved ? money(row.resolved.totalAmount, currency) : EMPTY) },
    { key: "issues", label: "Incidencias", truncate: 320, render: (row) => issuesSummary(row.issues) }
  ];
}

const RESULT_COLUMNS: CocoaTableColumn<ReservationImportRowRecord>[] = [
  { key: "rowNumber", label: "Fila", fit: true, align: "right", render: (row) => number(row.rowNumber) },
  {
    key: "outcome",
    label: "Resultado",
    fit: true,
    render: (row) => (
      <CocoaBadge tone={outcomeTone(row.outcome)} size="small">
        {outcomeLabel(row.outcome)}
      </CocoaBadge>
    )
  },
  {
    key: "reservation",
    label: "Reserva",
    fit: true,
    // A sync row that updated / confirmed a reservation carries its code but no id (the reservation belongs to the lot that created it).
    render: (row) =>
      row.reservationId ? (
        <CocoaButton variant="plain" tone="accent" size="small" onClick={() => openReservation(row.reservationId ?? "")} title="Abrir el detalle de la reserva">
          {row.reservationCode ?? ACTIONS.viewDetail}
        </CocoaButton>
      ) : row.reservationCode ? (
        <span className="cocoa-mono">{row.reservationCode}</span>
      ) : (
        EMPTY
      )
  },
  { key: "reference", label: "Referencia", truncate: 140, showFrom: "tablet", render: (row) => row.externalReference ?? EMPTY },
  { key: "stay", label: "Estancia", nowrap: true, render: (row) => (row.arrivalDate && row.departureDate ? dateRange(row.arrivalDate, row.departureDate) : EMPTY) },
  { key: "roomType", label: "Tipo", fit: true, hideOnNarrow: true, render: (row) => row.roomTypeCode ?? EMPTY },
  { key: "error", label: "Error", truncate: 320, render: (row) => row.errorMessage ?? EMPTY },
  { key: "warnings", label: "Avisos", fit: true, showFrom: "tablet", render: (row) => (row.warnings.length > 0 ? plural(row.warnings.length, "aviso", "avisos") : EMPTY) },
  { key: "undo", label: "Al deshacer", showFrom: "laptop", render: (row) => undoOutcomeLabel(row.undoOutcome) }
];

/** Columns of «Importaciones anteriores»; «Autor» names the actor (own name, «Sistema · proceso», «otro usuario»), never a raw id (qa#10, FUX-02). */
function listColumns(session: ActorSession): CocoaTableColumn<ReservationImportRecord>[] {
  return [
  { key: "createdAt", label: "Fecha", nowrap: true, render: (row) => dateTime(row.createdAt) },
  { key: "fileName", label: "Fichero", truncate: 220, render: (row) => <span className="cocoa-mono">{importFileLabel(row)}</span> },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (row) => (
      <CocoaBadge tone={importStatusTone(row.status)} size="small">
        {importStatusLabel(row.status)}
      </CocoaBadge>
    )
  },
  { key: "rowCount", label: "Filas", fit: true, align: "right", hideOnNarrow: true, render: (row) => number(row.rowCount) },
  { key: "createdCount", label: "Creadas", fit: true, align: "right", render: (row) => number(row.createdCount) },
  { key: "skippedCount", label: "Omitidas", fit: true, align: "right", hideOnNarrow: true, render: (row) => number(row.skippedCount) },
  { key: "errorCount", label: "Con error", fit: true, align: "right", hideOnNarrow: true, render: (row) => number(row.errorCount) },
  { key: "totalAmount", label: "Importe", align: "right", showFrom: "laptop", render: (row) => money(row.totalAmount, row.currency) },
  { key: "createdBy", label: "Autor", truncate: 160, showFrom: "laptop", render: (row) => importAuthorLabel(row.createdBy, session) }
  ];
}

export function ReservationImportScreen() {
  const hosted = useTabHost() !== null;
  const gate = useNavGate();
  // Undo only needs pms.reservation.modify, like the API (FUX-08).
  const canUndo = canDo(gate, "pms.reservation.modify");
  const { propertyId, propertyName } = useActiveProperty();
  const { showToast } = useToast();
  // Viewer's profile (GET /users/me, cached): names the author of a lot as the own name instead of a raw id (FUX-02).
  const { profile } = useCurrentUserProfile();
  const session = useMemo<ActorSession>(() => (profile ? { userId: profile.userId, fullName: profile.fullName } : null), [profile]);
  const listTable = useMemo(() => listColumns(session), [session]);
  // Accessibility (FUX-10): the step content takes focus on every change of step (not on mount); one live region announces the step and the analysis.
  const stepContentRef = useRef<HTMLDivElement | null>(null);
  const stepMounted = useRef(false);
  // Sync mode (Tanda 7b): read once from the URL the «Modo sombra OPERA» panel built (no react-router).
  const search = useMemo(() => (typeof window === "undefined" ? "" : window.location.search), []);
  const sync = useMemo(() => parseSyncSearchParams(search), [search]);
  const syncMode = isSyncMode(sync);
  // Create needs create + modify; the sync commit also applies check-ins / check-outs and the API demands the four keys (FUX-7B-05, diseño §10 nº 8).
  const canCreateImport = canDo(gate, "pms.reservation.create") && canDo(gate, "pms.reservation.modify");
  const canImport = syncMode ? canCreateImport && canDo(gate, "pms.checkin.execute") && canDo(gate, "pms.checkout.execute") : canCreateImport;
  const lotFromUrl = useMemo(() => parseImportLotParam(search), [search]);
  // Business date of the snapshot: the link's, otherwise today (editable in the callout; it salts the lot hash and stamps the links).
  const [syncBusinessDate, setSyncBusinessDate] = useState<string>(() => sync.businessDate ?? isoDate(new Date()) ?? "");
  const syncFields = useMemo<SyncFields>(() => syncRequestFields(sync, syncBusinessDate), [sync, syncBusinessDate]);

  const [step, setStep] = useState(FILE_STEP);
  const [file, setFile] = useState<PickedFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [templateBusy, setTemplateBusy] = useState<ReservationImportFormat | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReservationImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Columns the user decided in «Columnas» (a field or null = «Ignorar»); the rest keep the API proposal.
  const [choices, setChoices] = useState<Record<string, ReservationImportField | null>>({});
  const [options, setOptions] = useState<ReservationImportOptions>(DEFAULT_OPTIONS);
  const [rowFilter, setRowFilter] = useState<RowFilter>("all");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [result, setResult] = useState<ResultView | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [undoTarget, setUndoTarget] = useState<ReservationImportRecord | null>(null);
  const [undoReason, setUndoReason] = useState("");
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  const imports = useApiData<ReservationImportRecord[]>(propertyId ? reservationImportsPath(propertyId) : null, { query: { limit: LIST_LIMIT } });
  const importRows = useMemo(() => toArray<ReservationImportRecord>(imports.data), [imports.data]);

  // Latest preview request wins: a stale answer (the user changed a column meanwhile) is dropped.
  const requestSeq = useRef(0);
  const debounceTimer = useRef<number | null>(null);
  const latest = useRef({ file, choices, options });
  latest.current = { file, choices, options };

  const runPreview = useCallback(
    async (input: { file: PickedFile; choices: Record<string, ReservationImportField | null>; options: ReservationImportOptions; header?: readonly string[]; sync?: SyncFields }): Promise<ReservationImportPreview | null> => {
      const seq = requestSeq.current + 1;
      requestSeq.current = seq;
      setPreviewing(true);
      setPreviewError(null);
      setImportError(null);
      try {
        const mapping: ReservationImportMapping | undefined = input.header ? buildMapping(input.header, input.choices) : undefined;
        // Sync mode adds mode · profile · feed · businessDate to the body (nothing in create mode).
        const next = await previewReservationImport(
          { fileName: input.file.name, format: input.file.format, contentBase64: input.file.contentBase64, mapping, ...input.options, ...(input.sync ?? syncFields) },
          propertyId
        );
        if (seq !== requestSeq.current) return null;
        setPreview(next);
        return next;
      } catch (err) {
        if (seq !== requestSeq.current) return null;
        // A failed re-analysis keeps the previous preview on screen (FUX-03): the
        // user stays in «Columnas» / «Revisión» with the error callout and retries;
        // only a first preview of a new file leaves nothing (pickFile cleared it).
        setPreviewError(reservationImportErrorMessage(err, "No se pudo previsualizar el fichero."));
        return null;
      } finally {
        if (seq === requestSeq.current) setPreviewing(false);
      }
    },
    [propertyId, syncFields]
  );

  function cancelDebounce() {
    if (debounceTimer.current !== null) {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
  }

  useEffect(() => cancelDebounce, []);

  useEffect(() => {
    if (!stepMounted.current) {
      stepMounted.current = true;
      return;
    }
    stepContentRef.current?.focus();
  }, [step]);

  /** Drops the file and its analysis (a spent preview after a commit, FUX-05; «Nueva importación»). */
  function discardPreview() {
    cancelDebounce();
    requestSeq.current += 1;
    setFile(null);
    setPreview(null);
    setPreviewing(false);
    setPreviewError(null);
    setChoices({});
    setOptions(DEFAULT_OPTIONS);
    setRowFilter("all");
  }

  function resetAll() {
    discardPreview();
    setStep(FILE_STEP);
    setFileError(null);
    setTemplateError(null);
    setImportError(null);
    setResult(null);
  }

  async function pickFile(picked: File) {
    setFileError(null);
    let contentBase64: string;
    try {
      contentBase64 = base64OfArrayBuffer(await picked.arrayBuffer());
    } catch {
      setFileError(READ_FALLBACK);
      return;
    }
    const next: PickedFile = { name: picked.name, format: detectFormatFromName(picked.name), contentBase64, bytes: picked.size };
    cancelDebounce();
    setFile(next);
    setPreview(null);
    setChoices({});
    setResult(null);
    setImportError(null);
    setRowFilter("all");
    const analysed = await runPreview({ file: next, choices: {}, options });
    // Sync mode: when the OPERA profile resolved every column there is nothing to map, so «Revisión» comes next.
    if (analysed) setStep(skipsMappingStep(analysed, sync) ? REVIEW_STEP : COLUMNS_STEP);
  }

  /** Sync mode: another business date re-analyses the same file (the date salts the lot hash and stamps the links). */
  function changeSyncBusinessDate(value: string) {
    setSyncBusinessDate(value);
    if (!file) return;
    cancelDebounce();
    void runPreview({ file, choices, options, header: preview?.header, sync: syncRequestFields(sync, value) });
  }

  function removeFile() {
    cancelDebounce();
    requestSeq.current += 1;
    setFile(null);
    setPreview(null);
    setPreviewing(false);
    setPreviewError(null);
    setChoices({});
    setStep(FILE_STEP);
  }

  async function downloadTemplate(format: ReservationImportFormat) {
    setTemplateBusy(format);
    setTemplateError(null);
    try {
      saveDownload(await downloadReservationImportTemplate(format, propertyId));
    } catch (err) {
      setTemplateError(reservationImportErrorMessage(err, "No se pudo descargar la plantilla."));
    } finally {
      setTemplateBusy(null);
    }
  }

  /** A column changed: keep the choice, resolve a field taken by another column, preview again after 400 ms. */
  function changeColumn(column: string, value: string) {
    if (!preview || !file) return;
    const next = applyMappingChoice(preview.mapping, choices, column, value);
    setChoices(next);
    cancelDebounce();
    const header = preview.header;
    debounceTimer.current = window.setTimeout(() => {
      debounceTimer.current = null;
      const current = latest.current;
      if (!current.file) return;
      void runPreview({ file: current.file, choices: next, options: current.options, header });
    }, PREVIEW_DEBOUNCE_MS);
  }

  async function applyMapping() {
    if (!preview || !file) return;
    cancelDebounce();
    const analysed = await runPreview({ file, choices, options, header: preview.header });
    if (analysed) setStep(REVIEW_STEP);
  }

  function changeOption(key: keyof ReservationImportOptions, value: boolean) {
    if (!file) return;
    const next = { ...options, [key]: value };
    setOptions(next);
    cancelDebounce();
    void runPreview({ file, choices, options: next, header: preview?.header });
  }

  async function runImport() {
    if (!file || !preview || !canImport || importing) return;
    cancelDebounce();
    setImporting(true);
    setImportError(null);
    try {
      // Sync mode adds mode · profile · feed · businessDate to the commit body too (nothing in create mode).
      const created = await createReservationImport(
        { fileName: file.name, format: file.format, contentBase64: file.contentBase64, mapping: buildMapping(preview.header, choices), ...options, ...syncFields, commit: true },
        propertyId
      );
      setResult({ record: created, warnings: created.warnings, mode: "imported", sync: created.sync });
      setStep(RESULT_STEP);
      // The preview is spent (FUX-05): a second «Importar» would end in 409
      // RESERVATION_IMPORT_DUPLICATE with no switch to follow its advice, or
      // duplicate the lot after any switch; steps 2-3 become unreachable and
      // only «Nueva importación» remains.
      discardPreview();
      showToast(plural(created.createdCount, "reserva importada", "reservas importadas"), { variant: created.status === "failed" ? "error" : created.status === "partial" ? "warning" : "success" });
      imports.refresh();
    } catch (err) {
      setImportError(reservationImportErrorMessage(err));
    } finally {
      setImporting(false);
    }
  }

  async function viewImport(record: ReservationImportRecord) {
    setViewing(record.id);
    try {
      const detail = await getReservationImport(record.id, propertyId);
      setResult({ record: detail, warnings: [], mode: "viewed" });
      setStep(RESULT_STEP);
    } catch (err) {
      showToast(reservationImportErrorMessage(err, "No se pudo abrir la importación."), { variant: "error" });
    } finally {
      setViewing(null);
    }
  }

  // `?lote=<id>` (the «Ver lote» of the OPERA panel): open that lot in step 4 once, when the property is known.
  const lotOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!lotFromUrl || !propertyId || lotOpened.current === lotFromUrl) return;
    lotOpened.current = lotFromUrl;
    void viewImport({ id: lotFromUrl } as ReservationImportRecord);
    // viewImport is a plain closure over propertyId; the ref keeps the deep link from replaying on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lotFromUrl, propertyId]);

  function openUndo(record: ReservationImportRecord) {
    setUndoTarget(record);
    setUndoReason("");
    setUndoError(null);
  }

  async function confirmUndo() {
    if (!undoTarget || undoing) return;
    setUndoing(true);
    setUndoError(null);
    try {
      const undone = await undoReservationImport(undoTarget.id, { reason: undoReason.trim() || undefined }, propertyId);
      showToast(undoSummary(undone), { variant: undone.alreadyUndone ? "info" : "success" });
      setUndoTarget(null);
      setUndoReason("");
      imports.refresh();
      if (result && result.record.id === undone.id) {
        const detail = await getReservationImport(undone.id, propertyId);
        setResult({ record: detail, warnings: result.warnings, mode: result.mode });
      }
    } catch (err) {
      setUndoError(reservationImportErrorMessage(err, "No se pudo deshacer la importación."));
    } finally {
      setUndoing(false);
    }
  }

  function downloadReport() {
    if (!result) return;
    const csv = buildImportReportCsv(result.record.rows);
    saveDownload({ blob: new Blob([csv], { type: "text/csv;charset=utf-8" }), filename: reportFileName(result.record), contentType: "text/csv" });
  }

  // ---- derived ----
  const current = IMPORT_STEPS[step] ?? IMPORT_STEPS[FILE_STEP];
  const summary = stepSummary(step);
  // Sync mode: a snapshot that only updates rows is importable (the create-only blocker of the Tanda 7 helpers does not apply).
  const blockers = syncMode ? syncBlockers(previewBlockers(preview), preview?.summary) : previewBlockers(preview);
  // Sync mode: the OPERA profile resolved every column → «Columnas» has nothing to decide and stays out of the path.
  const skipMapping = skipsMappingStep(preview, sync);
  const mappingView = preview ? effectiveMapping(preview.mapping, choices) : {};
  // Example per column from the RAW sample cells (FUX-04): also for an unmapped column and when every row has errors.
  const mappingRows: MappingRow[] = preview
    ? preview.header.map((column, index) => ({ column, field: mappingView[column] ?? null, source: choices[column] !== undefined ? "explicit" : preview.mappingSource[column] ?? "none", example: exampleForColumn(preview.rows, index, mappingView[column] ?? null) }))
    : [];
  const filteredRows = preview ? filterRows(preview.rows, rowFilter) : [];
  const currency = preview?.catalog.currency ?? preview?.totals.currency ?? "";
  const reviewTable = useMemo(() => reviewColumns(currency, syncMode), [currency, syncMode]);
  const exceeded = preview ? availabilityExceeded(preview.availability.byRoomType) : [];
  const importDisabled = !preview?.canImport || !canImport || importing || previewing;
  // The preview on screen predates a failed re-analysis (FUX-03): keep it visible, but do not import on it.
  const previewStale = preview !== null && previewError !== null;
  const mappingReady = preview !== null && preview.missingRequired.length === 0 && !previewing;
  const record = result?.record ?? null;
  const liveMessage = previewing ? "Analizando el fichero…" : importing ? "Importando las reservas…" : `Paso ${step + 1} de ${IMPORT_STEPS.length}: ${current.label}`;

  const reachable = (index: number): boolean => {
    if (index === FILE_STEP) return true;
    if (index === COLUMNS_STEP) return preview !== null && !skipMapping;
    if (index === REVIEW_STEP) return preview !== null;
    return result !== null;
  };

  const mappingColumns: CocoaTableColumn<MappingRow>[] = [
    { key: "column", label: "Columna del fichero", render: (row) => <span className="cocoa-mono">{row.column}</span> },
    { key: "example", label: "Ejemplo", showFrom: "tablet", truncate: 200, render: (row) => row.example || EMPTY },
    {
      key: "field",
      label: "Campo",
      render: (row) => (
        <CocoaSelect size="small" inline aria-label={`Campo de la columna ${row.column}`} value={fieldSelectValue(row.field)} onChange={(value) => changeColumn(row.column, value)} options={FIELD_OPTIONS} disabled={previewing || importing} />
      )
    },
    {
      key: "source",
      label: "Origen",
      fit: true,
      hideOnNarrow: true,
      render: (row) => (
        <CocoaBadge tone={mappingSourceTone(row.source)} size="small" variant="tinted" uppercase={false}>
          {mappingSourceLabel(row.source)}
        </CocoaBadge>
      )
    }
  ];

  // ---- steps ----
  function renderFileStep() {
    return (
      <CocoaSection title="1 · Fichero" meta={file ? `${formatLabel(file.format)} · ${fileSizeLabel(file.bytes)}` : undefined}>
        <div className="cocoa-stack" data-gap="3">
          <div className="cocoa-row">
            <CocoaFileInput accept=".csv,.txt,.xlsx" maxBytes={5 * 1024 * 1024} fileName={file?.name ?? null} onPick={(picked) => void pickFile(picked)} onReject={setFileError} disabled={previewing || importing || !propertyId} label="Elegir fichero CSV o XLSX" />
            {file ? (
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={removeFile} disabled={previewing || importing}>
                Quitar fichero
              </CocoaButton>
            ) : null}
            {file ? (
              <CocoaBadge tone="neutral" size="small">
                {formatLabel(file.format)}
              </CocoaBadge>
            ) : null}
            {previewing ? (
              <CocoaBadge tone="info" size="small">
                Analizando el fichero…
              </CocoaBadge>
            ) : null}
          </div>
          <div className="cocoa-row">
            <CocoaButton variant="bordered" tone="neutral" size="small" icon={<DownloadIcon size={14} aria-hidden="true" />} loading={templateBusy === "csv"} disabled={templateBusy !== null || !propertyId} onClick={() => void downloadTemplate("csv")}>
              Descargar plantilla CSV
            </CocoaButton>
            <CocoaButton variant="bordered" tone="neutral" size="small" icon={<DownloadIcon size={14} aria-hidden="true" />} loading={templateBusy === "xlsx"} disabled={templateBusy !== null || !propertyId} onClick={() => void downloadTemplate("xlsx")}>
              Descargar plantilla XLSX
            </CocoaButton>
          </div>
          <div className="cocoa-row">
            <CocoaStat label="Propiedad de destino" value={propertyName || propertyId || EMPTY} hint="Las reservas se crean en la propiedad activa" />
            {preview ? <CocoaStat label="Filas de datos" value={number(preview.rowCount)} hint={`${plural(preview.header.length, "columna", "columnas")} · hoy en la propiedad ${date(preview.today)}${preview.businessDate < preview.today ? ` · fecha de negocio ${date(preview.businessDate)} (días sin cerrar)` : ""}`} /> : null}
          </div>
          <p className="cocoa-note">
            CSV con separador «;», «,» o tabulador, en UTF-8 o Windows-1252, o XLSX (se lee la primera hoja). Cabecera con los nombres de la plantilla o de tu propio sistema: en el paso «Columnas» se confirma qué campo alimenta cada columna. Máximo {fileSizeLabel(5 * 1024 * 1024)} y {number(IMPORT_MAX_ROWS)} filas de datos; a partir de {number(IMPORT_CLI_ROWS_HINT)} filas es mejor importar con la herramienta de línea de comandos. El fichero no se guarda: solo el resultado por fila.
          </p>
          {!propertyId ? (
            <CocoaCallout tone="warning" role="status">
              {NO_PROPERTY_HINT}
            </CocoaCallout>
          ) : null}
          {templateError ? (
            <CocoaCallout tone="danger" title="No se pudo descargar la plantilla" role="alert">
              {templateError}
            </CocoaCallout>
          ) : null}
          {fileError ? (
            <CocoaCallout tone="danger" title="No se pudo leer el fichero" role="alert">
              {fileError}
            </CocoaCallout>
          ) : null}
          {previewError ? (
            <CocoaCallout tone="danger" title="No se pudo previsualizar" role="alert">
              {previewError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaSection>
    );
  }

  function renderColumnsStep() {
    if (!preview) return renderFileStep();
    const missing = missingRequiredLabels(preview.missingRequired);
    return (
      <CocoaSection title="2 · Columnas" meta={`${plural(preview.header.length, "columna", "columnas")} · ${plural(preview.unmappedColumns.length, "sin mapear", "sin mapear")}`}>
        <div className="cocoa-stack" data-gap="3">
          <p className="cocoa-note">
            El sistema propone un campo por columna a partir de la cabecera (sinónimos en español e inglés). Cambia el campo donde haga falta o elige «Ignorar columna»; cada cambio vuelve a analizar el fichero. Obligatorias: llegada, tipo de habitación, nombre y apellidos, más salida o noches{preview.splitName ? " (la columna de nombre completo se parte en nombre y apellidos)" : ""}.
          </p>
          <CocoaTable columns={mappingColumns} rows={mappingRows} rowKey="column" density="compact" caption="Mapeo de columnas" aria-label="Mapeo de columnas del fichero" />
          {missing.length > 0 || preview.unmappedColumns.length > 0 ? (
            <CocoaCallout tone={missing.length > 0 ? "warning" : "neutral"} title={missing.length > 0 ? "Faltan columnas obligatorias" : "Columnas sin mapear"} role="status">
              <div className="cocoa-stack" data-gap="2">
                {missing.length > 0 ? <span>Asigna una columna a: {missing.join(", ")}.</span> : null}
                {preview.unmappedColumns.length > 0 ? <span>Se ignorarán: {preview.unmappedColumns.join(", ")}.</span> : null}
              </div>
            </CocoaCallout>
          ) : null}
          {previewError ? (
            <CocoaCallout tone="danger" title="No se pudo previsualizar" role="alert">
              {previewError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaSection>
    );
  }

  function renderReviewStep() {
    if (!preview) return renderFileStep();
    const duplicates = preview.duplicates;
    const hasDuplicates = duplicates.byReferenceRows.length > 0 || duplicates.inFileRows.length > 0 || duplicates.possibleRows.length > 0 || duplicates.ofImport !== null;
    return (
      <div className="cocoa-stack" data-gap="4">
        <CocoaKpiStrip aria-label="Resumen de la revisión">
          {summaryKpis(preview.summary).map((kpi) => (
            <CocoaKpi key={kpi.key} label={kpi.label} value={kpi.value} tone={kpi.tone} caption={kpi.caption} size="compact" />
          ))}
          {syncMode
            ? syncSummaryKpis(preview.summary).map((kpi) => <CocoaKpi key={kpi.key} label={kpi.label} value={kpi.value} tone={kpi.tone} caption={kpi.caption} size="compact" />)
            : null}
        </CocoaKpiStrip>

        <CocoaSection
          title="3 · Revisión"
          meta={`${plural(preview.rowCount, "fila", "filas")} · ${money(preview.totals.fromFile, preview.totals.currency)} del fichero · ${money(preview.totals.quoted, preview.totals.currency)} cotizados`}
          action={<CocoaSegmentedControl size="small" aria-label="Filtrar filas por estado" value={rowFilter} onChange={(value) => setRowFilter(isRowFilter(value) ? value : "all")} options={ROW_FILTERS.map((filter) => ({ value: filter.value, label: filter.label }))} />}
        >
          <div className="cocoa-stack" data-gap="3">
            {previewing ? (
              <CocoaBadge tone="info" size="small">
                Analizando de nuevo…
              </CocoaBadge>
            ) : null}
            <CocoaTable
              columns={reviewTable}
              rows={filteredRows}
              rowKey={(row) => String(row.rowNumber)}
              density="compact"
              virtualize
              maxHeight={REVIEW_MAX_HEIGHT}
              rowTone={(row) => (row.status === "error" ? "danger" : row.status === "warning" ? "warning" : undefined)}
              rowTitle={(row) => issuesTitle(row.issues)}
              emptyState="Ninguna fila con ese estado."
              caption="Filas del fichero con su veredicto"
              aria-label="Filas del fichero con su veredicto"
            />
            <p className="cocoa-caption">Los datos del huésped solo se muestran en las primeras {number(preview.sampleSize)} filas; los mensajes citan columna y número de fila, nunca un valor del fichero.</p>
          </div>
        </CocoaSection>

        {preview.availability.byRoomType.length > 0 ? (
          <CocoaCallout tone={exceeded.length > 0 ? "warning" : "neutral"} title="Disponibilidad por tipo de habitación" role="status">
            <div className="cocoa-stack" data-gap="2">
              <span>El PMS aplica la regla de rango: suma las reservas confirmadas que solapan la estancia completa, más las filas anteriores del fichero, y rechaza la fila cuando supera el cupo del tipo aunque quepa noche a noche.</span>
              <ul className="c22-section__list">
                {preview.availability.byRoomType.map((type) => (
                  <li key={type.roomTypeId}>
                    <span>{availabilityLine(type)}</span>
                  </li>
                ))}
              </ul>
              {preview.availability.overbookingRows.length > 0 ? <span>Por encima del cupo con overbooking permitido: {rowsLabel(preview.availability.overbookingRows)}.</span> : null}
            </div>
          </CocoaCallout>
        ) : null}

        {hasDuplicates ? (
          <CocoaCallout tone={duplicates.ofImport && !options.force ? "warning" : "neutral"} title="Duplicados" role="status">
            <div className="cocoa-stack" data-gap="2">
              {duplicates.byReferenceRows.length > 0 ? <span>Referencia externa ya existente en una reserva activa (se omiten): {rowsLabel(duplicates.byReferenceRows)}.</span> : null}
              {duplicates.inFileRows.length > 0 ? <span>Referencia repetida dentro del fichero (gana la primera): {rowsLabel(duplicates.inFileRows)}.</span> : null}
              {duplicates.possibleRows.length > 0 ? <span>Posibles duplicados (mismo huésped, llegada y tipo): {rowsLabel(duplicates.possibleRows)}. No bloquean: compruébalos.</span> : null}
              {duplicates.ofImport ? (
                <span>
                  Este fichero ya se importó: lote {duplicates.ofImport.fileName ?? duplicates.ofImport.importId} ({importStatusLabel(duplicates.ofImport.status)}, {dateTime(duplicates.ofImport.createdAt)}). Deshaz el lote anterior o importa de todos modos.
                </span>
              ) : null}
              {duplicates.ofImport ? <CocoaSwitch checked={options.force} onChange={(value) => changeOption("force", value)} label="Importar de todos modos" size="small" disabled={previewing || importing} /> : null}
            </div>
          </CocoaCallout>
        ) : null}

        <CocoaSection title="Opciones de la importación">
          <div className="cocoa-stack" data-gap="3">
            <div className="cocoa-stack" data-gap="1">
              <CocoaSwitch checked={options.omitirInvalidas} onChange={(value) => changeOption("omitirInvalidas", value)} label="Omitir filas inválidas" size="small" disabled={previewing || importing} />
              <span className="cocoa-caption">Crea las filas válidas y deja fuera las que tienen errores (quedan en el informe para corregirlas y reimportarlas).</span>
            </div>
            <div className="cocoa-stack" data-gap="1">
              <CocoaSwitch checked={options.permitirOverbooking} onChange={(value) => changeOption("permitirOverbooking", value)} label="Permitir overbooking" size="small" disabled={previewing || importing} />
              <span className="cocoa-caption">Crea las filas por encima del cupo del tipo; quedan auditadas como overbooking consciente.</span>
            </div>
            <div className="cocoa-stack" data-gap="1">
              <CocoaSwitch checked={options.historico} onChange={(value) => changeOption("historico", value)} label="Cargar llegadas pasadas como histórico" size="small" disabled={previewing || importing} />
              <span className="cocoa-caption">Las llegadas anteriores a hoy (fecha local de la propiedad) se crean como estancias cerradas (sin cargos ni folio abierto); una estancia en curso se hace por recepción.</span>
            </div>
          </div>
        </CocoaSection>

        {preview.warnings.length > 0 ? (
          <CocoaCallout tone="warning" title="Avisos del fichero" role="status">
            <ul className="c22-section__list">
              {preview.warnings.map((warning, index) => (
                <li key={index}>
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          </CocoaCallout>
        ) : null}

        {blockers.length > 0 ? (
          <CocoaCallout tone="danger" title="Todavía no se puede importar" role="status">
            <ul className="c22-section__list">
              {blockers.map((blocker) => (
                <li key={blocker}>
                  <span>{blocker}</span>
                </li>
              ))}
            </ul>
          </CocoaCallout>
        ) : null}

        {previewError ? (
          <CocoaCallout tone="danger" title="No se pudo previsualizar" role="alert">
            {previewError}
          </CocoaCallout>
        ) : null}
        {importError ? (
          <CocoaCallout tone="danger" title="No se pudo importar" role="alert">
            {importError}
          </CocoaCallout>
        ) : null}
      </div>
    );
  }

  function renderResultStep() {
    if (!result || !record) return renderFileStep();
    const tone = resultTone(record.status);
    return (
      <div className="cocoa-stack" data-gap="4">
        <CocoaCallout tone={tone} title={resultTitle(record)} role="status">
          <div className="cocoa-stack" data-gap="2">
            <span>
              Lote {importFileLabel(record)} · {dateTime(record.createdAt)} · {plural(record.rowCount, "fila", "filas")}
              {record.arrivalFrom && record.arrivalTo ? ` · llegadas ${dateRange(record.arrivalFrom, record.arrivalTo)}` : ""}
              {result.mode === "viewed" ? " · consulta de una importación anterior" : ""}
            </span>
            {record.undoneAt ? (
              <span>
                Deshecha el {dateTime(record.undoneAt)}
                {record.undoReason ? ` · motivo: ${record.undoReason}` : ""}
              </span>
            ) : null}
            {result.warnings.length > 0 ? (
              <ul className="c22-section__list">
                {result.warnings.map((warning, index) => (
                  <li key={index}>
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </CocoaCallout>

        <CocoaKpiStrip aria-label="Resumen de la importación">
          {resultKpis(record).map((kpi) => (
            <CocoaKpi key={kpi.key} label={kpi.label} value={kpi.value} tone={kpi.tone} size="compact" />
          ))}
        </CocoaKpiStrip>

        {result.sync ? (
          <CocoaCallout tone={result.sync.missing.length > 0 || result.sync.conflicts.length > 0 || result.sync.checkInWithoutRoom.length > 0 ? "warning" : "success"} title={syncResultTitle(result.sync)} role="status">
            {syncResultLines(result.sync).length > 0 ? (
              <ul className="c22-section__list">
                {syncResultLines(result.sync).map((line, index) => (
                  <li key={index}>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span>Sin reservas ausentes, conflictos con reservas locales ni check-ins sin habitación: el corte cuadra con ehotelOS.</span>
            )}
          </CocoaCallout>
        ) : null}

        <CocoaSection title="4 · Resultado por fila" meta={`${plural(record.rows.length, "fila", "filas")}`}>
          <CocoaTable
            columns={RESULT_COLUMNS}
            rows={record.rows}
            rowKey={(row) => String(row.rowNumber)}
            density="compact"
            virtualize
            maxHeight={REVIEW_MAX_HEIGHT}
            rowTone={(row) => (row.outcome === "error" ? "danger" : row.outcome === "skipped" ? "neutral" : undefined)}
            rowTitle={(row) => issuesTitle(row.warnings) ?? row.errorMessage ?? undefined}
            emptyState="Este lote no tiene filas registradas."
            caption="Resultado por fila"
            aria-label="Resultado por fila de la importación"
          />
        </CocoaSection>

        {undoError && undoTarget === null ? (
          <CocoaCallout tone="danger" title="No se pudo deshacer" role="alert">
            {undoError}
          </CocoaCallout>
        ) : null}
      </div>
    );
  }

  function renderStep() {
    switch (step) {
      case COLUMNS_STEP:
        return renderColumnsStep();
      case REVIEW_STEP:
        return renderReviewStep();
      case RESULT_STEP:
        return renderResultStep();
      default:
        return renderFileStep();
    }
  }

  // ---- action bar per step ----
  // Sync mode: «Sincronizar N nuevas · M actualizadas» instead of «Importar N reservas»; the mapping step is skipped when the profile resolved every column.
  const primary =
    step === FILE_STEP
      ? { label: ACTIONS.next, disabled: preview === null || previewing, onClick: () => setStep(skipMapping ? REVIEW_STEP : COLUMNS_STEP) }
      : step === COLUMNS_STEP
        ? { label: "Aplicar y validar", disabled: !mappingReady, loading: previewing, onClick: () => void applyMapping() }
        : step === REVIEW_STEP
          ? { label: importing ? (syncMode ? "Sincronizando…" : "Importando…") : syncMode ? syncImportButtonLabel(preview?.summary) : `Importar ${plural(preview?.summary.toCreate ?? 0, "reserva", "reservas")}`, disabled: importDisabled || previewStale, loading: importing, onClick: () => void runImport(), title: previewStale ? "No se puede importar: la última previsualización falló; cambia una opción o vuelve a «Columnas» para analizar de nuevo." : blockers.length > 0 ? `No se puede importar: ${blockers.join("; ")}.` : undefined }
          : { label: "Descargar informe CSV", icon: <DownloadIcon size={14} aria-hidden="true" />, disabled: !record || record.rows.length === 0, onClick: downloadReport };
  const secondary =
    step === COLUMNS_STEP
      ? { label: ACTIONS.previous, onClick: () => setStep(FILE_STEP), disabled: previewing }
      : step === REVIEW_STEP
        ? { label: ACTIONS.previous, onClick: () => setStep(skipMapping ? FILE_STEP : COLUMNS_STEP), disabled: importing }
        : step === RESULT_STEP
          ? { label: "Nueva importación", onClick: resetAll }
          : undefined;

  return (
    <CocoaPage
      eyebrow="Recepción · Reservas"
      title="Importar reservas"
      subtitle={hosted ? undefined : "Carga decenas o cientos de reservas desde un CSV o XLSX: previsualización, mapeo de columnas, disponibilidad y deshacer."}
      commands={[
        { id: "reservas-importar-nueva", label: "Nueva importación de reservas", run: resetAll },
        { id: "reservas-importar-plantilla", label: "Descargar plantilla CSV de reservas", run: () => void downloadTemplate("csv") }
      ]}
    >
      <CocoaLiveRegion message={liveMessage} announceKey={`${step}-${previewing ? "p" : ""}-${importing ? "i" : ""}`} />
      {!canImport ? (
        <p className="cocoa-note">
          {syncMode
            ? `Necesitas los permisos de crear y modificar reservas y los de check-in y check-out para sincronizar un corte (las transiciones de estado se aplican como en recepción)${canUndo ? " (deshacer un lote solo exige el de modificar, que sí tienes)" : "; deshacer uno exige el de modificar"}: puedes previsualizar el fichero y consultar las importaciones anteriores.`
            : `Necesitas los permisos de crear y modificar reservas para importar un lote${canUndo ? " (deshacer uno solo exige el de modificar, que sí tienes)" : "; deshacer uno exige el de modificar"}: puedes previsualizar el fichero y consultar las importaciones anteriores.`}
        </p>
      ) : null}
      {syncMode ? (
        // FUX-7B-09: no live region here (a `role="status"` container must not hold an editable field); the step live region above announces the analysis.
        <CocoaCallout tone="info" title={syncCalloutText(sync, syncBusinessDate)}>
          <div className="cocoa-stack" data-gap="2">
            <span>{SYNC_CALLOUT_HELP}</span>
            <CocoaField label="Fecha de negocio del corte" help="Sal del hash del lote y última fecha vista de cada reserva enlazada; cambiarla vuelve a analizar el fichero.">
              <CocoaInput type="date" value={syncBusinessDate} onChange={changeSyncBusinessDate} disabled={previewing || importing} aria-label="Fecha de negocio del corte" />
            </CocoaField>
            <span className="cocoa-caption">Sincronizar exige además los permisos de check-in y check-out (las transiciones de estado se aplican como en recepción, sin correos al huésped).</span>
          </div>
        </CocoaCallout>
      ) : null}

      <CocoaGrid columns={12} align="start">
        <CocoaSpan cols={4} min={240}>
          <CocoaSection title="Pasos" meta={`${step + 1} / ${IMPORT_STEPS.length}`}>
            <div className="cocoa-stack" data-gap="3">
              <CocoaChart.Progress value={((step + 1) / IMPORT_STEPS.length) * 100} label={current.label} showValue={false} aria-label={summary} />
              <ol className="c22-section__list" aria-label="Pasos del asistente">
                {IMPORT_STEPS.map((item, index) => (
                  <li key={item.key}>
                    <CocoaButton variant="plain" tone={index === step ? "accent" : "neutral"} size="small" wrap fullWidth align="start" aria-current={index === step ? "step" : undefined} disabled={!reachable(index)} onClick={() => setStep(index)}>
                      {index + 1}. {item.label}
                    </CocoaButton>
                    <CocoaBadge tone={stepTone(index, step)} variant="dot" size="small">
                      {skipMapping && index === COLUMNS_STEP ? "Resuelto por el perfil" : stepStateLabel(index, step)}
                    </CocoaBadge>
                  </li>
                ))}
              </ol>
              <p className="cocoa-caption">{current.description}</p>
            </div>
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={8} min={480}>
          <div className="cocoa-stack" data-gap="4" ref={stepContentRef} tabIndex={-1} role="region" aria-label={`Paso ${step + 1}: ${current.label}`}>
            {renderStep()}
          </div>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaActionBar
        aria-label="Navegación del asistente de importación"
        status={summary}
        extra={
          step === RESULT_STEP && record ? (
            <CocoaButton variant="plain" tone="destructive" size="small" disabled={!canUndo || !canUndoImport(record) || undoing} onClick={() => openUndo(record)}>
              Deshacer importación
            </CocoaButton>
          ) : undefined
        }
        secondary={secondary}
        primary={primary}
      />

      <CocoaSection
        title="Importaciones anteriores"
        meta={importRows.length > 0 ? plural(importRows.length, "lote", "lotes") : undefined}
        action={
          <CocoaButton variant="plain" tone="neutral" size="small" loading={imports.loading} onClick={imports.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        }
      >
        {imports.error ? (
          <CocoaCallout tone="danger" title="No se pudieron cargar las importaciones" role="alert">
            {imports.error}
          </CocoaCallout>
        ) : (
          <CocoaTable
            columns={listTable}
            rows={importRows}
            rowKey="id"
            density="compact"
            loading={imports.loading && importRows.length === 0}
            emptyState="Todavía no hay importaciones en esta propiedad."
            rowActionsVisible="always"
            rowActions={(row) => (
              <>
                <CocoaButton variant="plain" tone="neutral" size="small" loading={viewing === row.id} onClick={() => void viewImport(row)}>
                  {ACTIONS.view}
                </CocoaButton>
                <CocoaButton variant="plain" tone="destructive" size="small" disabled={!canUndo || !canUndoImport(row)} onClick={() => openUndo(row)}>
                  Deshacer
                </CocoaButton>
              </>
            )}
            caption="Importaciones anteriores"
            aria-label="Importaciones anteriores de la propiedad"
          />
        )}
      </CocoaSection>

      <CocoaDialog
        open={undoTarget !== null}
        onClose={() => {
          if (!undoing) setUndoTarget(null);
        }}
        tone="destructive"
        title={undoTarget ? `Deshacer la importación ${importFileLabel(undoTarget)}` : "Deshacer importación"}
        description={
          undoTarget
            ? `Se cancelan las ${plural(undoTarget.createdCount, "reserva creada", "reservas creadas")} por el lote que sigan sin check-in; las que ya tienen check-in o check-out se conservan. La cancelación no libera la habitación asignada ni cierra los folios, como cualquier cancelación de recepción.`
            : undefined
        }
        confirmLabel="Deshacer importación"
        cancelLabel={ACTIONS.cancel}
        busy={undoing}
        onConfirm={() => void confirmUndo()}
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Motivo" hint="opcional" help="Queda registrado en el lote y en cada reserva cancelada.">
            <CocoaInput value={undoReason} onChange={setUndoReason} multiline rows={3} maxLength={500} placeholder="Importación deshecha" disabled={undoing} />
          </CocoaField>
          {undoError ? (
            <CocoaCallout tone="danger" title="No se pudo deshacer" role="alert">
              {undoError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDialog>
    </CocoaPage>
  );
}

export default ReservationImportScreen;
