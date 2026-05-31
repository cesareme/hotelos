import { getActivePropertyId, getActivePropertyName } from "../../services/activeProperty";
import { useState } from "react";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();

type Quarter = { quarter: 1 | 2 | 3 | 4; fromDate: string; toDate: string; baseImponible: number; cuotaRepercutida: number };
type Bucket = {
  ratePercent: number;
  baseAnual: number;
  cuotaAnual: number;
  baseQ1: number; cuotaQ1: number;
  baseQ2: number; cuotaQ2: number;
  baseQ3: number; cuotaQ3: number;
  baseQ4: number; cuotaQ4: number;
};

type Modelo390 = {
  year: number;
  quarters: Quarter[];
  buckets: Bucket[];
  totals: { baseAnual: number; cuotaAnualDevengada: number; cuotaAnualLiquidada: number };
  casillas: Record<string, number>;
};

function fmt(amount: number): string {
  return new Intl.NumberFormat("es-ES", { useGrouping: true, style: "currency", currency: "EUR", minimumFractionDigits: 2 }).format(amount);
}

export function Modelo390Screen() {
  const [year, setYear] = useState<number>(new Date().getUTCFullYear());
  const { data, loading, error, refresh } = useApiData<Modelo390>(
    "/accounting/reports/modelo-390",
    { query: { propertyId: PROPERTY_ID, year } }
  );

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">AEAT · Modelo 390</div>
          <h1 className="bo-page-title">Resumen anual del IVA {year}</h1>
          <p className="bo-page-subtitle">
            Consolidación de los 4 modelos 303 trimestrales con desglose por bucket de tasa, comparativa por trimestre y mapeo a las casillas Modelo 390.
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
          <label>Ejercicio</label>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[year + 1, year, year - 1, year - 2, year - 3].map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div className="rev-toolbar-group">
          <label>Property</label>
          <select disabled defaultValue={getActivePropertyId()}><option value={getActivePropertyId()}>{getActivePropertyName()}</option></select>
        </div>
        <div className="rev-toolbar-spacer" />
        <div className="rev-toolbar-actions">
          <span className="bo-chip">Régimen general</span>
          <span className="bo-chip">Mainland · IVA</span>
        </div>
      </div>

      {loading ? (
        <div className="bo-card" style={{ textAlign: "center", padding: 48, color: "var(--ink-muted)" }}>Calculando consolidación anual…</div>
      ) : error ? (
        <div className="bo-card" style={{ borderLeft: "3px solid var(--danger-ink)" }}><h3>Error</h3><p className="bo-muted">Couldn't load this report right now. Refresh to retry.</p></div>
      ) : !data ? null : (
        <>
          <section className="rev-kpi-grid">
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Base imponible anual</span></div>
              <div className="rev-kpi-value">{fmt(data.totals.baseAnual)}</div>
              <div className="rev-kpi-delta">Casilla 99 · Modelo 390</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Cuota devengada anual</span></div>
              <div className="rev-kpi-value">{fmt(data.totals.cuotaAnualDevengada)}</div>
              <div className="rev-kpi-delta">Casilla 109 · Modelo 390</div>
            </article>
            <article className="rev-kpi rev-kpi-warn">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Liquidación anual</span></div>
              <div className="rev-kpi-value">{fmt(data.totals.cuotaAnualLiquidada)}</div>
              <div className="rev-kpi-delta">Casilla 662 · resultado</div>
            </article>
            <article className="rev-kpi">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Trimestres con operaciones</span></div>
              <div className="rev-kpi-value">{data.quarters.filter((q) => q.baseImponible > 0).length} / 4</div>
              <div className="rev-kpi-delta">{data.buckets.length} buckets</div>
            </article>
          </section>

          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 20 }}>Comparativa trimestral</h2>
              <span className="bo-chip">{data.year}</span>
            </div>
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Trimestre</th>
                    <th>Período</th>
                    <th style={{ textAlign: "right" }}>Base imponible</th>
                    <th style={{ textAlign: "right" }}>Cuota repercutida</th>
                    <th style={{ textAlign: "right" }}>% del año</th>
                  </tr>
                </thead>
                <tbody>
                  {data.quarters.map((q) => {
                    const pct = data.totals.cuotaAnualDevengada > 0 ? (q.cuotaRepercutida / data.totals.cuotaAnualDevengada) * 100 : 0;
                    return (
                      <tr key={q.quarter}>
                        <td><strong>Q{q.quarter}</strong></td>
                        <td style={{ fontSize: 12, color: "var(--ink-muted)" }}>{q.fromDate} → {q.toDate}</td>
                        <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(q.baseImponible)}</td>
                        <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(q.cuotaRepercutida)}</td>
                        <td style={{ textAlign: "right" }}>{pct.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                  <tr style={{ background: "var(--surface-soft)" }}>
                    <td><strong>ANUAL</strong></td>
                    <td>—</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>{fmt(data.totals.baseAnual)}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>{fmt(data.totals.cuotaAnualDevengada)}</td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>100%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 20 }}>Buckets por tipo IVA × trimestre</h2>
            </div>
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th style={{ textAlign: "right" }}>Q1 base</th>
                    <th style={{ textAlign: "right" }}>Q2 base</th>
                    <th style={{ textAlign: "right" }}>Q3 base</th>
                    <th style={{ textAlign: "right" }}>Q4 base</th>
                    <th style={{ textAlign: "right" }}>Base anual</th>
                    <th style={{ textAlign: "right" }}>Cuota anual</th>
                  </tr>
                </thead>
                <tbody>
                  {data.buckets.map((b) => (
                    <tr key={b.ratePercent}>
                      <td><strong>{b.ratePercent}%</strong></td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(b.baseQ1)}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(b.baseQ2)}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(b.baseQ3)}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(b.baseQ4)}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>{fmt(b.baseAnual)}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>{fmt(b.cuotaAnual)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 20 }}>Cuadre Modelo 303 vs Modelo 390</h2>
              <span className="bo-chip">control coherence</span>
            </div>
            <p style={{ marginBottom: 12 }}>
              La suma de las cuotas devengadas de los 4 modelos 303 trimestrales debe ser exactamente igual a la cuota anual devengada del Modelo 390.
              Si hay diferencia, hay un asiento fuera de período o un modelo 303 sin presentar.
            </p>
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Concepto</th>
                    <th style={{ textAlign: "right" }}>Suma Modelos 303 (Q1+Q2+Q3+Q4)</th>
                    <th style={{ textAlign: "right" }}>Modelo 390 anual</th>
                    <th style={{ textAlign: "right" }}>Diferencia</th>
                    <th>Cuadre</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const sum303Base = data.quarters.reduce((s, q) => s + q.baseImponible, 0);
                    const sum303Cuota = data.quarters.reduce((s, q) => s + q.cuotaRepercutida, 0);
                    const diffBase = Math.round((sum303Base - data.totals.baseAnual) * 100) / 100;
                    const diffCuota = Math.round((sum303Cuota - data.totals.cuotaAnualDevengada) * 100) / 100;
                    return (
                      <>
                        <tr>
                          <td><strong>Base imponible</strong></td>
                          <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(sum303Base)}</td>
                          <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(data.totals.baseAnual)}</td>
                          <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(diffBase)}</td>
                          <td><span className={`cm-pill ${diffBase === 0 ? "cm-pill-ok" : "cm-pill-error"}`}>{diffBase === 0 ? "✓ cuadra" : "Δ revisar"}</span></td>
                        </tr>
                        <tr>
                          <td><strong>Cuota devengada</strong></td>
                          <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(sum303Cuota)}</td>
                          <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(data.totals.cuotaAnualDevengada)}</td>
                          <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(diffCuota)}</td>
                          <td><span className={`cm-pill ${diffCuota === 0 ? "cm-pill-ok" : "cm-pill-error"}`}>{diffCuota === 0 ? "✓ cuadra" : "Δ revisar"}</span></td>
                        </tr>
                      </>
                    );
                  })()}
                </tbody>
              </table>
            </div>
          </section>

          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 20 }}>Casillas Modelo 390</h2>
              <span className="bo-chip">{Object.keys(data.casillas).length} casillas</span>
            </div>
            <div className="bo-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
              {Object.entries(data.casillas).map(([key, value]) => (
                <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4, padding: 12, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--radius-md)" }}>
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
