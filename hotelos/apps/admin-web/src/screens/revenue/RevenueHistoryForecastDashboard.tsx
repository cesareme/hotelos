import { useCallback, useEffect, useState } from "react";
import { fetchHistoryForecastReport, type ReportRow as LiveReportRow } from "../../services/revenueApi";
import { LoadingBlock, Spinner } from "../../components/States";
import { NarrowViewportBanner } from "../../components/NarrowViewportBanner";

function defaultFrom(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 14);
  return d.toISOString().slice(0, 10);
}
function defaultTo(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 21);
  return d.toISOString().slice(0, 10);
}

type Kpi = {
  label: string;
  value: string;
  delta?: string;
  forecast?: boolean;
  status: "ok" | "warn" | "error";
};

type ChartPoint = {
  label: string;
  history?: number;
  forecast?: number;
  confidenceLow?: number;
  confidenceHigh?: number;
};

type ReportRow = {
  rowType: "section" | "data" | "subtotal" | "total";
  label?: string;
  date?: string;
  totalOcc?: number;
  arrivalRooms?: number;
  compRooms?: number;
  houseUseRooms?: number;
  deductIndividualRooms?: number;
  nonDeductIndividualRooms?: number;
  deductGroupRooms?: number;
  nonDeductGroupRooms?: number;
  occPercent?: number;
  totalRevenue?: number;
  averageRate?: number;
  departureRooms?: number;
  dayUseRooms?: number;
  noShowRooms?: number;
  oooRooms?: number;
  adultsChildren?: number;
};

const kpis: Kpi[] = [
  { label: "Ocupación %", value: "73,33%", delta: "+6,0 pts vs. año anterior", status: "ok" },
  { label: "Ingresos de habitación", value: "28.300 €", delta: "+2.100 € vs. año anterior", status: "ok" },
  { label: "ADR", value: "137,52 €", delta: "-3,20 € vs. año anterior", status: "warn" },
  { label: "RevPAR", value: "94,33 €", delta: "+7,40 € vs. año anterior", status: "ok" },
  { label: "TRevPAR", value: "118,61 €", delta: "+8,10 € vs. año anterior", status: "ok" },
  { label: "GOPPAR", value: "54,13 €", forecast: true, status: "warn" },
  { label: "Entradas", value: "82 hab.", delta: "+9 vs. año anterior", status: "ok" },
  { label: "Salidas", value: "69 hab.", delta: "+6 vs. año anterior", status: "ok" },
  { label: "OOO", value: "15 hab.", delta: "-3 vs. plan", status: "warn" },
  { label: "Habitaciones cortesía", value: "1", status: "ok" },
  { label: "Confianza de la previsión", value: "76%", forecast: true, status: "warn" },
  { label: "Pickup últimos 7 días", value: "+34 noches", forecast: true, status: "ok" }
];

const occupancyChart: ChartPoint[] = [
  { label: "01/05", history: 76 },
  { label: "05/05", history: 82 },
  { label: "10/05", history: 88 },
  { label: "15/05", history: 90 },
  { label: "16/05", forecast: 92, confidenceLow: 86, confidenceHigh: 95 },
  { label: "20/05", forecast: 84, confidenceLow: 78, confidenceHigh: 90 },
  { label: "25/05", forecast: 62, confidenceLow: 55, confidenceHigh: 70 },
  { label: "29/05", forecast: 36, confidenceLow: 29, confidenceHigh: 45 },
  { label: "31/05", forecast: 62, confidenceLow: 55, confidenceHigh: 68 }
];

const revenueChart: ChartPoint[] = [
  { label: "01/05", history: 6280 },
  { label: "05/05", history: 7110 },
  { label: "10/05", history: 7830 },
  { label: "15/05", history: 7910 },
  { label: "16/05", forecast: 8120 },
  { label: "20/05", forecast: 7240 },
  { label: "25/05", forecast: 5410 },
  { label: "29/05", forecast: 3200 },
  { label: "31/05", forecast: 5380 }
];

const adrChart: ChartPoint[] = [
  { label: "01/05", history: 136 },
  { label: "10/05", history: 141 },
  { label: "15/05", history: 144 },
  { label: "16/05", forecast: 146 },
  { label: "20/05", forecast: 138 },
  { label: "25/05", forecast: 129 },
  { label: "29/05", forecast: 121 },
  { label: "31/05", forecast: 132 }
];

const revparChart: ChartPoint[] = [
  { label: "01/05", history: 103 },
  { label: "10/05", history: 124 },
  { label: "15/05", history: 129 },
  { label: "16/05", forecast: 134 },
  { label: "20/05", forecast: 116 },
  { label: "25/05", forecast: 80 },
  { label: "29/05", forecast: 44 },
  { label: "31/05", forecast: 82 }
];

