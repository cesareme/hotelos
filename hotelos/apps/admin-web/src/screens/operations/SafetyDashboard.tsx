// Safety dashboard — Operaciones › Seguridad e incidentes (/operaciones/seguridad).
//
// Cocoa 22 (docs/design/COCOA-22.md §4 · ola 4 · lote 4-C): CocoaPage →
// CocoaKpiStrip → CocoaGrid 7/5 (recent incidents as a CocoaTable with a
// «Marcar gestionado» row action · upcoming inspections as a CocoaTable). An
// incident row opens its record in a CocoaDrawer, «Registrar incidente» opens
// the form in a CocoaDrawer, and every outcome is announced through useToast.
// Data: GET /dashboards/safety (KPIs, inspections) plus the live incidents
// store, both polled every 30 s — only once the safety_incident_management
// module is enabled (qa#14): while the module list loads the page keeps its
// skeleton, and with the module not active it paints «Módulo no activado»
// (+ «Activar módulo» for users with modules.enable) instead of KPIs at 0 and
// a 403 on every poll.

import { useState, type CSSProperties, type ReactNode } from "react";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { createIncident, updateIncident, type IncidentSeverity } from "../../services/safetyApi";
import { useToast } from "../../components/Toast";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, newLabel } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { date, number, percent, plural } from "../../lib/format";
import { moduleDisabledCopy } from "./module-gate";
import { useScreenModuleGate } from "./useScreenModuleGate";
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
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
// Menu labels of the tree (Operaciones › Seguridad e incidentes), never retyped here.
const HEADER = treeHeaderFor("SafetyDashboard", { eyebrow: "Operaciones", title: "Seguridad e incidentes" });

type IncidentRow = {
  id: string;
  title: string;
  severity?: string;
  status: string;
  occurredAt?: string;
  reportedAt?: string;
  incidentType?: string;
  description?: string;
  location?: string;
  assignedTo?: string;
  resolvedAt?: string;
};
type SafetyCheck = { id: string; name: string; dueAt?: string; assignedTo?: string };
type Kpis = { incidents30d: number; criticalIncidents30d: number; safetyChecksCompletedPct: number; nextInspections: number; openIncidents: number };
type SafetyDashboardData = {
  kpis: Kpis;
  incidentsBySeverity: Array<{ severity: string; count: number }>;
  recentIncidents: IncidentRow[];
  upcomingChecks: SafetyCheck[];
};
type LiveIncident = { id: string; status?: string; createdAt?: string; payload?: Record<string, unknown> };

const INCIDENT_TYPE_LABEL: Record<string, string> = {
  slip_fall: "Resbalón / caída",
  fire_safety: "Seguridad contra incendios",
  theft: "Robo / sustracción",
  medical: "Médico",
  other: "Otro"
};
const SEV_LABEL: Record<string, string> = { low: "baja", medium: "media", high: "alta", critical: "crítica" };
const SEV_TONE: Record<string, CocoaTone> = { low: "info", medium: "warning", high: "warning", critical: "danger" };
const SEVERITIES: IncidentSeverity[] = ["low", "medium", "high", "critical"];
const SEVERITY_OPTIONS = SEVERITIES.map((s) => ({ value: s, label: SEV_LABEL[s] }));
const EMPTY_KPIS: Kpis = { incidents30d: 0, criticalIncidents30d: 0, safetyChecksCompletedPct: 0, nextInspections: 0, openIncidents: 0 };
const MAX_ROWS = 12;
const NEW_INCIDENT = "Registrar incidente";
const HANDLED_LABEL = "Marcar gestionado";

function fmtNum(v: number | undefined): string {
  return number(v);
}
function fmtDate(v?: string): string {
  return date(v, "dayMonth");
}
function severityLabel(severity: string): string {
  return SEV_LABEL[severity] ?? severity;
}
function severityTone(severity: string): CocoaTone {
  return SEV_TONE[severity] ?? "info";
}
function handled(status: string): boolean {
  return status === "resolved" || status === "closed" || status === "updated";
}

