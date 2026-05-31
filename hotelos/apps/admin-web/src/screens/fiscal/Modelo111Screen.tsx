import { getActivePropertyId, getActivePropertyName } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();

type Modelo111Row = {
  rowCode: string;
  label: string;
  perceptores: number;
  base: number;
  retenciones: number;
  casillaPerceptores: number;
  casillaBase: number;
  casillaRetenciones: number;
};

type Modelo111 = {
  fromDate: string;
  toDate: string;
  generatedAt: string;
  rows: Modelo111Row[];
  totals: { perceptores: number; base: number; retenciones: number; resultadoLiquidacion: number };
  casillas: Record<string, number>;
};

function defaultQuarter(): { from: string; to: string; quarter: number; year: number } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const q = Math.floor(month / 3) + 1;
  const fromMonth = (q - 1) * 3;
  const toMonth = fromMonth + 2;
  const from = `${year}-${String(fromMonth + 1).padStart(2, "0")}-01`;
  const toDay = new Date(Date.UTC(year, toMonth + 1, 0)).getUTCDate();
  const to = `${year}-${String(toMonth + 1).padStart(2, "0")}-${String(toDay).padStart(2, "0")}`;
  return { from, to, quarter: q, year };
}

function quarterRange(year: number, quarter: number): { from: string; to: string } {
  const fromMonth = (quarter - 1) * 3;
  const toMonth = fromMonth + 2;
  const from = `${year}-${String(fromMonth + 1).padStart(2, "0")}-01`;
  const toDay = new Date(Date.UTC(year, toMonth + 1, 0)).getUTCDate();
  const to = `${year}-${String(toMonth + 1).padStart(2, "0")}-${String(toDay).padStart(2, "0")}`;
  return { from, to };
}

function fmt(amount: number): string {
  return new Intl.NumberFormat("es-ES", { useGrouping: true, style: "currency", currency: "EUR", minimumFractionDigits: 2 }).format(amount);
}

