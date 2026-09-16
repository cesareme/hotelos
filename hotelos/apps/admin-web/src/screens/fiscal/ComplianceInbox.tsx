// Bandeja de cumplimiento — /cumplimiento/bandeja (standalone; App.tsx wraps it
// in ComplianceInboxWired with `onNavigate`). Cocoa 22 · ola 8 · lote 8-B
// (plantilla Workspace).
//
// Everything that needs a person, in one place: rejected or retrying
// submissions of the four authorities (VeriFactu · TicketBAI · IGIC ·
// SES.HOSPEDAJES, polled every 15 s) and the fiscal periods about to close or
// already overdue. Severity KPIs, a severity filter as inner views, and a
// workspace split: the alert list on the left (4 columns), the selected alert
// with its action on the right (8); below 900 px the list is the page and the
// detail opens in a CocoaDrawer (bottom sheet on phones).

import { useMemo, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { dateTime, number, plural, relativeTime } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  useViewportTier,
  type CocoaPageHeaderTab,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

type Submission = {
  id: string;
  status: string;
  errorCode?: string;
  errorMessage?: string;
  invoiceNumber?: string;
  externalReference?: string;
  submittedAt?: string;
  nextRetryAt?: string;
  attempts?: number;
};

type FiscalPeriod = {
  id: string;
  periodCode: string;
  periodType: string;
  startDate: string;
  endDate: string;
  status: string;
  closedAt?: string;
};

type Severity = "critical" | "warning" | "info";
type Authority = "verifactu" | "tbai" | "igic" | "ses" | "system";

type Alert = {
  id: string;
  severity: Severity;
  authority: Authority;
  title: string;
  description: string;
  actionLabel?: string;
  actionScreen?: string;
  timestamp?: string;
};

const SEVERITY_META: Record<Severity, { label: string; tone: CocoaTone }> = {
  critical: { label: "Crítico", tone: "danger" },
  warning: { label: "Aviso", tone: "warning" },
  info: { label: "Información", tone: "info" }
};

const AUTHORITY_LABEL: Record<Authority, string> = {
  verifactu: "VeriFactu",
  tbai: "TicketBAI",
  igic: "IGIC",
  ses: "SES.HOSPEDAJES",
  system: "Sistema"
};

const STATUS_LABEL: Record<string, string> = {
  rejected: "envío rechazado",
  retrying: "reintentando",
  network_error: "error de red"
};

function relTime(iso?: string): string {
  return iso ? relativeTime(iso) : "";
}

function asAlerts(authority: Authority, rows: Submission[] | null): Alert[] {
  if (!rows) return [];
  return rows
    .filter((row) => row.status === "rejected" || row.status === "retrying" || row.status === "network_error")
    .map((row) => ({
      id: `${authority}-${row.id}`,
      severity: (row.status === "rejected" ? "critical" : "warning") as Severity,
      authority,
      title: `${AUTHORITY_LABEL[authority]} · ${STATUS_LABEL[row.status] ?? row.status} — ${row.invoiceNumber ?? row.externalReference ?? row.id}`,
      description: row.errorMessage
        ? `${row.errorCode ?? "error"}: ${row.errorMessage}`
        : row.status === "retrying"
          ? `Envío en cola para reintento. Próximo intento: ${row.nextRetryAt ? dateTime(row.nextRetryAt) : "en breve"}. Intentos hasta ahora: ${number(row.attempts ?? 0)}.`
          : "La autoridad no confirmó la recepción. El sistema reintentará automáticamente.",
      actionLabel: "Abrir envíos",
      actionScreen: "FiscalSubmissionsCenter",
      timestamp: row.submittedAt
    }));
}

type Filter = "all" | Severity;

const SEVERITY_FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Todas" },
  { id: "critical", label: "Críticas" },
  { id: "warning", label: "Avisos" },
  { id: "info", label: "Información" }
];

function InboxSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[4, 8]]} height={320} />
    </div>
  );
}

