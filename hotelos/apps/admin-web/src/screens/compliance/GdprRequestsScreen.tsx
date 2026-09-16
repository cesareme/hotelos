// Protección de datos — Cumplimiento › Protección de datos
// (/cumplimiento/proteccion-datos, standalone). Cocoa 22 · ola 8 · lote 8-A,
// archetype «dashboard» (docs/design/COCOA-22.md §4, plantilla DashboardStandalone).
//
// GET /gdpr/requests feeds the KPI strip and the table; the form creates a
// request (POST /gdpr/requests) and a row opens a CocoaDrawer with the
// lifecycle, the fulfilment data (the dossier just generated or the stored
// fulfillmentMetadataJson, painted as a flat key/value list instead of the
// legacy DataPreview) and the actions: acknowledge, deliver the data (DSAR /
// portability), execute the erasure (with the RD 933/2021 retention override)
// and reject with a reason. Same endpoints, same toasts; the copy is Spanish.

import { useMemo, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { dateTime, number } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
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
  CocoaSkeleton,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

type GdprRequest = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  subjectType: string;
  subjectId: string | null;
  subjectEmail: string | null;
  requestType: string;
  status: string;
  requestedAt: string;
  acknowledgedAt: string | null;
  completedAt: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;
  requestorEmail: string;
  fulfillmentMetadataJson: Record<string, unknown> | null;
  dueAt: string | null;
  assigneeUserId: string | null;
};

const REQUEST_TYPES = ["dsar", "erasure", "rectification", "portability"] as const;
const REQUEST_TYPE_LABEL: Record<string, string> = {
  dsar: "Acceso (DSAR)",
  erasure: "Supresión",
  rectification: "Rectificación",
  portability: "Portabilidad"
};
const REQUEST_TYPE_OPTIONS = REQUEST_TYPES.map((type) => ({ value: type, label: REQUEST_TYPE_LABEL[type] }));

const STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  in_progress: "En curso",
  completed: "Completada",
  rejected: "Rechazada"
};

function statusTone(status: string): CocoaTone {
  switch (status) {
    case "completed":
      return "success";
    case "pending":
    case "in_progress":
      return "warning";
    case "rejected":
      return "danger";
    default:
      return "neutral";
  }
}

function requestTypeLabel(type: string): string {
  return REQUEST_TYPE_LABEL[type] ?? type.toUpperCase();
}

function fmtDate(iso: string | null | undefined): string {
  return dateTime(iso);
}

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function isOpen(r: GdprRequest): boolean {
  return r.status === "pending" || r.status === "in_progress";
}

function isOverdue(r: GdprRequest): boolean {
  return isOpen(r) && daysSince(r.requestedAt) > 30;
}

const COLUMNS: CocoaTableColumn<GdprRequest>[] = [
  { key: "requestedAt", label: "Solicitada", fit: true, render: (r) => fmtDate(r.requestedAt) },
  { key: "subject", label: "Interesado", minWidth: 180, render: (r) => r.subjectEmail ?? r.subjectId ?? "—" },
  { key: "requestType", label: "Tipo", fit: true, render: (r) => <CocoaBadge tone="neutral" size="small">{requestTypeLabel(r.requestType)}</CocoaBadge> },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (r) => (
      <span className="cocoa-cluster">
        <CocoaBadge tone={statusTone(r.status)}>{STATUS_LABEL[r.status] ?? r.status}</CocoaBadge>
        {isOverdue(r) ? <CocoaBadge tone="danger" size="small">fuera de plazo</CocoaBadge> : null}
      </span>
    )
  },
  { key: "dueAt", label: "Vence", fit: true, showFrom: "tablet", render: (r) => fmtDate(r.dueAt) }
];

// Value of a key/value row: semibold, right-aligned, breaks anywhere (ids, hashes, long values).
const kvValueStyle: CSSProperties = {
  minWidth: 0,
  textAlign: "right",
  wordBreak: "break-all",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"]
};

function scalarText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? STATUS_LABELS.yes : STATUS_LABELS.no;
  if (typeof value === "number") return number(value);
  return String(value);
}

