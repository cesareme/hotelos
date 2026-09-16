// Programa de fidelización — Comercial › Clientes y fidelización › Programa
// (/comercial/clientes/programa, hosted inside ClientesTabs).
//
// Cocoa 22 · ola 7 · lote 7-B (docs/design/COCOA-22.md §4, archetype
// «dashboard alojado»): CocoaPage → CocoaKpiStrip (members, active, points)
// → CocoaGrid 5/7 (distribution by tier as CocoaChart.Progress rows · global
// configuration as a CocoaFormSection with string-controlled fields) →
// tier cards inside a CocoaSection (a CocoaSection per tier) → a CocoaDrawer
// edits one tier. «Crear programa» / «Guardar cambios» lives in the page
// actions and in ⌘K.
//
// Data (apps/api/src/server.ts:2189-2190, module guest_data_crm_loyalty):
//   GET  /crm/loyalty          — programmes of the organisation + embedded memberships
//   POST /crm/loyalty/programs — publishes the configuration (a NEW version of the programme)
//
// The backend has no PATCH for programmes: every save creates a new version
// through POST and the screen always reads the most recent active one. The
// member KPIs come from the real memberships returned by the API (aggregated
// across programme versions). Module gate (qa#14): nothing is requested until
// guest_data_crm_loyalty is known to be enabled; with the module off the page
// paints «Módulo no activado» (+ «Activar módulo» for users with modules.enable).
//
// Tier colours: a tier may carry a `color` in configurationJson (older
// versions of this screen let the user pick one). Cocoa 22 paints no colour a
// screen invents (§2, §6), so the value is preserved on every save but no
// longer edited nor painted here.

import { useCallback, useEffect, useMemo, useState } from "react";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { getActiveProperty } from "../../services/activeProperty";
import {
  createLoyaltyProgram,
  fetchLoyaltyPrograms,
  type LoyaltyMembership,
  type LoyaltyProgram
} from "../../services/crmApi";
import { useToast } from "../../components/Toast";
import { ACTIONS, FIELD_LABELS } from "../../content/actions";
import { date, money, number, percent, plural, toNumber } from "../../lib/format";
import { moduleDisabledCopy } from "../operations/module-gate";
import { useScreenModuleGate } from "../operations/useScreenModuleGate";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaSwitch
} from "../../components/cocoa";

// Menu labels of the tree (Comercial › Clientes y fidelización › Programa), never retyped here.
const HEADER = treeHeaderFor("LoyaltyProgram", { eyebrow: "Comercial · Clientes y fidelización", title: "Programa" });

