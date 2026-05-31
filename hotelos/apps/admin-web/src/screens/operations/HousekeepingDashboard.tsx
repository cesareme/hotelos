import { useMemo, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import {
  createHousekeepingTask,
  markRoomClean,
  markRoomInspected,
  updateHousekeepingTask,
  type HkBoardItem,
  type HkPriority,
  type HkTaskType
} from "../../services/housekeepingApi";
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";
import { toArray } from "../../utils/toArray";

const PROPERTY_ID = getActivePropertyId();

type StatusKind = "ok" | "warn" | "error" | "info";

const HK_STATUS_LABEL: Record<string, string> = {
  dirty: "Sucia",
  clean: "Limpia",
  inspected: "Inspeccionada",
  occupied: "Ocupada",
  out_of_order: "Fuera de servicio",
  out_of_service: "Fuera de servicio"
};
const HK_STATUS_KIND: Record<string, StatusKind> = {
  dirty: "warn",
  clean: "ok",
  inspected: "ok",
  occupied: "info",
  out_of_order: "error",
  out_of_service: "error"
};

const TASK_TYPE_LABEL: Record<string, string> = {
  departure_clean: "Salida (limpieza)",
  stayover: "Cliente alojado",
  inspection: "Inspección",
  deep_clean: "Limpieza a fondo"
};
const TASK_STATUS_LABEL: Record<string, string> = {
  pending: "pendiente",
  assigned: "asignada",
  in_progress: "en curso",
  done: "hecha",
  rejected: "rechazada"
};
const PRIORITY_LABEL: Record<string, string> = { low: "baja", normal: "normal", high: "alta" };
const PRIORITY_KIND: Record<string, StatusKind> = { low: "info", normal: "ok", high: "warn" };

const TASK_TYPES: HkTaskType[] = ["departure_clean", "stayover", "inspection", "deep_clean"];

function hkStatusOf(item: HkBoardItem): string {
  return item.room.housekeepingStatus ?? item.room.status ?? "dirty";
}

const FILTERS: { id: string; label: string; match: (i: HkBoardItem) => boolean }[] = [
  { id: "all", label: "Todas", match: () => true },
  { id: "dirty", label: "Sucias", match: (i) => hkStatusOf(i) === "dirty" },
  { id: "clean", label: "Limpias", match: (i) => hkStatusOf(i) === "clean" },
  { id: "inspected", label: "Inspeccionadas", match: (i) => hkStatusOf(i) === "inspected" },
  { id: "occupied", label: "Ocupadas", match: (i) => hkStatusOf(i) === "occupied" },
  { id: "ooo", label: "Fuera de servicio", match: (i) => hkStatusOf(i) === "out_of_order" || hkStatusOf(i) === "out_of_service" },
  { id: "tasks", label: "Con tareas", match: (i) => i.tasks.length > 0 }
];

function fmtNum(n: number): string {
  return new Intl.NumberFormat("es-ES", { useGrouping: true }).format(n);
}

export function HousekeepingDashboard() {
  const { data, loading, error, refresh } = useApiData<HkBoardItem[]>(
    `/properties/${PROPERTY_ID}/housekeeping/board`,
    { pollIntervalMs: 30000 }
  );
  const board = useMemo(() => toArray<HkBoardItem>(data), [data]);

  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [formRoom, setFormRoom] = useState<string | null>(null);
  const [formType, setFormType] = useState<HkTaskType>("departure_clean");
  const [formPriority, setFormPriority] = useState<HkPriority>("normal");

  const kpis = useMemo(() => {
    const k = { dirty: 0, clean: 0, inspected: 0, occupied: 0, ooo: 0, tasks: 0 };
    for (const item of board) {
      const s = hkStatusOf(item);
      if (s === "dirty") k.dirty += 1;
      else if (s === "clean") k.clean += 1;
      else if (s === "inspected") k.inspected += 1;
      else if (s === "occupied") k.occupied += 1;
      else if (s === "out_of_order" || s === "out_of_service") k.ooo += 1;
      k.tasks += item.tasks.length;
    }
    return k;
  }, [board]);

  const visible = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter) ?? FILTERS[0];
    return board.filter(f.match).sort((a, b) => a.room.number.localeCompare(b.room.number, "es", { numeric: true }));
  }, [board, filter]);

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

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <style>{`
        .hk-room { position: relative; transition: box-shadow .15s ease, transform .15s ease; }
        .hk-room:hover { box-shadow: 0 10px 28px rgba(2,6,23,.22); transform: translateY(-2px); z-index: 6; }
        .hk-hovercard { position: absolute; left: 0; right: 0; bottom: calc(100% + 8px); z-index: 20;
          background: var(--surface, #fff); border: 1px solid var(--line-soft, #e2e8f0); border-radius: 12px;
          box-shadow: 0 12px 32px rgba(2,6,23,.28); padding: 10px 12px; opacity: 0; transform: translateY(6px);
          pointer-events: none; transition: opacity .12s ease, transform .12s ease; }
        .hk-room:hover .hk-hovercard { opacity: 1; transform: translateY(0); }
        .hk-hovercard::after { content: ""; position: absolute; top: 100%; left: 24px; border: 7px solid transparent; border-top-color: var(--surface, #fff); }
        .hk-hc-row { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; padding: 2px 0; }
        .hk-hc-row span:first-child { color: var(--ink-soft, #64748b); }
      `}</style>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>Operaciones · Pisos</p>
          <h2 style={{ color: "var(--ink)" }}>Tablero de pisos</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Estado de cada habitación en vivo. Marca limpiezas, inspecciona y crea tareas para el equipo.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {busy ? <Spinner size="sm" /> : null}
          <button type="button" onClick={refresh} disabled={loading}>↻ Actualizar</button>
        </div>
      </header>

      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      {loading && board.length === 0 ? (
        <LoadingBlock label="Cargando tablero de pisos…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar" message={error} onRetry={refresh} />
      ) : (
        <>
          <div className="rev-kpi-grid">
            <article className="rev-kpi rev-kpi-warn"><div className="rev-kpi-head"><span className="rev-kpi-label">Sucias</span><span className="bo-status warn">limpiar</span></div><div className="rev-kpi-value">{fmtNum(kpis.dirty)}</div></article>
            <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Limpias</span><span className="bo-status ok">listas</span></div><div className="rev-kpi-value">{fmtNum(kpis.clean)}</div></article>
            <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Inspeccionadas</span><span className="bo-status ok">vendibles</span></div><div className="rev-kpi-value">{fmtNum(kpis.inspected)}</div></article>
            <article className={`rev-kpi rev-kpi-${kpis.ooo > 0 ? "error" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Fuera de servicio</span><span className={`bo-status ${kpis.ooo > 0 ? "error" : "ok"}`}>{kpis.ooo > 0 ? "bloqueadas" : "ninguna"}</span></div><div className="rev-kpi-value">{fmtNum(kpis.ooo)}</div></article>
            <article className={`rev-kpi rev-kpi-${kpis.tasks > 0 ? "warn" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Tareas abiertas</span><span className={`bo-status ${kpis.tasks > 0 ? "warn" : "ok"}`}>{kpis.tasks > 0 ? "en curso" : "al día"}</span></div><div className="rev-kpi-value">{fmtNum(kpis.tasks)}</div></article>
          </div>

          <div className="bo-pill-row">
            {FILTERS.map((f) => {
              const count = f.id === "all" ? board.length : board.filter(f.match).length;
              return (
                <button key={f.id} type="button" className={`bo-pill${filter === f.id ? " is-active" : ""}`} style={{ cursor: "pointer" }} onClick={() => setFilter(f.id)}>
                  {f.label} ({count})
                </button>
              );
            })}
          </div>

          {visible.length === 0 ? (
            <EmptyState title="Sin habitaciones" message="No hay habitaciones que coincidan con este filtro." />
          ) : (
            <div className="bo-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
              {visible.map((item) => {
                const s = hkStatusOf(item);
                const statusKind = HK_STATUS_KIND[s] ?? "info";
                const isClean = s === "clean";
                const isInspected = s === "inspected";
                const formOpen = formRoom === item.room.id;
                const maint = item.room.maintenanceStatus ?? "ok";
                const sellable = item.room.sellable;
                return (
                  <article key={item.room.id} className="bo-card hk-room" style={{ background: "var(--surface)", display: "flex", flexDirection: "column", gap: 8 }}>
                    <div className="hk-hovercard">
                      <div style={{ fontWeight: 700, color: "var(--ink)", marginBottom: 4 }}>Habitación {item.room.number}{item.room.floor ? ` · planta ${item.room.floor}` : ""}</div>
                      <div className="hk-hc-row"><span>Estado</span><span><span className={`bo-status ${statusKind}`} style={{ fontSize: 10 }}>{HK_STATUS_LABEL[s] ?? s}</span></span></div>
                      <div className="hk-hc-row"><span>Mantenimiento</span><span><span className={`bo-status ${maint === "ok" ? "ok" : "warn"}`} style={{ fontSize: 10 }}>{maint === "ok" ? "correcto" : maint}</span></span></div>
                      <div className="hk-hc-row"><span>Vendible</span><span><span className={`bo-status ${sellable ? "ok" : "error"}`} style={{ fontSize: 10 }}>{sellable ? "sí" : "no"}</span></span></div>
                      <div className="hk-hc-row"><span>Tareas abiertas</span><span><strong>{item.tasks.length}</strong></span></div>
                      {item.tasks.length > 0 ? (
                        <div style={{ marginTop: 4, fontSize: 12, color: "var(--ink)" }}>
                          {item.tasks.map((t) => `${TASK_TYPE_LABEL[t.taskType] ?? t.taskType} (${TASK_STATUS_LABEL[t.status] ?? t.status})`).join(" · ")}
                        </div>
                      ) : null}
                    </div>
                    <div className="bo-card-head" style={{ marginBottom: 0 }}>
                      <div>
                        <strong style={{ fontSize: 18, color: "var(--ink)" }}>{item.room.number}</strong>
                        {item.room.floor ? <span className="bo-muted" style={{ fontSize: 12 }}> · planta {item.room.floor}</span> : null}
                      </div>
                      <span className={`bo-status ${statusKind}`}>{HK_STATUS_LABEL[s] ?? s}</span>
                    </div>

                    {item.tasks.length > 0 ? (
                      <div className="bo-stack" style={{ gap: 6 }}>
                        {item.tasks.map((t) => {
                          const next = t.status === "in_progress" ? { status: "done", label: "Completar" } : { status: "in_progress", label: "Empezar" };
                          return (
                            <div key={t.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 12.5 }}>
                                {TASK_TYPE_LABEL[t.taskType] ?? t.taskType}{" "}
                                <span className={`bo-status ${PRIORITY_KIND[t.priority] ?? "info"}`} style={{ fontSize: 10 }}>{PRIORITY_LABEL[t.priority] ?? t.priority}</span>{" "}
                                <span className="bo-muted" style={{ fontSize: 11 }}>{TASK_STATUS_LABEL[t.status] ?? t.status}</span>
                              </span>
                              {t.status !== "done" ? (
                                <button type="button" disabled={busy} style={{ minHeight: 30, padding: "2px 10px", fontSize: 12 }} onClick={() => run(() => updateHousekeepingTask(t.id, { status: next.status }), `Tarea ${next.label.toLowerCase()}.`)}>
                                  {next.label}
                                </button>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>Sin tareas abiertas.</p>
                    )}

                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: "auto" }}>
                      {!isClean && !isInspected ? (
                        <button type="button" className="primary" disabled={busy} style={{ minHeight: 32, padding: "4px 10px", fontSize: 12.5 }} onClick={() => run(() => markRoomClean(item.room.id), `Habitación ${item.room.number} marcada limpia.`)}>Marcar limpia</button>
                      ) : null}
                      {isClean ? (
                        <button type="button" className="primary" disabled={busy} style={{ minHeight: 32, padding: "4px 10px", fontSize: 12.5 }} onClick={() => run(() => markRoomInspected(item.room.id), `Habitación ${item.room.number} inspeccionada.`)}>Inspeccionar</button>
                      ) : null}
                      <button type="button" disabled={busy} style={{ minHeight: 32, padding: "4px 10px", fontSize: 12.5 }} onClick={() => { setFormRoom(formOpen ? null : item.room.id); setMsg(null); }}>
                        {formOpen ? "Cancelar" : "+ Tarea"}
                      </button>
                    </div>

                    {formOpen ? (
                      <div className="bo-stack" style={{ gap: 6, borderTop: "1px solid var(--line-soft)", paddingTop: 8 }}>
                        <select value={formType} onChange={(e) => setFormType(e.target.value as HkTaskType)} disabled={busy}>
                          {TASK_TYPES.map((t) => <option key={t} value={t}>{TASK_TYPE_LABEL[t]}</option>)}
                        </select>
                        <select value={formPriority} onChange={(e) => setFormPriority(e.target.value as HkPriority)} disabled={busy}>
                          <option value="low">Prioridad baja</option>
                          <option value="normal">Prioridad normal</option>
                          <option value="high">Prioridad alta</option>
                        </select>
                        <button type="button" className="primary" disabled={busy} style={{ minHeight: 32 }} onClick={() => run(async () => { await createHousekeepingTask({ roomId: item.room.id, taskType: formType, priority: formPriority }); setFormRoom(null); }, "Tarea creada.")}>
                          Crear tarea
                        </button>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
