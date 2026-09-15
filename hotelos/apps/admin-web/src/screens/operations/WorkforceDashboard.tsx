// Workforce dashboard — Operaciones › Personal y turnos (/operaciones/personal).
//
// Cocoa 22 (docs/design/COCOA-22.md §4 · ola 4 · lote 4-C): CocoaPage →
// CocoaKpiStrip → CocoaGrid 4/8 (time clock · upcoming shifts as a CocoaTable)
// and 6/6 (pending absences as a CocoaTable with an «Aprobar» row action ·
// headcount by department as CocoaChart.Bars). A shift or absence row opens
// its record in a CocoaDrawer, the new-shift form is a CocoaDrawer too, and
// every outcome is announced through useToast. Data: GET /dashboards/workforce
// plus the live time-clock store, both polled every 30 s — only once the
// workforce_labor module is enabled (qa#14): while the module list loads the
// page keeps its skeleton, and with the module not active it paints «Módulo
// no activado» (+ «Activar módulo» for users with modules.enable) instead of
// KPIs at 0 and a 403 on every poll.

import { useState, type CSSProperties, type ReactNode } from "react";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { approveAbsence, clockIn, clockOut, createShift } from "../../services/workforceApi";
import { useToast } from "../../components/Toast";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, newLabel } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { date, dateRange, number, plural, time } from "../../lib/format";
import { moduleDisabledCopy } from "./module-gate";
import { useScreenModuleGate } from "./useScreenModuleGate";
import {
  CocoaBadge,
  CocoaButton,
  CocoaChart,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaBarsDatum,
  type CocoaTableColumn
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
// Menu labels of the tree (Operaciones › Personal y turnos), never retyped here.
const HEADER = treeHeaderFor("WorkforceDashboard", { eyebrow: "Operaciones", title: "Personal y turnos" });

type Kpis = {
  headcount: number;
  activeStaff: number;
  hoursWorkedMtd: number;
  absencesPending: number;
  absencesApproved: number;
  nextShiftsToday: number;
};
type Shift = { id: string; staffName: string; startAt: string; endAt: string; role?: string };
type Absence = { id: string; staffName: string; type: string; startDate: string; endDate: string; status: string };
type ClockEntry = { id: string; createdAt?: string; payload?: Record<string, unknown> };
type WorkforceDashboardData = {
  kpis: Kpis;
  staffByDepartment: Array<{ departmentName: string; count: number }>;
  upcomingShifts: Shift[];
  pendingAbsences: Absence[];
};

const EMPTY_KPIS: Kpis = { headcount: 0, activeStaff: 0, hoursWorkedMtd: 0, absencesPending: 0, absencesApproved: 0, nextShiftsToday: 0 };
const ABSENCE_TYPE_LABELS: Record<string, string> = { vacation: "vacaciones", sick: "baja médica", personal: "personal", unpaid: "sin sueldo", other: "otro" };
const MAX_SHIFTS = 12;
const MAX_CLOCK_ENTRIES = 8;
const NEW_SHIFT = newLabel("m", "turno");

function fmtNum(v: number | undefined): string {
  return number(v, { maximumFractionDigits: 1 });
}
function fmtDate(v: string): string {
  return date(v, "dayMonth");
}
function fmtTime(v: string): string {
  return time(v);
}
function absenceTypeLabel(type: string): string {
  return ABSENCE_TYPE_LABELS[type] ?? type;
}

/** Calendar days covered by an absence, both ends included. */
function absenceDays(a: Absence): number {
  const start = new Date(a.startDate);
  const end = new Date(a.endDate);
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
}

/** Hours of a shift, one decimal. */
function shiftHours(s: Shift): number {
  const start = new Date(s.startAt);
  const end = new Date(s.endAt);
  return Math.max(0, Math.round(((end.getTime() - start.getTime()) / 3_600_000) * 10) / 10);
}

// Text styles the lists repeat (layout comes from the stylesheet lists).
const growStyle: CSSProperties = { flex: "1 1 auto", minWidth: 0 };
const captionStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};
const secondaryStyle: CSSProperties = { fontSize: "var(--cocoa-fs-footnote)", color: "var(--cocoa-label-secondary)" };
const valueStyle: CSSProperties = {
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  textAlign: "right",
  minWidth: 0
};
const timeStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-footnote)",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
  color: "var(--cocoa-label-secondary)"
};

