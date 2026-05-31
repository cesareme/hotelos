// Programa de fidelización — configuración de tiers, ratio de puntos y
// beneficios por nivel. El motor evalúa el tier del huésped cada vez que
// completa una estancia y aplica beneficios automáticos.

import { useMemo, useState } from "react";

type LoyaltyTier = {
  id: string;
  code: string;
  name: string;
  color: string;
  /** Estancias necesarias para alcanzar el tier en los últimos 12 meses. */
  qualifyingStays: number;
  /** Multiplicador de puntos en este tier. */
  pointsMultiplier: number;
  benefits: string[];
};

type LoyaltyConfig = {
  programName: string;
  pointsPerEur: number;
  pointValueEur: number;
  pointsExpiryMonths: number;
  bonusOnBirthday: number;
  earnOnTaxes: boolean;
  earnOnExtras: boolean;
};

const INITIAL_TIERS: LoyaltyTier[] = [
  {
    id: "tier_silver",
    code: "silver",
    name: "Plata",
    color: "#93a1ad",
    qualifyingStays: 0,
    pointsMultiplier: 1,
    benefits: ["10% descuento en F&B", "Welcome drink", "Wifi premium"]
  },
  {
    id: "tier_gold",
    code: "gold",
    name: "Oro",
    color: "#f0b46a",
    qualifyingStays: 3,
    pointsMultiplier: 1.5,
    benefits: ["Late check-out garantizado", "Upgrade según disponibilidad", "Desayuno cortesía 1/estancia"]
  },
  {
    id: "tier_platinum",
    code: "platinum",
    name: "Platino",
    color: "#e8eef3",
    qualifyingStays: 8,
    pointsMultiplier: 2,
    benefits: ["Upgrade garantizado", "Early check-in + late check-out", "Acceso al lounge", "Welcome amenity premium"]
  },
  {
    id: "tier_diamond",
    code: "diamond",
    name: "Diamante",
    color: "#4ee0a3",
    qualifyingStays: 15,
    pointsMultiplier: 3,
    benefits: ["Suite upgrade prioritario", "Concierge personal 24/7", "Tarifa best-rate garantizada", "Regalo de cumpleaños"]
  }
];

const INITIAL_CONFIG: LoyaltyConfig = {
  programName: "HotelOS Stays Club",
  pointsPerEur: 10,
  pointValueEur: 0.01,
  pointsExpiryMonths: 24,
  bonusOnBirthday: 500,
  earnOnTaxes: false,
  earnOnExtras: true
};

const MEMBER_KPIS = {
  totalMembers: 14_237,
  activeLastMonth: 1_842,
  totalPoints: 8_421_500,
  redemptionsLast90d: 312,
  averagePointsBalance: 591
};

const TIER_DISTRIBUTION: Array<{ tier: string; members: number; pctOfTotal: number }> = [
  { tier: "silver", members: 11_482, pctOfTotal: 80.6 },
  { tier: "gold", members: 2_010, pctOfTotal: 14.1 },
  { tier: "platinum", members: 642, pctOfTotal: 4.5 },
  { tier: "diamond", members: 103, pctOfTotal: 0.8 }
];

