// Envíos a autoridades — /cumplimiento/envios (standalone). Cocoa 22 · ola 8 ·
// lote 8-B (plantilla ListaTabla dentro de un dashboard: inner views por
// autoridad, tabla de envíos y detalle en CocoaDrawer).
//
// One list per authority (VeriFactu · TicketBAI · IGIC · SES.HOSPEDAJES) read
// with useApiData and polled every 12 s while a submission is still pending;
// «Reintentar N fallidos» re-queues every retryable row (POST …/retry, one
// request per row, summarised in a toast). A row opens the detail drawer
// (SubmissionDetailDrawer, defined below in this file): identifiers, life
// cycle, transport, the authority's error, the canonical XML and the
// authority's response, with a manual retry. The pending / retryable status
// sets live in fiscal-shared.ts (SUBMISSION_PENDING_STATUSES counts «sent» as
// open, like the API's SES_OPEN_STATUSES). Simulated acknowledgements
// (endpoint `stub://…`, no real submission) are labelled «Simulado · no enviado»
// and never painted green (auditoría 2026-07).

import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { useToast } from "../../components/Toast";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS } from "../../content/actions";
import { EMPTY, dateTime, number, plural } from "../../lib/format";
import { SUBMISSION_PENDING_STATUSES, SUBMISSION_RETRYABLE_STATUSES, submissionStatusLabel } from "./fiscal-shared";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  type CocoaPageHeaderTab,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

type AuthorityKind = "verifactu" | "tbai" | "igic" | "ses";

type SubmissionRow = {
  id: string;
  status: string;
  endpoint?: string;
  attempts?: number;
  submittedAt?: string;
  acknowledgedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  invoiceNumber?: string;
  invoiceId?: string;
  csvCode?: string;
  tbaiCode?: string;
  tbaiHash?: string;
  territory?: string;
  acknowledgementCode?: string;
  trackingNumber?: string;
  externalReference?: string;
  submissionType?: string;
};

/** Tone of a submission status. A SIMULATED «accepted» (no real submission to
 *  the Administration) is never painted green as if it were a real acknowledgement. */
function statusTone(status: string, simulated = false): CocoaTone {
  // VeriFactu writes `accepted_with_errors` («AceptadoConErrores»), SES `accepted_with_warnings`.
  if (status === "accepted" || status === "accepted_with_errors" || status === "accepted_with_warnings") return simulated ? "warning" : "success";
  // Terminal states without acknowledgement: «failed» (attempts exhausted) and
  // «abandoned» (the invoice is no longer issuable) are errors, not information.
  if (status === "rejected" || status === "failed" || status === "abandoned") return "danger";
  if (status === "retrying" || status === "queued" || status === "submitting" || status === "sent" || status === "pending" || status === "network_error") return "warning";
  return "info";
}

// The Spanish label of every wire status lives in fiscal-shared.ts
// (`submissionStatusLabel`, shared with TbaiForalScreen and unit-tested).

/** Simulated submission: the default submitter persists acknowledgements with an
 *  endpoint `stub://…` without contacting the Administration. */
function isSimulated(row: { endpoint?: string }): boolean {
  return typeof row.endpoint === "string" && row.endpoint.startsWith("stub://");
}

function listPath(tab: AuthorityKind): string {
  switch (tab) {
    case "verifactu": return `/properties/${PROPERTY_ID}/verifactu/submissions`;
    case "tbai": return `/properties/${PROPERTY_ID}/tbai/submissions`;
    case "igic": return `/properties/${PROPERTY_ID}/igic/submissions`;
    case "ses": return `/properties/${PROPERTY_ID}/ses/submissions`;
  }
}

function retryPath(tab: AuthorityKind, id: string): string {
  switch (tab) {
    case "verifactu": return `/verifactu/submissions/${id}/retry`;
    case "tbai": return `/tbai/submissions/${id}/retry`;
    case "igic": return `/igic/submissions/${id}/retry`;
    case "ses": return `/ses/submissions/${id}/retry`;
  }
}

