import { getActivePropertyId, getActivePropertyName } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();

type Bucket = {
  ratePercent: number;
  baseImponible: number;
  cuotaRepercutida: number;
  casillaBase: number;
  casillaCuota: number;
};

type Modelo303 = {
  fromDate: string;
  toDate: string;
  generatedAt: string;
  buckets: Bucket[];
  totals: { baseImponible: number; cuotaDevengada: number; netResult: number };
  casillas: Record<string, number>;
};

function defaultQuarter(): { from: string; to: string; label: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const q = Math.floor(month / 3) + 1;
  const fromMonth = (q - 1) * 3;
  const toMonth = fromMonth + 2;
  const from = `${year}-${String(fromMonth + 1).padStart(2, "0")}-01`;
  const toDay = new Date(Date.UTC(year, toMonth + 1, 0)).getUTCDate();
  const to = `${year}-${String(toMonth + 1).padStart(2, "0")}-${String(toDay).padStart(2, "0")}`;
  return { from, to, label: `${year} · Q${q}` };
}

function fmt(amount: number): string {
  return new Intl.NumberFormat("es-ES", { useGrouping: true, style: "currency", currency: "EUR", minimumFractionDigits: 2 }).format(amount);
}

export function Modelo303Screen() {
  const initial = useMemo(defaultQuarter, []);
  const [fromDate, setFromDate] = useState(initial.from);
  const [toDate, setToDate] = useState(initial.to);

  const { data, loading, error, refresh } = useApiData<Modelo303>(
    "/accounting/reports/modelo-303",
    { query: { propertyId: PROPERTY_ID, fromDate, toDate, periodType: "quarterly" } }
  );

  const casillaPairs = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.casillas).map(([key, value]) => ({ key, value }));
  }, [data]);

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">AEAT · Modelo 303</div>
          <h1 className="bo-page-title">Declaración trimestral del IVA</h1>
          <p className="bo-page-subtitle">
            Agregación de la cuenta <strong>477 H.P. IVA repercutido</strong> por bucket de tasa, con mapeo directo a las casillas oficiales del Modelo 303 para presentación.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" onClick={refresh}>↻ Recalcular</button>
          <button type="button" className="ghost">Export CSV</button>
          <button type="button" className="primary">Generar PDF AEAT</button>
        </div>
      </div>

      <div className="rev-toolbar">
        <div className="rev-toolbar-group">
          <label>Period</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </div>
        <div className="rev-toolbar-group">
          <label>End date</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        <div className="rev-toolbar-group">
          <label>Property</label>
          <select disabled defaultValue={getActivePropertyId()}><option value={getActivePropertyId()}>{getActivePropertyName()}</option></select>
        </div>
        <div className="rev-toolbar-spacer" />
        <div className="rev-toolbar-actions">
          <span className="bo-chip">Régimen general</span>
        </div>
      </div>

      {loading ? (
        <div className="bo-card" style={{ textAlign: "center", padding: 48, color: "var(--ink-muted)" }}>Calculando agregación…</div>
      ) : error ? (
        <div className="bo-card" style={{ borderLeft: "3px solid var(--danger-ink)" }}><h3>Error</h3><p className="bo-muted">Couldn't load this report right now. Refresh to retry.</p></div>
      ) : !data || data.buckets.length === 0 ? (
        <div className="bo-card" style={{ textAlign: "center", padding: 48 }}>
          <h3>Sin operaciones en este período</h3>
          <p>No hay líneas IVA repercutidas (cuenta 477) entre {fromDate} y {toDate}.</p>
        </div>
      ) : (
        <>
          <section className="rev-kpi-grid">
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Base imponible total</span></div>
              <div className="rev-kpi-value">{fmt(data.totals.baseImponible)}</div>
              <div className="rev-kpi-delta">Casilla 27</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Cuota devengada</span></div>
              <div className="rev-kpi-value">{fmt(data.totals.cuotaDevengada)}</div>
              <div className="rev-kpi-delta">Casilla 46</div>
            </article>
            <article className="rev-kpi rev-kpi-warn">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Resultado liquidación</span></div>
              <div className="rev-kpi-value">{fmt(data.totals.netResult)}</div>
              <div className="rev-kpi-delta">Casilla 71 · a ingresar</div>
            </article>
            <article className="rev-kpi">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Buckets activos</span></div>
              <div className="rev-kpi-value">{data.buckets.length}</div>
              <div className="rev-kpi-delta">tipos impositivos</div>
            </article>
          </section>

          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 20 }}>Desglose por tipo impositivo</h2>
              <span className="bo-chip">{data.fromDate} → {data.toDate}</span>
            </div>
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Tipo IVA</th>
                    <th style={{ textAlign: "right" }}>Base imponible</th>
                    <th style={{ textAlign: "right" }}>Cuota repercutida</th>
                    <th>Casilla base</th>
                    <th>Casilla cuota</th>
                  </tr>
                </thead>
                <tbody>
                  {data.buckets.map((b) => (
                    <tr key={b.ratePercent}>
                      <td><strong>{b.ratePercent}%</strong></td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(b.baseImponible)}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(b.cuotaRepercutida)}</td>
                      <td><span className="bo-chip">Casilla {b.casillaBase}</span></td>
                      <td><span className="bo-chip">Casilla {b.casillaCuota}</span></td>
                    </tr>
                  ))}
                  <tr>
                    <td><strong>TOTAL</strong></td>
                    <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>{fmt(data.totals.baseImponible)}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>{fmt(data.totals.cuotaDevengada)}</td>
                    <td><span className="bo-chip">Casilla 27</span></td>
                    <td><span className="bo-chip">Casilla 46</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 20 }}>Mapa de casillas AEAT</h2>
              <span className="bo-chip">{casillaPairs.length} casillas</span>
            </div>
            <p style={{ marginBottom: 16 }}>Estas son las casillas pre-rellenadas para el Modelo 303 oficial. Verifica antes de enviar al AEAT.</p>
            <div className="bo-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
              {casillaPairs.map(({ key, value }) => (
                <div key={key} className="bo-pill" style={{ display: "flex", flexDirection: "column", gap: 4, padding: 12, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--radius-md)" }}>
                  <span style={{ fontSize: 11, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{key.replace("casilla_", "Casilla ")}</span>
                  <strong style={{ fontFamily: "var(--font-mono)", fontSize: 14 }}>{fmt(value)}</strong>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}
