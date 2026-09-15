// Notifications screen (Sprint 26 — Notification engine + document template
// renderer). Three tabs: Templates, Deliveries, Stats. All data flows through
// `useApiData` so mutations refresh the table that changed without forcing a
// full-page reload.

import { getActiveOrganizationId, getActivePropertyId } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { dateTime, percent, plural } from "../../lib/format";

const PROPERTY_ID = getActivePropertyId();
// Organisation of the active property (never a fixed demo id: Los Tilos answered 404 ×3, browser-roles#10).
const ORG_ID = getActiveOrganizationId();

// ---- types ----

type NotificationTemplate = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  code: string;
  channel: string;
  language: string;
  subject: string | null;
  body: string;
  variablesJson?: unknown;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  tokens: string[];
};

type Delivery = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  notificationId: string | null;
  templateCode: string | null;
  channel: string;
  recipient: string;
  status: "pending" | "queued" | "sent" | "failed" | "bounced";
  providerMessageId: string | null;
  subject: string | null;
  bodyRendered: string | null;
  attempts: number;
  errorMessage: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type TemplateStat = {
  templateCode: string;
  channel: string;
  sent: number;
  failed: number;
  queued: number;
  total: number;
  lastSentAt: string | null;
  lastFailedAt: string | null;
};

type TabKey = "templates" | "deliveries" | "stats";

// ---- helpers ----

const DELIVERY_STATUS_LABEL: Record<Delivery["status"], string> = {
  pending: "pendiente",
  queued: "en cola",
  sent: "enviado",
  failed: "fallido",
  bounced: "rebotado"
};

function formatDateTime(value: string | null): string {
  return dateTime(value);
}

function statusPill(status: Delivery["status"]) {
  if (status === "sent") return <span className="bo-status ok">{DELIVERY_STATUS_LABEL.sent}</span>;
  if (status === "failed" || status === "bounced") return <span className="bo-status" style={{ color: "var(--danger-ink)" }}>{DELIVERY_STATUS_LABEL[status]}</span>;
  return <span className="bo-status warn">{DELIVERY_STATUS_LABEL[status] ?? status}</span>;
}

// ---- screen ----

