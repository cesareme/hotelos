import { useState } from "react";
import { useApiData } from "../hooks/useApiData";
import { apiRequest } from "../services/api-client";

export type AuthorityKind = "verifactu" | "tbai" | "igic" | "ses";

type DetailRow = {
  id?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  territory?: string;
  status: string;
  endpoint?: string;
  attempts?: number;
  csvCode?: string;
  tbaiCode?: string;
  tbaiHash?: string;
  previousTbaiHash?: string;
  acceptedHash?: string;
  acknowledgementCode?: string;
  trackingNumber?: string;
  externalReference?: string;
  submissionType?: string;
  errorCode?: string;
  errorMessage?: string;
  xmlPayload?: string;
  responseAck?: string;
  signatureMode?: string;
  signedAt?: string;
  submittedAt?: string;
  acknowledgedAt?: string;
  nextRetryAt?: string;
  createdAt?: string;
};

const AUTHORITY_META: Record<AuthorityKind, { label: string; authority: string; endpointBase: string }> = {
  verifactu: { label: "VeriFactu", authority: "AEAT", endpointBase: "/verifactu/submissions" },
  tbai: { label: "TicketBAI", authority: "Hacienda Foral", endpointBase: "/tbai/submissions" },
  igic: { label: "IGIC", authority: "ATC · Canarias", endpointBase: "/igic/submissions" },
  ses: { label: "SES.HOSPEDAJES", authority: "MIR · Interior", endpointBase: "/ses/submissions" }
};

function statusToClass(status: string): string {
  if (status === "accepted" || status === "accepted_with_warnings") return "ok";
  if (status === "rejected") return "error";
  if (status === "retrying" || status === "queued" || status === "submitting" || status === "pending" || status === "network_error") return "warn";
  return "info";
}