const arrivalsChart: ChartPoint[] = [
  { label: "01/05", history: 12 },
  { label: "10/05", history: 9 },
  { label: "15/05", history: 14 },
  { label: "16/05", forecast: 20 },
  { label: "20/05", forecast: 16 },
  { label: "25/05", forecast: 11 },
  { label: "29/05", forecast: 6 },
  { label: "31/05", forecast: 9 }
];

const channelMix = [
  { channel: "Direct", history: 38, forecast: 40 },
  { channel: "Booking.com", history: 31, forecast: 32 },
  { channel: "Expedia", history: 14, forecast: 12 },
  { channel: "Google Hotels", history: 7, forecast: 9 },
  { channel: "Corporate", history: 6, forecast: 5 },
  { channel: "Wholesalers", history: 4, forecast: 2 }
];

const reportRows: ReportRow[] = [
  { rowType: "section", label: "Histórico" },
  { rowType: "data", date: "2026-05-01", totalOcc: 38, arrivalRooms: 12, compRooms: 1, houseUseRooms: 1, deductIndividualRooms: 31, nonDeductIndividualRooms: 2, deductGroupRooms: 4, nonDeductGroupRooms: 1, occPercent: 76, totalRevenue: 6280, averageRate: 136, departureRooms: 10, dayUseRooms: 0, noShowRooms: 1, oooRooms: 2, adultsChildren: 72 },
  { rowType: "data", date: "2026-05-08", totalOcc: 41, arrivalRooms: 14, compRooms: 0, houseUseRooms: 1, deductIndividualRooms: 35, nonDeductIndividualRooms: 1, deductGroupRooms: 4, nonDeductGroupRooms: 1, occPercent: 82, totalRevenue: 7110, averageRate: 141, departureRooms: 13, dayUseRooms: 1, noShowRooms: 0, oooRooms: 2, adultsChildren: 81 },
  { rowType: "data", date: "2026-05-15", totalOcc: 46, arrivalRooms: 20, compRooms: 0, houseUseRooms: 1, deductIndividualRooms: 39, nonDeductIndividualRooms: 1, deductGroupRooms: 5, nonDeductGroupRooms: 1, occPercent: 92, totalRevenue: 7910, averageRate: 144, departureRooms: 14, dayUseRooms: 1, noShowRooms: 1, oooRooms: 2, adultsChildren: 84 },
  { rowType: "subtotal", label: "Subtotal histórico", totalOcc: 125, arrivalRooms: 46, compRooms: 1, houseUseRooms: 3, occPercent: 83.33, totalRevenue: 21220, averageRate: 140.18, departureRooms: 37, dayUseRooms: 2, noShowRooms: 2, oooRooms: 6, adultsChildren: 237 },
  { rowType: "section", label: "Previsión" },
  { rowType: "data", date: "2026-05-16", totalOcc: 46, arrivalRooms: 20, compRooms: 0, houseUseRooms: 1, deductIndividualRooms: 36, nonDeductIndividualRooms: 3, deductGroupRooms: 6, nonDeductGroupRooms: 1, occPercent: 92, totalRevenue: 8120, averageRate: 146, departureRooms: 11, dayUseRooms: 1, noShowRooms: 1, oooRooms: 2, adultsChildren: 89 },
  { rowType: "data", date: "2026-05-22", totalOcc: 32, arrivalRooms: 10, compRooms: 0, houseUseRooms: 1, deductIndividualRooms: 25, nonDeductIndividualRooms: 1, deductGroupRooms: 5, nonDeductGroupRooms: 1, occPercent: 64, totalRevenue: 4180, averageRate: 130, departureRooms: 11, dayUseRooms: 0, noShowRooms: 1, oooRooms: 3, adultsChildren: 56 },
  { rowType: "data", date: "2026-05-29", totalOcc: 18, arrivalRooms: 6, compRooms: 0, houseUseRooms: 1, deductIndividualRooms: 14, nonDeductIndividualRooms: 1, deductGroupRooms: 2, nonDeductGroupRooms: 1, occPercent: 36, totalRevenue: 3160, averageRate: 121, departureRooms: 10, dayUseRooms: 0, noShowRooms: 1, oooRooms: 4, adultsChildren: 37 },
  { rowType: "subtotal", label: "Subtotal previsión", totalOcc: 95, arrivalRooms: 36, compRooms: 0, houseUseRooms: 3, occPercent: 63.33, totalRevenue: 15460, averageRate: 134.87, departureRooms: 32, dayUseRooms: 1, noShowRooms: 3, oooRooms: 9, adultsChildren: 182 },
  { rowType: "total", label: "Total", totalOcc: 220, arrivalRooms: 82, compRooms: 1, houseUseRooms: 6, occPercent: 73.33, totalRevenue: 36680, averageRate: 137.52, departureRooms: 69, dayUseRooms: 3, noShowRooms: 5, oooRooms: 15, adultsChildren: 419 }
];