// Text styles the drawer repeats (layout comes from the stylesheet lists).
const secondaryStyle: CSSProperties = { fontSize: "var(--cocoa-fs-footnote)", color: "var(--cocoa-label-secondary)" };
const valueStyle: CSSProperties = {
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  textAlign: "right",
  minWidth: 0
};
const bodyStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-body)",
  lineHeight: "var(--cocoa-lh-body)",
  color: "var(--cocoa-label)"
};

function SeverityBadge({ severity }: { severity?: string }) {
  if (!severity) return <>—</>;
  return (
    <CocoaBadge tone={severityTone(severity)} variant="tinted" size="small">
      {severityLabel(severity)}
    </CocoaBadge>
  );
}

function StatusBadge({ status }: { status: string }) {
  return handled(status) ? (
    <CocoaBadge tone="success" size="small">
      gestionado
    </CocoaBadge>
  ) : (
    <CocoaBadge tone="warning" size="small">
      abierto
    </CocoaBadge>
  );
}

/** Label · value row of the record drawer (section-list rhythm: hairline, value at the right). */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li>
      <span style={secondaryStyle}>{label}</span>
      <span style={valueStyle}>{children}</span>
    </li>
  );
}

const INCIDENT_COLUMNS: CocoaTableColumn<IncidentRow>[] = [
  { key: "severity", label: "Gravedad", render: (i) => <SeverityBadge severity={i.severity} /> },
  { key: "title", label: "Incidente", render: (i) => <strong>{i.title}</strong> },
  { key: "date", label: FIELD_LABELS.date, hideOnNarrow: true, render: (i) => fmtDate(i.occurredAt ?? i.reportedAt) },
  { key: "status", label: FIELD_LABELS.status, align: "right", render: (i) => <StatusBadge status={i.status} /> }
];

const CHECK_COLUMNS: CocoaTableColumn<SafetyCheck>[] = [
  { key: "name", label: "Inspección", render: (c) => <strong>{c.name}</strong> },
  { key: "assignedTo", label: "Asignada a", hideOnNarrow: true, render: (c) => c.assignedTo ?? "—" },
  { key: "dueAt", label: FIELD_LABELS.date, align: "right", render: (c) => fmtDate(c.dueAt) }
];