type LoyaltyTier = {
  id: string;
  code: string;
  name: string;
  /** Kept as saved by older versions of the screen; not edited nor painted (see header). */
  color?: string;
  /** Stays needed to reach the tier in the last 12 months. */
  qualifyingStays: number;
  /** Points multiplier of the tier. */
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

/** Form state of the global configuration: numbers travel as strings (§4.2 A3) and are parsed on save. */
type ConfigForm = {
  programName: string;
  pointsPerEur: string;
  pointValueEur: string;
  pointsExpiryMonths: string;
  bonusOnBirthday: string;
  earnOnTaxes: boolean;
  earnOnExtras: boolean;
};

/** Form state of the tier drawer (numbers as strings, benefits one per line). */
type TierForm = {
  id: string;
  name: string;
  qualifyingStays: string;
  pointsMultiplier: string;
  benefits: string;
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

/** Suggested template when the programme has no tiers yet. */
const TEMPLATE_TIERS: LoyaltyTier[] = [
  {
    id: "tier_silver",
    code: "silver",
    name: "Plata",
    qualifyingStays: 0,
    pointsMultiplier: 1,
    benefits: ["10 % de descuento en restauración", "Bebida de bienvenida", "Wifi premium"]
  },
  {
    id: "tier_gold",
    code: "gold",
    name: "Oro",
    qualifyingStays: 3,
    pointsMultiplier: 1.5,
    benefits: ["Salida tardía garantizada", "Mejora de habitación según disponibilidad", "Desayuno de cortesía una vez por estancia"]
  },
  {
    id: "tier_platinum",
    code: "platinum",
    name: "Platino",
    qualifyingStays: 8,
    pointsMultiplier: 2,
    benefits: ["Mejora de habitación garantizada", "Entrada anticipada y salida tardía", "Acceso al salón", "Detalle de bienvenida premium"]
  },
  {
    id: "tier_diamond",
    code: "diamond",
    name: "Diamante",
    qualifyingStays: 15,
    pointsMultiplier: 3,
    benefits: ["Prioridad de mejora a suite", "Conserje personal 24 h", "Mejor tarifa garantizada", "Regalo de cumpleaños"]
  }
];

const SAVE_LABEL = ACTIONS.saveChanges;
const CREATE_LABEL = "Crear programa";
const TEMPLATE_LABEL = "Cargar plantilla de niveles (Plata → Diamante)";

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
    // Compat: older versions saved pointsPerEuro.
    pointsPerEur: num(cfg["pointsPerEur"] ?? cfg["pointsPerEuro"], DEFAULT_CONFIG.pointsPerEur),
    pointValueEur: num(cfg["pointValueEur"], DEFAULT_CONFIG.pointValueEur),
    pointsExpiryMonths: num(cfg["pointsExpiryMonths"], DEFAULT_CONFIG.pointsExpiryMonths),
    bonusOnBirthday: num(cfg["bonusOnBirthday"], DEFAULT_CONFIG.bonusOnBirthday),
    earnOnTaxes: bool(cfg["earnOnTaxes"], DEFAULT_CONFIG.earnOnTaxes),
    earnOnExtras: bool(cfg["earnOnExtras"], DEFAULT_CONFIG.earnOnExtras)
  };
}

/**
 * Normalises the tiers saved in configurationJson. Accepts the rich format of
 * this screen (LoyaltyTier objects) and degrades legacy string lists (e.g.
 * ["member", "silver", "gold"]) to basic editable tiers.
 */
function parseTiers(raw: unknown): LoyaltyTier[] {
  if (!Array.isArray(raw)) return [];
  const tiers: LoyaltyTier[] = [];
  raw.forEach((item, index) => {
    if (typeof item === "string" && item.trim() !== "") {
      const code = item.trim();
      tiers.push({
        id: `tier_${code}`,
        code,
        name: code.charAt(0).toUpperCase() + code.slice(1),
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
          : `Nivel ${index + 1}`;
      const code = typeof t["code"] === "string" && t["code"].trim() !== ""
        ? t["code"]
        : name.toLowerCase().replace(/\s+/g, "_");
      const color = typeof t["color"] === "string" && t["color"].trim() !== "" ? t["color"] : undefined;
      tiers.push({
        id: typeof t["id"] === "string" && t["id"] !== "" ? t["id"] : `tier_${code}_${index}`,
        code,
        name,
        ...(color ? { color } : {}),
        qualifyingStays: num(t["qualifyingStays"], 0),
        pointsMultiplier: num(t["pointsMultiplier"], 1),
        benefits: Array.isArray(t["benefits"]) ? t["benefits"].filter((b): b is string => typeof b === "string") : []
      });
    }
  });
  return tiers;
}

/** Current version: the most recent active one (or the most recent if none is active). */
function pickCurrent(records: LoyaltyProgram[]): LoyaltyProgram | null {
  if (records.length === 0) return null;
  const sorted = [...records].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return sorted.find((p) => p.active) ?? sorted[0] ?? null;
}

function toForm(config: LoyaltyConfig): ConfigForm {
  return {
    programName: config.programName,
    pointsPerEur: String(config.pointsPerEur),
    pointValueEur: String(config.pointValueEur),
    pointsExpiryMonths: String(config.pointsExpiryMonths),
    bonusOnBirthday: String(config.bonusOnBirthday),
    earnOnTaxes: config.earnOnTaxes,
    earnOnExtras: config.earnOnExtras
  };
}

function fromForm(form: ConfigForm): LoyaltyConfig {
  return {
    programName: form.programName.trim() || DEFAULT_CONFIG.programName,
    pointsPerEur: toNumber(form.pointsPerEur) ?? DEFAULT_CONFIG.pointsPerEur,
    pointValueEur: toNumber(form.pointValueEur) ?? DEFAULT_CONFIG.pointValueEur,
    pointsExpiryMonths: toNumber(form.pointsExpiryMonths) ?? DEFAULT_CONFIG.pointsExpiryMonths,
    bonusOnBirthday: toNumber(form.bonusOnBirthday) ?? DEFAULT_CONFIG.bonusOnBirthday,
    earnOnTaxes: form.earnOnTaxes,
    earnOnExtras: form.earnOnExtras
  };
}

function tierToForm(tier: LoyaltyTier): TierForm {
  return {
    id: tier.id,
    name: tier.name,
    qualifyingStays: String(tier.qualifyingStays),
    pointsMultiplier: String(tier.pointsMultiplier),
    benefits: tier.benefits.join("\n")
  };
}

function tierThreshold(tier: LoyaltyTier): string {
  return tier.qualifyingStays === 0 ? "Nivel de entrada" : `Desde ${plural(tier.qualifyingStays, "estancia", "estancias")} al año`;
}

function multiplierLabel(multiplier: number): string {
  return `×${number(multiplier, { maximumFractionDigits: 2 })} puntos`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Mirror skeleton: the KPI strip, the 5/7 row and the tier strip.
function ProgramSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[5, 7]]} height={260} />
      <CocoaSkeleton variant="card" height={220} />
    </div>
  );
}

