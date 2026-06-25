// Webhooks admin — gestiona suscripciones, prueba en vivo y ve historial de entregas.
//
// Conecta el backend P0-1 (apps/api/src/modules/webhooks + apps/worker) con la
// interfaz. Es la primera pantalla operativa para developer/partners.

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
import { LoadingBlock, EmptyState, Spinner } from "../../components/States";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function statusBadge(status: string): "ok" | "warn" | "info" {
  if (status === "delivered") return "ok";
  if (status === "pending" || status === "retrying") return "warn";
  return "info";
}

export function WebhooksAdminScreen() {
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

  // Selected sub state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  // Confirm dialog state for delete action
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

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

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    if (!selectedId) { setDeliveries([]); return; }
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
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newUrl.trim() || newEvents.size === 0) return;
    setCreating(true);
    setError(null);
    try {
      const result = await createSubscription({
        targetUrl: newUrl.trim(),
        eventTypes: Array.from(newEvents)
      });
      setCreatedSecret(result.secret);
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
    setPendingDeleteId(null);
    try {
      await deleteSubscription(id);
      if (selectedId === id) setSelectedId(null);
      await refresh();
      showToast("Suscripción eliminada", { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo eliminar.";
      setError(message);
      showToast(message, { variant: "error" });
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
          ? `Entrega correcta · HTTP ${r.responseStatus}`
          : `Falló · ${r.errorMessage ?? `HTTP ${r.responseStatus}`}`
      );
      // Refresca historial para mostrar la entrega
      const fresh = await fetchDeliveries(selectedId);
      setDeliveries(fresh);
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : "Test fallido.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Plataforma · Webhooks
          </p>
          <h2 style={{ color: "var(--ink)" }}>Suscripciones a eventos</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Cada evento del PMS (reservas, folios, facturas, habitaciones) se entrega por HTTP POST a la URL del partner.
            Las entregas se firman con <code>HMAC-SHA256</code> sobre el body usando el <strong>secret</strong> que aparece
            <strong> solo una vez</strong> al crear la suscripción. Reintentos exponenciales (30s → 6h, 6 intentos).
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading}>↻ Actualizar</button>
      </header>

      {error ? <p className="bo-status warn" style={{ textTransform: "none" }}>{error}</p> : null}

      {createdSecret ? (
        <article className="bo-card" style={{ background: "var(--accent-soft, rgba(78,224,163,0.10))", border: "1px solid var(--accent)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Secret generado</h3>
            <button type="button" onClick={() => setCreatedSecret(null)}>Cerrar</button>
          </div>
          <p className="bo-muted" style={{ textTransform: "none" }}>
            Cópialo ahora — no se mostrará de nuevo. El partner lo necesita para verificar la firma <code>X-Anfitorio-Signature</code>.
          </p>
          <pre className="mono" style={{ background: "var(--surface-2)", padding: 10, borderRadius: 6, overflowX: "auto", margin: "8px 0 0" }}>
            {createdSecret}
          </pre>
        </article>
      ) : null}

      {/* Create form */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Nueva suscripción</h3></div>
        <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label className="bo-muted" style={{ textTransform: "none" }}>URL de destino</label>
          <input
            type="url"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="https://partner.example.com/hotelos/webhook"
            required
            style={{ padding: "8px 12px" }}
          />
          <label className="bo-muted" style={{ textTransform: "none" }}>
            Eventos a recibir ({newEvents.size}/{eventTypes.length})
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 4 }}>
            {eventTypes.map((t) => (
              <label key={t} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={newEvents.has(t)} onChange={() => toggleEvent(t)} />
                <span className="mono" style={{ fontSize: 12 }}>{t}</span>
              </label>
            ))}
          </div>
          <div className="bo-row" style={{ gap: 8 }}>
            <button type="submit" className="primary" disabled={creating || !newUrl.trim() || newEvents.size === 0}>
              {creating ? <Spinner size="sm" /> : "+ Crear suscripción"}
            </button>
            <button type="button" onClick={() => setNewEvents(new Set(eventTypes))} disabled={creating}>
              Seleccionar todos
            </button>
            <button type="button" onClick={() => setNewEvents(new Set())} disabled={creating}>
              Limpiar
            </button>
          </div>
        </form>
      </article>

      {/* List */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Suscripciones activas</h3>
          <span className="bo-chip">{subs.length}</span>
        </div>
        {loading && subs.length === 0 ? <LoadingBlock label="Cargando…" /> : subs.length === 0 ? (
          <EmptyState title="Sin suscripciones" message="Crea la primera arriba." />
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr><th>URL</th><th>Eventos</th><th>Estado</th><th>Secret</th><th>Creada</th><th></th></tr>
              </thead>
              <tbody>
                {subs.map((s) => (
                  <tr key={s.id} style={{ background: selectedId === s.id ? "var(--accent-soft, rgba(78,224,163,0.08))" : undefined, cursor: "pointer" }} onClick={() => setSelectedId(s.id)}>
                    <td className="mono" style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }}>{s.targetUrl}</td>
                    <td>{s.eventTypes.length}</td>
                    <td><span className={`bo-status ${s.active ? "ok" : "info"}`} style={{ fontSize: 10 }}>{s.active ? "activa" : "pausada"}</span></td>
                    <td className="mono" style={{ fontSize: 11 }}>{s.secretMasked ?? "—"}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{fmtTime(s.createdAt)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button type="button" onClick={() => void handleToggle(s)}>{s.active ? "Pausar" : "Activar"}</button>
                      {" "}
                      <button type="button" onClick={() => setPendingDeleteId(s.id)}>Eliminar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>

      {/* Deliveries for selected */}
      {selected ? (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Entregas · {selected.targetUrl.slice(0, 60)}{selected.targetUrl.length > 60 ? "…" : ""}</h3>
            <div className="bo-row" style={{ gap: 8 }}>
              <button type="button" onClick={handleTest} disabled={testing} className="primary">
                {testing ? <Spinner size="sm" /> : "Enviar evento de prueba"}
              </button>
              <button type="button" onClick={() => setSelectedId(null)}>Cerrar</button>
            </div>
          </div>
          {testResult ? <p className="bo-status info" style={{ textTransform: "none" }}>{testResult}</p> : null}
          {deliveriesLoading ? <LoadingBlock label="Cargando entregas…" /> : deliveries.length === 0 ? (
            <EmptyState title="Sin entregas" message="No hay entregas registradas todavía. Pulsa «Enviar evento de prueba» para validar la URL." />
          ) : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr><th>Cuándo</th><th>Evento</th><th>Estado</th><th>HTTP</th><th>Error</th></tr>
                </thead>
                <tbody>
                  {deliveries.map((d) => (
                    <tr key={d.id}>
                      <td className="mono" style={{ fontSize: 11 }}>{fmtTime(d.attemptedAt)}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{d.eventType}</td>
                      <td><span className={`bo-status ${statusBadge(d.status)}`} style={{ fontSize: 10 }}>{d.status}</span></td>
                      <td className="mono">{d.responseStatus ?? "—"}</td>
                      <td style={{ fontSize: 11, color: "var(--ink-muted)" }}>{d.errorMessage ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
      ) : null}

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title="¿Eliminar esta suscripción?"
        description="Las entregas pendientes se cancelan."
        confirmLabel="Eliminar"
        variant="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDeleteId(null)}
      />
    </section>
  );
}
