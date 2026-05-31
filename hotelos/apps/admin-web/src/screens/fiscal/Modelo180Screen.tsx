import { getActivePropertyId, getActivePropertyName } from "../../services/activeProperty";
import { useState } from "react";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();

type Quarter = {
  quarter: 1 | 2 | 3 | 4;
  fromDate: string;
  toDate: string;
  perceptores: number;
  base: number;
  retenciones: number;
};

type Lessor = {
  recipientNif: string;
  recipientName: string;
  recipientAddress: string;
  cadastralReference: string;
  importeIntegro: number;
  retencion: number;
};

type Modelo180 = {
  year: number;
  quarters: Quarter[];
  lessors: Lessor[];
  totals: { perceptores: number; baseAnual: number; retencionAnual: number };
  casillas: Record<string, number>;
};

function fmt(amount: number): string {
  return new Intl.NumberFormat("es-ES", { useGrouping: true, style: "currency", currency: "EUR", minimumFractionDigits: 2 }).format(amount);
}

export function Modelo180Screen() {
  const [year, setYear] = useState<number>(new Date().getUTCFullYear());
  const { data, loading, error, refresh } = useApiData<Modelo180>(
    "/accounting/reports/modelo-180",
    { query: { propertyId: PROPERTY_ID, year } }
  );

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">AEAT · Modelo 180</div>
          <h1 className="bo-page-title">Resumen anual retenciones arrendamientos {year}</h1>
          <p className="bo-page-subtitle">
            Consolidación de los 4 modelos 115 trimestrales con desglose por arrendador (NIF, nombre, dirección del
            inmueble y referencia catastral) y mapeo a las casillas oficiales del Modelo 180.
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
          <span className="bo-chip">Arrendamientos urbanos</span>
          <span className="bo-chip">Resumen anual</span>
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
              <div className="rev-kpi-head"><span className="rev-kpi-label">Perceptores anuales</span></div>
              <div className="rev-kpi-value">{data.totals.perceptores}</div>
              <div className="rev-kpi-delta">Casilla 01 · arrendadores distintos</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Base anual retenciones</span></div>
              <div className="rev-kpi-value">{fmt(data.totals.baseAnual)}</div>
              <div className="rev-kpi-delta">Casilla 02 · importe íntegro</div>
            </article>
            <article className="rev-kpi rev-kpi-warn">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Retención anual</span></div>
              <div className="rev-kpi-value">{fmt(data.totals.retencionAnual)}</div>
              <div className="rev-kpi-delta">Casilla 03 · suma anual</div>
            </article>
            <article className="rev-kpi">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Trimestres con operaciones</span></div>
              <div className="rev-kpi-value">{data.quarters.filter((q) => q.retenciones > 0).length} / 4</div>
              <div className="rev-kpi-delta">{data.lessors.length} arrendadores en desglose</div>
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
                    <th style={{ textAlign: "right" }}>Perceptores</th>
                    <th style={{ textAlign: "right" }}>Base</th>
                    <th style={{ textAlign: "right" }}>Retenciones</th>
                    <th style={{ textAlign: "right" }}>% del año</th>
                  </tr>
                </thead>
                <tbody>
                  {data.quarters.map((q) => {
                    const pct = data.totals.retencionAnual > 0 ? (q.retenciones / data.totals.retencionAnual) * 100 : 0;
                    return (
                      <tr key={q.quarter}>
                        <td><strong>Q{q.quarter}</strong></td>
                        <td style={{ fontSize: 12, color: "var(--ink-muted)" }}>{q.fromDate} → {q.toDate}</td>
                        <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{q.perceptores}</td>
                        <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(q.base)}</td>
                        <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(q.retenciones)}</td>
                        <td style={{ textAlign: "right" }}>{pct.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                  <tr style={{ background: "var(--surface-soft)" }}>
                    <td><strong>ANUAL</strong></td>
                    <td>—</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>{data.totals.perceptores}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>{fmt(data.totals.baseAnual)}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>{fmt(data.totals.retencionAnual)}</td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>100%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 20 }}>Desglose por arrendador</h2>
              <span className="bo-chip">{data.lessors.length} perceptores</span>
            </div>
            {data.lessors.length === 0 ? (
              <div style={{ textAlign: "center", padding: 32, color: "var(--ink-muted)" }}>
                Sin arrendadores registrados en {data.year}. La cuenta 4751 (arrendamientos urbanos) está a cero para el ejercicio.
              </div>
            ) : (
              <div className="rev-report-wrap">
                <table className="cm-table">
                  <thead>
                    <tr>
                      <th>NIF</th>
                      <th>Nombre / razón social</th>
                      <th>Dirección inmueble</th>
                      <th>Ref. catastral</th>
                      <th style={{ textAlign: "right" }}>Importe íntegro</th>
                      <th style={{ textAlign: "right" }}>Retención</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lessors.map((l) => (
                      <tr key={`${l.recipientNif}|${l.cadastralReference}`}>
                        <td style={{ fontFamily: "var(--font-mono)" }}>{l.recipientNif}</td>
                        <td>{l.recipientName || <em style={{ color: "var(--ink-muted)" }}>sin nombre</em>}</td>
                        <td style={{ fontSize: 12 }}>{l.recipientAddress || <em style={{ color: "var(--ink-muted)" }}>—</em>}</td>
                        <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{l.cadastralReference || <em style={{ color: "var(--ink-muted)" }}>—</em>}</td>
                        <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(l.importeIntegro)}</td>
                        <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(l.retencion)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 20 }}>Cuadre Modelo 115 vs Modelo 180</h2>
              <span className="bo-chip">control coherence</span>
            </div>
            <p style={{ marginBottom: 12 }}>
              La suma de las retenciones de los 4 modelos 115 trimestrales debe ser exactamente igual a la retención
              anual del Modelo 180. Si hay diferencia, hay un asiento fuera de período o un modelo 115 sin presentar.
            </p>
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Concepto</th>
                    <th style={{ textAlign: "right" }}>Suma Modelos 115 (Q1+Q2+Q3+Q4)</th>
                    <th style={{ textAlign: "right" }}>Modelo 180 anual</th>
                    <th style={{ textAlign: "right" }}>Diferencia</th>
                    <th>Cuadre</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const sum115Base = data.quarters.reduce((s, q) => s + q.base, 0);
                    const sum115Ret = data.quarters.reduce((s, q) => s + q.retenciones, 0);
                    const diffBase = Math.round((sum115Base - data.totals.baseAnual) * 100) / 100;
                    const diffRet = Math.round((sum115Ret - data.totals.retencionAnual) * 100) / 100;
                    return (
                      <>
                        <tr>
                          <td><strong>Base retenciones</strong></td>
                          <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(sum115Base)}</td>
                          <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(data.totals.baseAnual)}</td>
                          <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(diffBase)}</td>
                          <td><span className={`cm-pill ${diffBase === 0 ? "cm-pill-ok" : "cm-pill-error"}`}>{diffBase === 0 ? "✓ cuadra" : "Δ revisar"}</span></td>
                        </tr>
                        <tr>
                          <td><strong>Importe retenciones</strong></td>
                          <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(sum115Ret)}</td>
                          <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(data.totals.retencionAnual)}</td>
                          <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(diffRet)}</td>
                          <td><span className={`cm-pill ${diffRet === 0 ? "cm-pill-ok" : "cm-pill-error"}`}>{diffRet === 0 ? "✓ cuadra" : "Δ revisar"}</span></td>
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
              <h2 style={{ fontSize: 20 }}>Casillas Modelo 180</h2>
              <span className="bo-chip">{Object.keys(data.casillas).length} casillas</span>
            </div>
            <div className="bo-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
              {Object.entries(data.casillas).map(([key, value]) => (
                <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4, padding: 12, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--radius-md)" }}>
                  <span style={{ fontSize: 11, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{key.replace("casilla_", "Casilla ")}</span>
                  <strong style={{ fontFamily: "var(--font-mono)", fontSize: 14 }}>
                    {typeof value === "number" && Number.isInteger(value) && value < 100 ? value : fmt(value)}
                  </strong>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}
