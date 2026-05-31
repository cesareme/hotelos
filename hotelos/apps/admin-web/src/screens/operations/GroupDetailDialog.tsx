// GroupDetailDialog — vista 360º de un grupo (lectura + edición + acciones).
//
// Layout en pestañas internas:
//  1. Resumen          → todos los campos del grupo organizados en secciones
//                        (modo lectura o edición según el flag `editing`)
//  2. Pickup & bloqueo → KPIs + barras día×día (mismo patrón que AllotmentLifecycleRow)
//  3. Eventos          → placeholder de iteración futura
//
// Acciones de footer:
//  • Modo lectura: "Editar", "Cambiar estado…" (dropdown), "Crear folio maestro", "Cerrar"
//  • Modo edición: "Guardar cambios", "Descartar"
//
// Mismo patrón modal grande que NewGroupDialog (max-width amplio) y mismos
// helpers locales de estilo replicados para evitar acoplamiento entre dialogs.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useApiData } from "../../hooks/useApiData";
import { LoadingBlock, ErrorState } from "../../components/States";
import { useToast } from "../../components/Toast";
import { apiRequest } from "../../services/api-client";
import { getActivePropertyId } from "../../services/activeProperty";
import type { GroupBooking } from "../../services/groupsApi";

// ─── Tipos del pickup-summary de grupos (espejo del de allotments) ───────

type GroupPickupDay = {
  date: string;
  blocked: number;
  pickedUp: number;
  released: number;
  remaining: number;
  pickupPct: number;
};

type GroupPickupRow = {
  groupBookingId: string;
  code: string;
  name: string;
  arrivalDate: string;
  departureDate: string;
  totalBlocked: number;
  totalPickedUp: number;
  totalReleased: number;
  totalRemaining: number;
  pickupPct: number;
  attritionThresholdPct?: number;
  attritionPenaltyPct?: number;
  belowAttritionThreshold?: boolean;
  cutOffDate?: string;
  daysToCutOff?: number | null;
  days: GroupPickupDay[];
};

type GroupsPickupSummary = {
  generatedAt: string;
  window: { from: string; to: string };
  groups: GroupPickupRow[];
};

// Forma esperada de la respuesta del endpoint master-folio.
type MasterFolioResponse = {
  folioId?: string;
  id?: string;
  masterFolioId?: string;
};

// ─── Helpers locales (replicados para no acoplar con NewGroupDialog) ─────

const fieldsetStyle: CSSProperties = {
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "var(--radius-sm, 6px)",
  padding: 12,
  margin: 0
};

const legendStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-soft, #555)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  padding: "0 6px"
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--border, #d1d5db)",
  borderRadius: "var(--radius-sm, 6px)",
  background: "var(--surface, white)",
  color: "var(--ink, #1a1a1a)",
  fontSize: 14,
  fontFamily: "inherit"
};

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--ink)" }}>
      <span style={{ fontWeight: 500 }}>{props.label}</span>
      {props.children}
      {props.hint ? <span className="bo-muted" style={{ fontSize: 11 }}>{props.hint}</span> : null}
    </label>
  );
}

// ─── Helpers de formato ──────────────────────────────────────────────────

function fmtDateEs(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
}

