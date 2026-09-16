// Reglas y recomendaciones — Revenue › Reglas y recomendaciones
// (/revenue/reglas, standalone). Cocoa 22 · ola 5 · lote 5-C (migrated from
// the legacy `.bo-*` screen), archetype «dashboard».
//
// Reads services/revenueApi.ts: fetchRecommendations · generateRecommendations
// · decideRecommendation · fetchPricingRules · createPricingRule. The engine
// combines real occupancy, competitor prices and the pricing rules to suggest
// the base rate per date; nothing is applied without approval and applying
// writes the rate into the grid (deep link per night to RateGridEditorScreen).
//
// Layout: CocoaPage → CocoaKpiStrip (pendientes · aplicadas · reglas activas)
// → «Recomendaciones de BAR» (CocoaTable with Aplicar / Rechazar per row, the
// high-risk rows washed with the warning tone) → «Reglas de precio» (CocoaTable)
// → «Nueva regla» (CocoaFormSection with the create form in a 4-column row).

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  fetchRecommendations,
  generateRecommendations,
  decideRecommendation,
  fetchPricingRules,
  createPricingRule,
  type Recommendation,
  type PricingRule
} from "../services/revenueApi";
import { getActiveProperty } from "../services/activeProperty";
import { ACTIONS, FIELD_LABELS } from "../content/actions";
import { urlForScreen } from "../navigation/nav-tree";
import { date, money, number, percent, plural } from "../lib/format";
import { treeHeaderFor } from "./tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  toneInk,
  type CocoaTableColumn,
  type CocoaTone
} from "../components/cocoa";

// Menu labels of the tree (Revenue › Reglas y recomendaciones), never retyped here.
const HEADER = treeHeaderFor("RevenueRules", { eyebrow: "Revenue", title: "Reglas y recomendaciones" });

function fmtDate(iso: string): string {
  return date(iso, "weekdayShort");
}
// es-ES percentage with an explicit sign («+4,5 %», «−3 %»), never en-US.
function fmtPct(value: number): string {
  return percent(value, { signDisplay: "always", maximumFractionDigits: 1 });
}
/** Deep link to the rate grid (Revenue › Parrilla de tarifas, Tanda 5) on the recommendation's night (the editor reads ?from&to). */
function rateGridHref(iso: string): string {
  const q = new URLSearchParams({ from: iso, to: iso });
  return `${urlForScreen("RateGridEditorScreen") ?? "/revenue/parrilla"}?${q.toString()}`;
}
function statusTone(status: string): CocoaTone {
  if (status === "applied" || status === "approved") return "success";
  if (status === "rejected") return "danger";
  return "warning";
}
const STATUS_ES: Record<string, string> = { pending: "pendiente", approved: "aprobada", applied: "aplicada", rejected: "rechazada" };

// Δ of a recommendation in the AA ink of its sign (never inside a style literal, rule 6).
function deltaStyle(delta: number): CSSProperties {
  return { color: delta >= 0 ? toneInk("success") : toneInk("danger") };
}
// «sin tarifario» under the «—» of a night without a published BAR: caption in secondary.
const captionStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)"
};

