import { useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
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
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";
import { SidePanel, DetailRow } from "../../components/SidePanel";
import { toArray } from "../../utils/toArray";

const PROPERTY_ID = getActivePropertyId();

type Kind = "ok" | "warn" | "error" | "info";

const PRIORITY_LABEL: Record<string, string> = { emergency: "emergencia", urgent: "urgente", normal: "normal", preventive: "preventivo" };
const PRIORITY_KIND: Record<string, Kind> = { emergency: "error", urgent: "warn", normal: "info", preventive: "ok" };
const STATUS_LABEL: Record<string, string> = { open: "Abierta", assigned: "Asignada", in_progress: "En curso", waiting_vendor: "Esperando proveedor", resolved: "Resuelta", closed: "Cerrada" };
const STATUS_KIND: Record<string, Kind> = { open: "warn", assigned: "info", in_progress: "info", waiting_vendor: "warn", resolved: "ok", closed: "ok" };

const STATUS_OPTIONS: WoStatus[] = ["open", "assigned", "in_progress", "waiting_vendor"];
const PRIORITIES: WoPriority[] = ["emergency", "urgent", "normal", "preventive"];

const FILTERS: { id: string; label: string; match: (w: WorkOrder) => boolean }[] = [
  { id: "active", label: "Activas", match: (w) => w.status !== "resolved" && w.status !== "closed" },
  { id: "all", label: "Todas", match: () => true },
  { id: "open", label: "Abiertas", match: (w) => w.status === "open" },
  { id: "in_progress", label: "En curso", match: (w) => w.status === "in_progress" || w.status === "assigned" },
  { id: "waiting_vendor", label: "Esperando proveedor", match: (w) => w.status === "waiting_vendor" },
  { id: "blocking", label: "Bloquean habitación", match: (w) => w.blocksRoom },
  { id: "resolved", label: "Resueltas", match: (w) => w.status === "resolved" || w.status === "closed" }
];

function fmtNum(n: number): string {
  return new Intl.NumberFormat("es-ES", { useGrouping: true }).format(n);
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
}

export function MaintenanceDashboard() {
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
  const [msg, setMsg] = useState<string | null>(null);
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
      if (w.blocksRoom && w.status !== "resolved" && w.status !== "closed") k.blocking += 1;
      if (w.priority === "emergency" && w.status !== "resolved" && w.status !== "closed") k.emergency += 1;
    }
    return k;
  }, [orders]);

  const visible = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter) ?? FILTERS[0];
    const order = { emergency: 0, urgent: 1, normal: 2, preventive: 3 } as Record<string, number>;
    return orders.filter(f.match).sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || b.createdAt.localeCompare(a.createdAt));
  }, [orders, filter]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

  function roomLabel(w: WorkOrder): string {
    if (!w.roomId) return "—";
    return rooms[w.roomId] ? `Hab. ${rooms[w.roomId]}` : "Hab.";
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>Operaciones · Mantenimiento</p>
          <h2 style={{ color: "var(--ink)" }}>Tablero de mantenimiento</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Órdenes de trabajo en vivo. Crea averías, cambia su estado, asígnalas, bloquea habitaciones y resuélvelas.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {busy ? <Spinner size="sm" /> : null}
          <button type="button" onClick={refresh} disabled={loading}>↻ Actualizar</button>
          <button type="button" className="primary" onClick={() => { setShowForm((v) => !v); setMsg(null); }}>{showForm ? "Cancelar" : "+ Nueva orden"}</button>
        </div>
      </header>

      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      {showForm ? (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head"><h3>Nueva orden de trabajo</h3></div>
          <div className="bo-grid two">
            <label className="bo-form-field"><span>Título *</span><input value={fTitle} onChange={(e) => setFTitle(e.target.value)} placeholder="Ej.: Fuga en el baño" disabled={busy} /></label>
            <label className="bo-form-field"><span>Habitación (nº, opcional)</span><input value={fRoom} onChange={(e) => setFRoom(e.target.value)} placeholder="Ej.: 108" disabled={busy} /></label>
          </div>
          <label className="bo-form-field"><span>Descripción</span><textarea rows={2} value={fDesc} onChange={(e) => setFDesc(e.target.value)} disabled={busy} /></label>
          <div className="bo-row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <label className="bo-form-field" style={{ margin: 0 }}><span>Prioridad</span>
              <select value={fPriority} onChange={(e) => setFPriority(e.target.value as WoPriority)} disabled={busy}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
            </label>
            <label className="bo-row" style={{ gap: 6, alignItems: "center", marginTop: 18 }}>
              <input type="checkbox" checked={fBlocks} onChange={(e) => setFBlocks(e.target.checked)} disabled={busy} /> <span>Bloquea la habitación (fuera de servicio)</span>
            </label>
          </div>
          <div className="bo-actions" style={{ marginTop: 8 }}>
            <button type="button" className="primary" disabled={busy || !fTitle.trim()} onClick={() => run(async () => {
              await createWorkOrder({ title: fTitle, roomNumber: fRoom || undefined, description: fDesc || undefined, priority: fPriority, blocksRoom: fBlocks });
              setFTitle(""); setFRoom(""); setFDesc(""); setFPriority("normal"); setFBlocks(false); setShowForm(false);
            }, "Orden creada.")}>Crear orden</button>
          </div>
        </article>
      ) : null}

      {loading && orders.length === 0 ? (
        <LoadingBlock label="Cargando órdenes de trabajo…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar" message={error} onRetry={refresh} />
      ) : (
        <>
          <div className="rev-kpi-grid">
            <article className={`rev-kpi rev-kpi-${kpis.emergency > 0 ? "error" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Emergencias</span><span className={`bo-status ${kpis.emergency > 0 ? "error" : "ok"}`}>{kpis.emergency > 0 ? "urgente" : "ninguna"}</span></div><div className="rev-kpi-value">{fmtNum(kpis.emergency)}</div></article>
            <article className={`rev-kpi rev-kpi-${kpis.open > 0 ? "warn" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Abiertas</span><span className={`bo-status ${kpis.open > 0 ? "warn" : "ok"}`}>{kpis.open > 0 ? "sin asignar" : "al día"}</span></div><div className="rev-kpi-value">{fmtNum(kpis.open)}</div></article>
            <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">En curso</span><span className="bo-status info">trabajando</span></div><div className="rev-kpi-value">{fmtNum(kpis.inProgress)}</div></article>
            <article className={`rev-kpi rev-kpi-${kpis.waiting > 0 ? "warn" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Esperando proveedor</span><span className={`bo-status ${kpis.waiting > 0 ? "warn" : "ok"}`}>{kpis.waiting > 0 ? "externo" : "ninguna"}</span></div><div className="rev-kpi-value">{fmtNum(kpis.waiting)}</div></article>
            <article className={`rev-kpi rev-kpi-${kpis.blocking > 0 ? "error" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Bloquean habitación</span><span className={`bo-status ${kpis.blocking > 0 ? "error" : "ok"}`}>{kpis.blocking > 0 ? "fuera de servicio" : "ninguna"}</span></div><div className="rev-kpi-value">{fmtNum(kpis.blocking)}</div></article>
          </div>

          <div className="bo-pill-row">
            {FILTERS.map((f) => {
              const count = orders.filter(f.match).length;
              return <button key={f.id} type="button" className={`bo-pill${filter === f.id ? " is-active" : ""}`} style={{ cursor: "pointer" }} onClick={() => setFilter(f.id)}>{f.label} ({count})</button>;
            })}
          </div>

          {visible.length === 0 ? (
            <EmptyState title="Sin órdenes" message="No hay órdenes de trabajo que coincidan con este filtro." />
          ) : (
            <div className="bo-stack" style={{ gap: 10 }}>
              {visible.map((w) => {
                const closed = w.status === "resolved" || w.status === "closed";
                return (
                  <article key={w.id} className="bo-card" style={{ background: "var(--surface)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                      <div style={{ minWidth: 0, cursor: "pointer", flex: 1 }} onClick={() => setSelectedId(w.id)} title="Ver ficha">
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <span className={`bo-status ${PRIORITY_KIND[w.priority] ?? "info"}`}>{PRIORITY_LABEL[w.priority] ?? w.priority}</span>
                          <strong style={{ color: "var(--ink)" }}>{w.title}</strong>
                          <span className={`bo-status ${STATUS_KIND[w.status] ?? "info"}`}>{STATUS_LABEL[w.status] ?? w.status}</span>
                          {w.blocksRoom && !closed ? <span className="bo-status error">habitación bloqueada</span> : null}
                        </div>
                        <div className="bo-muted" style={{ fontSize: 12, marginTop: 2, textTransform: "none" }}>
                          {roomLabel(w)} · creada {fmtDate(w.createdAt)}{w.assignedTo ? ` · asignada a ${w.assignedTo}` : ""}
                        </div>
                        {w.description ? <div style={{ fontSize: 13, marginTop: 4 }}>{w.description}</div> : null}
                      </div>
                      <button type="button" className="bo-link" style={{ alignSelf: "flex-start" }} onClick={() => setSelectedId(w.id)}>Ver ficha →</button>
                    </div>
                    {!closed ? (
                      <div className="bo-row" style={{ gap: 6, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                        <select value={w.status} disabled={busy} onChange={(e) => run(() => updateWorkOrder(w.id, { status: e.target.value as WoStatus }), "Estado actualizado.")}>
                          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                        </select>
                        {!w.blocksRoom && w.roomId ? (
                          <button type="button" disabled={busy} onClick={() => run(() => blockRoomForWorkOrder(w.id), "Habitación bloqueada.")}>Bloquear habitación</button>
                        ) : null}
                        <button type="button" className="primary" disabled={busy} onClick={() => run(() => resolveWorkOrder(w.id, { releaseRoom: w.blocksRoom }), "Orden resuelta.")}>Resolver</button>
                      </div>
                    ) : (
                      <div className="bo-muted" style={{ fontSize: 12, marginTop: 8 }}>{w.resolvedAt ? `Resuelta el ${fmtDate(w.resolvedAt)}` : "Cerrada"}</div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}

      <SidePanel
        open={!!selected}
        title={selected?.title ?? ""}
        subtitle={selected ? `${roomLabel(selected)} · ${PRIORITY_LABEL[selected.priority] ?? selected.priority}` : undefined}
        onClose={() => setSelectedId(null)}
        footer={selected && selected.status !== "resolved" && selected.status !== "closed" ? (
          <>
            <select value={selected.status} disabled={busy} onChange={(e) => run(() => updateWorkOrder(selected.id, { status: e.target.value as WoStatus }), "Estado actualizado.")}>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
            {!selected.blocksRoom && selected.roomId ? (
              <button type="button" disabled={busy} onClick={() => run(() => blockRoomForWorkOrder(selected.id), "Habitación bloqueada.")}>Bloquear habitación</button>
            ) : null}
            <button type="button" className="primary" disabled={busy} onClick={() => run(async () => { await resolveWorkOrder(selected.id, { releaseRoom: selected.blocksRoom }); setSelectedId(null); }, "Orden resuelta.")}>Resolver</button>
          </>
        ) : undefined}
      >
        {selected ? (
          <>
            <DetailRow label="Estado"><span className={`bo-status ${STATUS_KIND[selected.status] ?? "info"}`}>{STATUS_LABEL[selected.status] ?? selected.status}</span></DetailRow>
            <DetailRow label="Prioridad"><span className={`bo-status ${PRIORITY_KIND[selected.priority] ?? "info"}`}>{PRIORITY_LABEL[selected.priority] ?? selected.priority}</span></DetailRow>
            <DetailRow label="Habitación">{roomLabel(selected)}</DetailRow>
            <DetailRow label="Bloquea habitación">{selected.blocksRoom ? "Sí (fuera de servicio)" : "No"}</DetailRow>
            <DetailRow label="Asignada a">{selected.assignedTo ?? "Sin asignar"}</DetailRow>
            <DetailRow label="Creada">{fmtDate(selected.createdAt)}</DetailRow>
            {selected.resolvedAt ? <DetailRow label="Resuelta">{fmtDate(selected.resolvedAt)}</DetailRow> : null}
            <div style={{ marginTop: 6 }}>
              <p className="bo-muted" style={{ fontSize: 12, textTransform: "none", marginBottom: 4 }}>Descripción</p>
              <p style={{ margin: 0, color: "var(--ink)", fontSize: 13.5, lineHeight: 1.5 }}>{selected.description || "Sin descripción."}</p>
            </div>
          </>
        ) : null}
      </SidePanel>
    </section>
  );
}
