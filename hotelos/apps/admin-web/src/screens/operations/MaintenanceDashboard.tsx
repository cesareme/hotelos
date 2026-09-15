// Maintenance Dashboard — «Tablero de mantenimiento» (/operaciones/mantenimiento;
// base tab of MantenimientoTabs, standalone the page paints eyebrow + H1).
//
// Cocoa 22 (ola 4 · lote 4-A, archetype «workspace»): CocoaPage → CocoaKpiStrip
// (emergencias · abiertas · en curso · esperando proveedor · bloquean
// habitación) → filter chips (CocoaButton aria-pressed with counts) →
// CocoaGrid 4/8: the work-order list (CocoaSection scroll="y", a row is a
// CocoaButton plus CocoaBadge states) and the selected order's record (state,
// room, dates, description, CocoaSelect for the status, «Bloquear
// habitación» / «Resolver»). Below 900 px the list is the page and the record
// opens in a CocoaDrawer (bottom sheet on phones). «Nueva orden» opens a
// CocoaDrawer form (CocoaField + CocoaInput / CocoaSelect / CocoaSwitch).
// Results and errors go to the toast; same API calls as before
// (services/maintenanceApi, 30 s poll).

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { useTabHost } from "../tabs/TabHost";
import { fetchRooms } from "../../services/pmsCommerceApi";
import {
  blockRoomForWorkOrder,
  createWorkOrder,
  resolveWorkOrder,
  updateWorkOrder,
  type WorkOrder,
  type WoPriority,
  type WoStatus
} from "../../services/maintenanceApi";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { date, number, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, newLabel } from "../../content/actions";
import { PlusIcon } from "../../components/cocoa-icons/ActionIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaSwitch,
  useViewportTier,
  type CocoaSelectOption,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

const PRIORITY_LABEL: Record<string, string> = { emergency: "emergencia", urgent: "urgente", normal: "normal", preventive: "preventivo" };
const PRIORITY_TONE: Record<string, CocoaTone> = { emergency: "danger", urgent: "warning", normal: "info", preventive: "success" };
const STATUS_LABEL: Record<string, string> = { open: "Abierta", assigned: "Asignada", in_progress: "En curso", waiting_vendor: "Esperando proveedor", resolved: "Resuelta", closed: "Cerrada" };
const STATUS_TONE: Record<string, CocoaTone> = { open: "warning", assigned: "info", in_progress: "info", waiting_vendor: "warning", resolved: "success", closed: "success" };

const STATUS_OPTIONS: WoStatus[] = ["open", "assigned", "in_progress", "waiting_vendor"];
const PRIORITIES: WoPriority[] = ["emergency", "urgent", "normal", "preventive"];
const STATUS_SELECT_OPTIONS: CocoaSelectOption[] = STATUS_OPTIONS.map((s) => ({ value: s, label: STATUS_LABEL[s] }));
const PRIORITY_SELECT_OPTIONS: CocoaSelectOption[] = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }));

const FILTERS: { id: string; label: string; match: (w: WorkOrder) => boolean }[] = [
  { id: "active", label: "Activas", match: (w) => w.status !== "resolved" && w.status !== "closed" },
  { id: "all", label: "Todas", match: () => true },
  { id: "open", label: "Abiertas", match: (w) => w.status === "open" },
  { id: "in_progress", label: "En curso", match: (w) => w.status === "in_progress" || w.status === "assigned" },
  { id: "waiting_vendor", label: "Esperando proveedor", match: (w) => w.status === "waiting_vendor" },
  { id: "blocking", label: "Bloquean habitación", match: (w) => w.blocksRoom },
  { id: "resolved", label: "Resueltas", match: (w) => w.status === "resolved" || w.status === "closed" }
];

const PRIORITY_ORDER: Record<string, number> = { emergency: 0, urgent: 1, normal: 2, preventive: 3 };

const LIST_MAX_HEIGHT = 560;

function isClosed(w: WorkOrder): boolean {
  return w.status === "resolved" || w.status === "closed";
}

// Named style objects (rule 6): layout and text flow only.
const listInsetStyle: CSSProperties = { padding: "0 var(--cocoa-space-4)" };
const rowButtonStyle: CSSProperties = { flex: "1 1 auto", minWidth: 0, height: "auto", justifyContent: "flex-start", textAlign: "left", whiteSpace: "normal" };
const captionStyle: CSSProperties = { fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" };
const descriptionStyle: CSSProperties = { margin: 0, whiteSpace: "pre-line" };

function MaintenanceSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} min={200} />
      <CocoaSkeleton variant="row" />
      <CocoaSkeleton.Grid rows={[[4, 8]]} height={420} />
    </div>
  );
}

