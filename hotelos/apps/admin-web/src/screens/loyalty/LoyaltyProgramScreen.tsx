// Programa de fidelización — configuración de tiers, ratio de puntos y
// beneficios por nivel. El motor evalúa el tier del huésped cada vez que
// completa una estancia y aplica beneficios automáticos.
//
// Datos reales (apps/api/src/server.ts:2189-2190):
//   GET  /crm/loyalty          — programas de la organización + membresías embebidas
//   POST /crm/loyalty/programs — publica la configuración (nueva versión del programa)
//
// El backend no expone PATCH de programas: cada «Guardar cambios» crea una
// versión nueva vía POST y esta pantalla lee siempre la versión activa más
// reciente. Los KPIs de miembros se calculan de las membresías reales
// devueltas por la API (agregadas entre versiones del programa).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createLoyaltyProgram,
  fetchLoyaltyPrograms,
  type LoyaltyMembership,
  type LoyaltyProgram
} from "../../services/crmApi";
import { ErrorState, LoadingBlock } from "../../components/States";
import { useToast } from "../../components/Toast";

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

const DEFAULT_CONFIG: LoyaltyConfig = {
  programName: "Anfitorio Stays Club",
  pointsPerEur: 10,
  pointValueEur: 0.01,
  pointsExpiryMonths: 24,
  bonusOnBirthday: 500,
  earnOnTaxes: false,
  earnOnExtras: true
};

const TIER_PALETTE = ["#93a1ad", "#f0b46a", "#e8eef3", "#4ee0a3"];

