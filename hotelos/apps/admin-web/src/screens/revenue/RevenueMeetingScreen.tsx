import { useCallback, useEffect, useState } from "react";
import {
  fetchMeetingPack,
  analyzeDisplacement,
  money,
  type MeetingPack,
  type Displacement
} from "../../services/revenueApi";
import { LoadingBlock, ErrorState, Spinner } from "../../components/States";

function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString("es-ES", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
}

export function RevenueMeetingScreen() {
  const [pack, setPack] = useState<MeetingPack | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Displacement calculator
  const [arrival, setArrival] = useState("2026-06-10");
  const [departure, setDeparture] = useState("2026-06-13");
  const [rooms, setRooms] = useState("10");
  const [rate, setRate] = useState("95");
  const [disp, setDisp] = useState<Displacement | null>(null);
  const [dispBusy, setDispBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPack(await fetchMeetingPack());
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el pack de reunión.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runDisplacement() {
    setDispBusy(true);
    try {
      setDisp(await analyzeDisplacement({ arrivalDate: arrival, departureDate: departure, roomsPerNight: Number(rooms), groupRate: Number(rate) }));
    } catch {
      setDisp(null);
    } finally {
      setDispBusy(false);
    }
  }

  const h = (n: number) => pack?.pace.horizons.find((x) => x.horizonDays === n);
  const pk = (n: number) => pack?.pickup.windows.find((x) => x.windowDays === n);
  const occAcc = pack?.forecastAccuracy.find((m) => m.metric === "occupancy");
  const adrAcc = pack?.forecastAccuracy.find((m) => m.metric === "adr");

  return (
    <section className="bo-card" style={{ display: "grid", gap: 16 }}>
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Comercial · Revenue</p>
          <h2>Panel de reunión de revenue</h2>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>↻ Actualizar</button>
      </div>
      <p>Todo lo que necesita la reunión semanal en una pantalla: pace, pickup, precisión de la previsión, comp-set, presupuesto vs previsión vs real, recomendaciones pendientes y una calculadora de desplazamiento de grupos. Datos reales.</p>

      {loading ? (
        <LoadingBlock label="Cargando pack de reunión…" />
      ) : error || !pack ? (
        <ErrorState title="No se pudo cargar" message={error ?? "Sin datos"} onRetry={() => void load()} />
      ) : (
        <>
          <section className="rev-kpi-grid">
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">OTB 30 días</span></div>
              <div className="rev-kpi-value">{h(30)?.otbRooms ?? 0} noches</div>
              <div className="rev-kpi-delta">{money(h(30)?.otbRevenue ?? 0)}</div>
            </article>
            <article className={`rev-kpi rev-kpi-${(h(90)?.paceRooms ?? 0) >= 0 ? "ok" : "warn"}`}>
              <div className="rev-kpi-head"><span className="rev-kpi-label">Pace 90 días</span></div>
              <div className="rev-kpi-value">{(h(90)?.paceRooms ?? 0) >= 0 ? "+" : ""}{h(90)?.paceRooms ?? 0} noches</div>
              <div className="rev-kpi-delta">{pack.pace.comparison.label}</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Pickup 7 días</span></div>
              <div className="rev-kpi-value">{pk(7)?.roomNights ?? 0} noches</div>
              <div className="rev-kpi-delta">{pk(7)?.reservations ?? 0} reservas · {money(pk(7)?.revenue ?? 0)}</div>
            </article>
            <article className={`rev-kpi rev-kpi-${(occAcc?.accuracy ?? 0) >= 80 ? "ok" : "warn"}`}>
              <div className="rev-kpi-head"><span className="rev-kpi-label">Precisión previsión</span></div>
              <div className="rev-kpi-value">{occAcc?.accuracy != null ? `${occAcc.accuracy}%` : "—"}</div>
              <div className="rev-kpi-delta">ADR {adrAcc?.accuracy != null ? `${adrAcc.accuracy}%` : "—"}</div>
            </article>
          </section>

          <div className="bo-grid two">
            <article className="bo-card">
              <div className="bo-card-head"><h3>Comp-set (próx. 14 días)</h3><span className="bo-chip">{pack.compSet.samples} muestras</span></div>
              {pack.compSet.median == null ? (
                <p className="bo-muted">Sin tarifas de comp-set. Ejecuta un sondeo en Rate Shopper.</p>
              ) : (
                <div className="rev-kpi-grid">
                  <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Mínimo</span></div><div className="rev-kpi-value">{money(pack.compSet.min ?? 0)}</div></article>
                  <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Mediana</span></div><div className="rev-kpi-value">{money(pack.compSet.median)}</div></article>
                  <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Máximo</span></div><div className="rev-kpi-value">{money(pack.compSet.max ?? 0)}</div></article>
                </div>
              )}
            </article>

            <article className="bo-card">
              <div className="bo-card-head"><h3>Presupuesto vs previsión vs real</h3><span className="bo-chip">{pack.budgetVariance.month}</span></div>
              <div className="rev-report-wrap">
                <table className="cm-table">
                  <thead><tr><th></th><th>Ocup.</th><th>ADR</th><th>Ingresos hab.</th></tr></thead>
                  <tbody>
                    <tr><td><strong>Presupuesto</strong></td><td>{pack.budgetVariance.budget ? `${pack.budgetVariance.budget.occupancyPct}%` : "—"}</td><td>{pack.budgetVariance.budget ? money(pack.budgetVariance.budget.adr) : "—"}</td><td>{pack.budgetVariance.budget ? money(pack.budgetVariance.budget.roomRevenue) : "—"}</td></tr>
                    <tr><td><strong>Previsión</strong></td><td>{pack.budgetVariance.forecast.occupancyPct}%</td><td>{money(pack.budgetVariance.forecast.adr)}</td><td>{money(pack.budgetVariance.forecast.roomRevenue)}</td></tr>
                    <tr><td><strong>Real</strong></td><td>{pack.budgetVariance.actual.occupancyPct}%</td><td>{money(pack.budgetVariance.actual.adr)}</td><td>{money(pack.budgetVariance.actual.roomRevenue)}</td></tr>
                  </tbody>
                </table>
              </div>
            </article>
          </div>

          <article className="bo-card">
            <div className="bo-card-head"><h3>Recomendaciones de BAR pendientes</h3><span className="bo-chip">{pack.topRecommendations.length}</span></div>
            {pack.topRecommendations.length === 0 ? (
              <p className="bo-muted">No hay recomendaciones pendientes. Genera nuevas en «Reglas y recomendaciones de BAR».</p>
            ) : (
              <div className="rev-report-wrap">
                <table className="cm-table">
                  <thead><tr><th>Fecha</th><th>BAR actual</th><th>BAR sugerido</th><th>Δ</th><th>Riesgo</th></tr></thead>
                  <tbody>
                    {pack.topRecommendations.map((r) => (
                      <tr key={r.id}>
                        <td><strong>{fmtDate(r.targetDate)}</strong></td>
                        <td>{r.current?.bar != null ? money(r.current.bar) : "—"}</td>
                        <td><strong>{r.recommended?.bar != null ? money(r.recommended.bar) : "—"}</strong></td>
                        <td>{(r.expectedImpact?.deltaPct ?? 0) >= 0 ? "+" : ""}{r.expectedImpact?.deltaPct ?? 0}%</td>
                        <td><span className={`bo-status ${r.riskLevel === "high" ? "warn" : "ok"}`} style={{ textTransform: "none" }}>{r.riskLevel}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>

          <article className="bo-card">
            <div className="bo-card-head"><h3>Análisis de desplazamiento de grupos</h3></div>
            <p className="bo-muted" style={{ textTransform: "none" }}>Evalúa si un grupo compensa frente al transitorio que desplazaría a la tarifa de previsión.</p>
            <div className="bo-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
              <label style={{ display: "grid", gap: 2 }}><span className="bo-muted" style={{ textTransform: "none", fontSize: 12 }}>Entrada</span><input type="date" value={arrival} onChange={(e) => setArrival(e.target.value)} /></label>
              <label style={{ display: "grid", gap: 2 }}><span className="bo-muted" style={{ textTransform: "none", fontSize: 12 }}>Salida</span><input type="date" value={departure} onChange={(e) => setDeparture(e.target.value)} /></label>
              <label style={{ display: "grid", gap: 2 }}><span className="bo-muted" style={{ textTransform: "none", fontSize: 12 }}>Hab./noche</span><input value={rooms} onChange={(e) => setRooms(e.target.value)} style={{ width: 90 }} /></label>
              <label style={{ display: "grid", gap: 2 }}><span className="bo-muted" style={{ textTransform: "none", fontSize: 12 }}>Tarifa grupo</span><input value={rate} onChange={(e) => setRate(e.target.value)} style={{ width: 100 }} /></label>
              <button type="button" className="primary" onClick={() => void runDisplacement()} disabled={dispBusy} style={{ alignSelf: "end" }}>{dispBusy ? <><Spinner size="sm" /> Analizando…</> : "Analizar"}</button>
            </div>
            {disp ? (
              <div className="rev-kpi-grid">
                <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Ingresos del grupo</span></div><div className="rev-kpi-value">{money(disp.groupRevenue)}</div></article>
                <article className="rev-kpi rev-kpi-warn"><div className="rev-kpi-head"><span className="rev-kpi-label">Transitorio desplazado</span></div><div className="rev-kpi-value">{money(disp.displacedRevenue)}</div></article>
                <article className={`rev-kpi rev-kpi-${disp.netBenefit >= 0 ? "ok" : "error"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Beneficio neto</span></div><div className="rev-kpi-value">{money(disp.netBenefit)}</div></article>
                <article className={`rev-kpi rev-kpi-${disp.recommendation === "accept" ? "ok" : disp.recommendation === "accept_with_caution" ? "warn" : "error"}`}>
                  <div className="rev-kpi-head"><span className="rev-kpi-label">Recomendación</span></div>
                  <div className="rev-kpi-value" style={{ fontSize: 16 }}>{disp.recommendation === "accept" ? "Aceptar" : disp.recommendation === "accept_with_caution" ? "Aceptar con cautela" : "Negociar / declinar"}</div>
                </article>
              </div>
            ) : null}
          </article>
        </>
      )}
    </section>
  );
}
