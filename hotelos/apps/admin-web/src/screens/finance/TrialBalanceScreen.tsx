import { getActivePropertyId } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();

type TrialBalanceRow = {
  accountCode: string;
  accountName: string;
  debitTotal: number;
  creditTotal: number;
  balance: number;
};

type TrialBalance = {
  asOf: string;
  fromDate?: string;
  toDate?: string;
  generatedAt: string;
  rows: TrialBalanceRow[];
  totals: { debit: number; credit: number };
  balanced: boolean;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmt(amount: number): string {
  return new Intl.NumberFormat("es-ES", { useGrouping: true,
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2
  }).format(amount);
}

export function TrialBalanceScreen() {
  const initialAsOf = useMemo(todayIso, []);
  const [asOf, setAsOf] = useState(initialAsOf);
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  const query = useMemo(() => {
    const q: Record<string, string> = { propertyId: PROPERTY_ID, asOf };
    if (fromDate) q.fromDate = fromDate;
    if (toDate) q.toDate = toDate;
    return q;
  }, [asOf, fromDate, toDate]);

  const { data, loading, error, refresh } = useApiData<TrialBalance>(
    "/accounting/reports/trial-balance",
    { query, pollIntervalMs: 300000 }
  );

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Contabilidad · Balance de Sumas y Saldos</div>
          <h1 className="bo-page-title">Balance de comprobación</h1>
          <p className="bo-page-subtitle">
            Agregación de los movimientos del libro diario por cuenta del Plan General Contable. Verifica
            que la partida doble cuadra: <strong>Total Debe = Total Haber</strong>.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" onClick={refresh}>↻ Recalcular</button>
          <button type="button" className="ghost">Export CSV</button>
        </div>
      </div>

      <div className="rev-toolbar">
        <div className="rev-toolbar-group">
          <label>Fecha de corte (asOf)</label>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
        <div className="rev-toolbar-group">
          <label>Desde (opcional)</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </div>
        <div className="rev-toolbar-group">
          <label>Hasta (opcional)</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        <div className="rev-toolbar-spacer" />
        <div className="rev-toolbar-actions">
          {data && (
            <span
              className="bo-chip"
              style={{
                background: data.balanced ? "var(--success-bg)" : "var(--danger-bg)",
                color: data.balanced ? "var(--success-ink)" : "var(--danger-ink)",
                fontWeight: 600
              }}
            >
              {data.balanced ? "✓ Balanced" : "✗ Unbalanced"}
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="bo-card" style={{ textAlign: "center", padding: 48, color: "var(--ink-muted)" }}>
          Calculando saldos…
        </div>
      ) : error ? (
        <div className="bo-card" style={{ borderLeft: "3px solid var(--danger-ink)" }}>
          <h3>Error</h3>
          <p>{error}</p>
        </div>
      ) : !data || data.rows.length === 0 ? (
        <div className="bo-card" style={{ textAlign: "center", padding: 48 }}>
          <h3>Sin movimientos contables</h3>
          <p>
            No hay asientos contabilizados {fromDate ? `entre ${fromDate} y ${toDate || asOf}` : `hasta ${asOf}`}.
          </p>
        </div>
      ) : (
        <>
          <section className="rev-kpi-grid">
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Total Debe</span></div>
              <div className="rev-kpi-value">{fmt(data.totals.debit)}</div>
              <div className="rev-kpi-delta">{data.rows.length} cuentas</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Total Haber</span></div>
              <div className="rev-kpi-value">{fmt(data.totals.credit)}</div>
              <div className="rev-kpi-delta">{data.rows.length} cuentas</div>
            </article>
            <article className={`rev-kpi ${data.balanced ? "rev-kpi-ok" : "rev-kpi-warn"}`}>
              <div className="rev-kpi-head"><span className="rev-kpi-label">Diferencia</span></div>
              <div className="rev-kpi-value">{fmt(data.totals.debit - data.totals.credit)}</div>
              <div className="rev-kpi-delta">{data.balanced ? "Cuadrado" : "Descuadre detectado"}</div>
            </article>
            <article className="rev-kpi">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Fecha de corte</span></div>
              <div className="rev-kpi-value" style={{ fontSize: 20 }}>{data.asOf}</div>
              <div className="rev-kpi-delta">{data.fromDate ? `desde ${data.fromDate}` : "acumulado"}</div>
            </article>
          </section>

          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 20 }}>Detalle por cuenta</h2>
              <span className="bo-chip">{data.rows.length} cuentas</span>
            </div>
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Código</th>
                    <th>Cuenta</th>
                    <th style={{ textAlign: "right" }}>Debe</th>
                    <th style={{ textAlign: "right" }}>Haber</th>
                    <th style={{ textAlign: "right" }}>Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.accountCode}>
                      <td><strong>{row.accountCode}</strong></td>
                      <td>{row.accountName}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(row.debitTotal)}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(row.creditTotal)}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                        {fmt(row.balance)}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: "2px solid var(--line)" }}>
                    <td colSpan={2}><strong>TOTALES</strong></td>
                    <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>
                      {fmt(data.totals.debit)}
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>
                      {fmt(data.totals.credit)}
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>
                      {fmt(data.totals.debit - data.totals.credit)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
