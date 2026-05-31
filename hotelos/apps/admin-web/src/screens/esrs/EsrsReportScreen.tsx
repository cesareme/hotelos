// CSRD/ESRS reporting — alimentación de indicadores + generación de informe.
//
// La cadena introduce los datos (puede tirar de los contadores IoT cuando estén
// conectados); el sistema calcula % completeness, agrupa por estándar y
// genera un informe firmado con hash de integridad.

import { useEffect, useMemo, useState } from "react";
import { getActiveOrganizationId } from "../../services/activeProperty";
import {
  fetchCatalog,
  fetchIndicators,
  upsertIndicator,
  generateReport,
  type EsrsDisclosure,
  type EsrsIndicator,
  type EsrsReportSummary
} from "../../services/esrsApi";
import { LoadingBlock, EmptyState, Spinner } from "../../components/States";

const ORG_ID = getActiveOrganizationId();

const STANDARD_LABEL: Record<string, { name: string; icon: string }> = {
  ESRS_E1: { name: "Cambio climático", icon: "🌡" },
  ESRS_E3: { name: "Recursos hídricos", icon: "💧" },
  ESRS_E5: { name: "Economía circular", icon: "♻" },
  ESRS_S1: { name: "Plantilla propia", icon: "👥" },
  ESRS_G1: { name: "Conducta empresarial", icon: "⚖" }
};

function fmtNum(n: number | string | null): string {
  if (n === null || n === undefined) return "—";
  const x = typeof n === "number" ? n : Number(n);
  return Number.isNaN(x) ? "—" : new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(x);
}

