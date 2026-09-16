// GroupDetailDialog — 360º view of a group booking (read, edit and actions).
//
// Cocoa 22 (ola 3 · lote 3-B, archetype «diálogo / drawer»): a CocoaDrawer
// (right, lg; bottom sheet on phones) with three inner views switched by a
// CocoaSegmentedControl:
//   1. Resumen          → every field of the group in CocoaFormSections, read
//                         only or editable (`editing`); PATCH /groups/:id saves.
//   2. Pickup y bloqueo → KPI strip + day-by-day bars from
//                         GET /properties/:id/groups/pickup-summary (the same
//                         shape the allotments summary uses).
//   3. Eventos          → pointer to the Grupos y eventos board.
// Footer (two buttons): read → Cerrar · Editar; edit → Descartar · Guardar.
// «Cambiar estado» (CocoaPopover menu; cancelling is confirmed by a
// destructive CocoaDialog) and «Crear folio maestro» (POST
// /groups/:id/master-folio) live in the actions row above the views. Leaving
// Resumen while editing asks to discard the draft (CocoaDialog).
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useApiData } from "../../hooks/useApiData";
import { useToast } from "../../components/Toast";
import { apiRequest } from "../../services/api-client";
import { getActivePropertyId } from "../../services/activeProperty";
import type { GroupBooking } from "../../services/groupsApi";
import { EMPTY, date, dateRange, money, number, percent, plural, type CurrencyInput } from "../../lib/format";
import { ACTIONS, confirmDiscard } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaDatePicker,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPopover,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaSwitch,
  type CocoaBarsDatum,
  type CocoaKpiStatus,
  type CocoaTone
} from "../../components/cocoa";

// ─── Pickup summary types (mirror of the allotments summary) ─────────────

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

// Shape of the master-folio endpoint answer.
type MasterFolioResponse = {
  folioId?: string;
  id?: string;
  masterFolioId?: string;
};

type GroupStatusChange = "inquiry" | "tentative" | "definite" | "cancelled";
type ViewKey = "resumen" | "pickup" | "eventos";

// ─── Labels (Spanish; the API enum stays in the value) ───────────────────

const GROUP_TYPE_LABEL: Record<string, string> = {
  corporate: "Corporativo",
  mice: "MICE",
  smerf: "SMERF",
  leisure: "Ocio",
  wedding: "Boda",
  sports: "Deportivo",
  wholesale: "Mayorista (TT.OO.)"
};

const GROUP_STATUS_LABEL: Record<string, string> = {
  inquiry: "Consulta",
  tentative: "Provisional",
  definite: "Confirmado",
  cancelled: "Cancelado"
};

const GROUP_STATUS_TONE: Record<string, CocoaTone> = {
  inquiry: "neutral",
  tentative: "warning",
  definite: "success",
  cancelled: "danger"
};

const RATE_TYPE_LABEL: Record<string, string> = {
  net: "Tarifa neta",
  commissionable: "Tarifa comisionable"
};

const ATTRITION_TYPE_LABEL: Record<string, string> = {
  cumulative: "Acumulativa (total estancia)",
  nightly: "Por noche",
  revenue: "Sobre los ingresos totales"
};

const BILLING_METHOD_LABEL: Record<string, string> = {
  master_folio: "Folio maestro",
  split: "Separado (alojamiento y extras)",
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

function toOptions(map: Record<string, string>): Array<{ value: string; label: string }> {
  return Object.entries(map).map(([value, label]) => ({ value, label }));
}

// ─── Date helpers ────────────────────────────────────────────────────────

function daysFromToday(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const target = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function dDaysLabel(n: number | null): string {
  if (n === null) return EMPTY;
  if (n === 0) return "hoy";
  if (n > 0) return `en ${plural(n, "día", "días")}`;
  return `hace ${plural(Math.abs(n), "día", "días")}`;
}

function fmtMoney(value: number | undefined | null, currency?: CurrencyInput): string {
  return money(value, currency);
}

function pickupStatus(pct: number): CocoaKpiStatus {
  return pct >= 70 ? "ok" : pct >= 40 ? "warning" : "critical";
}

function pickupTone(pct: number): CocoaTone {
  return pct >= 70 ? "success" : pct >= 40 ? "warning" : "danger";
}

const noop = () => undefined;

// Secondary lines (menu hints, notes): identity from the system, not a literal.
const HINT_STYLE: CSSProperties = {
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-callout)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  textAlign: "left"
};

const NOTES_STYLE: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap"
};

