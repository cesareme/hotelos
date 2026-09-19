// Webhooks admin — Configuración › Sistema › Webhooks (/configuracion/sistema/webhooks).
//
// Subscriptions, live test and delivery history over the real backend
// (apps/api/src/modules/webhooks + apps/worker webhook-delivery job):
// HMAC-SHA256 signature in `X-HotelOS-Signature` («sha256=<hex>»), the
// secret shown ONCE on creation, retries by the worker (6 attempts: 30 s →
// 6 h). Honest limit: today only «Enviar evento de prueba» creates
// deliveries — the PMS does not publish its domain events to the
// subscriptions yet — and the screen says so.
//
// Cocoa 22 (lote 10-A · lista / tabla): CocoaPage → CocoaFormSection «Nueva
// suscripción» (URL + event chips with aria-pressed) → CocoaSection
// padding="none" with the subscriptions CocoaTable (row actions always
// visible; a row selects it) → CocoaSection «Entregas» of the selected
// subscription → CocoaDialog destructive for the deletion.

import { useEffect, useMemo, useState } from "react";
import {
  fetchEventTypes,
  listSubscriptions,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  fetchDeliveries,
  testSubscription,
  type WebhookSubscription,
  type WebhookDelivery
} from "../../services/webhooksApi";
import { copyText } from "../../services/authApi";
import { getActivePropertyId } from "../../services/activeProperty";
import { useToast } from "../../components/Toast";
import { dateTime, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaField,
  CocoaFormSection,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

function fmtTime(iso: string): string {
  return dateTime(iso, { style: "dayMonth" });
}

/** Delivery status of the worker → tone and Spanish label (unknown values pass through). */
function deliveryStatus(status: string): { tone: CocoaTone; label: string } {
  switch (status) {
    case "delivered":
      return { tone: "success", label: "Entregada" };
    case "pending":
      return { tone: "warning", label: STATUS_LABELS.pending };
    case "retrying":
      return { tone: "warning", label: "Reintentando" };
    case "failed":
    case "permanent_failure":
      return { tone: "danger", label: status === "failed" ? "Fallida" : "Fallo definitivo" };
    default:
      return { tone: "info", label: status };
  }
}

/** A long target URL for a section title («Entregas · https://…»). */
function shortUrl(url: string): string {
  return url.length > 60 ? `${url.slice(0, 60)}…` : url;
}

const DELIVERY_COLUMNS: CocoaTableColumn<WebhookDelivery>[] = [
  { key: "attemptedAt", label: "Cuándo", fit: true, render: (d) => fmtTime(d.attemptedAt) },
  { key: "eventType", label: "Evento", render: (d) => <code className="cocoa-mono">{d.eventType}</code> },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (d) => {
      const s = deliveryStatus(d.status);
      return (
        <CocoaBadge tone={s.tone} uppercase={false}>
          {s.label}
        </CocoaBadge>
      );
    }
  },
  { key: "responseStatus", label: "HTTP", align: "right", fit: true, render: (d) => d.responseStatus ?? "—" },
  { key: "errorMessage", label: "Error", hideOnNarrow: true, render: (d) => d.errorMessage ?? "—" }
];