/** Plantilla sugerida cuando el programa aún no tiene tiers configurados. */
const TEMPLATE_TIERS: LoyaltyTier[] = [
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

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseConfig(record: LoyaltyProgram): LoyaltyConfig {
  const cfg = (record.configurationJson ?? {}) as Record<string, unknown>;
  return {
    programName: record.name,
    // Compat: versiones antiguas guardaban pointsPerEuro.
    pointsPerEur: num(cfg["pointsPerEur"] ?? cfg["pointsPerEuro"], DEFAULT_CONFIG.pointsPerEur),
    pointValueEur: num(cfg["pointValueEur"], DEFAULT_CONFIG.pointValueEur),
    pointsExpiryMonths: num(cfg["pointsExpiryMonths"], DEFAULT_CONFIG.pointsExpiryMonths),
    bonusOnBirthday: num(cfg["bonusOnBirthday"], DEFAULT_CONFIG.bonusOnBirthday),
    earnOnTaxes: bool(cfg["earnOnTaxes"], DEFAULT_CONFIG.earnOnTaxes),
    earnOnExtras: bool(cfg["earnOnExtras"], DEFAULT_CONFIG.earnOnExtras)
  };
}

/**
 * Normaliza los tiers guardados en configurationJson. Acepta el formato rico
 * de esta UI (objetos LoyaltyTier) y degrada listas de strings heredadas
 * (p. ej. ["member", "silver", "gold"]) a tiers básicos editables.
 */
function parseTiers(raw: unknown): LoyaltyTier[] {
  if (!Array.isArray(raw)) return [];
  const tiers: LoyaltyTier[] = [];
  raw.forEach((item, index) => {
    const fallbackColor = TIER_PALETTE[index % TIER_PALETTE.length] ?? "#93a1ad";
    if (typeof item === "string" && item.trim() !== "") {
      const code = item.trim();
      tiers.push({
        id: `tier_${code}`,
        code,
        name: code.charAt(0).toUpperCase() + code.slice(1),
        color: fallbackColor,
        qualifyingStays: 0,
        pointsMultiplier: 1,
        benefits: []
      });
      return;
    }
    if (item && typeof item === "object") {
      const t = item as Record<string, unknown>;
      const name = typeof t["name"] === "string" && t["name"].trim() !== ""
        ? t["name"]
        : typeof t["code"] === "string" && t["code"].trim() !== ""
          ? t["code"]
          : `Tier ${index + 1}`;
      const code = typeof t["code"] === "string" && t["code"].trim() !== ""
        ? t["code"]
        : name.toLowerCase().replace(/\s+/g, "_");
      tiers.push({
        id: typeof t["id"] === "string" && t["id"] !== "" ? t["id"] : `tier_${code}_${index}`,
        code,
        name,
        color: typeof t["color"] === "string" && t["color"].startsWith("#") ? t["color"] : fallbackColor,
        qualifyingStays: num(t["qualifyingStays"], 0),
        pointsMultiplier: num(t["pointsMultiplier"], 1),
        benefits: Array.isArray(t["benefits"]) ? t["benefits"].filter((b): b is string => typeof b === "string") : []
      });
    }
  });
  return tiers;
}

/** Versión vigente: la activa más reciente (o la más reciente si ninguna activa). */
function pickCurrent(records: LoyaltyProgram[]): LoyaltyProgram | null {
  if (records.length === 0) return null;
  const sorted = [...records].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return sorted.find((p) => p.active) ?? sorted[0] ?? null;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function LoyaltyProgramScreen() {
  const { showToast } = useToast();
  const [programs, setPrograms] = useState<LoyaltyProgram[]>([]);
  const [current, setCurrent] = useState<LoyaltyProgram | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<LoyaltyConfig>(DEFAULT_CONFIG);
  const [tiers, setTiers] = useState<LoyaltyTier[]>([]);
  const [editingTier, setEditingTier] = useState<LoyaltyTier | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const records = await fetchLoyaltyPrograms();
      setPrograms(records);
      const program = pickCurrent(records);
      setCurrent(program);
      if (program) {
        setConfig(parseConfig(program));
        setTiers(parseTiers((program.configurationJson ?? {})["tiers"]));
        setDirty(false);
      } else {
        // Aún no hay programa: la pantalla arranca con una propuesta editable
        // que solo existe en el servidor cuando se pulsa «Crear programa».
        setConfig(DEFAULT_CONFIG);
        setTiers(TEMPLATE_TIERS);
        setDirty(true);
      }
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Membresías reales agregadas entre versiones del programa (el POST de
  // guardado crea versiones nuevas y las membresías quedan ligadas a la suya).
  const memberships = useMemo<LoyaltyMembership[]>(
    () => programs.flatMap((p) => p.memberships ?? []),
    [programs]
  );

  const kpis = useMemo(() => {
    const totalMembers = memberships.length;
    const active = memberships.filter((m) => m.status === "active").length;
    const totalPoints = memberships.reduce((sum, m) => sum + (Number.isFinite(m.pointsBalance) ? m.pointsBalance : 0), 0);
    const avgBalance = totalMembers > 0 ? Math.round(totalPoints / totalMembers) : 0;
    return { totalMembers, active, totalPoints, avgBalance };
  }, [memberships]);

  const distribution = useMemo(() => {
    const byTier = new Map<string, number>();
    for (const m of memberships) {
      const key = m.tier && m.tier.trim() !== "" ? m.tier : "sin_tier";
      byTier.set(key, (byTier.get(key) ?? 0) + 1);
    }
    const total = memberships.length;
    return Array.from(byTier.entries()).map(([tierCode, members]) => ({
      tierCode,
      members,
      pct: total > 0 ? (members / total) * 100 : 0
    }));
  }, [memberships]);

  function tierMeta(code: string): { name: string; color: string } {
    if (code === "sin_tier") return { name: "Sin tier", color: "#93a1ad" };
    const tier = tiers.find((t) => t.code === code);
    return { name: tier?.name ?? code, color: tier?.color ?? "#93a1ad" };
  }

  function patchConfig(patch: Partial<LoyaltyConfig>) {
    setConfig((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  }

  function applyTierEdit() {
    if (!editingTier) return;
    setTiers((prev) => prev.map((t) => (t.id === editingTier.id ? editingTier : t)));
    setEditingTier(null);
    setDirty(true);
  }

  async function saveProgram() {
    if (saving) return;
    const isCreate = current === null;
    const payload = {
      name: config.programName.trim() || DEFAULT_CONFIG.programName,
      configurationJson: {
        pointsPerEur: num(config.pointsPerEur, DEFAULT_CONFIG.pointsPerEur),
        pointValueEur: num(config.pointValueEur, DEFAULT_CONFIG.pointValueEur),
        pointsExpiryMonths: num(config.pointsExpiryMonths, DEFAULT_CONFIG.pointsExpiryMonths),
        bonusOnBirthday: num(config.bonusOnBirthday, DEFAULT_CONFIG.bonusOnBirthday),
        earnOnTaxes: config.earnOnTaxes,
        earnOnExtras: config.earnOnExtras,
        tiers
      }
    };
    setSaving(true);
    try {
      const created = await createLoyaltyProgram(payload);
      await load();
      showToast(
        isCreate
          ? `Programa «${created.name}» creado.`
          : `Configuración guardada — nueva versión de «${created.name}» publicada.`,
        { variant: "success" }
      );
    } catch (err) {
      showToast(`No se pudo guardar la configuración: ${errMsg(err)}`, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="bo-card">
        <LoadingBlock label="Cargando programa de fidelización…" />
      </section>
    );
  }

  if (error) {
    return (
      <section className="bo-card">
        <ErrorState
          title="No se pudo cargar el programa de fidelización"
          message={error}
          onRetry={() => {
            setLoading(true);
            void load();
          }}
        />
      </section>
    );
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Comercial · Fidelización
          </p>
          <h2 style={{ color: "var(--ink)" }}>{config.programName || "Programa de fidelización"}</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Programa por <strong>tiers + puntos</strong>. Los miembros suben de tier por estancias en los últimos 12 meses;
            los puntos se canjean por estancias gratuitas, upgrades o reservas en F&B.
          </p>
        </div>
        {dirty ? <span className="bo-status warn" style={{ alignSelf: "flex-start" }}>cambios sin guardar</span> : null}
      </header>

      {current === null ? (
        <p className="bo-status info" style={{ textTransform: "none" }}>
          Todavía no hay ningún programa de fidelización en el servidor. Ajusta la propuesta y pulsa «Crear programa» para publicarla.
        </p>
      ) : null}

      {/* KPIs — calculados de las membresías reales devueltas por la API */}
      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Miembros totales</span></div>
          <div className="rev-kpi-value">{kpis.totalMembers.toLocaleString("es-ES")}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Membresías activas</span>
            {kpis.totalMembers > 0 ? <span className="bo-status ok">{Math.round((kpis.active / kpis.totalMembers) * 100)}%</span> : null}
          </div>
          <div className="rev-kpi-value">{kpis.active.toLocaleString("es-ES")}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Saldo total puntos</span></div>
          <div className="rev-kpi-value">{kpis.totalPoints.toLocaleString("es-ES")}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Saldo medio</span></div>
          <div className="rev-kpi-value">{kpis.avgBalance.toLocaleString("es-ES")}</div>
        </article>
      </div>

      {/* Distribución por tier */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Distribución de miembros por tier</h3></div>
        {memberships.length === 0 ? (
          <p className="bo-muted" style={{ textTransform: "none" }}>Todavía no hay membresías registradas en el programa.</p>
        ) : (
          <>
            <div style={{ display: "flex", gap: 6, marginTop: 8, height: 28, borderRadius: 6, overflow: "hidden", background: "var(--surface-2)" }}>
              {distribution.map((d) => {
                const meta = tierMeta(d.tierCode);
                return (
                  <div
                    key={d.tierCode}
                    style={{
                      width: `${d.pct}%`,
                      background: meta.color,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      color: "#0a0d10",
                      fontWeight: 600
                    }}
                    title={`${meta.name}: ${d.members.toLocaleString("es-ES")} (${d.pct.toFixed(1)}%)`}
                  >
                    {d.pct >= 6 ? meta.name : ""}
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginTop: 4, fontSize: 11, color: "var(--ink-muted)" }}>
              {distribution.map((d) => {
                const meta = tierMeta(d.tierCode);
                return (
                  <span key={d.tierCode}>
                    <span style={{ display: "inline-block", width: 8, height: 8, background: meta.color, borderRadius: 99, marginRight: 4 }} />
                    {meta.name}: {d.members.toLocaleString("es-ES")} ({d.pct.toFixed(1)}%)
                  </span>
                );
              })}
            </div>
          </>
        )}
      </article>

      {/* Configuración global */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Configuración global del programa</h3>
          <button type="button" className="primary" onClick={() => void saveProgram()} disabled={saving}>
            {saving ? "Guardando…" : current === null ? "Crear programa" : "Guardar cambios"}
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <label>Nombre comercial<input value={config.programName} onChange={(e) => patchConfig({ programName: e.target.value })} /></label>
          <label>Puntos por € gastado<input type="number" value={config.pointsPerEur} onChange={(e) => patchConfig({ pointsPerEur: Number(e.target.value) })} /></label>
          <label>Valor de 1 punto (€)<input type="number" step="0.001" value={config.pointValueEur} onChange={(e) => patchConfig({ pointValueEur: Number(e.target.value) })} /></label>
          <label>Caducidad puntos (meses)<input type="number" value={config.pointsExpiryMonths} onChange={(e) => patchConfig({ pointsExpiryMonths: Number(e.target.value) })} /></label>
          <label>Bonus cumpleaños (puntos)<input type="number" value={config.bonusOnBirthday} onChange={(e) => patchConfig({ bonusOnBirthday: Number(e.target.value) })} /></label>
          <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={config.earnOnTaxes} onChange={(e) => patchConfig({ earnOnTaxes: e.target.checked })} />
            <span>Acumular puntos sobre impuestos</span>
          </label>
          <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={config.earnOnExtras} onChange={(e) => patchConfig({ earnOnExtras: e.target.checked })} />
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
        {tiers.length === 0 ? (
          <div>
            <p className="bo-muted" style={{ textTransform: "none" }}>
              La configuración guardada no define tiers todavía.
            </p>
            <button
              type="button"
              style={{ marginTop: 8 }}
              onClick={() => {
                setTiers(TEMPLATE_TIERS);
                setDirty(true);
              }}
            >
              Cargar plantilla de tiers (Plata → Diamante)
            </button>
          </div>
        ) : (
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
                  <button type="button" onClick={() => setEditingTier({ ...tier, benefits: [...tier.benefits] })}>Editar</button>
                </div>
                {tier.benefits.length === 0 ? (
                  <p className="bo-muted" style={{ fontSize: 12, marginTop: 8, textTransform: "none" }}>Sin beneficios definidos.</p>
                ) : (
                  <ul style={{ fontSize: 12, color: "var(--ink)", marginTop: 8, paddingLeft: 18 }}>
                    {tier.benefits.map((b, i) => <li key={i} style={{ marginBottom: 2 }}>{b}</li>)}
                  </ul>
                )}
              </article>
            ))}
          </div>
        )}
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
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
            <button type="button" className="primary" onClick={applyTierEdit}>
              Aplicar
            </button>
            <span className="bo-muted" style={{ fontSize: 11, textTransform: "none" }}>
              Los cambios de tiers se publican con «Guardar cambios».
            </span>
          </div>
        </article>
      ) : null}

      <p className="bo-muted" style={{ fontSize: 11, textTransform: "none" }}>
        La configuración (global + tiers) se lee de <code>GET /crm/loyalty</code> y cada guardado publica una nueva
        versión del programa vía <code>POST /crm/loyalty/programs</code>.
        {current ? <> Versión vigente publicada el {fmtDate(current.createdAt)}.</> : null}
        {" "}Los KPIs y la distribución provienen de las membresías reales de la API.
      </p>
    </section>
  );
}
