// Correo entrante → reservas — /configuracion/comunicaciones/correo-entrante
// (tab of ComunicacionesTabs; Cocoa 22 · ola 10 · lote 10-B, plantilla
// Formulario).
//
// Mailboxes the AI reads to extract reservation drafts (services/emailApi):
// providers configured on the server (honest «configurado / no configurado»
// badges, no provider is ever shown as active when it is not), connected
// mailboxes with authorise / poll / disconnect, the add-mailbox form, the
// paste-a-mail probe and the review inbox where every draft is approved or
// rejected by a person. Same calls and payloads as before; outcomes go to
// the toast. Disconnecting is destructive (credentials are wiped) so it goes
// through a CocoaDialog with busy; a provider the server declares as not
// configured cannot add a mailbox (no «pending» row is ever created for an
// authorisation that cannot happen) and disconnected rows offer no further
// action (qa#4).
//
// Tanda 7b (L4): every mailbox carries a purpose — «Reservas por IA» (the flow
// above) or «Modo sombra OPERA» (the attachments of the OPERA Report Scheduler
// go to the shadow ingest; optional sender-domain and subject filters travel in
// the payload as `fromDomain` / `subjectContains`). The list shows the purpose
// as a badge. No inline style added (the 4 tolerated ones stay as they were).
//
// Tanda T9 (T9-07): third purpose «Documentos del centro» — every PDF / image /
// XML attachment of the mailbox becomes an incoming document of the active
// centre (module documents); no filter is required. Still no inline style.