export function WebhooksAdminScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [subs, setSubs] = useState<WebhookSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create-form state
  const [newUrl, setNewUrl] = useState("");
  const [newEvents, setNewEvents] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  // Selected sub state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Confirm dialog state for the delete action
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [types, list] = await Promise.all([fetchEventTypes(), listSubscriptions()]);
      setEventTypes(types);
      setSubs(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDeliveries([]);
      return;
    }
    setDeliveriesLoading(true);
    fetchDeliveries(selectedId)
      .then(setDeliveries)
      .catch(() => setDeliveries([]))
      .finally(() => setDeliveriesLoading(false));
  }, [selectedId]);

  const selected = useMemo(() => subs.find((s) => s.id === selectedId) ?? null, [subs, selectedId]);

  function toggleEvent(t: string) {
    setNewEvents((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  const canCreate = !creating && newUrl.trim() !== "" && newEvents.size > 0;

  async function handleCreate() {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      // FIX-1 (F7): the subscription hangs from the active property so the
      // tenant guard resolves it (Pausar / Eliminar / entregas / prueba).
      const result = await createSubscription({
        targetUrl: newUrl.trim(),
        eventTypes: Array.from(newEvents),
        propertyId: getActivePropertyId()
      });
      setCreatedSecret(result.secret);
      setSecretCopied(false);
      setNewUrl("");
      setNewEvents(new Set());
      await refresh();
      setSelectedId(result.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo crear la suscripción.");
    } finally {
      setCreating(false);
    }
  }

  async function copySecret() {
    if (!createdSecret) return;
    if (await copyText(createdSecret)) {
      setSecretCopied(true);
      window.setTimeout(() => setSecretCopied(false), 1600);
    }
  }

  async function handleToggle(sub: WebhookSubscription) {
    try {
      await updateSubscription(sub.id, { active: !sub.active });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo actualizar.");
    }
  }

  async function confirmDelete() {
    const id = pendingDeleteId;
    if (!id) return;
    setDeleting(true);
    try {
      await deleteSubscription(id);
      if (selectedId === id) setSelectedId(null);
      setPendingDeleteId(null);
      await refresh();
      showToast("Suscripción eliminada", { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo eliminar.";
      setError(message);
      showToast(message, { variant: "error" });
      setPendingDeleteId(null);
    } finally {
      setDeleting(false);
    }
  }

  async function handleTest() {
    if (!selectedId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testSubscription(selectedId);
      setTestResult(
        r.delivered
          ? { ok: true, message: `Entrega correcta · HTTP ${r.responseStatus ?? "—"}` }
          : { ok: false, message: `Falló · ${r.errorMessage ?? `HTTP ${r.responseStatus ?? "—"}`}` }
      );
      // Reload the history so the test delivery shows up.
      const fresh = await fetchDeliveries(selectedId);
      setDeliveries(fresh);
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : "La prueba falló." });
    } finally {
      setTesting(false);
    }
  }

  // Columns close over the busy flags and the row handlers.
  const subscriptionColumns: CocoaTableColumn<WebhookSubscription>[] = [
    { key: "targetUrl", label: "URL", minWidth: 240, render: (s) => <code className="cocoa-mono cocoa-truncate">{s.targetUrl}</code> },
    { key: "eventTypes", label: "Eventos", align: "right", fit: true, render: (s) => s.eventTypes.length },
    {
      key: "active",
      label: "Estado",
      fit: true,
      render: (s) => (
        <CocoaBadge tone={s.active ? "success" : "neutral"} uppercase={false}>
          {s.active ? "Activa" : "Pausada"}
        </CocoaBadge>
      )
    },
    { key: "secretMasked", label: "Secret", fit: true, showFrom: "laptop", render: (s) => <code className="cocoa-mono">{s.secretMasked ?? "—"}</code> },
    { key: "createdAt", label: "Creada", fit: true, hideOnNarrow: true, render: (s) => fmtTime(s.createdAt) }
  ];

  const ready = !loading && subs.length > 0;

  let listBody;
  if (loading && subs.length === 0) {
    listBody = <CocoaTable columns={subscriptionColumns} rows={[]} loading aria-label="Suscripciones" />;
  } else if (subs.length === 0) {
    listBody = <CocoaState kind="empty" title="Sin suscripciones" message="Crea la primera con el formulario de arriba: URL de destino y los eventos que quieres recibir." />;
  } else {
    listBody = (
      <CocoaTable
        columns={subscriptionColumns}
        rows={subs}
        rowKey="id"
        selectedKey={selectedId ?? undefined}
        onSelect={(s) => setSelectedId(s.id)}
        rowActionsVisible="always"
        rowActions={(s) => (
          <>
            <CocoaButton
              variant="plain"
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                void handleToggle(s);
              }}
            >
              {s.active ? "Pausar" : ACTIONS.activate}
            </CocoaButton>
            <CocoaButton
              variant="plain"
              tone="destructive"
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                setPendingDeleteId(s.id);
              }}
            >
              {ACTIONS.delete}
            </CocoaButton>
          </>
        )}
        caption="Suscripciones a eventos"
        aria-label="Suscripciones a eventos"
      />
    );
  }

  return (
    <CocoaPage
      eyebrow="Configuración · Sistema"
      title="Webhooks"
      subtitle={hosted ? undefined : "Suscripciones a eventos entregadas por HTTP POST a la URL del partner, firmadas con HMAC-SHA256."}
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void refresh()} disabled={loading}>
          {ACTIONS.refresh}
        </CocoaButton>
      }
      commands={[{ id: "webhooks-refresh", label: `${ACTIONS.refresh} webhooks`, run: () => void refresh() }]}
    >
      <CocoaCallout tone="info" title="Cómo se entregan">
        Cada entrega es un HTTP POST firmado con HMAC-SHA256 sobre el cuerpo, en la cabecera <code className="cocoa-mono">X-HotelOS-Signature</code> (nombre técnico heredado del protocolo, no cambia con la marca; formato <code className="cocoa-mono">sha256=…</code>), usando el secret
        que se muestra una sola vez al crear la suscripción. Si la URL no responde 2xx, el sistema reintenta hasta 6 veces (30 s → 6 h). Hoy solo «Enviar evento de prueba» genera entregas: los eventos del PMS
        (reservas, folios, facturas, habitaciones) todavía no se publican automáticamente en las suscripciones.
      </CocoaCallout>

      {error ? (
        <CocoaCallout tone="danger" title={STATUS_LABELS.loadError} role="alert">
          {error}
        </CocoaCallout>
      ) : null}

      {createdSecret ? (
        <CocoaCallout
          tone="success"
          title="Secret generado"
          role="status"
          actions={
            <>
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void copySecret()}>
                {secretCopied ? "Copiado" : ACTIONS.copy}
              </CocoaButton>
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setCreatedSecret(null)}>
                {ACTIONS.close}
              </CocoaButton>
            </>
          }
        >
          Cópialo ahora: no se mostrará de nuevo. El partner lo necesita para verificar la firma. <code className="cocoa-mono">{createdSecret}</code>
        </CocoaCallout>
      ) : null}

      <CocoaFormSection
        title="Nueva suscripción"
        description="URL de destino y eventos que recibirá. El secret de firma se genera al crearla."
        columns={1}
        actions={
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void handleCreate()} disabled={!canCreate} loading={creating}>
            Crear suscripción
          </CocoaButton>
        }
      >
        <CocoaField label="URL de destino" required help="Debe aceptar HTTP POST con el cuerpo JSON del evento.">
          <CocoaInput value={newUrl} onChange={setNewUrl} type="url" inputMode="url" placeholder="https://partner.example.com/ehotelos/webhook" disabled={creating} autoComplete="off" />
        </CocoaField>
        <div className="cocoa-stack" data-gap="2" role="group" aria-label="Eventos a recibir">
          <div className="cocoa-row" data-gap="2" data-justify="between">
            <span className="cocoa-caption">
              Eventos a recibir · {newEvents.size} de {eventTypes.length}
            </span>
            <span className="cocoa-cluster">
              <CocoaButton variant="plain" size="small" onClick={() => setNewEvents(new Set(eventTypes))} disabled={creating || eventTypes.length === 0}>
                {ACTIONS.selectAll}
              </CocoaButton>
              <CocoaButton variant="plain" size="small" onClick={() => setNewEvents(new Set())} disabled={creating || newEvents.size === 0}>
                {ACTIONS.clearSelection}
              </CocoaButton>
            </span>
          </div>
          {eventTypes.length === 0 ? (
            <CocoaState kind="empty" inline title={loading ? STATUS_LABELS.loading : "El API no expone tipos de evento."} />
          ) : (
            <div className="cocoa-cluster">
              {eventTypes.map((t) => {
                const active = newEvents.has(t);
                return (
                  <CocoaButton key={t} size="small" variant={active ? "tinted" : "bordered"} tone={active ? "accent" : "neutral"} aria-pressed={active} disabled={creating} onClick={() => toggleEvent(t)}>
                    {t}
                  </CocoaButton>
                );
              })}
            </div>
          )}
        </div>
      </CocoaFormSection>

      <CocoaSection padding={ready ? "none" : "md"} style={{ overflow: "clip" }} aria-label="Suscripciones a eventos" footer={ready ? <span>{plural(subs.length, "suscripción", "suscripciones")}</span> : undefined}>
        {listBody}
      </CocoaSection>

      {selected ? (
        <CocoaSection
          title="Entregas"
          meta={shortUrl(selected.targetUrl)}
          padding={deliveries.length > 0 ? "none" : "md"}
          style={{ overflow: "clip" }}
          action={
            <span className="cocoa-cluster">
              <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void handleTest()} loading={testing} disabled={testing}>
                Enviar evento de prueba
              </CocoaButton>
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setSelectedId(null)}>
                {ACTIONS.close}
              </CocoaButton>
            </span>
          }
          footer={testResult ? <span role="status">{testResult.message}</span> : undefined}
        >
          {deliveriesLoading ? (
            <CocoaTable columns={DELIVERY_COLUMNS} rows={[]} loading aria-label="Entregas" />
          ) : deliveries.length === 0 ? (
            <CocoaState kind="empty" inline title="No hay entregas registradas todavía. Pulsa «Enviar evento de prueba» para validar la URL." />
          ) : (
            <CocoaTable columns={DELIVERY_COLUMNS} rows={deliveries} rowKey="id" caption="Entregas de la suscripción" aria-label="Entregas de la suscripción" />
          )}
        </CocoaSection>
      ) : null}

      <CocoaDialog
        open={pendingDeleteId !== null}
        onClose={() => (deleting ? undefined : setPendingDeleteId(null))}
        tone="destructive"
        title="¿Eliminar esta suscripción?"
        description="Las entregas pendientes se cancelan y el partner dejará de recibir eventos en esa URL."
        confirmLabel={ACTIONS.delete}
        cancelLabel={ACTIONS.cancel}
        busy={deleting}
        onConfirm={confirmDelete}
      />
    </CocoaPage>
  );
}
