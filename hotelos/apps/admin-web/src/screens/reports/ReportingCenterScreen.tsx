// Reporting center — Informes › Centro de informes (/informes).
//
// Cocoa 22 (ola 9 · lote 9-A): dashboard hosted in CentroInformesTabs (the
// container paints eyebrow + H1). KPI strip of the reservation and billing
// reports → 6/6 row (catalog list + export form) → 6/6 row (reservation and
// billing report tables) → status line. Same service calls as before
// (services/pmsCommerceApi.ts); the export payload is unchanged.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import {
  exportOperationalReport,
  fetchBillingReport,
  fetchReportCatalog,
  fetchReservationReport
} from "../../services/pmsCommerceApi";
import { navigateTo } from "../../lib/navigate";
import { money, number, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { uniqueByFolio } from "./reporting-center-rows";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
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
  toneFromStatus,
  type CocoaTableColumn
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

// Real types — the response shape of the service is documented in
// `services/pmsCommerceApi.ts` and mirrored here so the render stays typed.

type ReportFormat = "pdf" | "csv" | "xlsx" | "json";

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

type ExportResult = {
  export: { downloadUrl: string };
};

type ReportState = {
  catalog?: ReportCatalog;
  reservation?: ReservationReport;
  billing?: BillingReport;
  exportResult?: ExportResult;
};

const REPORT_TYPE_LABELS: Record<string, string> = {
  reservation: "Reservas",
  billing: "Facturación",
  revenue: "Revenue",
  owner: "Propietario"
};

const REPORT_TYPE_OPTIONS = Object.entries(REPORT_TYPE_LABELS).map(([value, label]) => ({ value, label }));
const FORMAT_OPTIONS: Array<{ value: ReportFormat; label: string }> = [
  { value: "pdf", label: "PDF" },
  { value: "csv", label: "CSV" },
  { value: "xlsx", label: "XLSX" },
  { value: "json", label: "JSON" }
];

const LOAD_ERROR_MESSAGE = "No se pudieron cargar los informes. Comprueba la API local.";

// Secondary line under a catalog title: caption secondary.
const subStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};

// Download link of a finished export (a real anchor: the browser handles the URL).
const linkStyle: CSSProperties = {
  color: "var(--cocoa-accent)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"]
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
  const [reports, setReports] = useState<ReportState>({});
  const [reportType, setReportType] = useState<string>("reservation");
  const [format, setFormat] = useState<ReportFormat>("pdf");
  const [status, setStatus] = useState<string>("Cargando catálogo de informes…");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

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

  async function handleExport() {
    setExporting(true);
    setStatus("Creando exportación…");
    try {
      const result = (await exportOperationalReport(PROPERTY_ID, {
        reportType,
        format,
        query: { fromDate: "2026-05-01", toDate: "2026-05-31" }
      })) as ExportResult;
      setReports((current) => ({ ...current, exportResult: result }));
      setStatus(`Exportación lista: ${result.export.downloadUrl}`);
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : "No se pudo generar la exportación.");
    } finally {
      setExporting(false);
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
        { id: "centro-informes-export", label: "Generar exportación de informe", run: () => void handleExport() }
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
                {catalogReports.map((report) => (
                  <li key={report.code}>
                    <span>
                      <strong>{report.title}</strong>
                      {report.description ? <span style={subStyle}>{report.description}</span> : null}
                    </span>
                    <CocoaBadge tone="neutral">{report.formats?.join(" · ") ?? "—"}</CocoaBadge>
                  </li>
                ))}
              </ul>
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Exportar informe"
            meta="PDF · CSV · XLSX · JSON"
            footer={
              <div className="cocoa-row" data-gap="2">
                <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void handleExport()} loading={exporting}>
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
                <CocoaSelect id="reporting-center-format" value={format} onChange={(value) => setFormat(value as ReportFormat)} options={FORMAT_OPTIONS} />
              </CocoaField>
            </CocoaFormRow>
            {reports.exportResult ? (
              <CocoaCallout tone="success" title="Exportación lista">
                <a href={reports.exportResult.export.downloadUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                  Descargar exportación
                </a>
              </CocoaCallout>
            ) : null}
          </CocoaSection>
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
    </CocoaPage>
  );
}