const AUTHORITIES: ReadonlyArray<{ id: AuthorityKind; label: string; subtitle: string }> = [
  { id: "verifactu", label: "VeriFactu", subtitle: "AEAT · Península y Baleares" },
  { id: "tbai", label: "TicketBAI", subtitle: "Bizkaia · Gipuzkoa · Araba" },
  { id: "igic", label: "IGIC", subtitle: "Canarias (ATC)" },
  { id: "ses", label: "SES.HOSPEDAJES", subtitle: "MIR · viajeros" }
];

const AUTHORITY_TABS: CocoaPageHeaderTab[] = AUTHORITIES.map((a) => ({ value: a.id, label: a.label }));

function identifierCell(row: SubmissionRow): ReactNode {
  const items: Array<[string, string]> = [];
  if (row.csvCode) items.push(["CSV", row.csvCode]);
  if (row.tbaiCode) items.push(["Código TBAI", row.tbaiCode]);
  if (row.acknowledgementCode) items.push(["Acuse", row.acknowledgementCode]);
  if (items.length === 0) return EMPTY;
  return (
    <span className="cocoa-stack" data-gap="1">
      {items.map(([label, code]) => (
        <span key={label}>
          <span className="cocoa-mono">{code}</span>
          <span className="cocoa-note">{label}</span>
        </span>
      ))}
    </span>
  );
}

function detailCell(row: SubmissionRow): ReactNode {
  if (row.errorCode) {
    return (
      <span className="cocoa-stack" data-gap="1">
        <span>
          <CocoaBadge tone="danger">{row.errorCode}</CocoaBadge>
        </span>
        {row.errorMessage ? <span className="cocoa-note">{row.errorMessage}</span> : null}
      </span>
    );
  }
  if (row.trackingNumber) return <span className="cocoa-mono">{row.trackingNumber}</span>;
  if (row.tbaiHash) {
    return (
      <span className="cocoa-mono" title={row.tbaiHash}>
        {`${row.tbaiHash.slice(0, 16)}…`}
      </span>
    );
  }
  return EMPTY;
}

/** Columns of the list; only the reference header depends on the authority (SES has no invoice). */
function submissionColumns(tab: AuthorityKind): CocoaTableColumn<SubmissionRow>[] {
  return [
    {
      key: "status",
      label: FIELD_LABELS.status,
      fit: true,
      render: (row) => (
        <span className="cocoa-cluster">
          <CocoaBadge tone={statusTone(row.status, isSimulated(row))}>{submissionStatusLabel(row.status)}</CocoaBadge>
          {isSimulated(row) ? (
            <CocoaBadge tone="warning" variant="tinted" size="small">
              Simulado · no enviado
            </CocoaBadge>
          ) : null}
        </span>
      )
    },
    {
      key: "reference",
      label: tab === "ses" ? "Referencia" : "Factura",
      minWidth: 160,
      render: (row) => (
        <span className="cocoa-stack" data-gap="1">
          <strong>{row.invoiceNumber ?? row.externalReference ?? EMPTY}</strong>
          {row.submissionType ? <span className="cocoa-note">{row.submissionType}</span> : null}
          {row.territory ? <span className="cocoa-note">{row.territory}</span> : null}
        </span>
      )
    },
    // Only ≥ 1200: with the CSV / acuse codes (mono, one line) the table measured
    // 858 px inside a 734 px wrap at 1024 (qa#16); the drawer lists every identifier.
    { key: "identifier", label: "Identificador", showFrom: "desktop", render: identifierCell },
    { key: "submittedAt", label: "Enviado", fit: true, showFrom: "tablet", render: (row) => dateTime(row.submittedAt) },
    { key: "attempts", label: "Intentos", align: "right", fit: true, render: (row) => number(row.attempts ?? 0) },
    { key: "detail", label: "Detalle", showFrom: "laptop", render: detailCell }
  ];
}

function SubmissionsSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={320} />
    </div>
  );
}

export function FiscalSubmissionsCenter() {
  const { showToast } = useToast();
  const [tab, setTab] = useState<AuthorityKind>("verifactu");
  const [selected, setSelected] = useState<string | null>(null);
  const [bulkRetrying, setBulkRetrying] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);

  const { data, loading, error, refresh } = useApiData<SubmissionRow[] | { items?: SubmissionRow[]; submissions?: SubmissionRow[] }>(listPath(tab), {
    pollIntervalMs: 12_000,
    pollWhile: (raw) => {
      const list = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { items?: SubmissionRow[] } | null)?.items)
          ? ((raw as { items: SubmissionRow[] }).items)
          : Array.isArray((raw as { submissions?: SubmissionRow[] } | null)?.submissions)
            ? ((raw as { submissions: SubmissionRow[] }).submissions)
            : [];
      return list.some((r) => SUBMISSION_PENDING_STATUSES.has(r.status));
    }
  });

  // Defensive: accept array, { items: [] }, { submissions: [] }, null, undefined —
  // some envelopes wrap the list in an object instead of a raw array.
  const rows: SubmissionRow[] = useMemo(() => {
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
      const envelope = data as { items?: SubmissionRow[]; submissions?: SubmissionRow[] };
      if (Array.isArray(envelope.items)) return envelope.items;
      if (Array.isArray(envelope.submissions)) return envelope.submissions;
    }
    return [];
  }, [data]);
  const retryable = useMemo(() => rows.filter((r) => SUBMISSION_RETRYABLE_STATUSES.has(r.status)), [rows]);
  const columns = useMemo(() => submissionColumns(tab), [tab]);
  const authority = AUTHORITIES.find((a) => a.id === tab) ?? AUTHORITIES[0];

  async function handleBulkRetry() {
    if (retryable.length === 0) return;
    setBulkRetrying(true);
    setBulkMessage(null);
    let ok = 0;
    let fail = 0;
    for (const row of retryable) {
      try {
        await apiRequest(retryPath(tab, row.id), { method: "POST" });
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setBulkRetrying(false);
    const summary = `${plural(ok, "envío reencolado", "envíos reencolados")}.${fail > 0 ? ` ${plural(fail, "envío con error", "envíos con error")}.` : ""}`;
    setBulkMessage(summary);
    if (fail === 0) {
      showToast(summary, { variant: "success" });
    } else if (ok === 0) {
      showToast(summary, { variant: "error" });
    } else {
      showToast(summary, { variant: "info" });
    }
    setTimeout(() => refresh(), 1500);
  }

  const hasRows = rows.length > 0;
  const ready = !error && hasRows;

  return (
    <CocoaPage
      eyebrow="Cumplimiento"
      title="Envíos a autoridades"
      subtitle="VeriFactu, SES.Hospedajes, TicketBAI e IGIC: abre una fila para ver el XML firmado, la respuesta de la autoridad y los reintentos. La tabla se actualiza sola cada 12 s mientras haya envíos pendientes."
      tabs={AUTHORITY_TABS}
      activeTab={tab}
      onTabChange={(value) => {
        setTab(value as AuthorityKind);
        setSelected(null);
      }}
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => refresh()} loading={loading && hasRows}>
            {ACTIONS.refresh}
          </CocoaButton>
          {retryable.length > 0 ? (
            <CocoaButton variant="filled" tone="accent" size="small" loading={bulkRetrying} onClick={() => void handleBulkRetry()}>
              {bulkRetrying ? "Reintentando…" : `Reintentar ${plural(retryable.length, "fallido", "fallidos")}`}
            </CocoaButton>
          ) : null}
        </>
      }
      state={loading && !hasRows && !error ? "loading" : "ready"}
      skeleton={<SubmissionsSkeleton />}
      commands={[
        { id: "fiscal-submissions-refresh", label: "Actualizar los envíos a autoridades", run: () => refresh() },
        { id: "fiscal-submissions-retry", label: "Reintentar los envíos fallidos", run: () => void handleBulkRetry() }
      ]}
    >
      {bulkMessage ? (
        <CocoaCallout tone="info" role="status">
          {bulkMessage}
        </CocoaCallout>
      ) : null}

      {rows.some(isSimulated) ? (
        <CocoaCallout tone="warning" title="Modo de pruebas" role="status">
          Los envíos marcados como «Simulado» no han salido del sistema: <strong>no se han remitido a la Administración</strong>. El envío real
          requiere configurar el modo producción y el certificado del establecimiento.
        </CocoaCallout>
      ) : null}

      <CocoaSection
        title={authority.label}
        meta={authority.subtitle}
        padding={ready ? "none" : "md"}
        style={{ overflow: "clip" }}
        footer={ready ? <span>{plural(rows.length, "envío", "envíos")}</span> : undefined}
      >
        {error ? (
          <CocoaState kind="error" title="Error al cargar los envíos" message="No hemos podido cargar los envíos. Inténtalo de nuevo." onRetry={() => refresh()} />
        ) : !hasRows ? (
          <CocoaState
            kind="empty"
            illustration="box"
            title="Todavía no hay envíos a esta autoridad"
            message="Emite una factura de una propiedad que tribute en esta autoridad y aparecerá aquí."
          />
        ) : (
          <CocoaTable
            columns={columns}
            rows={rows}
            rowKey="id"
            selectedKey={selected ?? undefined}
            onSelect={(row) => setSelected(row.id)}
            rowTitle={() => "Abrir el detalle del envío"}
            rowActions={(row) => (
              <CocoaButton
                variant="plain"
                size="small"
                onClick={(event) => {
                  event.stopPropagation();
                  setSelected(row.id);
                }}
              >
                {ACTIONS.viewDetail}
              </CocoaButton>
            )}
            caption={`Envíos a ${authority.label}`}
            aria-label={`Envíos a ${authority.label}`}
          />
        )}
      </CocoaSection>

      <SubmissionDetailDrawer open={selected !== null} authority={tab} submissionId={selected} onClose={() => setSelected(null)} onRetried={() => refresh()} />
    </CocoaPage>
  );
}

