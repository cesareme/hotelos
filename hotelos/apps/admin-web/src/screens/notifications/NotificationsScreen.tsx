// Comunicaciones · Plantillas y envíos — /configuracion/comunicaciones (base
// tab of ComunicacionesTabs; Cocoa 22 · ola 10 · lote 10-B, plantilla
// DashboardAlojado).
//
// Notification engine (templates · deliveries · stats) over
// /notifications/templates, /notifications/deliveries and
// /notifications/template-stats. All data flows through `useApiData` so a
// mutation refreshes only the table that changed. The template form opens in
// a CocoaDrawer; the delivery filters live in a CocoaToolbar; every table is
// a CocoaTable. Same endpoints, queries and bodies as before.
//
// Tanda L8 (lote L8-03): a `sent` row with errorMessage «SIMULADO…» never left
// the box (no provider). Badge, filter and KPIs derive the real outcome from
// ./delivery-outcome.ts; «Enviadas» counts real sends only.

import { getActiveOrganizationId, getActivePropertyId } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { dateTime, number, percent, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { PlusIcon } from "../../components/cocoa-icons/ActionIcons";
import { useTabHost } from "../tabs/TabHost";
import {
  DELIVERY_OUTCOME_LABEL,
  OUTCOME_FILTER_OPTIONS,
  apiStatusForOutcomeFilter,
  deliveryOutcome,
  deliveryOutcomeTone,
  matchesOutcomeFilter,
  splitSentCounts,
  type DeliveryStatus
} from "./delivery-outcome";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn
} from "../../components/cocoa";

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
  status: DeliveryStatus;
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
  /** Real sends only. */
  sent: number;
  /** `sent` rows without a provider («SIMULADO»); optional while an older API still answers. */
  simulated?: number;
  failed: number;
  queued: number;
  total: number;
  lastSentAt: string | null;
  lastFailedAt: string | null;
};

type TabKey = "templates" | "deliveries" | "stats";

// ---- helpers ----

const CHANNEL_LABEL: Record<string, string> = { email: "correo", sms: "SMS", whatsapp: "WhatsApp" };

function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel] ?? channel;
}

// The wire status alone lies: a `sent` row whose errorMessage starts with
// «SIMULADO» was never delivered. The badge paints the real outcome («simulado»,
// warning) and the row keeps the API message underneath as the explanation.
function statusBadge(d: Pick<Delivery, "status" | "errorMessage">) {
  const outcome = deliveryOutcome(d);
  return (
    <CocoaBadge tone={deliveryOutcomeTone(outcome)} variant="tinted" size="small">
      {DELIVERY_OUTCOME_LABEL[outcome]}
    </CocoaBadge>
  );
}

/** «3 simuladas (sin proveedor)» — caption of a sent counter when part of it never left the box. */
function simulatedCaption(simulated: number): string {
  return `${plural(simulated, "simulada", "simuladas")} (sin proveedor)`;
}

const VIEWS: Array<{ value: TabKey; label: string }> = [
  { value: "templates", label: "Plantillas" },
  { value: "deliveries", label: "Envíos" },
  { value: "stats", label: "Estadísticas" }
];

const CHANNEL_FILTER_OPTIONS = [
  { value: "", label: "Todos los canales" },
  { value: "email", label: "correo" },
  { value: "sms", label: "SMS" },
  { value: "whatsapp", label: "WhatsApp" }
];

const WINDOW_OPTIONS = [
  { value: "7", label: "7 días" },
  { value: "30", label: "30 días" },
  { value: "90", label: "90 días" }
];

// ---- screen ----

