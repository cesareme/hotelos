import { getActivePropertyId } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();

type Item = { description: string; amount: number };
type WorkingCapitalChange = { category: string; amount: number };

type CashFlowStatement = {
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  operating: {
    netIncome: number;
    depreciation: number;
    workingCapitalChanges: WorkingCapitalChange[];
    subtotal: number;
  };
  investing: { items: Item[]; subtotal: number };
  financing: { items: Item[]; subtotal: number };
  netChangeInCash: number;
  openingCash: number;
  closingCash: number;
};

function defaultPeriod(): { from: string; to: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const from = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const to = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

function fmt(amount: number): string {
  return new Intl.NumberFormat("es-ES", { useGrouping: true,
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2
  }).format(amount);
}

function amountColor(n: number): string {
  if (Math.abs(n) < 0.005) return "var(--ink-muted)";
  return n >= 0 ? "var(--success-ink)" : "var(--danger-ink)";
}

function SectionHeader({ title, subtotal }: { title: string; subtotal: number }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "12px 0",
        borderBottom: "1px solid var(--line)",
        marginBottom: 8
      }}
    >
      <h3 style={{ margin: 0, fontSize: 16 }}>{title}</h3>
      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: amountColor(subtotal) }}>
        {fmt(subtotal)}
      </span>
    </div>
  );
}

function LineRow({ label, amount, bold = false }: { label: string; amount: number; bold?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "6px 0",
        fontWeight: bold ? 700 : 400
      }}
    >
      <span>{label}</span>
      <span style={{ fontFamily: "var(--font-mono)", color: amountColor(amount) }}>{fmt(amount)}</span>
    </div>
  );
}

export function CashFlowScreen() {
  const initial = useMemo(defaultPeriod, []);
  const [fromDate, setFromDate] = useState(initial.from);
  const [toDate, setToDate] = useState(initial.to);

  const { data, loading, error, refresh } = useApiData<CashFlowStatement>(
    "/accounting/reports/cash-flow",
    { query: { propertyId: PROPERTY_ID, fromDate, toDate }, pollIntervalMs: 300000 }
  );

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Contabilidad · Estado de Flujos de Efectivo</div>
          <h1 className="bo-page-title">Estado de flujos de efectivo</h1>
          <p className="bo-page-subtitle">
            Método indirecto: parte del resultado del ejercicio, ajusta partidas no monetarias (amortización 68x)
            y variaciones del capital circulante (clientes, existencias, proveedores), y separa actividades de
            inversión y financiación.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" onClick={refresh}>↻ Recalcular</button>
          <button type="button" className="ghost">Export CSV</button>
        </div>
      </div>

      <div className="rev-toolbar">
        <div className="rev-toolbar-group">
          <label>Desde</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </div>
        <div className="rev-toolbar-group">
          <label>Hasta</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        <div className="rev-toolbar-spacer" />
      </div>

      {loading ? (
        <div className="bo-card" style={{ textAlign: "center", padding: 48, color: "var(--ink-muted)" }}>
          Calculando flujos…
        </div>
      ) : error ? (
        <div className="bo-card" style={{ borderLeft: "3px solid var(--danger-ink)" }}>
          <h3>Error</h3>
          <p>{error}</p>
        </div>
      ) : !data ? null : (
        <>
          <section className="rev-kpi-grid">
            <article className="rev-kpi">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Tesorería inicial</span></div>
              <div className="rev-kpi-value">{fmt(data.openingCash)}</div>
              <div className="rev-kpi-delta">a {data.periodStart}</div>
            </article>
            <article className={`rev-kpi ${data.netChangeInCash >= 0 ? "rev-kpi-ok" : "rev-kpi-warn"}`}>
              <div className="rev-kpi-head"><span className="rev-kpi-label">Variación neta</span></div>
              <div className="rev-kpi-value">{fmt(data.netChangeInCash)}</div>
              <div className="rev-kpi-delta">durante el período</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Tesorería final</span></div>
              <div className="rev-kpi-value">{fmt(data.closingCash)}</div>
              <div className="rev-kpi-delta">a {data.periodEnd}</div>
            </article>
            <article className="rev-kpi">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Resultado neto</span></div>
              <div className="rev-kpi-value">{fmt(data.operating.netIncome)}</div>
              <div className="rev-kpi-delta">punto de partida</div>
            </article>
          </section>

          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 20 }}>Actividades de explotación</h2>
              <span className="bo-chip">{fmt(data.operating.subtotal)}</span>
            </div>
            <SectionHeader title="Resultado y ajustes no monetarios" subtotal={data.operating.netIncome + data.operating.depreciation} />
            <LineRow label="Resultado del ejercicio (P&L)" amount={data.operating.netIncome} />
            <LineRow label="(+) Amortización del inmovilizado (68x)" amount={data.operating.depreciation} />

            <SectionHeader
              title="Variaciones del capital circulante"
              subtotal={data.operating.workingCapitalChanges.reduce((s, c) => s + c.amount, 0)}
            />
            {data.operating.workingCapitalChanges.map((wc) => (
              <LineRow key={wc.category} label={wc.category} amount={wc.amount} />
            ))}

            <div style={{ borderTop: "2px solid var(--ink)", marginTop: 12, paddingTop: 12 }}>
              <LineRow label="Subtotal flujos de explotación" amount={data.operating.subtotal} bold />
            </div>
          </section>

          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 20 }}>Actividades de inversión</h2>
              <span className="bo-chip">{fmt(data.investing.subtotal)}</span>
            </div>
            {data.investing.items.length === 0 ? (
              <p style={{ color: "var(--ink-muted)" }}>Sin movimientos de inversión en el período.</p>
            ) : (
              data.investing.items.map((item) => (
                <LineRow key={item.description} label={item.description} amount={item.amount} />
              ))
            )}
            <div style={{ borderTop: "2px solid var(--ink)", marginTop: 12, paddingTop: 12 }}>
              <LineRow label="Subtotal flujos de inversión" amount={data.investing.subtotal} bold />
            </div>
          </section>

          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 20 }}>Actividades de financiación</h2>
              <span className="bo-chip">{fmt(data.financing.subtotal)}</span>
            </div>
            {data.financing.items.length === 0 ? (
              <p style={{ color: "var(--ink-muted)" }}>Sin movimientos de financiación en el período.</p>
            ) : (
              data.financing.items.map((item) => (
                <LineRow key={item.description} label={item.description} amount={item.amount} />
              ))
            )}
            <div style={{ borderTop: "2px solid var(--ink)", marginTop: 12, paddingTop: 12 }}>
              <LineRow label="Subtotal flujos de financiación" amount={data.financing.subtotal} bold />
            </div>
          </section>

          <section className="bo-card" style={{ background: "var(--surface)" }}>
            <LineRow label="Tesorería inicial" amount={data.openingCash} />
            <LineRow label="(+) Variación neta del efectivo" amount={data.netChangeInCash} />
            <div style={{ borderTop: "2px solid var(--ink)", marginTop: 12, paddingTop: 12 }}>
              <LineRow label="= Tesorería final" amount={data.closingCash} bold />
            </div>
          </section>
        </>
      )}
    </>
  );
}