export function ComplianceInbox(props: { onNavigate?: (screen: string) => void }) {
  const tier = useViewportTier();
  const compact = tier === "phone" || tier === "tablet";
  const verifactu = useApiData<Submission[]>(`/properties/${PROPERTY_ID}/verifactu/submissions`, { pollIntervalMs: 15000 });
  const tbai = useApiData<Submission[]>(`/properties/${PROPERTY_ID}/tbai/submissions`, { pollIntervalMs: 15000 });
  const igic = useApiData<Submission[]>(`/properties/${PROPERTY_ID}/igic/submissions`, { pollIntervalMs: 15000 });
  const ses = useApiData<Submission[]>(`/properties/${PROPERTY_ID}/ses/submissions`, { pollIntervalMs: 15000 });
  const periods = useApiData<FiscalPeriod[]>(`/accounting/fiscal-periods?propertyId=${PROPERTY_ID}`);

  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const realAlerts = useMemo<Alert[]>(() => {
    const list: Alert[] = [
      ...asAlerts("verifactu", toArray<Submission>(verifactu.data)),
      ...asAlerts("tbai", toArray<Submission>(tbai.data)),
      ...asAlerts("igic", toArray<Submission>(igic.data)),
      ...asAlerts("ses", toArray<Submission>(ses.data))
    ];
    const now = new Date();
    for (const period of toArray<FiscalPeriod>(periods.data)) {
      if (period.status !== "open") continue;
      const end = new Date(period.endDate);
      const days = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      if (days <= 7 && days >= 0) {
        list.push({
          id: `period-${period.id}`,
          severity: "warning",
          authority: "system",
          title: `El período fiscal ${period.periodCode} cierra en ${plural(days, "día", "días")}`,
          description: `Ciérralo antes de la presentación en AEAT. Los asientos posteriores al ${period.endDate} quedarán bloqueados.`,
          actionLabel: "Abrir período",
          actionScreen: "FiscalDashboard",
          timestamp: period.startDate
        });
      }
      if (days < 0) {
        list.push({
          id: `period-late-${period.id}`,
          severity: "critical",
          authority: "system",
          title: `Período fiscal ${period.periodCode} vencido`,
          description: `El período terminó el ${period.endDate} y sigue abierto. Ciérralo para bloquear asientos y generar el Modelo 303.`,
          actionLabel: "Cerrar período",
          actionScreen: "FiscalDashboard",
          timestamp: period.endDate
        });
      }
    }
    const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
    return list.sort((a, b) => {
      if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
      return (b.timestamp ?? "").localeCompare(a.timestamp ?? "");
    });
  }, [verifactu.data, tbai.data, igic.data, ses.data, periods.data]);

  // Only real alerts (the sample feed is gone since Tanda 5).
  const sourceAlerts = realAlerts;
  const alerts = filter === "all" ? sourceAlerts : sourceAlerts.filter((a) => a.severity === filter);

  const counts = {
    critical: sourceAlerts.filter((a) => a.severity === "critical").length,
    warning: sourceAlerts.filter((a) => a.severity === "warning").length,
    info: sourceAlerts.filter((a) => a.severity === "info").length
  };

  // Desktop preselects the first alert of the filtered list; on a phone the
  // drawer only opens on an explicit choice.
  const selected = alerts.find((a) => a.id === selectedId) ?? (compact ? null : (alerts[0] ?? null));

  const feeds = [
    { label: AUTHORITY_LABEL.verifactu, state: verifactu },
    { label: AUTHORITY_LABEL.tbai, state: tbai },
    { label: AUTHORITY_LABEL.igic, state: igic },
    { label: AUTHORITY_LABEL.ses, state: ses },
    { label: "Períodos fiscales", state: periods }
  ];
  const initialLoading = feeds.some((f) => f.state.loading && f.state.data === null && f.state.error === null);
  const failedFeeds = feeds.filter((f) => f.state.error !== null).map((f) => f.label);

  const refreshAll = () => {
    verifactu.refresh();
    tbai.refresh();
    igic.refresh();
    ses.refresh();
    periods.refresh();
  };

  const filterTabs: CocoaPageHeaderTab[] = SEVERITY_FILTERS.map((f) => ({
    value: f.id,
    label: `${f.label} · ${number(f.id === "all" ? sourceAlerts.length : counts[f.id])}`
  }));

  const actionOf = (alert: Alert) =>
    alert.actionScreen ? (
      <CocoaButton variant="filled" tone="accent" onClick={() => props.onNavigate?.(alert.actionScreen!)}>
        {alert.actionLabel ?? "Abrir"}
      </CocoaButton>
    ) : null;

  const list = (
    <CocoaSection
      title="Alertas"
      meta={plural(alerts.length, "alerta", "alertas")}
      padding={alerts.length === 0 ? "md" : "none"}
      scroll={alerts.length === 0 ? undefined : "y"}
      maxHeight={compact || alerts.length === 0 ? undefined : 640}
    >
      {alerts.length === 0 ? (
        sourceAlerts.length === 0 ? (
          <CocoaState kind="empty" illustration="success" title="Nada que atender" message="No hay envíos rechazados ni periodos fiscales vencidos." />
        ) : (
          <CocoaState kind="empty" illustration="search" title="Sin alertas de este tipo" message="Prueba con otro filtro de gravedad." />
        )
      ) : (
        <ul className="c22-section__list" aria-label="Alertas de cumplimiento" style={{ padding: "0 var(--cocoa-space-4)" }}>
          {alerts.map((alert) => {
            const meta = SEVERITY_META[alert.severity];
            const isSelected = alert.id === selected?.id;
            return (
              <li key={alert.id}>
                <CocoaButton
                  variant="plain"
                  tone={isSelected ? "accent" : "neutral"}
                  size="small"
                  wrap
                  align="start"
                  aria-current={isSelected ? true : undefined}
                  onClick={() => setSelectedId(alert.id)}
                  style={{ flex: "1 1 auto", minWidth: 0 }}
                >
                  <span className="cocoa-stack" data-gap="1">
                    <span className="cocoa-cluster">
                      <CocoaBadge tone={meta.tone} variant="dot" size="small">
                        {meta.label}
                      </CocoaBadge>
                      <span className="cocoa-caption">{AUTHORITY_LABEL[alert.authority]}</span>
                    </span>
                    <span>{alert.title}</span>
                  </span>
                </CocoaButton>
                {alert.timestamp ? (
                  <time className="cocoa-note" dateTime={alert.timestamp} style={{ flexShrink: 0 }}>
                    {relTime(alert.timestamp)}
                  </time>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </CocoaSection>
  );

  const detailBody = (alert: Alert) => (
    <div className="cocoa-stack" data-gap="3">
      <div className="cocoa-cluster">
        <CocoaBadge tone={SEVERITY_META[alert.severity].tone} variant="tinted">
          {SEVERITY_META[alert.severity].label}
        </CocoaBadge>
        <CocoaBadge tone="neutral">{AUTHORITY_LABEL[alert.authority]}</CocoaBadge>
      </div>
      <p>{alert.description}</p>
      {alert.timestamp ? (
        <p className="cocoa-note">
          {dateTime(alert.timestamp)} · {relTime(alert.timestamp)}
        </p>
      ) : null}
    </div>
  );

  const detail = selected ? (
    <CocoaSection title={selected.title} meta={AUTHORITY_LABEL[selected.authority]} headingLevel={2} footer={actionOf(selected)}>
      {detailBody(selected)}
    </CocoaSection>
  ) : (
    <CocoaSection aria-label="Sin selección">
      <CocoaState kind="empty" illustration="box" title="Elige una alerta" message="El detalle y la acción recomendada aparecen aquí." />
    </CocoaSection>
  );

  return (
    <CocoaPage
      eyebrow="Cumplimiento"
      title="Bandeja de cumplimiento"
      subtitle="Todo lo que requiere atención humana en un solo sitio: envíos rechazados, periodos fiscales a punto de cerrar y certificados que caducan, en VeriFactu, TicketBAI, IGIC y SES.Hospedajes. Se actualiza cada 15 s."
      tabs={sourceAlerts.length > 0 ? filterTabs : undefined}
      activeTab={filter}
      onTabChange={(value) => setFilter(value as Filter)}
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll}>
          {ACTIONS.refresh}
        </CocoaButton>
      }
      state={initialLoading ? "loading" : "ready"}
      skeleton={<InboxSkeleton />}
      commands={[{ id: "compliance-inbox-refresh", label: "Actualizar la bandeja de cumplimiento", run: refreshAll }]}
    >
      {failedFeeds.length > 0 ? (
        <CocoaCallout
          tone="danger"
          title={STATUS_LABELS.loadError}
          role="status"
          actions={
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll}>
              {ACTIONS.retry}
            </CocoaButton>
          }
        >
          No se pudieron cargar {failedFeeds.join(", ")}. Las alertas solo cuentan las fuentes cargadas.
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Alertas por gravedad">
        <CocoaKpi label="Críticas" value={number(counts.critical)} caption="Requieren acción ahora" polarity="negative-good" status={counts.critical > 0 ? "critical" : "ok"} />
        <CocoaKpi label="Avisos" value={number(counts.warning)} caption="Reintento en curso o próximos vencimientos" polarity="negative-good" status={counts.warning > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Información" value={number(counts.info)} caption="Recordatorios y avisos" polarity="neutral" />
        <CocoaKpi label="Total de alertas" value={number(sourceAlerts.length)} caption="Cuatro autoridades y el sistema" polarity="neutral" />
      </CocoaKpiStrip>

      {alerts.length === 0 ? (
        list
      ) : compact ? (
        <>
          {list}
          <CocoaDrawer
            open={selected !== null}
            onClose={() => setSelectedId(null)}
            title={selected?.title ?? "Alerta"}
            subtitle={selected ? AUTHORITY_LABEL[selected.authority] : undefined}
            side="right"
            size="md"
            footer={
              selected ? (
                <>
                  <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelectedId(null)}>
                    {ACTIONS.close}
                  </CocoaButton>
                  {actionOf(selected)}
                </>
              ) : undefined
            }
          >
            {selected ? detailBody(selected) : null}
          </CocoaDrawer>
        </>
      ) : (
        <CocoaGrid align="start" aria-label="Alertas y detalle">
          <CocoaSpan cols={4} min={320}>
            {list}
          </CocoaSpan>
          <CocoaSpan cols={8} min={480}>
            {detail}
          </CocoaSpan>
        </CocoaGrid>
      )}
    </CocoaPage>
  );
}