const SHIFT_COLUMNS: CocoaTableColumn<Shift>[] = [
  { key: "staffName", label: "Empleado", render: (s) => <strong>{s.staffName}</strong> },
  { key: "role", label: "Puesto", hideOnNarrow: true, render: (s) => s.role ?? "—" },
  { key: "date", label: FIELD_LABELS.date, render: (s) => fmtDate(s.startAt) },
  { key: "hours", label: "Horario", align: "right", render: (s) => `${fmtTime(s.startAt)}–${fmtTime(s.endAt)}` }
];

const ABSENCE_COLUMNS: CocoaTableColumn<Absence>[] = [
  { key: "staffName", label: "Empleado", render: (a) => <strong>{a.staffName}</strong> },
  {
    key: "type",
    label: FIELD_LABELS.type,
    render: (a) => (
      <CocoaBadge tone="warning" variant="tinted" size="small">
        {absenceTypeLabel(a.type)}
      </CocoaBadge>
    )
  },
  { key: "period", label: "Periodo", hideOnNarrow: true, render: (a) => dateRange(a.startDate, a.endDate, { style: "dayMonth" }) }
];

/** Label · value row of a record drawer (section-list rhythm: hairline, value at the right). */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li>
      <span style={secondaryStyle}>{label}</span>
      <span style={valueStyle}>{children}</span>
    </li>
  );
}