const REC_COLUMNS: CocoaTableColumn<Recommendation>[] = [
  {
    key: "targetDate",
    label: FIELD_LABELS.date,
    fit: true,
    // A real link (middle-click, «abrir en pestaña nueva»), not a CocoaButton: on
    // touch `.cocoa-link` grows to the 44 px target by itself (cocoa-base.css, qa#15).
    render: (r) => (
      <a href={rateGridHref(r.targetDate)} className="cocoa-link" title="Abrir esa noche en el editor de tarifas">
        {fmtDate(r.targetDate)}
      </a>
    )
  },
  { key: "occupancy", label: "Ocupación", align: "right", fit: true, hideOnNarrow: true, render: (r) => percent(r.current?.occupancyPct, { maximumFractionDigits: 1 }) },
  {
    key: "bar",
    label: "BAR actual",
    align: "right",
    fit: true,
    render: (r) => {
      // REV-04: `current.bar` is null when no BAR is published for the date
      // (barSource "none"); we show "—", never a fallback price.
      const noBar = r.current?.bar == null;
      return noBar ? (
        <span title="Sin BAR publicado en la parrilla para esta fecha">
          —<span style={captionStyle}>sin tarifario</span>
        </span>
      ) : (
        money(r.current.bar as number)
      );
    }
  },
  { key: "compset", label: "Competencia", align: "right", fit: true, showFrom: "laptop", render: (r) => (r.current?.compsetMedian != null ? money(r.current.compsetMedian) : "—") },
  { key: "recommended", label: "BAR sugerido", align: "right", fit: true, render: (r) => <strong>{r.recommended?.bar != null ? money(r.recommended.bar) : "—"}</strong> },
  {
    key: "delta",
    label: "Δ",
    align: "right",
    fit: true,
    render: (r) => {
      const delta = r.expectedImpact?.deltaPct;
      return delta == null ? "—" : <strong style={deltaStyle(delta)}>{fmtPct(delta)}</strong>;
    }
  },
  { key: "status", label: FIELD_LABELS.status, fit: true, render: (r) => <CocoaBadge tone={statusTone(r.status)}>{STATUS_ES[r.status] ?? r.status}</CocoaBadge> }
];

const RULE_COLUMNS: CocoaTableColumn<PricingRule>[] = [
  { key: "priority", label: "Prioridad", align: "right", fit: true, render: (r) => number(r.priority) },
  { key: "name", label: FIELD_LABELS.name, minWidth: 160, render: (r) => <strong>{r.name}</strong> },
  { key: "occupancy", label: "Ocupación", fit: true, render: (r) => `${percent(r.minOccupancy ?? 0)} – ${percent(r.maxOccupancy ?? 100)}` },
  { key: "adjust", label: "Ajuste", align: "right", fit: true, render: (r) => (r.adjustType === "percent" ? fmtPct(Number(r.adjustValue)) : money(Number(r.adjustValue))) },
  { key: "active", label: FIELD_LABELS.status, fit: true, render: (r) => <CocoaBadge tone={r.active ? "success" : "neutral"}>{r.active ? "Activa" : "Inactiva"}</CocoaBadge> }
];

function RulesSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={3} />
      <CocoaSkeleton variant="card" height={260} />
      <CocoaSkeleton variant="card" height={200} />
    </div>
  );
}