export function SubmissionDetailPanel(props: {
  open: boolean;
  authority: AuthorityKind;
  submissionId: string | null;
  onClose: () => void;
  onRetried?: () => void;
}) {
  const [tab, setTab] = useState<"summary" | "xml" | "response">("summary");
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const meta = AUTHORITY_META[props.authority];
  const path = props.open && props.submissionId ? `${meta.endpointBase}/${props.submissionId}` : null;
  const polling = props.open;

  const { data, loading, error, refresh } = useApiData<DetailRow>(path, {
    pollIntervalMs: polling ? 8000 : undefined,
    pollWhile: (d) => {
      const status = (d as DetailRow | null)?.status;
      return status === "retrying" || status === "submitting" || status === "queued" || status === "pending" || status === "network_error";
    }
  });

  async function handleRetry() {
    if (!props.submissionId) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await apiRequest(`${meta.endpointBase}/${props.submissionId}/retry`, { method: "POST" });
      setTimeout(() => refresh(), 600);
      props.onRetried?.();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }

  if (!props.open) return null;

  const sub = data;
  const identifier =
    sub?.csvCode ?? sub?.tbaiCode ?? sub?.acknowledgementCode ?? sub?.acceptedHash;
  const canRetry = sub?.status === "rejected" || sub?.status === "retrying" || sub?.status === "network_error";

  return (
    <div className="bo-cmdk-overlay" onClick={props.onClose} role="dialog" aria-modal="true">
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          right: 0,
          top: 0,
          height: "100vh",
          width: "min(680px, 92vw)",
          background: "var(--surface)",
          borderLeft: "1px solid var(--line)",
          boxShadow: "var(--shadow-xl)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden"
        }}
      >
        <header style={{ padding: "20px 24px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="bo-page-eyebrow" style={{ marginBottom: 4 }}>{meta.authority} · {meta.label}</div>
            <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {sub?.invoiceNumber ?? sub?.externalReference ?? "Detalle de envío"}
            </h2>
            {sub ? (
              <div className="bo-pill-row" style={{ marginTop: 8 }}>
                <span className={`bo-status ${statusToClass(sub.status)}`}>{sub.status}</span>
                {sub.submissionType ? <span className="bo-chip">{sub.submissionType}</span> : null}
                {sub.territory ? <span className="bo-chip">{sub.territory}</span> : null}
                {sub.signatureMode ? <span className="bo-chip">XAdES {sub.signatureMode}</span> : null}
                <span className="bo-chip">{sub.attempts ?? 0} {sub.attempts === 1 ? "intento" : "intentos"}</span>
              </div>
            ) : null}
          </div>
          <button type="button" className="bo-icon-button" onClick={props.onClose} aria-label="Cerrar detalle" title="Cerrar (Esc)">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
              <path d="M4 4L14 14M14 4L4 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="bo-row" style={{ gap: 0, borderBottom: "1px solid var(--line)", padding: "0 24px" }}>
          {(["summary", "xml", "response"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              style={{
                border: "none",
                borderRadius: 0,
                borderBottom: t === tab ? "2px solid var(--accent)" : "2px solid transparent",
                background: "transparent",
                padding: "10px 16px",
                cursor: "pointer",
                color: t === tab ? "var(--ink)" : "var(--ink-muted)",
                fontWeight: t === tab ? 700 : 500,
                fontSize: 13
              }}
            >
              {t === "summary" ? "Resumen" : t === "xml" ? "XML canónico" : "Respuesta de la autoridad"}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
          {loading && !sub ? (
            <p role="status" aria-live="polite" style={{ color: "var(--ink-muted)", textAlign: "center", padding: 32 }}>Cargando…</p>
          ) : error ? (
            <div className="bo-card" role="alert" style={{ borderLeft: "3px solid var(--danger-ink)" }}>
              <h3>Error</h3>
              <p>{error}</p>
            </div>
          ) : !sub ? (
            <p style={{ color: "var(--ink-muted)", textAlign: "center", padding: 32 }}>Envío no encontrado.</p>
          ) : tab === "summary" ? (
            <div className="bo-stack">
              <article className="bo-card" style={{ padding: 16 }}>
                <h3 style={{ fontSize: 14, marginBottom: 12 }}>Identificadores</h3>
                <div className="bo-stack">
                  <KvRow label="ID de envío" value={sub.id} mono />
                  <KvRow label="Factura / Referencia" value={sub.invoiceNumber ?? sub.externalReference} mono />
                  <KvRow label="ID de factura" value={sub.invoiceId} mono />
                  {identifier ? <KvRow label="Código de la autoridad" value={identifier} mono /> : null}
                  {sub.trackingNumber ? <KvRow label="Nº de seguimiento" value={sub.trackingNumber} mono /> : null}
                </div>
              </article>

              <article className="bo-card" style={{ padding: 16 }}>
                <h3 style={{ fontSize: 14, marginBottom: 12 }}>Ciclo de vida</h3>
                <div className="bo-stack">
                  <KvRow label="Creado" value={sub.createdAt ? new Date(sub.createdAt).toLocaleString() : "—"} />
                  <KvRow label="Firmado" value={sub.signedAt ? new Date(sub.signedAt).toLocaleString() : "—"} />
                  <KvRow label="Enviado" value={sub.submittedAt ? new Date(sub.submittedAt).toLocaleString() : "—"} />
                  <KvRow label="Confirmado" value={sub.acknowledgedAt ? new Date(sub.acknowledgedAt).toLocaleString() : "—"} />
                  {sub.nextRetryAt ? <KvRow label="Siguiente reintento" value={new Date(sub.nextRetryAt).toLocaleString()} /> : null}
                </div>
              </article>

              <article className="bo-card" style={{ padding: 16 }}>
                <h3 style={{ fontSize: 14, marginBottom: 12 }}>Transporte</h3>
                <div className="bo-stack">
                  <KvRow label="Endpoint" value={sub.endpoint} mono />
                  <KvRow label="Modo de firma" value={sub.signatureMode ?? "—"} />
                  {sub.tbaiHash ? <KvRow label="Hash TBAI" value={sub.tbaiHash} mono compact /> : null}
                  {sub.previousTbaiHash ? <KvRow label="Hash TBAI anterior" value={sub.previousTbaiHash} mono compact /> : null}
                  {sub.acceptedHash ? <KvRow label="Hash aceptado" value={sub.acceptedHash} mono compact /> : null}
                </div>
              </article>

              {sub.errorCode || sub.errorMessage ? (
                <article className="bo-card" role="alert" style={{ padding: 16, borderLeft: "3px solid var(--danger-ink)" }}>
                  <h3 style={{ fontSize: 14, marginBottom: 12 }}>Error de la autoridad</h3>
                  {sub.errorCode ? <div><span className="cm-pill cm-pill-error">{sub.errorCode}</span></div> : null}
                  {sub.errorMessage ? <p style={{ marginTop: 8 }}>{sub.errorMessage}</p> : null}
                </article>
              ) : null}
            </div>
          ) : tab === "xml" ? (
            <pre style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              lineHeight: 1.55,
              padding: 16,
              background: "var(--surface-sunken)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-md)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "var(--ink)"
            }}>
              {sub.xmlPayload ?? "(sin payload XML)"}
            </pre>
          ) : (
            <pre style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              lineHeight: 1.55,
              padding: 16,
              background: "var(--surface-sunken)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-md)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "var(--ink)"
            }}>
              {sub.responseAck ?? "(sin respuesta aún)"}
            </pre>
          )}
        </div>

        <footer style={{ padding: 16, borderTop: "1px solid var(--line)", display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>
            {polling && sub && ["retrying", "submitting", "queued", "network_error"].includes(sub.status)
              ? "🔁 Auto-actualización cada 8s mientras esté pendiente."
              : "Actualización manual."}
          </div>
          <div className="bo-row" style={{ gap: 8 }}>
            <button type="button" onClick={refresh} aria-label="Actualizar detalle">↻ Actualizar</button>
            {canRetry ? (
              <button type="button" className="primary" disabled={retrying} onClick={handleRetry}>
                {retrying ? "Reintentando…" : "Reintentar envío"}
              </button>
            ) : null}
          </div>
        </footer>
        {retryError ? (
          <div style={{ padding: "8px 16px", background: "var(--danger-bg)", color: "var(--danger-ink)", fontSize: 12 }}>{retryError}</div>
        ) : null}
      </aside>
    </div>
  );
}

function KvRow(props: { label: string; value?: string | null; mono?: boolean; compact?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 12, alignItems: "baseline" }}>
      <div style={{ fontSize: 11, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>{props.label}</div>
      <div
        style={{
          fontFamily: props.mono ? "var(--font-mono)" : undefined,
          fontSize: props.mono ? 12 : 13,
          color: "var(--ink)",
          wordBreak: props.compact ? "break-all" : "normal"
        }}
      >
        {props.value || "—"}
      </div>
    </div>
  );
}
