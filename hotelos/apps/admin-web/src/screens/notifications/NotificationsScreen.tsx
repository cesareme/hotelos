// Notifications screen (Sprint 26 — Notification engine + document template
// renderer). Three tabs: Templates, Deliveries, Stats. All data flows through
// `useApiData` so mutations refresh the table that changed without forcing a
// full-page reload.

import { getActivePropertyId } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";

const PROPERTY_ID = getActivePropertyId();
const ORG_ID = "org_demo";

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

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("es-ES", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return value;
  }
}

function statusPill(status: Delivery["status"]) {
  if (status === "sent") return <span className="bo-status ok">sent</span>;
  if (status === "failed" || status === "bounced") return <span className="bo-status" style={{ color: "var(--danger-ink)" }}>{status}</span>;
  return <span className="bo-status warn">{status}</span>;
}

// ---- screen ----

export function NotificationsScreen() {
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
          <div className="bo-page-eyebrow">Notification engine</div>
          <h1 className="bo-page-title">Notificaciones y plantillas</h1>
          <p className="bo-page-subtitle">
            Manage templates per channel (email · SMS · WhatsApp), inspect delivery history, and monitor send
            volumes. Invoices, reservation confirmations and payment receipts auto-dispatch from the event bus.
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
            ↻ Refresh
          </button>
        </div>
      </div>

      <section className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Sent (last 30d)</span></div>
          <div className="rev-kpi-value">{sentCount}</div>
          <div className="rev-kpi-delta">delivered</div>
        </article>
        <article className={`rev-kpi ${failedCount > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Failed</span></div>
          <div className="rev-kpi-value">{failedCount}</div>
          <div className="rev-kpi-delta">retry from the deliveries tab</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Queued</span></div>
          <div className="rev-kpi-value">{queuedCount}</div>
          <div className="rev-kpi-delta">awaiting send</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Active templates</span></div>
          <div className="rev-kpi-value">{toArray<NotificationTemplate>(templates.data).filter((t) => t.active).length}</div>
          <div className="rev-kpi-delta">{toArray<NotificationTemplate>(templates.data).length} total</div>
        </article>
      </section>

      {error ? (
        <div className="bo-card" style={{ borderLeft: "3px solid var(--danger-ink)", marginBottom: 16 }}>
          Couldn't load this view right now. Refresh to retry.
        </div>
      ) : null}

      <div className="rev-toolbar" style={{ gap: 8 }}>
        <button type="button" className={tab === "templates" ? "primary" : "ghost"} onClick={() => setTab("templates")}>
          Templates ({templates.data?.length ?? 0})
        </button>
        <button type="button" className={tab === "deliveries" ? "primary" : "ghost"} onClick={() => setTab("deliveries")}>
          Deliveries ({deliveries.data?.length ?? 0})
        </button>
        <button type="button" className={tab === "stats" ? "primary" : "ghost"} onClick={() => setTab("stats")}>
          Stats
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
        <h2 style={{ fontSize: 20 }}>Notification templates</h2>
        <button type="button" className="primary" onClick={props.onToggleForm}>
          {props.showForm ? "Cancel" : "+ Add / edit template"}
        </button>
      </div>

      {props.showForm ? <TemplateForm onCreated={props.onCreated} /> : null}

      {props.loading ? (
        <p style={{ color: "var(--ink-muted)" }}>Loading templates…</p>
      ) : props.fetchError ? (
        <p style={{ color: "var(--danger-ink)" }}>{props.fetchError}</p>
      ) : (props.templates ?? []).length === 0 ? (
        <p style={{ color: "var(--ink-muted)" }}>
          No templates yet. Add the first one — needed codes include
          {" "}<code>invoice_issued</code>, <code>reservation_confirmed</code> and <code>payment_receipt</code>.
        </p>
      ) : (
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Channel</th>
                <th>Lang</th>
                <th>Scope</th>
                <th>Subject</th>
                <th>Tokens</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(props.templates ?? []).map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.code}</strong></td>
                  <td>{t.channel}</td>
                  <td>{t.language}</td>
                  <td>{t.propertyId ? "property" : <span style={{ color: "var(--ink-muted)" }}>org-wide</span>}</td>
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
                        {props.busy === `deact-${t.id}` ? "…" : "Deactivate"}
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
      setFormError("Template code is required.");
      return;
    }
    if (!body.trim()) {
      setFormError("Template body cannot be empty.");
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
      <h3 style={{ fontSize: 16, marginTop: 0 }}>New / update template</h3>
      <div className="bo-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <label>
          Code
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="invoice_issued" />
        </label>
        <label>
          Channel
          <select value={channel} onChange={(e) => setChannel(e.target.value as "email" | "sms" | "whatsapp")}>
            <option value="email">email</option>
            <option value="sms">sms</option>
            <option value="whatsapp">whatsapp</option>
          </select>
        </label>
        <label>
          Language
          <input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="es" />
        </label>
        <label>
          Scope
          <select value={scope} onChange={(e) => setScope(e.target.value as "property" | "org")}>
            <option value="property">property-scoped</option>
            <option value="org">org-wide default</option>
          </select>
        </label>
      </div>
      <label style={{ display: "block", marginTop: 12 }}>
        Subject (email/WhatsApp only)
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Factura {{invoice_number}}" />
      </label>
      <label style={{ display: "block", marginTop: 12 }}>
        Body
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 13 }}
        />
      </label>
      <p style={{ color: "var(--ink-muted)", fontSize: 12, marginTop: 4 }}>
        Tokens: <code>{"{{var}}"}</code> or <code>{"{{var | default: \"fallback\"}}"}</code>. Dotted paths
        like <code>{"{{guest.name}}"}</code> are supported one level deep.
      </p>
      {formError ? <p style={{ color: "var(--danger-ink)", marginTop: 8 }}>{formError}</p> : null}
      <div style={{ marginTop: 12 }}>
        <button type="button" className="primary" disabled={submitting} onClick={submit}>
          {submitting ? "Saving…" : "Save template"}
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
        <h2 style={{ fontSize: 20 }}>Delivery log</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={props.statusFilter} onChange={(e) => props.onStatusFilter(e.target.value)}>
            <option value="">all statuses</option>
            <option value="sent">sent</option>
            <option value="failed">failed</option>
            <option value="queued">queued</option>
            <option value="bounced">bounced</option>
          </select>
          <select value={props.channelFilter} onChange={(e) => props.onChannelFilter(e.target.value)}>
            <option value="">all channels</option>
            <option value="email">email</option>
            <option value="sms">sms</option>
            <option value="whatsapp">whatsapp</option>
          </select>
        </div>
      </div>

      {props.loading ? (
        <p style={{ color: "var(--ink-muted)" }}>Loading deliveries…</p>
      ) : props.fetchError ? (
        <p style={{ color: "var(--danger-ink)" }}>{props.fetchError}</p>
      ) : (props.deliveries ?? []).length === 0 ? (
        <p style={{ color: "var(--ink-muted)" }}>
          No deliveries yet. Issue an invoice or create a reservation with a booker email and the engine will
          queue one automatically.
        </p>
      ) : (
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Channel</th>
                <th>Template</th>
                <th>Recipient</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Attempts</th>
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
                        {props.busy === `retry-${d.id}` ? "…" : "Retry"}
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
        <h2 style={{ fontSize: 20 }}>Template performance · last {props.days} days</h2>
        <select value={props.days} onChange={(e) => props.onChangeDays(Number(e.target.value))}>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
      </div>

      <section className="rev-kpi-grid" style={{ marginBottom: 16 }}>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Total sent</span></div>
          <div className="rev-kpi-value">{totalSent}</div>
        </article>
        <article className={`rev-kpi ${totalFailed > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Total failed</span></div>
          <div className="rev-kpi-value">{totalFailed}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Failure rate</span></div>
          <div className="rev-kpi-value">{failureRate.toFixed(1)}%</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Queued / pending</span></div>
          <div className="rev-kpi-value">{totalQueued}</div>
        </article>
      </section>

      {props.loading ? (
        <p style={{ color: "var(--ink-muted)" }}>Loading stats…</p>
      ) : props.fetchError ? (
        <p style={{ color: "var(--danger-ink)" }}>{props.fetchError}</p>
      ) : (props.stats ?? []).length === 0 ? (
        <p style={{ color: "var(--ink-muted)" }}>No deliveries in this window.</p>
      ) : (
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>Template</th>
                <th>Channel</th>
                <th style={{ textAlign: "right" }}>Sent</th>
                <th style={{ textAlign: "right" }}>Failed</th>
                <th style={{ textAlign: "right" }}>Queued</th>
                <th style={{ textAlign: "right" }}>Total</th>
                <th>Last sent</th>
                <th>Last failed</th>
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
