import { getActivePropertyId } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();

type Item = { accountCode: string; accountName: string; amount: number };

type FormalBalanceSheet = {
  asOf: string;
  generatedAt: string;
  assets: { nonCurrent: Item[]; current: Item[]; total: number };
  liabilities: { nonCurrent: Item[]; current: Item[]; total: number };
  equity: { items: Item[]; retainedEarnings: number; total: number };
  totalLiabPlusEquity: number;
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

function Section({
  title,
  items,
  initiallyOpen = true
}: {
  title: string;
  items: Item[];
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const subtotal = items.reduce((s, i) => s + i.amount, 0);
  return (
    <div style={{ marginBottom: 12, border: "1px solid var(--line)", borderRadius: "var(--radius-md)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          width: "100%",
          padding: "10px 14px",
          background: "var(--surface)",
          border: "none",
          cursor: "pointer",
          borderRadius: "var(--radius-md)",
          fontWeight: 600
        }}
      >
        <span>
          <span style={{ marginRight: 8 }}>{open ? "▾" : "▸"}</span>
          {title}
          <span style={{ marginLeft: 8, color: "var(--ink-muted)", fontWeight: 400 }}>
            ({items.length})
          </span>
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>{fmt(subtotal)}</span>
      </button>
      {open && items.length > 0 && (
        <table className="cm-table" style={{ borderTop: "1px solid var(--line)" }}>
          <tbody>
            {items.map((item) => (
              <tr key={item.accountCode}>
                <td style={{ width: 100 }}><strong>{item.accountCode}</strong></td>
                <td>{item.accountName}</td>
                <td
                  style={{
                    textAlign: "right",
                    fontFamily: "var(--font-mono)",
                    width: 160
                  }}
                >
                  {fmt(item.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && items.length === 0 && (
        <p style={{ padding: 12, color: "var(--ink-muted)", margin: 0 }}>Sin saldos en esta sección.</p>
      )}
    </div>
  );
}

export function BalanceSheetScreen() {
  const initialAsOf = useMemo(todayIso, []);
  const [asOf, setAsOf] = useState(initialAsOf);

  const { data, loading, error, refresh } = useApiData<FormalBalanceSheet>(
    "/accounting/reports/balance-sheet",
    { query: { propertyId: PROPERTY_ID, asOf }, pollIntervalMs: 300000 }
  );

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Contabilidad · Balance de Situación</div>
          <h1 className="bo-page-title">Balance de situación</h1>
          <p className="bo-page-subtitle">
            Activo, Pasivo y Patrimonio neto clasificado conforme al Plan General Contable español.
            La igualdad fundamental es: <strong>Activo = Pasivo + Patrimonio neto</strong>.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" onClick={refresh}>↻ Recalcular</button>
          <button type="button" className="ghost">Export CSV</button>
        </div>
      </div>

      <div className="rev-toolbar">
        <div className="rev-toolbar-group">
          <label>Fecha de cierre</label>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
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
          Calculando balance…
        </div>
      ) : error ? (
        <div className="bo-card" style={{ borderLeft: "3px solid var(--danger-ink)" }}>
          <h3>Error</h3>
          <p>{error}</p>
        </div>
      ) : !data ? null : (
        <>
          <section className="rev-kpi-grid">
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Total Activo</span></div>
              <div className="rev-kpi-value">{fmt(data.assets.total)}</div>
              <div className="rev-kpi-delta">No corriente + Corriente</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Total Pasivo</span></div>
              <div className="rev-kpi-value">{fmt(data.liabilities.total)}</div>
              <div className="rev-kpi-delta">No corriente + Corriente</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Patrimonio Neto</span></div>
              <div className="rev-kpi-value">{fmt(data.equity.total)}</div>
              <div className="rev-kpi-delta">incl. resultado del ejercicio</div>
            </article>
            <article className={`rev-kpi ${data.balanced ? "rev-kpi-ok" : "rev-kpi-warn"}`}>
              <div className="rev-kpi-head"><span className="rev-kpi-label">Diferencia</span></div>
              <div className="rev-kpi-value">{fmt(data.assets.total - data.totalLiabPlusEquity)}</div>
              <div className="rev-kpi-delta">{data.balanced ? "Cuadrado" : "Descuadre"}</div>
            </article>
          </section>

          <div
            className="bo-grid"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 24 }}
          >
            <section className="bo-card">
              <div className="bo-card-head">
                <h2 style={{ fontSize: 20 }}>Activo</h2>
                <span className="bo-chip">{fmt(data.assets.total)}</span>
              </div>
              <Section title="Activo no corriente (2xx · inmovilizado)" items={data.assets.nonCurrent} />
              <Section title="Activo corriente (3xx, 43x, 44x, 57x)" items={data.assets.current} />
              <div
                style={{
                  marginTop: 8,
                  padding: 12,
                  borderTop: "2px solid var(--ink)",
                  display: "flex",
                  justifyContent: "space-between",
                  fontWeight: 700
                }}
              >
                <span>TOTAL ACTIVO</span>
                <span style={{ fontFamily: "var(--font-mono)" }}>{fmt(data.assets.total)}</span>
              </div>
            </section>

            <section className="bo-card">
              <div className="bo-card-head">
                <h2 style={{ fontSize: 20 }}>Pasivo + Patrimonio Neto</h2>
                <span className="bo-chip">{fmt(data.totalLiabPlusEquity)}</span>
              </div>
              <Section
                title="Patrimonio neto (10x, 11x, 12x)"
                items={[
                  ...data.equity.items,
                  {
                    accountCode: "129",
                    accountName: "Resultado del ejercicio (calculado)",
                    amount: data.equity.retainedEarnings
                  }
                ]}
              />
              <Section title="Pasivo no corriente (17x · deuda largo plazo)" items={data.liabilities.nonCurrent} />
              <Section
                title="Pasivo corriente (40x, 41x, 47x, 52x)"
                items={data.liabilities.current}
              />
              <div
                style={{
                  marginTop: 8,
                  padding: 12,
                  borderTop: "2px solid var(--ink)",
                  display: "flex",
                  justifyContent: "space-between",
                  fontWeight: 700
                }}
              >
                <span>TOTAL PASIVO + PATRIMONIO NETO</span>
                <span style={{ fontFamily: "var(--font-mono)" }}>{fmt(data.totalLiabPlusEquity)}</span>
              </div>
            </section>
          </div>
        </>
      )}
    </>
  );
}