const businessDate = "2026-05-15";

function navigateTo(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

function MiniChart(props: { points: ChartPoint[]; height?: number; showForecastBand?: boolean }) {
  const height = props.height ?? 140;
  const width = 720;
  const padding = 32;
  const all = props.points.flatMap((p) => [p.history, p.forecast, p.confidenceHigh, p.confidenceLow].filter((v): v is number => typeof v === "number"));
  const max = Math.max(...all, 1);
  const min = Math.min(...all, 0);
  const range = max - min || 1;
  const step = (width - padding * 2) / Math.max(props.points.length - 1, 1);

  function y(value: number) {
    return height - padding - ((value - min) / range) * (height - padding * 2);
  }
  function x(i: number) {
    return padding + step * i;
  }

  const historyPath = props.points
    .map((p, i) => (typeof p.history === "number" ? `${i === 0 || typeof props.points[i - 1]?.history !== "number" ? "M" : "L"} ${x(i)} ${y(p.history)}` : ""))
    .filter(Boolean)
    .join(" ");

  const firstForecastIdx = props.points.findIndex((p) => typeof p.forecast === "number");
  const forecastPath = props.points
    .map((p, i) => {
      if (typeof p.forecast !== "number") return "";
      const prev = props.points[i - 1];
      const cmd = i === firstForecastIdx || typeof prev?.forecast !== "number" ? "M" : "L";
      return `${cmd} ${x(i)} ${y(p.forecast)}`;
    })
    .filter(Boolean)
    .join(" ");

  const bandTop = props.points.map((p, i) => (typeof p.confidenceHigh === "number" ? `${i === firstForecastIdx ? "M" : "L"} ${x(i)} ${y(p.confidenceHigh)}` : "")).filter(Boolean).join(" ");
  const bandBottom = [...props.points]
    .map((p, i) => ({ p, i }))
    .reverse()
    .map(({ p, i }) => (typeof p.confidenceLow === "number" ? `L ${x(i)} ${y(p.confidenceLow)}` : ""))
    .filter(Boolean)
    .join(" ");
  const bandPath = bandTop && bandBottom ? `${bandTop} ${bandBottom} Z` : "";

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" style={{ width: "100%", height: "auto", minWidth: 0, display: "block" }}>
      <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#e2e8f0" strokeWidth={1} />
      <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="#e2e8f0" strokeWidth={1} />
      {props.showForecastBand && bandPath ? <path d={bandPath} fill="rgba(99, 102, 241, 0.12)" stroke="none" /> : null}
      {historyPath ? <path d={historyPath} fill="none" stroke="#1e3a8a" strokeWidth={2.5} /> : null}
      {forecastPath ? <path d={forecastPath} fill="none" stroke="#6366f1" strokeWidth={2.5} strokeDasharray="6 4" /> : null}
      {props.points.map((p, i) => {
        const v = p.history ?? p.forecast;
        if (typeof v !== "number") return null;
        return <circle key={`${p.label}-${i}`} cx={x(i)} cy={y(v)} r={3} fill={typeof p.history === "number" ? "#1e3a8a" : "#6366f1"} />;
      })}
      {props.points.map((p, i) => (
        <text key={`label-${p.label}-${i}`} x={x(i)} y={height - 10} fontSize={10} fill="#64748b" textAnchor="middle">
          {p.label}
        </text>
      ))}
    </svg>
  );
}

