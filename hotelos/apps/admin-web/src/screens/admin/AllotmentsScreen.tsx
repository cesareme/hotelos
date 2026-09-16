// Cupos de tour operadores — Recepción › Grupos y eventos › Cupos (/recepcion/grupos/cupos).
//
// Cocoa 22 (ola 3 · lote 3-C, plantilla DashboardAlojado): CocoaPage with the
// three inner views as `tabs` (Pickup y liberación · Cupos contratados · Tour
// operadores; hosted inside GruposEventosTabs the container paints the head
// and HostedHead paints the views), a CocoaKpiStrip, one CocoaSection per
// allotment with CocoaChart.Progress / CocoaStat / CocoaChart.Line for the
// pickup lifecycle, CocoaTable for the two lists and two CocoaDrawers for the
// «Nuevo TT.OO.» and «Nuevo cupo» forms (CocoaFormSection + CocoaField).
// Same endpoints and payloads as before:
//   GET  /organizations/:orgId/tour-operators
//   GET  /properties/:id/allotments · /allotments/pickup-summary?windowDays=60
//   GET  /properties/:id/room-types (inside the allotment drawer)
//   POST /properties/:id/allotments · /allotments/release-expired
//   POST /organizations/:orgId/tour-operators

import { useMemo, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { getActivePropertyId, getActiveOrganizationId } from "../../services/activeProperty";
import {
  createAllotment,
  createTourOperator,
  releaseExpired,
  type Allotment,
  type TourOperator,
  type CreateTourOperatorPayload,
  type PickupSummary,
  type PickupSummaryAllotment
} from "../../services/allotmentApi";
import { useToast } from "../../components/Toast";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance";
import { ALLOTMENTS_INSTRUCTIONS } from "../../content/screen-instructions/allotments";
import { useTabHost } from "../tabs/TabHost";
import { EMPTY, date, dateRange, money, number, percent, plural, time, toNumber } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaDatePicker,
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
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  type CocoaLineSeries,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
const ORG_ID = getActiveOrganizationId();

type AllotmentsView = "pickup" | "allotments" | "operators";

const VIEWS: Array<{ value: AllotmentsView; label: string }> = [
  { value: "pickup", label: "Pickup y liberación" },
  { value: "allotments", label: "Cupos contratados" },
  { value: "operators", label: "Tour operadores" }
];

const CURRENCY_OPTIONS = [
  { value: "EUR", label: "EUR" },
  { value: "GBP", label: "GBP" },
  { value: "USD", label: "USD" }
];

const NEW_OPERATOR_LABEL = "Nuevo TT.OO.";
const NEW_ALLOTMENT_LABEL = "Nuevo cupo";

// Tables inside a section: clip to the radius without creating a scroll container (D26).
const CLIP: CSSProperties = { overflow: "clip" };
// Four compact stats of a lifecycle card (2 columns on phones, 4 on desktop).
const STATS_GRID: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "var(--cocoa-space-3)" };

function allotmentStatus(status: string): { label: string; tone: CocoaTone } {
  if (status === "active") return { label: STATUS_LABELS.active, tone: "success" };
  if (status === "expired") return { label: STATUS_LABELS.expired, tone: "neutral" };
  if (status === "draft") return { label: STATUS_LABELS.draft, tone: "warning" };
  return { label: status, tone: "warning" };
}

const OPERATOR_COLUMNS: CocoaTableColumn<TourOperator>[] = [
  { key: "code", label: "Código", fit: true, render: (t) => <strong className="cocoa-mono">{t.code}</strong> },
  { key: "name", label: "Nombre", minWidth: 160 },
  { key: "taxId", label: "NIF", fit: true, hideOnNarrow: true, render: (t) => t.taxId ?? EMPTY },
  { key: "contactEmail", label: "Correo", showFrom: "laptop", render: (t) => t.contactEmail ?? EMPTY },
  {
    key: "defaultCommissionPct",
    label: "Comisión",
    align: "right",
    fit: true,
    render: (t) => (t.defaultCommissionPct != null ? percent(t.defaultCommissionPct, { maximumFractionDigits: 1 }) : EMPTY)
  },
  { key: "paymentTermsDays", label: "Plazo", align: "right", fit: true, hideOnNarrow: true, render: (t) => plural(t.paymentTermsDays, "día", "días") },
  {
    key: "active",
    label: "Estado",
    fit: true,
    render: (t) => <CocoaBadge tone={t.active ? "success" : "neutral"}>{t.active ? STATUS_LABELS.active : STATUS_LABELS.inactive}</CocoaBadge>
  }
];

type AllotmentRow = Allotment & { operatorName: string };