export function Modelo111Screen() {
  const initial = useMemo(defaultQuarter, []);
  const [year, setYear] = useState(initial.year);
  const [quarter, setQuarter] = useState<number>(initial.quarter);

  const { from: fromDate, to: toDate } = useMemo(() => quarterRange(year, quarter), [year, quarter]);

  const { data, loading, error, refresh } = useApiData<Modelo111>(
    "/accounting/reports/modelo-111",
    { query: { propertyId: PROPERTY_ID, fromDate, toDate, periodType: "quarterly" } }
  );

  const activeRows = useMemo(() => (data?.rows ?? []).filter((r) => r.base > 0 || r.retenciones > 0), [data]);

  const casillaPairs = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.casillas).map(([key, value]) => ({ key, value }));
  }, [data]);

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">AEAT · Modelo 111</div>
          <h1 className="bo-page-title">Retenciones IRPF trimestrales</h1>
          <p className="bo-page-subtitle">
            Agregación de la cuenta <strong>4751 H.P. acreedor por retenciones practicadas</strong> por código de
            percepción (empleados, profesionales, actividades agrarias, …), con mapeo a las casillas oficiales del
            Modelo 111 para presentación trimestral ante la AEAT.
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
            {[year - 1, year, year + 1].map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div className="rev-toolbar-group">
          <label>Trimestre</label>
          <select value={quarter} onChange={(e) => setQuarter(Number(e.target.value))}>
            <option value={1}>1T (Ene–Mar)</option>
            <option value={2}>2T (Abr–Jun)</option>
            <option value={3}>3T (Jul–Sep)</option>
            <option value={4}>4T (Oct–Dic)</option>
          </select>
        </div>
        <div className="rev-toolbar-group">
          <label>Property</label>
          <select disabled defaultValue={getActivePropertyId()}><option value={getActivePropertyId()}>{getActivePropertyName()}</option></select>
        </div>
        <div className="rev-toolbar-spacer" />
        <div className="rev-toolbar-actions">
          <span className="bo-chip">{fromDate} → {toDate}</span>
        </div>
      </div>

      {loading ? (
        <div className="bo-card" style={{ textAlign: "center", padding: 48, color: "var(--ink-muted)" }}>
          Calculando agregación…
        </div>
      ) : error ? (
        <div className="bo-card" style={{ borderLeft: "3px solid var(--danger-ink)" }}>
          <h3>Error</h3><p className="bo-muted">Couldn't load this report right now. Refresh to retry.</p>
        </div>
      ) : !data ? (
        <div className="bo-card" style={{ textAlign: "center", padding: 48 }}>
          <h3>Sin datos</h3>
          <p>No se han podido cargar las retenciones para este período.</p>
        </div>
      ) : (
        <>
          <section className="rev-kpi-grid">
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Perceptores totales</span></div>
              <div className="rev-kpi-value">{data.totals.perceptores}</div>
              <div className="rev-kpi-delta">distintos en el trimestre</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Base retenida</span></div>
              <div className="rev-kpi-value">{fmt(data.totals.base)}</div>
              <div className="rev-kpi-delta">suma rendimientos brutos</div>
            </article>
            <article className="rev-kpi rev-kpi-warn">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Total retenciones</span></div>
              <div className="rev-kpi-value">{fmt(data.totals.retenciones)}</div>
              <div className="rev-kpi-delta">Casilla 28</div>
            </article>
            <article className="rev-kpi rev-kpi-warn">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Resultado liquidación</span></div>
              <div className="rev-kpi-value">{fmt(data.totals.resultadoLiquidacion)}</div>
              <div className="rev-kpi-delta">Casilla 31 · a ingresar</div>
            </article>
          </section>

          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 20 }}>Desglose por código de percepción</h2>
              <span className="bo-chip">{activeRows.length} filas con datos</span>
            </div>
            {activeRows.length === 0 ? (
              <div style={{ textAlign: "center", padding: 32, color: "var(--ink-muted)" }}>
                Sin retenciones registradas en el período <strong>{fromDate}</strong> → <strong>{toDate}</strong>.
                <br />La cuenta 4751 está a cero para este trimestre.
              </div>
            ) : (
              <div className="rev-report-wrap">
                <table className="cm-table">
                  <thead>
                    <tr>
                      <th>Código</th>
                      <th>Concepto</th>
                      <th style={{ textAlign: "right" }}>Perceptores</th>
                      <th style={{ textAlign: "right" }}>Base</th>
                      <th style={{ textAlign: "right" }}>Retenciones</th>
                      <th>Casillas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeRows.map((row) => (
                      <tr key={row.rowCode}>
                        <td><strong>{row.rowCode}</strong></td>
                        <td>{row.label}</td>
                        <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{row.perceptores}</td>
                        <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(row.base)}</td>
                        <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(row.retenciones)}</td>
                        <td>
                          <span className="bo-chip">C{row.casillaPerceptores}</span>{" "}
                          <span className="bo-chip">C{row.casillaBase}</span>{" "}
                          <span className="bo-chip">C{row.casillaRetenciones}</span>
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={2}><strong>TOTAL</strong></td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>{data.totals.perceptores}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>{fmt(data.totals.base)}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>{fmt(data.totals.retenciones)}</td>
                      <td><span className="bo-chip">Casilla 28</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 20 }}>Mapa de casillas AEAT</h2>
              <span className="bo-chip">{casillaPairs.length} casillas</span>
            </div>
            <p style={{ marginBottom: 16 }}>
              Casillas pre-rellenadas para el Modelo 111 oficial. Verifica antes de enviar al AEAT.
              La casilla 30 corresponde al total de retenciones e ingresos a cuenta, y la 31 al resultado a ingresar.
            </p>
            <div className="bo-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
              {casillaPairs.map(({ key, value }) => (
                <div
                  key={key}
                  className="bo-pill"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    padding: 12,
                    background: "var(--surface)",
                    border: "1px solid var(--line)",
                    borderRadius: "var(--radius-md)"
                  }}
                >
                  <span style={{ fontSize: 11, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {key.replace("casilla_", "Casilla ")}
                  </span>
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