export function MaintenanceDashboard() {
  const hosted = useTabHost() !== null;
  const tier = useViewportTier();
  const compact = tier === "phone" || tier === "tablet";
  const { showToast } = useToast();
  const { data, loading, error, refresh } = useApiData<WorkOrder[]>(
    `/properties/${PROPERTY_ID}/work-orders`,
    { pollIntervalMs: 30000 }
  );
  const orders = useMemo(() => toArray<WorkOrder>(data), [data]);

  const [rooms, setRooms] = useState<Record<string, string>>({});
  useEffect(() => {
    void fetchRooms(PROPERTY_ID).then((list) => {
      const map: Record<string, string> = {};
      for (const r of list) map[r.id] = r.number;
      setRooms(map);
    }).catch(() => setRooms({}));
  }, []);

  const [filter, setFilter] = useState("active");
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => orders.find((o) => o.id === selectedId) ?? null, [orders, selectedId]);
  const [showForm, setShowForm] = useState(false);
  const [fTitle, setFTitle] = useState("");
  const [fRoom, setFRoom] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fPriority, setFPriority] = useState<WoPriority>("normal");
  const [fBlocks, setFBlocks] = useState(false);

  const kpis = useMemo(() => {
    const k = { open: 0, inProgress: 0, waiting: 0, blocking: 0, emergency: 0 };
    for (const w of orders) {
      if (w.status === "open") k.open += 1;
      if (w.status === "in_progress" || w.status === "assigned") k.inProgress += 1;
      if (w.status === "waiting_vendor") k.waiting += 1;
      if (w.blocksRoom && !isClosed(w)) k.blocking += 1;
      if (w.priority === "emergency" && !isClosed(w)) k.emergency += 1;
    }
    return k;
  }, [orders]);

  const visible = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter) ?? FILTERS[0];
    return orders.filter(f.match).sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) || b.createdAt.localeCompare(a.createdAt));
  }, [orders, filter]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      showToast(ok, { variant: "success" });
      refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "No se pudo completar la acción.", { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  function roomLabel(w: WorkOrder): string {
    if (!w.roomId) return "—";
    return rooms[w.roomId] ? `Hab. ${rooms[w.roomId]}` : "Hab.";
  }

  function openForm() {
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
  }

  function submitForm() {
    void run(async () => {
      await createWorkOrder({ title: fTitle, roomNumber: fRoom || undefined, description: fDesc || undefined, priority: fPriority, blocksRoom: fBlocks });
      setFTitle("");
      setFRoom("");
      setFDesc("");
      setFPriority("normal");
      setFBlocks(false);
      setShowForm(false);
    }, "Orden creada.");
  }

  function detailMeta(w: WorkOrder): string {
    return `${roomLabel(w)} · ${PRIORITY_LABEL[w.priority] ?? w.priority}`;
  }

  // Record body shared by the desktop pane and the phone/tablet drawer.
  function renderDetail(w: WorkOrder) {
    return (
      <div className="cocoa-stack" data-gap="4">
        <ul className="c22-section__list" aria-label="Datos de la orden">
          <li>
            <span>{FIELD_LABELS.status}</span>
            <CocoaBadge tone={STATUS_TONE[w.status] ?? "info"}>{STATUS_LABEL[w.status] ?? w.status}</CocoaBadge>
          </li>
          <li>
            <span>Prioridad</span>
            <CocoaBadge tone={PRIORITY_TONE[w.priority] ?? "info"}>{PRIORITY_LABEL[w.priority] ?? w.priority}</CocoaBadge>
          </li>
          <li>
            <span>{FIELD_LABELS.room}</span>
            <strong>{roomLabel(w)}</strong>
          </li>
          <li>
            <span>Bloquea habitación</span>
            <strong>{w.blocksRoom ? "Sí (fuera de servicio)" : STATUS_LABELS.no}</strong>
          </li>
          <li>
            <span>Asignada a</span>
            <strong>{w.assignedTo ?? "Sin asignar"}</strong>
          </li>
          <li>
            <span>Creada</span>
            <strong>{date(w.createdAt, "dayMonth")}</strong>
          </li>
          {w.resolvedAt ? (
            <li>
              <span>Resuelta</span>
              <strong>{date(w.resolvedAt, "dayMonth")}</strong>
            </li>
          ) : null}
        </ul>
        <div className="cocoa-stack" data-gap="1">
          <span style={captionStyle}>{FIELD_LABELS.description}</span>
          <p style={descriptionStyle}>{w.description || "Sin descripción."}</p>
        </div>
        {!isClosed(w) ? (
          <CocoaFormRow columns={2}>
            <CocoaField label={FIELD_LABELS.status} help="El cambio se guarda al elegirlo.">
              <CocoaSelect
                value={w.status}
                onChange={(v) => void run(() => updateWorkOrder(w.id, { status: v as WoStatus }), "Estado actualizado.")}
                options={STATUS_SELECT_OPTIONS}
                disabled={busy}
              />
            </CocoaField>
          </CocoaFormRow>
        ) : null}
      </div>
    );
  }

  // «Bloquear habitación» / «Resolver» (two buttons at most: section footer or drawer footer).
  function renderDetailActions(w: WorkOrder) {
    if (isClosed(w)) return null;
    return (
      <>
        {!w.blocksRoom && w.roomId ? (
          <CocoaButton variant="bordered" tone="neutral" disabled={busy} onClick={() => void run(() => blockRoomForWorkOrder(w.id), "Habitación bloqueada.")}>
            Bloquear habitación
          </CocoaButton>
        ) : null}
        <CocoaButton
          loading={busy}
          onClick={() =>
            void run(async () => {
              await resolveWorkOrder(w.id, { releaseRoom: w.blocksRoom });
              if (compact) setSelectedId(null);
            }, "Orden resuelta.")
          }
        >
          Resolver
        </CocoaButton>
      </>
    );
  }

  const list = (
    <CocoaSection
      title="Órdenes"
      meta={plural(visible.length, "orden", "órdenes")}
      scroll={compact ? undefined : "y"}
      maxHeight={compact ? undefined : LIST_MAX_HEIGHT}
      padding="none"
    >
      {visible.length === 0 ? (
        <CocoaState kind="empty" inline title="No hay órdenes de trabajo que coincidan con este filtro." style={listInsetStyle} />
      ) : (
        <ul className="c22-section__list" style={listInsetStyle} aria-label="Órdenes de trabajo">
          {visible.map((w) => {
            const isSelected = w.id === selectedId;
            return (
              <li key={w.id}>
                <CocoaButton
                  variant="plain"
                  tone={isSelected ? "accent" : "neutral"}
                  size="small"
                  onClick={() => setSelectedId(w.id)}
                  aria-current={isSelected ? true : undefined}
                  style={rowButtonStyle}
                >
                  {w.title}
                </CocoaButton>
                <span className="cocoa-cluster">
                  <CocoaBadge tone={PRIORITY_TONE[w.priority] ?? "info"} variant="dot" size="small">
                    {PRIORITY_LABEL[w.priority] ?? w.priority}
                  </CocoaBadge>
                  <CocoaBadge tone={STATUS_TONE[w.status] ?? "info"} size="small">
                    {STATUS_LABEL[w.status] ?? w.status}
                  </CocoaBadge>
                  {w.blocksRoom && !isClosed(w) ? (
                    <CocoaBadge tone="danger" variant="tinted" size="small">
                      bloquea
                    </CocoaBadge>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </CocoaSection>
  );

  const detailActions = selected ? renderDetailActions(selected) : null;

  const detail = selected ? (
    <CocoaSection
      title={selected.title}
      meta={detailMeta(selected)}
      footer={
        detailActions ? (
          <div className="cocoa-row" data-gap="2" data-justify="end">
            {detailActions}
          </div>
        ) : undefined
      }
    >
      {renderDetail(selected)}
    </CocoaSection>
  ) : (
    <CocoaSection aria-label="Sin selección">
      <CocoaState kind="empty" title="Elige una orden" message="La ficha aparece aquí: estado, habitación, descripción y acciones." illustration="box" />
    </CocoaSection>
  );

  return (
    <CocoaPage
      eyebrow="Operaciones · Mantenimiento"
      title="Tablero de mantenimiento"
      subtitle={hosted ? undefined : "Órdenes de trabajo en vivo. Crea averías, cambia su estado, asígnalas, bloquea habitaciones y resuélvelas."}
      actions={
        <>
          {busy ? <CocoaBadge tone="info">{STATUS_LABELS.saving}</CocoaBadge> : null}
          {error && orders.length > 0 ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} loading={loading && orders.length > 0}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton size="small" icon={<PlusIcon size={12} aria-hidden="true" />} onClick={openForm}>
            {newLabel("f", "orden")}
          </CocoaButton>
        </>
      }
      state={loading && orders.length === 0 ? "loading" : error && orders.length === 0 ? "error" : "ready"}
      skeleton={<MaintenanceSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[
        { id: "maintenance-refresh", label: "Actualizar el tablero de mantenimiento", run: refresh },
        { id: "maintenance-new-order", label: "Nueva orden de trabajo", run: openForm }
      ]}
    >
      <CocoaKpiStrip min={200} stagger aria-label="Órdenes de trabajo por estado">
        <CocoaKpi label="Emergencias" value={number(kpis.emergency)} polarity="negative-good" status={kpis.emergency > 0 ? "critical" : "ok"} />
        <CocoaKpi label="Abiertas" value={number(kpis.open)} polarity="negative-good" status={kpis.open > 0 ? "warning" : "ok"} />
        <CocoaKpi label="En curso" value={number(kpis.inProgress)} polarity="neutral" status="ok" />
        <CocoaKpi label="Esperando proveedor" value={number(kpis.waiting)} polarity="negative-good" status={kpis.waiting > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Bloquean habitación" value={number(kpis.blocking)} polarity="negative-good" status={kpis.blocking > 0 ? "critical" : "ok"} />
      </CocoaKpiStrip>

      <div className="cocoa-cluster" role="group" aria-label="Filtrar órdenes">
        {FILTERS.map((f) => {
          const count = orders.filter(f.match).length;
          const active = filter === f.id;
          return (
            <CocoaButton
              key={f.id}
              size="small"
              variant={active ? "tinted" : "bordered"}
              tone={active ? "accent" : "neutral"}
              aria-pressed={active}
              onClick={() => setFilter(f.id)}
            >
              {f.label} · {number(count)}
            </CocoaButton>
          );
        })}
      </div>

      {compact ? (
        <>
          {list}
          <CocoaDrawer
            open={selected !== null}
            onClose={() => setSelectedId(null)}
            title={selected?.title ?? "Orden de trabajo"}
            subtitle={selected ? detailMeta(selected) : undefined}
            side="right"
            size="md"
            footer={detailActions ?? undefined}
          >
            {selected ? renderDetail(selected) : null}
          </CocoaDrawer>
        </>
      ) : (
        <CocoaGrid align="start" aria-label="Órdenes y ficha">
          <CocoaSpan cols={4} min={320}>
            {list}
          </CocoaSpan>
          <CocoaSpan cols={8} min={480}>
            {detail}
          </CocoaSpan>
        </CocoaGrid>
      )}

      <CocoaDrawer
        open={showForm}
        onClose={closeForm}
        title="Nueva orden de trabajo"
        subtitle="Se crea abierta; asígnala o bloquea la habitación desde su ficha."
        side="right"
        size="md"
        initialFocus={() => document.getElementById("wo-title")}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={closeForm} disabled={busy}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton loading={busy} disabled={!fTitle.trim()} onClick={submitForm}>
              Crear orden
            </CocoaButton>
          </>
        }
      >
        <CocoaFormRow columns={2}>
          <CocoaField label="Título" required fullWidth>
            <CocoaInput id="wo-title" value={fTitle} onChange={setFTitle} placeholder="Ej.: Fuga en el baño" disabled={busy} />
          </CocoaField>
          <CocoaField label={FIELD_LABELS.room} hint={STATUS_LABELS.optional} help="Número de habitación">
            <CocoaInput value={fRoom} onChange={setFRoom} placeholder="Ej.: 108" disabled={busy} />
          </CocoaField>
          <CocoaField label="Prioridad">
            <CocoaSelect value={fPriority} onChange={(v) => setFPriority(v as WoPriority)} options={PRIORITY_SELECT_OPTIONS} disabled={busy} />
          </CocoaField>
          <CocoaField label={FIELD_LABELS.description} fullWidth>
            <CocoaInput value={fDesc} onChange={setFDesc} multiline rows={3} disabled={busy} />
          </CocoaField>
          <CocoaField label="Bloquea la habitación (fuera de servicio)" inline fullWidth>
            <CocoaSwitch checked={fBlocks} onChange={setFBlocks} disabled={busy} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaDrawer>
    </CocoaPage>
  );
}
