import { useCallback, useEffect, useState } from "react";
import {
  fetchRecommendations,
  generateRecommendations,
  decideRecommendation,
  fetchPricingRules,
  createPricingRule,
  money,
  type Recommendation,
  type PricingRule
} from "../services/revenueApi";
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../components/States";

function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString("es-ES", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
}
function statusPill(status: string): string {
  if (status === "applied") return "ok";
  if (status === "approved") return "ok";
  if (status === "rejected") return "error";
  return "warn";
}
const STATUS_ES: Record<string, string> = { pending: "pendiente", approved: "aprobada", applied: "aplicada", rejected: "rechazada" };

export function RevenueRulesScreen() {
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [rName, setRName] = useState("");
  const [rMin, setRMin] = useState("");
  const [rMax, setRMax] = useState("");
  const [rAdj, setRAdj] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, pr] = await Promise.all([fetchRecommendations(), fetchPricingRules()]);
      setRecs(r);
      setRules(pr);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudieron cargar las recomendaciones.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run<T>(fn: () => Promise<T>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

  const pending = recs.filter((r) => r.status === "pending");
  const applied = recs.filter((r) => r.status === "applied").length;

  return (
    <section className="bo-card" style={{ display: "grid", gap: 16 }}>
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Revenue · Pricing</p>
          <h2>Reglas y recomendaciones de BAR</h2>
        </div>
        <div className="bo-pill-row">
          <button type="button" className="primary" disabled={busy || loading} onClick={() => run(() => generateRecommendations(), "Recomendaciones generadas.")}>
            {busy ? <><Spinner size="sm" /> Generando…</> : "Generar recomendaciones"}
          </button>
          <button type="button" onClick={() => void load()} disabled={loading}>↻ Actualizar</button>
        </div>
      </div>
      <p>
        El motor combina la ocupación real (OTB), el comp-set y tus reglas de precio para recomendar el BAR por fecha. Cada
        recomendación es explicable (mira los factores) y nada se aplica sin aprobación humana. Al aplicar, el BAR se escribe en
        la parrilla de tarifas.
      </p>
      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      {loading ? (
        <LoadingBlock label="Cargando recomendaciones…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar" message={error} onRetry={() => void load()} />
      ) : (
        <>
          <section className="rev-kpi-grid">
            <article className={`rev-kpi ${pending.length > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
              <div className="rev-kpi-head"><span className="rev-kpi-label">Pendientes</span></div>
              <div className="rev-kpi-value">{pending.length}</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Aplicadas</span></div>
              <div className="rev-kpi-value">{applied}</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Reglas activas</span></div>
              <div className="rev-kpi-value">{rules.filter((r) => r.active).length}</div>
            </article>
          </section>

          <article className="bo-card">
            <div className="bo-card-head"><h3>Recomendaciones de BAR</h3><span className="bo-chip">{recs.length}</span></div>
            {recs.length === 0 ? (
              <EmptyState title="Sin recomendaciones" message="Pulsa «Generar recomendaciones» para calcular el BAR sugerido por fecha." />
            ) : (
              <div className="rev-report-wrap">
                <table className="cm-table">
                  <thead>
                    <tr><th>Fecha</th><th>Ocup.</th><th>BAR actual</th><th>Comp-set</th><th>BAR sugerido</th><th>Δ</th><th>Estado</th><th>Acciones</th></tr>
                  </thead>
                  <tbody>
                    {recs.slice(0, 30).map((r) => {
                      const delta = r.expectedImpact?.deltaPct ?? 0;
                      return (
                        <tr key={r.id} className={r.riskLevel === "high" ? "cm-row-warn" : undefined}>
                          <td><strong>{fmtDate(r.targetDate)}</strong></td>
                          <td>{r.current?.occupancyPct != null ? `${r.current.occupancyPct}%` : "—"}</td>
                          <td>{r.current?.bar != null ? money(r.current.bar) : "—"}</td>
                          <td>{r.current?.compsetMedian != null ? money(r.current.compsetMedian) : "—"}</td>
                          <td><strong>{r.recommended?.bar != null ? money(r.recommended.bar) : "—"}</strong></td>
                          <td style={{ color: delta >= 0 ? "var(--ok-ink, #0a7e57)" : "var(--danger-ink, #c2413a)" }}>{delta >= 0 ? "+" : ""}{delta}%</td>
                          <td><span className={`bo-status ${statusPill(r.status)}`} style={{ textTransform: "none" }}>{STATUS_ES[r.status] ?? r.status}</span></td>
                          <td>
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {r.status === "pending" ? (
                                <>
                                  <button type="button" className="bo-button-link" disabled={busy} onClick={() => run(() => decideRecommendation(r.id, "apply"), "Recomendación aplicada al BAR.")}>Aplicar</button>
                                  <button type="button" className="bo-button-link" disabled={busy} onClick={() => run(() => decideRecommendation(r.id, "reject"), "Recomendación rechazada.")} style={{ borderColor: "#c2413a", color: "#c2413a" }}>Rechazar</button>
                                </>
                              ) : (
                                <span className="bo-muted">—</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </article>

          <article className="bo-card">
            <div className="bo-card-head"><h3>Reglas de precio</h3><span className="bo-chip">{rules.length}</span></div>
            {rules.length === 0 ? (
              <p className="bo-muted">Aún no hay reglas. Añade una para que el motor ajuste el BAR por bandas de ocupación.</p>
            ) : (
              <div className="rev-report-wrap">
                <table className="cm-table">
                  <thead><tr><th>Prioridad</th><th>Nombre</th><th>Ocupación</th><th>Ajuste</th><th>Estado</th></tr></thead>
                  <tbody>
                    {rules.map((r) => (
                      <tr key={r.id}>
                        <td>{r.priority}</td>
                        <td><strong>{r.name}</strong></td>
                        <td>{r.minOccupancy ?? "0"}% – {r.maxOccupancy ?? "100"}%</td>
                        <td>{r.adjustType === "percent" ? `${Number(r.adjustValue) >= 0 ? "+" : ""}${r.adjustValue}%` : money(Number(r.adjustValue))}</td>
                        <td><span className={`bo-status ${r.active ? "ok" : "info"}`}>{r.active ? "activa" : "inactiva"}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="bo-row" style={{ gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
              <input placeholder="Nombre de la regla" value={rName} onChange={(e) => setRName(e.target.value)} style={{ flex: "1 1 160px" }} />
              <input placeholder="Ocup. mín %" value={rMin} onChange={(e) => setRMin(e.target.value)} style={{ width: 100 }} />
              <input placeholder="Ocup. máx %" value={rMax} onChange={(e) => setRMax(e.target.value)} style={{ width: 100 }} />
              <input placeholder="Ajuste %" value={rAdj} onChange={(e) => setRAdj(e.target.value)} style={{ width: 90 }} />
              <button
                type="button"
                disabled={busy || !rName.trim() || rAdj === ""}
                onClick={() =>
                  run(
                    () => createPricingRule({ name: rName.trim(), minOccupancy: rMin ? Number(rMin) : undefined, maxOccupancy: rMax ? Number(rMax) : undefined, adjustType: "percent", adjustValue: Number(rAdj) }).then(() => { setRName(""); setRMin(""); setRMax(""); setRAdj(""); }),
                    "Regla creada."
                  )
                }
              >
                Añadir regla
              </button>
            </div>
          </article>
        </>
      )}
    </section>
  );
}