export function NotificationsScreen({ embedded = false }: { embedded?: boolean } = {}) {
  // Inside a tab container (Tanda 5) the page header belongs to the container: eyebrow and title are not painted.
  const { showToast } = useToast();
  const [tab, setTab] = useState<TabKey>("templates");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNewTemplate, setShowNewTemplate] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [channelFilter, setChannelFilter] = useState<string>("");
  const [statsDays, setStatsDays] = useState<number>(30);

  const templates = useApiData<NotificationTemplate[]>("/notifications/templates", {
    query: { organizationId: ORG_ID, propertyId: PROPERTY_ID }
  });
  const deliveries = useApiData<Delivery[]>("/notifications/deliveries", {
    query: {
      organizationId: ORG_ID,
      propertyId: PROPERTY_ID,
      status: statusFilter || undefined,
      channel: channelFilter || undefined,
      days: 30
    }
  });
  const stats = useApiData<TemplateStat[]>("/notifications/template-stats", {
    query: { organizationId: ORG_ID, propertyId: PROPERTY_ID, days: statsDays }
  });

  // Defensive: backend may return raw array or envelope { items: [] }; coerce once.
  const deliveryList = useMemo(() => toArray<Delivery>(deliveries.data), [deliveries.data]);
  const sentCount = useMemo<number>(
    () => deliveryList.filter((d) => d.status === "sent").length,
    [deliveryList]
  );
  const failedCount = useMemo<number>(
    () => deliveryList.filter((d) => d.status === "failed" || d.status === "bounced").length,
    [deliveryList]
  );
  const queuedCount = useMemo<number>(
    () => deliveryList.filter((d) => d.status === "queued" || d.status === "pending").length,
    [deliveryList]
  );

  async function handleDeactivateTemplate(id: string) {
    setBusy(`deact-${id}`);
    setError(null);
    try {
      await apiRequest(`/notifications/templates/${id}/deactivate`, { method: "POST" });
      templates.refresh();
      showToast("Plantilla desactivada", { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function handleRetry(id: string) {
    setBusy(`retry-${id}`);
    setError(null);
    try {
      await apiRequest(`/notifications/deliveries/${id}/retry`, { method: "POST" });
      deliveries.refresh();
      stats.refresh();
      showToast("Envío reintentado", { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          {embedded ? null : <div className="bo-page-eyebrow">Comunicaciones</div>}
          {embedded ? null : <h1 className="bo-page-title">Notificaciones y plantillas</h1>}
          <p className="bo-page-subtitle">
            Plantillas por canal (correo · SMS · WhatsApp), historial de envíos y volúmenes. Las facturas, las
            confirmaciones de reserva y los recibos de pago se envían solos cuando ocurre el evento.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button
            type="button"
            className="ghost"
            onClick={() => {
              templates.refresh();
              deliveries.refresh();
              stats.refresh();
            }}
          >
            ↻ Actualizar
          </button>
        </div>
      </div>

      <section className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Enviadas (30 días)</span></div>
          <div className="rev-kpi-value">{sentCount}</div>
          <div className="rev-kpi-delta">entregadas</div>
        </article>
        <article className={`rev-kpi ${failedCount > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Fallidas</span></div>
          <div className="rev-kpi-value">{failedCount}</div>
          <div className="rev-kpi-delta">reintenta desde la pestaña de envíos</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">En cola</span></div>
          <div className="rev-kpi-value">{queuedCount}</div>
          <div className="rev-kpi-delta">pendientes de envío</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Plantillas activas</span></div>
          <div className="rev-kpi-value">{toArray<NotificationTemplate>(templates.data).filter((t) => t.active).length}</div>
          <div className="rev-kpi-delta">{toArray<NotificationTemplate>(templates.data).length} en total</div>
        </article>
      </section>

      {error ? (
        <div className="bo-card" style={{ borderLeft: "3px solid var(--danger-ink)", marginBottom: 16 }}>
          No hemos podido cargar esta vista. Inténtalo de nuevo.
        </div>
      ) : null}

      <div className="rev-toolbar" style={{ gap: 8 }}>
        <button type="button" className={tab === "templates" ? "primary" : "ghost"} onClick={() => setTab("templates")}>
          Plantillas ({templates.data?.length ?? 0})
        </button>
        <button type="button" className={tab === "deliveries" ? "primary" : "ghost"} onClick={() => setTab("deliveries")}>
          Envíos ({deliveries.data?.length ?? 0})
        </button>
        <button type="button" className={tab === "stats" ? "primary" : "ghost"} onClick={() => setTab("stats")}>
          Estadísticas
        </button>
      </div>

      {tab === "templates" ? (
        <TemplatesTab
          templates={templates.data}
          loading={templates.loading}
          fetchError={templates.error}
          showForm={showNewTemplate}
          onToggleForm={() => setShowNewTemplate((v) => !v)}
          onCreated={() => {
            setShowNewTemplate(false);
            templates.refresh();
          }}
          onDeactivate={handleDeactivateTemplate}
          busy={busy}
        />
      ) : null}

      {tab === "deliveries" ? (
        <DeliveriesTab
          deliveries={deliveries.data}
          loading={deliveries.loading}
          fetchError={deliveries.error}
          statusFilter={statusFilter}
          channelFilter={channelFilter}
          onStatusFilter={setStatusFilter}
          onChannelFilter={setChannelFilter}
          onRetry={handleRetry}
          busy={busy}
        />
      ) : null}

      {tab === "stats" ? (
        <StatsTab
          stats={stats.data}
          loading={stats.loading}
          fetchError={stats.error}
          days={statsDays}
          onChangeDays={setStatsDays}
        />
      ) : null}
    </>
  );
}

// ---- Tab: Templates ----

function TemplatesTab(props: {
  templates: NotificationTemplate[] | null;
  loading: boolean;
  fetchError: string | null;
  showForm: boolean;
  onToggleForm: () => void;
  onCreated: () => void;
  onDeactivate: (id: string) => void;
  busy: string | null;
}) {
  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <h2 style={{ fontSize: 20 }}>Plantillas de notificación</h2>
        <button type="button" className="primary" onClick={props.onToggleForm}>
          {props.showForm ? "Cancelar" : "+ Añadir o editar plantilla"}
        </button>
      </div>

      {props.showForm ? <TemplateForm onCreated={props.onCreated} /> : null}

      {props.loading ? (
        <p style={{ color: "var(--ink-muted)" }}>Cargando plantillas…</p>
      ) : props.fetchError ? (
        <p style={{ color: "var(--danger-ink)" }}>{props.fetchError}</p>
      ) : (props.templates ?? []).length === 0 ? (
        <p style={{ color: "var(--ink-muted)" }}>
          Todavía no hay plantillas. Añade la primera; los códigos que usa el motor son
          {" "}<code>invoice_issued</code>, <code>reservation_confirmed</code> y <code>payment_receipt</code>.
        </p>
      ) : (
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>Código</th>
                <th>Canal</th>
                <th>Idioma</th>
                <th>Ámbito</th>
                <th>Asunto</th>
                <th>Variables</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(props.templates ?? []).map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.code}</strong></td>
                  <td>{t.channel}</td>
                  <td>{t.language}</td>
                  <td>{t.propertyId ? "propiedad" : <span style={{ color: "var(--ink-muted)" }}>organización</span>}</td>
                  <td style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.subject ?? <span style={{ color: "var(--ink-muted)" }}>—</span>}
                  </td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                    {t.tokens.length === 0 ? "—" : t.tokens.slice(0, 4).join(", ")}
                    {t.tokens.length > 4 ? ` +${t.tokens.length - 4}` : ""}
                  </td>
                  <td>
                    <span className={t.active ? "bo-status ok" : "bo-status"}>
                      {t.active ? "active" : "inactive"}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {t.active ? (
                      <button
                        type="button"
                        className="ghost"
                        disabled={props.busy === `deact-${t.id}`}
                        onClick={() => props.onDeactivate(t.id)}
                      >
                        {props.busy === `deact-${t.id}` ? "…" : "Desactivar"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TemplateForm(props: { onCreated: () => void }) {
  const [code, setCode] = useState("invoice_issued");
  const [channel, setChannel] = useState<"email" | "sms" | "whatsapp">("email");
  const [language, setLanguage] = useState("es");
  const [subject, setSubject] = useState("Factura {{invoice_number}}");
  const [body, setBody] = useState(
    "Estimado/a {{booker_name | default: \"cliente\"}},\n\nAdjuntamos la factura {{invoice_number}} por importe de {{invoice_total}} {{currency}}.\n\nGracias,\n{{property_name}}"
  );
  const [scope, setScope] = useState<"property" | "org">("property");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit() {
    if (!code.trim()) {
      setFormError("El código de la plantilla es obligatorio.");
      return;
    }
    if (!body.trim()) {
      setFormError("El cuerpo de la plantilla no puede estar vacío.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await apiRequest("/notifications/templates", {
        method: "POST",
        body: {
          organizationId: ORG_ID,
          propertyId: scope === "property" ? PROPERTY_ID : null,
          code: code.trim(),
          channel,
          language: language.trim() || "es",
          subject: subject.trim() || null,
          body
        }
      });
      props.onCreated();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="bo-card"
      style={{ background: "var(--surface)", marginBottom: 16, padding: 16, border: "1px solid var(--line)" }}
    >
      <h3 style={{ fontSize: 16, marginTop: 0 }}>Nueva plantilla o actualización</h3>
      <div className="bo-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <label>
          Código
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="invoice_issued" />
        </label>
        <label>
          Canal
          <select value={channel} onChange={(e) => setChannel(e.target.value as "email" | "sms" | "whatsapp")}>
            <option value="email">correo</option>
            <option value="sms">SMS</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
        </label>
        <label>
          Idioma
          <input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="es" />
        </label>
        <label>
          Ámbito
          <select value={scope} onChange={(e) => setScope(e.target.value as "property" | "org")}>
            <option value="property">de esta propiedad</option>
            <option value="org">predeterminada de la organización</option>
          </select>
        </label>
      </div>
      <label style={{ display: "block", marginTop: 12 }}>
        Asunto (solo correo y WhatsApp)
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Factura {{invoice_number}}" />
      </label>
      <label style={{ display: "block", marginTop: 12 }}>
        Cuerpo
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 13 }}
        />
      </label>
      <p style={{ color: "var(--ink-muted)", fontSize: 12, marginTop: 4 }}>
        Variables: <code>{"{{var}}"}</code> o <code>{"{{var | default: \"valor\"}}"}</code>. Se admiten rutas con punto
        como <code>{"{{guest.name}}"}</code> (un nivel).
      </p>
      {formError ? <p style={{ color: "var(--danger-ink)", marginTop: 8 }}>{formError}</p> : null}
      <div style={{ marginTop: 12 }}>
        <button type="button" className="primary" disabled={submitting} onClick={submit}>
          {submitting ? "Guardando…" : "Guardar plantilla"}
        </button>
      </div>
    </div>
  );
}

// ---- Tab: Deliveries ----

function DeliveriesTab(props: {
  deliveries: Delivery[] | null;
  loading: boolean;
  fetchError: string | null;
  statusFilter: string;
  channelFilter: string;
  onStatusFilter: (v: string) => void;
  onChannelFilter: (v: string) => void;
  onRetry: (id: string) => void;
  busy: string | null;
}) {
  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <h2 style={{ fontSize: 20 }}>Registro de envíos</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={props.statusFilter} onChange={(e) => props.onStatusFilter(e.target.value)}>
            <option value="">todos los estados</option>
            <option value="sent">enviado</option>
            <option value="failed">fallido</option>
            <option value="queued">en cola</option>
            <option value="bounced">rebotado</option>
          </select>
          <select value={props.channelFilter} onChange={(e) => props.onChannelFilter(e.target.value)}>
            <option value="">todos los canales</option>
            <option value="email">email</option>
            <option value="sms">sms</option>
            <option value="whatsapp">whatsapp</option>
          </select>
        </div>
      </div>

      {props.loading ? (
        <p style={{ color: "var(--ink-muted)" }}>Cargando envíos…</p>
      ) : props.fetchError ? (
        <p style={{ color: "var(--danger-ink)" }}>{props.fetchError}</p>
      ) : (props.deliveries ?? []).length === 0 ? (
        <p style={{ color: "var(--ink-muted)" }}>
          Todavía no hay envíos. Emite una factura o crea una reserva con el correo del titular y el motor
          encolará uno automáticamente.
        </p>
      ) : (
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>Cuándo</th>
                <th>Canal</th>
                <th>Plantilla</th>
                <th>Destinatario</th>
                <th>Asunto</th>
                <th>Estado</th>
                <th>Intentos</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(props.deliveries ?? []).map((d) => (
                <tr key={d.id}>
                  <td>{formatDateTime(d.createdAt)}</td>
                  <td>{d.channel}</td>
                  <td><strong>{d.templateCode ?? "(manual)"}</strong></td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{d.recipient}</td>
                  <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {d.subject ?? <span style={{ color: "var(--ink-muted)" }}>—</span>}
                  </td>
                  <td>
                    <div>{statusPill(d.status)}</div>
                    {d.errorMessage ? (
                      <div style={{ color: "var(--danger-ink)", fontSize: 11, marginTop: 4 }}>{d.errorMessage}</div>
                    ) : null}
                  </td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{d.attempts}</td>
                  <td style={{ textAlign: "right" }}>
                    {d.status === "failed" || d.status === "bounced" ? (
                      <button
                        type="button"
                        className="ghost"
                        disabled={props.busy === `retry-${d.id}`}
                        onClick={() => props.onRetry(d.id)}
                      >
                        {props.busy === `retry-${d.id}` ? "…" : "Reintentar"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---- Tab: Stats ----

function StatsTab(props: {
  stats: TemplateStat[] | null;
  loading: boolean;
  fetchError: string | null;
  days: number;
  onChangeDays: (n: number) => void;
}) {
  const totalSent = (props.stats ?? []).reduce((sum, s) => sum + s.sent, 0);
  const totalFailed = (props.stats ?? []).reduce((sum, s) => sum + s.failed, 0);
  const totalQueued = (props.stats ?? []).reduce((sum, s) => sum + s.queued, 0);
  const failureRate = totalSent + totalFailed > 0 ? (totalFailed / (totalSent + totalFailed)) * 100 : 0;

  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <h2 style={{ fontSize: 20 }}>Rendimiento de las plantillas · últimos {plural(props.days, "día", "días", { withCount: true })}</h2>
        <select value={props.days} onChange={(e) => props.onChangeDays(Number(e.target.value))} aria-label="Ventana de días">
          <option value={7}>7 días</option>
          <option value={30}>30 días</option>
          <option value={90}>90 días</option>
        </select>
      </div>

      <section className="rev-kpi-grid" style={{ marginBottom: 16 }}>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Total enviadas</span></div>
          <div className="rev-kpi-value">{totalSent}</div>
        </article>
        <article className={`rev-kpi ${totalFailed > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Total fallidas</span></div>
          <div className="rev-kpi-value">{totalFailed}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tasa de fallos</span></div>
          <div className="rev-kpi-value">{percent(failureRate, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">En cola / pendientes</span></div>
          <div className="rev-kpi-value">{totalQueued}</div>
        </article>
      </section>

      {props.loading ? (
        <p style={{ color: "var(--ink-muted)" }}>Cargando estadísticas…</p>
      ) : props.fetchError ? (
        <p style={{ color: "var(--danger-ink)" }}>{props.fetchError}</p>
      ) : (props.stats ?? []).length === 0 ? (
        <p style={{ color: "var(--ink-muted)" }}>Sin envíos en este periodo.</p>
      ) : (
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>Plantilla</th>
                <th>Canal</th>
                <th style={{ textAlign: "right" }}>Enviadas</th>
                <th style={{ textAlign: "right" }}>Fallidas</th>
                <th style={{ textAlign: "right" }}>En cola</th>
                <th style={{ textAlign: "right" }}>Total</th>
                <th>Último envío</th>
                <th>Último fallo</th>
              </tr>
            </thead>
            <tbody>
              {(props.stats ?? []).map((s) => (
                <tr key={`${s.templateCode}-${s.channel}`}>
                  <td><strong>{s.templateCode}</strong></td>
                  <td>{s.channel}</td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{s.sent}</td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", color: s.failed > 0 ? "var(--danger-ink)" : undefined }}>
                    {s.failed}
                  </td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{s.queued}</td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>{s.total}</td>
                  <td>{formatDateTime(s.lastSentAt)}</td>
                  <td>{formatDateTime(s.lastFailedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
