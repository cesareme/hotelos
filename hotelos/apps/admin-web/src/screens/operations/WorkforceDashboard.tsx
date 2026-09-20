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
//
// Tanda RRHH · RRHH-10 (recon §3.10 «Personal»; RRHH-4 resolveStaff): the time
// clock and the new-shift drawer identify the person by her ficha de personal
// (StaffProfile) chosen in a CocoaSelect fed by GET /payroll/staff-profiles of
// the centre — the same list PayrollScreen uses — and send `{ staffProfileId }`
// through services/workforceApi.ts; no free-text name reaches the API any more
// (it would answer 400 HR_EMPLOYEE_REQUIRED). Without fichas the pickers stay
// disabled and the help points to Finanzas › Nóminas («Nueva ficha»). A created
// shift may come back with rule `warnings` (rest, daily cap, weekly rest,
// overtime; never a block): they are announced in a warning toast. Errors are
// mapped by workforceErrorMessage (APPROVAL_SELF_DECISION when the approver of
// an absence is its requester, HR_INVALID_TRANSITION, HR_EMPLOYEE_REQUIRED…).

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { absenceTypeLabel, approveAbsence, clockIn, clockOut, createShift, recordWarnings, workforceErrorMessage, workforceStaffProfilesPath, type WorkforceStaffProfile } from "../../services/workforceApi";
import { getUser } from "../../services/auth-storage";
import { useNavGate } from "../../navigation/useEnabledModules";
import { canDo } from "../accounting/accounting-ui";
import { useToast } from "../../components/Toast";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, newLabel } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { date, dateRange, number, plural, time } from "../../lib/format";
import { toArray } from "../../utils/toArray";
import { employeeLabel, staffProfileLabelMap, staffProfileOptions } from "../payroll/staff-profile-form";
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
  CocoaSelect,
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
type Absence = { id: string; staffName: string; type: string | null; restricted?: boolean; startDate: string; endDate: string; status: string };
type ClockEntry = { id: string; createdAt?: string; payload?: Record<string, unknown> };
type WorkforceDashboardData = {
  kpis: Kpis;
  staffByDepartment: Array<{ departmentName: string; count: number }>;
  upcomingShifts: Shift[];
  pendingAbsences: Absence[];
};

const EMPTY_KPIS: Kpis = { headcount: 0, activeStaff: 0, hoursWorkedMtd: 0, absencesPending: 0, absencesApproved: 0, nextShiftsToday: 0 };
const MAX_SHIFTS = 12;
const MAX_CLOCK_ENTRIES = 8;
const NEW_SHIFT = newLabel("m", "turno");
const NO_PROFILES_HELP = "No hay fichas de personal en este centro: créalas en Finanzas › Nóminas («Nueva ficha») antes de fichar o crear turnos.";
const NO_OWN_PROFILE_HELP = "No tienes ficha de personal en este centro: pide a RRHH que la cree para poder fichar (con workforce.timeclock.manage se ficha por otras personas).";
const PROFILE_PLACEHOLDER = "Elige una ficha de personal";

