// Night Audit Screen — checklist guiada para el cierre del día («Cierre del
// día», /hoy/cierre-del-dia, standalone).
//
// Directriz Anfitorio (Nov 2026):
//   "La auditoría nocturna debe ser una checklist inteligente. El sistema debe
//    decir: 'No puedes cerrar todavía porque hay 3 folios con saldo pendiente
//    y 2 llegadas sin resolver.'"
//
// Cocoa 22 (docs/design/COCOA-22.md §4, plantilla DashboardStandalone):
//   - CocoaPage with the can-close banner as a CocoaCallout (success/danger)
//     that carries the «Cerrar día» CocoaButton
//   - ok / warning / blocker summary as a CocoaKpiStrip
//   - checks as stacked CocoaCallout cards (status icon, count badge, affected
//     items expandable, fix action → typed navigateTo)
//   - previous runs in a CocoaTable (sticky head, stacked cards under 600 px)
// Data: GET /properties/:id/night-audit/preflight (30 s poll) and
// GET /properties/:id/night-audit/runs; POST /properties/:id/night-audit/run.

import { useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { navigateTo, type ScreenKey } from "../../lib/navigate";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { date, dateTime, number, plural } from "../../lib/format";
import { CheckCircleIcon, ExclamationCircleIcon, XCircleIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  toneFromStatus,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

type Status = "ok" | "warning" | "blocker";

type CheckItem = { ref: string; label: string; detail?: string };

type Check = {
  id: string;
  title: string;
  status: Status;
  count: number;
  detail: string;
  items?: CheckItem[];
};

type PreflightData = {
  propertyId: string;
  businessDate?: string;
  generatedAt: string;
  canClose: boolean;
  blockingMessage?: string;
  checks: Check[];
  summary: { ok: number; warning: number; blocker: number };
};

type RunRecord = {
  id: string;
  businessDate: string;
  status: string;
  completedAt?: string;
  stepResults?: Array<{ step: string; status: string; detail?: string }>;
};

const STATUS_TONE: Record<Status, CocoaTone> = { ok: "success", warning: "warning", blocker: "danger" };
const STATUS_LABEL: Record<Status, string> = { ok: "OK", warning: "Atención", blocker: "Bloquea" };

// Run status → Spanish label (the API speaks English).
const RUN_STATUS_LABEL: Record<string, string> = {
  completed: STATUS_LABELS.completed,
  failed: STATUS_LABELS.failed,
  running: STATUS_LABELS.inProgress,
  pending: STATUS_LABELS.pending
};

const MAX_RUNS = 10;

function fixActionFor(checkId: string): { label: string; screen: ScreenKey } | null {
  switch (checkId) {
    case "arrivals_pending":
    case "unresolved_no_shows":
    case "open_folios_with_balance":
    case "departures_not_checked_out":
      return { label: "Abrir cola operativa", screen: "FrontDeskDashboard" };
    case "dirty_in_house_rooms":
      return { label: "Abrir tablero de habitaciones", screen: "RoomRackScreen" };
    case "unposted_room_charges":
      return { label: "Postear ahora", screen: "FrontDeskDashboard" };
    case "invoices_pending":
      return { label: "Ver facturas", screen: "FiscalSubmissionsCenter" };
    default:
      return null;
  }
}

function StatusIcon({ status }: { status: Status }) {
  if (status === "blocker") return <XCircleIcon size={16} />;
  if (status === "warning") return <ExclamationCircleIcon size={16} />;
  return <CheckCircleIcon size={16} />;
}

// Text styles (colours and sizes from the tokens; layout from the utilities).
const detailStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-callout)",
  color: "var(--cocoa-label-secondary)"
};

const secondaryStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };

const growStyle: CSSProperties = { flex: "1 1 auto", minWidth: 0 };

const RUN_COLUMNS: CocoaTableColumn<RunRecord>[] = [
  { key: "businessDate", label: "Fecha de negocio", render: (r) => <strong>{date(r.businessDate, "short")}</strong> },
  {
    key: "status",
    label: "Estado",
    render: (r) => (
      <CocoaBadge tone={toneFromStatus(r.status === "completed" ? "ok" : r.status === "failed" ? "error" : "info")} size="small">
        {RUN_STATUS_LABEL[r.status] ?? r.status}
      </CocoaBadge>
    )
  },
  { key: "steps", label: "Pasos", align: "right", hideOnNarrow: true, render: (r) => number(r.stepResults?.length ?? 0) },
  { key: "completedAt", label: "Completado", render: (r) => <span style={secondaryStyle}>{dateTime(r.completedAt)}</span> }
];