export function WorkforceDashboard() {
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  // Module gate (qa#14): no request (and no 30 s poll) until workforce_labor
  // is known to be enabled; `null` paths keep useApiData idle.
  const moduleGate = useScreenModuleGate("WorkforceDashboard");
  const { data, loading, error, refresh } = useApiData<WorkforceDashboardData>(
    moduleGate.ready ? `/dashboards/workforce?propertyId=${PROPERTY_ID}` : null,
    { pollIntervalMs: 30000 }
  );
  // Live time-clock entries (round-trip via the generic advanced-records store).
  const timeClock = useApiData<{ items: ClockEntry[] }>(
    moduleGate.ready ? `/workforce/properties/${PROPERTY_ID}/time-clock` : null,
    { pollIntervalMs: 30000 }
  );
  const clockEntries = timeClock.data?.items ?? [];
  const kpis = data?.kpis ?? EMPTY_KPIS;
  const departments = data?.staffByDepartment ?? [];
  const shifts = data?.upcomingShifts ?? [];
  const absences = data?.pendingAbsences ?? [];

  const [busy, setBusy] = useState(false);
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

  function refreshAll() {
    refresh();
    timeClock.refresh();
  }

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      showToast(ok, { variant: "success" });
      refreshAll();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "No se pudo completar la acción.", { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const employee = clockName.trim();
  const canClock = !busy && employee !== "";
  const canCreateShift = !busy && sStaff.trim() !== "" && sStart !== "" && sEnd !== "";

  function openShiftForm() {
    setShowShift(true);
  }
  function closeShiftForm() {
    setShowShift(false);
  }

  function submitShift() {
    void run(async () => {
      await createShift({ staffName: sStaff.trim(), role: sRole || undefined, startAt: new Date(sStart).toISOString(), endAt: new Date(sEnd).toISOString() });
      setSStaff("");
      setSRole("");
      setSStart("");
      setSEnd("");
      setShowShift(false);
    }, "Turno creado.");
  }

  function approve(a: Absence, closeDrawer = false) {
    void run(async () => {
      await approveAbsence(a.id);
      if (closeDrawer) setSelectedAbsenceId(null);
    }, `Ausencia de ${a.staffName} aprobada.`);
  }

  const departmentBars: CocoaBarsDatum[] = departments.map((d) => ({
    label: d.departmentName,
    value: d.count,
    tone: "accent",
    hint: plural(d.count, "empleado", "empleados")
  }));

  // Module not active → the whole body is the «Módulo no activado» state
  // (§3.10: `state="empty"` replaces the body; the write actions would 403 too).
  const moduleDisabled = moduleGate.status === "disabled";
  const disabledCopy = moduleDisabledCopy(moduleGate.canEnable);
  const state =
    moduleGate.status === "loading" ? "loading" : moduleDisabled ? "empty" : loading && !data ? "loading" : error && !data ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
      title={HEADER.title}
      subtitle="Plantilla, fichajes y turnos en vivo. Ficha entradas/salidas, crea turnos y aprueba ausencias."
      actions={
        moduleGate.ready ? (
          <>
            {busy ? <CocoaBadge tone="info">{STATUS_LABELS.saving}</CocoaBadge> : null}
            {error && data ? (
              <CocoaBadge tone="danger" title={error}>
                {STATUS_LABELS.loadError}
              </CocoaBadge>
            ) : null}
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll} disabled={loading} title={ACTIONS.refresh}>
              {ACTIONS.refresh}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" size="small" onClick={openShiftForm}>
              {NEW_SHIFT}
            </CocoaButton>
          </>
        ) : null
      }
      state={state}
      skeleton={<WorkforceSkeleton />}
      empty={{
        title: disabledCopy.title,
        message: disabledCopy.message,
        primaryAction: disabledCopy.cta ? { label: disabledCopy.cta, onClick: moduleGate.enable } : undefined
      }}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refreshAll }}
      commands={
        moduleGate.ready
          ? [
              { id: "workforce-refresh", label: "Actualizar personal y turnos", run: refreshAll },
              { id: "workforce-new-shift", label: NEW_SHIFT, run: openShiftForm }
            ]
          : moduleDisabled && disabledCopy.cta
            ? [{ id: "workforce-enable-module", label: `${disabledCopy.cta} · ${HEADER.title}`, run: moduleGate.enable }]
            : []
      }
    >
      <CocoaKpiStrip stagger aria-label="Indicadores de personal">
        <CocoaKpi label="Plantilla" value={fmtNum(kpis.headcount)} deltaLabel="total" polarity="neutral" status="ok" />
        <CocoaKpi label="Activos hoy" value={fmtNum(kpis.activeStaff)} deltaLabel="en turno" polarity="neutral" status="ok" />
        <CocoaKpi label="Horas (mes)" value={fmtNum(kpis.hoursWorkedMtd)} unit="h" deltaLabel="mes en curso" polarity="neutral" status="ok" />
        <CocoaKpi
          label="Ausencias pendientes"
          value={fmtNum(kpis.absencesPending)}
          deltaLabel={kpis.absencesPending > 0 ? "por aprobar" : "al día"}
          polarity="neutral"
          status={kpis.absencesPending > 0 ? "warning" : "ok"}
        />
        <CocoaKpi label="Turnos hoy" value={fmtNum(kpis.nextShiftsToday)} deltaLabel="próximos" polarity="neutral" status="ok" />
      </CocoaKpiStrip>

      <CocoaGrid align="start">
        <CocoaSpan cols={4} min={320}>
          <CocoaSection title="Fichaje" meta="entrada / salida">
            <CocoaField label="Nombre del empleado">
              <CocoaInput value={clockName} onChange={setClockName} placeholder="Nombre del empleado" disabled={busy} autoComplete="off" />
            </CocoaField>
            <div className="cocoa-row" data-gap="2">
              <CocoaButton variant="filled" tone="accent" size="small" disabled={!canClock} onClick={() => run(() => clockIn(employee), `Entrada registrada para ${employee}.`)}>
                Fichar entrada
              </CocoaButton>
              <CocoaButton variant="bordered" tone="neutral" size="small" disabled={!canClock} onClick={() => run(() => clockOut(employee), `Salida registrada para ${employee}.`)}>
                Fichar salida
              </CocoaButton>
            </div>
            <span style={captionStyle}>Fichajes recientes</span>
            {clockEntries.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin fichajes recientes." />
            ) : (
              <ol className="c22-section__list" aria-label="Fichajes recientes">
                {clockEntries.slice(0, MAX_CLOCK_ENTRIES).map((e) => {
                  const out = e.payload?.action === "out";
                  return (
                    <li key={e.id}>
                      <CocoaBadge tone={out ? "info" : "success"} variant="dot" size="small">
                        {out ? "salida" : "entrada"}
                      </CocoaBadge>
                      <span style={growStyle}>
                        <strong>{String(e.payload?.staffName ?? "—")}</strong>
                      </span>
                      <time dateTime={e.createdAt} style={timeStyle}>
                        {time(e.createdAt, { empty: "" })}
                      </time>
                    </li>
                  );
                })}
              </ol>
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={8} min={480}>
          <CocoaSection
            title="Próximos turnos"
            meta={plural(shifts.length, "turno", "turnos")}
            action={
              <CocoaButton variant="plain" tone="accent" size="small" onClick={openShiftForm}>
                {NEW_SHIFT}
              </CocoaButton>
            }
            padding={shifts.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {shifts.length === 0 ? (
              <CocoaState
                kind="empty"
                title="No hay turnos próximos"
                message="Crea el primer turno desde el botón superior o programa la planificación semanal."
                primaryAction={{ label: NEW_SHIFT, onClick: openShiftForm }}
              />
            ) : (
              <CocoaTable
                columns={SHIFT_COLUMNS}
                rows={shifts.slice(0, MAX_SHIFTS)}
                rowKey="id"
                selectedKey={selectedShiftId ?? undefined}
                onSelect={(s) => setSelectedShiftId(s.id)}
                caption="Próximos turnos"
                aria-label="Próximos turnos"
              />
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Ausencias pendientes"
            meta={plural(absences.length, "solicitud", "solicitudes")}
            padding={absences.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {absences.length === 0 ? (
              <CocoaState
                kind="empty"
                title="No hay ausencias pendientes"
                message="Cuando algún empleado solicite una baja o ausencia aparecerá aquí para revisar y aprobar."
              />
            ) : (
              <CocoaTable
                columns={ABSENCE_COLUMNS}
                rows={absences}
                rowKey="id"
                selectedKey={selectedAbsenceId ?? undefined}
                onSelect={(a) => setSelectedAbsenceId(a.id)}
                rowActions={(a) => (
                  <CocoaButton variant="tinted" tone="accent" size="small" disabled={busy} onClick={() => approve(a)}>
                    {ACTIONS.approve}
                  </CocoaButton>
                )}
                caption="Ausencias pendientes"
                aria-label="Ausencias pendientes"
              />
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Plantilla por departamento" meta={plural(departments.length, "departamento", "departamentos")}>
            {departments.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin plantilla asignada por departamento." />
            ) : (
              <CocoaChart.Bars data={departmentBars} valueFormat={fmtNum} aria-label="Plantilla por departamento" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaDrawer
        open={selectedAbsence !== null}
        onClose={() => setSelectedAbsenceId(null)}
        title={selectedAbsence ? `Ausencia · ${selectedAbsence.staffName}` : "Ausencia"}
        subtitle={selectedAbsence ? absenceTypeLabel(selectedAbsence.type) : undefined}
        side="right"
        size="sm"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelectedAbsenceId(null)}>
              {ACTIONS.close}
            </CocoaButton>
            {selectedAbsence && selectedAbsence.status === "pending" ? (
              <CocoaButton variant="filled" tone="accent" loading={busy} disabled={busy} onClick={() => approve(selectedAbsence, true)}>
                {ACTIONS.approve}
              </CocoaButton>
            ) : null}
          </>
        }
      >
        {selectedAbsence ? (
          <ul className="c22-section__list" aria-label="Ficha de la ausencia">
            <DetailRow label="Empleado">{selectedAbsence.staffName}</DetailRow>
            <DetailRow label={FIELD_LABELS.type}>{absenceTypeLabel(selectedAbsence.type)}</DetailRow>
            <DetailRow label={FIELD_LABELS.status}>
              {selectedAbsence.status === "pending" ? (
                <CocoaBadge tone="warning">pendiente</CocoaBadge>
              ) : (
                <CocoaBadge tone="success">{selectedAbsence.status}</CocoaBadge>
              )}
            </DetailRow>
            <DetailRow label={FIELD_LABELS.from}>{fmtDate(selectedAbsence.startDate)}</DetailRow>
            <DetailRow label={FIELD_LABELS.to}>{fmtDate(selectedAbsence.endDate)}</DetailRow>
            <DetailRow label="Duración">{plural(absenceDays(selectedAbsence), "día", "días")}</DetailRow>
          </ul>
        ) : null}
      </CocoaDrawer>

      <CocoaDrawer
        open={selectedShift !== null}
        onClose={() => setSelectedShiftId(null)}
        title={selectedShift ? `Turno · ${selectedShift.staffName}` : "Turno"}
        subtitle={selectedShift?.role}
        side="right"
        size="sm"
        footer={
          <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelectedShiftId(null)}>
            {ACTIONS.close}
          </CocoaButton>
        }
      >
        {selectedShift ? (
          <ul className="c22-section__list" aria-label="Ficha del turno">
            <DetailRow label="Empleado">{selectedShift.staffName}</DetailRow>
            {selectedShift.role ? <DetailRow label="Puesto">{selectedShift.role}</DetailRow> : null}
            <DetailRow label={FIELD_LABELS.date}>{date(selectedShift.startAt, "weekday")}</DetailRow>
            <DetailRow label="Entrada">{fmtTime(selectedShift.startAt)}</DetailRow>
            <DetailRow label="Salida">{fmtTime(selectedShift.endAt)}</DetailRow>
            <DetailRow label="Duración">{`${fmtNum(shiftHours(selectedShift))} h`}</DetailRow>
          </ul>
        ) : null}
      </CocoaDrawer>

      <CocoaDrawer
        open={showShift}
        onClose={closeShiftForm}
        title={NEW_SHIFT}
        subtitle="Asigna empleado, puesto y horario."
        side="right"
        size="md"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={closeShiftForm} disabled={busy}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" loading={busy} disabled={!canCreateShift} onClick={submitShift}>
              Crear turno
            </CocoaButton>
          </>
        }
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Empleado" required>
            <CocoaInput value={sStaff} onChange={setSStaff} placeholder="Empleado" disabled={busy} autoComplete="off" />
          </CocoaField>
          <CocoaField label="Puesto" hint={STATUS_LABELS.optional}>
            <CocoaInput value={sRole} onChange={setSRole} placeholder="Puesto (ej.: recepción)" disabled={busy} />
          </CocoaField>
          <CocoaFormRow columns={2}>
            <CocoaField label="Inicio" required>
              <CocoaInput type="datetime-local" value={sStart} onChange={setSStart} disabled={busy} />
            </CocoaField>
            <CocoaField label="Fin" required>
              <CocoaInput type="datetime-local" value={sEnd} onChange={setSEnd} disabled={busy} />
            </CocoaField>
          </CocoaFormRow>
        </div>
      </CocoaDrawer>
    </CocoaPage>
  );
}

// Mirror skeleton: the KPI strip and the 4/8 + 6/6 grid.
function WorkforceSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[4, 8], [6, 6]]} height={220} />
    </div>
  );
}

export default WorkforceDashboard;
