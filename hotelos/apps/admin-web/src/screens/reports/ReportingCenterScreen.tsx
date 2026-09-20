// Reporting center — Informes › Centro de informes (/informes).
//
// Cocoa 22 (ola 9 · lote 9-A): dashboard hosted in CentroInformesTabs (the
// container paints eyebrow + H1). KPI strip of the reservation and billing
// reports → 6/6 row (catalog list + export form) → 6/6 row (reservation and
// billing report tables) → status line. Same service calls as before
// (services/pmsCommerceApi.ts).
//
// Tanda UX-2 · lote D6 (docs/design/UX-DIRECCION-FEEL.md §3 F-D6, recon Δ11,
// FIX-1 §1.5): the export posts a REAL range (preset «Este mes · Mes anterior
// · Últimos 30 días · Personalizado» + two CocoaDatePicker, default this month
// up to today) instead of a fixed May 2026; the format options say what the
// API really delivers (printable HTML for PDF, CSV for XLSX); the catalogue
// list takes its titles from REPORT_TYPE_LABELS; «Generar exportación» is the
// submit of a <form> (Enter exports, ⌥E clicks it); the result is one message
// (callout + toast + status): «Exportación lista: <fichero> · disponible
// hasta HH:MM»; ⌘K «Exportar informe de reservas» / «… de facturación».

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import {
  exportOperationalReport,
  fetchBillingReport,
  fetchReportCatalog,
  fetchReportExportFile,
  fetchReservationReport,
  type ReportExportResult
} from "../../services/pmsCommerceApi";
import { navigateTo } from "../../lib/navigate";
import { dateRange, isoDate, money, number, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { DIRECCION_INFORMES_INSTRUCTIONS } from "../../content/screen-instructions/direccion";
import { useToast } from "../../components/Toast";
import {
  FORMAT_OPTIONS,
  RANGE_PRESET_OPTIONS,
  REPORT_TYPE_LABELS,
  catalogRowDetail,
  catalogRowTitle,
  downloadReportExport,
  exportFormLabel,
  exportReadyDetail,
  exportStatusMessage,
  isExportEnter,
  rangeForPreset,
  saveBlobAs,
  uniqueByFolio,
  type DateRange,
  type RangePreset,
  type ReportFormat
} from "./reporting-center-rows";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  localIsoDate,
  toneFromStatus,
  type CocoaTableColumn
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

// Real types — the response shape of the service is documented in
// `services/pmsCommerceApi.ts` and mirrored here so the render stays typed.

type ReportCatalogItem = {
  code: string;
  title: string;
  description?: string;
  formats?: ReportFormat[];
  category?: string;
};

type ReservationReportRow = {
  reservationId: string;
  code: string;
  guestName: string;
  totalAmount: number;
  currency: string;
};

type BillingFolioRow = {
  folioId: string;
  status: string;
  balanceDue: number;
  currency: string;
};

type ReservationReport = {
  kpis: {
    reservations?: number;
    arrivals?: number;
    departures?: number;
    totalAmount?: number;
  };
  rows: ReservationReportRow[];
};

type BillingReport = {
  kpis: {
    invoiceCount?: number;
    openFolioBalances?: number;
  };
  folios: BillingFolioRow[];
};

type ReportCatalog = {
  reports: ReportCatalogItem[];
};

type ReportState = {
  catalog?: ReportCatalog;
  reservation?: ReservationReport;
  billing?: BillingReport;
  exportResult?: ReportExportResult;
};

const REPORT_TYPE_OPTIONS = Object.entries(REPORT_TYPE_LABELS).map(([value, label]) => ({ value, label }));
const RANGE_OPTIONS = RANGE_PRESET_OPTIONS.map((option) => ({ ...option }));
const FORMAT_SELECT_OPTIONS = FORMAT_OPTIONS.map((option) => ({ ...option }));
const DEFAULT_PRESET: RangePreset = "this_month";

/** Today as the Madrid calendar day (the API's business date lives per property; the picker falls back to the local day). */
function todayIso(): string {
  return isoDate(new Date()) ?? localIsoDate();
}

const LOAD_ERROR_MESSAGE = "No se pudieron cargar los informes. Comprueba la API local.";

// Secondary line under a catalog title: caption secondary.
const subStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};

