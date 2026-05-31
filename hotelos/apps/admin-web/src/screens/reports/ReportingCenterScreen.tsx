import { useEffect, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import {
  exportOperationalReport,
  fetchBillingReport,
  fetchReportCatalog,
  fetchReservationReport
} from "../../services/pmsCommerceApi";

const PROPERTY_ID = getActivePropertyId();

// Tipos reales — antes era todo `any`. La forma de la respuesta del servicio
// está documentada en `services/pmsCommerceApi.ts` y replicada aquí para que
// el render quede tipado y sin warnings.

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

export function ReportingCenterScreen() {
  const [reports, setReports] = useState<ReportState>({});
  const [reportType, setReportType] = useState<string>("reservation");
  const [format, setFormat] = useState<ReportFormat>("pdf");
  const [status, setStatus] = useState<string>("Cargando catálogo de informes…");

  async function refresh() {
    const [catalog, reservation, billing] = await Promise.all([
      fetchReportCatalog(PROPERTY_ID) as Promise<ReportCatalog>,
      fetchReservationReport(PROPERTY_ID) as Promise<ReservationReport>,
      fetchBillingReport(PROPERTY_ID) as Promise<BillingReport>
    ]);
    setReports({ catalog, reservation, billing });
    setStatus(`Informes cargados desde el API · ${catalog.reports?.length ?? 0} disponibles.`);
  }

  useEffect(() => {
    void refresh().catch(() => setStatus("No se pudieron cargar los informes. Comprueba la API local."));
  }, []);

  async function handleExport() {
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
    }
  }

  const reservationKpis = reports.reservation?.kpis ?? {};
  const billingKpis = reports.billing?.kpis ?? {};
  const catalogReports: ReportCatalogItem[] = reports.catalog?.reports ?? [];

  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Hotel Intelligence Platform</p>
          <h2>Centro de informes</h2>
        </div>
        <span className="bo-chip">{catalogReports.length} informes disponibles</span>
      </div>
      <p>
        Los informes son superficies de producto: reservas, facturación, revenue y propietario
        exponen sus entradas, categorías, formatos y exportaciones desde un único panel.
      </p>

      <div className="bo-grid">
        <article className="bo-card">
          <span className="bo-muted">Reservas</span>
          <div className="bo-metric">{reservationKpis.reservations ?? 0}</div>
          <p>Llegadas {reservationKpis.arrivals ?? 0} · Salidas {reservationKpis.departures ?? 0}</p>
        </article>
        <article className="bo-card">
          <span className="bo-muted">Valor reservado</span>
          <div className="bo-metric">{reservationKpis.totalAmount ?? 0}</div>
          <p>Importe total del informe de reservas.</p>
        </article>
        <article className="bo-card">
          <span className="bo-muted">Facturación</span>
          <div className="bo-metric">{billingKpis.invoiceCount ?? 0}</div>
          <p>Facturas · Saldos abiertos {billingKpis.openFolioBalances ?? 0}</p>
        </article>
      </div>

      <div className="bo-grid two">
        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Catálogo de informes</h3>
            <span className="bo-status ok">{catalogReports.length} informes</span>
          </div>
          {catalogReports.map((report) => (
            <article className="bo-row" key={report.code}>
              <span>
                <strong>{report.title}</strong>
                {report.description ? <small>{report.description}</small> : null}
              </span>
              <span className="bo-pill">{report.formats?.join(" · ") ?? "—"}</span>
            </article>
          ))}
        </section>

        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Exportar informe</h3>
            <span className="bo-chip">PDF · CSV · XLSX · JSON</span>
          </div>
          <div className="bo-grid two">
            <label className="bo-form-field">
              <span>Tipo de informe</span>
              <select value={reportType} onChange={(event) => setReportType(event.target.value)}>
                {Object.entries(REPORT_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="bo-form-field">
              <span>Formato</span>
              <select value={format} onChange={(event) => setFormat(event.target.value as ReportFormat)}>
                <option value="pdf">PDF</option>
                <option value="csv">CSV</option>
                <option value="xlsx">XLSX</option>
                <option value="json">JSON</option>
              </select>
            </label>
          </div>
          <div className="bo-actions">
            <button className="primary" onClick={handleExport} type="button">Generar exportación</button>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "RevenueHistoryForecastDashboard" }))}
              type="button"
            >
              Abrir histórico y previsión
            </button>
          </div>
          {reports.exportResult ? (
            <p className="bo-muted" style={{ marginTop: 8 }}>
              <span className="bo-status ok">Listo</span>{" "}
              <a
                href={reports.exportResult.export.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent-strong)" }}
              >
                Descargar exportación
              </a>
            </p>
          ) : null}
        </section>
      </div>

      <div className="bo-grid two">
        <section className="bo-card">
          <h3>Informe de reservas</h3>
          {(reports.reservation?.rows ?? []).map((row) => (
            <div className="bo-row" key={row.reservationId}>
              <span>{row.code} · {row.guestName}</span>
              <strong>{row.totalAmount} {row.currency}</strong>
            </div>
          ))}
        </section>
        <section className="bo-card">
          <h3>Informe de facturación</h3>
          {(reports.billing?.folios ?? []).map((row) => (
            <div className="bo-row" key={row.folioId}>
              <span>{row.folioId} · {row.status}</span>
              <strong>{row.balanceDue} {row.currency}</strong>
            </div>
          ))}
        </section>
      </div>
      <p className="bo-muted">{status}</p>
    </section>
  );
}
