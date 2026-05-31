import { useCallback, useEffect, useState } from "react";
import {
  fetchEmailProviders,
  fetchEmailConnections,
  createEmailConnection,
  disconnectEmailConnection,
  getEmailAuthorizeUrl,
  pollEmailConnection,
  ingestManualEmail,
  fetchInboundEmails,
  approveInboundEmail,
  rejectInboundEmail,
  type EmailProviders,
  type EmailConnection,
  type InboundEmail
} from "../../services/emailApi";
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";

const PROVIDER_LABEL: Record<string, string> = { gmail: "Gmail", microsoft: "Microsoft 365", imap: "IMAP", manual: "Manual / demo" };
const STATUS_LABEL: Record<string, string> = { connected: "conectado", pending_auth: "pendiente de autorizar", disconnected: "desconectado", error: "error" };
const INBOUND_STATUS: Record<string, { label: string; cls: string }> = {
  received: { label: "recibido", cls: "info" },
  review: { label: "en revisión", cls: "warn" },
  ignored: { label: "ignorado", cls: "info" },
  reservation_created: { label: "reserva creada", cls: "ok" },
  error: { label: "error", cls: "error" }
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-ES");
}

export function EmailConnectorsScreen() {
  const [providers, setProviders] = useState<EmailProviders>({});
  const [connections, setConnections] = useState<EmailConnection[]>([]);
  const [inbound, setInbound] = useState<InboundEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // add-connection form
  const [provider, setProvider] = useState("gmail");
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // manual ingest
  const [mFrom, setMFrom] = useState("");
  const [mSubject, setMSubject] = useState("");
  const [mBody, setMBody] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, c, i] = await Promise.all([fetchEmailProviders(), fetchEmailConnections(), fetchInboundEmails()]);
      setProviders(p);
      setConnections(c);
      setInbound(i);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el módulo de correo.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run<T>(fn: () => Promise<T>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

  async function addConnection() {
    const payload: Record<string, unknown> = { provider };
    if (provider === "imap") Object.assign(payload, { host, username, password, port: 993 });
    await run(async () => {
      const conn = await createEmailConnection(payload);
      setHost(""); setUsername(""); setPassword("");
      if ((conn.needsOAuth) && conn.authorizeAvailable) {
        const { url } = await getEmailAuthorizeUrl(conn.id);
        window.open(url, "_blank", "noopener,noreferrer");
      }
    }, "Conexión creada.");
  }

  async function authorize(id: string) {
    setBusy(true); setMsg(null);
    try {
      const { url } = await getEmailAuthorizeUrl(id);
      window.open(url, "_blank", "noopener,noreferrer");
      setMsg("Abre la pestaña de autorización y vuelve; luego pulsa Actualizar.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "OAuth no disponible.");
    } finally {
      setBusy(false);
    }
  }

  const reviewItems = inbound.filter((i) => i.status === "review");

  return (
    <section className="bo-card" style={{ display: "grid", gap: 16 }}>
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Operaciones de IA</p>
          <h2>Correo → reservas (IA)</h2>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>↻ Actualizar</button>
      </div>
      <p>
        Conecta buzones (Gmail, Microsoft 365, IMAP) para que la IA lea los correos entrantes y extraiga reservas.
        Cada borrador pasa <strong>siempre por revisión humana</strong> antes de crear la reserva. El conector
        manual/demo te deja pegar un email y recorrer el mismo flujo sin OAuth.
      </p>
      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      {loading ? (
        <LoadingBlock label="Cargando conectores de correo…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar" message={error} onRetry={() => void load()} />
      ) : (
        <>
          <div className="bo-pill-row">
            {Object.entries(providers).map(([k, v]) => (
              <span key={k} className={`bo-status ${v.configured ? "ok" : "info"}`} style={{ textTransform: "none" }} title={v.note ?? ""}>
                {PROVIDER_LABEL[k] ?? k}: {v.configured ? "configurado" : "no configurado"}
              </span>
            ))}
          </div>

          <div className="bo-grid two">
            <article className="bo-card">
              <div className="bo-card-head"><h3>Buzones conectados</h3><span className="bo-chip">{connections.length}</span></div>
              {connections.length === 0 ? (
                <p className="bo-muted">Aún no hay buzones. Añade uno abajo.</p>
              ) : (
                <div className="bo-stack" style={{ gap: 8 }}>
                  {connections.map((c) => (
                    <div key={c.id} style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, borderBottom: "1px solid var(--line-soft)", paddingBottom: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <strong>{PROVIDER_LABEL[c.provider] ?? c.provider}</strong>{" "}
                        <span className={`bo-status ${c.status === "connected" ? "ok" : c.status === "error" ? "error" : "warn"}`} style={{ textTransform: "none" }}>{STATUS_LABEL[c.status] ?? c.status}</span>
                        <div className="bo-muted" style={{ fontSize: 12, textTransform: "none" }}>{c.emailAddress ?? "—"} · últ. sync {fmt(c.lastSyncAt)}</div>
                        {c.lastError ? <div className="bo-status error" style={{ textTransform: "none", fontSize: 12 }}>{c.lastError}</div> : null}
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" }}>
                        {c.status === "pending_auth" ? <button type="button" className="primary" disabled={busy} onClick={() => void authorize(c.id)}>Autorizar</button> : null}
                        {c.status === "connected" && c.provider !== "manual" ? <button type="button" disabled={busy} onClick={() => run(() => pollEmailConnection(c.id), "Sondeo lanzado.")}>Sondear</button> : null}
                        <button type="button" disabled={busy} style={{ borderColor: "#c2413a", color: "#c2413a" }} onClick={() => run(() => disconnectEmailConnection(c.id), "Desconectado.")}>Desconectar</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="bo-row" style={{ gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
                <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="gmail">Gmail</option>
                  <option value="microsoft">Microsoft 365</option>
                  <option value="imap">IMAP</option>
                  <option value="manual">Manual / demo</option>
                </select>
                {provider === "imap" ? (
                  <>
                    <input placeholder="host (imap.dominio.com)" value={host} onChange={(e) => setHost(e.target.value)} style={{ width: 180 }} />
                    <input placeholder="usuario" value={username} onChange={(e) => setUsername(e.target.value)} style={{ width: 140 }} />
                    <input placeholder="contraseña de app" type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: 150 }} />
                  </>
                ) : null}
                <button type="button" className="primary" disabled={busy} onClick={() => void addConnection()}>Añadir buzón</button>
              </div>
            </article>

            <article className="bo-card">
              <div className="bo-card-head"><h3>Probar con un email (demo)</h3></div>
              <p className="bo-muted" style={{ textTransform: "none" }}>Pega el texto de un email de reserva; la IA lo extrae y lo envía a revisión.</p>
              <div className="bo-stack" style={{ gap: 8 }}>
                <input placeholder="De (remitente)" value={mFrom} onChange={(e) => setMFrom(e.target.value)} />
                <input placeholder="Asunto" value={mSubject} onChange={(e) => setMSubject(e.target.value)} />
                <textarea placeholder="Cuerpo del email…" rows={6} value={mBody} onChange={(e) => setMBody(e.target.value)} />
                <button type="button" className="primary" disabled={busy || !mBody.trim()} onClick={() => run(async () => { await ingestManualEmail({ from: mFrom, subject: mSubject, body: mBody }); setMBody(""); setMSubject(""); setMFrom(""); }, "Email procesado.")}>
                  {busy ? <><Spinner size="sm" /> Procesando…</> : "Procesar email"}
                </button>
              </div>
            </article>
          </div>

          <article className="bo-card">
            <div className="bo-card-head">
              <h3>Bandeja de reservas por correo</h3>
              <span className="bo-chip">{reviewItems.length} en revisión · {inbound.length} total</span>
            </div>
            {inbound.length === 0 ? (
              <EmptyState title="Sin correos procesados" message="Conecta un buzón y sondéalo, o prueba con el conector demo." />
            ) : (
              <div className="rev-report-wrap">
                <table className="cm-table">
                  <thead><tr><th>Remitente</th><th>Asunto</th><th>Origen</th><th>Conf.</th><th>Borrador</th><th>Estado</th><th>Acciones</th></tr></thead>
                  <tbody>
                    {inbound.slice(0, 50).map((i) => {
                      const st = INBOUND_STATUS[i.status] ?? { label: i.status, cls: "info" };
                      const d = i.draft as { arrivalDate?: string; departureDate?: string; roomTypeName?: string; guestName?: string };
                      return (
                        <tr key={i.id}>
                          <td style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.from ?? "—"}</td>
                          <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.subject ?? "—"}</td>
                          <td>{i.detectedSource ?? "—"}</td>
                          <td>{i.confidence != null ? `${i.confidence}%` : "—"}</td>
                          <td style={{ fontSize: 12 }}>{i.status === "ignored" ? <span className="bo-muted">no es reserva</span> : `${d.guestName ?? "—"} · ${d.arrivalDate ?? "?"}→${d.departureDate ?? "?"} · ${d.roomTypeName ?? "—"}`}</td>
                          <td><span className={`bo-status ${st.cls}`} style={{ textTransform: "none" }}>{st.label}</span></td>
                          <td>
                            {i.status === "review" ? (
                              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                <button type="button" className="primary" disabled={busy} onClick={() => run(() => approveInboundEmail(i.id), "Reserva creada desde el email.")}>Aprobar</button>
                                <button type="button" disabled={busy} style={{ borderColor: "#c2413a", color: "#c2413a" }} onClick={() => run(() => rejectInboundEmail(i.id), "Descartado.")}>Rechazar</button>
                              </div>
                            ) : i.reservationId ? <span className="bo-muted" style={{ fontSize: 12 }}>✓ reserva</span> : <span className="bo-muted">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </article>
        </>
      )}
    </section>
  );
}