const RESERVATION_COLUMNS: CocoaTableColumn<ReservationReportRow>[] = [
  { key: "code", label: "Código", render: (row) => <strong>{row.code}</strong> },
  { key: "guestName", label: "Huésped" },
  { key: "totalAmount", label: "Importe", align: "right", render: (row) => money(row.totalAmount, row.currency) }
];

const FOLIO_COLUMNS: CocoaTableColumn<BillingFolioRow>[] = [
  { key: "folioId", label: "Folio", render: (row) => <strong>{row.folioId}</strong> },
  { key: "status", label: "Estado", render: (row) => <CocoaBadge tone={toneFromStatus(row.status)}>{row.status}</CocoaBadge> },
  { key: "balanceDue", label: "Saldo", align: "right", render: (row) => money(row.balanceDue, row.currency) }
];

// Skeleton espejo: strip of 3 tiles, then 6/6 · 6/6.
function ReportingCenterSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={3} />
      <CocoaSkeleton.Grid rows={[[6, 6], [6, 6]]} height={200} />
    </div>
  );
}

export function ReportingCenterScreen() {
  // Hosted inside the Centro de informes container (Tanda 5): CocoaPage reads the host and lets the container paint eyebrow + H1.
  const { showToast } = useToast();
  const [reports, setReports] = useState<ReportState>({});
  const [reportType, setReportType] = useState<string>("reservation");
  const [format, setFormat] = useState<ReportFormat>("pdf");
  const [preset, setPreset] = useState<RangePreset>(DEFAULT_PRESET);
  const [range, setRange] = useState<DateRange>(() => rangeForPreset(DEFAULT_PRESET, todayIso()));
  const [status, setStatus] = useState<string>("Cargando catálogo de informes…");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [catalog, reservation, billing] = await Promise.all([
        fetchReportCatalog(PROPERTY_ID) as Promise<ReportCatalog>,
        fetchReservationReport(PROPERTY_ID) as Promise<ReservationReport>,
        fetchBillingReport(PROPERTY_ID) as Promise<BillingReport>
      ]);
      setReports({ catalog, reservation, billing });
      setStatus(`Informes cargados desde el API · ${number(catalog.reports?.length ?? 0)} disponibles.`);
    } catch {
      setLoadError(LOAD_ERROR_MESSAGE);
      setStatus(LOAD_ERROR_MESSAGE);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A preset recomputes both dates; editing a date turns the preset into «Personalizado».
  function handlePresetChange(value: string) {
    const next = value as RangePreset;
    setPreset(next);
    if (next !== "custom") setRange(rangeForPreset(next, todayIso()));
  }

  function handleRangeChange(patch: Partial<DateRange>) {
    setPreset("custom");
    setRange((current) => ({ ...current, ...patch }));
  }

  // `type` comes from the ⌘K commands («Exportar informe de reservas» /
  // «… de facturación»); the form and the button export the selected type.
  async function handleExport(type: string = reportType) {
    if (exporting) return;
    if (type !== reportType) setReportType(type);
    setExporting(true);
    setStatus("Creando exportación…");
    try {
      const result = await exportOperationalReport(PROPERTY_ID, {
        reportType: type,
        format,
        query: { fromDate: range.fromDate, toDate: range.toDate }
      });
      setReports((current) => ({ ...current, exportResult: result }));
      // The response carries the file body: download it right away (F5) and
      // keep the authenticated link for a second download until it expires.
      downloadReportExport(result);
      const message = exportStatusMessage(result);
      setStatus(message);
      // The status callout below is the page's live region: the toast stays silent (R5, one announcement).
      showToast(message, { variant: "success", announce: false });
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : "No se pudo generar la exportación.");
    } finally {
      setExporting(false);
    }
  }

  function handleExportSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void handleExport();
  }

  // Enter on a field exports (a date input or a select never submits by itself in Chromium).
  function handleExportKeyDown(event: ReactKeyboardEvent<HTMLFormElement>) {
    if (!isExportEnter({ ...event, tagName: (event.target as HTMLElement).tagName })) return;
    event.preventDefault();
    void handleExport();
  }

  // Second download through GET /reports/exports/:id/download (15 min TTL in the API).
  async function handleDownloadAgain(result: ReportExportResult) {
    setDownloading(true);
    try {
      const file = await fetchReportExportFile(result.export.downloadUrl);
      saveBlobAs(file.blob, result.export.filename);
      setStatus(exportStatusMessage(result));
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : "No se pudo descargar la exportación.");
    } finally {
      setDownloading(false);
    }
  }

  const reservationKpis = reports.reservation?.kpis ?? {};
  const billingKpis = reports.billing?.kpis ?? {};
  const catalogReports: ReportCatalogItem[] = reports.catalog?.reports ?? [];
  const reservationRows = reports.reservation?.rows ?? [];
  // The API repeats a folio when its reservation has two (qa#3): one row per folio.
  const folioRows = uniqueByFolio(reports.billing?.folios ?? []);
  const hasData = Boolean(reports.catalog || reports.reservation || reports.billing);

  return (
    <CocoaPage
      eyebrow={`Informes · ${getActiveProperty().propertyName}`}
      title="Centro de informes"
      subtitle="Los informes son superficies de producto: reservas, facturación, revenue y propietario exponen sus entradas, categorías, formatos y exportaciones desde un único panel."
      actions={
        <>
          <CocoaBadge tone="neutral">{`${plural(catalogReports.length, "informe", "informes")} disponibles`}</CocoaBadge>
          {loading && hasData ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void refresh()} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !hasData ? "loading" : loadError && !hasData ? "error" : "ready"}
      skeleton={<ReportingCenterSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: loadError ?? undefined, onRetry: () => void refresh() }}
      commands={[
        { id: "centro-informes-refresh", label: "Actualizar el centro de informes", run: () => void refresh() },
        { id: "centro-informes-export", label: "Generar exportación de informe", run: () => void handleExport() },
        { id: "centro-informes-export-reservas", label: "Exportar informe de reservas", run: () => void handleExport("reservation") },
        { id: "centro-informes-export-facturacion", label: "Exportar informe de facturación", run: () => void handleExport("billing") }
      ]}
    >
      <CocoaKpiStrip stagger aria-label="Cifras de los informes">
        <CocoaKpi
          label="Reservas"
          value={number(reservationKpis.reservations ?? 0)}
          deltaLabel={`llegadas ${number(reservationKpis.arrivals ?? 0)} · salidas ${number(reservationKpis.departures ?? 0)}`}
          polarity="neutral"
          status="ok"
        />
        <CocoaKpi label="Valor reservado" value={money(reservationKpis.totalAmount ?? 0)} deltaLabel="total del informe" status="ok" />
        <CocoaKpi
          label="Facturación"
          value={number(billingKpis.invoiceCount ?? 0)}
          deltaLabel={`facturas · saldos abiertos ${number(billingKpis.openFolioBalances ?? 0)}`}
          polarity="neutral"
          status="ok"
        />
      </CocoaKpiStrip>

      <CocoaGrid aria-label="Catálogo y exportación" align="start">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Catálogo de informes" meta={<CocoaBadge tone="success">{plural(catalogReports.length, "informe", "informes")}</CocoaBadge>}>
            {catalogReports.length === 0 ? (
              <CocoaState kind="empty" inline title="El catálogo no tiene informes todavía." />
            ) : (
              <ul className="c22-section__list" aria-label="Informes del catálogo">
                {catalogReports.map((report) => {
                  const detail = catalogRowDetail(report);
                  return (
                    <li key={report.code}>
                      <span>
                        <strong>{catalogRowTitle(report)}</strong>
                        {detail ? <span style={subStyle}>{detail}</span> : null}
                      </span>
                      <CocoaBadge tone="neutral">{report.formats?.map((value) => value.toUpperCase()).join(" · ") ?? "—"}</CocoaBadge>
                    </li>
                  );
                })}
              </ul>
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <form onSubmit={handleExportSubmit} onKeyDown={handleExportKeyDown} aria-label={exportFormLabel(reportType, preset)} noValidate>
            <CocoaSection
              title="Exportar informe"
              meta={dateRange(range.fromDate, range.toDate)}
              footer={
                <div className="cocoa-row" data-gap="2">
                  <CocoaButton type="submit" variant="filled" tone="accent" size="small" accessKey="E" loading={exporting}>
                    Generar exportación
                  </CocoaButton>
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("RevenueHistoryForecastDashboard")}>
                    Abrir histórico y previsión
                  </CocoaButton>
                </div>
              }
            >
              <CocoaFormRow columns={2} min={160}>
                <CocoaField label="Tipo de informe" htmlFor="reporting-center-type">
                  <CocoaSelect id="reporting-center-type" value={reportType} onChange={setReportType} options={REPORT_TYPE_OPTIONS} />
                </CocoaField>
                <CocoaField label="Formato" htmlFor="reporting-center-format">
                  <CocoaSelect id="reporting-center-format" value={format} onChange={(value) => setFormat(value as ReportFormat)} options={FORMAT_SELECT_OPTIONS} />
                </CocoaField>
              </CocoaFormRow>
              <CocoaFormRow columns={3} min={140}>
                <CocoaField label="Periodo" htmlFor="reporting-center-range">
                  <CocoaSelect id="reporting-center-range" value={preset} onChange={handlePresetChange} options={RANGE_OPTIONS} />
                </CocoaField>
                <CocoaField label="Desde" htmlFor="reporting-center-from">
                  <CocoaDatePicker id="reporting-center-from" value={range.fromDate} max={range.toDate} onChange={(value) => handleRangeChange({ fromDate: value })} arithmetic />
                </CocoaField>
                <CocoaField label="Hasta" htmlFor="reporting-center-to">
                  <CocoaDatePicker id="reporting-center-to" value={range.toDate} min={range.fromDate} onChange={(value) => handleRangeChange({ toDate: value })} arithmetic />
                </CocoaField>
              </CocoaFormRow>
              {reports.exportResult ? (
                <CocoaCallout tone="success" title="Exportación lista">
                  <div className="cocoa-stack" data-gap="2">
                    <span>{exportReadyDetail(reports.exportResult)}</span>
                    <div className="cocoa-row" data-gap="2">
                      <CocoaButton
                        variant="bordered"
                        tone="neutral"
                        size="small"
                        onClick={() => void handleDownloadAgain(reports.exportResult as ReportExportResult)}
                        loading={downloading}
                      >
                        Descargar exportación
                      </CocoaButton>
                    </div>
                  </div>
                </CocoaCallout>
              ) : null}
            </CocoaSection>
          </form>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaGrid aria-label="Informes de reservas y facturación" align="start">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Informe de reservas" meta={plural(reservationRows.length, "reserva", "reservas")} padding={reservationRows.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {reservationRows.length === 0 ? (
              <CocoaState kind="empty" inline title="El informe de reservas no tiene filas." />
            ) : (
              <CocoaTable columns={RESERVATION_COLUMNS} rows={reservationRows} rowKey="reservationId" caption="Informe de reservas" aria-label="Informe de reservas" />
            )}
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Informe de facturación" meta={plural(folioRows.length, "folio", "folios")} padding={folioRows.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {folioRows.length === 0 ? (
              <CocoaState kind="empty" inline title="El informe de facturación no tiene folios." />
            ) : (
              <CocoaTable columns={FOLIO_COLUMNS} rows={folioRows} rowKey="folioId" caption="Informe de facturación" aria-label="Informe de facturación" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaCallout tone={loadError ? "danger" : "neutral"} role="status">
        {status}
      </CocoaCallout>

      {/* Ayuda contextual honesta (UX-2 · D8): solo lo que existe en el centro de informes; se descarta una vez. */}
      <CocoaScreenInstructionsCard {...DIRECCION_INFORMES_INSTRUCTIONS} dismissible persistKey="direccion-informes" />
    </CocoaPage>
  );
}