const ALLOTMENT_COLUMNS: CocoaTableColumn<AllotmentRow>[] = [
  { key: "code", label: "Código", fit: true, render: (a) => <strong className="cocoa-mono">{a.code}</strong> },
  { key: "name", label: "Nombre", minWidth: 160 },
  { key: "operatorName", label: "Turoperador", hideOnNarrow: true },
  { key: "period", label: "Periodo", fit: true, render: (a) => dateRange(a.validFrom, a.validTo) },
  { key: "totalRooms", label: "Hab./día", align: "right", fit: true, render: (a) => number(a.totalRooms) },
  { key: "releaseDays", label: "Liberación", align: "right", fit: true, hideOnNarrow: true, render: (a) => plural(a.releaseDays, "día", "días") },
  {
    key: "contractedRate",
    label: "Tarifa",
    align: "right",
    fit: true,
    showFrom: "laptop",
    render: (a) => (a.contractedRate != null ? money(a.contractedRate, a.currency) : EMPTY)
  },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (a) => {
      const s = allotmentStatus(a.status);
      return <CocoaBadge tone={s.tone}>{s.label}</CocoaBadge>;
    }
  }
];

function AllotmentsSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[6, 6]]} height={280} />
    </div>
  );
}

export function AllotmentsScreen() {
  const hosted = useTabHost() !== null;
  const tos = useApiData<{ items: TourOperator[] }>(`/organizations/${ORG_ID}/tour-operators`, { pollIntervalMs: 0 });
  const allots = useApiData<{ items: Allotment[] }>(`/properties/${PROPERTY_ID}/allotments`, { pollIntervalMs: 60000 });
  const pickup = useApiData<PickupSummary>(`/properties/${PROPERTY_ID}/allotments/pickup-summary?windowDays=60`, { pollIntervalMs: 60000 });

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [toOpen, setToOpen] = useState(false);
  const [allotOpen, setAllotOpen] = useState(false);
  // Each opening remounts the drawer form (fresh fields), as the old conditional dialogs did.
  const [toSession, setToSession] = useState(0);
  const [allotSession, setAllotSession] = useState(0);
  // Only one of the three domains is painted at a time (less scrolling).
  const [view, setView] = useState<AllotmentsView>("pickup");
  const { showToast } = useToast();

  const tourOperators = useMemo(() => toArray<TourOperator>(tos.data?.items), [tos.data]);
  const allotments = useMemo(() => toArray<Allotment>(allots.data?.items), [allots.data]);
  const toName = useMemo(() => new Map(tourOperators.map((t) => [t.id, t.name])), [tourOperators]);
  const allotmentRows = useMemo<AllotmentRow[]>(
    () => allotments.map((a) => ({ ...a, operatorName: a.tourOperatorId ? (toName.get(a.tourOperatorId) ?? a.tourOperatorId) : EMPTY })),
    [allotments, toName]
  );
  const pickupAllotments = useMemo(() => toArray<PickupSummaryAllotment>(pickup.data?.allotments), [pickup.data]);

  function refreshAll() {
    tos.refresh();
    allots.refresh();
    pickup.refresh();
  }

  function openOperatorDrawer() {
    setToSession((n) => n + 1);
    setToOpen(true);
  }

  function openAllotmentDrawer() {
    setAllotSession((n) => n + 1);
    setAllotOpen(true);
  }

  async function release() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await releaseExpired();
      setNotice({
        tone: "success",
        text: `Liberación ejecutada: ${plural(r.releasedDays, "día liberado", "días liberados")} (${plural(r.releasedRooms, "habitación devuelta", "habitaciones devueltas")} al cupo general).`
      });
      allots.refresh();
      pickup.refresh();
    } catch (e) {
      setNotice({ tone: "danger", text: e instanceof Error ? e.message : "No se pudo liberar cuota." });
    } finally {
      setBusy(false);
    }
  }

  const kpis = useMemo(() => {
    const active = allotments.filter((a) => a.status === "active");
    const totalRooms = active.reduce((s, a) => s + a.totalRooms, 0);
    const uniqTos = new Set(active.map((a) => a.tourOperatorId).filter(Boolean));
    return { active: active.length, totalRooms, uniqueTos: uniqTos.size, all: allotments.length };
  }, [allotments]);

  const initialLoading = (allots.loading && !allots.data) || (tos.loading && !tos.data);
  const pageState = initialLoading ? "loading" : allots.error && !allots.data ? "error" : "ready";

  const operatorsReady = !tos.loading && !tos.error && tourOperators.length > 0;
  const allotmentsReady = !allots.loading && !allots.error && allotments.length > 0;
  const noOperators = tourOperators.length === 0;

  return (
    <CocoaPage
      eyebrow="Recepción · Grupos y eventos"
      title="Cupos de tour operadores"
      subtitle={
        hosted
          ? undefined
          : "Cuotas contratadas con tour operadores y bancos de camas. Las no usadas vuelven al cupo general N días antes de la llegada (periodo de liberación)."
      }
      tabs={VIEWS}
      activeTab={view}
      onTabChange={(v) => setView(v as AllotmentsView)}
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll} disabled={busy}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={release} loading={busy}>
            Liberar cuotas vencidas
          </CocoaButton>
          <CocoaButton variant="tinted" tone="accent" size="small" onClick={openOperatorDrawer} disabled={busy}>
            {NEW_OPERATOR_LABEL}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={openAllotmentDrawer} disabled={busy || noOperators}>
            {NEW_ALLOTMENT_LABEL}
          </CocoaButton>
        </>
      }
      state={pageState}
      skeleton={<AllotmentsSkeleton />}
      error={{ title: "No se pudieron cargar los cupos", message: allots.error ?? undefined, onRetry: refreshAll }}
      commands={[
        { id: "allotments-refresh", label: "Actualizar cupos", run: refreshAll },
        { id: "allotments-release", label: "Liberar cuotas vencidas", run: () => void release() },
        { id: "allotments-new-operator", label: NEW_OPERATOR_LABEL, run: openOperatorDrawer },
        { id: "allotments-new", label: NEW_ALLOTMENT_LABEL, run: openAllotmentDrawer }
      ]}
    >
      {notice ? (
        <CocoaCallout tone={notice.tone} role="status">
          {notice.text}
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Indicadores de cupos">
        <CocoaKpi label="Cupos activos" value={number(kpis.active)} caption={plural(kpis.all, "cupo en total", "cupos en total")} polarity="neutral" />
        <CocoaKpi label="Habitaciones contratadas" value={number(kpis.totalRooms)} unit="/ día" caption="En cupos activos" polarity="neutral" />
        <CocoaKpi label="TT.OO. con contrato" value={number(kpis.uniqueTos)} caption="Operadores distintos" polarity="neutral" />
        <CocoaKpi label="Tour operadores" value={number(tourOperators.length)} caption="En la organización" polarity="neutral" />
      </CocoaKpiStrip>

      <CocoaScreenInstructionsCard
        title="Cupos de tour operadores"
        description={ALLOTMENTS_INSTRUCTIONS.whatIsThis}
        steps={ALLOTMENTS_INSTRUCTIONS.howToUse}
        tip={ALLOTMENTS_INSTRUCTIONS.tips?.[0]}
        dismissible
        persistKey="allotments"
      />

      {view === "pickup" ? (
        pickupAllotments.length > 0 ? (
          <CocoaGrid align="start" aria-label="Pickup y ciclo de liberación por cupo">
            {pickupAllotments.map((a) => (
              <CocoaSpan key={a.allotmentId} cols={6} min={320}>
                <AllotmentLifecycleCard allotment={a} />
              </CocoaSpan>
            ))}
          </CocoaGrid>
        ) : (
          <CocoaSection title="Pickup y ciclo de liberación" meta={pickup.data ? `Próximos 60 días · datos a ${time(pickup.data.generatedAt)}` : "Próximos 60 días"}>
            {pickup.loading && !pickup.data ? (
              <CocoaState kind="loading" inline title="Calculando pickup y próximas liberaciones…" />
            ) : pickup.error && !pickup.data ? (
              <CocoaState kind="error" inline title="No se pudo calcular el pickup" message={pickup.error} onRetry={pickup.refresh} />
            ) : (
              <CocoaState
                kind="empty"
                inline
                title="Sin cupos con actividad en los próximos 60 días."
                message="Cuando haya cupos vigentes verás aquí, día a día, lo contratado, lo vendido y lo liberado."
              />
            )}
          </CocoaSection>
        )
      ) : null}

      {view === "operators" ? (
        <CocoaSection
          title="Tour operadores"
          meta={plural(tourOperators.length, "operador", "operadores")}
          action={
            <CocoaButton variant="plain" tone="accent" size="small" onClick={openOperatorDrawer}>
              {NEW_OPERATOR_LABEL}
            </CocoaButton>
          }
          padding={operatorsReady ? "none" : "md"}
          style={CLIP}
        >
          {tos.loading && tourOperators.length === 0 ? (
            <CocoaTable columns={OPERATOR_COLUMNS} rows={[]} loading aria-label="Tour operadores" />
          ) : tos.error && tourOperators.length === 0 ? (
            <CocoaState kind="error" title="No se pudieron cargar los tour operadores" message={tos.error} onRetry={tos.refresh} />
          ) : tourOperators.length === 0 ? (
            <CocoaState
              kind="empty"
              illustration="box"
              title="Sin tour operadores"
              message="Aún no hay tour operadores configurados. Crea uno para empezar a contratar cupos."
              primaryAction={{ label: NEW_OPERATOR_LABEL, onClick: openOperatorDrawer }}
            />
          ) : (
            <CocoaTable columns={OPERATOR_COLUMNS} rows={tourOperators} rowKey="id" caption="Tour operadores" aria-label="Tour operadores" />
          )}
        </CocoaSection>
      ) : null}

      {view === "allotments" ? (
        <CocoaSection
          title="Cupos contratados"
          meta={plural(allotments.length, "cupo", "cupos")}
          action={
            <CocoaButton variant="plain" tone="accent" size="small" onClick={openAllotmentDrawer} disabled={noOperators}>
              {NEW_ALLOTMENT_LABEL}
            </CocoaButton>
          }
          padding={allotmentsReady ? "none" : "md"}
          style={CLIP}
        >
          {allots.loading && allotments.length === 0 ? (
            <CocoaTable columns={ALLOTMENT_COLUMNS} rows={[]} loading aria-label="Cupos contratados" />
          ) : allots.error && allotments.length === 0 ? (
            <CocoaState kind="error" title="No se pudieron cargar los cupos" message={allots.error} onRetry={allots.refresh} />
          ) : allotments.length === 0 ? (
            <CocoaState
              kind="empty"
              illustration="box"
              title="Sin cupos"
              message={noOperators ? "Primero crea un tour operador; después podrás contratar cupos." : "Aún no hay cupos contratados para esta propiedad."}
              primaryAction={noOperators ? { label: NEW_OPERATOR_LABEL, onClick: openOperatorDrawer } : { label: NEW_ALLOTMENT_LABEL, onClick: openAllotmentDrawer }}
            />
          ) : (
            <CocoaTable columns={ALLOTMENT_COLUMNS} rows={allotmentRows} rowKey="id" caption="Cupos contratados" aria-label="Cupos contratados" />
          )}
        </CocoaSection>
      ) : null}

      {/* Both drawers are siblings and both session counters start at 0: prefixed keys keep them distinct (qa#5). */}
      <NewTourOperatorDrawer
        key={`to-${toSession}`}
        open={toOpen}
        onClose={() => setToOpen(false)}
        onCreated={(t) => {
          setToOpen(false);
          tos.refresh();
          showToast(`Tour operador «${t.name}» creado.`, { variant: "success" });
        }}
        onError={(err) => showToast(err, { variant: "error" })}
      />

      <NewAllotmentDrawer
        key={`allot-${allotSession}`}
        open={allotOpen}
        tourOperators={tourOperators}
        onClose={() => setAllotOpen(false)}
        onCreated={(a) => {
          setAllotOpen(false);
          allots.refresh();
          pickup.refresh();
          showToast(`Cupo «${a.name}» creado (${plural(a.totalRooms, "habitación", "habitaciones")} al día).`, { variant: "success" });
        }}
        onError={(err) => showToast(err, { variant: "error" })}
      />
    </CocoaPage>
  );
}

