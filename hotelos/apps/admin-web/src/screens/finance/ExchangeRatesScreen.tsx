import { useMemo, useState, type FormEvent } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { LoadingBlock } from "../../components/States";
import { useToast } from "../../components/Toast";

// Exchange rates admin (Sprint 24 — Multi-currency).
//
// Lists every rate row newest-first, lets the user add a new one via an
// inline form. Saving issues `POST /finance/exchange-rates`; the table
// refreshes via the `useApiData` refresh callback so the new row appears
// immediately. Rates are stored as "1 base = rate quote" — we surface the
// same wording in the form to avoid ambiguity.

type ExchangeRate = {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  effectiveDate: string;
  source?: string;
  organizationId?: string;
  createdAt: string;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtRate(n: number): string {
  // FX rates are quoted to 4 decimals in most public feeds (ECB, Banxico),
  // but our table stores 8. Show the trailing precision only when non-zero.
  const fixed = n.toFixed(8);
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

export function ExchangeRatesScreen() {
  const { showToast } = useToast();
  const [base, setBase] = useState<string>("");
  const [quote, setQuote] = useState<string>("");
  const [asOf, setAsOf] = useState<string>("");

  // Form state (kept separate from filters).
  const [formBase, setFormBase] = useState("USD");
  const [formQuote, setFormQuote] = useState("EUR");
  const [formRate, setFormRate] = useState("");
  const [formDate, setFormDate] = useState(todayIso());
  const [formSource, setFormSource] = useState("manual");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const query = useMemo(() => {
    const q: Record<string, string> = {};
    if (base) q.base = base.toUpperCase();
    if (quote) q.quote = quote.toUpperCase();
    if (asOf) q.asOf = asOf;
    return q;
  }, [base, quote, asOf]);

  const { data, loading, error, refresh } = useApiData<ExchangeRate[]>(
    "/finance/exchange-rates",
    { query }
  );

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setSaveError(null);
    const rateNum = Number(formRate);
    if (!formBase || !formQuote) {
      setSaveError("Both currencies are required.");
      return;
    }
    if (formBase.trim().toUpperCase() === formQuote.trim().toUpperCase()) {
      setSaveError("Base and quote currencies must differ.");
      return;
    }
    if (!Number.isFinite(rateNum) || rateNum <= 0) {
      setSaveError("Rate must be a positive number.");
      return;
    }
    setSaving(true);
    try {
      await apiRequest("/finance/exchange-rates", {
        method: "POST",
        body: {
          baseCurrency: formBase.trim().toUpperCase(),
          quoteCurrency: formQuote.trim().toUpperCase(),
          rate: rateNum,
          effectiveDate: formDate,
          source: formSource.trim() || null
        }
      });
      setFormRate("");
      refresh();
      showToast(`Tipo ${formBase.trim().toUpperCase()}/${formQuote.trim().toUpperCase()} guardado`, { variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSaveError(message);
      showToast(message, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Finanzas · Tipos de cambio</div>
          <h1 className="bo-page-title">Exchange Rates</h1>
          <p className="bo-page-subtitle">
            Tabla de tipos de cambio históricos. Cada fila indica que <strong>1 unidad de la divisa base</strong>
            equivale a <strong>rate</strong> unidades de la divisa cotizada en la fecha efectiva. Las facturas no-EUR
            consultan la tabla en el momento de creación y guardan el ratio aplicado.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" onClick={refresh}>↻ Refrescar</button>
        </div>
      </div>

      <div className="rev-toolbar">
        <div className="rev-toolbar-group">
          <label>Base</label>
          <input
            type="text"
            value={base}
            placeholder="USD"
            maxLength={3}
            onChange={(e) => setBase(e.target.value)}
            style={{ width: 80, textTransform: "uppercase" }}
          />
        </div>
        <div className="rev-toolbar-group">
          <label>Quote</label>
          <input
            type="text"
            value={quote}
            placeholder="EUR"
            maxLength={3}
            onChange={(e) => setQuote(e.target.value)}
            style={{ width: 80, textTransform: "uppercase" }}
          />
        </div>
        <div className="rev-toolbar-group">
          <label>Hasta (asOf)</label>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
        <div className="rev-toolbar-spacer" />
      </div>

      <section className="bo-card">
        <div className="bo-card-head">
          <h2 style={{ fontSize: 18 }}>Añadir tipo de cambio</h2>
        </div>
        <form onSubmit={onSubmit} className="rev-toolbar" style={{ flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <div className="rev-toolbar-group">
            <label>Base</label>
            <input
              type="text"
              value={formBase}
              maxLength={3}
              onChange={(e) => setFormBase(e.target.value.toUpperCase())}
              required
              style={{ width: 90, textTransform: "uppercase" }}
            />
          </div>
          <div className="rev-toolbar-group">
            <label>Quote</label>
            <input
              type="text"
              value={formQuote}
              maxLength={3}
              onChange={(e) => setFormQuote(e.target.value.toUpperCase())}
              required
              style={{ width: 90, textTransform: "uppercase" }}
            />
          </div>
          <div className="rev-toolbar-group">
            <label>Rate (1 base = ? quote)</label>
            <input
              type="number"
              step="0.00000001"
              min="0"
              value={formRate}
              onChange={(e) => setFormRate(e.target.value)}
              required
              style={{ width: 160 }}
            />
          </div>
          <div className="rev-toolbar-group">
            <label>Fecha efectiva</label>
            <input
              type="date"
              value={formDate}
              onChange={(e) => setFormDate(e.target.value)}
              required
            />
          </div>
          <div className="rev-toolbar-group">
            <label>Fuente</label>
            <input
              type="text"
              value={formSource}
              onChange={(e) => setFormSource(e.target.value)}
              placeholder="manual / ECB / Banxico"
              style={{ width: 180 }}
            />
          </div>
          <div className="rev-toolbar-actions">
            <button type="submit" disabled={saving}>
              {saving ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </form>
        {saveError && (
          <p style={{ color: "var(--danger-ink)", marginTop: 8 }}>{saveError}</p>
        )}
      </section>

      {loading ? (
        <div className="bo-card">
          <LoadingBlock label="Cargando tipos…" />
        </div>
      ) : error ? (
        <div className="bo-card" style={{ borderLeft: "3px solid var(--danger-ink)" }}>
          <h3>Error</h3>
          <p>{error}</p>
        </div>
      ) : !data || data.length === 0 ? (
        <div className="bo-card" style={{ textAlign: "center", padding: 48 }}>
          <h3>Sin tipos de cambio registrados</h3>
          <p>Añade la primera fila con el formulario superior para empezar a facturar en divisa.</p>
        </div>
      ) : (
        <section className="bo-card">
          <div className="bo-card-head">
            <h2 style={{ fontSize: 20 }}>Histórico</h2>
            <span className="bo-chip">{data.length} filas</span>
          </div>
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Fecha efectiva</th>
                  <th>Base</th>
                  <th>Quote</th>
                  <th style={{ textAlign: "right" }}>Rate</th>
                  <th>Fuente</th>
                  <th>Alcance</th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.id}>
                    <td>{row.effectiveDate}</td>
                    <td><strong>{row.baseCurrency}</strong></td>
                    <td>{row.quoteCurrency}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>
                      {fmtRate(row.rate)}
                    </td>
                    <td>{row.source ?? "—"}</td>
                    <td>
                      <span className="bo-chip">{row.organizationId ? "tenant" : "global"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