export function NotificationsScreen() {
  // Hosted (ComunicacionesTabs): the container paints eyebrow + H1.
  const hosted = useTabHost() !== null;
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
      status: apiStatusForOutcomeFilter(statusFilter),
      channel: channelFilter || undefined,
      days: 30
    }
  });
  const stats = useApiData<TemplateStat[]>("/notifications/template-stats", {
    query: { organizationId: ORG_ID, propertyId: PROPERTY_ID, days: statsDays }
  });

  // Defensive: backend may return raw array or envelope { items: [] }; coerce once.
  const templateList = useMemo(() => toArray<NotificationTemplate>(templates.data), [templates.data]);
  const deliveryList = useMemo(() => toArray<Delivery>(deliveries.data), [deliveries.data]);
  const statList = useMemo(() => toArray<TemplateStat>(stats.data), [stats.data]);
  // «enviado» / «simulado» both ask the API for `sent`; the table narrows to the real outcome while the KPIs read the whole window.
  const visibleDeliveries = useMemo(() => deliveryList.filter((d) => matchesOutcomeFilter(d, statusFilter)), [deliveryList, statusFilter]);
  const sentCounts = useMemo(() => splitSentCounts(deliveryList), [deliveryList]);
  const failedCount = useMemo<number>(() => deliveryList.filter((d) => d.status === "failed" || d.status === "bounced").length, [deliveryList]);
  const queuedCount = useMemo<number>(() => deliveryList.filter((d) => d.status === "queued" || d.status === "pending").length, [deliveryList]);
  const activeTemplates = templateList.filter((t) => t.active).length;

  function refreshAll() {
    templates.refresh();
    deliveries.refresh();
    stats.refresh();
  }

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
    <CocoaPage
      eyebrow="Configuración · Comunicaciones"
      title="Notificaciones y plantillas"
      subtitle={
        hosted
          ? undefined
          : "Plantillas por canal (correo · SMS · WhatsApp), historial de envíos y volúmenes. Las facturas, las confirmaciones de reserva y los recibos de pago se envían solos cuando ocurre el evento."
      }
      tabs={VIEWS}
      activeTab={tab}
      onTabChange={(value) => setTab(value as TabKey)}
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll}>
          {ACTIONS.refresh}
        </CocoaButton>
      }
      commands={[
        { id: "comunicaciones-refresh", label: "Actualizar plantillas y envíos", run: refreshAll },
        { id: "comunicaciones-nueva-plantilla", label: "Añadir plantilla de notificación", run: () => setShowNewTemplate(true) }
      ]}
    >
      <CocoaKpiStrip stagger aria-label="Envíos de los últimos 30 días">
        <CocoaKpi
          label="Enviadas (30 días)"
          value={number(sentCounts.real)}
          caption={sentCounts.simulated > 0 ? simulatedCaption(sentCounts.simulated) : "entregadas"}
          polarity="neutral"
          status={sentCounts.simulated > 0 ? "warning" : "ok"}
        />
        <CocoaKpi label="Fallidas" value={number(failedCount)} caption="reintenta desde la pestaña de envíos" polarity="negative-good" status={failedCount > 0 ? "warning" : "ok"} />
        <CocoaKpi label="En cola" value={number(queuedCount)} caption="pendientes de envío" polarity="neutral" status="ok" />
        <CocoaKpi label="Plantillas activas" value={number(activeTemplates)} caption={`${plural(templateList.length, "plantilla", "plantillas")} en total`} polarity="neutral" status="ok" />
      </CocoaKpiStrip>

      {error ? (
        <CocoaCallout
          tone="danger"
          role="alert"
          title="No se pudo completar la acción"
          actions={
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setError(null)}>
              {ACTIONS.discard}
            </CocoaButton>
          }
        >
          {error}
        </CocoaCallout>
      ) : null}

      {tab === "templates" ? (
        <TemplatesTab
          templates={templateList}
          loading={templates.loading}
          fetchError={templates.error}
          onRetry={templates.refresh}
          showForm={showNewTemplate}
          onToggleForm={() => setShowNewTemplate((v) => !v)}
          onCreated={() => {
            setShowNewTemplate(false);
            templates.refresh();
          }}
          onDeactivate={(id) => void handleDeactivateTemplate(id)}
          busy={busy}
        />
      ) : null}

      {tab === "deliveries" ? (
        <DeliveriesTab
          deliveries={visibleDeliveries}
          loading={deliveries.loading}
          fetchError={deliveries.error}
          onRetryLoad={deliveries.refresh}
          statusFilter={statusFilter}
          channelFilter={channelFilter}
          onStatusFilter={setStatusFilter}
          onChannelFilter={setChannelFilter}
          onRetry={(id) => void handleRetry(id)}
          busy={busy}
        />
      ) : null}

      {tab === "stats" ? <StatsTab stats={statList} loading={stats.loading} fetchError={stats.error} onRetry={stats.refresh} days={statsDays} onChangeDays={setStatsDays} /> : null}
    </CocoaPage>
  );
}