function daysFromToday(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const target = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function dDaysLabel(n: number | null): string {
  if (n === null) return "—";
  if (n === 0) return "hoy";
  if (n > 0) return `en ${n} días`;
  return `hace ${Math.abs(n)} días`;
}

function fmtMoney(value: number | undefined | null, currency = "EUR"): string {
  if (value == null || Number.isNaN(Number(value))) return "—";
  try {
    return new Intl.NumberFormat("es-ES", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(value));
  } catch {
    return `${value} ${currency}`;
  }
}

function fmtPct(value: number | undefined | null): string {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${value}%`;
}

const GROUP_TYPE_LABEL: Record<string, string> = {
  corporate: "Corporate",
  mice: "MICE",
  smerf: "SMERF",
  leisure: "Leisure",
  wedding: "Wedding",
  sports: "Sports",
  wholesale: "Wholesale"
};

const GROUP_STATUS_LABEL: Record<string, string> = {
  inquiry: "Inquiry",
  tentative: "Tentative",
  definite: "Definite",
  cancelled: "Cancelado"
};

const RATE_TYPE_LABEL: Record<string, string> = {
  net: "Tarifa neta (net)",
  commissionable: "Tarifa comisionable"
};

const ATTRITION_TYPE_LABEL: Record<string, string> = {
  cumulative: "Acumulativa (total estancia)",
  nightly: "Por noche",
  revenue: "Sobre revenue total"
};

const BILLING_METHOD_LABEL: Record<string, string> = {
  master_folio: "Master folio",
  split: "Split (room + extras)",
  individual: "Individual"
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cc_guarantee: "Tarjeta de garantía",
  prepay_pct: "Prepago anticipado",
  deposit: "Depósito inicial",
  credit: "Crédito (cuenta corporativa)",
  transfer: "Transferencia bancaria"
};

const MEAL_PLAN_LABEL: Record<string, string> = {
  none: "Ninguno",
  HD: "HD · Media pensión",
  FB: "FB · Pensión completa",
  AI: "AI · Todo incluido"
};

// ─── Componente principal ────────────────────────────────────────────────

type TabKey = "resumen" | "pickup" | "eventos";

export function GroupDetailDialog(props: {
  groupBookingId: string;
  onClose: () => void;
}) {
  const propertyId = getActivePropertyId();
  const { showToast } = useToast();
  const [tab, setTab] = useState<TabKey>("resumen");

  // Estado de edición + draft + flags de acción
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<GroupBooking | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Estado local del grupo (lo que mostramos después de un PATCH exitoso).
  const [localGroup, setLocalGroup] = useState<GroupBooking | null>(null);

  // Dropdown "Cambiar estado…"
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);

  // Crear folio maestro
  const [creatingFolio, setCreatingFolio] = useState(false);
  const [masterFolioId, setMasterFolioId] = useState<string | null>(null);

  // 1. Fetch del grupo
  const groupState = useApiData<GroupBooking>(`/groups/${props.groupBookingId}`);

  // 2. Fetch del pickup-summary del property y filtramos por groupBookingId
  const pickupState = useApiData<GroupsPickupSummary>(
    `/properties/${propertyId}/groups/pickup-summary?windowDays=120`
  );

  // Encuentra el row del grupo en el pickup-summary
  const pickupRow = useMemo<GroupPickupRow | null>(() => {
    const list = pickupState.data?.groups ?? [];
    return list.find((g) => g.groupBookingId === props.groupBookingId) ?? null;
  }, [pickupState.data, props.groupBookingId]);

  const loading = groupState.loading || pickupState.loading;
  const fatalError = groupState.error || pickupState.error;

  // Sincroniza el localGroup con la primera carga del fetch.
  useEffect(() => {
    if (groupState.data && !localGroup) {
      setLocalGroup(groupState.data);
    }
  }, [groupState.data, localGroup]);

  // Usamos siempre la versión local más reciente (que recibe el resultado de los PATCHes).
  const group = localGroup ?? groupState.data;

  function refreshAll() {
    groupState.refresh();
    pickupState.refresh();
  }

  // ─── Acciones de edición ───────────────────────────────────────────────

  function startEditing() {
    if (!group) return;
    setDraft({ ...group });
    setSaveError(null);
    setEditing(true);
    setStatusMenuOpen(false);
  }

  function discardEditing() {
    setDraft(null);
    setEditing(false);
    setSaveError(null);
  }

  async function saveEdit() {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await apiRequest<GroupBooking>(`/groups/${props.groupBookingId}`, {
        method: "PATCH",
        body: draft
      });
      setLocalGroup(updated);
      setDraft(null);
      setEditing(false);
      showToast("Cambios guardados", { variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSaveError(message);
      showToast(`No se pudo guardar: ${message}`, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  function updateDraftField<K extends keyof GroupBooking>(key: K, value: GroupBooking[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  // ─── Acciones de cambio de estado ──────────────────────────────────────

  async function changeStatus(nextStatus: "inquiry" | "tentative" | "definite" | "cancelled") {
    if (!group) return;
    if (nextStatus === "cancelled") {
      const ok = window.confirm(
        `¿Cancelar el grupo "${group.name ?? group.code ?? "(sin nombre)"}"?\n\n` +
        "Esta acción liberará el bloqueo y notificará a los miembros del grupo. " +
        "Podrás reactivarlo más adelante si es necesario."
      );
      if (!ok) return;
    }
    setChangingStatus(true);
    setStatusMenuOpen(false);
    try {
      const updated = await apiRequest<GroupBooking>(`/groups/${props.groupBookingId}`, {
        method: "PATCH",
        // Cast explícito porque GroupStatus en groupsApi.ts no contempla "cancelled"
        // pero el backend sí lo acepta como transición de estado válida.
        body: { status: nextStatus } as Partial<GroupBooking>
      });
      setLocalGroup(updated);
      const label = GROUP_STATUS_LABEL[nextStatus] ?? nextStatus;
      showToast(`Estado actualizado a ${label}`, { variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`No se pudo cambiar el estado: ${message}`, { variant: "error" });
    } finally {
      setChangingStatus(false);
    }
  }

  // ─── Acción: crear folio maestro ───────────────────────────────────────

  async function createMasterFolio() {
    setCreatingFolio(true);
    try {
      const response = await apiRequest<MasterFolioResponse>(
        `/groups/${props.groupBookingId}/master-folio`,
        { method: "POST" }
      );
      const newFolioId = response?.folioId ?? response?.masterFolioId ?? response?.id ?? null;
      setMasterFolioId(newFolioId);
      showToast(
        newFolioId
          ? `Folio maestro creado · ${newFolioId}`
          : "Folio maestro creado",
        { variant: "success" }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`No se pudo crear el folio maestro: ${message}`, { variant: "error" });
    } finally {
      setCreatingFolio(false);
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────

  let body: ReactNode;
  if (loading && !group) {
    body = <LoadingBlock label="Cargando detalle del grupo…" />;
  } else if (fatalError || !group) {
    body = (
      <ErrorState
        title="No se pudo cargar"
        message={fatalError ?? "Grupo no encontrado."}
        onRetry={refreshAll}
      />
    );
  } else {
    body = (
      <>
        <TabsBar
          tab={tab}
          onChange={(next) => {
            // Si abandonan la pestaña de Resumen mientras editan, descartamos el modo edición.
            if (editing && next !== "resumen") {
              const ok = window.confirm("Estás editando. ¿Descartar los cambios al cambiar de pestaña?");
              if (!ok) return;
              discardEditing();
            }
            setTab(next);
          }}
          pickupAvailable={pickupRow !== null}
        />
        {tab === "resumen" ? (
          <ResumenTab
            group={group}
            draft={draft}
            editing={editing}
            masterFolioId={masterFolioId}
            saveError={saveError}
            onChangeField={updateDraftField}
          />
        ) : null}
        {tab === "pickup" ? <PickupTab group={group} row={pickupRow} /> : null}
        {tab === "eventos" ? <EventosTab /> : null}
      </>
    );
  }

  // ─── Marco modal ───────────────────────────────────────────────────────

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="group-detail-title"
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
      <section
        className="bo-card"
        style={{
          width: "100%",
          maxWidth: 880,
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
            <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11, margin: 0 }}>
              Comercial · Groups &amp; Events
            </p>
            <h3 id="group-detail-title" style={{ margin: "2px 0 0 0" }}>
              {group ? `${group.code ?? "—"} · ${group.name ?? "Grupo sin nombre"}` : "Detalle de grupo"}
              {editing ? (
                <span
                  className="bo-muted"
                  style={{ fontSize: 12, marginLeft: 10, color: "var(--accent, #0d8a5f)", fontWeight: 500 }}
                >
                  · editando
                </span>
              ) : null}
            </h3>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Cerrar"
            style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "var(--ink)" }}
          >×</button>
        </div>

        {body}

        <FooterActions
          editing={editing}
          saving={saving}
          changingStatus={changingStatus}
          creatingFolio={creatingFolio}
          hasGroup={!!group}
          masterFolioExists={!!masterFolioId || !!(group as (GroupBooking & { masterFolioId?: string }) | null)?.masterFolioId}
          statusMenuOpen={statusMenuOpen}
          onToggleStatusMenu={() => setStatusMenuOpen((open) => !open)}
          onStartEdit={startEditing}
          onSave={() => void saveEdit()}
          onDiscard={discardEditing}
          onChangeStatus={(next) => void changeStatus(next)}
          onCreateMasterFolio={() => void createMasterFolio()}
          onClose={props.onClose}
        />
      </section>
    </div>
  );
}

// ─── Footer de acciones ──────────────────────────────────────────────────

function FooterActions(props: {
  editing: boolean;
  saving: boolean;
  changingStatus: boolean;
  creatingFolio: boolean;
  hasGroup: boolean;
  masterFolioExists: boolean;
  statusMenuOpen: boolean;
  onToggleStatusMenu: () => void;
  onStartEdit: () => void;
  onSave: () => void;
  onDiscard: () => void;
  onChangeStatus: (next: "inquiry" | "tentative" | "definite" | "cancelled") => void;
  onCreateMasterFolio: () => void;
  onClose: () => void;
}) {
  if (props.editing) {
    return (
      <div className="bo-row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
        <button type="button" onClick={props.onDiscard} disabled={props.saving}>
          Descartar
        </button>
        <button
          type="button"
          className="primary"
          onClick={props.onSave}
          disabled={props.saving}
        >
          {props.saving ? "Guardando…" : "Guardar cambios"}
        </button>
      </div>
    );
  }

  return (
    <div className="bo-row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 4, position: "relative" }}>
      <button type="button" onClick={props.onStartEdit} disabled={!props.hasGroup}>
        Editar
      </button>

      <div style={{ position: "relative" }}>
        <button
          type="button"
          onClick={props.onToggleStatusMenu}
          disabled={!props.hasGroup || props.changingStatus}
          aria-haspopup="menu"
          aria-expanded={props.statusMenuOpen}
        >
          {props.changingStatus ? "Cambiando…" : "Cambiar estado…"}
        </button>
        {props.statusMenuOpen ? (
          <div
            role="menu"
            style={{
              position: "absolute",
              bottom: "calc(100% + 4px)",
              right: 0,
              minWidth: 230,
              background: "var(--surface-1, white)",
              border: "1px solid var(--border, #e5e7eb)",
              borderRadius: "var(--radius-sm, 6px)",
              boxShadow: "0 4px 14px rgba(26,26,26,0.10), 0 12px 32px rgba(26,26,26,0.06)",
              padding: 4,
              display: "flex",
              flexDirection: "column",
              zIndex: 10
            }}
          >
            <StatusMenuItem
              label="Mantener como Inquiry"
              hint="Estado inicial · sin compromiso"
              onClick={() => props.onChangeStatus("inquiry")}
            />
            <StatusMenuItem
              label="Confirmar a Tentative"
              hint="Bloqueo provisional · expira en cut-off"
              onClick={() => props.onChangeStatus("tentative")}
            />
            <StatusMenuItem
              label="Confirmar a Definite"
              hint="Contrato firmado · bloqueo en firme"
              onClick={() => props.onChangeStatus("definite")}
            />
            <StatusMenuItem
              label="Cancelar grupo"
              hint="Libera bloqueo · pide confirmación"
              tone="danger"
              onClick={() => props.onChangeStatus("cancelled")}
            />
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={props.onCreateMasterFolio}
        disabled={!props.hasGroup || props.creatingFolio || props.masterFolioExists}
        title={props.masterFolioExists ? "El folio maestro ya existe" : undefined}
      >
        {props.creatingFolio
          ? "Creando…"
          : props.masterFolioExists
          ? "Folio maestro creado"
          : "Crear folio maestro"}
      </button>

      <button type="button" onClick={props.onClose}>Cerrar</button>
    </div>
  );
}

function StatusMenuItem(props: {
  label: string;
  hint?: string;
  tone?: "default" | "danger";
  onClick: () => void;
}) {
  const danger = props.tone === "danger";
  return (
    <button
      type="button"
      role="menuitem"
      onClick={props.onClick}
      style={{
        textAlign: "left",
        border: "none",
        background: "transparent",
        padding: "8px 10px",
        borderRadius: 4,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        color: danger ? "var(--danger, #dc2626)" : "var(--ink, #1a1a1a)"
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0,0,0,0.04)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ fontSize: 13, fontWeight: 500 }}>{props.label}</span>
      {props.hint ? (
        <span className="bo-muted" style={{ fontSize: 11 }}>{props.hint}</span>
      ) : null}
    </button>
  );
}

// ─── Pestañas ────────────────────────────────────────────────────────────

function TabsBar(props: {
  tab: TabKey;
  onChange: (next: TabKey) => void;
  pickupAvailable: boolean;
}) {
  const items: Array<{ key: TabKey; label: string; disabled?: boolean }> = [
    { key: "resumen", label: "Resumen" },
    { key: "pickup", label: "Pickup & bloqueo", disabled: !props.pickupAvailable },
    { key: "eventos", label: "Eventos" }
  ];
  return (
    <div
      role="tablist"
      aria-label="Secciones del grupo"
      style={{
        display: "flex",
        gap: 4,
        borderBottom: "1px solid var(--border, #e5e7eb)",
        paddingBottom: 0
      }}
    >
      {items.map((it) => {
        const active = props.tab === it.key;
        return (
          <button
            key={it.key}
            role="tab"
            type="button"
            aria-selected={active}
            disabled={it.disabled}
            onClick={() => props.onChange(it.key)}
            style={{
              border: "none",
              background: "transparent",
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: active ? 600 : 500,
              cursor: it.disabled ? "not-allowed" : "pointer",
              opacity: it.disabled ? 0.5 : 1,
              color: active ? "var(--accent, #0d8a5f)" : "var(--ink, #1a1a1a)",
              borderBottom: active ? "2px solid var(--accent, #0d8a5f)" : "2px solid transparent",
              marginBottom: -1
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Tab 1 · Resumen ─────────────────────────────────────────────────────

// Helper para mostrar un input editable o un input deshabilitado según el flag.
function readOnlyValue<K extends keyof GroupBooking>(
  group: GroupBooking,
  key: K
): string {
  const v = group[key];
  if (v == null) return "—";
  return String(v);
}

function ResumenTab(props: {
  group: GroupBooking;
  draft: GroupBooking | null;
  editing: boolean;
  masterFolioId: string | null;
  saveError: string | null;
  onChangeField: <K extends keyof GroupBooking>(key: K, value: GroupBooking[K]) => void;
}) {
  const { group, draft, editing, masterFolioId, saveError, onChangeField } = props;
  // Para mostrar/editar usamos el draft cuando estamos editando; si no, el group.
  const view = editing && draft ? draft : group;

  const arrivalDays = daysFromToday(view.arrivalDate);
  const departureDays = daysFromToday(view.departureDate);
  const cutOffDays = daysFromToday(view.cutOffDate);
  const roomingListDays = daysFromToday(view.roomingListDueDate);

  // Ejemplo numérico aplicado a la attrition: asume 100 hab × 3 noches × tarifa
  const exampleAttrition = useMemo(() => {
    const threshold = view.attritionThresholdPct ?? 80;
    const penalty = view.attritionPenaltyPct ?? 100;
    const rate = view.contractedRate ?? 120;
    const exampleRooms = 100;
    const exampleNights = 3;
    const examplePickupPct = Math.max(0, threshold - 10); // 10 puntos por debajo del threshold
    const deficitPct = threshold - examplePickupPct;
    const deficitRooms = Math.round((deficitPct / 100) * exampleRooms);
    const penaltyEur = deficitRooms * exampleNights * rate * (penalty / 100);
    return {
      threshold,
      penalty,
      rate,
      exampleRooms,
      exampleNights,
      examplePickupPct,
      deficitRooms,
      penaltyEur
    };
  }, [view.attritionThresholdPct, view.attritionPenaltyPct, view.contractedRate]);

  const showCommission = view.rateType === "commissionable" && view.commissionPct != null;
  const showDeposit = (view.paymentMethod === "prepay_pct" || view.paymentMethod === "deposit") && view.depositPct != null;

  // Detección del masterFolioId persistido en el propio group (por si vuelves al dialog).
  const persistedFolioId =
    (group as GroupBooking & { masterFolioId?: string }).masterFolioId ?? null;
  const folioToShow = masterFolioId ?? persistedFolioId;

  // ─── Helpers de campo editable ───────────────────────────────────────

  function TextField<K extends keyof GroupBooking>(p: {
    label: string;
    fieldKey: K;
    hint?: string;
    type?: "text" | "date" | "number" | "email" | "tel";
  }) {
    const value = view[p.fieldKey];
    const displayValue =
      value == null ? (editing ? "" : "—") : String(value);
    if (editing) {
      return (
        <Field label={p.label} hint={p.hint}>
          <input
            type={p.type ?? "text"}
            value={displayValue}
            style={inputStyle}
            onChange={(e) => {
              const raw = e.target.value;
              if (p.type === "number") {
                onChangeField(p.fieldKey, (raw === "" ? undefined : Number(raw)) as GroupBooking[K]);
              } else {
                onChangeField(p.fieldKey, (raw === "" ? undefined : raw) as GroupBooking[K]);
              }
            }}
          />
        </Field>
      );
    }
    return (
      <Field label={p.label} hint={p.hint}>
        <input type="text" disabled value={displayValue} style={{ ...inputStyle, opacity: 0.85 }} />
      </Field>
    );
  }

  function SelectField<K extends keyof GroupBooking>(p: {
    label: string;
    fieldKey: K;
    options: Array<{ value: string; label: string }>;
    placeholderLabel?: string;
  }) {
    const value = view[p.fieldKey];
    const stringValue = value == null ? "" : String(value);
    if (editing) {
      return (
        <Field label={p.label}>
          <select
            value={stringValue}
            style={inputStyle}
            onChange={(e) => {
              const raw = e.target.value;
              onChangeField(p.fieldKey, (raw === "" ? undefined : raw) as GroupBooking[K]);
            }}
          >
            <option value="">{p.placeholderLabel ?? "(sin valor)"}</option>
            {p.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
      );
    }
    const displayLabel =
      p.options.find((o) => o.value === stringValue)?.label ?? (stringValue || "—");
    return (
      <Field label={p.label}>
        <input type="text" disabled value={displayLabel} style={{ ...inputStyle, opacity: 0.85 }} />
      </Field>
    );
  }

  function CheckboxField<K extends keyof GroupBooking>(p: {
    label: string;
    fieldKey: K;
  }) {
    const value = Boolean(view[p.fieldKey]);
    if (editing) {
      return (
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={value}
            onChange={(e) => onChangeField(p.fieldKey, e.target.checked as GroupBooking[K])}
          />
          <span>{p.label}</span>
        </label>
      );
    }
    return value ? <FbChip label={p.label} tone="ok" /> : null;
  }

  function TextAreaField<K extends keyof GroupBooking>(p: {
    label: string;
    fieldKey: K;
  }) {
    const value = view[p.fieldKey];
    const stringValue = value == null ? "" : String(value);
    if (editing) {
      return (
        <Field label={p.label}>
          <textarea
            value={stringValue}
            rows={4}
            style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
            onChange={(e) => {
              const raw = e.target.value;
              onChangeField(p.fieldKey, (raw === "" ? undefined : raw) as GroupBooking[K]);
            }}
          />
        </Field>
      );
    }
    if (!stringValue) return null;
    return (
      <p style={{ margin: 0, fontSize: 13, color: "var(--ink)", whiteSpace: "pre-wrap" }}>{stringValue}</p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Banner de error inline al guardar */}
      {saveError ? (
        <div
          className="bo-status"
          style={{
            textTransform: "none",
            padding: "10px 12px",
            borderRadius: "var(--radius-sm, 6px)",
            background: "rgba(220, 38, 38, 0.1)",
            borderLeft: "3px solid var(--danger, #dc2626)",
            color: "var(--ink)",
            fontSize: 13
          }}
        >
          No se pudo guardar: {saveError}
        </div>
      ) : null}

      {/* 1. Identificación */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Identificación</legend>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 12 }}>
          <TextField label="Código" fieldKey="code" />
          <TextField label="Nombre del grupo" fieldKey="name" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
          <SelectField
            label="Tipo de grupo"
            fieldKey="groupType"
            options={Object.entries(GROUP_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <SelectField
            label="Estado"
            fieldKey="status"
            options={Object.entries(GROUP_STATUS_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <TextField label="Market code" fieldKey="marketCode" />
          <TextField label="Source code" fieldKey="sourceCode" />
        </div>
      </fieldset>

      {/* 2. Fechas */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Fechas e hitos</legend>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
          {editing ? (
            <>
              <TextField label="Llegada" fieldKey="arrivalDate" hint={dDaysLabel(arrivalDays)} type="date" />
              <TextField label="Salida" fieldKey="departureDate" hint={dDaysLabel(departureDays)} type="date" />
              <TextField label="Cut-off" fieldKey="cutOffDate" hint={dDaysLabel(cutOffDays)} type="date" />
              <TextField label="Rooming list due" fieldKey="roomingListDueDate" hint={dDaysLabel(roomingListDays)} type="date" />
            </>
          ) : (
            <>
              <Field label="Llegada" hint={dDaysLabel(arrivalDays)}>
                <input type="text" disabled value={fmtDateEs(view.arrivalDate)} style={{ ...inputStyle, opacity: 0.85 }} />
              </Field>
              <Field label="Salida" hint={dDaysLabel(departureDays)}>
                <input type="text" disabled value={fmtDateEs(view.departureDate)} style={{ ...inputStyle, opacity: 0.85 }} />
              </Field>
              <Field label="Cut-off" hint={dDaysLabel(cutOffDays)}>
                <input type="text" disabled value={fmtDateEs(view.cutOffDate)} style={{ ...inputStyle, opacity: 0.85 }} />
              </Field>
              <Field label="Rooming list due" hint={dDaysLabel(roomingListDays)}>
                <input type="text" disabled value={fmtDateEs(view.roomingListDueDate)} style={{ ...inputStyle, opacity: 0.85 }} />
              </Field>
            </>
          )}
        </div>
      </fieldset>

      {/* 3. Contacto */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Contacto</legend>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <TextField label="Nombre" fieldKey="contactPersonName" />
          <TextField label="Cargo / rol" fieldKey="contactRole" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {editing ? (
            <>
              <TextField label="Email" fieldKey="contactEmail" type="email" />
              <TextField label="Teléfono" fieldKey="contactPhone" type="tel" />
            </>
          ) : (
            <>
              <Field label="Email">
                {view.contactEmail ? (
                  <a
                    href={`mailto:${view.contactEmail}`}
                    style={{
                      ...inputStyle,
                      opacity: 0.95,
                      textDecoration: "none",
                      color: "var(--accent, #0d8a5f)",
                      display: "inline-flex",
                      alignItems: "center"
                    }}
                  >
                    {view.contactEmail}
                  </a>
                ) : (
                  <input type="text" disabled value="—" style={{ ...inputStyle, opacity: 0.85 }} />
                )}
              </Field>
              <Field label="Teléfono">
                {view.contactPhone ? (
                  <a
                    href={`tel:${view.contactPhone}`}
                    style={{
                      ...inputStyle,
                      opacity: 0.95,
                      textDecoration: "none",
                      color: "var(--accent, #0d8a5f)",
                      display: "inline-flex",
                      alignItems: "center"
                    }}
                  >
                    {view.contactPhone}
                  </a>
                ) : (
                  <input type="text" disabled value="—" style={{ ...inputStyle, opacity: 0.85 }} />
                )}
              </Field>
            </>
          )}
        </div>
      </fieldset>

      {/* 4. Empresa */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Empresa</legend>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <TextField label="Razón social" fieldKey="companyName" />
          <TextField label="NIF / Tax ID" fieldKey="companyTaxId" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
          <TextField label="Dirección" fieldKey="companyAddress" />
          <TextField label="Sector / industry" fieldKey="industry" />
        </div>
      </fieldset>

      {/* 5. Tarifa */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Tarifa contratada</legend>
        <div style={{ display: "grid", gridTemplateColumns: showCommission || editing ? "1fr 1fr 1fr" : "1fr 1fr", gap: 12 }}>
          {editing ? (
            <TextField label="Tarifa / habitación / noche" fieldKey="contractedRate" type="number" />
          ) : (
            <Field label="Tarifa / habitación / noche">
              <input
                type="text"
                disabled
                value={fmtMoney(view.contractedRate, view.currency ?? "EUR")}
                style={{ ...inputStyle, opacity: 0.85 }}
              />
            </Field>
          )}
          <SelectField
            label="Modelo de tarifa"
            fieldKey="rateType"
            options={Object.entries(RATE_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
          />
          {showCommission || editing ? (
            editing ? (
              <TextField label="Comisión (%)" fieldKey="commissionPct" type="number" />
            ) : (
              <Field label="Comisión">
                <input
                  type="text"
                  disabled
                  value={fmtPct(view.commissionPct)}
                  style={{ ...inputStyle, opacity: 0.85 }}
                />
              </Field>
            )
          ) : null}
        </div>
      </fieldset>

      {/* 6. Attrition */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Attrition (penalización por no-pickup)</legend>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <SelectField
            label="Tipo"
            fieldKey="attritionType"
            options={Object.entries(ATTRITION_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
          />
          {editing ? (
            <>
              <TextField label="Threshold (%)" fieldKey="attritionThresholdPct" type="number" />
              <TextField label="Penalty (%)" fieldKey="attritionPenaltyPct" type="number" />
            </>
          ) : (
            <>
              <Field label="Threshold">
                <input
                  type="text"
                  disabled
                  value={fmtPct(view.attritionThresholdPct)}
                  style={{ ...inputStyle, opacity: 0.85 }}
                />
              </Field>
              <Field label="Penalty">
                <input
                  type="text"
                  disabled
                  value={fmtPct(view.attritionPenaltyPct)}
                  style={{ ...inputStyle, opacity: 0.85 }}
                />
              </Field>
            </>
          )}
        </div>
        <p className="bo-muted" style={{ fontSize: 12, margin: "10px 0 0 0" }}>
          Ejemplo: con {exampleAttrition.exampleRooms} habs × {exampleAttrition.exampleNights} noches,
          threshold {exampleAttrition.threshold}%, si pickup baja a {exampleAttrition.examplePickupPct}%
          ({exampleAttrition.deficitRooms} hab por debajo) → penalización ≈
          {" "}<strong style={{ color: "var(--ink)" }}>
            {fmtMoney(exampleAttrition.penaltyEur, view.currency ?? "EUR")}
          </strong>{" "}
          ({exampleAttrition.penalty}% del déficit a tarifa {fmtMoney(exampleAttrition.rate, view.currency ?? "EUR")}).
        </p>
      </fieldset>

      {/* 7. Billing */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Facturación &amp; pago</legend>
        <div style={{ display: "grid", gridTemplateColumns: showDeposit || editing ? "1fr 1fr 1fr" : "1fr 1fr", gap: 12 }}>
          <SelectField
            label="Método de facturación"
            fieldKey="billingMethod"
            options={Object.entries(BILLING_METHOD_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <SelectField
            label="Método de pago"
            fieldKey="paymentMethod"
            options={Object.entries(PAYMENT_METHOD_LABEL).map(([value, label]) => ({ value, label }))}
          />
          {showDeposit || editing ? (
            editing ? (
              <TextField label="Depósito (%)" fieldKey="depositPct" type="number" />
            ) : (
              <Field label="Depósito">
                <input
                  type="text"
                  disabled
                  value={fmtPct(view.depositPct)}
                  style={{ ...inputStyle, opacity: 0.85 }}
                />
              </Field>
            )
          ) : null}
        </div>

        {/* Master folio · se muestra si existe uno creado en esta sesión o ya persistido */}
        <div style={{ marginTop: 12, padding: "8px 10px", border: "1px dashed var(--border, #e5e7eb)", borderRadius: 4 }}>
          {folioToShow ? (
            <div className="bo-row" style={{ alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{ fontWeight: 500 }}>Folio maestro:</span>
              <code style={{ background: "var(--surface-2, rgba(0,0,0,0.04))", padding: "2px 6px", borderRadius: 3 }}>
                {folioToShow}
              </code>
              <span className="bo-muted" style={{ fontSize: 11 }}>
                · Todos los cargos del grupo se imputarán a este folio.
              </span>
            </div>
          ) : (
            <span className="bo-muted" style={{ fontSize: 12 }}>
              Sin folio maestro creado. Usa el botón &quot;Crear folio maestro&quot; del footer cuando el grupo esté listo.
            </span>
          )}
        </div>
      </fieldset>

      {/* 8. F&B */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>F&amp;B (catering &amp; restauración)</legend>
        {editing ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <SelectField
              label="Régimen / Meal plan"
              fieldKey="mealPlan"
              options={Object.entries(MEAL_PLAN_LABEL).map(([value, label]) => ({ value, label }))}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 6, justifyContent: "center" }}>
              <CheckboxField label="Desayuno incluido" fieldKey="breakfastIncluded" />
              <CheckboxField label="Welcome cocktail" fieldKey="welcomeCocktail" />
              <CheckboxField label="Gala dinner" fieldKey="galaDinner" />
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {view.breakfastIncluded ? <FbChip label="Breakfast" tone="ok" /> : null}
            {view.mealPlan && view.mealPlan !== "none" ? (
              <FbChip label={MEAL_PLAN_LABEL[view.mealPlan] ?? view.mealPlan} tone="ok" />
            ) : null}
            {view.welcomeCocktail ? <FbChip label="Welcome cocktail" tone="accent" /> : null}
            {view.galaDinner ? <FbChip label="Gala dinner" tone="accent" /> : null}
            {!view.breakfastIncluded &&
              (!view.mealPlan || view.mealPlan === "none") &&
              !view.welcomeCocktail &&
              !view.galaDinner ? (
              <span className="bo-muted" style={{ fontSize: 13 }}>Sin servicios de F&amp;B incluidos.</span>
            ) : null}
          </div>
        )}
      </fieldset>

      {/* 9. ES specifics */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>España · Específicos</legend>
        {editing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <CheckboxField label="REAV (Régimen Especial AAEE)" fieldKey="regimenEspecialAaee" />
            <CheckboxField label="Llegada confidencial" fieldKey="confidentialArrival" />
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {view.regimenEspecialAaee ? (
              <FbChip label="REAV (Régimen Especial AAEE)" tone="warn" />
            ) : (
              <span className="bo-muted" style={{ fontSize: 13 }}>Sin régimen especial AAEE.</span>
            )}
            {view.confidentialArrival ? (
              <FbChip label="Llegada confidencial" tone="warn" />
            ) : null}
          </div>
        )}
      </fieldset>

      {/* 10. Notas */}
      {editing || view.notes ? (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Notas internas</legend>
          <TextAreaField label="Notas" fieldKey="notes" />
        </fieldset>
      ) : null}

      {/* Silenciamos la advertencia de helper no usado mientras solo lo dejamos disponible. */}
      <span style={{ display: "none" }}>{readOnlyValue(group, "id")}</span>
    </div>
  );
}

function FbChip(props: { label: string; tone: "ok" | "warn" | "accent" }) {
  const bg =
    props.tone === "ok" ? "rgba(13, 138, 95, 0.12)"
    : props.tone === "warn" ? "rgba(217, 119, 6, 0.12)"
    : "rgba(13, 138, 95, 0.08)";
  const border =
    props.tone === "ok" ? "var(--ok, #0d8a5f)"
    : props.tone === "warn" ? "var(--warn, #d97706)"
    : "var(--accent, #0d8a5f)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 10px",
        borderRadius: 999,
        background: bg,
        border: `1px solid ${border}`,
        color: "var(--ink)",
        fontSize: 12,
        fontWeight: 500
      }}
    >
      {props.label}
    </span>
  );
}

// ─── Tab 2 · Pickup & bloqueo ────────────────────────────────────────────

function PickupTab(props: { group: GroupBooking; row: GroupPickupRow | null }) {
  const { group, row } = props;
  const cutOffDays = daysFromToday(group.cutOffDate);
  const showCutOffBanner = cutOffDays != null && cutOffDays >= 0 && cutOffDays < 14;

  if (!row) {
    return (
      <div className="bo-status" style={{ textTransform: "none", padding: 14, borderRadius: "var(--radius-sm, 6px)" }}>
        Aún no hay datos de pickup para este grupo. El bloqueo de habitaciones todavía no se ha
        registrado o está fuera de la ventana de 120 días.
      </div>
    );
  }

  const threshold = group.attritionThresholdPct ?? 80;
  const belowThreshold = row.belowAttritionThreshold ?? row.pickupPct < threshold;
  const pickupColor =
    row.pickupPct >= 70 ? "var(--ok, #0d8a5f)"
    : row.pickupPct >= 40 ? "var(--warn, #d97706)"
    : "var(--danger, #dc2626)";

  // Estimación de la penalty si quedara como está hoy
  const exampleNights = Math.max(1, row.days.length);
  const rate = group.contractedRate ?? 0;
  const penaltyPct = group.attritionPenaltyPct ?? 100;
  const deficitRooms = Math.max(0, Math.round(((threshold - row.pickupPct) / 100) * row.totalBlocked / exampleNights));
  const estimatedPenalty = deficitRooms * exampleNights * rate * (penaltyPct / 100);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Banner de cut-off próximo */}
      {showCutOffBanner ? (
        <div
          className="bo-status warn"
          style={{
            textTransform: "none",
            padding: "10px 12px",
            borderRadius: "var(--radius-sm, 6px)",
            background: "rgba(217, 119, 6, 0.12)",
            borderLeft: "3px solid var(--warn, #d97706)",
            color: "var(--ink)",
            fontSize: 13
          }}
        >
          Cut-off en {cutOffDays === 0 ? "hoy" : `${cutOffDays} día${cutOffDays === 1 ? "" : "s"}`}
          {" "}({fmtDateEs(group.cutOffDate)}). Asegúrate de tener la rooming list y revisar el pickup actual.
        </div>
      ) : null}

      {/* Alerta attrition */}
      {belowThreshold ? (
        <div
          className="bo-status warn"
          style={{
            textTransform: "none",
            padding: "10px 12px",
            borderRadius: "var(--radius-sm, 6px)",
            background: "rgba(220, 38, 38, 0.1)",
            borderLeft: "3px solid var(--danger, #dc2626)",
            color: "var(--ink)",
            fontSize: 13
          }}
        >
          Pickup actual <strong>{row.pickupPct}%</strong> está por debajo del threshold{" "}
          <strong>{threshold}%</strong>. Penalización estimada{" "}
          <strong>{fmtMoney(estimatedPenalty, group.currency ?? "EUR")}</strong>
          {" "}({penaltyPct}% del déficit, ~{deficitRooms} hab/día por debajo).
        </div>
      ) : null}

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
        <Stat label="Blocked" value={row.totalBlocked} color="var(--ink, #1a1a1a)" />
        <Stat label="Picked-up" value={row.totalPickedUp} color="var(--ok, #0d8a5f)" />
        <Stat label="Remaining" value={row.totalRemaining} color="var(--accent, #0d8a5f)" />
        <Stat label={`Pickup %`} value={row.pickupPct} color={pickupColor} suffix="%" />
      </div>

      {/* Mini barras día a día */}
      {row.days.length > 0 ? (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Día a día · {row.days.length} noches</legend>
          <div
            style={{
              display: "flex",
              gap: 1,
              alignItems: "flex-end",
              height: 60,
              background: "var(--surface-2, rgba(0,0,0,0.03))",
              padding: 4,
              borderRadius: 4,
              overflow: "auto"
            }}
          >
            {row.days.map((d) => {
              const total = Math.max(1, d.blocked);
              const pkH = Math.round((d.pickedUp / total) * 52);
              const rlH = Math.round((d.released / total) * 52);
              const rmH = Math.round((d.remaining / total) * 52);
              return (
                <div
                  key={d.date}
                  title={`${fmtDateShort(d.date)}\nBlocked: ${d.blocked}\nPickup: ${d.pickedUp} (${d.pickupPct}%)\nReleased: ${d.released}\nRemaining: ${d.remaining}`}
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
            <Legend color="var(--ok, #0d8a5f)" label="Picked-up" />
            <Legend color="rgba(13, 138, 95, 0.25)" label="Remaining" />
            <Legend color="rgba(136, 136, 136, 0.4)" label="Released" />
            <span className="bo-muted" style={{ marginLeft: "auto" }}>Hover para ver el detalle del día</span>
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

function Stat(props: { label: string; value: number; color: string; suffix?: string }) {
  return (
    <div
      style={{
        padding: "8px 10px",
        borderRadius: 4,
        background: "var(--surface-2, rgba(0,0,0,0.03))",
        display: "flex",
        flexDirection: "column",
        gap: 2
      }}
    >
      <span className="bo-muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {props.label}
      </span>
      <span
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: props.color,
          fontFeatureSettings: '"tnum"'
        }}
      >
        {props.value}{props.suffix ?? ""}
      </span>
    </div>
  );
}

function Legend(props: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ width: 10, height: 10, background: props.color, borderRadius: 2, display: "inline-block" }} />
      <span className="bo-muted">{props.label}</span>
    </span>
  );
}

// ─── Tab 3 · Eventos (placeholder) ───────────────────────────────────────

function EventosTab() {
  return (
    <fieldset style={fieldsetStyle}>
      <legend style={legendStyle}>Eventos</legend>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "32px 16px" }}>
        <span style={{ fontSize: 32, opacity: 0.4 }} aria-hidden>◌</span>
        <p style={{ margin: 0, fontSize: 14, color: "var(--ink)" }}>
          Eventos asociados al grupo (próximamente).
        </p>
        <p className="bo-muted" style={{ margin: 0, fontSize: 12, textAlign: "center", maxWidth: 380 }}>
          Aquí verás el listado de eventos vinculados (banquetes, salas, F&amp;B, AV) cuando esté lista la
          integración con el módulo de eventos.
        </p>
      </div>
    </fieldset>
  );
}