export function EsrsReportScreen() {
  const [year, setYear] = useState<string>(String(new Date().getUTCFullYear() - 1));
  const [catalog, setCatalog] = useState<EsrsDisclosure[]>([]);
  const [indicators, setIndicators] = useState<EsrsIndicator[]>([]);
  const [summary, setSummary] = useState<EsrsReportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<EsrsDisclosure | null>(null);
  const [draftValue, setDraftValue] = useState<string>("");

  async function refresh() {
    setLoading(true);
    try {
      const [cat, inds] = await Promise.all([fetchCatalog(), fetchIndicators(ORG_ID, year)]);
      setCatalog(cat);
      setIndicators(inds);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, [year]);

  const indByCode = useMemo(() => new Map(indicators.map((i) => [i.disclosureCode, i])), [indicators]);
  const byStandard = useMemo(() => {
    const m = new Map<string, EsrsDisclosure[]>();
    for (const d of catalog) {
      const arr = m.get(d.standard) ?? [];
      arr.push(d);
      m.set(d.standard, arr);
    }
    return m;
  }, [catalog]);

  const reqCount = catalog.filter((d) => d.required).length;
  const reportedReq = catalog.filter((d) => d.required && indByCode.has(d.code)).length;
  const completeness = reqCount > 0 ? Math.round((reportedReq / reqCount) * 1000) / 10 : 0;

  async function handleSave() {
    if (!editing) return;
    const val = draftValue.trim();
    if (!val) return;
    setBusy(true);
    try {
      const numeric = Number(val);
      const isNumeric = !Number.isNaN(numeric) && editing.unit !== "n/a";
      await upsertIndicator({
        organizationId: ORG_ID,
        fiscalYear: year,
        standardCode: editing.standard,
        disclosureCode: editing.code,
        ...(isNumeric ? { numericValue: numeric } : { textValue: val }),
        unit: editing.unit
      });
      setEditing(null);
      setDraftValue("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error guardando.");
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerate() {
    setBusy(true);
    try {
      const r = await generateReport(ORG_ID, year);
      setSummary(r.summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error generando informe.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Sostenibilidad · CSRD / ESRS
          </p>
          <h2 style={{ color: "var(--ink)" }}>Informe de sostenibilidad</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Indicadores obligatorios bajo la <strong>directiva CSRD</strong>. Grandes empresas reportan datos del ejercicio
            anterior antes de fin del año en curso. Datos firmados con hash de integridad para auditoría externa.
          </p>
        </div>
        <div className="bo-row" style={{ gap: 8, alignItems: "center" }}>
          <label className="bo-muted" style={{ textTransform: "none" }}>Ejercicio:</label>
          <select value={year} onChange={(e) => setYear(e.target.value)}>
            {["2023", "2024", "2025", "2026"].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <button type="button" className="primary" onClick={handleGenerate} disabled={busy}>
            {busy ? <Spinner size="sm" /> : "Generar informe"}
          </button>
        </div>
      </header>

      {error ? <p className="bo-status warn" style={{ textTransform: "none" }}>{error}</p> : null}

      {/* KPIs */}
      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">% Cumplimiento</span>
            <span className={`bo-status ${completeness === 100 ? "ok" : completeness >= 80 ? "info" : "warn"}`}>
              {completeness === 100 ? "completo" : `${reqCount - reportedReq} faltan`}
            </span>
          </div>
          <div className="rev-kpi-value">{completeness.toFixed(1)} %</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Reportados</span>
            <span className="bo-status info">{reqCount} obligatorios</span>
          </div>
          <div className="rev-kpi-value">{indicators.length}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Estándares activos</span>
            <span className="bo-status ok">ESRS</span>
          </div>
          <div className="rev-kpi-value">{byStandard.size}</div>
        </article>
      </div>

      {summary ? (
        <article className="bo-card" style={{ background: "var(--accent-soft, rgba(78,224,163,0.10))", border: "1px solid var(--accent)" }}>
          <p style={{ margin: 0, color: "var(--ink)" }}>
            Informe generado · <strong>{summary.completenessPct.toFixed(1)} %</strong> de cumplimiento sobre disclosures obligatorios
            ({summary.reportedRequired}/{summary.requiredDisclosures}).
            Estado: <strong>{summary.completenessPct === 100 ? "Listo para enviar" : "Borrador"}</strong>.
          </p>
        </article>
      ) : null}

      {/* Edit dialog */}
      {editing ? (
        <article className="bo-card" style={{ background: "var(--surface-2, var(--surface))", border: "1px solid var(--accent)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>
              {STANDARD_LABEL[editing.standard]?.icon ?? "📊"} {editing.code}
            </h3>
            <button type="button" onClick={() => setEditing(null)}>Cancelar</button>
          </div>
          <p style={{ margin: "4px 0", color: "var(--ink)" }}>{editing.description}</p>
          <p className="bo-muted" style={{ margin: 0, fontSize: 12 }}>Unidad: <code>{editing.unit}</code></p>
          <form onSubmit={(e) => { e.preventDefault(); void handleSave(); }} style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <input
              type="text"
              value={draftValue}
              onChange={(e) => setDraftValue(e.target.value)}
              placeholder={`Valor en ${editing.unit}`}
              autoFocus
              style={{ flex: "1 1 0%" }}
            />
            <button type="submit" className="primary" disabled={busy || !draftValue.trim()}>Guardar</button>
          </form>
        </article>
      ) : null}

      {/* Por estándar */}
      {loading ? <LoadingBlock label="Cargando catálogo ESRS…" /> : Array.from(byStandard.entries()).map(([std, items]) => {
        const meta = STANDARD_LABEL[std] ?? { name: std, icon: "📊" };
        const reportedHere = items.filter((d) => indByCode.has(d.code)).length;
        return (
          <article key={std} className="bo-card" style={{ background: "var(--surface)" }}>
            <div className="bo-card-head">
              <h3 style={{ color: "var(--ink)" }}>{meta.icon} {std} · {meta.name}</h3>
              <span className={`bo-status ${reportedHere === items.length ? "ok" : "info"}`}>
                {reportedHere}/{items.length} reportados
              </span>
            </div>
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead><tr><th>Disclosure</th><th>Descripción</th><th>Unidad</th><th>Valor</th><th>Origen</th><th></th></tr></thead>
                <tbody>
                  {items.map((d) => {
                    const ind = indByCode.get(d.code);
                    return (
                      <tr key={d.code}>
                        <td className="mono"><strong>{d.code}</strong>{d.required ? " *" : ""}</td>
                        <td>{d.description}</td>
                        <td className="mono">{d.unit}</td>
                        <td>{ind ? <span className="mono"><strong>{fmtNum(ind.numericValue)}</strong> {ind.unit}</span> : <span className="bo-muted">—</span>}</td>
                        <td className="bo-muted" style={{ fontSize: 11 }}>{ind?.source ?? ""}</td>
                        <td>
                          <button type="button" onClick={() => { setEditing(d); setDraftValue(ind?.numericValue ? String(ind.numericValue) : ind?.textValue ?? ""); }}>
                            {ind ? "Editar" : "Reportar"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </article>
        );
      })}

      <p className="bo-muted" style={{ fontSize: 11, textTransform: "none" }}>
        * = disclosure obligatorio bajo CSRD. Los datos no obligatorios mejoran la calidad del informe pero no se exige reportarlos.
      </p>
    </section>
  );
}