// ───────────────────────────────────────────────────────── Pickup lifecycle

function pickupTone(pct: number): CocoaTone {
  // Industry thresholds: below 40 % low (danger), 40–70 % medium (warning), above 70 % healthy (success).
  return pct >= 70 ? "success" : pct >= 40 ? "warning" : "danger";
}

function pickupLabel(pct: number): string {
  return pct >= 70 ? "Saludable" : pct >= 40 ? "Medio" : pct >= 1 ? "Bajo" : "Sin pickup";
}

function AllotmentLifecycleCard({ allotment }: { allotment: PickupSummaryAllotment }) {
  const tone = pickupTone(allotment.pickupPct);
  const label = pickupLabel(allotment.pickupPct);
  const pct = percent(allotment.pickupPct, { maximumFractionDigits: 0 });
  // Warn when the next release would hand back at least half of the contracted block.
  const upcomingHighRelease = allotment.upcomingReleaseRooms > 0 && allotment.upcomingReleaseRooms >= allotment.totalRooms * 0.5;
  const nextRelease =
    allotment.daysToNextRelease != null && allotment.nextReleaseDate
      ? ` · próxima liberación el ${date(allotment.nextReleaseDate, "dayMonth")} (T−${number(allotment.daysToNextRelease)} d)`
      : "";

  const series: CocoaLineSeries[] = [
    { id: "sold", label: "Vendido", points: allotment.days.map((d) => ({ x: date(d.date, "dayMonth"), y: d.pickedUp })), tone: "success", width: 2 },
    { id: "remaining", label: "Disponible", points: allotment.days.map((d) => ({ x: date(d.date, "dayMonth"), y: d.remaining })), tone: "accent", width: 2 },
    { id: "released", label: "Liberado", points: allotment.days.map((d) => ({ x: date(d.date, "dayMonth"), y: d.released })), tone: "tertiary", width: 1 }
  ];

  return (
    <CocoaSection
      title={`${allotment.code} · ${allotment.name}`}
      meta={
        <CocoaBadge tone={tone} variant="tinted">
          {pct} · {label}
        </CocoaBadge>
      }
    >
      <p className="cocoa-caption">
        Vigencia {dateRange(allotment.validFrom, allotment.validTo)} · {plural(allotment.totalRooms, "habitación", "habitaciones")} al día · liberación{" "}
        {plural(allotment.releaseDays, "día", "días")} antes de la llegada{nextRelease}
      </p>
      <CocoaChart.Progress value={allotment.pickupPct} tone={tone} label="Pickup" valueLabel={`${pct} · ${label}`} aria-label={`Pickup del cupo ${allotment.code}: ${pct}, ${label}`} />
      <div style={STATS_GRID}>
        <CocoaStat label="Contratado" value={number(allotment.totalBlocked)} />
        <CocoaStat label="Vendido" value={number(allotment.totalPickedUp)} tone="success" />
        <CocoaStat label="Liberado" value={number(allotment.totalReleased)} tone="neutral" />
        <CocoaStat label="Disponible" value={number(allotment.totalRemaining)} tone="accent" />
      </div>
      {upcomingHighRelease ? (
        <CocoaCallout tone="warning" title="Liberación importante a la vista">
          Sin pickup adicional, en los próximos {plural(allotment.daysToNextRelease ?? allotment.releaseDays, "día", "días")} se liberarán unas{" "}
          <strong>{plural(allotment.upcomingReleaseRooms, "habitación", "habitaciones")}</strong> al cupo general.
        </CocoaCallout>
      ) : null}
      {allotment.days.length > 0 ? (
        <CocoaChart.Line
          series={series}
          height={140}
          yLabel="Habitaciones"
          aria-label={`Día a día del cupo ${allotment.code}: vendido, disponible y liberado en ${plural(allotment.days.length, "noche", "noches")}`}
        />
      ) : (
        <CocoaState kind="empty" inline title="Sin noches en la ventana de 60 días." />
      )}
    </CocoaSection>
  );
}