function fmtNum(v: number | undefined): string {
  return number(v, { maximumFractionDigits: 1 });
}
function fmtDate(v: string): string {
  return date(v, "dayMonth");
}
function fmtTime(v: string): string {
  return time(v);
}
function absenceLabel(a: Pick<Absence, "type" | "restricted">): string {
  return absenceTypeLabel(a.type, a.restricted === true);
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
        {absenceLabel(a)}
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
  // Fichas de personal of the centre (workforce.read: every template that opens this screen holds it): the only way to name a person.
  const profilesState = useApiData<WorkforceStaffProfile[]>(moduleGate.ready ? workforceStaffProfilesPath(PROPERTY_ID) : null);
  const profiles = useMemo(() => toArray<WorkforceStaffProfile>(profilesState.data).filter((profile) => profile.active), [profilesState.data]);
  const profileOptions = useMemo(() => staffProfileOptions(profiles), [profiles]);
  const profileLabels = useMemo(() => staffProfileLabelMap(profiles), [profiles]);
  const profilesHelp = profilesState.error && !profilesState.data ? `No se pudieron cargar las fichas de personal: ${profilesState.error}` : profilesState.loading && !profilesState.data ? STATUS_LABELS.loading : profiles.length === 0 ? NO_PROFILES_HELP : undefined;
  // Time clock (RF-01): without workforce.timeclock.manage the API only accepts the actor's own ficha, so the picker offers just hers.
  const gate = useNavGate();
  const clocksForOthers = canDo(gate, "workforce.timeclock.manage");
  const ownUserId = getUser()?.userId ?? null;
  const clockProfiles = useMemo(() => (clocksForOthers ? profiles : profiles.filter((profile) => profile.userId === ownUserId)), [clocksForOthers, profiles, ownUserId]);
  const clockOptions = useMemo(() => staffProfileOptions(clockProfiles), [clockProfiles]);
  const clockHelp = profilesHelp ?? (clockProfiles.length === 0 ? NO_OWN_PROFILE_HELP : undefined);
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
  const [clockProfileId, setClockProfileId] = useState("");
  const [showShift, setShowShift] = useState(false);
  const [sStaffProfileId, setSStaffProfileId] = useState("");
  const [sRole, setSRole] = useState("");
  const [sStart, setSStart] = useState("");
  const [sEnd, setSEnd] = useState("");

  function refreshAll() {
    refresh();
    timeClock.refresh();
    profilesState.refresh();
  }

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      showToast(ok, { variant: "success" });
      refreshAll();
    } catch (e) {
      showToast(workforceErrorMessage(e, "No se pudo completar la acción."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  // The ficha chosen for the time clock must still be in the list (a refresh may retire it); a single own ficha is preselected.
  const clockProfile = clockProfiles.some((profile) => profile.id === clockProfileId) ? clockProfileId : clockProfiles.length === 1 ? clockProfiles[0]!.id : "";
  const clockLabel = clockProfile ? employeeLabel(profileLabels, clockProfile) : "";
  const canClock = !busy && clockProfile !== "";
  const canCreateShift = !busy && sStaffProfileId !== "" && sStart !== "" && sEnd !== "";

  function openShiftForm() {
    setShowShift(true);
  }
  function closeShiftForm() {
    setShowShift(false);
  }

  function submitShift() {
    void run(async () => {
      const created = await createShift({ staffProfileId: sStaffProfileId, role: sRole || undefined, startAt: new Date(sStart).toISOString(), endAt: new Date(sEnd).toISOString() });
      setSStaffProfileId("");
      setSRole("");
      setSStart("");
      setSEnd("");
      setShowShift(false);
      // Rule warnings never block the shift: announce them after the success toast so the planner can fix the roster.
      const warnings = recordWarnings(created);
      if (warnings.length > 0) showToast(`Turno con ${plural(warnings.length, "aviso", "avisos")}: ${warnings.map((warning) => warning.message).join(" · ")}`, { variant: "warning" });
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
            <CocoaField label="Ficha de personal" help={clockHelp}>
              <CocoaSelect value={clockProfile} onChange={setClockProfileId} options={clockOptions} placeholder={PROFILE_PLACEHOLDER} disabled={busy || clockProfiles.length === 0} aria-label="Ficha de personal para fichar" />
            </CocoaField>
            <div className="cocoa-row" data-gap="2">
              <CocoaButton variant="filled" tone="accent" size="small" disabled={!canClock} onClick={() => run(() => clockIn(clockProfile), `Entrada registrada para ${clockLabel}.`)}>
                Fichar entrada
              </CocoaButton>
              <CocoaButton variant="bordered" tone="neutral" size="small" disabled={!canClock} onClick={() => run(() => clockOut(clockProfile), `Salida registrada para ${clockLabel}.`)}>
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
        subtitle={selectedAbsence ? absenceLabel(selectedAbsence) : undefined}
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
            <DetailRow label={FIELD_LABELS.type}>{absenceLabel(selectedAbsence)}</DetailRow>
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
        subtitle="Elige la ficha de personal, el puesto y el horario. El turno se crea aunque incumpla una regla del convenio: la pantalla avisa."
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
          <CocoaField label="Ficha de personal" required help={profilesHelp}>
            <CocoaSelect value={sStaffProfileId} onChange={setSStaffProfileId} options={profileOptions} placeholder={PROFILE_PLACEHOLDER} disabled={busy || profiles.length === 0} />
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