export function NightAuditScreen() {
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  const { data: preflight, loading: ploading, error: perror, refresh } = useApiData<PreflightData>(
    `/properties/${propertyId}/night-audit/preflight`,
    { pollIntervalMs: 30000 }
  );
  const { data: runsData } = useApiData<RunRecord[]>(`/properties/${propertyId}/night-audit/runs`);

  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const checks = toArray<Check>(preflight?.checks);
  const runs = toArray<RunRecord>(runsData);
  const shownRuns = runs.slice(0, MAX_RUNS);
  const state = !preflight ? (perror ? "error" : "loading") : "ready";

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runAudit() {
    if (!preflight?.canClose) return;
    setBusy(true);
    try {
      await apiRequest<unknown>(`/properties/${encodeURIComponent(propertyId)}/night-audit/run`, { method: "POST" });
      showToast("Cierre del día ejecutado. Día cerrado.", { variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error";
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
      refresh();
    }
  }

  const canClose = Boolean(preflight?.canClose);

  return (
    <CocoaPage
      eyebrow={`Hoy · ${propertyName}`}
      title="Cierre del día"
      subtitle={`Comprobaciones guiadas antes de cerrar: si algo bloquea, te dice qué arreglar y dónde.${preflight?.businessDate ? ` Fecha de negocio actual: ${date(preflight.businessDate, "short")}.` : ""}`}
      actions={
        <>
          {ploading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          {perror ? <CocoaBadge tone="danger">{perror}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} aria-label={ACTIONS.refresh} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={state}
      skeleton={<NightAuditSkeleton />}
      error={{ title: "No se pudo cargar el cierre del día", message: perror ?? undefined, onRetry: refresh }}
      commands={[{ id: "night-audit-refresh", label: "Actualizar el cierre del día", run: refresh }]}
    >
      {preflight ? (
        <>
          {/* Banner principal — audit 2026-06 · #10: while the first fetch has no
              data the page shows loading/error instead of a misleading red
              «no puedes cerrar» banner. */}
          <CocoaCallout
            tone={canClose ? "success" : "danger"}
            icon={canClose ? <CheckCircleIcon size={20} /> : <XCircleIcon size={20} />}
            title={canClose ? "Puedes cerrar el día" : "No puedes cerrar todavía"}
            actions={
              <CocoaButton
                variant="filled"
                tone="accent"
                disabled={!canClose || busy}
                loading={busy}
                onClick={runAudit}
                title={canClose ? "Ejecuta el cierre del día y avanza la fecha de negocio" : "Resuelve los bloqueos primero"}
              >
                Cerrar día
              </CocoaButton>
            }
          >
            {preflight.blockingMessage ?? "Todas las comprobaciones críticas están en verde. Ejecuta el cierre del día cuando estés listo."}
          </CocoaCallout>

          <CocoaKpiStrip min={200} stagger aria-label="Resumen de comprobaciones">
            <CocoaKpi label="Comprobaciones OK" value={preflight.summary.ok} polarity="neutral" status="ok" />
            <CocoaKpi label="Avisos" value={preflight.summary.warning} polarity="neutral" status={preflight.summary.warning > 0 ? "warning" : "ok"} />
            <CocoaKpi label="Bloqueos" value={preflight.summary.blocker} polarity="neutral" status={preflight.summary.blocker > 0 ? "critical" : "ok"} />
          </CocoaKpiStrip>

          <CocoaSection title="Checklist pre-cierre" meta={plural(checks.length, "chequeo", "chequeos")}>
            {checks.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin comprobaciones para la fecha de negocio actual." />
            ) : (
              <div className="cocoa-stack" data-gap="2" role="list" aria-label="Checklist pre-cierre">
                {checks.map((check) => {
                  const tone = STATUS_TONE[check.status];
                  const items = check.items ?? [];
                  const isExpanded = expanded.has(check.id);
                  const fix = fixActionFor(check.id);
                  const itemsId = `night-audit-items-${check.id}`;
                  return (
                    <CocoaCallout
                      key={check.id}
                      tone={tone}
                      icon={<StatusIcon status={check.status} />}
                      title={check.title}
                      actions={
                        <CocoaBadge tone={tone} variant="tinted" size="small">
                          {STATUS_LABEL[check.status]} · {number(check.count)}
                        </CocoaBadge>
                      }
                    >
                      <span style={detailStyle}>{check.detail}</span>
                      {items.length > 0 || (fix && check.status !== "ok") ? (
                        <div className="cocoa-row" data-gap="2">
                          {items.length > 0 ? (
                            <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => toggle(check.id)} aria-expanded={isExpanded} aria-controls={itemsId}>
                              {isExpanded ? "Ocultar" : `Ver ${plural(items.length, "elemento", "elementos")}`}
                            </CocoaButton>
                          ) : null}
                          {fix && check.status !== "ok" ? (
                            <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => navigateTo(fix.screen)}>
                              {fix.label}
                            </CocoaButton>
                          ) : null}
                        </div>
                      ) : null}
                      {isExpanded && items.length > 0 ? (
                        <ul id={itemsId} className="c22-section__list" aria-label={`Elementos afectados · ${check.title}`}>
                          {items.map((item) => (
                            <li key={item.ref}>
                              <div className="cocoa-row" data-gap="2" data-align="baseline" style={growStyle}>
                                <strong>{item.label}</strong>
                                {item.detail ? <span style={detailStyle}>{item.detail}</span> : null}
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </CocoaCallout>
                  );
                })}
              </div>
            )}
          </CocoaSection>

          {shownRuns.length > 0 ? (
            <CocoaSection title="Historial de cierres" meta={`Últimos ${number(shownRuns.length)}`} padding="none" style={{ overflow: "clip" }}>
              <CocoaTable columns={RUN_COLUMNS} rows={shownRuns} rowKey="id" caption="Historial de cierres" aria-label="Historial de cierres" />
            </CocoaSection>
          ) : null}
        </>
      ) : null}
    </CocoaPage>
  );
}

// Mirror skeleton: banner, three KPI tiles and the checklist card.
function NightAuditSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={72} />
      <CocoaSkeleton.Strip count={3} min={200} />
      <CocoaSkeleton variant="card" height={320} />
    </div>
  );
}

export default NightAuditScreen;
