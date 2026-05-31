import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { DataPreview } from "../../components/forms/FormComponents";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";

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

function statusClass(status: string): "ok" | "warn" | "error" | "" {
  switch (status) {
    case "completed":
      return "ok";
    case "pending":
    case "in_progress":
      return "warn";
    case "rejected":
      return "error";
    default:
      return "";
  }
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-ES");
}

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
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
    const totalPending = requests.filter((r) => r.status === "pending" || r.status === "in_progress").length;
    const overdue = requests.filter(
      (r) => (r.status === "pending" || r.status === "in_progress") && daysSince(r.requestedAt) > 30
    ).length;
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
      setActionError("Subject email and requestor email are required.");
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
      setActionMessage("Request created.");
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
      setActionError("Enter a rejection reason first.");
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

  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Privacidad y cumplimiento</p>
          <h2>Solicitudes RGPD del interesado</h2>
        </div>
        <span className="bo-chip">Art. 15 / 17</span>
      </div>
      <p>
        Gestiona solicitudes de acceso, derecho al olvido, rectificación y portabilidad bajo el RGPD.
        Los registros del libro de viajeros español se conservan tres años (RD 933/2021) salvo que se
        aplique una excepción de retención explícita.
      </p>

      <div className="bo-grid three">
        <article className="bo-card">
          <h3>Pending</h3>
          <div className="bo-metric">{kpis.totalPending}</div>
          <p>Open or in-progress requests.</p>
        </article>
        <article className="bo-card">
          <h3>Overdue</h3>
          <div className="bo-metric">{kpis.overdue}</div>
          <p>Past the 30-day GDPR response window.</p>
        </article>
        <article className="bo-card">
          <h3>Completed (30d)</h3>
          <div className="bo-metric">{kpis.completedLast30d}</div>
          <p>Closed in the last 30 days.</p>
        </article>
      </div>

      <section className="bo-card">
        <h3>New request</h3>
        <div className="bo-grid two">
          <label className="bo-form-field">
            <span>Request type</span>
            <select
              aria-label="Request type"
              value={formRequestType}
              onChange={(event) => setFormRequestType(event.currentTarget.value)}
            >
              {REQUEST_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <label className="bo-form-field">
            <span>Subject email</span>
            <input
              aria-label="Subject email"
              type="email"
              value={formSubjectEmail}
              onChange={(event) => setFormSubjectEmail(event.currentTarget.value)}
              placeholder="guest@example.com"
            />
          </label>
          <label className="bo-form-field">
            <span>Requestor email</span>
            <input
              aria-label="Requestor email"
              type="email"
              value={formRequestorEmail}
              onChange={(event) => setFormRequestorEmail(event.currentTarget.value)}
              placeholder="dpo@example.com"
            />
          </label>
        </div>
        <div className="bo-actions">
          <button className="primary" type="button" disabled={submitting} onClick={handleCreate}>
            {submitting ? "Creating..." : "Create request"}
          </button>
          {actionMessage ? <span className="bo-status ok">{actionMessage}</span> : null}
          {actionError ? <span className="bo-status error">{actionError}</span> : null}
        </div>
      </section>

      <section className="bo-card">
        <h3>Requests</h3>
        {loading ? <p className="bo-muted">Loading...</p> : null}
        {error ? <p className="bo-status error">{error}</p> : null}
        {!loading && requests.length === 0 ? <p className="bo-muted">No GDPR requests yet.</p> : null}
        {requests.length > 0 ? (
          <table className="bo-table">
            <thead>
              <tr>
                <th>Requested</th>
                <th>Subject</th>
                <th>Type</th>
                <th>Status</th>
                <th>Due</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => {
                const overdue =
                  (r.status === "pending" || r.status === "in_progress") && daysSince(r.requestedAt) > 30;
                const isExpanded = expandedId === r.id;
                return (
                  <>
                    <tr key={r.id}>
                      <td>{fmtDate(r.requestedAt)}</td>
                      <td>{r.subjectEmail ?? r.subjectId ?? "—"}</td>
                      <td>{r.requestType.toUpperCase()}</td>
                      <td>
                        <span className={`bo-status ${statusClass(r.status)}`}>{r.status}</span>
                        {overdue ? <span className="bo-status error"> overdue</span> : null}
                      </td>
                      <td>{fmtDate(r.dueAt)}</td>
                      <td>
                        <button
                          type="button"
                          onClick={() => setExpandedId(isExpanded ? null : r.id)}
                          aria-expanded={isExpanded}
                        >
                          {isExpanded ? "Hide" : "Details"}
                        </button>
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr key={`${r.id}-details`}>
                        <td colSpan={6}>
                          <div className="bo-card">
                            <h4>Request {r.id}</h4>
                            <div className="bo-grid two">
                              <div>
                                <p>
                                  <strong>Requestor:</strong> {r.requestorEmail}
                                </p>
                                <p>
                                  <strong>Acknowledged:</strong> {fmtDate(r.acknowledgedAt)}
                                </p>
                                <p>
                                  <strong>Completed:</strong> {fmtDate(r.completedAt)}
                                </p>
                                <p>
                                  <strong>Rejected:</strong> {fmtDate(r.rejectedAt)}
                                </p>
                                {r.rejectedReason ? (
                                  <p>
                                    <strong>Rejection reason:</strong> {r.rejectedReason}
                                  </p>
                                ) : null}
                              </div>
                              <div>
                                <h5>Fulfillment metadata</h5>
                                <DataPreview
                                  data={
                                    (dossierByRequest[r.id] ?? r.fulfillmentMetadataJson) as
                                      | Record<string, unknown>
                                      | null
                                  }
                                  emptyMessage="No fulfillment data yet."
                                />
                              </div>
                            </div>
                            <div className="bo-actions">
                              {r.status === "pending" ? (
                                <button
                                  type="button"
                                  onClick={() => handleAcknowledge(r.id)}
                                  disabled={runningAction === `ack-${r.id}`}
                                >
                                  {runningAction === `ack-${r.id}` ? "Acknowledging..." : "Acknowledge"}
                                </button>
                              ) : null}
                              {(r.requestType === "dsar" || r.requestType === "portability") &&
                              r.status !== "completed" &&
                              r.status !== "rejected" ? (
                                <button
                                  type="button"
                                  className="primary"
                                  onClick={() => handleFulfillDsar(r.id)}
                                  disabled={runningAction === `dsar-${r.id}`}
                                >
                                  {runningAction === `dsar-${r.id}` ? "Fulfilling..." : "Fulfill (DSAR)"}
                                </button>
                              ) : null}
                              {r.requestType === "erasure" &&
                              r.status !== "completed" &&
                              r.status !== "rejected" ? (
                                <>
                                  <label className="bo-form-field">
                                    <span>
                                      <input
                                        aria-label="Confirm retention override"
                                        type="checkbox"
                                        checked={Boolean(confirmOverride[r.id])}
                                        onChange={(event) =>
                                          setConfirmOverride((prev) => ({
                                            ...prev,
                                            [r.id]: event.currentTarget.checked
                                          }))
                                        }
                                      />
                                      &nbsp;Override RD 933/2021 retention (only for records older than 3
                                      years)
                                    </span>
                                  </label>
                                  <button
                                    type="button"
                                    className="primary"
                                    onClick={() => handleExecuteErasure(r.id)}
                                    disabled={runningAction === `erase-${r.id}`}
                                  >
                                    {runningAction === `erase-${r.id}` ? "Erasing..." : "Execute erasure"}
                                  </button>
                                </>
                              ) : null}
                              {r.status !== "completed" && r.status !== "rejected" ? (
                                <>
                                  <input
                                    aria-label="Rejection reason"
                                    placeholder="Rejection reason"
                                    value={rejectReason[r.id] ?? ""}
                                    onChange={(event) =>
                                      setRejectReason((prev) => ({
                                        ...prev,
                                        [r.id]: event.currentTarget.value
                                      }))
                                    }
                                  />
                                  <button
                                    type="button"
                                    onClick={() => handleReject(r.id)}
                                    disabled={runningAction === `reject-${r.id}`}
                                  >
                                    {runningAction === `reject-${r.id}` ? "Rejecting..." : "Reject"}
                                  </button>
                                </>
                              ) : null}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </section>
    </section>
  );
}