function ChannelMixBars(props: { rows: typeof channelMix }) {
  const max = Math.max(...props.rows.map((r) => Math.max(r.history, r.forecast)));
  return (
    <div className="bo-stack">
      {props.rows.map((row) => (
        <div key={row.channel} className="rev-channel-row">
          <span className="rev-channel-name">{row.channel}</span>
          <div className="rev-channel-bars">
            <div className="rev-channel-bar history" style={{ width: `${(row.history / max) * 100}%` }} title={`Histórico ${row.history}%`}>
              <span>{row.history}%</span>
            </div>
            <div className="rev-channel-bar forecast" style={{ width: `${(row.forecast / max) * 100}%` }} title={`Previsión ${row.forecast}%`}>
              <span>{row.forecast}%</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ReportTable(props: { rows: ReportRow[] }) {
  return (
    <div className="rev-report-wrap">
      <table className="rev-report-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Ocup. total</th>
            <th>Entradas</th>
            <th>Cortesía</th>
            <th>Uso interno</th>
            <th>Deduc. ind.</th>
            <th>No deduc. ind.</th>
            <th>Deduc. grupo</th>
            <th>No deduc. grupo</th>
            <th>Ocup. %</th>
            <th>Ingresos totales</th>
            <th>ADR</th>
            <th>Salidas</th>
            <th>OOO</th>
            <th>Adultos/Niños</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, index) => {
            if (row.rowType === "section") {
              return (
                <tr key={`section-${index}`} className="rev-report-section">
                  <td colSpan={15}>{row.label}</td>
                </tr>
              );
            }
            const cls = row.rowType === "subtotal" ? "rev-report-subtotal" : row.rowType === "total" ? "rev-report-total" : undefined;
            return (
              <tr key={`row-${index}`} className={cls}>
                <td>{row.label ?? row.date ?? "-"}</td>
                <td>{row.totalOcc ?? "-"}</td>
                <td>{row.arrivalRooms ?? "-"}</td>
                <td>{row.compRooms ?? "-"}</td>
                <td>{row.houseUseRooms ?? "-"}</td>
                <td>{row.deductIndividualRooms ?? "-"}</td>
                <td>{row.nonDeductIndividualRooms ?? "-"}</td>
                <td>{row.deductGroupRooms ?? "-"}</td>
                <td>{row.nonDeductGroupRooms ?? "-"}</td>
                <td>{typeof row.occPercent === "number" ? `${row.occPercent.toFixed(2)}%` : "-"}</td>
                <td>{typeof row.totalRevenue === "number" ? `${row.totalRevenue.toLocaleString("es-ES")} €` : "-"}</td>
                <td>{typeof row.averageRate === "number" ? `${row.averageRate.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : "-"}</td>
                <td>{row.departureRooms ?? "-"}</td>
                <td>{row.oooRooms ?? "-"}</td>
                <td>{row.adultsChildren ?? "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function RevenueHistoryForecastDashboard() {
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(defaultTo());
  const [report, setReport] = useState<LiveReportRow[] | null>(null);
  const [reportLoading, setReportLoading] = useState(true);
  const [liveBusinessDate, setLiveBusinessDate] = useState<string>(businessDate);
  const [refreshedAt, setRefreshedAt] = useState<string>("");

  const loadReport = useCallback(async () => {
    setReportLoading(true);
    try {
      const r = await fetchHistoryForecastReport(from, to);
      setReport(r.rows);
      setLiveBusinessDate(r.businessDate);
      setRefreshedAt(new Date().toLocaleTimeString("es-ES"));
    } catch {
      setReport([]);
    } finally {
      setReportLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void loadReport();
    const timer = setInterval(loadReport, 30000); // live: auto-refresh
    return () => clearInterval(timer);
  }, [loadReport]);

  return (
    <>
    <NarrowViewportBanner />
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Analítica visual de revenue</p>
          <h2>Histórico y Previsión</h2>
        </div>
        <div className="bo-pill-row">
          <span className="bo-status info" style={{ textTransform: "none" }}>Datos de ejemplo</span>
          <span className="bo-chip">Periodo &gt; 1 día, &lt; 12 meses</span>
        </div>
      </div>
      <p>Cabina de revenue visual con la tabla detallada clásica (en vivo) detrás de cada KPI. Histórico = fechas ≤ fecha de negocio ({liveBusinessDate}). Previsión = fechas &gt; fecha de negocio.</p>

      <div className="rev-toolbar">
        <div className="rev-toolbar-group">
          <label>Periodo</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span>a</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="rev-toolbar-group">
          <label>Granularidad</label>
          <select defaultValue="daily">
            <option value="daily">Diaria</option>
            <option value="weekly">Semanal</option>
            <option value="monthly">Mensual</option>
          </select>
        </div>
        <div className="rev-toolbar-group">
          <label>Comparación</label>
          <select defaultValue="ly">
            <option value="ly">Año anterior</option>
            <option value="lly">Hace dos años</option>
            <option value="budget">Presupuesto</option>
            <option value="none">Ninguna</option>
          </select>
        </div>
        <div className="rev-toolbar-group">
          <label>Ingresos</label>
          <select defaultValue="net">
            <option value="net">Netos</option>
            <option value="gross">Brutos</option>
          </select>
        </div>
        <div className="rev-toolbar-group">
          <label>Grupo</label>
          <select defaultValue="all">
            <option value="all">Todos</option>
            <option value="individual">Solo individual</option>
            <option value="group">Solo grupo</option>
          </select>
        </div>
        <div className="rev-toolbar-group">
          <label>OOO</label>
          <select defaultValue="excluded">
            <option value="included">Incluir OOO</option>
            <option value="excluded">Excluir OOO</option>
          </select>
        </div>
      </div>

      <div className="rev-kpi-grid">
        {kpis.map((kpi) => (
          <article key={kpi.label} className={`rev-kpi rev-kpi-${kpi.status}`}>
            <div className="rev-kpi-head">
              <span className="rev-kpi-label">{kpi.label}</span>
              {kpi.forecast ? <span className="rev-kpi-tag">previsión</span> : null}
            </div>
            <div className="rev-kpi-value">{kpi.value}</div>
            {kpi.delta ? <div className="rev-kpi-delta">{kpi.delta}</div> : null}
          </article>
        ))}
      </div>

      <div className="rev-legend">
        <span className="rev-legend-item history">Histórico</span>
        <span className="rev-legend-item forecast">Previsión</span>
        <span className="rev-legend-item band">Banda de confianza</span>
        <span className="rev-legend-business">Fecha de negocio: {liveBusinessDate}</span>
      </div>

      <div className="bo-grid two">
        <article className="bo-card">
          <h3>Histórico vs Previsión — Ocupación %</h3>
          <MiniChart points={occupancyChart} showForecastBand />
        </article>
        <article className="bo-card">
          <h3>Ingresos (€)</h3>
          <MiniChart points={revenueChart} />
        </article>
        <article className="bo-card">
          <h3>ADR (€)</h3>
          <MiniChart points={adrChart} />
        </article>
        <article className="bo-card">
          <h3>RevPAR (€)</h3>
          <MiniChart points={revparChart} />
        </article>
        <article className="bo-card">
          <h3>Entradas / Salidas (hab.)</h3>
          <MiniChart points={arrivalsChart} />
        </article>
        <article className="bo-card">
          <h3>Mix de canales — Histórico vs Previsión (%)</h3>
          <ChannelMixBars rows={channelMix} />
        </article>
      </div>

      <article className="bo-card">
        <div className="bo-card-head">
          <h3>Confianza de la previsión</h3>
          <span className="bo-status warn">76%</span>
        </div>
        <p>La confianza se pondera por el ritmo de reservas (pace), el mix de canales y el inventario OOO. Factores:</p>
        <ul className="bo-list">
          <li>Ritmo de reservas por encima de lo normal en los próximos 7 días.</li>
          <li>Cinco habitaciones OOO previstas en torno al 29/05 reducen el inventario vendible.</li>
          <li>Las credenciales de Expedia están fallando; el mix de canales podría desplazarse hacia el directo.</li>
        </ul>
      </article>

      <article className="bo-card rev-alert">
        <div className="bo-card-head">
          <h3>Fecha de baja demanda</h3>
          <span className="bo-status warn">29/05/2026</span>
        </div>
        <p>La ocupación prevista para el 29/05 es del 36%, por debajo del objetivo. Acción sugerida: revisa tarifa, restricciones y canales de marketing antes de que la automatización aplique recomendaciones.</p>
        <div className="bo-actions">
          <button type="button" className="primary" onClick={() => navigateTo("RevenueRecommendationRules")}>Abrir recomendaciones</button>
        </div>
      </article>

      <article className="bo-card">
        <div className="bo-card-head">
          <div>
            <h3>Tabla de informe detallada</h3>
            <p className="bo-muted" style={{ margin: "2px 0 0", textTransform: "none", fontSize: 12 }}>
              {from} a {to} · histórico real + previsión{refreshedAt ? ` · actualizado ${refreshedAt}` : ""}
            </p>
          </div>
          <div className="bo-pill-row">
            <span className="bo-status ok" style={{ textTransform: "none" }}>En vivo</span>
            <button type="button" onClick={() => void loadReport()} disabled={reportLoading}>
              {reportLoading ? <><Spinner size="sm" /> Cargando…</> : "↻ Actualizar"}
            </button>
          </div>
        </div>
        {report === null ? (
          <LoadingBlock label="Cargando informe en vivo…" />
        ) : report.length === 0 ? (
          <p className="bo-muted">No hay datos para el periodo seleccionado. Ajusta las fechas o genera la previsión.</p>
        ) : (
          <ReportTable rows={report as ReportRow[]} />
        )}
      </article>
    </section>
    </>
  );
}
