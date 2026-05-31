import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
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
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";
import { useToast } from "../../components/Toast";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaSegmentedControl } from "../../components/cocoa/CocoaSegmentedControl";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance";
import { ALLOTMENTS_INSTRUCTIONS } from "../../content/screen-instructions/allotments";

const PROPERTY_ID = getActivePropertyId();
const ORG_ID = getActiveOrganizationId();

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "2-digit" });
}
function fmtNum(n: number): string {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 }).format(n);
}

type AllotmentsTab = "pickup" | "allotments" | "operators";

export function AllotmentsScreen() {
  const tos = useApiData<{ items: TourOperator[] }>(`/organizations/${ORG_ID}/tour-operators`, { pollIntervalMs: 0 });
  const allots = useApiData<{ items: Allotment[] }>(`/properties/${PROPERTY_ID}/allotments`, { pollIntervalMs: 60000 });
  const pickup = useApiData<PickupSummary>(`/properties/${PROPERTY_ID}/allotments/pickup-summary?windowDays=60`, { pollIntervalMs: 60000 });

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [toOpen, setToOpen] = useState(false);
  const [allotOpen, setAllotOpen] = useState(false);
  // DEV #5 layout declutter — la pantalla mezcla 3 dominios (Pickup, Allotments,
  // Tour Operadores) en card-stack vertical. Tabs reducen el scroll a 1/3.
  const [activeTab, setActiveTab] = useState<AllotmentsTab>("pickup");
  const { showToast } = useToast();

  const tourOperators = tos.data?.items ?? [];
  const allotments = allots.data?.items ?? [];
  const toName = useMemo(() => new Map(tourOperators.map((t) => [t.id, t.name])), [tourOperators]);

  async function release() {
    setBusy(true); setMsg(null);
    try {
      const r = await releaseExpired();
      setMsg(`Release ejecutado: ${r.releasedDays} día(s) liberados (${r.releasedRooms} habitaciones devueltas al pool general).`);
      allots.refresh();
      pickup.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo liberar cuota.");
    } finally { setBusy(false); }
  }

  // KPIs
  const kpis = useMemo(() => {
    const active = allotments.filter((a) => a.status === "active");
    const totalRooms = active.reduce((s, a) => s + a.totalRooms, 0);
    const uniqTos = new Set(active.map((a) => a.tourOperatorId).filter(Boolean));
    return { active: active.length, totalRooms, uniqueTos: uniqTos.size, all: allotments.length };
  }, [allotments]);

  return (
    <CocoaCard variant="bordered" padding="lg" className="bo-card">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-4)" }}>
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--cocoa-space-4)", width: "100%" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-1)", minWidth: 0, flex: "1 1 auto" }}>
          <p style={{ color: "var(--cocoa-label-tertiary)", fontSize: "var(--cocoa-fs-caption)", fontWeight: 600, letterSpacing: "var(--cocoa-tracking-wide)", textTransform: "uppercase", lineHeight: 1.2, margin: 0 }}>Comercial · Distribución</p>
          <h2 style={{ color: "var(--cocoa-label)", fontSize: "var(--cocoa-fs-title-2)", fontWeight: 700, letterSpacing: "var(--cocoa-tracking-tight)", lineHeight: 1.2, margin: 0 }}>Cupos de tour operadores</h2>
          <p style={{ color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-body)", lineHeight: 1.35, margin: 0 }}>
            Cuotas contratadas con TT.OO. (Hotelbeds, TUI, FTI, JetTours…). Las cuotas no usadas se devuelven al pool general
            <strong> N días antes</strong> de la llegada (release period).
          </p>
        </div>
        <div style={{ display: "inline-flex", gap: "var(--cocoa-space-2)", alignItems: "center", flexShrink: 0 }}>
          {busy ? <Spinner size="sm" /> : null}
          <CocoaButton variant="bordered" tone="neutral" onClick={() => { tos.refresh(); allots.refresh(); pickup.refresh(); }} disabled={busy}>↻ Actualizar</CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" disabled={busy} onClick={release}>⤓ Liberar cuotas vencidas</CocoaButton>
          <CocoaButton variant="filled" tone="accent" onClick={() => setToOpen(true)} disabled={busy}>+ Nuevo TT.OO.</CocoaButton>
          <CocoaButton variant="filled" tone="accent" onClick={() => setAllotOpen(true)} disabled={busy || tourOperators.length === 0}>+ Nuevo allotment</CocoaButton>
        </div>
      </header>

      {msg ? <p role="status" aria-live="polite" className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      {/* DEV #5 — KPI "Tour operadores" total y "TT.OO. con contrato" son
          info redundante (ambos cuentan TT.OO. desde ángulos distintos). Los
          dejamos pero la grid sigue siendo de 4 (límite). */}
      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Cupos activos</span><span className="bo-status info">activos</span></div><div className="rev-kpi-value">{kpis.active}</div></article>
        <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Habitaciones contratadas</span><span className="bo-status info">total / día</span></div><div className="rev-kpi-value">{kpis.totalRooms}</div></article>
        <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">TT.OO. con contrato</span><span className="bo-status info">distintos</span></div><div className="rev-kpi-value">{kpis.uniqueTos}</div></article>
        <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Tour operadores</span><span className="bo-status info">org</span></div><div className="rev-kpi-value">{tourOperators.length}</div></article>
      </div>

      {/* DEV #5 — Tabs internas: Pickup (default) / Allotments / Tour operadores.
          Solo una sección a la vez → reduce scroll vertical ~⅔. */}
      <div style={{ display: "flex", alignItems: "center" }}>
        <CocoaSegmentedControl
          value={activeTab}
          onChange={(v) => setActiveTab(v as AllotmentsTab)}
          options={[
            { value: "pickup", label: "Pickup & Release" },
            { value: "allotments", label: "Cupos contratados" },
            { value: "operators", label: "Tour operadores" }
          ]}
          aria-label="Vistas de cupos"
        />
      </div>

      <CocoaScreenInstructionsCard
        title="Cupos de tour operadores"
        description={ALLOTMENTS_INSTRUCTIONS.whatIsThis}
        steps={ALLOTMENTS_INSTRUCTIONS.howToUse}
        tip={ALLOTMENTS_INSTRUCTIONS.tips?.[0]}
        dismissible
        persistKey="allotments"
      />

      {/* PILOT · Pickup & ciclo de release — visualización del estado del cupo día a día */}
      {activeTab === "pickup" ? (
        <PickupLifecycleCard pickup={pickup.data ?? null} loading={pickup.loading} />
      ) : null}

      {activeTab === "operators" ? (
      <CocoaCard variant="bordered" padding="md" className="bo-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--cocoa-space-3)", marginBottom: "var(--cocoa-space-3)" }}>
          <h3 style={{ color: "var(--cocoa-label)", fontSize: "var(--cocoa-fs-title-3)", fontWeight: 600, margin: 0 }}>Tour operadores</h3>
          <div style={{ display: "inline-flex", gap: "var(--cocoa-space-2)", alignItems: "center" }}>
            <span className="bo-chip">{tourOperators.length}</span>
            <CocoaButton variant="filled" tone="accent" onClick={() => setToOpen(true)}>+ Nuevo TT.OO.</CocoaButton>
          </div>
        </div>
        {tos.loading && tourOperators.length === 0 ? <LoadingBlock label="Cargando TT.OO.…" /> : tos.error ? (
          <ErrorState title="No se pudieron cargar los TT.OO." message={typeof tos.error === "string" ? tos.error : (tos.error as Error)?.message} onRetry={() => tos.refresh()} />
        ) : tourOperators.length === 0 ? (
          <EmptyState
            title="Sin TT.OO."
            message="Aún no hay tour operadores configurados. Crea uno para empezar a contratar cupos."
            actions={<CocoaButton variant="filled" tone="accent" onClick={() => setToOpen(true)}>+ Nuevo TT.OO.</CocoaButton>}
          />
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead><tr><th>Code</th><th>Nombre</th><th>NIF/Tax</th><th>Email</th><th>Comisión</th><th>Plazo</th><th>Estado</th></tr></thead>
              <tbody>
                {tourOperators.map((t) => (
                  <tr key={t.id}>
                    <td className="mono"><strong>{t.code}</strong></td>
                    <td>{t.name}</td>
                    <td className="mono">{t.taxId ?? "—"}</td>
                    <td>{t.contactEmail ?? "—"}</td>
                    <td>{t.defaultCommissionPct != null ? `${t.defaultCommissionPct}%` : "—"}</td>
                    <td>{t.paymentTermsDays} d</td>
                    <td><span className={`bo-status ${t.active ? "ok" : "info"}`} style={{ fontSize: 10 }}>{t.active ? "activo" : "inactivo"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CocoaCard>
      ) : null}

      {activeTab === "allotments" ? (
      <CocoaCard variant="bordered" padding="md" className="bo-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--cocoa-space-3)", marginBottom: "var(--cocoa-space-3)" }}>
          <h3 style={{ color: "var(--cocoa-label)", fontSize: "var(--cocoa-fs-title-3)", fontWeight: 600, margin: 0 }}>Allotments contratados</h3>
          <div style={{ display: "inline-flex", gap: "var(--cocoa-space-2)", alignItems: "center" }}>
            <span className="bo-chip">{allotments.length}</span>
            <CocoaButton variant="filled" tone="accent" onClick={() => setAllotOpen(true)} disabled={tourOperators.length === 0}>+ Nuevo cupo</CocoaButton>
          </div>
        </div>
        {allots.loading && allotments.length === 0 ? <LoadingBlock label="Cargando cupos…" /> : allotments.length === 0 ? (
          <EmptyState
            title="Sin cupos"
            message={tourOperators.length === 0 ? "Primero crea un tour operador, luego podrás contratar cupos." : "Aún no hay cupos contratados para esta propiedad."}
            actions={tourOperators.length > 0 ? <CocoaButton variant="filled" tone="accent" onClick={() => setAllotOpen(true)}>+ Nuevo cupo</CocoaButton> : null}
          />
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead><tr><th>Code</th><th>Nombre</th><th>Tour operador</th><th>Periodo</th><th>Hab/día</th><th>Release</th><th>Tarifa</th><th>Estado</th></tr></thead>
              <tbody>
                {allotments.map((a) => (
                  <tr key={a.id}>
                    <td className="mono"><strong>{a.code}</strong></td>
                    <td>{a.name}</td>
                    <td>{a.tourOperatorId ? toName.get(a.tourOperatorId) ?? a.tourOperatorId : "—"}</td>
                    <td>{fmtDate(a.validFrom)} → {fmtDate(a.validTo)}</td>
                    <td>{a.totalRooms}</td>
                    <td>{a.releaseDays} d</td>
                    <td>{a.contractedRate != null ? `${fmtNum(a.contractedRate)} ${a.currency}` : "—"}</td>
                    <td><span className={`bo-status ${a.status === "active" ? "ok" : a.status === "expired" ? "info" : "warn"}`} style={{ fontSize: 10 }}>{a.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CocoaCard>
      ) : null}

      {toOpen ? (
        <NewTourOperatorDialog
          onClose={() => setToOpen(false)}
          onCreated={(t) => {
            setToOpen(false);
            tos.refresh();
            showToast(`Tour operador «${t.name}» creado.`, { variant: "success" });
          }}
          onError={(err) => showToast(err, { variant: "error" })}
        />
      ) : null}

      {allotOpen ? (
        <NewAllotmentDialog
          tourOperators={tourOperators}
          onClose={() => setAllotOpen(false)}
          onCreated={(a) => {
            setAllotOpen(false);
            allots.refresh();
            pickup.refresh();
            showToast(`Cupo «${a.name}» creado (${a.totalRooms} hab/día).`, { variant: "success" });
          }}
          onError={(err) => showToast(err, { variant: "error" })}
        />
      ) : null}
      </div>
    </CocoaCard>
  );
}

// ───────────────────────────────────────────────────────── Dialog crear TT.OO.

function NewTourOperatorDialog(props: {
  onClose: () => void;
  onCreated: (t: TourOperator) => void;
  onError: (msg: string) => void;
}) {
  const [form, setForm] = useState<CreateTourOperatorPayload>({
    code: "",
    name: "",
    taxId: "",
    contactEmail: "",
    contactPhone: "",
    defaultCommissionPct: undefined,
    paymentTermsDays: 30,
    currency: "EUR",
    notes: "",
    active: true
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof CreateTourOperatorPayload>(key: K, value: CreateTourOperatorPayload[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.code.trim() || !form.name.trim()) {
      setError("Código y nombre son obligatorios.");
      return;
    }
    setSubmitting(true);
    try {
      const cleanPayload: CreateTourOperatorPayload = {
        code: form.code.trim(),
        name: form.name.trim(),
        taxId: form.taxId?.trim() || undefined,
        contactEmail: form.contactEmail?.trim() || undefined,
        contactPhone: form.contactPhone?.trim() || undefined,
        defaultCommissionPct: form.defaultCommissionPct,
        paymentTermsDays: form.paymentTermsDays ?? 30,
        currency: form.currency?.trim() || "EUR",
        notes: form.notes?.trim() || undefined,
        active: form.active ?? true
      };
      const created = await createTourOperator(cleanPayload);
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
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-to-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16
      }}
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") props.onClose(); }}
    >
      <form
        onSubmit={submit}
        className="bo-card"
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: "90vh",
          overflow: "auto",
          background: "var(--surface-1, var(--surface))",
          padding: "var(--space-5, 20px)",
          borderRadius: "var(--radius-md, 12px)",
          display: "flex",
          flexDirection: "column",
          gap: 12
        }}
      >
        <div className="bo-card-head" style={{ marginBottom: 4 }}>
          <h3 id="new-to-title" style={{ margin: 0 }}>Nuevo tour operador</h3>
          <button type="button" onClick={props.onClose} aria-label="Cerrar" style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "var(--ink)" }}>×</button>
        </div>

        <p className="bo-muted" style={{ margin: 0, fontSize: 13 }}>
          Da de alta un tour operador con el que vas a contratar cupos.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 4 }}>
          <Field label="Código *" hint="Ej. TUI, HOTELBEDS">
            <input
              type="text"
              required
              maxLength={20}
              value={form.code}
              onChange={(e) => update("code", e.target.value.toUpperCase())}
              style={inputStyle}
              placeholder="TUI"
              autoFocus
            />
          </Field>
          <Field label="Nombre *">
            <input
              type="text"
              required
              maxLength={120}
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              style={inputStyle}
              placeholder="TUI Group"
            />
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="NIF / Tax ID">
            <input
              type="text"
              value={form.taxId ?? ""}
              onChange={(e) => update("taxId", e.target.value)}
              style={inputStyle}
              placeholder="DE123456789"
            />
          </Field>
          <Field label="Moneda">
            <select
              value={form.currency ?? "EUR"}
              onChange={(e) => update("currency", e.target.value)}
              style={inputStyle}
            >
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
              <option value="USD">USD</option>
            </select>
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Email de contacto">
            <input
              type="email"
              inputMode="email"
              value={form.contactEmail ?? ""}
              onChange={(e) => update("contactEmail", e.target.value)}
              style={inputStyle}
              placeholder="contracting@tui.com"
            />
          </Field>
          <Field label="Teléfono">
            <input
              type="tel"
              inputMode="tel"
              value={form.contactPhone ?? ""}
              onChange={(e) => update("contactPhone", e.target.value)}
              style={inputStyle}
              placeholder="+49 ..."
            />
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Comisión por defecto (%)">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step={0.1}
              value={form.defaultCommissionPct ?? ""}
              onChange={(e) => update("defaultCommissionPct", e.target.value === "" ? undefined : Number(e.target.value))}
              style={inputStyle}
              placeholder="22"
            />
          </Field>
          <Field label="Plazo de pago (días)">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={365}
              step={1}
              value={form.paymentTermsDays ?? 30}
              onChange={(e) => update("paymentTermsDays", Number(e.target.value))}
              style={inputStyle}
            />
          </Field>
        </div>

        <Field label="Notas">
          <textarea
            value={form.notes ?? ""}
            onChange={(e) => update("notes", e.target.value)}
            style={{ ...inputStyle, minHeight: 60, resize: "vertical" }}
            placeholder="Condiciones especiales, contactos, etc."
          />
        </Field>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--ink)" }}>
          <input
            type="checkbox"
            checked={form.active ?? true}
            onChange={(e) => update("active", e.target.checked)}
          />
          Activo
        </label>

        {error ? (
          <p className="bo-status error" style={{ textTransform: "none", margin: 0 }}>{error}</p>
        ) : null}

        <div className="bo-row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
          <button type="button" onClick={props.onClose} disabled={submitting}>Cancelar</button>
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? "Creando…" : "Crear tour operador"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ───────────────────────────────────────────────────────── Dialog crear Allotment

type RoomType = { id: string; code: string; name: string; baseOccupancy?: number };

type CreateAllotmentForm = {
  code: string;
  name: string;
  tourOperatorId: string;
  roomTypeId: string;
  validFrom: string;
  validTo: string;
  totalRooms: number;
  releaseDays: number;
  // Industria · campos B2B (research-backed: Mews/Opera/Protel/Cloudbeds)
  allotmentType: "soft" | "hard" | "free_sale";
  counterpartyType: "tour_operator" | "bedbank" | "corporate" | "ota";
  rateType: "net" | "commissionable";
  contractedRate: string;
  commissionPct: string;
  currency: string;
  status: "draft" | "active";
  stopSell: boolean;
  notes: string;
};

// Release periods recomendados por tipo de contraparte (industria 2026)
const RELEASE_RECOMMENDATIONS: Record<CreateAllotmentForm["counterpartyType"], { days: number; rationale: string }> = {
  bedbank: { days: 30, rationale: "Hotelbeds, WebBeds, Restel: estándar 30-60 días." },
  tour_operator: { days: 21, rationale: "TUI, Jet2, FTI: estándar 14-21 días en mercado europeo." },
  corporate: { days: 7, rationale: "Cuentas corporativas: 4-7 días típicos." },
  ota: { days: 3, rationale: "Si firmas allotment con OTA (raro): 3-7 días." }
};

function todayIso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function NewAllotmentDialog(props: {
  tourOperators: TourOperator[];
  onClose: () => void;
  onCreated: (a: Allotment) => void;
  onError: (msg: string) => void;
}) {
  const roomTypes = useApiData<{ items: RoomType[] }>(`/properties/${PROPERTY_ID}/room-types`, { pollIntervalMs: 0 });
  const roomTypeList = roomTypes.data?.items ?? [];

  const [form, setForm] = useState<CreateAllotmentForm>({
    code: "",
    name: "",
    tourOperatorId: "",
    roomTypeId: "",
    validFrom: todayIso(0),
    validTo: todayIso(180),
    totalRooms: 5,
    releaseDays: 21, // recomendado para TT.OO. europeo
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Validaciones locales
    if (!form.code.trim()) return setError("El código es obligatorio.");
    if (!form.name.trim()) return setError("El nombre es obligatorio.");
    if (!form.roomTypeId) return setError("Selecciona un tipo de habitación.");
    if (!form.validFrom || !form.validTo) return setError("Las fechas son obligatorias.");
    if (form.validTo <= form.validFrom) return setError("La fecha hasta debe ser posterior a la fecha desde.");
    if (form.totalRooms <= 0) return setError("Las habitaciones por día deben ser > 0.");
    if (form.releaseDays < 0) return setError("Los días de release no pueden ser negativos.");

    // Auto-completa nombre si está vacío con el TT.OO. + roomType
    const toName = props.tourOperators.find((t) => t.id === form.tourOperatorId)?.name;
    const rtName = roomTypeList.find((r) => r.id === form.roomTypeId)?.name;
    const finalName = form.name.trim() || `${toName ?? "Cupo"} · ${rtName ?? form.code}`;

    // Validación tarifa comisionable
    if (form.rateType === "commissionable") {
      const pct = Number(form.commissionPct);
      if (!form.commissionPct.trim() || Number.isNaN(pct) || pct < 0 || pct > 100) {
        return setError("Para tarifa comisionable, indica un porcentaje entre 0 y 100.");
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
        totalRooms: form.totalRooms,
        releaseDays: form.allotmentType === "hard" ? 0 : form.releaseDays,
        allotmentType: form.allotmentType,
        counterpartyType: form.counterpartyType,
        rateType: form.rateType,
        contractedRate: form.contractedRate.trim() ? Number(form.contractedRate) : undefined,
        commissionPct: form.rateType === "commissionable" && form.commissionPct.trim()
          ? Number(form.commissionPct)
          : undefined,
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
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-allot-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16
      }}
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") props.onClose(); }}
    >
      <form
        onSubmit={submit}
        className="bo-card"
        style={{
          width: "100%",
          maxWidth: 680,
          maxHeight: "92vh",
          overflow: "auto",
          background: "var(--surface-1, var(--surface))",
          padding: "var(--space-5, 20px)",
          borderRadius: "var(--radius-md, 12px)",
          display: "flex",
          flexDirection: "column",
          gap: 12
        }}
      >
        <div className="bo-card-head" style={{ marginBottom: 4 }}>
          <div>
            <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11, margin: 0 }}>Comercial · Distribución</p>
            <h3 id="new-allot-title" style={{ margin: "2px 0 0 0" }}>Nuevo cupo de tour operador</h3>
          </div>
          <button type="button" onClick={props.onClose} aria-label="Cerrar" style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "var(--ink)" }}>×</button>
        </div>

        <p className="bo-muted" style={{ margin: 0, fontSize: 13 }}>
          Contrata bloques de habitaciones para un periodo. Las no usadas vuelven al pool general
          <strong> N días antes</strong> de la llegada.
        </p>

        {/* Identificación */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Identificación</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
            <Field label="Código *" hint="Ej. TUI-VRN-2026">
              <input
                type="text"
                required
                maxLength={32}
                value={form.code}
                onChange={(e) => update("code", e.target.value.toUpperCase())}
                style={inputStyle}
                placeholder="TUI-2026"
                autoFocus
              />
            </Field>
            <Field label="Nombre" hint="Si lo dejas vacío se autogenera con TT.OO. + tipo de habitación">
              <input
                type="text"
                maxLength={120}
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                style={inputStyle}
                placeholder="TUI · Habitación doble verano 2026"
              />
            </Field>
          </div>
        </fieldset>

        {/* Modelo contractual */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Modelo contractual</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field
              label="Tipo de contraparte *"
              hint="Define el modelo de release y la naturaleza del contrato."
            >
              <select
                value={form.counterpartyType}
                onChange={(e) => {
                  const v = e.target.value as CreateAllotmentForm["counterpartyType"];
                  // Auto-ajusta releaseDays al recomendado del tipo
                  const rec = RELEASE_RECOMMENDATIONS[v];
                  setForm((f) => ({ ...f, counterpartyType: v, releaseDays: rec.days }));
                }}
                style={inputStyle}
              >
                <option value="tour_operator">Tour operador (TUI, Jet2, FTI…)</option>
                <option value="bedbank">Bedbank / wholesaler (Hotelbeds, Restel…)</option>
                <option value="corporate">Cuenta corporativa</option>
                <option value="ota">OTA con contrato directo</option>
              </select>
            </Field>
            <Field
              label="Modelo de cupo *"
              hint="Soft = release devuelve no vendido. Hard = TT.OO. compromete pago (commit)."
            >
              <select
                value={form.allotmentType}
                onChange={(e) => update("allotmentType", e.target.value as CreateAllotmentForm["allotmentType"])}
                style={inputStyle}
              >
                <option value="soft">Soft allotment (con release period)</option>
                <option value="hard">Hard allotment / commit (sin release)</option>
                <option value="free_sale">Free sale (sin inventario reservado)</option>
              </select>
            </Field>
          </div>
        </fieldset>

        {/* Asignación */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Asignación</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Tour operador *">
              <select
                required
                value={form.tourOperatorId}
                onChange={(e) => update("tourOperatorId", e.target.value)}
                style={inputStyle}
              >
                <option value="" disabled>Selecciona un TT.OO.</option>
                {props.tourOperators.filter((t) => t.active).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.code} · {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tipo de habitación *">
              {roomTypes.loading ? (
                <span className="bo-muted" style={{ fontSize: 13 }}>Cargando tipos…</span>
              ) : roomTypeList.length === 0 ? (
                <span className="bo-status warn" style={{ fontSize: 12, textTransform: "none" }}>
                  No hay tipos de habitación. Créalos primero en Configuración → Tipos de habitación.
                </span>
              ) : (
                <select
                  required
                  value={form.roomTypeId}
                  onChange={(e) => update("roomTypeId", e.target.value)}
                  style={inputStyle}
                >
                  <option value="" disabled>Selecciona un tipo</option>
                  {roomTypeList.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.code} · {r.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        </fieldset>

        {/* Vigencia + capacidad */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Vigencia y capacidad</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
            <Field label="Desde *">
              <input
                type="date"
                required
                value={form.validFrom}
                onChange={(e) => update("validFrom", e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="Hasta *" hint="Máx. 2 años">
              <input
                type="date"
                required
                value={form.validTo}
                onChange={(e) => update("validTo", e.target.value)}
                min={form.validFrom}
                style={inputStyle}
              />
            </Field>
            <Field label="Hab/día *">
              <input
                type="number"
                inputMode="numeric"
                required
                min={1}
                step={1}
                value={form.totalRooms}
                onChange={(e) => update("totalRooms", Number(e.target.value))}
                style={inputStyle}
              />
            </Field>
            <Field
              label="Release (días)"
              hint={form.allotmentType === "hard"
                ? "Hard allotment: TT.OO. paga aunque no venda. No hay release."
                : form.allotmentType === "free_sale"
                ? "Free sale: vende contra disponibilidad general. Release N/A."
                : RELEASE_RECOMMENDATIONS[form.counterpartyType].rationale}
            >
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={365}
                step={1}
                value={form.releaseDays}
                onChange={(e) => update("releaseDays", Number(e.target.value))}
                disabled={form.allotmentType !== "soft"}
                style={{
                  ...inputStyle,
                  opacity: form.allotmentType !== "soft" ? 0.5 : 1,
                  cursor: form.allotmentType !== "soft" ? "not-allowed" : "text"
                }}
              />
            </Field>
          </div>

          {/* Preview en vivo del ciclo release */}
          {form.allotmentType === "soft" && form.releaseDays > 0 && form.totalRooms > 0 ? (
            <ReleasePreview
              releaseDays={form.releaseDays}
              totalRooms={form.totalRooms}
              validFrom={form.validFrom}
              counterpartyType={form.counterpartyType}
            />
          ) : null}
        </fieldset>

        {/* Tarifa */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Tarifa contratada</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <Field
              label="Modelo de tarifa *"
              hint="Net: el operador aplica su markup. Comisionable: tarifa pública con % comisión."
            >
              <select
                value={form.rateType}
                onChange={(e) => update("rateType", e.target.value as CreateAllotmentForm["rateType"])}
                style={inputStyle}
              >
                <option value="net">Tarifa neta (net rate)</option>
                <option value="commissionable">Tarifa comisionable</option>
              </select>
            </Field>
            {form.rateType === "commissionable" ? (
              <Field label="Comisión (%) *" hint="Típico TT.OO. europeo: 18-25%. Corporate: 8-15%.">
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step={0.1}
                  required
                  value={form.commissionPct}
                  onChange={(e) => update("commissionPct", e.target.value)}
                  style={inputStyle}
                  placeholder="22"
                />
              </Field>
            ) : (
              <Field label="" hint="Net rate: la tarifa contratada es lo que cobras directamente.">
                <input type="text" disabled style={{ ...inputStyle, opacity: 0.5 }} placeholder="—" />
              </Field>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
            <Field label="Tarifa /noche" hint="Opcional. Si la dejas vacía se factura según rate plan público.">
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step={0.01}
                value={form.contractedRate}
                onChange={(e) => update("contractedRate", e.target.value)}
                style={inputStyle}
                placeholder="65.00"
              />
            </Field>
            <Field label="Moneda">
              <select
                value={form.currency}
                onChange={(e) => update("currency", e.target.value)}
                style={inputStyle}
              >
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="USD">USD</option>
              </select>
            </Field>
            <Field label="Estado inicial">
              <select
                value={form.status}
                onChange={(e) => update("status", e.target.value as "draft" | "active")}
                style={inputStyle}
              >
                <option value="active">Activo</option>
                <option value="draft">Borrador</option>
              </select>
            </Field>
          </div>
        </fieldset>

        <Field label="Notas">
          <textarea
            value={form.notes}
            onChange={(e) => update("notes", e.target.value)}
            style={{ ...inputStyle, minHeight: 60, resize: "vertical" }}
            placeholder="Condiciones especiales del contrato, contactos, referencias…"
          />
        </Field>

        {error ? (
          <p className="bo-status error" style={{ textTransform: "none", margin: 0 }}>{error}</p>
        ) : null}

        <div className="bo-row" style={{ gap: 8, justifyContent: "space-between", marginTop: 8 }}>
          <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>
            * Campos obligatorios
          </p>
          <div className="bo-row" style={{ gap: 8 }}>
            <button type="button" onClick={props.onClose} disabled={submitting}>Cancelar</button>
            <button type="submit" className="primary" disabled={submitting || roomTypeList.length === 0}>
              {submitting ? "Creando…" : "Crear cupo"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

// ───────────────────────────────────────────────────────── Estilos compartidos

const fieldsetStyle: React.CSSProperties = {
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "var(--radius-sm, 6px)",
  padding: 12,
  margin: 0
};

const legendStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-soft, #555)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  padding: "0 6px"
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--border, #d1d5db)",
  borderRadius: "var(--radius-sm, 6px)",
  background: "var(--surface, white)",
  color: "var(--ink, #1a1a1a)",
  fontSize: 14,
  fontFamily: "inherit"
};

function ReleasePreview(props: {
  releaseDays: number;
  totalRooms: number;
  validFrom: string;
  counterpartyType: CreateAllotmentForm["counterpartyType"];
}) {
  const from = new Date(props.validFrom);
  // Para la primera noche del cupo, el release ocurre el día: arrival - releaseDays
  const firstNight = props.validFrom;
  const firstReleaseDate = new Date(from.getTime() - props.releaseDays * 86400000);
  const fmt = (d: Date) => d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "2-digit" });

  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        borderRadius: "var(--radius-sm, 6px)",
        background: "var(--surface-2, rgba(13, 138, 95, 0.06))",
        borderLeft: "3px solid var(--ok, #0d8a5f)",
        fontSize: 13
      }}
    >
      <strong style={{ color: "var(--ink)" }}>📅 Ciclo de vida del cupo (preview)</strong>
      <ul style={{ margin: "8px 0 0 0", paddingLeft: 18, color: "var(--ink-soft, #555)", lineHeight: 1.6 }}>
        <li>
          Para la primera noche (<strong>{fmt(from)}</strong>), tu cupo de <strong>{props.totalRooms} habs</strong> queda bloqueado hasta el
          {" "}
          <strong>{fmt(firstReleaseDate)}</strong>
          {" "}(día = <strong>noche − {props.releaseDays} días</strong>).
        </li>
        <li>
          Si para esa fecha el TT.OO. no ha vendido todas, lo no vendido vuelve automáticamente al <strong>pool general</strong>{" "}
          y queda disponible para venta directa u otros canales.
        </li>
        <li>
          El proceso aplica <strong>rolling cut-off por noche</strong>: cada noche se libera <strong>{props.releaseDays} días</strong> antes
          de su check-in (patrón Opera / Protel).
        </li>
        <li className="bo-muted" style={{ fontSize: 12 }}>
          Cuando una reserva del TT.OO. entra en el sistema, decrementa el cupo. Cuando se cancela, devuelve al pool (NO al cupo) si ya pasó el corte diario.
        </li>
      </ul>
    </div>
  );
}

function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--ink)" }}>
      <span style={{ fontWeight: 500 }}>{props.label}</span>
      {props.children}
      {props.hint ? <span className="bo-muted" style={{ fontSize: 11 }}>{props.hint}</span> : null}
    </label>
  );
}

// ─────────────────────────────────────────────── Pickup lifecycle visualization

function PickupLifecycleCard(props: { pickup: PickupSummary | null; loading: boolean }) {
  if (props.loading && !props.pickup) {
    return (
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Pickup &amp; ciclo de release · próximos 60 días</h3>
        </div>
        <LoadingBlock label="Calculando pickup y próximas liberaciones…" />
      </article>
    );
  }
  const allotments = props.pickup?.allotments ?? [];
  if (allotments.length === 0) {
    return null; // Si no hay cupos, no mostramos esta sección (KPIs ya lo dicen)
  }

  return (
    <article className="bo-card" style={{ background: "var(--surface)" }}>
      <div className="bo-card-head">
        <div>
          <h3 style={{ color: "var(--ink)", margin: 0 }}>Pickup &amp; ciclo de release</h3>
          <p className="bo-muted" style={{ margin: "4px 0 0 0", fontSize: 12, textTransform: "none" }}>
            Próximos 60 días · Estado actual del cupo día a día (blocked / picked-up / released).
            El scheduler libera cada día las habs cuyo release period haya vencido.
          </p>
        </div>
        <span className="bo-chip">{allotments.length} cupos</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
        {allotments.map((a) => (
          <AllotmentLifecycleRow key={a.allotmentId} allotment={a} />
        ))}
      </div>
    </article>
  );
}

function AllotmentLifecycleRow({ allotment }: { allotment: PickupSummaryAllotment }) {
  // Color por nivel de pickup (industria: bajo <40% rojo, medio 40-70% ámbar, bueno >70% verde)
  const pickupColor = allotment.pickupPct >= 70 ? "var(--ok, #0d8a5f)"
    : allotment.pickupPct >= 40 ? "var(--warn, #d97706)"
    : "var(--danger, #dc2626)";
  const pickupLabel = allotment.pickupPct >= 70 ? "Saludable"
    : allotment.pickupPct >= 40 ? "Medio"
    : allotment.pickupPct >= 1 ? "Bajo"
    : "Sin pickup";

  // Alerta si el próximo release liberará un volumen significativo
  const upcomingHighRelease = allotment.upcomingReleaseRooms >= allotment.totalRooms * 0.5;

  return (
    <div
      style={{
        padding: 12,
        borderRadius: "var(--radius-sm, 6px)",
        background: "var(--surface-1, var(--surface))",
        border: "1px solid var(--border, rgba(0,0,0,0.06))"
      }}
    >
      {/* Header: code · name · pickup% */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 auto" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <strong style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 13 }}>{allotment.code}</strong>
            <span style={{ color: "var(--ink)", fontSize: 14 }}>{allotment.name}</span>
          </div>
          <p className="bo-muted" style={{ margin: "2px 0 0 0", fontSize: 12 }}>
            Vigencia: {new Date(allotment.validFrom).toLocaleDateString("es-ES")} → {new Date(allotment.validTo).toLocaleDateString("es-ES")} · {allotment.totalRooms} hab/día contratadas · release T−{allotment.releaseDays}d
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          <span style={{
            display: "inline-block",
            padding: "3px 8px",
            borderRadius: 999,
            background: pickupColor,
            color: "white",
            fontSize: 12,
            fontWeight: 600
          }}>
            {allotment.pickupPct}% pickup · {pickupLabel}
          </span>
          {allotment.daysToNextRelease != null && allotment.nextReleaseDate ? (
            <span className="bo-muted" style={{ fontSize: 11 }}>
              Próx. release: T−{allotment.daysToNextRelease}d ({new Date(allotment.nextReleaseDate).toLocaleDateString("es-ES", { day: "2-digit", month: "short" })})
            </span>
          ) : null}
        </div>
      </div>

      {/* Stats compactas */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 8 }}>
        <Stat label="Contratado" value={allotment.totalBlocked} color="var(--ink, #1a1a1a)" />
        <Stat label="Vendido" value={allotment.totalPickedUp} color="var(--ok, #0d8a5f)" />
        <Stat label="Liberado" value={allotment.totalReleased} color="var(--ink-soft, #888)" />
        <Stat label="Disponible" value={allotment.totalRemaining} color="var(--accent, #0d8a5f)" />
      </div>

      {/* Alerta de próxima liberación significativa */}
      {upcomingHighRelease && allotment.upcomingReleaseRooms > 0 ? (
        <div style={{
          padding: "8px 10px",
          borderRadius: "var(--radius-sm, 6px)",
          background: "rgba(217, 119, 6, 0.1)",
          borderLeft: "3px solid var(--warn, #d97706)",
          fontSize: 12,
          marginBottom: 8,
          color: "var(--ink)"
        }}>
          ⚠️ Sin pickup adicional, en los próximos {allotment.daysToNextRelease ?? allotment.releaseDays} días se liberarán
          {" "}<strong>~{allotment.upcomingReleaseRooms} habitaciones</strong> al pool general.
        </div>
      ) : null}

      {/* Barra diaria stacked (picked-up + released + remaining) */}
      {allotment.days.length > 0 ? (
        <div>
          <p className="bo-muted" style={{ fontSize: 11, margin: "0 0 4px 0", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Día a día · {allotment.days.length} noches
          </p>
          <div style={{
            display: "flex",
            gap: 1,
            alignItems: "flex-end",
            height: 60,
            background: "var(--surface-2, rgba(0,0,0,0.03))",
            padding: 4,
            borderRadius: 4,
            overflow: "auto"
          }}>
            {allotment.days.map((d) => {
              const total = Math.max(1, d.blocked);
              const pkH = Math.round((d.pickedUp / total) * 52);
              const rlH = Math.round((d.released / total) * 52);
              const rmH = Math.round((d.remaining / total) * 52);
              return (
                <div
                  key={d.date}
                  title={`${new Date(d.date).toLocaleDateString("es-ES")}\nContratado: ${d.blocked}\nVendido: ${d.pickedUp} (${d.pickupPct}%)\nLiberado: ${d.released}\nDisponible: ${d.remaining}`}
                  style={{
                    minWidth: 6,
                    flex: "1 1 auto",
                    height: "100%",
                    display: "flex",
                    flexDirection: "column-reverse",
                    cursor: "help"
                  }}
                >
                  <div style={{ height: pkH, background: "var(--ok, #0d8a5f)" }} />
                  <div style={{ height: rlH, background: "var(--ink-soft, #888)", opacity: 0.4 }} />
                  <div style={{ height: rmH, background: "var(--accent, #0d8a5f)", opacity: 0.25 }} />
                </div>
              );
            })}
          </div>
          <div className="bo-row" style={{ gap: 12, marginTop: 6, fontSize: 11 }}>
            <Legend color="var(--ok, #0d8a5f)" label="Vendido" />
            <Legend color="rgba(13, 138, 95, 0.25)" label="Disponible" />
            <Legend color="rgba(136, 136, 136, 0.4)" label="Liberado al pool" />
            <span className="bo-muted" style={{ marginLeft: "auto" }}>Hover para ver el detalle del día</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      padding: "6px 10px",
      borderRadius: 4,
      background: "var(--surface-2, rgba(0,0,0,0.03))",
      display: "flex",
      flexDirection: "column",
      gap: 2
    }}>
      <span className="bo-muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</span>
      <span style={{ fontSize: 16, fontWeight: 600, color, fontFeatureSettings: '"tnum"' }}>{value}</span>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ width: 10, height: 10, background: color, borderRadius: 2, display: "inline-block" }} />
      <span className="bo-muted">{label}</span>
    </span>
  );
}
