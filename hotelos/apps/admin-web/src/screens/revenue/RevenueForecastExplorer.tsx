import { useMemo } from "react";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { getActivePropertyId } from "../../services/activeProperty";
import { ErrorState, LoadingBlock, SkeletonLines } from "../../components/States";
import { money } from "../../services/revenueApi";

// Live shape returned by GET /revenue/properties/:propertyId/forecast
// (see apps/api/src/modules/revenue/forecast.service.ts → mapForecast).
type ForecastRow = {
  id: string;
  propertyId: string;
  forecastDate: string;
  roomTypeId?: string;
  expectedOccupancy: number;
  expectedRoomsSold: number;
  expectedAdr: number;
  expectedRevpar: number;
  expectedRoomRevenue: number;
  expectedTotalRevenue: number;
  confidence: number;
  modelVersion?: string;
  drivers?: unknown;
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function rangeFrom(days: number): { from: string; to: string } {
  const today = new Date();
  const to = new Date(today.getTime() + (days - 1) * 86_400_000);
  return { from: isoDate(today), to: isoDate(to) };
}
function fmtPct(value: number, fractionDigits = 1): string {
  // expectedOccupancy is stored as 0..1 in the canonical RevenueForecast table.
  const pct = value > 1.5 ? value : value * 100;
  return `${pct.toLocaleString("es-ES", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}%`;
}
function fmtDate(iso: string): string {
  // 2026-05-31 → 31/05
  const [, mm, dd] = iso.split("-");
  return `${dd}/${mm}`;
}
function confidenceTone(c: number): "ok" | "warn" | "error" {
  const pct = c > 1.5 ? c : c * 100;
  if (pct >= 75) return "ok";
  if (pct >= 50) return "warn";
  return "error";
}

export function RevenueForecastExplorer() {
  const propertyId = getActivePropertyId();
  const { from, to } = useMemo(() => rangeFrom(30), []);

  const { data, loading, error, refresh } = useApiData<ForecastRow[]>(
    `/revenue/properties/${propertyId}/forecast`,
    { query: { from, to } }
  );
  const rows = useMemo(() => toArray<ForecastRow>(data), [data]);

  const summary = useMemo(() => {
    if (rows.length === 0) {
      return { days: 0, avgOcc: 0, avgAdr: 0, avgRevpar: 0, totalRevenue: 0, avgConfidence: 0 };
    }
    const sumOcc = rows.reduce((acc, r) => acc + Number(r.expectedOccupancy || 0), 0);
    const sumAdr = rows.reduce((acc, r) => acc + Number(r.expectedAdr || 0), 0);
    const sumRevpar = rows.reduce((acc, r) => acc + Number(r.expectedRevpar || 0), 0);
    const totalRevenue = rows.reduce((acc, r) => acc + Number(r.expectedRoomRevenue || 0), 0);
    const sumConfidence = rows.reduce((acc, r) => acc + Number(r.confidence || 0), 0);
    return {
      days: rows.length,
      avgOcc: sumOcc / rows.length,
      avgAdr: sumAdr / rows.length,
      avgRevpar: sumRevpar / rows.length,
      totalRevenue,
      avgConfidence: sumConfidence / rows.length
    };
  }, [rows]);

  const confidenceStatus = confidenceTone(summary.avgConfidence);

  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Forecast explorer</p>
          <h2>Forecast Confidence and Drivers</h2>
          <p className="bo-muted" style={{ margin: "4px 0 0", textTransform: "none", fontSize: 12 }}>
            Próximos 30 días · {from} → {to}
          </p>
        </div>
        <div className="bo-pill-row">
          <span className="bo-status info" style={{ textTransform: "none" }}>En vivo</span>
          <button type="button" onClick={refresh} disabled={loading}>
            ↻ Actualizar
          </button>
        </div>
      </div>

      {error ? (
        <ErrorState
          title="No se pudo cargar la previsión"
          message={error}
          onRetry={refresh}
        />
      ) : loading && rows.length === 0 ? (
        <>
          <LoadingBlock label="Cargando previsión…" />
          <div style={{ marginTop: 16 }}>
            <SkeletonLines lines={6} />
          </div>
        </>
      ) : rows.length === 0 ? (
        <p className="bo-muted">
          No hay previsión generada para los próximos 30 días. Genera la previsión desde el panel de Revenue.
        </p>
      ) : (
        <>
          <div className="rev-kpi-grid">
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Días con previsión</span></div>
              <div className="rev-kpi-value">{summary.days}</div>
            </article>
            <article className={`rev-kpi rev-kpi-${confidenceStatus}`}>
              <div className="rev-kpi-head">
                <span className="rev-kpi-label">Confianza media</span>
                <span className="rev-kpi-tag">previsión</span>
              </div>
              <div className="rev-kpi-value">{fmtPct(summary.avgConfidence, 0)}</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head">
                <span className="rev-kpi-label">Ocupación media</span>
                <span className="rev-kpi-tag">previsión</span>
              </div>
              <div className="rev-kpi-value">{fmtPct(summary.avgOcc, 1)}</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head">
                <span className="rev-kpi-label">ADR medio</span>
                <span className="rev-kpi-tag">previsión</span>
              </div>
              <div className="rev-kpi-value">{money(summary.avgAdr)}</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head">
                <span className="rev-kpi-label">RevPAR medio</span>
                <span className="rev-kpi-tag">previsión</span>
              </div>
              <div className="rev-kpi-value">{money(summary.avgRevpar)}</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head">
                <span className="rev-kpi-label">Ingresos previstos (30d)</span>
                <span className="rev-kpi-tag">previsión</span>
              </div>
              <div className="rev-kpi-value">{money(summary.totalRevenue)}</div>
            </article>
          </div>

          <div className="rev-report-wrap" style={{ marginTop: 16 }}>
            <table className="rev-report-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Ocup. prevista</th>
                  <th>Hab. vendidas</th>
                  <th>ADR</th>
                  <th>RevPAR</th>
                  <th>Ingresos hab.</th>
                  <th>Confianza</th>
                  <th>Modelo</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const tone = confidenceTone(Number(row.confidence || 0));
                  return (
                    <tr key={row.id}>
                      <td>{fmtDate(row.forecastDate)}</td>
                      <td>{fmtPct(Number(row.expectedOccupancy || 0), 1)}</td>
                      <td>{Math.round(Number(row.expectedRoomsSold || 0))}</td>
                      <td>{money(Number(row.expectedAdr || 0))}</td>
                      <td>{money(Number(row.expectedRevpar || 0))}</td>
                      <td>{money(Number(row.expectedRoomRevenue || 0))}</td>
                      <td>
                        <span className={`bo-status ${tone}`} style={{ textTransform: "none" }}>
                          {fmtPct(Number(row.confidence || 0), 0)}
                        </span>
                      </td>
                      <td><code style={{ fontSize: 12 }}>{row.modelVersion ?? "—"}</code></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="bo-muted" style={{ marginTop: 12, textTransform: "none", fontSize: 12 }}>
            Fuente: GET /revenue/properties/{propertyId}/forecast (range=30d). La confianza, ocupación y
            ADR se calculan en el backend desde la tabla canónica RevenueForecast, sin invenciones del cliente.
          </p>
        </>
      )}
    </section>
  );
}
