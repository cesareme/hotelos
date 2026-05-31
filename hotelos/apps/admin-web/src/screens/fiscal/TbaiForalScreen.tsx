// TicketBAI multi-jurisdicción foral — dashboard de envíos por territorio
// + verificación de cadena hash.

import { useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import {
  fetchTerritories,
  fetchSubmissions,
  verifyChain,
  type ForalTerritory,
  type TbaiSubmission,
  type TbaiTerritoryConfig
} from "../../services/tbaiApi";
import { LoadingBlock, EmptyState, Spinner } from "../../components/States";

const PROPERTY_ID = getActivePropertyId();

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function statusBadge(status: string): "ok" | "warn" | "info" {
  if (status === "delivered" || status === "acknowledged") return "ok";
  if (status === "retrying" || status === "submitting" || status === "pending") return "warn";
  return "info";
}

export function TbaiForalScreen() {
  const [territories, setTerritories] = useState<ForalTerritory[]>([]);
  const [config, setConfig] = useState<Record<string, TbaiTerritoryConfig>>({});
  const [active, setActive] = useState<ForalTerritory | "">("");
  const [submissions, setSubmissions] = useState<TbaiSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [chainResult, setChainResult] = useState<{ valid: boolean; inspected: number; brokenAt?: string } | null>(null);

  useEffect(() => {
    fetchTerritories()
      .then((r) => { setTerritories(r.items); setConfig(r.config); })
      .catch((e) => setError(e instanceof Error ? e.message : "Error."));
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchSubmissions(PROPERTY_ID, active || undefined)
      .then(setSubmissions)
      .catch((e) => setError(e instanceof Error ? e.message : "Error."))
      .finally(() => setLoading(false));
  }, [active]);

  async function handleVerify() {
    if (!active) return;
    setVerifying(true);
    setChainResult(null);
    try {
      const r = await verifyChain(PROPERTY_ID, active);
      setChainResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error verificando cadena.");
    } finally {
      setVerifying(false);
    }
  }

  const stats = useMemo(() => {
    const byTerritory: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const s of submissions) {
      byTerritory[s.territory] = (byTerritory[s.territory] ?? 0) + 1;
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    }
    return { byTerritory, byStatus };
  }, [submissions]);

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Cumplimiento · TicketBAI foral
          </p>
          <h2 style={{ color: "var(--ink)" }}>Envíos a haciendas forales</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Cada factura emitida en territorio foral se envía a la <strong>hacienda correspondiente</strong> con cadena
            de huellas TBAI (cada envío incluye el hash del anterior). Bizkaia exige envío en ≤ 24 h.
          </p>
        </div>
      </header>

      {error ? <p className="bo-status warn" style={{ textTransform: "none" }}>{error}</p> : null}

      {/* Territory tabs */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setActive("")} className={active === "" ? "primary" : ""} style={{ padding: "6px 12px" }}>
          Todos
        </button>
        {territories.map((t) => (
          <button key={t} type="button" onClick={() => setActive(t)} className={active === t ? "primary" : ""} style={{ padding: "6px 12px" }}>
            {config[t]?.name ?? t}
          </button>
        ))}
      </div>

      {/* Territory info card */}
      {active && config[active] ? (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>{config[active].hacienda}</h3>
            <button type="button" onClick={handleVerify} disabled={verifying}>
              {verifying ? <Spinner size="sm" /> : "Verificar cadena hash"}
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, fontSize: 12 }}>
            <div>
              <span className="bo-muted">ISO</span>
              <p className="mono" style={{ margin: 0, color: "var(--ink)" }}>{config[active].isoCode}</p>
            </div>
            <div>
              <span className="bo-muted">Plazo</span>
              <p style={{ margin: 0, color: "var(--ink)" }}>{Math.round(config[active].submissionDeadlineMs / 86_400_000)} días máximo</p>
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <span className="bo-muted">Endpoint sandbox</span>
              <p className="mono" style={{ margin: 0, color: "var(--ink-muted)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{config[active].endpoints.sandbox}</p>
            </div>
          </div>
          {chainResult ? (
            <p className={`bo-status ${chainResult.valid ? "ok" : "warn"}`} style={{ textTransform: "none", marginTop: 8 }}>
              {chainResult.valid
                ? `✓ Cadena íntegra · ${chainResult.inspected} envíos verificados.`
                : `✗ Cadena rota · ${chainResult.inspected} inspeccionados · broken at ${chainResult.brokenAt}`}
            </p>
          ) : null}
        </article>
      ) : null}

      {/* KPIs */}
      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Envíos totales</span></div>
          <div className="rev-kpi-value">{submissions.length}</div>
        </article>
        {territories.slice(0, 3).map((t) => (
          <article key={t} className="rev-kpi rev-kpi-ok">
            <div className="rev-kpi-head"><span className="rev-kpi-label">{config[t]?.name ?? t}</span></div>
            <div className="rev-kpi-value">{stats.byTerritory[t] ?? 0}</div>
          </article>
        ))}
      </div>

      {/* Submissions table */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Histórico de envíos</h3>
          <span className="bo-chip">{submissions.length}</span>
        </div>
        {loading ? <LoadingBlock label="Cargando envíos…" /> : submissions.length === 0 ? (
          <EmptyState
            title="Sin envíos todavía"
            message={`No hay submissions TBAI para ${active ? config[active]?.name : "esta propiedad"}. Se crean automáticamente al emitir facturas en territorio foral.`}
          />
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr><th>Código</th><th>Territorio</th><th>Estado</th><th>Hash TBAI</th><th>Intentos</th><th>Enviado</th><th>Confirmado</th></tr>
              </thead>
              <tbody>
                {submissions.map((s) => (
                  <tr key={s.id}>
                    <td className="mono"><strong>{s.tbaiCode ?? s.id.slice(0, 16)}</strong></td>
                    <td>{config[s.territory]?.name ?? s.territory}</td>
                    <td><span className={`bo-status ${statusBadge(s.status)}`} style={{ fontSize: 10 }}>{s.status}</span></td>
                    <td className="mono" style={{ fontSize: 10, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {s.tbaiHash ? s.tbaiHash.slice(0, 16) + "…" : "—"}
                    </td>
                    <td className="mono">{s.attempts}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{fmtDateTime(s.submittedAt)}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{fmtDateTime(s.acknowledgedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>
    </section>
  );
}