import { useCallback, useEffect, useMemo, useState } from "react";
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
  emailConnectionPurpose,
  type CreateEmailConnectionPayload,
  type EmailConnectionPurpose,
  type EmailProviders,
  type EmailConnection,
  type InboundEmail
} from "../../services/emailApi";
import { useToast } from "../../components/Toast";
import { date, dateTime, percent, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaGrid,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROVIDER_LABEL: Record<string, string> = { gmail: "Gmail", microsoft: "Microsoft 365", imap: "IMAP", manual: "Manual (pegar un correo)" };
const PROVIDER_OPTIONS = ["gmail", "microsoft", "imap", "manual"].map((value) => ({ value, label: PROVIDER_LABEL[value] }));
/** Providers whose mailbox needs an external authorisation (the server creates them as `pending_auth`). */
const OAUTH_PROVIDERS = new Set(["gmail", "microsoft"]);
const STATUS_LABEL: Record<string, string> = { connected: "conectado", pending_auth: "pendiente de autorizar", disconnected: "desconectado", error: "error" };
/**
 * Purpose of a mailbox: the AI reservation flow, the OPERA shadow-mode ingest (Tanda 7b) or the
 * documents mailbox of the centre (Tanda T9 · T9-07: every PDF / image / XML attachment becomes an
 * incoming document). `documents` is accepted by the API schema (EMAIL_CONNECTION_PURPOSES) but the
 * client type of services/emailApi.ts is still the Tanda 7b pair, so the screen widens it locally.
 */
type MailboxPurpose = EmailConnectionPurpose | "documents";
const PURPOSE_LABEL: Record<MailboxPurpose, string> = { reservation_ai: "Reservas por IA", pms_shadow: "Modo sombra OPERA", documents: "Documentos del centro" };
const PURPOSE_OPTIONS = (Object.keys(PURPOSE_LABEL) as MailboxPurpose[]).map((value) => ({ value, label: PURPOSE_LABEL[value] }));
const PURPOSE_TONE: Record<MailboxPurpose, CocoaTone> = { reservation_ai: "ai", pms_shadow: "info", documents: "success" };
const PURPOSE_HELP: Record<MailboxPurpose, string> = {
  reservation_ai: "Cada correo se convierte en un borrador de reserva que una persona revisa.",
  pms_shadow: "Los adjuntos (CSV, XML, XLSX) van al ingest del modo sombra; ningún correo pasa por la IA.",
  documents: "Cada adjunto PDF/imagen/XML crea un documento entrante en este centro; el cuerpo del correo no se guarda."
};

/** `config.purpose` of a connection including `documents`; anything else reads as the API does (emailConnectionPurpose). */
function mailboxPurpose(connection: Pick<EmailConnection, "config">): MailboxPurpose {
  return connection.config?.purpose === ("documents" as string) ? "documents" : emailConnectionPurpose(connection);
}

function isMailboxPurpose(value: string): value is MailboxPurpose {
  return value in PURPOSE_LABEL;
}
const FILTER_MAX = 120;
const INBOUND_STATUS: Record<string, { label: string; tone: CocoaTone }> = {
  received: { label: "recibido", tone: "info" },
  review: { label: "en revisión", tone: "warning" },
  ignored: { label: "ignorado", tone: "neutral" },
  reservation_created: { label: "reserva creada", tone: "success" },
  error: { label: "error", tone: "danger" },
  // Buzón «Documentos del centro» (T9-07): el correo no es una reserva; cada adjunto es un documento entrante.
  documents_ingested: { label: "documentos creados", tone: "success" },
  documents_ignored: { label: "sin documentos", tone: "neutral" }
};

type Draft = { arrivalDate?: string; departureDate?: string; roomTypeName?: string; guestName?: string };
/** `draftJson` of a documents mailbox row (email-reservation.service.ts processDocumentsEmail): counts per attachment, never bytes. */
type DocumentsDraft = { purpose?: string; ingested?: number; ignored?: number; failed?: number; reason?: string };

/** «2 documentos · 1 ignorado» for a documents mailbox row; the reason when nothing was captured. */
function documentsSummary(i: InboundEmail): string {
  const d = i.draft as DocumentsDraft;
  if (i.status === "documents_ignored" && (d.ingested ?? 0) === 0) {
    return d.reason === "filter" ? "descartado por los filtros del buzón" : d.reason === "no_attachment" ? "sin adjunto PDF/imagen/XML" : plural(d.ignored ?? 0, "adjunto ignorado", "adjuntos ignorados");
  }
  const parts = [plural(d.ingested ?? 0, "documento", "documentos")];
  if (d.ignored) parts.push(plural(d.ignored, "ignorado", "ignorados"));
  if (d.failed) parts.push(plural(d.failed, "fallido", "fallidos"));
  return parts.join(" · ");
}

function connectionTone(status: string): CocoaTone {
  return status === "connected" ? "success" : status === "error" ? "danger" : status === "disconnected" ? "neutral" : "warning";
}

/** «Gmail (reservas@hotel.es)» for dialog titles. */
function connectionLabel(c: EmailConnection): string {
  const provider = PROVIDER_LABEL[c.provider] ?? c.provider;
  return c.emailAddress ? `${provider} (${c.emailAddress})` : provider;
}

function draftSummary(i: InboundEmail): string {
  const d = i.draft as Draft;
  return `${d.guestName ?? "—"} · ${date(d.arrivalDate, "short")} → ${date(d.departureDate, "short")} · ${d.roomTypeName ?? "—"}`;
}

const INBOUND_COLUMNS: CocoaTableColumn<InboundEmail>[] = [
  {
    key: "from",
    label: "Remitente",
    minWidth: 140,
    render: (i) => (
      <span className="cocoa-truncate" style={{ display: "block", maxWidth: 200 }}>
        {i.from ?? "—"}
      </span>
    )
  },
  {
    key: "subject",
    label: "Asunto",
    minWidth: 160,
    render: (i) => (
      <span className="cocoa-truncate" style={{ display: "block", maxWidth: 260 }}>
        {i.subject ?? "—"}
      </span>
    )
  },
  { key: "detectedSource", label: "Origen", fit: true, hideOnNarrow: true, render: (i) => i.detectedSource ?? "—" },
  { key: "confidence", label: "Confianza", align: "right", fit: true, render: (i) => (i.confidence != null ? percent(i.confidence, { maximumFractionDigits: 0 }) : "—") },
  {
    key: "draft",
    label: "Borrador",
    minWidth: 200,
    showFrom: "laptop",
    render: (i) =>
      i.status === "ignored" ? (
        <span className="cocoa-note">no es reserva</span>
      ) : i.status === "documents_ingested" || i.status === "documents_ignored" ? (
        <span className="cocoa-note">{documentsSummary(i)}</span>
      ) : (
        <span className="cocoa-note">{draftSummary(i)}</span>
      )
  },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (i) => {
      const st = INBOUND_STATUS[i.status] ?? { label: i.status, tone: "info" as CocoaTone };
      return (
        <CocoaBadge tone={st.tone} variant="tinted" size="small">
          {st.label}
        </CocoaBadge>
      );
    }
  }
];

function ConnectorsSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={72} />
      <CocoaSkeleton.Grid rows={[[6, 6], [12]]} height={220} />
    </div>
  );
}

export function EmailConnectorsScreen() {
  // Hosted (ComunicacionesTabs): the container paints eyebrow + H1.
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const [providers, setProviders] = useState<EmailProviders>({});
  const [connections, setConnections] = useState<EmailConnection[]>([]);
  const [inbound, setInbound] = useState<InboundEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // disconnect confirmation (the target survives the dialog's exit transition)
  const [disconnectTarget, setDisconnectTarget] = useState<EmailConnection | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  // add-connection form
  const [provider, setProvider] = useState("gmail");
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // purpose (Tanda 7b): pms_shadow adds the optional sender-domain and subject filters; documents (T9-07) needs none
  const [purpose, setPurpose] = useState<MailboxPurpose>("reservation_ai");
  const [fromDomain, setFromDomain] = useState("");
  const [subjectContains, setSubjectContains] = useState("");

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
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el módulo de correo.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs an action, toasts the outcome and reloads; resolves true only when the action succeeded. */
  async function run<T>(fn: () => Promise<T>, ok: string | ((result: T) => string)): Promise<boolean> {
    setBusy(true);
    try {
      const result = await fn();
      showToast(typeof ok === "function" ? ok(result) : ok, { variant: "success" });
      await load();
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : "No se pudo completar la acción.", { variant: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const providerInfo = providers[provider];
  const oauthProvider = OAUTH_PROVIDERS.has(provider);
  // A provider the server declares as not configured cannot serve a mailbox: no row is created until it is.
  const providerUnavailable = providerInfo ? !providerInfo.configured : false;
  const imapIncomplete = provider === "imap" && (!host.trim() || !username.trim() || !password);
  // SEC-03: a shadow-mode mailbox must name the sender domain (the API schema rejects `pms_shadow` without `fromDomain`).
  const shadowIncomplete = purpose === "pms_shadow" && fromDomain.trim() === "";
  const canAdd = !busy && !providerUnavailable && !imapIncomplete && !shadowIncomplete;

  async function addConnection() {
    if (!canAdd) return;
    // `documents` widens the Tanda 7b client type (services/emailApi.ts) until it carries the third purpose; the API schema already accepts it.
    const payload = { provider, purpose } as CreateEmailConnectionPayload;
    if (provider === "imap") Object.assign(payload, { host, username, password, port: 993 });
    // The filters only make sense for the shadow-mode ingest; blank ones never travel (the API schema rejects empty strings).
    if (purpose === "pms_shadow") {
      if (fromDomain.trim()) payload.fromDomain = fromDomain.trim();
      if (subjectContains.trim()) payload.subjectContains = subjectContains.trim();
    }
    await run(
      async () => {
        const conn = await createEmailConnection(payload);
        setHost("");
        setUsername("");
        setPassword("");
        setFromDomain("");
        setSubjectContains("");
        // OAuth providers: the authorisation opens in the same step, so the new mailbox never sits «pending» unannounced.
        if (conn.needsOAuth && conn.authorizeAvailable) {
          const { url } = await getEmailAuthorizeUrl(conn.id);
          window.open(url, "_blank", "noopener,noreferrer");
          return "authorizing" as const;
        }
        return conn.needsOAuth ? ("pending" as const) : ("connected" as const);
      },
      (outcome) =>
        outcome === "authorizing"
          ? "Buzón creado. Completa la autorización en la pestaña abierta y después pulsa Actualizar."
          : outcome === "pending"
            ? "Buzón creado, pendiente de autorizar: pulsa Autorizar en la lista cuando la autorización externa esté disponible."
            : "Buzón añadido."
    );
  }

  async function confirmDisconnect() {
    if (!disconnectTarget) return;
    const done = await run(() => disconnectEmailConnection(disconnectTarget.id), "Buzón desconectado.");
    if (done) setDisconnectOpen(false);
  }

  async function authorize(id: string) {
    setBusy(true);
    try {
      const { url } = await getEmailAuthorizeUrl(id);
      window.open(url, "_blank", "noopener,noreferrer");
      showToast("Abre la pestaña de autorización y vuelve; luego pulsa Actualizar.", { variant: "info" });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "La autorización externa no está disponible.", { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const reviewItems = useMemo(() => inbound.filter((i) => i.status === "review"), [inbound]);
  const providerEntries = useMemo(() => Object.entries(providers), [providers]);
  const configuredProviders = providerEntries.filter(([, v]) => v.configured).length;
  const disconnectedCount = connections.filter((c) => c.status === "disconnected").length;
  const mailboxesMeta =
    disconnectedCount > 0
      ? `${plural(connections.length, "buzón", "buzones")} · ${plural(disconnectedCount, "desconectado", "desconectados")}`
      : plural(connections.length, "buzón", "buzones");

  return (
    <CocoaPage
      eyebrow="Configuración · Comunicaciones"
      title="Correo entrante"
      subtitle={hosted ? undefined : "Buzones que la IA lee para convertir correos de reserva en borradores que una persona revisa antes de crear la reserva."}
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void load()} disabled={loading}>
          {ACTIONS.refresh}
        </CocoaButton>
      }
      state={loading && !loaded ? "loading" : error && !loaded ? "error" : "ready"}
      skeleton={<ConnectorsSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: () => void load() }}
      commands={[{ id: "correo-entrante-refresh", label: "Actualizar los buzones de correo entrante", run: () => void load() }]}
    >
      <CocoaCallout tone="info" title="Cada borrador pasa siempre por revisión humana">
        Conecta buzones (Gmail, Microsoft 365, IMAP) para que la IA lea los correos entrantes y extraiga reservas. El conector manual te deja pegar un correo y recorrer el
        mismo flujo sin autorización externa.
      </CocoaCallout>

      {error && loaded ? (
        <CocoaCallout tone="danger" role="alert" title={STATUS_LABELS.loadError}>
          {error}
        </CocoaCallout>
      ) : null}

      <CocoaSection title="Proveedores" meta={`${configuredProviders} de ${plural(providerEntries.length, "proveedor", "proveedores")} configurados`}>
        {providerEntries.length === 0 ? (
          <CocoaState kind="empty" inline title="El servidor no declara ningún proveedor de correo." />
        ) : (
          <div className="cocoa-cluster" role="list" aria-label="Proveedores de correo">
            {providerEntries.map(([k, v]) => (
              <CocoaBadge key={k} tone={v.configured ? "success" : "neutral"} variant="tinted" uppercase={false} title={v.note ?? undefined} role="listitem">
                {PROVIDER_LABEL[k] ?? k}: {v.configured ? "configurado" : "no configurado"}
              </CocoaBadge>
            ))}
          </div>
        )}
      </CocoaSection>

      <CocoaGrid align="start">
        <CocoaSpan cols={6} min={320}>
          <div className="cocoa-stack" data-gap="3">
            <CocoaSection title="Buzones conectados" meta={mailboxesMeta}>
              {connections.length === 0 ? (
                <CocoaState kind="empty" inline title="Aún no hay buzones. Añade uno abajo." />
              ) : (
                <ul className="c22-section__list" aria-label="Buzones conectados">
                  {connections.map((c) => (
                    <li key={c.id}>
                      <div className="cocoa-stack" data-gap="1" style={{ flex: "1 1 auto" }}>
                        <div className="cocoa-cluster">
                          <strong>{PROVIDER_LABEL[c.provider] ?? c.provider}</strong>
                          <CocoaBadge tone={connectionTone(c.status)} variant="tinted" size="small">
                            {STATUS_LABEL[c.status] ?? c.status}
                          </CocoaBadge>
                          <CocoaBadge tone={PURPOSE_TONE[mailboxPurpose(c)]} variant="outline" size="small" uppercase={false} title={c.config?.fromDomain || c.config?.subjectContains ? `Filtros: ${[c.config?.fromDomain ? `remitente ${c.config.fromDomain}` : null, c.config?.subjectContains ? `asunto «${c.config.subjectContains}»` : null].filter(Boolean).join(" · ")}` : undefined}>
                            {PURPOSE_LABEL[mailboxPurpose(c)]}
                          </CocoaBadge>
                        </div>
                        <span className="cocoa-note">
                          {c.emailAddress ?? "—"} · última sincronización {dateTime(c.lastSyncAt)}
                        </span>
                        {c.lastError ? <CocoaState kind="error" inline title={c.lastError} /> : null}
                      </div>
                      <div className="cocoa-cluster">
                        {c.status === "pending_auth" ? (
                          <CocoaButton variant="filled" tone="accent" size="small" disabled={busy} onClick={() => void authorize(c.id)}>
                            Autorizar
                          </CocoaButton>
                        ) : null}
                        {c.status === "connected" && c.provider !== "manual" ? (
                          <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy} onClick={() => void run(() => pollEmailConnection(c.id), "Sondeo lanzado.")}>
                            Sondear
                          </CocoaButton>
                        ) : null}
                        {c.status !== "disconnected" ? (
                          <CocoaButton
                            variant="bordered"
                            tone="destructive"
                            size="small"
                            disabled={busy}
                            onClick={() => {
                              setDisconnectTarget(c);
                              setDisconnectOpen(true);
                            }}
                          >
                            Desconectar
                          </CocoaButton>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CocoaSection>

            <CocoaFormSection
              title="Añadir buzón"
              description="Gmail y Microsoft 365 abren la autorización externa en el mismo paso; IMAP pide los datos del servidor. El propósito decide qué se hace con cada correo: extraer reservas con IA, entregar los adjuntos al modo sombra de OPERA o crear un documento entrante del centro por cada adjunto."
              actions={
                <CocoaButton variant="filled" tone="accent" size="small" disabled={!canAdd} loading={busy} onClick={() => void addConnection()}>
                  {oauthProvider ? "Iniciar autorización" : "Añadir buzón"}
                </CocoaButton>
              }
            >
              {providerUnavailable ? (
                <CocoaCallout tone="warning" title={`${PROVIDER_LABEL[provider] ?? provider} no está configurado en el servidor`}>
                  {providerInfo?.note ??
                    (oauthProvider ? "La autorización externa no está disponible, así que este buzón no se puede añadir todavía." : "Este buzón no se puede añadir todavía.")}{" "}
                  Elige otro proveedor o usa el conector manual.
                </CocoaCallout>
              ) : null}
              <CocoaFormRow columns={2}>
                <CocoaField label="Proveedor">
                  <CocoaSelect value={provider} onChange={setProvider} options={PROVIDER_OPTIONS} />
                </CocoaField>
                <CocoaField label="Propósito" help={PURPOSE_HELP[purpose]}>
                  <CocoaSelect value={purpose} onChange={(value) => setPurpose(isMailboxPurpose(value) ? value : "reservation_ai")} options={PURPOSE_OPTIONS} />
                </CocoaField>
                {purpose === "pms_shadow" ? (
                  <CocoaField label="Dominio remitente" required help="Obligatorio: solo se procesan los correos cuyo remitente pertenece a este dominio (o a un subdominio); sin él cualquier remitente podría contabilizar ingresos o cancelar reservas.">
                    <CocoaInput value={fromDomain} onChange={setFromDomain} placeholder="oracle.com" autoComplete="off" maxLength={FILTER_MAX} />
                  </CocoaField>
                ) : null}
                {purpose === "pms_shadow" ? (
                  <CocoaField label="Asunto contiene" hint="opcional" help="Texto que debe aparecer en el asunto (sin distinguir mayúsculas).">
                    <CocoaInput value={subjectContains} onChange={setSubjectContains} placeholder="Scheduled report" autoComplete="off" maxLength={FILTER_MAX} />
                  </CocoaField>
                ) : null}
                {provider === "imap" ? (
                  <CocoaField label="Servidor" required>
                    <CocoaInput value={host} onChange={setHost} placeholder="imap.dominio.com" autoComplete="off" />
                  </CocoaField>
                ) : null}
                {provider === "imap" ? (
                  <CocoaField label="Usuario" required>
                    <CocoaInput value={username} onChange={setUsername} placeholder="usuario" autoComplete="off" />
                  </CocoaField>
                ) : null}
                {provider === "imap" ? (
                  <CocoaField label="Contraseña de aplicación" required>
                    <CocoaInput value={password} onChange={setPassword} type="password" autoComplete="new-password" />
                  </CocoaField>
                ) : null}
              </CocoaFormRow>
            </CocoaFormSection>
          </div>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaFormSection
            title="Probar con un correo pegado"
            description="Pega el texto de un correo de reserva; la IA lo extrae y lo envía a revisión."
            actions={
              <CocoaButton
                variant="filled"
                tone="accent"
                size="small"
                disabled={busy || !mBody.trim()}
                loading={busy}
                onClick={() =>
                  void run(async () => {
                    await ingestManualEmail({ from: mFrom, subject: mSubject, body: mBody });
                    setMBody("");
                    setMSubject("");
                    setMFrom("");
                  }, "Correo procesado.")
                }
              >
                Procesar correo
              </CocoaButton>
            }
          >
            <CocoaField label="De (remitente)">
              <CocoaInput value={mFrom} onChange={setMFrom} placeholder="huesped@ejemplo.com" inputMode="email" />
            </CocoaField>
            <CocoaField label="Asunto">
              <CocoaInput value={mSubject} onChange={setMSubject} placeholder="Reserva para el fin de semana" />
            </CocoaField>
            <CocoaField label="Cuerpo del correo" required fullWidth>
              <CocoaInput value={mBody} onChange={setMBody} multiline rows={6} placeholder="Cuerpo del correo…" />
            </CocoaField>
          </CocoaFormSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaSection
        title="Bandeja de reservas por correo"
        meta={`${plural(reviewItems.length, "correo en revisión", "correos en revisión")} · ${plural(inbound.length, "correo", "correos")} en total`}
        padding={inbound.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
      >
        {inbound.length === 0 ? (
          <CocoaState kind="empty" illustration="box" title="Sin correos procesados" message="Conecta un buzón y sondéalo, o prueba con un correo pegado." />
        ) : (
          <CocoaTable
            columns={INBOUND_COLUMNS}
            rows={inbound.slice(0, 50)}
            rowKey="id"
            rowTone={(i) => (i.status === "review" ? "warning" : undefined)}
            rowActionsVisible="always"
            rowActions={(i) =>
              i.status === "review" ? (
                <>
                  <CocoaButton variant="plain" size="small" tone="accent" disabled={busy} onClick={() => void run(() => approveInboundEmail(i.id), "Reserva creada desde el correo.")}>
                    {ACTIONS.approve}
                  </CocoaButton>
                  <CocoaButton variant="plain" size="small" tone="destructive" disabled={busy} onClick={() => void run(() => rejectInboundEmail(i.id), "Descartado.")}>
                    {ACTIONS.reject}
                  </CocoaButton>
                </>
              ) : i.reservationId ? (
                <CocoaBadge tone="success" variant="outline" size="small">
                  reserva creada
                </CocoaBadge>
              ) : null
            }
            caption="Correos de reserva recibidos"
            aria-label="Correos de reserva recibidos"
          />
        )}
      </CocoaSection>

      <CocoaDialog
        open={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        tone="destructive"
        title={`¿Desconectar el buzón ${disconnectTarget ? connectionLabel(disconnectTarget) : ""}?`}
        description="Se dejarán de leer sus correos y se borrarán las credenciales guardadas. El buzón seguirá en la lista como desconectado; para volver a usarlo habrá que añadirlo de nuevo."
        confirmLabel="Desconectar"
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        onConfirm={confirmDisconnect}
      />
    </CocoaPage>
  );
}