// ---- Tab: Templates ----

const TEMPLATE_COLUMNS: CocoaTableColumn<NotificationTemplate>[] = [
  { key: "code", label: "Código", minWidth: 160, render: (t) => <strong>{t.code}</strong> },
  { key: "channel", label: "Canal", fit: true, render: (t) => channelLabel(t.channel) },
  { key: "language", label: "Idioma", fit: true, hideOnNarrow: true },
  { key: "scope", label: "Ámbito", fit: true, hideOnNarrow: true, render: (t) => (t.propertyId ? "propiedad" : <span className="cocoa-note">organización</span>) },
  {
    key: "subject",
    label: "Asunto",
    minWidth: 200,
    showFrom: "laptop",
    render: (t) => (
      <span className="cocoa-truncate" style={{ display: "block", maxWidth: 320 }}>
        {t.subject ?? "—"}
      </span>
    )
  },
  {
    key: "tokens",
    label: "Variables",
    showFrom: "desktop",
    render: (t) => (
      <code className="cocoa-mono">
        {t.tokens.length === 0 ? "—" : t.tokens.slice(0, 4).join(", ")}
        {t.tokens.length > 4 ? ` +${t.tokens.length - 4}` : ""}
      </code>
    )
  },
  {
    key: "active",
    label: "Estado",
    fit: true,
    render: (t) => (
      <CocoaBadge tone={t.active ? "success" : "neutral"} variant="tinted" size="small">
        {t.active ? "activa" : "inactiva"}
      </CocoaBadge>
    )
  }
];