export function SafetyDashboard() {
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  // Module gate (qa#14): no request (and no 30 s poll) until
  // safety_incident_management is known to be enabled; `null` paths keep
  // useApiData idle.
  const moduleGate = useScreenModuleGate("SafetyDashboard");
  const { data, loading, error, refresh } = useApiData<SafetyDashboardData>(
    moduleGate.ready ? `/dashboards/safety?propertyId=${PROPERTY_ID}` : null,
    { pollIntervalMs: 30000 }
  );
  // Read incidents from the LIVE advanced-records endpoint (same source the
  // "Registrar incidente" action writes to) so new incidents appear instantly.
  const liveIncidents = useApiData<{ items: LiveIncident[] }>(
    moduleGate.ready ? `/safety/properties/${PROPERTY_ID}/incidents` : null,
    { pollIntervalMs: 30000 }
  );

  const kpis = data?.kpis ?? EMPTY_KPIS;
  const live = liveIncidents.data?.items ?? [];
  const incidents: IncidentRow[] =
    live.length > 0
      ? live
          .map((r) => ({
            id: r.id,
            title: String(r.payload?.title ?? "Incidente"),
            severity: r.payload?.severity ? String(r.payload.severity) : undefined,
            status: String(r.status ?? "open"),
            incidentType: r.payload?.incidentType ? String(r.payload.incidentType) : undefined,
            description: r.payload?.description ? String(r.payload.description) : undefined,
            location: r.payload?.location ? String(r.payload.location) : undefined,
            occurredAt: String(r.payload?.occurredAt ?? r.createdAt ?? ""),
            reportedAt: r.createdAt ? String(r.createdAt) : undefined
          }))
          .sort((a, b) => (b.occurredAt ?? "").localeCompare(a.occurredAt ?? ""))
      : (data?.recentIncidents ?? []);
  const checks = data?.upcomingChecks ?? [];

  function refreshAll() {
    refresh();
    liveIncidents.refresh();
  }

  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = incidents.find((i) => i.id === selectedId) ?? null;
  const [show, setShow] = useState(false);
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<IncidentSeverity>("medium");
  const [location, setLocation] = useState("");
  const [desc, setDesc] = useState("");

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

  function openForm() {
    setShow(true);
  }
  function closeForm() {
    setShow(false);
  }

  function submitIncident() {
    void run(async () => {
      await createIncident({ title: title.trim(), severity, location: location || undefined, description: desc || undefined });
      setTitle("");
      setLocation("");
      setDesc("");
      setSeverity("medium");
      setShow(false);
    }, "Incidente registrado.");
  }

  function markHandled(incident: IncidentRow, closeDrawer = false) {
    void run(async () => {
      await updateIncident(incident.id, { status: "resolved", handledAt: new Date().toISOString() });
      if (closeDrawer) setSelectedId(null);
    }, "Incidente marcado como gestionado.");
  }

  const canSubmit = !busy && title.trim() !== "";
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
      subtitle="Registra incidentes en vivo, haz seguimiento y revisa las inspecciones de seguridad pendientes."
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
            <CocoaButton variant="filled" tone="accent" size="small" onClick={openForm}>
              {NEW_INCIDENT}
            </CocoaButton>
          </>
        ) : null
      }
      state={state}
      skeleton={<SafetySkeleton />}
      empty={{
        title: disabledCopy.title,
        message: disabledCopy.message,
        primaryAction: disabledCopy.cta ? { label: disabledCopy.cta, onClick: moduleGate.enable } : undefined
      }}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refreshAll }}
      commands={
        moduleGate.ready
          ? [
              { id: "safety-refresh", label: "Actualizar seguridad e incidentes", run: refreshAll },
              { id: "safety-new-incident", label: NEW_INCIDENT, run: openForm }
            ]
          : moduleDisabled && disabledCopy.cta
            ? [{ id: "safety-enable-module", label: `${disabledCopy.cta} · ${HEADER.title}`, run: moduleGate.enable }]
            : []
      }
    >
      <CocoaKpiStrip stagger aria-label="Indicadores de seguridad">
        <CocoaKpi
          label="Incidentes abiertos"
          value={fmtNum(kpis.openIncidents)}
          deltaLabel={kpis.openIncidents > 0 ? "gestionar" : "al día"}
          polarity="neutral"
          status={kpis.openIncidents > 0 ? "warning" : "ok"}
        />
        <CocoaKpi
          label="Críticos (30 d)"
          value={fmtNum(kpis.criticalIncidents30d)}
          deltaLabel={kpis.criticalIncidents30d > 0 ? "atención" : "ninguno"}
          polarity="neutral"
          status={kpis.criticalIncidents30d > 0 ? "critical" : "ok"}
        />
        <CocoaKpi label="Incidentes (30 d)" value={fmtNum(kpis.incidents30d)} deltaLabel="total" polarity="neutral" status="ok" />
        <CocoaKpi label="Checks completados" value={percent(kpis.safetyChecksCompletedPct)} deltaLabel="comprobaciones de seguridad" polarity="neutral" status="ok" />
        <CocoaKpi
          label="Inspecciones próximas"
          value={fmtNum(kpis.nextInspections)}
          deltaLabel={kpis.nextInspections > 0 ? "pendientes" : "ninguna"}
          polarity="neutral"
          status={kpis.nextInspections > 0 ? "warning" : "ok"}
        />
      </CocoaKpiStrip>

      <CocoaGrid align="start">
        <CocoaSpan cols={7} min={480}>
          <CocoaSection
            title="Incidentes recientes"
            meta={plural(incidents.length, "incidente", "incidentes")}
            padding={incidents.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {incidents.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin incidentes registrados." />
            ) : (
              <CocoaTable
                columns={INCIDENT_COLUMNS}
                rows={incidents.slice(0, MAX_ROWS)}
                rowKey="id"
                selectedKey={selectedId ?? undefined}
                onSelect={(i) => setSelectedId(i.id)}
                rowActions={(i) =>
                  handled(i.status) ? null : (
                    <CocoaButton variant="tinted" tone="accent" size="small" disabled={busy} onClick={() => markHandled(i)}>
                      {HANDLED_LABEL}
                    </CocoaButton>
                  )
                }
                caption="Incidentes recientes"
                aria-label="Incidentes recientes"
              />
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={5} min={320}>
          <CocoaSection
            title="Inspecciones próximas"
            meta={plural(checks.length, "inspección", "inspecciones")}
            padding={checks.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {checks.length === 0 ? (
              <CocoaState
                kind="empty"
                title="No hay inspecciones de seguridad pendientes"
                message="Programa una nueva inspección cuando toque revisar extintores, salidas de emergencia u otros chequeos."
              />
            ) : (
              <CocoaTable columns={CHECK_COLUMNS} rows={checks.slice(0, MAX_ROWS)} rowKey="id" caption="Inspecciones próximas" aria-label="Inspecciones próximas" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaDrawer
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        title={selected?.title ?? "Incidente"}
        subtitle={selected?.severity ? `Gravedad ${severityLabel(selected.severity)}` : undefined}
        side="right"
        size="sm"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelectedId(null)}>
              {ACTIONS.close}
            </CocoaButton>
            {selected && !handled(selected.status) ? (
              <CocoaButton variant="filled" tone="accent" loading={busy} disabled={busy} onClick={() => markHandled(selected, true)}>
                {HANDLED_LABEL}
              </CocoaButton>
            ) : null}
          </>
        }
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="4">
            <ul className="c22-section__list" aria-label="Ficha del incidente">
              <DetailRow label="Gravedad">
                <SeverityBadge severity={selected.severity} />
              </DetailRow>
              <DetailRow label={FIELD_LABELS.status}>
                <StatusBadge status={selected.status} />
              </DetailRow>
              {selected.incidentType ? <DetailRow label={FIELD_LABELS.type}>{INCIDENT_TYPE_LABEL[selected.incidentType] ?? selected.incidentType}</DetailRow> : null}
              {selected.location ? <DetailRow label="Ubicación">{selected.location}</DetailRow> : null}
              {selected.assignedTo ? <DetailRow label="Asignado a">{selected.assignedTo}</DetailRow> : null}
              <DetailRow label="Ocurrido">{fmtDate(selected.occurredAt ?? selected.reportedAt)}</DetailRow>
              {selected.resolvedAt ? <DetailRow label="Resuelto">{fmtDate(selected.resolvedAt)}</DetailRow> : null}
            </ul>
            {selected.description ? (
              <div className="cocoa-stack" data-gap="1">
                <span style={secondaryStyle}>{FIELD_LABELS.description}</span>
                <p style={bodyStyle}>{selected.description}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </CocoaDrawer>

      <CocoaDrawer
        open={show}
        onClose={closeForm}
        title={newLabel("m", "incidente")}
        subtitle="Describe qué ha pasado, dónde y con qué gravedad."
        side="right"
        size="md"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={closeForm} disabled={busy}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" loading={busy} disabled={!canSubmit} onClick={submitIncident}>
              {NEW_INCIDENT}
            </CocoaButton>
          </>
        }
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Título" required>
            <CocoaInput value={title} onChange={setTitle} placeholder="Ej.: Suelo mojado en recepción" disabled={busy} autoComplete="off" />
          </CocoaField>
          <CocoaFormRow columns={2}>
            <CocoaField label="Ubicación">
              <CocoaInput value={location} onChange={setLocation} placeholder="Ej.: Vestíbulo planta 0" disabled={busy} />
            </CocoaField>
            <CocoaField label="Gravedad">
              <CocoaSelect value={severity} onChange={(v) => setSeverity(v as IncidentSeverity)} options={SEVERITY_OPTIONS} disabled={busy} />
            </CocoaField>
          </CocoaFormRow>
          <CocoaField label={FIELD_LABELS.description}>
            <CocoaInput value={desc} onChange={setDesc} multiline rows={3} disabled={busy} />
          </CocoaField>
        </div>
      </CocoaDrawer>
    </CocoaPage>
  );
}

// Mirror skeleton: the KPI strip and the 7/5 grid.
function SafetySkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[7, 5]]} height={260} />
    </div>
  );
}

export default SafetyDashboard;
