import { getActivePropertyId } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { ACTIONS } from "../../content/actions";
import { dateTime, relativeTime } from "../../lib/format";

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

const SEVERITY_META: Record<Severity, { label: string; chip: string; accent: string }> = {
  critical: { label: "Crítico", chip: "error", accent: "var(--danger-ink)" },
  warning: { label: "Aviso", chip: "warn", accent: "var(--warn-ink)" },
  info: { label: "Info", chip: "info", accent: "var(--info-ink)" }
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
          ? `Envío en cola para reintento. Próximo intento: ${row.nextRetryAt ? dateTime(row.nextRetryAt) : "en breve"}. Intentos hasta ahora: ${row.attempts ?? 0}.`
          : "La autoridad no confirmó la recepción. El worker reintentará automáticamente.",
      actionLabel: "Abrir envíos",
      actionScreen: "FiscalSubmissionsCenter",
      timestamp: row.submittedAt
    }));
}

const SEVERITY_FILTERS: Array<{ id: "all" | Severity; label: string }> = [
  { id: "all", label: "Todas" },
  { id: "critical", label: "Críticas" },
  { id: "warning", label: "Avisos" },
  { id: "info", label: "Info" }
];

export function ComplianceInbox(props: { onNavigate?: (screen: string) => void }) {
  const verifactu = useApiData<Submission[]>(`/properties/${PROPERTY_ID}/verifactu/submissions`, { pollIntervalMs: 15000 });
  const tbai = useApiData<Submission[]>(`/properties/${PROPERTY_ID}/tbai/submissions`, { pollIntervalMs: 15000 });
  const igic = useApiData<Submission[]>(`/properties/${PROPERTY_ID}/igic/submissions`, { pollIntervalMs: 15000 });
  const ses = useApiData<Submission[]>(`/properties/${PROPERTY_ID}/ses/submissions`, { pollIntervalMs: 15000 });
  const periods = useApiData<FiscalPeriod[]>(`/accounting/fiscal-periods?propertyId=${PROPERTY_ID}`);

  const [filter, setFilter] = useState<"all" | Severity>("all");

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
          title: `El período fiscal ${period.periodCode} cierra en ${days} días`,
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

  // Only real alerts (Tanda 5: the sample «Datos de ejemplo» feed is gone).
  const sourceAlerts = realAlerts;
  const alerts = filter === "all" ? sourceAlerts : sourceAlerts.filter((a) => a.severity === filter);

  const counts = {
    critical: sourceAlerts.filter((a) => a.severity === "critical").length,
    warning: sourceAlerts.filter((a) => a.severity === "warning").length,
    info: sourceAlerts.filter((a) => a.severity === "info").length
  };

  const refreshAll = () => {
    verifactu.refresh();
    tbai.refresh();
    igic.refresh();
    ses.refresh();
    periods.refresh();
  };

  return (
    <>
      <CocoaPageHeader
        eyebrow="Cumplimiento"
        title="Bandeja de cumplimiento"
        subtitle="Todo lo que requiere atención humana en un solo sitio: envíos rechazados, periodos fiscales a punto de cerrar y certificados que caducan, en VeriFactu, TicketBAI, IGIC y SES.Hospedajes. Se actualiza cada 15 s."
        actions={<button type="button" onClick={refreshAll}>↻ {ACTIONS.refresh}</button>}
      />

      <section className="rev-kpi-grid">
        <article className={`rev-kpi ${counts.critical > 0 ? "rev-kpi-error" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Críticas</span></div>
          <div className="rev-kpi-value">{counts.critical}</div>
          <div className="rev-kpi-delta">Requieren acción ahora</div>
        </article>
        <article className={`rev-kpi ${counts.warning > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Avisos</span></div>
          <div className="rev-kpi-value">{counts.warning}</div>
          <div className="rev-kpi-delta">Reintento en curso o próximos vencimientos</div>
        </article>
        <article className="rev-kpi">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Info</span></div>
          <div className="rev-kpi-value">{counts.info}</div>
          <div className="rev-kpi-delta">Recordatorios y avisos</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Total de alertas</span></div>
          <div className="rev-kpi-value">{sourceAlerts.length}</div>
          <div className="rev-kpi-delta">Cuatro autoridades y el sistema</div>
        </article>
      </section>

      {/* Severity filter */}
      {sourceAlerts.length > 0 ? (
        <div className="bo-pill-row" style={{ alignItems: "center", gap: 8 }}>
          {SEVERITY_FILTERS.map((f) => {
            const count = f.id === "all" ? sourceAlerts.length : counts[f.id];
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                className={`bo-pill${active ? " is-active" : ""}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label} <span style={{ opacity: 0.7 }}>· {count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <section className="bo-card" style={{ padding: 0, overflow: "hidden" }}>
        {alerts.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center" }}>
            <h3 style={{ marginBottom: 8 }}>Nada que atender</h3>
            <p style={{ color: "var(--ink-muted)" }}>
              No hay envíos rechazados ni periodos fiscales vencidos.
            </p>
          </div>
        ) : (
          <div className="bo-stack" style={{ padding: 16, gap: 8 }}>
            {alerts.map((alert) => {
              const meta = SEVERITY_META[alert.severity];
              return (
                <article
                  key={alert.id}
                  className="bo-card"
                  style={{
                    padding: 16,
                    borderLeft: `3px solid ${meta.accent}`,
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto",
                    gap: 16,
                    alignItems: "center"
                  }}
                >
                  <span className={`bo-status ${meta.chip}`}>{meta.label}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <span className="bo-chip">{AUTHORITY_LABEL[alert.authority]}</span>
                      <strong style={{ color: "var(--ink)" }}>{alert.title}</strong>
                    </div>
                    <div style={{ fontSize: 13, color: "var(--ink-muted)", lineHeight: 1.45 }}>{alert.description}</div>
                    {alert.timestamp ? (
                      <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 6 }}>{relTime(alert.timestamp)}</div>
                    ) : null}
                  </div>
                  <div>
                    {alert.actionScreen ? (
                      <button type="button" className="primary" onClick={() => props.onNavigate?.(alert.actionScreen!)}>
                        {alert.actionLabel ?? "Abrir"}
                      </button>
                    ) : alert.actionLabel ? (
                      <button type="button">{alert.actionLabel}</button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