export function RevenueRulesScreen() {
  const property = getActiveProperty();
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: CocoaTone; text: string } | null>(null);
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
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run<T>(fn: () => Promise<T>, ok: string) {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      setNotice({ tone: "success", text: ok });
      await load();
    } catch (e) {
      setNotice({ tone: "danger", text: e instanceof Error ? e.message : "No se pudo completar la acción." });
    } finally {
      setBusy(false);
    }
  }

  const generate = () => void run(() => generateRecommendations(), "Recomendaciones generadas.");
  const addRule = () =>
    void run(
      () =>
        createPricingRule({ name: rName.trim(), minOccupancy: rMin ? Number(rMin) : undefined, maxOccupancy: rMax ? Number(rMax) : undefined, adjustType: "percent", adjustValue: Number(rAdj) }).then(() => {
          setRName("");
          setRMin("");
          setRMax("");
          setRAdj("");
        }),
      "Regla creada."
    );

  const pending = recs.filter((r) => r.status === "pending");
  const applied = recs.filter((r) => r.status === "applied").length;
  const activeRules = rules.filter((r) => r.active).length;
  const shownRecs = recs.slice(0, 30);

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${property.propertyName}`}
      title={HEADER.title}
      subtitle="El motor combina la ocupación real, los precios de la competencia y tus reglas para recomendar la tarifa base por fecha. Cada recomendación explica sus factores y nada se aplica sin aprobación; al aplicarla, la tarifa se escribe en la parrilla."
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void load()} loading={loading && loaded} disabled={loading || busy}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={generate} loading={busy} disabled={busy || loading}>
            {busy ? "Generando…" : "Generar recomendaciones"}
          </CocoaButton>
        </>
      }
      state={!loaded && loading ? "loading" : error ? "error" : "ready"}
      skeleton={<RulesSkeleton />}
      error={{ title: "No se pudo cargar", message: error ?? undefined, onRetry: () => void load() }}
      commands={[
        { id: "revenue-rules-generate", label: "Generar recomendaciones de BAR", run: generate },
        { id: "revenue-rules-refresh", label: "Actualizar reglas y recomendaciones", run: () => void load() }
      ]}
    >
      {notice ? (
        <CocoaCallout tone={notice.tone} role="status">
          {notice.text}
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Resumen de recomendaciones">
        <CocoaKpi label="Pendientes" value={number(pending.length)} caption="por decidir" polarity="neutral" status={pending.length > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Aplicadas" value={number(applied)} caption="escritas en la parrilla" polarity="neutral" status="ok" />
        <CocoaKpi label="Reglas activas" value={number(activeRules)} caption={`de ${plural(rules.length, "regla", "reglas")}`} polarity="neutral" status="ok" />
      </CocoaKpiStrip>

      <CocoaSection
        title="Recomendaciones de BAR"
        meta={plural(recs.length, "recomendación", "recomendaciones")}
        padding={recs.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
        aria-label="Recomendaciones de BAR"
      >
        {recs.length === 0 ? (
          <CocoaState
            kind="empty"
            illustration="box"
            title="Sin recomendaciones"
            message="Pulsa «Generar recomendaciones» para calcular el BAR sugerido por fecha."
            primaryAction={{ label: "Generar recomendaciones", onClick: generate, loading: busy }}
          />
        ) : (
          <CocoaTable
            columns={REC_COLUMNS}
            rows={shownRecs}
            rowKey="id"
            rowTone={(r) => (r.riskLevel === "high" ? "warning" : undefined)}
            rowActions={(r) =>
              r.status === "pending" ? (
                <span className="cocoa-row" data-gap="1" data-wrap="nowrap">
                  <CocoaButton variant="tinted" tone="accent" size="small" disabled={busy} onClick={() => void run(() => decideRecommendation(r.id, "apply"), "Recomendación aplicada al BAR.")}>
                    {ACTIONS.apply}
                  </CocoaButton>
                  <CocoaButton variant="plain" tone="destructive" size="small" disabled={busy} onClick={() => void run(() => decideRecommendation(r.id, "reject"), "Recomendación rechazada.")}>
                    {ACTIONS.reject}
                  </CocoaButton>
                </span>
              ) : null
            }
            caption="Recomendaciones de BAR"
            aria-label="Recomendaciones de BAR"
          />
        )}
      </CocoaSection>

      <CocoaSection
        title="Reglas de precio"
        meta={plural(rules.length, "regla", "reglas")}
        padding={rules.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
        aria-label="Reglas de precio"
      >
        {rules.length === 0 ? (
          <CocoaState kind="empty" inline title="Aún no hay reglas. Añade una para que el motor ajuste el BAR por bandas de ocupación." />
        ) : (
          <CocoaTable columns={RULE_COLUMNS} rows={rules} rowKey="id" density="compact" caption="Reglas de precio" aria-label="Reglas de precio" />
        )}
      </CocoaSection>

      <CocoaFormSection
        title="Nueva regla"
        description="Ajusta la BAR en porcentaje dentro de una banda de ocupación; el motor aplica las reglas por orden de prioridad."
        actions={
          <CocoaButton variant="filled" tone="accent" onClick={addRule} loading={busy} disabled={busy || !rName.trim() || rAdj === ""}>
            Añadir regla
          </CocoaButton>
        }
      >
        <CocoaFormRow columns={4} min={140}>
          <CocoaField label={FIELD_LABELS.name} required>
            <CocoaInput value={rName} onChange={setRName} placeholder="Alta ocupación" disabled={busy} />
          </CocoaField>
          <CocoaField label="Ocupación mínima (%)">
            <CocoaInput value={rMin} onChange={setRMin} inputMode="decimal" placeholder="0" disabled={busy} />
          </CocoaField>
          <CocoaField label="Ocupación máxima (%)">
            <CocoaInput value={rMax} onChange={setRMax} inputMode="decimal" placeholder="100" disabled={busy} />
          </CocoaField>
          <CocoaField label="Ajuste (%)" required help="Positivo sube la BAR; negativo la baja.">
            <CocoaInput value={rAdj} onChange={setRAdj} inputMode="decimal" placeholder="+5" disabled={busy} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>
    </CocoaPage>
  );
}