/** Flattens the fulfilment payload into «clave · subclave» rows (four levels, 200 rows) so a nested dossier reads as a list. */
function flattenEntries(value: unknown, prefix: string, out: Array<[string, string]>, depth = 0): void {
  if (out.length >= 200) return;
  if (value !== null && typeof value === "object" && depth < 4) {
    const entries: Array<[string, unknown]> = Array.isArray(value)
      ? value.map((item, index) => [String(index + 1), item] as [string, unknown])
      : Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      out.push([prefix || "datos", "(vacío)"]);
      return;
    }
    for (const [key, item] of entries) flattenEntries(item, prefix ? `${prefix} · ${key}` : key, out, depth + 1);
    return;
  }
  out.push([prefix || "valor", typeof value === "object" && value !== null ? JSON.stringify(value) : scalarText(value)]);
}

function KeyValueList({ data, emptyMessage, label }: { data: Record<string, unknown> | null | undefined; emptyMessage: string; label: string }) {
  const rows = useMemo(() => {
    const out: Array<[string, string]> = [];
    if (data) flattenEntries(data, "", out);
    return out;
  }, [data]);
  if (rows.length === 0) return <CocoaState kind="empty" inline title={emptyMessage} />;
  return (
    <ul className="c22-section__list" aria-label={label}>
      {rows.map(([key, value]) => (
        <li key={key}>
          <span>{key}</span>
          <span style={kvValueStyle}>{value}</span>
        </li>
      ))}
    </ul>
  );
}

function GdprSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={3} />
      <CocoaSkeleton variant="card" height={180} />
      <CocoaSkeleton variant="card" height={280} />
    </div>
  );
}

