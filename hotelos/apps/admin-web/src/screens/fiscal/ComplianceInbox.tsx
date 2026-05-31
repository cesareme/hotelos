import { getActivePropertyId } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";

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
  demo?: boolean;
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
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const days = Math.round(h / 24);
  return `hace ${days} d`;
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
          ? `Envío en cola para reintento. Próximo intento: ${row.nextRetryAt ? new Date(row.nextRetryAt).toLocaleString("es-ES") : "en breve"}. Intentos hasta ahora: ${row.attempts ?? 0}.`
          : "La autoridad no confirmó la recepción. El worker reintentará automáticamente.",
      actionLabel: "Abrir envíos",
      actionScreen: "FiscalSubmissionsCenter",
      timestamp: row.submittedAt
    }));
}

// Sample alerts shown only when there are no real alerts, so the inbox can be
// previewed populated. They are clearly flagged as demo and never mixed with
// real data (real alerts always take precedence and hide these).
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const DEMO_ALERTS: Alert[] = [
  {
    id: "demo-verifactu-1",
    severity: "critical",
    authority: "verifactu",
    title: "VeriFactu · envío rechazado — Factura F-2026/000142",
    description: "Error AEAT 3001: el NIF del receptor no es válido. Corrige el NIF en la factura y reenvía el registro de facturación.",
    actionLabel: "Abrir envíos",
    actionScreen: "FiscalSubmissionsCenter",
    timestamp: minutesAgo(8),
    demo: true
  },
  {
    id: "demo-period-overdue",
    severity: "critical",
    authority: "system",
    title: "Período fiscal 2026-T1 vencido",
    description: "El período terminó el 31/03/2026 y sigue abierto. Ciérralo para bloquear asientos y poder generar el Modelo 303.",
    actionLabel: "Cerrar período",
    actionScreen: "FiscalDashboard",
    timestamp: daysAgo(2),
    demo: true
  },
  {
    id: "demo-ses-1",
    severity: "warning",
    authority: "ses",
    title: "SES.HOSPEDAJES · parte rechazado — Reserva RES-00042",
    description: "El parte de viajeros fue rechazado: falta el número de soporte del documento de un huésped. Completa los datos y reenvía.",
    actionLabel: "Abrir SES.HOSPEDAJES",
    actionScreen: "SesHospedajesSettings",
    timestamp: minutesAgo(45),
    demo: true
  },
  {
    id: "demo-tbai-1",
    severity: "warning",
    authority: "tbai",
    title: "TicketBAI · reintentando — Factura F-2026/000150",
    description: "Envío en cola para reintento automático. Próximo intento en ~5 min. Intentos hasta ahora: 2.",
    actionLabel: "Abrir envíos",
    actionScreen: "FiscalSubmissionsCenter",
    timestamp: minutesAgo(12),
    demo: true
  },
  {
    id: "demo-period-soon",
    severity: "warning",
    authority: "system",
    title: "El período fiscal 2026-T2 cierra en 5 días",
    description: "Ciérralo antes de la presentación en AEAT. Los asientos con fecha posterior al 30/06/2026 quedarán bloqueados.",
    actionLabel: "Abrir período",
    actionScreen: "FiscalDashboard",
    timestamp: daysAgo(1),
    demo: true
  },
  {
    id: "demo-igic-1",
    severity: "info",
    authority: "igic",
    title: "IGIC · recordatorio — Modelo 420 trimestral",
    description: "El plazo de presentación del Modelo 420 (IGIC, Canarias) abre el 1 de julio. Revisa los importes acumulados del trimestre.",
    actionLabel: "Ajustes fiscales",
    actionScreen: "TaxComplianceSettings",
    timestamp: daysAgo(3),
    demo: true
  },
  {
    id: "demo-cert-1",
    severity: "info",
    authority: "system",
    title: "El certificado de firma caduca en 30 días",
    description: "El certificado digital (AEAT) caduca el 24/06/2026. Renuévalo a tiempo para no interrumpir VeriFactu ni el SII.",
    actionLabel: "Ajustes de cumplimiento",
    actionScreen: "TaxComplianceSettings",
    timestamp: daysAgo(5),
    demo: true
  }
];

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

  const [showDemo, setShowDemo] = useState(true);
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

  const isDemoMode = realAlerts.length === 0 && showDemo;
  const sourceAlerts = realAlerts.length > 0 ? realAlerts : isDemoMode ? DEMO_ALERTS : [];
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
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Cumplimiento · Bandeja</div>
          <h1 className="bo-page-title">Bandeja de cumplimiento</h1>
          <p className="bo-page-subtitle">
            Un único feed con todo lo que requiere atención humana: envíos rechazados, períodos fiscales a punto de cerrar y
            certificados que caducan, en VeriFactu, TicketBAI, IGIC y SES.HOSPEDAJES. Se actualiza automáticamente cada 15 s.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" onClick={refreshAll}>↻ Actualizar</button>
        </div>
      </div>

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
          <div className="rev-kpi-delta">4 autoridades + sistema</div>
        </article>
      </section>

      {/* Demo banner */}
      {isDemoMode ? (
        <div
          className="bo-card"
          style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, borderLeft: "3px solid var(--info-ink)" }}
        >
          <div>
            <strong>Datos de ejemplo</strong>
            <p style={{ margin: "4px 0 0", color: "var(--ink-muted)", fontSize: 13 }}>
              No hay alertas reales ahora mismo. Mostramos ejemplos para previsualizar cómo se ve la bandeja con actividad. En
              cuanto entre una alerta real, los ejemplos se ocultan automáticamente.
            </p>
          </div>
          <button type="button" onClick={() => setShowDemo(false)}>Ocultar ejemplos</button>
        </div>
      ) : null}

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
            <h3 style={{ marginBottom: 8 }}>✅ Nada que atender</h3>
            <p style={{ color: "var(--ink-muted)" }}>
              No hay envíos rechazados ni períodos fiscales vencidos. El pipeline está sano.
            </p>
            {!showDemo && realAlerts.length === 0 ? (
              <button type="button" style={{ marginTop: 12 }} onClick={() => { setShowDemo(true); setFilter("all"); }}>
                Ver ejemplos
              </button>
            ) : null}
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
                      {alert.demo ? <span className="bo-status info" style={{ textTransform: "none" }}>Demo</span> : null}
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
