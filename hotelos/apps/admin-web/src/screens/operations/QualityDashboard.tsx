// Calidad — Comercial › Reputación y calidad › Calidad
// (/comercial/reputacion/calidad, hosted inside ReputacionTabs).
//
// Cocoa 22 · ola 7 · lote 7-B (docs/design/COCOA-22.md §4, archetype
// «dashboard alojado»): CocoaPage → CocoaKpiStrip (open, critical, SLA,
// resolution time, closed 30 d) → CocoaGrid 6/6 (cases by type · cases by
// status as CocoaTables) → CocoaGrid 6/6 (most frequent causes as a
// CocoaTable · recent cases as a section list). Read-only.
//
// Data: GET /dashboards/quality?propertyId=, polled every minute — only once
// the reputation_quality module is known to be enabled (qa#14): while the
// module list loads the page keeps its skeleton, and with the module off it
// paints «Módulo no activado» (+ «Activar módulo» for users with modules.enable).

import type { CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { toArray } from "../../utils/toArray";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { dateTime, number, percent, plural } from "../../lib/format";
import { moduleDisabledCopy } from "./module-gate";
import { useScreenModuleGate } from "./useScreenModuleGate";
import {
  CocoaBadge,
  CocoaButton,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaKpiStatus,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
// Menu labels of the tree (Comercial › Reputación y calidad › Calidad), never retyped here.
const HEADER = treeHeaderFor("QualityDashboard", { eyebrow: "Comercial · Reputación y calidad", title: "Calidad" });

type Kpis = {
  openCases: number;
  slaBreachedPct: number;
  avgResolutionHours: number;
  closedLast30d: number;
  criticalOpen: number;
};
type CountRow = { key: string; label: string; count: number };
type TypeRow = { caseType: string; count: number };
type StatusRow = { status: string; count: number };
type CauseRow = { rootCause: string; count: number };
type QualityCase = {
  id: string;
  title: string;
  status: string;
  severity?: string;
  openedAt: string;
  closedAt?: string;
};
type QualityDashboardData = {
  kpis: Kpis;
  casesByType: TypeRow[];
  casesByStatus: StatusRow[];
  topFailureModes: CauseRow[];
  recentCases: QualityCase[];
};

const EMPTY_KPIS: Kpis = { openCases: 0, slaBreachedPct: 0, avgResolutionHours: 0, closedLast30d: 0, criticalOpen: 0 };
const MAX_ROWS = 12;

const CRITICAL_PRIORITIES = new Set(["critical", "urgent", "high"]);
const CLOSED_STATUSES = new Set(["resolved", "closed"]);
const IN_PROGRESS_STATUSES = new Set(["in_progress", "assigned", "investigating"]);
const WAITING_STATUSES = new Set(["waiting_vendor", "on_hold"]);

const STATUS_LABEL: Record<string, string> = {
  open: "abierto",
  new: "nuevo",
  in_progress: "en curso",
  assigned: "asignado",
  investigating: "en investigación",
  waiting_vendor: "esperando al proveedor",
  on_hold: "en espera",
  resolved: "resuelto",
  closed: "cerrado"
};

const SEVERITY_LABEL: Record<string, string> = {
  critical: "crítica",
  urgent: "urgente",
  high: "alta",
  medium: "media",
  normal: "normal",
  low: "baja"
};

function statusTone(status: string): CocoaTone {
  if (CLOSED_STATUSES.has(status)) return "success";
  if (IN_PROGRESS_STATUSES.has(status) || WAITING_STATUSES.has(status)) return "warning";
  return "danger";
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function severityTone(severity: string): CocoaTone {
  if (CRITICAL_PRIORITIES.has(severity)) return "danger";
  if (severity === "normal") return "success";
  return "warning";
}

function severityLabel(severity: string): string {
  return SEVERITY_LABEL[severity] ?? severity;
}

function slaStatus(pct: number): CocoaKpiStatus {
  if (pct >= 25) return "critical";
  if (pct > 0) return "warning";
  return "ok";
}

function StatusBadge({ status }: { status: string }) {
  return (
    <CocoaBadge tone={statusTone(status)} variant="dot" size="small">
      {statusLabel(status)}
    </CocoaBadge>
  );
}

function SeverityBadge({ severity }: { severity?: string }) {
  const sev = severity ?? "normal";
  return (
    <CocoaBadge tone={severityTone(sev)} variant="tinted" size="small">
      {severityLabel(sev)}
    </CocoaBadge>
  );
}

// Footnote text (dates of a case) in the secondary ink; outside a literal `style={{…}}` (rule 6).
const footnoteStyle: CSSProperties = { fontSize: "var(--cocoa-fs-footnote)", color: "var(--cocoa-label-secondary)" };

const TYPE_COLUMNS: CocoaTableColumn<CountRow>[] = [
  { key: "label", label: "Tipo de caso", render: (row) => <strong>{row.label}</strong> },
  { key: "count", label: "Número", align: "right", fit: true, render: (row) => number(row.count) }
];

const STATUS_COLUMNS: CocoaTableColumn<CountRow>[] = [
  { key: "label", label: FIELD_LABELS.status, render: (row) => <StatusBadge status={row.key} /> },
  { key: "count", label: "Número", align: "right", fit: true, render: (row) => number(row.count) }
];

const CAUSE_COLUMNS: CocoaTableColumn<CountRow>[] = [
  { key: "label", label: "Causa raíz", render: (row) => <strong>{row.label}</strong> },
  { key: "count", label: "Número", align: "right", fit: true, render: (row) => number(row.count) }
];

// Mirror skeleton: the KPI strip and the two 6/6 rows.
function QualitySkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[6, 6], [6, 6]]} height={200} />
    </div>
  );
}