// ----------------------------------------------------------------- detail drawer

type DetailRow = SubmissionRow & {
  previousTbaiHash?: string;
  acceptedHash?: string;
  xmlPayload?: string;
  responseAck?: string;
  signatureMode?: string;
  signedAt?: string;
  nextRetryAt?: string;
  createdAt?: string;
};

type DetailView = "summary" | "xml" | "response";

const AUTHORITY_META: Record<AuthorityKind, { label: string; authority: string; endpointBase: string }> = {
  verifactu: { label: "VeriFactu", authority: "AEAT", endpointBase: "/verifactu/submissions" },
  tbai: { label: "TicketBAI", authority: "Hacienda Foral", endpointBase: "/tbai/submissions" },
  igic: { label: "IGIC", authority: "ATC · Canarias", endpointBase: "/igic/submissions" },
  ses: { label: "SES.HOSPEDAJES", authority: "MIR · Interior", endpointBase: "/ses/submissions" }
};

const DETAIL_VIEWS: Array<{ value: DetailView; label: string }> = [
  { value: "summary", label: "Resumen" },
  { value: "xml", label: "XML canónico" },
  { value: "response", label: "Respuesta de la autoridad" }
];

// Code block of the XML / response views: mono caption on the sunken fill, wraps long lines.
const CODE_STYLE: CSSProperties = {
  margin: 0,
  padding: "var(--cocoa-space-4)",
  maxHeight: 480,
  overflow: "auto",
  fontSize: "var(--cocoa-fs-caption)",
  lineHeight: "var(--cocoa-lh-caption)",
  color: "var(--cocoa-label)",
  background: "var(--cocoa-fill-quaternary)",
  border: "1px solid var(--cocoa-separator)",
  borderRadius: "var(--cocoa-radius-md)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word"
};

