import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchCompetitors,
  fetchCompetitorRates,
  fetchParityAlerts,
  createCompetitor,
  runRateShop,
  money,
  type Competitor,
  type CompetitorRate,
  type ParityAlert
} from "../services/revenueApi";
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../components/States";

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString("es-ES", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
}

export function RateShopperSettingsScreen() {
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [rates, setRates] = useState<CompetitorRate[]>([]);
  const [alerts, setAlerts] = useState<ParityAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("4*");
  const [score, setScore] = useState("0.85");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, r, a] = await Promise.all([fetchCompetitors(), fetchCompetitorRates(), fetchParityAlerts()]);
      setCompetitors(c);
      setRates(r);
      setAlerts(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el rate shopper.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleShop() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await runRateShop(14);
      setMsg(`Sondeo completado: ${r.snapshots} tarifas de ${r.competitors} competidores.`);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo ejecutar el sondeo.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddCompetitor() {
    if (!name.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await createCompetitor({ name: name.trim(), category, comparableScore: Number(score) });
      setName("");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo añadir el competidor.");
    } finally {
      setBusy(false);
    }
  }

  // Market position by stay date (min / median / max competitor price).
  const byStay = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const r of rates) {
      if (!r.price) continue;
      const arr = map.get(r.stayDate) ?? [];
      arr.push(r.price);
      map.set(r.stayDate, arr);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([stayDate, prices]) => ({
        stayDate,
        min: Math.min(...prices),
        median: Math.round(median(prices) * 100) / 100,
        max: Math.max(...prices),
        count: prices.length
      }));
  }, [rates]);

  const compName = useMemo(() => new Map(competitors.map((c) => [c.id, c.name])), [competitors]);
  const openAlerts = alerts.filter((a) => a.status === "open").length;

  return (
    <section className="bo-card" style={{ display: "grid", gap: 16 }}>
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Inteligencia de mercado</p>
          <h2>Rate Shopper (comp-set)</h2>
        </div>
        <div className="bo-pill-row">
          <button type="button" className="primary" onClick={handleShop} disabled={busy || loading}>
            {busy ? <><Spinner size="sm" /> Sondeando…</> : "Ejecutar sondeo"}
          </button>
          <button type="button" onClick={() => void load()} disabled={loading}>↻ Actualizar</button>
        </div>
      </div>
      <p>
        Monitoriza las tarifas del comp-set para informar tus decisiones de BAR. El proveedor de sondeo es determinista y
        está etiquetado como tal (no hay scraper de OTA conectado); las tarifas se guardan en la base de datos.
      </p>
      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      {loading ? (
        <LoadingBlock label="Cargando comp-set…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar" message={error} onRetry={() => void load()} />
      ) : (
        <>
          <section className="rev-kpi-grid">
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Competidores</span></div>
              <div className="rev-kpi-value">{competitors.length}</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Tarifas sondeadas</span></div>
              <div className="rev-kpi-value">{rates.length}</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Mediana de mercado</span></div>
              <div className="rev-kpi-value">{byStay.length ? money(median(byStay.map((b) => b.median))) : "—"}</div>
            </article>
            <article className={`rev-kpi ${openAlerts > 0 ? "rev-kpi-error" : "rev-kpi-ok"}`}>
              <div className="rev-kpi-head"><span className="rev-kpi-label">Alertas de paridad</span></div>
              <div className="rev-kpi-value">{openAlerts}</div>
            </article>
          </section>

          <div className="bo-grid two">
            <article className="bo-card">
              <div className="bo-card-head"><h3>Comp-set</h3><span className="bo-chip">{competitors.length}</span></div>
              {competitors.length === 0 ? (
                <p className="bo-muted">Aún no hay competidores. Añade uno para empezar a sondear.</p>
              ) : (
                <div className="rev-report-wrap">
                  <table className="cm-table">
                    <thead><tr><th>Hotel</th><th>Categoría</th><th>Comparabilidad</th><th>Estado</th></tr></thead>
                    <tbody>
                      {competitors.map((c) => (
                        <tr key={c.id}>
                          <td><strong>{c.name}</strong></td>
                          <td>{c.category ?? "—"}</td>
                          <td>{c.comparableScore ? `${Math.round(Number(c.comparableScore) * 100)}%` : "—"}</td>
                          <td><span className={`bo-status ${c.active ? "ok" : "info"}`}>{c.active ? "activo" : "inactivo"}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="bo-row" style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <input placeholder="Nombre del hotel" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: "1 1 180px" }} />
                <input placeholder="Categoría" value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 80 }} />
                <input placeholder="0.85" value={score} onChange={(e) => setScore(e.target.value)} style={{ width: 70 }} title="Comparabilidad 0–1" />
                <button type="button" onClick={handleAddCompetitor} disabled={busy || !name.trim()}>Añadir</button>
              </div>
            </article>

            <article className="bo-card">
              <div className="bo-card-head"><h3>Alertas de paridad</h3><span className={`bo-chip${openAlerts ? "" : ""}`}>{openAlerts} abiertas</span></div>
              {alerts.length === 0 ? (
                <EmptyState title="Sin alertas de paridad" message="No hay desviaciones de paridad registradas para esta propiedad." />
              ) : (
                <div className="bo-stack" style={{ gap: 8 }}>
                  {alerts.slice(0, 8).map((a) => (
                    <div key={a.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, borderBottom: "1px solid #eef2f7", paddingBottom: 6 }}>
                      <div style={{ minWidth: 0 }}>
                        <span className={`bo-status ${a.severity === "critical" ? "error" : "warn"}`} style={{ textTransform: "none" }}>{a.severity}</span>{" "}
                        <strong>{a.sourceChannel ?? a.alertType}</strong> · {fmtDate(a.stayDate)}
                        <div style={{ fontSize: 13, color: "var(--ink-muted)" }}>{a.message}</div>
                      </div>
                      <span className={`bo-status ${a.status === "open" ? "warn" : "ok"}`} style={{ textTransform: "none", flex: "0 0 auto" }}>{a.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </article>
          </div>

          <article className="bo-card">
            <div className="bo-card-head"><h3>Posición de mercado por fecha</h3><span className="bo-chip">mín · mediana · máx</span></div>
            {byStay.length === 0 ? (
              <p className="bo-muted">Ejecuta un sondeo para ver las tarifas del comp-set por fecha de estancia.</p>
            ) : (
              <div className="rev-report-wrap">
                <table className="cm-table">
                  <thead><tr><th>Fecha de estancia</th><th>Mínimo</th><th>Mediana</th><th>Máximo</th><th>Competidores</th></tr></thead>
                  <tbody>
                    {byStay.slice(0, 14).map((b) => (
                      <tr key={b.stayDate}>
                        <td><strong>{fmtDate(b.stayDate)}</strong></td>
                        <td>{money(b.min)}</td>
                        <td>{money(b.median)}</td>
                        <td>{money(b.max)}</td>
                        <td>{b.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>

          <article className="bo-card">
            <div className="bo-card-head"><h3>Tarifas por competidor (muestra)</h3><span className="bo-chip">{rates.length} snapshots</span></div>
            {rates.length === 0 ? (
              <p className="bo-muted">Sin tarifas. Ejecuta un sondeo.</p>
            ) : (
              <div className="rev-report-wrap">
                <table className="cm-table">
                  <thead><tr><th>Competidor</th><th>Fecha de estancia</th><th>Canal</th><th>Tarifa</th><th>Disponibilidad</th></tr></thead>
                  <tbody>
                    {rates.slice(0, 16).map((r) => (
                      <tr key={r.id}>
                        <td>{r.competitorHotelId ? compName.get(r.competitorHotelId) ?? r.competitorHotelId : "—"}</td>
                        <td>{fmtDate(r.stayDate)}</td>
                        <td>{r.sourceChannel ?? "—"}</td>
                        <td><strong>{money(r.price, r.currency ?? "EUR")}</strong></td>
                        <td>{r.availabilityStatus ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>
        </>
      )}
    </section>
  );
}