export function QualityDashboard() {
  // Hosted inside ReputacionTabs the container paints eyebrow + H1; CocoaPage adds the subtitle and actions row.
  const propertyName = getActiveProperty().propertyName;
  // Module gate (qa#14): no request (and no 60 s poll) until reputation_quality is known to be enabled.
  const moduleGate = useScreenModuleGate("QualityDashboard");
  const { data, loading, error, refresh } = useApiData<QualityDashboardData>(moduleGate.ready ? `/dashboards/quality?propertyId=${PROPERTY_ID}` : null, {
    pollIntervalMs: 60000
  });

  const kpis = data?.kpis ?? EMPTY_KPIS;
  const casesByType: CountRow[] = toArray<TypeRow>(data?.casesByType).map((row) => ({ key: row.caseType, label: row.caseType, count: row.count }));
  const casesByStatus: CountRow[] = toArray<StatusRow>(data?.casesByStatus).map((row) => ({ key: row.status, label: statusLabel(row.status), count: row.count }));
  const topFailureModes: CountRow[] = toArray<CauseRow>(data?.topFailureModes).map((row) => ({ key: row.rootCause, label: row.rootCause, count: row.count }));
  const recentCases = toArray<QualityCase>(data?.recentCases);

  // Module not active → the whole body is the «Módulo no activado» state (§3.10).
  const moduleDisabled = moduleGate.status === "disabled";
  const disabledCopy = moduleDisabledCopy(moduleGate.canEnable);
  const state =
    moduleGate.status === "loading" ? "loading" : moduleDisabled ? "empty" : loading && !data ? "loading" : error && !data ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
      title={HEADER.title}
      subtitle="Casos abiertos, críticos y resueltos, tiempo medio de resolución, reparto por tipo y estado y causas más frecuentes. Se actualiza cada minuto."
      actions={
        moduleGate.ready ? (
          <>
            {loading && data ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
            {error && data ? (
              <CocoaBadge tone="danger" title={error}>
                {STATUS_LABELS.loadError}
              </CocoaBadge>
            ) : null}
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} disabled={loading}>
              {ACTIONS.refresh}
            </CocoaButton>
          </>
        ) : null
      }
      state={state}
      skeleton={<QualitySkeleton />}
      empty={{
        title: disabledCopy.title,
        message: disabledCopy.message,
        primaryAction: disabledCopy.cta ? { label: disabledCopy.cta, onClick: moduleGate.enable } : undefined
      }}
      error={{ title: "No se pudo cargar la vista de calidad", message: error ?? undefined, onRetry: refresh }}
      commands={
        moduleGate.ready
          ? [{ id: "quality-refresh", label: "Actualizar calidad", run: refresh }]
          : moduleDisabled && disabledCopy.cta
            ? [{ id: "quality-enable-module", label: `${disabledCopy.cta} · ${HEADER.title}`, run: moduleGate.enable }]
            : []
      }
    >
      <CocoaKpiStrip stagger aria-label="Indicadores de calidad">
        <CocoaKpi label="Casos abiertos" value={number(kpis.openCases)} caption="activos ahora mismo" polarity="negative-good" status={kpis.openCases > 0 ? "warning" : "ok"} />
        <CocoaKpi
          label="Críticos abiertos"
          value={number(kpis.criticalOpen)}
          caption="prioridad crítica, urgente o alta"
          polarity="negative-good"
          status={kpis.criticalOpen > 0 ? "critical" : "ok"}
        />
        <CocoaKpi
          label="SLA incumplido"
          value={percent(kpis.slaBreachedPct, { maximumFractionDigits: 1 })}
          caption="sin objetivo de SLA configurado"
          polarity="negative-good"
          status={slaStatus(kpis.slaBreachedPct)}
        />
        <CocoaKpi
          label="Resolución media"
          value={number(kpis.avgResolutionHours, { maximumFractionDigits: 1 })}
          unit="h"
          caption="por caso resuelto"
          polarity="negative-good"
          status="ok"
        />
        <CocoaKpi label="Cerrados en 30 días" value={number(kpis.closedLast30d)} caption="resueltos el último mes" polarity="neutral" status="ok" />
      </CocoaKpiStrip>

      <CocoaGrid align="start" aria-label="Casos por tipo y estado">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Casos por tipo"
            meta={plural(casesByType.length, "tipo", "tipos")}
            padding={casesByType.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {casesByType.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin casos de calidad en el periodo." />
            ) : (
              <CocoaTable columns={TYPE_COLUMNS} rows={casesByType.slice(0, MAX_ROWS)} rowKey="key" caption="Casos por tipo" aria-label="Casos por tipo" />
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Casos por estado"
            meta={plural(casesByStatus.length, "estado", "estados")}
            padding={casesByStatus.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {casesByStatus.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin casos de calidad en el periodo." />
            ) : (
              <CocoaTable columns={STATUS_COLUMNS} rows={casesByStatus.slice(0, MAX_ROWS)} rowKey="key" caption="Casos por estado" aria-label="Casos por estado" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaGrid align="start" aria-label="Causas y casos recientes">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Causas más frecuentes"
            meta={plural(topFailureModes.length, "causa", "causas")}
            padding={topFailureModes.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {topFailureModes.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin casos resueltos en el periodo." />
            ) : (
              <CocoaTable columns={CAUSE_COLUMNS} rows={topFailureModes.slice(0, MAX_ROWS)} rowKey="key" caption="Causas más frecuentes" aria-label="Causas más frecuentes" />
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Casos recientes" meta={plural(recentCases.length, "caso", "casos")}>
            {recentCases.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin casos recientes." />
            ) : (
              <ul className="c22-section__list" aria-label="Casos recientes">
                {recentCases.slice(0, MAX_ROWS).map((c) => (
                  <li key={c.id}>
                    <div className="cocoa-stack" data-gap="1" style={{ flex: "1 1 auto", minWidth: 0 }}>
                      <div className="cocoa-row" data-gap="2">
                        <StatusBadge status={c.status} />
                        <SeverityBadge severity={c.severity} />
                        <strong>{c.title}</strong>
                      </div>
                      <span style={footnoteStyle}>
                        Abierto el {dateTime(c.openedAt)}
                        {c.closedAt ? ` · Cerrado el ${dateTime(c.closedAt)}` : ""}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </CocoaPage>
  );
}