// Value cell of a key/value row: right-aligned, hashes and endpoints may break anywhere.
const VALUE_STYLE: CSSProperties = { textAlign: "right", wordBreak: "break-all", minWidth: 0 };

type KeyValue = { label: string; value?: string | null; mono?: boolean };

function KeyValueList({ rows, "aria-label": ariaLabel }: { rows: KeyValue[]; "aria-label": string }) {
  return (
    <ul className="c22-section__list" aria-label={ariaLabel}>
      {rows.map((row) => (
        <li key={row.label}>
          <span className="cocoa-caption">{row.label}</span>
          <span className={row.mono ? "cocoa-mono" : undefined} style={VALUE_STYLE}>
            {row.value || EMPTY}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SubmissionDetailDrawer(props: { open: boolean; authority: AuthorityKind; submissionId: string | null; onClose: () => void; onRetried?: () => void }) {
  const [view, setView] = useState<DetailView>("summary");
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const panelId = useId();

  const meta = AUTHORITY_META[props.authority];
  const path = props.open && props.submissionId ? `${meta.endpointBase}/${props.submissionId}` : null;

  const { data, loading, error, refresh } = useApiData<DetailRow>(path, {
    pollIntervalMs: props.open ? 8000 : undefined,
    pollWhile: (d) => {
      const status = (d as DetailRow | null)?.status;
      return status === "retrying" || status === "submitting" || status === "queued" || status === "pending" || status === "network_error";
    }
  });

  // A different submission starts on the summary with a clean retry error.
  useEffect(() => {
    setView("summary");
    setRetryError(null);
  }, [props.submissionId]);

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

  const sub = props.open ? data : null;
  const identifier = sub?.csvCode ?? sub?.tbaiCode ?? sub?.acknowledgementCode ?? sub?.acceptedHash;
  const canRetry = sub !== null && sub !== undefined && SUBMISSION_RETRYABLE_STATUSES.has(sub.status);
  const pending = sub ? SUBMISSION_PENDING_STATUSES.has(sub.status) : false;
  const title = sub?.invoiceNumber ?? sub?.externalReference ?? "Detalle de envío";

  let body: ReactNode;
  if (loading && !sub) {
    body = <CocoaState kind="loading" />;
  } else if (error) {
    body = <CocoaState kind="error" title={STATUS_LABELS.loadError} message={error} onRetry={() => refresh()} />;
  } else if (!sub) {
    body = <CocoaState kind="empty" inline title="Envío no encontrado." />;
  } else if (view === "summary") {
    body = (
      <div className="cocoa-stack" data-gap="3">
        <CocoaSection title="Identificadores" padding="sm">
          <KeyValueList
            aria-label="Identificadores del envío"
            rows={[
              { label: "ID de envío", value: sub.id, mono: true },
              { label: "Factura / Referencia", value: sub.invoiceNumber ?? sub.externalReference, mono: true },
              { label: "ID de factura", value: sub.invoiceId, mono: true },
              ...(identifier ? [{ label: "Código de la autoridad", value: identifier, mono: true }] : []),
              ...(sub.trackingNumber ? [{ label: "Nº de seguimiento", value: sub.trackingNumber, mono: true }] : [])
            ]}
          />
        </CocoaSection>
        <CocoaSection title="Ciclo de vida" padding="sm">
          <KeyValueList
            aria-label="Ciclo de vida del envío"
            rows={[
              { label: FIELD_LABELS.createdAt, value: dateTime(sub.createdAt) },
              { label: "Firmado", value: dateTime(sub.signedAt) },
              { label: "Enviado", value: dateTime(sub.submittedAt) },
              { label: "Confirmado", value: dateTime(sub.acknowledgedAt) },
              ...(sub.nextRetryAt ? [{ label: "Siguiente reintento", value: dateTime(sub.nextRetryAt) }] : [])
            ]}
          />
        </CocoaSection>
        <CocoaSection title="Transporte" padding="sm">
          <KeyValueList
            aria-label="Transporte del envío"
            rows={[
              { label: "Punto de conexión", value: sub.endpoint, mono: true },
              { label: "Modo de firma", value: sub.signatureMode },
              ...(sub.tbaiHash ? [{ label: "Huella TBAI", value: sub.tbaiHash, mono: true }] : []),
              ...(sub.previousTbaiHash ? [{ label: "Huella TBAI anterior", value: sub.previousTbaiHash, mono: true }] : []),
              ...(sub.acceptedHash ? [{ label: "Huella aceptada", value: sub.acceptedHash, mono: true }] : [])
            ]}
          />
        </CocoaSection>
        {sub.errorCode || sub.errorMessage ? (
          <CocoaCallout tone="danger" title="Error de la autoridad" role="alert">
            <span className="cocoa-stack" data-gap="1">
              {sub.errorCode ? (
                <span>
                  <CocoaBadge tone="danger">{sub.errorCode}</CocoaBadge>
                </span>
              ) : null}
              {sub.errorMessage ? <span>{sub.errorMessage}</span> : null}
            </span>
          </CocoaCallout>
        ) : null}
      </div>
    );
  } else {
    body = (
      <pre className="cocoa-mono" style={CODE_STYLE}>
        {view === "xml" ? (sub.xmlPayload ?? "(sin XML)") : (sub.responseAck ?? "(sin respuesta aún)")}
      </pre>
    );
  }

  return (
    <CocoaDrawer
      open={props.open}
      onClose={props.onClose}
      title={title}
      subtitle={`${meta.authority} · ${meta.label}`}
      side="right"
      size="lg"
      focusKey={sub?.id}
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={() => refresh()} aria-label="Actualizar el detalle del envío">
            {ACTIONS.refresh}
          </CocoaButton>
          {canRetry ? (
            <CocoaButton variant="filled" tone="accent" loading={retrying} onClick={() => void handleRetry()}>
              Reintentar envío
            </CocoaButton>
          ) : null}
        </>
      }
    >
      <div className="cocoa-stack" data-gap="4">
        {sub ? (
          <div className="cocoa-cluster">
            <CocoaBadge tone={statusTone(sub.status, isSimulated(sub))} variant="tinted">
              {submissionStatusLabel(sub.status)}
            </CocoaBadge>
            {isSimulated(sub) ? <CocoaBadge tone="warning">Simulado · no enviado</CocoaBadge> : null}
            {sub.submissionType ? <CocoaBadge tone="neutral">{sub.submissionType}</CocoaBadge> : null}
            {sub.territory ? <CocoaBadge tone="neutral">{sub.territory}</CocoaBadge> : null}
            {sub.signatureMode ? <CocoaBadge tone="neutral">XAdES {sub.signatureMode}</CocoaBadge> : null}
            <CocoaBadge tone="neutral">{plural(sub.attempts ?? 0, "intento", "intentos")}</CocoaBadge>
          </div>
        ) : null}

        <CocoaSegmentedControl
          value={view}
          onChange={(value) => setView(value as DetailView)}
          options={DETAIL_VIEWS}
          size="small"
          panelId={panelId}
          aria-label="Vistas del envío"
        />

        <div role="tabpanel" id={panelId} aria-label={DETAIL_VIEWS.find((v) => v.value === view)?.label}>
          {body}
        </div>

        {retryError ? (
          <CocoaCallout tone="danger" title="No se pudo reintentar el envío" role="alert">
            {retryError}
          </CocoaCallout>
        ) : null}

        <p className="cocoa-note">{pending ? "Se actualiza cada 8 s mientras el envío esté pendiente." : "Actualización manual."}</p>
      </div>
    </CocoaDrawer>
  );
}