// ───────────────────────────────────────────────────────── Drawer: nuevo TT.OO.

type OperatorForm = {
  code: string;
  name: string;
  taxId: string;
  contactEmail: string;
  contactPhone: string;
  defaultCommissionPct: string;
  paymentTermsDays: string;
  currency: string;
  notes: string;
  active: boolean;
};

const EMPTY_OPERATOR: OperatorForm = {
  code: "",
  name: "",
  taxId: "",
  contactEmail: "",
  contactPhone: "",
  defaultCommissionPct: "",
  paymentTermsDays: "30",
  currency: "EUR",
  notes: "",
  active: true
};

function NewTourOperatorDrawer(props: { open: boolean; onClose: () => void; onCreated: (t: TourOperator) => void; onError: (msg: string) => void }) {
  const [form, setForm] = useState<OperatorForm>(EMPTY_OPERATOR);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof OperatorForm>(key: K, value: OperatorForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const missingCode = error !== null && !form.code.trim();
  const missingName = error !== null && !form.name.trim();

  async function submit() {
    setError(null);
    if (!form.code.trim() || !form.name.trim()) {
      setError("Código y nombre son obligatorios.");
      return;
    }
    setSubmitting(true);
    try {
      const payload: CreateTourOperatorPayload = {
        code: form.code.trim(),
        name: form.name.trim(),
        taxId: form.taxId.trim() || undefined,
        contactEmail: form.contactEmail.trim() || undefined,
        contactPhone: form.contactPhone.trim() || undefined,
        defaultCommissionPct: toNumber(form.defaultCommissionPct) ?? undefined,
        paymentTermsDays: toNumber(form.paymentTermsDays) ?? 30,
        currency: form.currency.trim() || "EUR",
        notes: form.notes.trim() || undefined,
        active: form.active
      };
      const created = await createTourOperator(payload);
      props.onCreated(created);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      props.onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <CocoaDrawer
      open={props.open}
      onClose={props.onClose}
      title="Nuevo tour operador"
      subtitle="Da de alta un tour operador con el que vas a contratar cupos."
      side="right"
      size="md"
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={props.onClose} disabled={submitting}>
            {ACTIONS.cancel}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" onClick={() => void submit()} loading={submitting}>
            Crear tour operador
          </CocoaButton>
        </>
      }
    >
      <div className="cocoa-stack" data-gap="3">
        {error ? (
          <CocoaCallout tone="danger" role="alert">
            {error}
          </CocoaCallout>
        ) : null}
        <CocoaFormRow columns={2}>
          <CocoaField label="Código" required help="Ej. TUI, HOTELBEDS" error={missingCode ? "El código es obligatorio." : undefined}>
            <CocoaInput value={form.code} onChange={(v) => update("code", v.toUpperCase())} maxLength={20} placeholder="TUI" autoFocus />
          </CocoaField>
          <CocoaField label="Nombre" required error={missingName ? "El nombre es obligatorio." : undefined}>
            <CocoaInput value={form.name} onChange={(v) => update("name", v)} maxLength={120} placeholder="TUI Group" />
          </CocoaField>
          <CocoaField label="NIF">
            <CocoaInput value={form.taxId} onChange={(v) => update("taxId", v)} placeholder="DE123456789" />
          </CocoaField>
          <CocoaField label="Moneda">
            <CocoaSelect value={form.currency} onChange={(v) => update("currency", v)} options={CURRENCY_OPTIONS} />
          </CocoaField>
          <CocoaField label="Correo de contacto">
            <CocoaInput type="email" inputMode="email" value={form.contactEmail} onChange={(v) => update("contactEmail", v)} placeholder="contratacion@operador.com" />
          </CocoaField>
          <CocoaField label="Teléfono">
            <CocoaInput type="tel" inputMode="tel" value={form.contactPhone} onChange={(v) => update("contactPhone", v)} placeholder="+49 …" />
          </CocoaField>
          <CocoaField label="Comisión por defecto (%)">
            <CocoaInput type="number" inputMode="decimal" min={0} max={100} step={0.1} value={form.defaultCommissionPct} onChange={(v) => update("defaultCommissionPct", v)} placeholder="22" />
          </CocoaField>
          <CocoaField label="Plazo de pago (días)">
            <CocoaInput type="number" inputMode="numeric" min={0} max={365} step={1} value={form.paymentTermsDays} onChange={(v) => update("paymentTermsDays", v)} />
          </CocoaField>
          <CocoaField label="Notas" fullWidth>
            <CocoaInput multiline rows={3} value={form.notes} onChange={(v) => update("notes", v)} placeholder="Condiciones especiales, contactos, etc." />
          </CocoaField>
          <CocoaField label="Activo" inline fullWidth>
            <CocoaSwitch checked={form.active} onChange={(v) => update("active", v)} />
          </CocoaField>
        </CocoaFormRow>
      </div>
    </CocoaDrawer>
  );
}

// ───────────────────────────────────────────────────────── Drawer: nuevo cupo

type RoomType = { id: string; code: string; name: string; baseOccupancy?: number };

type AllotmentType = "soft" | "hard" | "free_sale";
type CounterpartyType = "tour_operator" | "bedbank" | "corporate" | "ota";
type RateType = "net" | "commissionable";

type CreateAllotmentForm = {
  code: string;
  name: string;
  tourOperatorId: string;
  roomTypeId: string;
  validFrom: string;
  validTo: string;
  totalRooms: string;
  releaseDays: string;
  allotmentType: AllotmentType;
  counterpartyType: CounterpartyType;
  rateType: RateType;
  contractedRate: string;
  commissionPct: string;
  currency: string;
  status: "draft" | "active";
  stopSell: boolean;
  notes: string;
};

// Recommended release periods by counterparty (industry, 2026).
const RELEASE_RECOMMENDATIONS: Record<CounterpartyType, { days: number; rationale: string }> = {
  bedbank: { days: 30, rationale: "Hotelbeds, WebBeds, Restel: estándar 30-60 días." },
  tour_operator: { days: 21, rationale: "TUI, Jet2, FTI: estándar 14-21 días en el mercado europeo." },
  corporate: { days: 7, rationale: "Cuentas corporativas: 4-7 días típicos." },
  ota: { days: 3, rationale: "Si firmas un cupo con una OTA (poco habitual): 3-7 días." }
};

const COUNTERPARTY_OPTIONS: Array<{ value: CounterpartyType; label: string }> = [
  { value: "tour_operator", label: "Tour operador (TUI, Jet2, FTI…)" },
  { value: "bedbank", label: "Banco de camas / mayorista (Hotelbeds, Restel…)" },
  { value: "corporate", label: "Cuenta corporativa" },
  { value: "ota", label: "OTA con contrato directo" }
];

const ALLOTMENT_TYPE_OPTIONS: Array<{ value: AllotmentType; label: string }> = [
  { value: "soft", label: "Cupo flexible (con periodo de liberación)" },
  { value: "hard", label: "Cupo garantizado (sin liberación)" },
  { value: "free_sale", label: "Venta libre (sin inventario reservado)" }
];

const RATE_TYPE_OPTIONS: Array<{ value: RateType; label: string }> = [
  { value: "net", label: "Tarifa neta" },
  { value: "commissionable", label: "Tarifa comisionable" }
];

const INITIAL_STATUS_OPTIONS: Array<{ value: "active" | "draft"; label: string }> = [
  { value: "active", label: STATUS_LABELS.active },
  { value: "draft", label: STATUS_LABELS.draft }
];

function todayIso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function releaseHelp(form: CreateAllotmentForm): string {
  if (form.allotmentType === "hard") return "Cupo garantizado: el TT.OO. paga aunque no venda. No hay liberación.";
  if (form.allotmentType === "free_sale") return "Venta libre: vende contra la disponibilidad general. La liberación no aplica.";
  return RELEASE_RECOMMENDATIONS[form.counterpartyType].rationale;
}

function NewAllotmentDrawer(props: {
  open: boolean;
  tourOperators: TourOperator[];
  onClose: () => void;
  onCreated: (a: Allotment) => void;
  onError: (msg: string) => void;
}) {
  const roomTypes = useApiData<RoomType[]>(props.open ? `/properties/${PROPERTY_ID}/room-types` : null, { pollIntervalMs: 0 });
  const roomTypeList = toArray<RoomType>(roomTypes.data);

  const [form, setForm] = useState<CreateAllotmentForm>({
    code: "",
    name: "",
    tourOperatorId: "",
    roomTypeId: "",
    validFrom: todayIso(0),
    validTo: todayIso(180),
    totalRooms: "5",
    releaseDays: "21", // recommended for a European tour operator
    allotmentType: "soft",
    counterpartyType: "tour_operator",
    rateType: "net",
    contractedRate: "",
    commissionPct: "",
    currency: "EUR",
    status: "active",
    stopSell: false,
    notes: ""
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof CreateAllotmentForm>(key: K, value: CreateAllotmentForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const totalRooms = toNumber(form.totalRooms) ?? 0;
  const releaseDays = toNumber(form.releaseDays) ?? 0;
  const operatorOptions = props.tourOperators.filter((t) => t.active).map((t) => ({ value: t.id, label: `${t.code} · ${t.name}` }));
  const roomTypeOptions = roomTypeList.map((r) => ({ value: r.id, label: `${r.code} · ${r.name}` }));

  async function submit() {
    setError(null);

    if (!form.code.trim()) return setError("El código es obligatorio.");
    if (!form.name.trim()) return setError("El nombre es obligatorio.");
    if (!form.roomTypeId) return setError("Selecciona un tipo de habitación.");
    if (!form.validFrom || !form.validTo) return setError("Las fechas son obligatorias.");
    if (form.validTo <= form.validFrom) return setError("La fecha hasta debe ser posterior a la fecha desde.");
    if (totalRooms <= 0) return setError("Las habitaciones por día deben ser mayores que 0.");
    if (releaseDays < 0) return setError("Los días de liberación no pueden ser negativos.");

    // The name falls back to «TT.OO. · tipo de habitación» when left blank.
    const toName = props.tourOperators.find((t) => t.id === form.tourOperatorId)?.name;
    const rtName = roomTypeList.find((r) => r.id === form.roomTypeId)?.name;
    const finalName = form.name.trim() || `${toName ?? "Cupo"} · ${rtName ?? form.code}`;

    if (form.rateType === "commissionable") {
      const pct = Number(form.commissionPct);
      if (!form.commissionPct.trim() || Number.isNaN(pct) || pct < 0 || pct > 100) {
        return setError("Para una tarifa comisionable, indica un porcentaje entre 0 y 100.");
      }
    }

    setSubmitting(true);
    try {
      const payload = {
        code: form.code.trim().toUpperCase(),
        name: finalName,
        tourOperatorId: form.tourOperatorId || undefined,
        roomTypeId: form.roomTypeId,
        validFrom: form.validFrom,
        validTo: form.validTo,
        totalRooms,
        releaseDays: form.allotmentType === "hard" ? 0 : releaseDays,
        allotmentType: form.allotmentType,
        counterpartyType: form.counterpartyType,
        rateType: form.rateType,
        contractedRate: form.contractedRate.trim() ? Number(form.contractedRate) : undefined,
        commissionPct: form.rateType === "commissionable" && form.commissionPct.trim() ? Number(form.commissionPct) : undefined,
        currency: form.currency,
        status: form.status,
        stopSell: form.stopSell,
        notes: form.notes.trim() || undefined
      };
      const created = await createAllotment(payload);
      props.onCreated(created);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      props.onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <CocoaDrawer
      open={props.open}
      onClose={props.onClose}
      title="Nuevo cupo de tour operador"
      subtitle="Contrata bloques de habitaciones para un periodo. Las no usadas vuelven al cupo general N días antes de la llegada."
      side="right"
      size="lg"
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={props.onClose} disabled={submitting}>
            {ACTIONS.cancel}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" onClick={() => void submit()} loading={submitting} disabled={roomTypeList.length === 0}>
            Crear cupo
          </CocoaButton>
        </>
      }
    >
      <div className="cocoa-stack" data-gap="3">
        {error ? (
          <CocoaCallout tone="danger" role="alert">
            {error}
          </CocoaCallout>
        ) : null}

        <CocoaFormSection title="Identificación" columns={2}>
          <CocoaField label="Código" required help="Ej. TUI-VRN-2026">
            <CocoaInput value={form.code} onChange={(v) => update("code", v.toUpperCase())} maxLength={32} placeholder="TUI-2026" autoFocus />
          </CocoaField>
          <CocoaField label="Nombre" required help="Si lo dejas vacío se genera con el TT.OO. y el tipo de habitación">
            <CocoaInput value={form.name} onChange={(v) => update("name", v)} maxLength={120} placeholder="TUI · Habitación doble verano 2026" />
          </CocoaField>
        </CocoaFormSection>

        <CocoaFormSection title="Modelo contractual" columns={2}>
          <CocoaField label="Tipo de contraparte" required help="Define el modelo de liberación y la naturaleza del contrato.">
            <CocoaSelect
              value={form.counterpartyType}
              onChange={(v) => {
                const next = v as CounterpartyType;
                // The recommended release period follows the counterparty.
                const rec = RELEASE_RECOMMENDATIONS[next];
                setForm((f) => ({ ...f, counterpartyType: next, releaseDays: String(rec.days) }));
              }}
              options={COUNTERPARTY_OPTIONS}
            />
          </CocoaField>
          <CocoaField label="Modelo de cupo" required help="Flexible: la liberación devuelve lo no vendido. Garantizado: el TT.OO. se compromete al pago.">
            <CocoaSelect value={form.allotmentType} onChange={(v) => update("allotmentType", v as AllotmentType)} options={ALLOTMENT_TYPE_OPTIONS} />
          </CocoaField>
        </CocoaFormSection>

        <CocoaFormSection title="Asignación" columns={2}>
          <CocoaField label="Tour operador" required>
            <CocoaSelect value={form.tourOperatorId} onChange={(v) => update("tourOperatorId", v)} options={operatorOptions} placeholder="Selecciona un TT.OO." required />
          </CocoaField>
          <CocoaField
            label="Tipo de habitación"
            required
            error={!roomTypes.loading && roomTypeList.length === 0 ? "No hay tipos de habitación. Créalos primero en Configuración → Tipos de habitación." : undefined}
          >
            <CocoaSelect
              value={form.roomTypeId}
              onChange={(v) => update("roomTypeId", v)}
              options={roomTypeOptions}
              placeholder={roomTypes.loading ? "Cargando tipos…" : "Selecciona un tipo"}
              disabled={roomTypes.loading || roomTypeList.length === 0}
              required
            />
          </CocoaField>
        </CocoaFormSection>

        <CocoaFormSection title="Vigencia y capacidad">
          <CocoaFormRow columns={4} min={140}>
            <CocoaField label="Desde" required>
              <CocoaDatePicker value={form.validFrom} onChange={(v) => update("validFrom", v)} required />
            </CocoaField>
            <CocoaField label="Hasta" required help="Máximo 2 años">
              <CocoaDatePicker value={form.validTo} onChange={(v) => update("validTo", v)} min={form.validFrom} required />
            </CocoaField>
            <CocoaField label="Hab./día" required>
              <CocoaInput type="number" inputMode="numeric" min={1} step={1} value={form.totalRooms} onChange={(v) => update("totalRooms", v)} required />
            </CocoaField>
            <CocoaField label="Liberación (días)" help={releaseHelp(form)}>
              <CocoaInput
                type="number"
                inputMode="numeric"
                min={0}
                max={365}
                step={1}
                value={form.releaseDays}
                onChange={(v) => update("releaseDays", v)}
                disabled={form.allotmentType !== "soft"}
              />
            </CocoaField>
          </CocoaFormRow>
          {form.allotmentType === "soft" && releaseDays > 0 && totalRooms > 0 ? (
            <ReleasePreview releaseDays={releaseDays} totalRooms={totalRooms} validFrom={form.validFrom} />
          ) : null}
        </CocoaFormSection>

        <CocoaFormSection title="Tarifa contratada">
          <CocoaFormRow columns={2}>
            <CocoaField label="Modelo de tarifa" required help="Neta: el operador aplica su margen. Comisionable: tarifa pública con un porcentaje de comisión.">
              <CocoaSelect value={form.rateType} onChange={(v) => update("rateType", v as RateType)} options={RATE_TYPE_OPTIONS} />
            </CocoaField>
            {form.rateType === "commissionable" ? (
              <CocoaField label="Comisión (%)" required help="Habitual en TT.OO. europeos: 18-25 %. Corporativo: 8-15 %.">
                <CocoaInput type="number" inputMode="decimal" min={0} max={100} step={0.1} value={form.commissionPct} onChange={(v) => update("commissionPct", v)} placeholder="22" required />
              </CocoaField>
            ) : (
              <CocoaField label="Comisión (%)" help="Tarifa neta: la tarifa contratada es lo que cobras directamente.">
                <CocoaInput value="" onChange={() => undefined} disabled placeholder={EMPTY} />
              </CocoaField>
            )}
          </CocoaFormRow>
          <CocoaFormRow columns={3} min={160}>
            <CocoaField label="Tarifa por noche" help="Opcional. Si la dejas vacía se factura según el plan de tarifas público.">
              <CocoaInput type="number" inputMode="decimal" min={0} step={0.01} value={form.contractedRate} onChange={(v) => update("contractedRate", v)} placeholder="65" />
            </CocoaField>
            <CocoaField label="Moneda">
              <CocoaSelect value={form.currency} onChange={(v) => update("currency", v)} options={CURRENCY_OPTIONS} />
            </CocoaField>
            <CocoaField label="Estado inicial">
              <CocoaSelect value={form.status} onChange={(v) => update("status", v as "draft" | "active")} options={INITIAL_STATUS_OPTIONS} />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>

        <CocoaField label="Notas">
          <CocoaInput multiline rows={3} value={form.notes} onChange={(v) => update("notes", v)} placeholder="Condiciones especiales del contrato, contactos, referencias…" />
        </CocoaField>
      </div>
    </CocoaDrawer>
  );
}

function ReleasePreview(props: { releaseDays: number; totalRooms: number; validFrom: string }) {
  const from = new Date(props.validFrom);
  // For the first night of the block the release happens on arrival − releaseDays.
  const firstReleaseDate = new Date(from.getTime() - props.releaseDays * 86400000);
  const fmt = (d: Date) => date(d, "medium");

  return (
    <CocoaCallout tone="accent" title="Ciclo de vida del cupo (vista previa)">
      <ul className="c22-section__list">
        <li>
          <span>
            Para la primera noche (<strong>{fmt(from)}</strong>), tu cupo de <strong>{plural(props.totalRooms, "habitación", "habitaciones")}</strong> queda bloqueado hasta el{" "}
            <strong>{fmt(firstReleaseDate)}</strong> (día = noche − {plural(props.releaseDays, "día", "días")}).
          </span>
        </li>
        <li>
          <span>Si para esa fecha el TT.OO. no ha vendido todas, lo no vendido vuelve automáticamente al cupo general y queda disponible para venta directa u otros canales.</span>
        </li>
        <li>
          <span>El corte es progresivo por noche: cada noche se libera {plural(props.releaseDays, "día", "días")} antes de su entrada.</span>
        </li>
        <li>
          <span className="cocoa-caption">
            Cuando una reserva del TT.OO. entra en el sistema, descuenta del cupo. Si se cancela después del corte diario, la habitación vuelve al cupo general, no al cupo del operador.
          </span>
        </li>
      </ul>
    </CocoaCallout>
  );
}