export function GdprRequestsScreen() {
  const { showToast } = useToast();
  const { data, loading, error, refresh } = useApiData<GdprRequest[]>("/gdpr/requests");
  const requests = useMemo(() => toArray<GdprRequest>(data), [data]);

  // Form state for creating a new request.
  const [formRequestType, setFormRequestType] = useState<string>("dsar");
  const [formSubjectEmail, setFormSubjectEmail] = useState("");
  const [formRequestorEmail, setFormRequestorEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  // Per-row state.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmOverride, setConfirmOverride] = useState<Record<string, boolean>>({});
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [dossierByRequest, setDossierByRequest] = useState<Record<string, Record<string, unknown>>>({});

  const kpis = useMemo(() => {
    const now = Date.now();
    const totalPending = requests.filter(isOpen).length;
    const overdue = requests.filter(isOverdue).length;
    const completedLast30d = requests.filter(
      (r) =>
        r.status === "completed" &&
        r.completedAt &&
        now - new Date(r.completedAt).getTime() <= 30 * 24 * 60 * 60 * 1000
    ).length;
    return { totalPending, overdue, completedLast30d };
  }, [requests]);

  async function handleCreate() {
    setActionError(null);
    setActionMessage(null);
    if (!formSubjectEmail || !formRequestorEmail) {
      setActionError("El correo del interesado y el del solicitante son obligatorios.");
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest("/gdpr/requests", {
        method: "POST",
        body: {
          requestType: formRequestType,
          subjectEmail: formSubjectEmail,
          requestorEmail: formRequestorEmail
        }
      });
      setFormSubjectEmail("");
      setFormRequestorEmail("");
      setActionMessage("Solicitud creada.");
      showToast("Solicitud RGPD creada", { variant: "success" });
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionError(message);
      showToast(message, { variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAcknowledge(id: string) {
    setRunningAction(`ack-${id}`);
    setActionError(null);
    try {
      await apiRequest(`/gdpr/requests/${id}/acknowledge`, { method: "POST" });
      showToast("Solicitud reconocida", { variant: "success" });
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionError(message);
      showToast(message, { variant: "error" });
    } finally {
      setRunningAction(null);
    }
  }

  async function handleFulfillDsar(id: string) {
    setRunningAction(`dsar-${id}`);
    setActionError(null);
    try {
      const result = await apiRequest<{ request: GdprRequest; dossier: Record<string, unknown> }>(
        `/gdpr/requests/${id}/fulfill-dsar`,
        { method: "POST" }
      );
      setDossierByRequest((prev) => ({ ...prev, [id]: result.dossier }));
      setExpandedId(id);
      showToast("DSAR generado", { variant: "success" });
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionError(message);
      showToast(message, { variant: "error" });
    } finally {
      setRunningAction(null);
    }
  }

  async function handleExecuteErasure(id: string) {
    setRunningAction(`erase-${id}`);
    setActionError(null);
    try {
      const result = await apiRequest<{ request: GdprRequest; summary: Record<string, unknown> }>(
        `/gdpr/requests/${id}/execute-erasure`,
        {
          method: "POST",
          body: { confirmRetentionOverride: Boolean(confirmOverride[id]) }
        }
      );
      setDossierByRequest((prev) => ({ ...prev, [id]: result.summary }));
      setExpandedId(id);
      showToast("Borrado ejecutado", { variant: "success" });
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionError(message);
      showToast(message, { variant: "error" });
    } finally {
      setRunningAction(null);
    }
  }

  async function handleReject(id: string) {
    const reason = rejectReason[id]?.trim();
    if (!reason) {
      setActionError("Indica primero el motivo del rechazo.");
      return;
    }
    setRunningAction(`reject-${id}`);
    setActionError(null);
    try {
      await apiRequest(`/gdpr/requests/${id}/reject`, {
        method: "POST",
        body: { reason }
      });
      setRejectReason((prev) => ({ ...prev, [id]: "" }));
      showToast("Solicitud rechazada", { variant: "success" });
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionError(message);
      showToast(message, { variant: "error" });
    } finally {
      setRunningAction(null);
    }
  }

  const selected = expandedId ? requests.find((r) => r.id === expandedId) ?? null : null;
  const selectedOpen = selected ? isOpen(selected) : false;
  const ready = !error && requests.length > 0;

  return (
    <CocoaPage
      eyebrow="Cumplimiento"
      title="Protección de datos"
      subtitle="Solicitudes RGPD de los huéspedes: acceso, supresión, rectificación y portabilidad."
      actions={
        <>
          <CocoaBadge tone="neutral">Art. 15 / 17</CocoaBadge>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !data && !error ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<GdprSkeleton />}
      error={{ title: "No se pudieron cargar las solicitudes", message: error ?? undefined, onRetry: refresh }}
      commands={[
        { id: "gdpr-requests-create", label: "Crear una solicitud RGPD", run: () => void handleCreate() },
        { id: "gdpr-requests-refresh", label: "Actualizar las solicitudes RGPD", run: refresh }
      ]}
    >
      <CocoaCallout tone="info" title="Derechos del interesado">
        Gestiona solicitudes de acceso, derecho al olvido, rectificación y portabilidad bajo el RGPD. Los registros del libro de viajeros español se conservan tres años (RD 933/2021) salvo que se aplique una excepción de retención explícita.
      </CocoaCallout>

      <CocoaKpiStrip aria-label="Indicadores de solicitudes RGPD">
        <CocoaKpi label="Pendientes" value={number(kpis.totalPending)} caption="abiertas o en curso" polarity="neutral" status={kpis.totalPending > 0 ? "warning" : "ok"} degraded={Boolean(error)} />
        <CocoaKpi label="Fuera de plazo" value={number(kpis.overdue)} caption="más de 30 días sin cerrar" polarity="neutral" status={kpis.overdue > 0 ? "critical" : "ok"} degraded={Boolean(error)} />
        <CocoaKpi label="Completadas" value={number(kpis.completedLast30d)} caption="cerradas en los últimos 30 días" polarity="neutral" degraded={Boolean(error)} />
      </CocoaKpiStrip>

      <CocoaFormSection
        title="Nueva solicitud"
        description="Registra la solicitud de un interesado. El correo del solicitante identifica a quien la tramita (por ejemplo, el delegado de protección de datos)."
        actions={
          <CocoaButton variant="filled" tone="accent" size="small" disabled={submitting} loading={submitting} onClick={() => void handleCreate()}>
            {submitting ? "Creando…" : "Crear solicitud"}
          </CocoaButton>
        }
      >
        <CocoaFormRow columns={3}>
          <CocoaField label="Tipo de solicitud" required>
            <CocoaSelect value={formRequestType} onChange={setFormRequestType} options={REQUEST_TYPE_OPTIONS} disabled={submitting} />
          </CocoaField>
          <CocoaField label="Correo del interesado" required>
            <CocoaInput type="email" inputMode="email" value={formSubjectEmail} onChange={setFormSubjectEmail} placeholder="huesped@ejemplo.es" autoComplete="off" disabled={submitting} />
          </CocoaField>
          <CocoaField label="Correo del solicitante" required>
            <CocoaInput type="email" inputMode="email" value={formRequestorEmail} onChange={setFormRequestorEmail} placeholder="dpd@ejemplo.es" autoComplete="off" disabled={submitting} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      {actionMessage ? (
        <CocoaCallout tone="success" role="status" actions={<CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setActionMessage(null)}>{ACTIONS.close}</CocoaButton>}>
          {actionMessage}
        </CocoaCallout>
      ) : null}
      {actionError ? (
        <CocoaCallout tone="danger" role="alert" title="No se pudo completar la acción" actions={<CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setActionError(null)}>{ACTIONS.close}</CocoaButton>}>
          {actionError}
        </CocoaCallout>
      ) : null}

      <CocoaSection
        title="Solicitudes"
        meta={ready ? `${number(requests.length)} en total` : undefined}
        padding={ready || (loading && requests.length === 0) ? "none" : "md"}
        style={{ overflow: "clip" }}
      >
        {error ? (
          <CocoaState kind="error" title="No se pudieron cargar las solicitudes" message={error} onRetry={refresh} />
        ) : loading && requests.length === 0 ? (
          <CocoaTable columns={COLUMNS} rows={[]} loading caption="Solicitudes RGPD" aria-label="Solicitudes RGPD" />
        ) : requests.length === 0 ? (
          <CocoaState kind="empty" illustration="box" title="Sin solicitudes RGPD" message="Todavía no hay solicitudes RGPD. Registra la primera con el formulario." />
        ) : (
          <CocoaTable
            columns={COLUMNS}
            rows={requests}
            rowKey="id"
            selectedKey={expandedId ?? undefined}
            onSelect={(r) => setExpandedId(r.id)}
            rowTone={(r) => (isOverdue(r) ? "danger" : undefined)}
            rowTitle={() => "Abrir el detalle de la solicitud"}
            rowActions={(r) => (
              <CocoaButton variant="plain" size="small" onClick={(event) => { event.stopPropagation(); setExpandedId(r.id); }} aria-expanded={expandedId === r.id}>
                {ACTIONS.viewDetail}
              </CocoaButton>
            )}
            caption="Solicitudes RGPD"
            aria-label="Solicitudes RGPD"
          />
        )}
      </CocoaSection>

      <CocoaDrawer
        open={selected !== null}
        onClose={() => setExpandedId(null)}
        title={selected ? `Solicitud ${selected.id}` : "Solicitud"}
        subtitle={selected ? `${requestTypeLabel(selected.requestType)} · ${STATUS_LABEL[selected.status] ?? selected.status}` : undefined}
        side="right"
        size="md"
        focusKey={selected?.id}
        footer={
          <CocoaButton variant="bordered" tone="neutral" onClick={() => setExpandedId(null)}>
            {ACTIONS.close}
          </CocoaButton>
        }
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="4">
            <div className="cocoa-cluster">
              <CocoaBadge tone={statusTone(selected.status)}>{STATUS_LABEL[selected.status] ?? selected.status}</CocoaBadge>
              <CocoaBadge tone="neutral" size="small">{requestTypeLabel(selected.requestType)}</CocoaBadge>
              {isOverdue(selected) ? <CocoaBadge tone="danger" size="small">fuera de plazo</CocoaBadge> : null}
            </div>

            <CocoaSection title="Ciclo de vida">
              <ul className="c22-section__list" aria-label="Ciclo de vida de la solicitud">
                <li>
                  <span>Interesado</span>
                  <span style={kvValueStyle}>{selected.subjectEmail ?? selected.subjectId ?? "—"}</span>
                </li>
                <li>
                  <span>Solicitante</span>
                  <span style={kvValueStyle}>{selected.requestorEmail}</span>
                </li>
                <li>
                  <span>Solicitada</span>
                  <strong>{fmtDate(selected.requestedAt)}</strong>
                </li>
                <li>
                  <span>Reconocida</span>
                  <strong>{fmtDate(selected.acknowledgedAt)}</strong>
                </li>
                <li>
                  <span>Vence</span>
                  <strong>{fmtDate(selected.dueAt)}</strong>
                </li>
                <li>
                  <span>Completada</span>
                  <strong>{fmtDate(selected.completedAt)}</strong>
                </li>
                <li>
                  <span>Rechazada</span>
                  <strong>{fmtDate(selected.rejectedAt)}</strong>
                </li>
                {selected.rejectedReason ? (
                  <li>
                    <span>Motivo del rechazo</span>
                    <span style={kvValueStyle}>{selected.rejectedReason}</span>
                  </li>
                ) : null}
              </ul>
            </CocoaSection>

            <CocoaSection title="Datos del cumplimiento">
              <KeyValueList data={dossierByRequest[selected.id] ?? selected.fulfillmentMetadataJson} emptyMessage="Sin datos de cumplimiento todavía." label="Datos del cumplimiento" />
            </CocoaSection>

            {selectedOpen ? (
              <CocoaSection title="Acciones">
                <div className="cocoa-row" data-gap="2">
                  {selected.status === "pending" ? (
                    <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void handleAcknowledge(selected.id)} disabled={runningAction === `ack-${selected.id}`} loading={runningAction === `ack-${selected.id}`}>
                      {runningAction === `ack-${selected.id}` ? "Reconociendo…" : "Reconocer"}
                    </CocoaButton>
                  ) : null}
                  {selected.requestType === "dsar" || selected.requestType === "portability" ? (
                    <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void handleFulfillDsar(selected.id)} disabled={runningAction === `dsar-${selected.id}`} loading={runningAction === `dsar-${selected.id}`}>
                      {runningAction === `dsar-${selected.id}` ? "Generando…" : "Entregar datos (acceso)"}
                    </CocoaButton>
                  ) : null}
                </div>

                {selected.requestType === "erasure" ? (
                  <CocoaFormRow columns={1}>
                    <CocoaField label="Excepción de retención del RD 933/2021" inline help="Solo para registros de más de 3 años: confirma que el libro de viajeros ya no obliga a conservarlos.">
                      <CocoaSwitch
                        checked={Boolean(confirmOverride[selected.id])}
                        onChange={(checked) => setConfirmOverride((prev) => ({ ...prev, [selected.id]: checked }))}
                        size="small"
                      />
                    </CocoaField>
                    <CocoaButton variant="filled" tone="destructive" size="small" onClick={() => void handleExecuteErasure(selected.id)} disabled={runningAction === `erase-${selected.id}`} loading={runningAction === `erase-${selected.id}`}>
                      {runningAction === `erase-${selected.id}` ? "Borrando…" : "Ejecutar el borrado"}
                    </CocoaButton>
                  </CocoaFormRow>
                ) : null}

                <CocoaFormRow columns={1}>
                  <CocoaField label="Motivo del rechazo" help="Obligatorio para rechazar la solicitud; el interesado lo recibe tal cual.">
                    <CocoaInput
                      value={rejectReason[selected.id] ?? ""}
                      onChange={(value) => setRejectReason((prev) => ({ ...prev, [selected.id]: value }))}
                      placeholder="Motivo del rechazo"
                    />
                  </CocoaField>
                  <CocoaButton variant="bordered" tone="destructive" size="small" onClick={() => void handleReject(selected.id)} disabled={runningAction === `reject-${selected.id}`} loading={runningAction === `reject-${selected.id}`}>
                    {runningAction === `reject-${selected.id}` ? "Rechazando…" : ACTIONS.reject}
                  </CocoaButton>
                </CocoaFormRow>
              </CocoaSection>
            ) : null}
          </div>
        ) : null}
      </CocoaDrawer>
    </CocoaPage>
  );
}