// ─── Main component ──────────────────────────────────────────────────────

export function GroupDetailDialog(props: {
  groupBookingId: string;
  onClose: () => void;
}) {
  const propertyId = getActivePropertyId();
  const { showToast } = useToast();
  const [view, setView] = useState<ViewKey>("resumen");
  // View the user asked for while editing: confirmed by the discard dialog.
  const [pendingView, setPendingView] = useState<ViewKey | null>(null);

  // Edit state: draft, flags and the last save error.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<GroupBooking | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Local copy of the group (what a successful PATCH returned).
  const [localGroup, setLocalGroup] = useState<GroupBooking | null>(null);

  // «Cambiar estado» menu and its destructive confirmation.
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const statusAnchorRef = useRef<HTMLButtonElement | null>(null);

  // Master folio.
  const [creatingFolio, setCreatingFolio] = useState(false);
  const [masterFolioId, setMasterFolioId] = useState<string | null>(null);

  // 1. The group itself.
  const groupState = useApiData<GroupBooking>(`/groups/${props.groupBookingId}`);

  // 2. The property pickup summary, filtered to this group.
  const pickupState = useApiData<GroupsPickupSummary>(
    `/properties/${propertyId}/groups/pickup-summary?windowDays=120`
  );

  const pickupRow = useMemo<GroupPickupRow | null>(() => {
    const list = pickupState.data?.groups ?? [];
    return list.find((g) => g.groupBookingId === props.groupBookingId) ?? null;
  }, [pickupState.data, props.groupBookingId]);

  const loading = groupState.loading || pickupState.loading;
  const fatalError = groupState.error || pickupState.error;

  // First fetch seeds the local copy.
  useEffect(() => {
    if (groupState.data && !localGroup) {
      setLocalGroup(groupState.data);
    }
  }, [groupState.data, localGroup]);

  const group = localGroup ?? groupState.data;

  function refreshAll() {
    groupState.refresh();
    pickupState.refresh();
  }

  // ─── Editing ───────────────────────────────────────────────────────────

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

  function handleViewChange(next: ViewKey) {
    // Leaving Resumen while editing drops the draft: ask first.
    if (editing && next !== "resumen") {
      setPendingView(next);
      return;
    }
    setView(next);
  }

  // ─── Status changes ────────────────────────────────────────────────────

  function requestStatus(next: GroupStatusChange) {
    setStatusMenuOpen(false);
    if (next === "cancelled") {
      setCancelOpen(true);
      return;
    }
    void changeStatus(next);
  }

  async function changeStatus(nextStatus: GroupStatusChange) {
    if (!group) return;
    setChangingStatus(true);
    try {
      const updated = await apiRequest<GroupBooking>(`/groups/${props.groupBookingId}`, {
        method: "PATCH",
        // GroupStatus in groupsApi.ts has no "cancelled", but the backend
        // accepts it as a valid transition.
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
      setCancelOpen(false);
    }
  }

  // ─── Master folio ──────────────────────────────────────────────────────

  async function createMasterFolio() {
    setCreatingFolio(true);
    try {
      const response = await apiRequest<MasterFolioResponse>(
        `/groups/${props.groupBookingId}/master-folio`,
        { method: "POST" }
      );
      const newFolioId = response?.folioId ?? response?.masterFolioId ?? response?.id ?? null;
      setMasterFolioId(newFolioId);
      showToast(newFolioId ? `Folio maestro creado · ${newFolioId}` : "Folio maestro creado", { variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`No se pudo crear el folio maestro: ${message}`, { variant: "error" });
    } finally {
      setCreatingFolio(false);
    }
  }

  // ─── Derived ───────────────────────────────────────────────────────────

  const persistedFolioId = (group as (GroupBooking & { masterFolioId?: string }) | null | undefined)?.masterFolioId ?? null;
  const folioToShow = masterFolioId ?? persistedFolioId;
  const masterFolioExists = Boolean(folioToShow);
  const statusKey = group?.status ?? "";
  const groupTitle = group ? `${group.code ?? EMPTY} · ${group.name ?? "Grupo sin nombre"}` : "Detalle de grupo";
  const subtitleParts = group
    ? [GROUP_TYPE_LABEL[group.groupType ?? ""] ?? group.groupType, dateRange(group.arrivalDate, group.departureDate), editing ? "editando" : null].filter(Boolean)
    : [];

  const viewOptions = [
    { value: "resumen", label: "Resumen" },
    { value: "pickup", label: "Pickup y bloqueo", disabled: pickupRow === null },
    { value: "eventos", label: "Eventos" }
  ];

  // ─── Body ──────────────────────────────────────────────────────────────

  let body: ReactNode;
  if (loading && !group) {
    body = (
      <div className="cocoa-stack" data-gap="3" aria-hidden="true">
        <CocoaSkeleton variant="title" width="40%" />
        <CocoaSkeleton variant="card" height={240} />
      </div>
    );
  } else if (fatalError || !group) {
    body = (
      <CocoaState
        kind="error"
        title="No se pudo cargar"
        message={fatalError ?? "Grupo no encontrado."}
        onRetry={refreshAll}
      />
    );
  } else {
    body = (
      <div className="cocoa-stack" data-gap="4">
        {editing ? null : (
          <div className="cocoa-row" data-gap="2" data-justify="between">
            <div className="cocoa-cluster">
              <CocoaBadge tone={GROUP_STATUS_TONE[statusKey] ?? "info"} variant="dot">
                {GROUP_STATUS_LABEL[statusKey] ?? (statusKey || "Sin estado")}
              </CocoaBadge>
              {masterFolioExists ? <CocoaBadge tone="accent">Folio maestro creado</CocoaBadge> : null}
            </div>
            <div className="cocoa-row" data-gap="2">
              <CocoaButton
                ref={statusAnchorRef}
                variant="bordered"
                tone="neutral"
                size="small"
                aria-haspopup="menu"
                aria-expanded={statusMenuOpen}
                loading={changingStatus}
                disabled={changingStatus}
                onClick={() => setStatusMenuOpen((open) => !open)}
              >
                Cambiar estado
              </CocoaButton>
              <CocoaButton
                variant="bordered"
                tone="neutral"
                size="small"
                loading={creatingFolio}
                disabled={creatingFolio || masterFolioExists}
                title={masterFolioExists ? "El folio maestro ya existe" : undefined}
                onClick={() => void createMasterFolio()}
              >
                {masterFolioExists ? "Folio maestro creado" : "Crear folio maestro"}
              </CocoaButton>
            </div>
          </div>
        )}

        <CocoaSegmentedControl
          value={view}
          onChange={(next) => handleViewChange(next as ViewKey)}
          options={viewOptions}
          size="small"
          aria-label="Vistas del grupo"
        />

        {view === "resumen" ? (
          <ResumenView
            group={group}
            draft={draft}
            editing={editing}
            folioToShow={folioToShow}
            saveError={saveError}
            onChangeField={updateDraftField}
          />
        ) : null}
        {view === "pickup" ? <PickupView group={group} row={pickupRow} /> : null}
        {view === "eventos" ? <EventosView /> : null}
      </div>
    );
  }

  const discardCopy = confirmDiscard();

  return (
    <CocoaDrawer
      open
      onClose={props.onClose}
      title={groupTitle}
      subtitle={subtitleParts.length > 0 ? subtitleParts.join(" · ") : undefined}
      side="right"
      size="lg"
      focusKey={group ? "loaded" : "loading"}
      footer={
        editing ? (
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={discardEditing} disabled={saving}>
              {ACTIONS.discard}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void saveEdit()} loading={saving} disabled={saving}>
              {ACTIONS.saveChanges}
            </CocoaButton>
          </>
        ) : (
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={props.onClose}>
              {ACTIONS.close}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={startEditing} disabled={!group}>
              {ACTIONS.edit}
            </CocoaButton>
          </>
        )
      }
    >
      {body}

      <CocoaPopover
        open={statusMenuOpen}
        anchorEl={statusAnchorRef.current}
        placement="bottom"
        onClose={() => setStatusMenuOpen(false)}
        role="menu"
        aria-label="Cambiar el estado del grupo"
      >
        <div className="cocoa-stack" data-gap="1" style={{ minWidth: 240 }}>
          <StatusMenuItem label="Mantener como consulta" hint="Estado inicial · sin compromiso" onClick={() => requestStatus("inquiry")} />
          <StatusMenuItem label="Pasar a provisional" hint="Bloqueo provisional · vence en la fecha límite" onClick={() => requestStatus("tentative")} />
          <StatusMenuItem label="Confirmar el grupo" hint="Contrato firmado · bloqueo en firme" onClick={() => requestStatus("definite")} />
          <StatusMenuItem label="Cancelar grupo" hint="Libera el bloqueo · pide confirmación" destructive onClick={() => requestStatus("cancelled")} />
        </div>
      </CocoaPopover>

      <CocoaDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        tone="destructive"
        title={`¿Cancelar el grupo «${group?.name ?? group?.code ?? "sin nombre"}»?`}
        description="Esta acción liberará el bloqueo y notificará a los miembros del grupo. Podrás reactivarlo más adelante si es necesario."
        confirmLabel="Cancelar grupo"
        cancelLabel={ACTIONS.back}
        busy={changingStatus}
        onConfirm={() => changeStatus("cancelled")}
      />

      <CocoaDialog
        open={pendingView !== null}
        onClose={() => setPendingView(null)}
        tone="destructive"
        title={discardCopy.title}
        description="Estás editando el resumen. Al cambiar de vista se pierden los cambios sin guardar."
        confirmLabel={discardCopy.confirmLabel}
        cancelLabel={discardCopy.cancelLabel}
        onConfirm={() => {
          discardEditing();
          if (pendingView) setView(pendingView);
          setPendingView(null);
        }}
      />
    </CocoaDrawer>
  );
}

// ─── Status menu item ────────────────────────────────────────────────────

function StatusMenuItem(props: {
  label: string;
  hint: string;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <CocoaButton
      variant="plain"
      tone={props.destructive ? "destructive" : "neutral"}
      size="small"
      role="menuitem"
      wrap
      onClick={props.onClick}
      style={{ width: "100%", justifyContent: "flex-start" }}
    >
      <span className="cocoa-stack" data-gap="1">
        <span>{props.label}</span>
        <span style={HINT_STYLE}>{props.hint}</span>
      </span>
    </CocoaButton>
  );
}

// ─── View 1 · Resumen ────────────────────────────────────────────────────

function ResumenView(props: {
  group: GroupBooking;
  draft: GroupBooking | null;
  editing: boolean;
  folioToShow: string | null;
  saveError: string | null;
  onChangeField: <K extends keyof GroupBooking>(key: K, value: GroupBooking[K]) => void;
}) {
  const { group, draft, editing, folioToShow, saveError, onChangeField } = props;
  // The draft is what we show and edit while editing; the group otherwise.
  const view = editing && draft ? draft : group;

  const arrivalDays = daysFromToday(view.arrivalDate);
  const departureDays = daysFromToday(view.departureDate);
  const cutOffDays = daysFromToday(view.cutOffDate);
  const roomingListDays = daysFromToday(view.roomingListDueDate);

  // Worked example of the attrition clause: 100 rooms × 3 nights × rate.
  const exampleAttrition = useMemo(() => {
    const threshold = view.attritionThresholdPct ?? 80;
    const penalty = view.attritionPenaltyPct ?? 100;
    const rate = view.contractedRate ?? 120;
    const exampleRooms = 100;
    const exampleNights = 3;
    const examplePickupPct = Math.max(0, threshold - 10);
    const deficitPct = threshold - examplePickupPct;
    const deficitRooms = Math.round((deficitPct / 100) * exampleRooms);
    const penaltyEur = deficitRooms * exampleNights * rate * (penalty / 100);
    return { threshold, penalty, rate, exampleRooms, exampleNights, examplePickupPct, deficitRooms, penaltyEur };
  }, [view.attritionThresholdPct, view.attritionPenaltyPct, view.contractedRate]);

  const showCommission = view.rateType === "commissionable" && view.commissionPct != null;
  const showDeposit = (view.paymentMethod === "prepay_pct" || view.paymentMethod === "deposit") && view.depositPct != null;

  // ─── Field renderers (plain functions, so the inputs keep their identity) ─

  function stringOf(key: keyof GroupBooking): string {
    const value = view[key];
    return value == null ? "" : String(value);
  }

  function readField(label: string, value: string, help?: string): ReactNode {
    return (
      <CocoaField label={label} help={help}>
        <CocoaInput value={value || EMPTY} onChange={noop} readOnly />
      </CocoaField>
    );
  }

  function textField<K extends keyof GroupBooking>(
    key: K,
    label: string,
    opts: { help?: string; type?: "text" | "number" | "email" | "tel"; inputMode?: "text" | "numeric" | "decimal" | "email" | "tel" } = {}
  ): ReactNode {
    const value = stringOf(key);
    if (!editing) return readField(label, value, opts.help);
    return (
      <CocoaField label={label} help={opts.help}>
        <CocoaInput
          value={value}
          onChange={(raw) => onChangeField(key, (raw === "" ? undefined : opts.type === "number" ? Number(raw) : raw) as GroupBooking[K])}
          type={opts.type ?? "text"}
          inputMode={opts.inputMode}
          autoComplete="off"
        />
      </CocoaField>
    );
  }

  function dateField<K extends keyof GroupBooking>(key: K, label: string, help?: string): ReactNode {
    const value = stringOf(key);
    if (!editing) return readField(label, date(value, "medium"), help);
    return (
      <CocoaField label={label} help={help}>
        <CocoaDatePicker value={value} onChange={(next) => onChangeField(key, (next === "" ? undefined : next) as GroupBooking[K])} />
      </CocoaField>
    );
  }

  function selectField<K extends keyof GroupBooking>(
    key: K,
    label: string,
    options: Array<{ value: string; label: string }>,
    emptyLabel = "(sin valor)"
  ): ReactNode {
    const value = stringOf(key);
    if (!editing) return readField(label, options.find((o) => o.value === value)?.label ?? value);
    return (
      <CocoaField label={label}>
        <CocoaSelect
          value={value}
          onChange={(raw) => onChangeField(key, (raw === "" ? undefined : raw) as GroupBooking[K])}
          options={[{ value: "", label: emptyLabel }, ...options]}
        />
      </CocoaField>
    );
  }

  function switchField<K extends keyof GroupBooking>(key: K, label: string, tone: CocoaTone = "success"): ReactNode {
    const checked = Boolean(view[key]);
    if (!editing) return checked ? <CocoaBadge tone={tone}>{label}</CocoaBadge> : null;
    return (
      <CocoaField label={label} inline>
        <CocoaSwitch checked={checked} onChange={(next) => onChangeField(key, next as GroupBooking[K])} />
      </CocoaField>
    );
  }

  const hasFb = Boolean(view.breakfastIncluded) || (view.mealPlan && view.mealPlan !== "none") || Boolean(view.welcomeCocktail) || Boolean(view.galaDinner);

  return (
    <div className="cocoa-stack" data-gap="4">
      {saveError ? (
        <CocoaCallout tone="danger" title="No se pudo guardar" role="alert">
          {saveError}
        </CocoaCallout>
      ) : null}

      <CocoaFormSection title="Identificación">
        <CocoaFormRow columns={2}>
          {textField("code", "Código")}
          {textField("name", "Nombre del grupo")}
        </CocoaFormRow>
        <CocoaFormRow columns={4} min={160}>
          {selectField("groupType", "Tipo de grupo", toOptions(GROUP_TYPE_LABEL))}
          {selectField("status", "Estado del grupo", toOptions(GROUP_STATUS_LABEL))}
          {textField("marketCode", "Código de mercado")}
          {textField("sourceCode", "Código de origen")}
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title="Fechas e hitos">
        <CocoaFormRow columns={4} min={160}>
          {dateField("arrivalDate", "Llegada", dDaysLabel(arrivalDays))}
          {dateField("departureDate", "Salida", dDaysLabel(departureDays))}
          {dateField("cutOffDate", "Fecha límite (cut-off)", dDaysLabel(cutOffDays))}
          {dateField("roomingListDueDate", "Entrega de la rooming list", dDaysLabel(roomingListDays))}
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title="Contacto">
        <CocoaFormRow columns={2}>
          {textField("contactPersonName", "Persona de contacto")}
          {textField("contactRole", "Cargo")}
        </CocoaFormRow>
        <CocoaFormRow columns={2}>
          {editing || !view.contactEmail ? (
            textField("contactEmail", "Correo electrónico", { type: "email", inputMode: "email" })
          ) : (
            <CocoaField label="Correo electrónico">
              <a className="cocoa-link" href={`mailto:${view.contactEmail}`}>{view.contactEmail}</a>
            </CocoaField>
          )}
          {editing || !view.contactPhone ? (
            textField("contactPhone", "Teléfono", { type: "tel", inputMode: "tel" })
          ) : (
            <CocoaField label="Teléfono">
              <a className="cocoa-link" href={`tel:${view.contactPhone}`}>{view.contactPhone}</a>
            </CocoaField>
          )}
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title="Empresa">
        <CocoaFormRow columns={2}>
          {textField("companyName", "Razón social")}
          {textField("companyTaxId", "NIF")}
        </CocoaFormRow>
        <CocoaFormRow columns={2}>
          {textField("companyAddress", "Dirección")}
          {textField("industry", "Sector")}
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title="Tarifa contratada">
        <CocoaFormRow columns={3} min={160}>
          {editing
            ? textField("contractedRate", "Tarifa por habitación y noche", { type: "number", inputMode: "decimal" })
            : readField("Tarifa por habitación y noche", fmtMoney(view.contractedRate, view.currency))}
          {selectField("rateType", "Modelo de tarifa", toOptions(RATE_TYPE_LABEL))}
          {editing
            ? textField("commissionPct", "Comisión (%)", { type: "number", inputMode: "decimal" })
            : showCommission
              ? readField("Comisión", percent(view.commissionPct))
              : null}
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title="Penalización por no ocupación (attrition)">
        <CocoaFormRow columns={3} min={160}>
          {selectField("attritionType", "Tipo", toOptions(ATTRITION_TYPE_LABEL))}
          {editing
            ? textField("attritionThresholdPct", "Umbral (%)", { type: "number", inputMode: "numeric" })
            : readField("Umbral", percent(view.attritionThresholdPct))}
          {editing
            ? textField("attritionPenaltyPct", "Penalización (%)", { type: "number", inputMode: "numeric" })
            : readField("Penalización", percent(view.attritionPenaltyPct))}
        </CocoaFormRow>
        <CocoaCallout tone="neutral" title="Ejemplo">
          Con {number(exampleAttrition.exampleRooms)} habitaciones y {plural(exampleAttrition.exampleNights, "noche", "noches")}, umbral{" "}
          {percent(exampleAttrition.threshold)}: si el pickup baja a {percent(exampleAttrition.examplePickupPct)} ({plural(exampleAttrition.deficitRooms, "habitación", "habitaciones")} por debajo)
          la penalización es de aproximadamente <strong>{fmtMoney(exampleAttrition.penaltyEur, view.currency)}</strong> ({percent(exampleAttrition.penalty)} del déficit a{" "}
          {fmtMoney(exampleAttrition.rate, view.currency)}).
        </CocoaCallout>
      </CocoaFormSection>

      <CocoaFormSection title="Facturación y pago">
        <CocoaFormRow columns={3} min={160}>
          {selectField("billingMethod", "Método de facturación", toOptions(BILLING_METHOD_LABEL))}
          {selectField("paymentMethod", "Método de pago", toOptions(PAYMENT_METHOD_LABEL))}
          {editing
            ? textField("depositPct", "Depósito (%)", { type: "number", inputMode: "decimal" })
            : showDeposit
              ? readField("Depósito", percent(view.depositPct))
              : null}
        </CocoaFormRow>
        {folioToShow ? (
          <CocoaCallout tone="accent" title="Folio maestro">
            <code className="cocoa-mono">{folioToShow}</code> · Todos los cargos del grupo se imputarán a este folio.
          </CocoaCallout>
        ) : (
          <CocoaCallout tone="neutral">
            Sin folio maestro creado. Usa «Crear folio maestro» cuando el grupo esté listo.
          </CocoaCallout>
        )}
      </CocoaFormSection>

      <CocoaFormSection title="Restauración y eventos (F&B)">
        {editing ? (
          <CocoaFormRow columns={2}>
            {selectField("mealPlan", "Régimen de comidas", toOptions(MEAL_PLAN_LABEL))}
            <div className="cocoa-stack" data-gap="2">
              {switchField("breakfastIncluded", "Desayuno incluido")}
              {switchField("welcomeCocktail", "Cóctel de bienvenida")}
              {switchField("galaDinner", "Cena de gala")}
            </div>
          </CocoaFormRow>
        ) : hasFb ? (
          <div className="cocoa-cluster">
            {switchField("breakfastIncluded", "Desayuno incluido")}
            {view.mealPlan && view.mealPlan !== "none" ? <CocoaBadge tone="success">{MEAL_PLAN_LABEL[view.mealPlan] ?? view.mealPlan}</CocoaBadge> : null}
            {switchField("welcomeCocktail", "Cóctel de bienvenida", "accent")}
            {switchField("galaDinner", "Cena de gala", "accent")}
          </div>
        ) : (
          <CocoaState kind="empty" inline title="Sin servicios de restauración incluidos." />
        )}
      </CocoaFormSection>

      <CocoaFormSection title="España · Específicos">
        {editing ? (
          <div className="cocoa-stack" data-gap="2">
            {switchField("regimenEspecialAaee", "REAV (Régimen Especial de Agencias de Viajes)")}
            {switchField("confidentialArrival", "Llegada confidencial")}
          </div>
        ) : view.regimenEspecialAaee || view.confidentialArrival ? (
          <div className="cocoa-cluster">
            {switchField("regimenEspecialAaee", "REAV (Régimen Especial de Agencias de Viajes)", "warning")}
            {switchField("confidentialArrival", "Llegada confidencial", "warning")}
          </div>
        ) : (
          <CocoaState kind="empty" inline title="Sin régimen especial ni llegada confidencial." />
        )}
      </CocoaFormSection>

      {editing || view.notes ? (
        <CocoaFormSection title="Notas internas">
          {editing ? (
            <CocoaField label="Notas" fullWidth>
              <CocoaInput
                value={stringOf("notes")}
                onChange={(raw) => onChangeField("notes", raw === "" ? undefined : raw)}
                multiline
                rows={4}
              />
            </CocoaField>
          ) : (
            <p style={NOTES_STYLE}>{view.notes}</p>
          )}
        </CocoaFormSection>
      ) : null}
    </div>
  );
}

// ─── View 2 · Pickup y bloqueo ───────────────────────────────────────────

function PickupView(props: { group: GroupBooking; row: GroupPickupRow | null }) {
  const { group, row } = props;
  const cutOffDays = daysFromToday(group.cutOffDate);
  const showCutOffBanner = cutOffDays != null && cutOffDays >= 0 && cutOffDays < 14;

  if (!row) {
    return (
      <CocoaState
        kind="empty"
        title="Aún no hay datos de pickup para este grupo"
        message="El bloqueo de habitaciones todavía no se ha registrado o está fuera de la ventana de 120 días."
      />
    );
  }

  const threshold = group.attritionThresholdPct ?? 80;
  const belowThreshold = row.belowAttritionThreshold ?? row.pickupPct < threshold;

  // Penalty estimate if the pickup stayed as it is today.
  const exampleNights = Math.max(1, row.days.length);
  const rate = group.contractedRate ?? 0;
  const penaltyPct = group.attritionPenaltyPct ?? 100;
  const deficitRooms = Math.max(0, Math.round(((threshold - row.pickupPct) / 100) * row.totalBlocked / exampleNights));
  const estimatedPenalty = deficitRooms * exampleNights * rate * (penaltyPct / 100);

  const bars: CocoaBarsDatum[] = row.days.map((d) => ({
    label: date(d.date, "dayMonth"),
    value: d.pickupPct,
    tone: pickupTone(d.pickupPct),
    hint: `Bloqueadas ${number(d.blocked)} · Vendidas ${number(d.pickedUp)} · Liberadas ${number(d.released)} · Disponibles ${number(d.remaining)}`
  }));

  return (
    <div className="cocoa-stack" data-gap="4">
      {showCutOffBanner ? (
        <CocoaCallout tone="warning" title={`Fecha límite ${cutOffDays === 0 ? "hoy" : `en ${plural(cutOffDays, "día", "días")}`} (${date(group.cutOffDate, "medium")})`}>
          Asegúrate de tener la rooming list y revisa el pickup actual.
        </CocoaCallout>
      ) : null}

      {belowThreshold ? (
        <CocoaCallout tone="danger" title={`Pickup ${percent(row.pickupPct)} por debajo del umbral ${percent(threshold)}`}>
          Penalización estimada <strong>{fmtMoney(estimatedPenalty, group.currency)}</strong> ({percent(penaltyPct)} del déficit, unas{" "}
          {plural(deficitRooms, "habitación", "habitaciones")} por día por debajo).
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip aria-label="Pickup del grupo">
        <CocoaKpi label="Bloqueadas" value={number(row.totalBlocked)} polarity="neutral" />
        <CocoaKpi label="Vendidas" value={number(row.totalPickedUp)} tone="success" polarity="neutral" />
        <CocoaKpi label="Disponibles" value={number(row.totalRemaining)} tone="accent" polarity="neutral" />
        <CocoaKpi label="Pickup" value={percent(row.pickupPct)} status={pickupStatus(row.pickupPct)} polarity="positive-good" />
      </CocoaKpiStrip>

      {row.days.length > 0 ? (
        <CocoaFormSection title="Día a día" description={`${plural(row.days.length, "noche", "noches")} · pickup de cada noche sobre lo bloqueado`}>
          <CocoaChart.Bars
            data={bars}
            height={120}
            valueFormat={(value) => percent(value, { maximumFractionDigits: 0 })}
            aria-label={`Pickup día a día de ${plural(row.days.length, "noche", "noches")}`}
          />
        </CocoaFormSection>
      ) : null}
    </div>
  );
}

// ─── View 3 · Eventos (the events of a group live in Grupos y eventos) ───

function EventosView() {
  return (
    <CocoaState
      kind="empty"
      title="Los eventos del grupo se gestionan en Grupos y eventos"
      message="Desde la fila del grupo, «Crear evento» abre el alta de banquetes, salas, restauración y audiovisuales; el listado de eventos se consulta en el tablero de Grupos y eventos."
    />
  );
}