export function LoyaltyProgramScreen() {
  const [config, setConfig] = useState<LoyaltyConfig>(INITIAL_CONFIG);
  const [tiers, setTiers] = useState<LoyaltyTier[]>(INITIAL_TIERS);
  const [editingTier, setEditingTier] = useState<LoyaltyTier | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const totalsCheck = useMemo(() => {
    const sum = TIER_DISTRIBUTION.reduce((s, d) => s + d.members, 0);
    return { sum, matchesTotal: sum === MEMBER_KPIS.totalMembers };
  }, []);

  function patchTier(id: string, patch: Partial<LoyaltyTier>) {
    setTiers((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  function saveConfig() {
    // Backend: POST /loyalty/config con el payload.
    setMsg("Configuración guardada (se aplica desde la próxima estancia completada).");
    setTimeout(() => setMsg(null), 3000);
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Comercial · Fidelización
          </p>
          <h2 style={{ color: "var(--ink)" }}>{config.programName}</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Programa por <strong>tiers + puntos</strong>. Los miembros suben de tier por estancias en los últimos 12 meses;
            los puntos se canjean por estancias gratuitas, upgrades o reservas en F&B.
          </p>
        </div>
      </header>

      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      {/* KPIs */}
      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Miembros totales</span></div>
          <div className="rev-kpi-value">{MEMBER_KPIS.totalMembers.toLocaleString("es-ES")}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Activos (último mes)</span><span className="bo-status ok">{Math.round((MEMBER_KPIS.activeLastMonth / MEMBER_KPIS.totalMembers) * 100)}%</span></div>
          <div className="rev-kpi-value">{MEMBER_KPIS.activeLastMonth.toLocaleString("es-ES")}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Saldo total puntos</span></div>
          <div className="rev-kpi-value">{(MEMBER_KPIS.totalPoints / 1_000_000).toFixed(1)}M</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Canjes 90 d</span></div>
          <div className="rev-kpi-value">{MEMBER_KPIS.redemptionsLast90d}</div>
        </article>
      </div>

      {/* Distribución por tier */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Distribución de miembros por tier</h3></div>
        <div style={{ display: "flex", gap: 6, marginTop: 8, height: 28, borderRadius: 6, overflow: "hidden", background: "var(--surface-2)" }}>
          {TIER_DISTRIBUTION.map((d) => {
            const tier = tiers.find((t) => t.code === d.tier);
            return (
              <div
                key={d.tier}
                style={{
                  width: `${d.pctOfTotal}%`,
                  background: tier?.color ?? "#444",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  color: d.tier === "diamond" ? "#0a0d10" : "#0a0d10",
                  fontWeight: 600
                }}
                title={`${tier?.name}: ${d.members.toLocaleString("es-ES")} (${d.pctOfTotal}%)`}
              >
                {d.pctOfTotal >= 6 ? tier?.name : ""}
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 11, color: "var(--ink-muted)" }}>
          {TIER_DISTRIBUTION.map((d) => {
            const tier = tiers.find((t) => t.code === d.tier);
            return (
              <span key={d.tier}>
                <span style={{ display: "inline-block", width: 8, height: 8, background: tier?.color, borderRadius: 99, marginRight: 4 }} />
                {tier?.name}: {d.members.toLocaleString("es-ES")} ({d.pctOfTotal}%)
              </span>
            );
          })}
        </div>
      </article>

      {/* Configuración global */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Configuración global del programa</h3>
          <button type="button" className="primary" onClick={saveConfig}>Guardar cambios</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <label>Nombre comercial<input value={config.programName} onChange={(e) => setConfig({ ...config, programName: e.target.value })} /></label>
          <label>Puntos por € gastado<input type="number" value={config.pointsPerEur} onChange={(e) => setConfig({ ...config, pointsPerEur: Number(e.target.value) })} /></label>
          <label>Valor de 1 punto (€)<input type="number" step="0.001" value={config.pointValueEur} onChange={(e) => setConfig({ ...config, pointValueEur: Number(e.target.value) })} /></label>
          <label>Caducidad puntos (meses)<input type="number" value={config.pointsExpiryMonths} onChange={(e) => setConfig({ ...config, pointsExpiryMonths: Number(e.target.value) })} /></label>
          <label>Bonus cumpleaños (puntos)<input type="number" value={config.bonusOnBirthday} onChange={(e) => setConfig({ ...config, bonusOnBirthday: Number(e.target.value) })} /></label>
          <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={config.earnOnTaxes} onChange={(e) => setConfig({ ...config, earnOnTaxes: e.target.checked })} />
            <span>Acumular puntos sobre impuestos</span>
          </label>
          <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={config.earnOnExtras} onChange={(e) => setConfig({ ...config, earnOnExtras: e.target.checked })} />
            <span>Acumular puntos sobre F&B y extras</span>
          </label>
        </div>
        <p className="bo-muted" style={{ textTransform: "none", marginTop: 8, fontSize: 12 }}>
          Ratio actual: <strong>{config.pointsPerEur} puntos × {config.pointValueEur} € = {(config.pointsPerEur * config.pointValueEur * 100).toFixed(1)} % de retorno</strong> al canje.
        </p>
      </article>

      {/* Tiers */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Niveles del programa</h3></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginTop: 8 }}>
          {tiers.map((tier) => (
            <article key={tier.id} className="bo-card" style={{ background: "var(--surface-2, var(--surface))", borderTop: `4px solid ${tier.color}` }}>
              <div className="bo-card-head">
                <div>
                  <strong style={{ color: "var(--ink)", fontSize: 18 }}>{tier.name}</strong>
                  <p className="bo-muted" style={{ margin: "2px 0 0", fontSize: 11 }}>
                    {tier.qualifyingStays === 0 ? "Tier de entrada" : `Desde ${tier.qualifyingStays} estancias/año`} · ×{tier.pointsMultiplier} puntos
                  </p>
                </div>
                <button type="button" onClick={() => setEditingTier(tier)}>Editar</button>
              </div>
              <ul style={{ fontSize: 12, color: "var(--ink)", marginTop: 8, paddingLeft: 18 }}>
                {tier.benefits.map((b, i) => <li key={i} style={{ marginBottom: 2 }}>{b}</li>)}
              </ul>
            </article>
          ))}
        </div>
      </article>

      {/* Edit tier dialog */}
      {editingTier ? (
        <article className="bo-card" style={{ background: "var(--surface-2)", border: "1px solid var(--accent)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Editar tier «{editingTier.name}»</h3>
            <button type="button" onClick={() => setEditingTier(null)}>Cerrar</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <label>Nombre<input value={editingTier.name} onChange={(e) => setEditingTier({ ...editingTier, name: e.target.value })} /></label>
            <label>Estancias mínimas<input type="number" value={editingTier.qualifyingStays} onChange={(e) => setEditingTier({ ...editingTier, qualifyingStays: Number(e.target.value) })} /></label>
            <label>Multiplicador puntos<input type="number" step="0.1" value={editingTier.pointsMultiplier} onChange={(e) => setEditingTier({ ...editingTier, pointsMultiplier: Number(e.target.value) })} /></label>
            <label>Color<input type="color" value={editingTier.color} onChange={(e) => setEditingTier({ ...editingTier, color: e.target.value })} /></label>
          </div>
          <label style={{ display: "block", marginTop: 12 }}>Beneficios (uno por línea)
            <textarea
              rows={4}
              value={editingTier.benefits.join("\n")}
              onChange={(e) => setEditingTier({ ...editingTier, benefits: e.target.value.split("\n").filter(Boolean) })}
              style={{ width: "100%" }}
            />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button" className="primary" onClick={() => { patchTier(editingTier.id, editingTier); setEditingTier(null); }}>
              Guardar
            </button>
          </div>
        </article>
      ) : null}

      <p className="bo-muted" style={{ fontSize: 11, textTransform: "none" }}>
        Datos demo en KPIs y distribución. La configuración (tiers + global) se guarda en{" "}
        <code>advanced_records/loyalty_config</code> y se aplica desde la próxima estancia completada.
        {totalsCheck.matchesTotal ? "" : " ⚠ La distribución por tier no suma el total — recalcula."}
      </p>
    </section>
  );
}