function TemplatesTab(props: {
  templates: NotificationTemplate[];
  loading: boolean;
  fetchError: string | null;
  onRetry: () => void;
  showForm: boolean;
  onToggleForm: () => void;
  onCreated: () => void;
  onDeactivate: (id: string) => void;
  busy: string | null;
}) {
  const rows = props.templates;
  const ready = !props.fetchError && !(props.loading && rows.length === 0);

  return (
    <>
      <CocoaSection
        title="Plantillas de notificación"
        meta={plural(rows.length, "plantilla", "plantillas")}
        padding={ready && rows.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
        action={
          <CocoaButton variant="plain" tone="accent" size="small" icon={<PlusIcon size={14} />} onClick={props.onToggleForm}>
            Añadir plantilla
          </CocoaButton>
        }
      >
        {props.fetchError ? (
          <CocoaState kind="error" title="No se pudieron cargar las plantillas" message={props.fetchError} onRetry={props.onRetry} />
        ) : !props.loading && rows.length === 0 ? (
          <CocoaState
            kind="empty"
            title="Todavía no hay plantillas"
            message="Añade la primera; los códigos que usa el motor son invoice_issued, reservation_confirmed y payment_receipt."
            primaryAction={{ label: "Añadir plantilla", onClick: props.onToggleForm }}
          />
        ) : (
          <CocoaTable
            columns={TEMPLATE_COLUMNS}
            rows={rows}
            rowKey="id"
            loading={props.loading && rows.length === 0}
            rowActionsVisible="always"
            rowActions={(t) =>
              t.active ? (
                <CocoaButton variant="plain" size="small" tone="neutral" disabled={props.busy === `deact-${t.id}`} loading={props.busy === `deact-${t.id}`} onClick={() => props.onDeactivate(t.id)}>
                  {ACTIONS.deactivate}
                </CocoaButton>
              ) : null
            }
            caption="Plantillas de notificación"
            aria-label="Plantillas de notificación"
          />
        )}
      </CocoaSection>

      <TemplateForm open={props.showForm} onClose={props.onToggleForm} onCreated={props.onCreated} />
    </>
  );
}

const CHANNEL_OPTIONS = [
  { value: "email", label: "correo" },
  { value: "sms", label: "SMS" },
  { value: "whatsapp", label: "WhatsApp" }
];

const SCOPE_OPTIONS = [
  { value: "property", label: "de esta propiedad" },
  { value: "org", label: "predeterminada de la organización" }
];

function TemplateForm(props: { open: boolean; onClose: () => void; onCreated: () => void }) {
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

  const codeError = code.trim() ? undefined : "El código de la plantilla es obligatorio.";
  const bodyError = body.trim() ? undefined : "El cuerpo de la plantilla no puede estar vacío.";

  async function submit() {
    if (codeError || bodyError) {
      setFormError(codeError ?? bodyError ?? null);
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
    <CocoaDrawer
      open={props.open}
      onClose={props.onClose}
      title="Nueva plantilla o actualización"
      subtitle="Una plantilla por código, canal e idioma; guardar con el mismo código la actualiza."
      side="right"
      size="lg"
      footer={
        <div className="cocoa-row" data-justify="end" data-gap="2">
          <CocoaButton variant="bordered" tone="neutral" onClick={props.onClose}>
            {ACTIONS.cancel}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" disabled={submitting || Boolean(codeError) || Boolean(bodyError)} loading={submitting} onClick={() => void submit()}>
            {submitting ? STATUS_LABELS.saving : "Guardar plantilla"}
          </CocoaButton>
        </div>
      }
    >
      <CocoaFormSection title="Plantilla" description="Código que dispara el motor, canal, idioma y ámbito.">
        <CocoaFormRow columns={2}>
          <CocoaField label="Código" required error={codeError}>
            <CocoaInput value={code} onChange={setCode} placeholder="invoice_issued" />
          </CocoaField>
          <CocoaField label="Canal">
            <CocoaSelect value={channel} onChange={(v) => setChannel(v as "email" | "sms" | "whatsapp")} options={CHANNEL_OPTIONS} />
          </CocoaField>
          <CocoaField label="Idioma">
            <CocoaInput value={language} onChange={setLanguage} placeholder="es" maxLength={8} />
          </CocoaField>
          <CocoaField label="Ámbito">
            <CocoaSelect value={scope} onChange={(v) => setScope(v as "property" | "org")} options={SCOPE_OPTIONS} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>
      <CocoaFormSection title="Contenido" description={'Variables: {{var}} o {{var | default: "valor"}}. Se admiten rutas con punto como {{guest.name}} (un nivel).'}>
        <CocoaField label="Asunto (solo correo y WhatsApp)" fullWidth>
          <CocoaInput value={subject} onChange={setSubject} placeholder="Factura {{invoice_number}}" />
        </CocoaField>
        <CocoaField label="Cuerpo" required error={bodyError} fullWidth>
          <CocoaInput value={body} onChange={setBody} multiline rows={8} className="cocoa-mono" />
        </CocoaField>
      </CocoaFormSection>
      {formError ? (
        <CocoaCallout tone="danger" role="alert" title={STATUS_LABELS.saveError}>
          {formError}
        </CocoaCallout>
      ) : null}
    </CocoaDrawer>
  );
}

// ---- Tab: Deliveries ----

const DELIVERY_COLUMNS: CocoaTableColumn<Delivery>[] = [
  { key: "createdAt", label: "Cuándo", fit: true, render: (d) => dateTime(d.createdAt) },
  { key: "channel", label: "Canal", fit: true, render: (d) => channelLabel(d.channel) },
  { key: "templateCode", label: "Plantilla", minWidth: 140, render: (d) => <strong>{d.templateCode ?? "(manual)"}</strong> },
  { key: "recipient", label: "Destinatario", minWidth: 160, render: (d) => <code className="cocoa-mono">{d.recipient}</code> },
  {
    key: "subject",
    label: "Asunto",
    minWidth: 200,
    showFrom: "laptop",
    render: (d) => (
      <span className="cocoa-truncate" style={{ display: "block", maxWidth: 320 }}>
        {d.subject ?? "—"}
      </span>
    )
  },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (d) => (
      <>
        {statusBadge(d)}
        {d.errorMessage ? <span className="cocoa-note">{d.errorMessage}</span> : null}
      </>
    )
  },
  { key: "attempts", label: "Intentos", align: "right", fit: true, hideOnNarrow: true, render: (d) => number(d.attempts) }
];

function DeliveriesTab(props: {
  deliveries: Delivery[];
  loading: boolean;
  fetchError: string | null;
  onRetryLoad: () => void;
  statusFilter: string;
  channelFilter: string;
  onStatusFilter: (v: string) => void;
  onChannelFilter: (v: string) => void;
  onRetry: (id: string) => void;
  busy: string | null;
}) {
  const rows = props.deliveries;
  const ready = !props.fetchError && !(props.loading && rows.length === 0);
  const filtered = props.statusFilter !== "" || props.channelFilter !== "";

  return (
    <>
      <CocoaToolbar
        variant="content"
        aria-label="Filtros del registro de envíos"
        leftSlot={
          <>
            <CocoaSelect value={props.statusFilter} onChange={props.onStatusFilter} options={OUTCOME_FILTER_OPTIONS} inline aria-label="Filtrar por estado" />
            <CocoaSelect value={props.channelFilter} onChange={props.onChannelFilter} options={CHANNEL_FILTER_OPTIONS} inline aria-label="Filtrar por canal" />
          </>
        }
      />
      <CocoaSection title="Registro de envíos" meta={`${plural(rows.length, "envío", "envíos")} · 30 días`} padding={ready && rows.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
        {props.fetchError ? (
          <CocoaState kind="error" title="No se pudieron cargar los envíos" message={props.fetchError} onRetry={props.onRetryLoad} />
        ) : !props.loading && rows.length === 0 ? (
          <CocoaState
            kind="empty"
            illustration={filtered ? "search" : "box"}
            title={filtered ? STATUS_LABELS.noResults : "Todavía no hay envíos"}
            message={filtered ? "Prueba con otro estado o canal." : "Emite una factura o crea una reserva con el correo del titular y el motor encolará uno automáticamente."}
            primaryAction={
              filtered
                ? {
                    label: ACTIONS.clearFilters,
                    onClick: () => {
                      props.onStatusFilter("");
                      props.onChannelFilter("");
                    }
                  }
                : undefined
            }
          />
        ) : (
          <CocoaTable
            columns={DELIVERY_COLUMNS}
            rows={rows}
            rowKey="id"
            loading={props.loading && rows.length === 0}
            rowTone={(d) => (d.status === "failed" || d.status === "bounced" ? "danger" : undefined)}
            rowActionsVisible="always"
            rowActions={(d) =>
              d.status === "failed" || d.status === "bounced" ? (
                <CocoaButton variant="plain" size="small" tone="accent" disabled={props.busy === `retry-${d.id}`} loading={props.busy === `retry-${d.id}`} onClick={() => props.onRetry(d.id)}>
                  {ACTIONS.retry}
                </CocoaButton>
              ) : null
            }
            caption="Registro de envíos"
            aria-label="Registro de envíos"
          />
        )}
      </CocoaSection>
    </>
  );
}

// ---- Tab: Stats ----

const STAT_COLUMNS: CocoaTableColumn<TemplateStat>[] = [
  { key: "templateCode", label: "Plantilla", minWidth: 160, render: (s) => <strong>{s.templateCode}</strong> },
  { key: "channel", label: "Canal", fit: true, render: (s) => channelLabel(s.channel) },
  { key: "sent", label: "Enviadas", align: "right", fit: true, render: (s) => number(s.sent) },
  {
    key: "simulated",
    label: "Simuladas",
    align: "right",
    fit: true,
    hideOnNarrow: true,
    render: (s) =>
      (s.simulated ?? 0) > 0 ? (
        <CocoaBadge tone="warning" variant="tinted" size="small">
          {number(s.simulated ?? 0)}
        </CocoaBadge>
      ) : (
        number(s.simulated ?? 0)
      )
  },
  {
    key: "failed",
    label: "Fallidas",
    align: "right",
    fit: true,
    render: (s) =>
      s.failed > 0 ? (
        <CocoaBadge tone="danger" variant="tinted" size="small">
          {number(s.failed)}
        </CocoaBadge>
      ) : (
        number(s.failed)
      )
  },
  { key: "queued", label: "En cola", align: "right", fit: true, hideOnNarrow: true, render: (s) => number(s.queued) },
  { key: "total", label: "Total", align: "right", fit: true, render: (s) => <strong>{number(s.total)}</strong> },
  { key: "lastSentAt", label: "Último envío", fit: true, showFrom: "laptop", render: (s) => dateTime(s.lastSentAt) },
  { key: "lastFailedAt", label: "Último fallo", fit: true, showFrom: "desktop", render: (s) => dateTime(s.lastFailedAt) }
];

function StatsTab(props: { stats: TemplateStat[]; loading: boolean; fetchError: string | null; onRetry: () => void; days: number; onChangeDays: (n: number) => void }) {
  const rows = props.stats;
  const totalSent = rows.reduce((sum, s) => sum + s.sent, 0);
  const totalSimulated = rows.reduce((sum, s) => sum + (s.simulated ?? 0), 0);
  const totalFailed = rows.reduce((sum, s) => sum + s.failed, 0);
  const totalQueued = rows.reduce((sum, s) => sum + s.queued, 0);
  const failureRate = totalSent + totalFailed > 0 ? (totalFailed / (totalSent + totalFailed)) * 100 : 0;
  const ready = !props.fetchError && !(props.loading && rows.length === 0);

  return (
    <CocoaSection
      title="Rendimiento de las plantillas"
      meta={`últimos ${plural(props.days, "día", "días")}`}
      padding={ready && rows.length > 0 ? "none" : "md"}
      style={{ overflow: "clip" }}
      action={<CocoaSelect value={String(props.days)} onChange={(v) => props.onChangeDays(Number(v))} options={WINDOW_OPTIONS} size="small" inline aria-label="Ventana de días" />}
    >
      <div className="cocoa-stack" data-gap="4" style={{ padding: ready && rows.length > 0 ? "var(--cocoa-space-4) var(--cocoa-space-4) 0" : 0 }}>
        <CocoaKpiStrip aria-label={`Envíos de los últimos ${plural(props.days, "día", "días")}`}>
          <CocoaKpi
            label="Total enviadas"
            value={number(totalSent)}
            caption={totalSimulated > 0 ? simulatedCaption(totalSimulated) : undefined}
            polarity="neutral"
            status={totalSimulated > 0 ? "warning" : "ok"}
          />
          <CocoaKpi label="Total fallidas" value={number(totalFailed)} polarity="negative-good" status={totalFailed > 0 ? "warning" : "ok"} />
          <CocoaKpi label="Tasa de fallos" value={percent(failureRate, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} polarity="negative-good" status={failureRate > 5 ? "warning" : "ok"} />
          <CocoaKpi label="En cola / pendientes" value={number(totalQueued)} polarity="neutral" status="ok" />
        </CocoaKpiStrip>
      </div>
      {props.fetchError ? (
        <CocoaState kind="error" title="No se pudieron cargar las estadísticas" message={props.fetchError} onRetry={props.onRetry} />
      ) : !props.loading && rows.length === 0 ? (
        <CocoaState kind="empty" inline title="Sin envíos en este periodo." />
      ) : (
        <CocoaTable columns={STAT_COLUMNS} rows={rows} rowKey={(s) => `${s.templateCode}-${s.channel}`} loading={props.loading && rows.length === 0} caption="Rendimiento de las plantillas" aria-label="Rendimiento de las plantillas" />
      )}
    </CocoaSection>
  );
}
