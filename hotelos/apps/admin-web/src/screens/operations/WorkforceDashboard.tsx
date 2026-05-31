import { useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { approveAbsence, clockIn, clockOut, createShift } from "../../services/workforceApi";
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";
import { SidePanel, DetailRow } from "../../components/SidePanel";

const PROPERTY_ID = getActivePropertyId();

type Kpis = {
  headcount: number;
  activeStaff: number;
  hoursWorkedMtd: number;
  absencesPending: number;
  absencesApproved: number;
  nextShiftsToday: number;
};
type WorkforceDashboardData = {
  kpis: Kpis;
  staffByDepartment: Array<{ departmentName: string; count: number }>;
  upcomingShifts: Array<{ id: string; staffName: string; startAt: string; endAt: string; role?: string }>;
  pendingAbsences: Array<{ id: string; staffName: string; type: string; startDate: string; endDate: string; status: string }>;
};

const ABSENCE_TYPE_LABELS: Record<string, string> = { vacation: "vacaciones", sick: "baja médica", personal: "personal", unpaid: "sin sueldo", other: "otro" };

function fmtNum(v: number | undefined): string {
  return new Intl.NumberFormat("es-ES", { useGrouping: true, maximumFractionDigits: 1 }).format(v ?? 0);
}
function fmtDate(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
}
function fmtTime(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

export function WorkforceDashboard() {
  const { data, loading, error, refresh } = useApiData<WorkforceDashboardData>(
    `/dashboards/workforce?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 30000 }
  );
  // Live time-clock entries (round-trip via the generic advanced-records store).
  const timeClock = useApiData<{ items: Array<{ id: string; createdAt?: string; payload?: Record<string, unknown> }> }>(
    `/workforce/properties/${PROPERTY_ID}/time-clock`,
    { pollIntervalMs: 30000 }
  );
  const clockEntries = timeClock.data?.items ?? [];
  const kpis = data?.kpis ?? { headcount: 0, activeStaff: 0, hoursWorkedMtd: 0, absencesPending: 0, absencesApproved: 0, nextShiftsToday: 0 };
  const departments = data?.staffByDepartment ?? [];
  const shifts = data?.upcomingShifts ?? [];
  const absences = data?.pendingAbsences ?? [];

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const selectedShift = shifts.find((s) => s.id === selectedShiftId) ?? null;
  const [selectedAbsenceId, setSelectedAbsenceId] = useState<string | null>(null);
  const selectedAbsence = absences.find((a) => a.id === selectedAbsenceId) ?? null;
  const [clockName, setClockName] = useState("");
  const [showShift, setShowShift] = useState(false);
  const [sStaff, setSStaff] = useState("");
  const [sRole, setSRole] = useState("");
  const [sStart, setSStart] = useState("");
  const [sEnd, setSEnd] = useState("");

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      refresh();
      timeClock.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>Operaciones · Personal</p>
          <h2 style={{ color: "var(--ink)" }}>Tablero de personal y turnos</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Plantilla, fichajes y turnos en vivo. Ficha entradas/salidas, crea turnos y aprueba ausencias.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {busy ? <Spinner size="sm" /> : null}
          <button type="button" onClick={refresh} disabled={loading}>↻ Actualizar</button>
        </div>
      </header>

      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      {loading && !data ? (
        <LoadingBlock label="Cargando personal…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar" message={error} onRetry={refresh} />
      ) : (
        <>
          <div className="rev-kpi-grid">
            <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Plantilla</span><span className="bo-status info">total</span></div><div className="rev-kpi-value">{fmtNum(kpis.headcount)}</div></article>
            <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Activos hoy</span><span className="bo-status ok">en turno</span></div><div className="rev-kpi-value">{fmtNum(kpis.activeStaff)}</div></article>
            <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Horas (mes)</span><span className="bo-status info">MTD</span></div><div className="rev-kpi-value">{fmtNum(kpis.hoursWorkedMtd)}</div></article>
            <article className={`rev-kpi rev-kpi-${kpis.absencesPending > 0 ? "warn" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Ausencias pendientes</span><span className={`bo-status ${kpis.absencesPending > 0 ? "warn" : "ok"}`}>{kpis.absencesPending > 0 ? "aprobar" : "al día"}</span></div><div className="rev-kpi-value">{fmtNum(kpis.absencesPending)}</div></article>
            <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Turnos hoy</span><span className="bo-status info">próximos</span></div><div className="rev-kpi-value">{fmtNum(kpis.nextShiftsToday)}</div></article>
          </div>

          {/* Fichaje */}
          <article className="bo-card" style={{ background: "var(--surface)" }}>
            <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Fichaje (entrada / salida)</h3></div>
            <div className="bo-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input value={clockName} onChange={(e) => setClockName(e.target.value)} placeholder="Nombre del empleado" disabled={busy} style={{ minWidth: 220 }} />
              <button type="button" className="primary" disabled={busy || !clockName.trim()} onClick={() => run(() => clockIn(clockName.trim()), `Entrada registrada para ${clockName.trim()}.`)}>Fichar entrada</button>
              <button type="button" disabled={busy || !clockName.trim()} onClick={() => run(() => clockOut(clockName.trim()), `Salida registrada para ${clockName.trim()}.`)}>Fichar salida</button>
            </div>
            {clockEntries.length > 0 ? (
              <div className="bo-stack" style={{ gap: 4, marginTop: 10 }}>
                <span className="bo-muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>Fichajes recientes</span>
                {clockEntries.slice(0, 8).map((e) => (
                  <div key={e.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
                    <span><strong>{String(e.payload?.staffName ?? "—")}</strong> <span className={`bo-status ${e.payload?.action === "out" ? "info" : "ok"}`} style={{ fontSize: 10 }}>{e.payload?.action === "out" ? "salida" : "entrada"}</span></span>
                    <span className="bo-muted" style={{ fontSize: 12 }}>{e.createdAt ? new Date(e.createdAt).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </article>

          <div className="bo-grid two">
            {/* Turnos */}
            <article className="bo-card" style={{ background: "var(--surface)" }}>
              <div className="bo-card-head">
                <h3 style={{ color: "var(--ink)" }}>Próximos turnos</h3>
                <button type="button" onClick={() => { setShowShift((v) => !v); setMsg(null); }}>{showShift ? "Cancelar" : "+ Nuevo turno"}</button>
              </div>
              {showShift ? (
                <div className="bo-stack" style={{ gap: 6, marginBottom: 10 }}>
                  <input value={sStaff} onChange={(e) => setSStaff(e.target.value)} placeholder="Empleado" disabled={busy} />
                  <input value={sRole} onChange={(e) => setSRole(e.target.value)} placeholder="Puesto (ej.: recepción)" disabled={busy} />
                  <div className="bo-row" style={{ gap: 6 }}>
                    <input type="datetime-local" value={sStart} onChange={(e) => setSStart(e.target.value)} disabled={busy} />
                    <input type="datetime-local" value={sEnd} onChange={(e) => setSEnd(e.target.value)} disabled={busy} />
                  </div>
                  <button type="button" className="primary" disabled={busy || !sStaff.trim() || !sStart || !sEnd} onClick={() => run(async () => {
                    await createShift({ staffName: sStaff.trim(), role: sRole || undefined, startAt: new Date(sStart).toISOString(), endAt: new Date(sEnd).toISOString() });
                    setSStaff(""); setSRole(""); setSStart(""); setSEnd(""); setShowShift(false);
                  }, "Turno creado.")}>Crear turno</button>
                </div>
              ) : null}
              {shifts.length === 0 ? (
                <EmptyState
                  title="No hay turnos próximos"
                  message="Crea el primer turno desde el botón superior o programa la planificación semanal."
                />
              ) : (
                <div className="bo-stack" style={{ gap: 6 }}>
                  {shifts.slice(0, 12).map((s) => (
                    <div key={s.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, borderBottom: "1px solid var(--line-soft)", paddingBottom: 6, cursor: "pointer" }} onClick={() => setSelectedShiftId(s.id)} title="Ver ficha del turno">
                      <span><strong>{s.staffName}</strong>{s.role ? <span className="bo-muted" style={{ fontSize: 12 }}> · {s.role}</span> : null}</span>
                      <span className="bo-muted" style={{ fontSize: 12 }}>{fmtDate(s.startAt)} {fmtTime(s.startAt)}–{fmtTime(s.endAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </article>

            {/* Ausencias */}
            <article className="bo-card" style={{ background: "var(--surface)" }}>
              <div className="bo-card-head">
                <h3 style={{ color: "var(--ink)" }}>Ausencias pendientes</h3>
                <span className="bo-chip">{absences.length}</span>
              </div>
              {absences.length === 0 ? (
                <EmptyState
                  title="No hay ausencias pendientes"
                  message="Cuando algún empleado solicite una baja o ausencia aparecerá aquí para revisar y aprobar."
                />
              ) : (
                <div className="bo-stack" style={{ gap: 6 }}>
                  {absences.map((a) => (
                    <div key={a.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", borderBottom: "1px solid var(--line-soft)", paddingBottom: 6 }}>
                      <span style={{ cursor: "pointer", flex: 1 }} onClick={() => setSelectedAbsenceId(a.id)} title="Ver ficha de la ausencia">
                        <strong>{a.staffName}</strong>{" "}
                        <span className="bo-status warn" style={{ fontSize: 10 }}>{ABSENCE_TYPE_LABELS[a.type] ?? a.type}</span>{" "}
                        <span className="bo-muted" style={{ fontSize: 12 }}>{fmtDate(a.startDate)} → {fmtDate(a.endDate)}</span>
                      </span>
                      <button type="button" className="primary" disabled={busy} style={{ minHeight: 30, padding: "2px 10px", fontSize: 12 }} onClick={() => run(() => approveAbsence(a.id), `Ausencia de ${a.staffName} aprobada.`)}>Aprobar</button>
                    </div>
                  ))}
                </div>
              )}
            </article>
          </div>

          {departments.length > 0 ? (
            <article className="bo-card" style={{ background: "var(--surface)" }}>
              <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Plantilla por departamento</h3></div>
              <div className="bo-pill-row">
                {departments.map((d) => (
                  <span key={d.departmentName} className="bo-status info" style={{ textTransform: "none" }}>{d.departmentName}: {fmtNum(d.count)}</span>
                ))}
              </div>
            </article>
          ) : null}
        </>
      )}

      <SidePanel
        open={!!selectedAbsence}
        title={selectedAbsence ? `Ausencia · ${selectedAbsence.staffName}` : ""}
        subtitle={selectedAbsence ? ABSENCE_TYPE_LABELS[selectedAbsence.type] ?? selectedAbsence.type : undefined}
        onClose={() => setSelectedAbsenceId(null)}
        footer={selectedAbsence && selectedAbsence.status === "pending" ? (
          <button type="button" className="primary" disabled={busy} onClick={() => run(async () => { await approveAbsence(selectedAbsence.id); setSelectedAbsenceId(null); }, `Ausencia de ${selectedAbsence.staffName} aprobada.`)}>Aprobar</button>
        ) : undefined}
      >
        {selectedAbsence ? (() => {
          const start = new Date(selectedAbsence.startDate);
          const end = new Date(selectedAbsence.endDate);
          const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
          return (
            <>
              <DetailRow label="Empleado">{selectedAbsence.staffName}</DetailRow>
              <DetailRow label="Tipo">{ABSENCE_TYPE_LABELS[selectedAbsence.type] ?? selectedAbsence.type}</DetailRow>
              <DetailRow label="Estado">{selectedAbsence.status === "pending" ? <span className="bo-status warn">pendiente</span> : <span className="bo-status ok">{selectedAbsence.status}</span>}</DetailRow>
              <DetailRow label="Desde">{fmtDate(selectedAbsence.startDate)}</DetailRow>
              <DetailRow label="Hasta">{fmtDate(selectedAbsence.endDate)}</DetailRow>
              <DetailRow label="Duración">{fmtNum(days)} día{days === 1 ? "" : "s"}</DetailRow>
            </>
          );
        })() : null}
      </SidePanel>

      <SidePanel
        open={!!selectedShift}
        title={selectedShift ? `Turno · ${selectedShift.staffName}` : ""}
        subtitle={selectedShift?.role ?? undefined}
        onClose={() => setSelectedShiftId(null)}
      >
        {selectedShift ? (() => {
          const start = new Date(selectedShift.startAt);
          const end = new Date(selectedShift.endAt);
          const hours = Math.max(0, Math.round(((end.getTime() - start.getTime()) / 3_600_000) * 10) / 10);
          return (
            <>
              <DetailRow label="Empleado">{selectedShift.staffName}</DetailRow>
              {selectedShift.role ? <DetailRow label="Puesto">{selectedShift.role}</DetailRow> : null}
              <DetailRow label="Fecha">{start.toLocaleDateString("es-ES", { weekday: "long", day: "2-digit", month: "long" })}</DetailRow>
              <DetailRow label="Entrada">{fmtTime(selectedShift.startAt)}</DetailRow>
              <DetailRow label="Salida">{fmtTime(selectedShift.endAt)}</DetailRow>
              <DetailRow label="Duración">{fmtNum(hours)} h</DetailRow>
            </>
          );
        })() : null}
      </SidePanel>
    </section>
  );
}