export function LoyaltyProgramScreen() {
  // Hosted inside ClientesTabs the container paints eyebrow + H1; CocoaPage adds the subtitle and actions row.
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  // Module gate (qa#14): no request until guest_data_crm_loyalty is known to be enabled.
  const moduleGate = useScreenModuleGate("LoyaltyProgram");
  const [programs, setPrograms] = useState<LoyaltyProgram[]>([]);
  const [current, setCurrent] = useState<LoyaltyProgram | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ConfigForm>(() => toForm(DEFAULT_CONFIG));
  const [tiers, setTiers] = useState<LoyaltyTier[]>([]);
  const [editingTier, setEditingTier] = useState<TierForm | null>(null);
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
        setForm(toForm(parseConfig(program)));
        setTiers(parseTiers((program.configurationJson ?? {})["tiers"]));
        setDirty(false);
      } else {
        // No programme yet: the screen starts with an editable proposal that
        // only exists on the server once «Crear programa» is pressed.
        setForm(toForm(DEFAULT_CONFIG));
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
    if (moduleGate.ready) void load();
  }, [load, moduleGate.ready]);

  function reload() {
    setLoading(true);
    void load();
  }

  // Real memberships aggregated across programme versions (every save creates
  // a new version and the memberships stay tied to their own).
  const memberships = useMemo<LoyaltyMembership[]>(() => programs.flatMap((p) => p.memberships ?? []), [programs]);

  const kpis = useMemo(() => {
    const totalMembers = memberships.length;
    const active = memberships.filter((m) => m.status === "active").length;
    const totalPoints = memberships.reduce((sum, m) => sum + (Number.isFinite(m.pointsBalance) ? m.pointsBalance : 0), 0);
    const avgBalance = totalMembers > 0 ? Math.round(totalPoints / totalMembers) : 0;
    const activePct = totalMembers > 0 ? (active / totalMembers) * 100 : 0;
    return { totalMembers, active, totalPoints, avgBalance, activePct };
  }, [memberships]);

  const distribution = useMemo(() => {
    const byTier = new Map<string, number>();
    for (const m of memberships) {
      const key = m.tier && m.tier.trim() !== "" ? m.tier : "sin_tier";
      byTier.set(key, (byTier.get(key) ?? 0) + 1);
    }
    const total = memberships.length;
    const rows = Array.from(byTier.entries()).map(([tierCode, members]) => ({
      tierCode,
      members,
      pct: total > 0 ? (members / total) * 100 : 0
    }));
    const max = rows.reduce((m, r) => Math.max(m, r.members), 0);
    return { rows, max };
  }, [memberships]);

  function tierName(code: string): string {
    if (code === "sin_tier") return "Sin nivel";
    return tiers.find((t) => t.code === code)?.name ?? code;
  }

  function patchForm(patch: Partial<ConfigForm>) {
    setForm((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  }

  function applyTierEdit() {
    if (!editingTier) return;
    const draft = editingTier;
    setTiers((prev) =>
      prev.map((t) =>
        t.id === draft.id
          ? {
              ...t,
              name: draft.name.trim() || t.name,
              qualifyingStays: Math.max(0, toNumber(draft.qualifyingStays) ?? t.qualifyingStays),
              pointsMultiplier: toNumber(draft.pointsMultiplier) ?? t.pointsMultiplier,
              benefits: draft.benefits.split("\n").map((b) => b.trim()).filter(Boolean)
            }
          : t
      )
    );
    setEditingTier(null);
    setDirty(true);
  }

  function loadTemplate() {
    setTiers(TEMPLATE_TIERS);
    setDirty(true);
  }

  async function saveProgram() {
    if (saving || !moduleGate.ready) return;
    const isCreate = current === null;
    const config = fromForm(form);
    const payload = {
      name: config.programName,
      configurationJson: {
        pointsPerEur: config.pointsPerEur,
        pointValueEur: config.pointValueEur,
        pointsExpiryMonths: config.pointsExpiryMonths,
        bonusOnBirthday: config.bonusOnBirthday,
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
        isCreate ? `Programa «${created.name}» creado.` : `Configuración guardada: nueva versión de «${created.name}» publicada.`,
        { variant: "success" }
      );
    } catch (err) {
      showToast(`No se pudo guardar la configuración: ${errMsg(err)}`, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  const config = fromForm(form);
  const returnPct = config.pointsPerEur * config.pointValueEur;
  const saveLabel = current === null ? CREATE_LABEL : SAVE_LABEL;

  // Module not active → the whole body is the «Módulo no activado» state (§3.10).
  const moduleDisabled = moduleGate.status === "disabled";
  const disabledCopy = moduleDisabledCopy(moduleGate.canEnable);
  const state =
    moduleGate.status === "loading" ? "loading" : moduleDisabled ? "empty" : loading ? "loading" : error ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
      title={HEADER.title}
      subtitle="Programa por niveles y puntos: los miembros suben de nivel por estancias en los últimos 12 meses y canjean puntos por estancias, mejoras o consumo."
      actions={
        moduleGate.ready ? (
          <>
            {dirty ? <CocoaBadge tone="warning">cambios sin guardar</CocoaBadge> : null}
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={reload} disabled={loading || saving}>
              {ACTIONS.refresh}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void saveProgram()} loading={saving} disabled={loading || saving}>
              {saveLabel}
            </CocoaButton>
          </>
        ) : null
      }
      state={state}
      skeleton={<ProgramSkeleton />}
      empty={{
        title: disabledCopy.title,
        message: disabledCopy.message,
        primaryAction: disabledCopy.cta ? { label: disabledCopy.cta, onClick: moduleGate.enable } : undefined
      }}
      error={{ title: "No se pudo cargar el programa de fidelización", message: error ?? undefined, onRetry: reload }}
      commands={
        moduleGate.ready
          ? [
              { id: "loyalty-program-save", label: `${saveLabel} · ${HEADER.title}`, run: () => void saveProgram() },
              { id: "loyalty-program-refresh", label: "Actualizar programa de fidelización", run: reload }
            ]
          : moduleDisabled && disabledCopy.cta
            ? [{ id: "loyalty-program-enable-module", label: `${disabledCopy.cta} · ${HEADER.title}`, run: moduleGate.enable }]
            : []
      }
    >
      {current === null ? (
        <CocoaCallout tone="info" title="Todavía no hay ningún programa de fidelización">
          Ajusta la propuesta y pulsa «{CREATE_LABEL}» para publicarla. Por ahora el programa se guarda en la memoria del servidor y se pierde al reiniciarlo.
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Miembros del programa">
        <CocoaKpi label="Miembros totales" value={number(kpis.totalMembers)} caption="membresías registradas" polarity="neutral" status="ok" />
        <CocoaKpi
          label="Membresías activas"
          value={number(kpis.active)}
          caption={kpis.totalMembers > 0 ? `${percent(kpis.activePct, { maximumFractionDigits: 0 })} del total` : "sin miembros todavía"}
          polarity="neutral"
          status="ok"
        />
        <CocoaKpi label="Saldo total de puntos" value={number(kpis.totalPoints)} caption="en circulación" polarity="neutral" status="ok" />
        <CocoaKpi label="Saldo medio" value={number(kpis.avgBalance)} caption="puntos por miembro" polarity="neutral" status="ok" />
      </CocoaKpiStrip>

      <CocoaGrid align="start" aria-label="Distribución y configuración">
        <CocoaSpan cols={5} min={320}>
          <CocoaSection title="Miembros por nivel" meta={plural(memberships.length, "miembro", "miembros")}>
            {distribution.rows.length === 0 ? (
              <CocoaState kind="empty" inline title="Todavía no hay membresías registradas en el programa." />
            ) : (
              <ul className="c22-section__list" aria-label="Miembros por nivel">
                {distribution.rows.map((row) => (
                  <li key={row.tierCode}>
                    <span style={{ flex: "1 1 auto", minWidth: 0 }}>
                      <CocoaChart.Progress
                        value={distribution.max > 0 ? Math.max(2, (row.members / distribution.max) * 100) : 0}
                        label={tierName(row.tierCode)}
                        valueLabel={`${number(row.members)} · ${percent(row.pct, { maximumFractionDigits: 1 })}`}
                        aria-label={`${tierName(row.tierCode)}: ${plural(row.members, "miembro", "miembros")} (${percent(row.pct, { maximumFractionDigits: 1 })})`}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={7} min={320}>
          <CocoaFormSection title="Configuración global del programa" description="Ratio de puntos, valor de canje, caducidad y bonificaciones.">
            <CocoaFormRow columns={2}>
              <CocoaField label="Nombre comercial" required>
                <CocoaInput value={form.programName} onChange={(v) => patchForm({ programName: v })} placeholder={DEFAULT_CONFIG.programName} disabled={saving} />
              </CocoaField>
              <CocoaField label="Puntos por euro gastado">
                <CocoaInput type="number" inputMode="decimal" min={0} step={1} value={form.pointsPerEur} onChange={(v) => patchForm({ pointsPerEur: v })} disabled={saving} />
              </CocoaField>
              <CocoaField label="Valor de un punto (€)">
                <CocoaInput type="number" inputMode="decimal" min={0} step={0.001} value={form.pointValueEur} onChange={(v) => patchForm({ pointValueEur: v })} disabled={saving} />
              </CocoaField>
              <CocoaField label="Caducidad de los puntos (meses)">
                <CocoaInput type="number" inputMode="numeric" min={0} step={1} value={form.pointsExpiryMonths} onChange={(v) => patchForm({ pointsExpiryMonths: v })} disabled={saving} />
              </CocoaField>
              <CocoaField label="Bonificación de cumpleaños (puntos)">
                <CocoaInput type="number" inputMode="numeric" min={0} step={1} value={form.bonusOnBirthday} onChange={(v) => patchForm({ bonusOnBirthday: v })} disabled={saving} />
              </CocoaField>
            </CocoaFormRow>
            <CocoaFormRow columns={2}>
              <CocoaField label="Acumular puntos sobre impuestos" inline>
                <CocoaSwitch checked={form.earnOnTaxes} onChange={(v) => patchForm({ earnOnTaxes: v })} disabled={saving} />
              </CocoaField>
              <CocoaField label="Acumular puntos sobre restauración y extras" inline>
                <CocoaSwitch checked={form.earnOnExtras} onChange={(v) => patchForm({ earnOnExtras: v })} disabled={saving} />
              </CocoaField>
            </CocoaFormRow>
            <CocoaCallout tone="neutral" title="Ratio actual">
              {number(config.pointsPerEur, { maximumFractionDigits: 2 })} puntos × {money(config.pointValueEur, { decimals: "auto" })} ={" "}
              {percent(returnPct, { ratio: true, minimumFractionDigits: 1, maximumFractionDigits: 1 })} de retorno al canje.
            </CocoaCallout>
          </CocoaFormSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaSection
        title="Niveles del programa"
        headingLevel={2}
        meta={tiers.length > 0 ? plural(tiers.length, "nivel", "niveles") : undefined}
        action={
          tiers.length === 0 ? (
            <CocoaButton variant="plain" tone="accent" size="small" onClick={loadTemplate} disabled={saving}>
              {TEMPLATE_LABEL}
            </CocoaButton>
          ) : undefined
        }
      >
        {tiers.length === 0 ? (
          <CocoaState
            kind="empty"
            dashed
            title="La configuración guardada no define niveles todavía."
            message="Carga la plantilla sugerida y ajústala, o publica el programa solo con puntos."
            primaryAction={{ label: TEMPLATE_LABEL, onClick: loadTemplate }}
          />
        ) : (
          <CocoaKpiStrip min={240} aria-label="Niveles del programa">
            {tiers.map((tier) => (
              <CocoaSection
                key={tier.id}
                title={tier.name}
                meta={tierThreshold(tier)}
                action={
                  <CocoaButton variant="plain" tone="accent" size="small" onClick={() => setEditingTier(tierToForm(tier))} disabled={saving}>
                    {ACTIONS.edit}
                  </CocoaButton>
                }
              >
                <div className="cocoa-cluster">
                  <CocoaBadge tone="accent" variant="tinted" uppercase={false}>
                    {multiplierLabel(tier.pointsMultiplier)}
                  </CocoaBadge>
                </div>
                {tier.benefits.length === 0 ? (
                  <CocoaState kind="empty" inline title="Sin beneficios definidos." />
                ) : (
                  <ul className="c22-section__list" aria-label={`Beneficios del nivel ${tier.name}`}>
                    {tier.benefits.map((benefit, index) => (
                      <li key={`${tier.id}-${index}`}>
                        <span>{benefit}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CocoaSection>
            ))}
          </CocoaKpiStrip>
        )}
      </CocoaSection>

      <CocoaCallout tone="neutral" title="Versiones del programa">
        Cada guardado publica una nueva versión del programa y la pantalla muestra siempre la versión vigente.
        {current ? ` Versión vigente publicada el ${date(current.createdAt, "medium")}.` : ""} Los indicadores y la distribución salen de las
        membresías reales. Por ahora el programa y sus membresías se guardan en la memoria del servidor y se pierden al reiniciarlo.
      </CocoaCallout>

      <CocoaDrawer
        open={editingTier !== null}
        onClose={() => setEditingTier(null)}
        title={editingTier ? `Editar nivel «${editingTier.name}»` : "Editar nivel"}
        subtitle="Los cambios de niveles se publican con «Guardar cambios»."
        side="right"
        size="md"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setEditingTier(null)}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={applyTierEdit} disabled={!editingTier || editingTier.name.trim() === ""}>
              {ACTIONS.apply}
            </CocoaButton>
          </>
        }
      >
        {editingTier ? (
          <div className="cocoa-stack" data-gap="3">
            <CocoaFormRow columns={2}>
              <CocoaField label={FIELD_LABELS.name} required fullWidth>
                <CocoaInput value={editingTier.name} onChange={(v) => setEditingTier({ ...editingTier, name: v })} autoComplete="off" />
              </CocoaField>
              <CocoaField label="Estancias mínimas al año" help="0 = nivel de entrada.">
                <CocoaInput type="number" inputMode="numeric" min={0} step={1} value={editingTier.qualifyingStays} onChange={(v) => setEditingTier({ ...editingTier, qualifyingStays: v })} />
              </CocoaField>
              <CocoaField label="Multiplicador de puntos">
                <CocoaInput type="number" inputMode="decimal" min={0} step={0.1} value={editingTier.pointsMultiplier} onChange={(v) => setEditingTier({ ...editingTier, pointsMultiplier: v })} />
              </CocoaField>
            </CocoaFormRow>
            <CocoaField label="Beneficios" help="Uno por línea.">
              <CocoaInput multiline rows={5} value={editingTier.benefits} onChange={(v) => setEditingTier({ ...editingTier, benefits: v })} />
            </CocoaField>
          </div>
        ) : null}
      </CocoaDrawer>

    </CocoaPage>
  );
}
