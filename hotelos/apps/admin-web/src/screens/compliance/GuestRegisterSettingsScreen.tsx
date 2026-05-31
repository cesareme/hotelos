import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ErrorState, LoadingBlock, Spinner } from "../../components/States";
import { getActivePropertyId } from "../../services/activeProperty";
import {
  createSpainGuestRegisterRecord,
  listPropertyGuestRegisterRecords,
  queueSpainGuestRegisterSubmission,
  validateSpainGuestRegisterForm,
  type FormValidationErrors,
  type GuestRegisterRecord,
  type GuestRegisterStatus,
  type SpainGuestRegisterInput
} from "../../services/guestRegisterApi";

const PROPERTY_ID = getActivePropertyId();

const STATUS_TONE: Record<GuestRegisterStatus, "ok" | "warn" | "error" | "info"> = {
  draft: "info",
  missing_data: "warn",
  ready_to_sign: "info",
  signed: "info",
  ready_to_submit: "info",
  queued: "info",
  exported: "info",
  submitted: "info",
  accepted: "ok",
  rejected: "error",
  failed: "error",
  annulled: "warn",
  corrected: "warn",
  expired: "warn"
};

type FormState = {
  reservationId: string;
  firstName: string;
  surname1: string;
  surname2: string;
  documentType: "DNI" | "PASSPORT" | "TIE";
  documentNumber: string;
  documentSupportNumber: string;
  nationality: string;
  dateOfBirth: string;
  residenceFullAddress: string;
  residenceLocality: string;
  residenceCountry: string;
  phoneMobile: string;
  email: string;
  travellerCount: string;
  contractReference: string;
  checkinAt: string;
  checkoutAt: string;
};

const EMPTY_FORM: FormState = {
  reservationId: "",
  firstName: "",
  surname1: "",
  surname2: "",
  documentType: "DNI",
  documentNumber: "",
  documentSupportNumber: "",
  nationality: "ES",
  dateOfBirth: "",
  residenceFullAddress: "",
  residenceLocality: "",
  residenceCountry: "ES",
  phoneMobile: "",
  email: "",
  travellerCount: "1",
  contractReference: "",
  checkinAt: "",
  checkoutAt: ""
};

type SubmissionState =
  | { kind: "idle" }
  | { kind: "submitting"; phase: "create" | "queue" }
  | { kind: "success"; recordId: string; submissionId?: string; message: string }
  | { kind: "error"; message: string };

function nav(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

function formToInput(form: FormState): SpainGuestRegisterInput {
  // Cast through unknown — Zod will validate the actual shape.
  return {
    firstName: form.firstName.trim(),
    surname1: form.surname1.trim(),
    surname2: form.surname2.trim() || undefined,
    documentType: form.documentType,
    documentNumber: form.documentNumber.trim(),
    documentSupportNumber: form.documentSupportNumber.trim() || undefined,
    nationality: form.nationality.trim().toUpperCase(),
    dateOfBirth: form.dateOfBirth,
    residenceFullAddress: form.residenceFullAddress.trim(),
    residenceLocality: form.residenceLocality.trim(),
    residenceCountry: form.residenceCountry.trim().toUpperCase(),
    phoneMobile: form.phoneMobile.trim() || undefined,
    email: form.email.trim() || undefined,
    travellerCount: Number(form.travellerCount) || 1,
    contractReference: form.contractReference.trim(),
    checkinAt: form.checkinAt || undefined,
    checkoutAt: form.checkoutAt || undefined,
    recordType: "checkin"
  };
}

export function GuestRegisterSettingsScreen() {
  const [records, setRecords] = useState<GuestRegisterRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<FormValidationErrors>({});
  const [submission, setSubmission] = useState<SubmissionState>({ kind: "idle" });

  function load() {
    setLoading(true);
    setLoadError(null);
    listPropertyGuestRegisterRecords(PROPERTY_ID)
      .then((rows) => setRecords(rows))
      .catch((err) =>
        setLoadError(err instanceof Error ? err.message : "No se pudieron cargar los registros.")
      )
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((cur) => ({ ...cur, [key]: value }));
    if (fieldErrors[key as keyof SpainGuestRegisterInput]) {
      setFieldErrors((cur) => {
        const next = { ...cur };
        delete next[key as keyof SpainGuestRegisterInput];
        return next;
      });
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmission({ kind: "idle" });
    setFieldErrors({});

    if (!form.reservationId.trim()) {
      setSubmission({ kind: "error", message: "Reservation ID is required." });
      return;
    }

    const input = formToInput(form);
    const validation = validateSpainGuestRegisterForm(input);
    if (!validation.ok) {
      setFieldErrors(validation.errors);
      setSubmission({
        kind: "error",
        message: "Some required fields are missing or invalid. Please review the form."
      });
      return;
    }

    try {
      setSubmission({ kind: "submitting", phase: "create" });
      const record = await createSpainGuestRegisterRecord({
        reservationId: form.reservationId.trim(),
        propertyId: PROPERTY_ID,
        input: validation.data,
        retry: { retries: 2, baseDelayMs: 400 }
      });

      // Queue authority submission (SES.HOSPEDAJES) after a successful create.
      setSubmission({ kind: "submitting", phase: "queue" });
      let submissionId: string | undefined;
      let queueMessage = "Record created.";
      try {
        const queued = await queueSpainGuestRegisterSubmission(record.id, "checkin", {
          retries: 2,
          baseDelayMs: 400
        });
        submissionId = queued.id;
        queueMessage = `Record created and authority submission queued (${queued.status}).`;
      } catch (queueErr) {
        queueMessage = `Record created. Authority submission could not be queued: ${
          queueErr instanceof Error ? queueErr.message : "unknown error"
        }. Use Retry from the Compliance Inbox.`;
      }

      setSubmission({
        kind: "success",
        recordId: record.id,
        submissionId,
        message: queueMessage
      });
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      setSubmission({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not create the guest register record."
      });
    }
  }

  async function handleRetryQueue(recordId: string) {
    setSubmission({ kind: "submitting", phase: "queue" });
    try {
      const queued = await queueSpainGuestRegisterSubmission(recordId, "checkin", {
        retries: 2,
        baseDelayMs: 400
      });
      setSubmission({
        kind: "success",
        recordId,
        submissionId: queued.id,
        message: `Authority submission queued (${queued.status}).`
      });
      load();
    } catch (err) {
      setSubmission({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not queue the authority submission."
      });
    }
  }

  const counts = useMemo(() => {
    const acc: Partial<Record<GuestRegisterStatus, number>> = {};
    for (const r of records) {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
    }
    return acc;
  }, [records]);

  const busy = submission.kind === "submitting";
  const submittingLabel =
    submission.kind === "submitting"
      ? submission.phase === "create"
        ? "Creating record…"
        : "Queueing authority submission…"
      : "";

  if (loading) {
    return (
      <section className="bo-card">
        <LoadingBlock label="Loading guest register…" />
      </section>
    );
  }
  if (loadError) {
    return (
      <section className="bo-card">
        <ErrorState message={loadError} onRetry={load} />
      </section>
    );
  }

  return (
    <>
      <section className="bo-card">
        <div className="bo-card-head" style={{ marginBottom: "var(--space-2)" }}>
          <div>
            <p className="bo-page-eyebrow">Spain compliance</p>
            <h2 className="bo-page-title" style={{ fontSize: "var(--fs-2xl)" }}>
              Guest Register (parte de entrada)
            </h2>
          </div>
          <span className="bo-status info">{records.length} records</span>
        </div>
        <p className="bo-page-subtitle" style={{ marginTop: 0 }}>
          Capture the RD 933/2021 traveller register and queue submissions to SES.HOSPEDAJES. Required identity,
          residence, contract and contact fields are validated client-side before the record is created.
        </p>

        <div className="rev-kpi-grid" style={{ marginTop: "var(--space-4)" }}>
          <div className="rev-kpi rev-kpi-ok">
            <span className="rev-kpi-label">Accepted</span>
            <span className="rev-kpi-value">{counts.accepted ?? 0}</span>
          </div>
          <div className="rev-kpi rev-kpi-warn">
            <span className="rev-kpi-label">Missing data</span>
            <span className="rev-kpi-value">{counts.missing_data ?? 0}</span>
          </div>
          <div className="rev-kpi">
            <span className="rev-kpi-label">Queued</span>
            <span className="rev-kpi-value">{counts.queued ?? 0}</span>
          </div>
          <div
            className={`rev-kpi ${
              (counts.rejected ?? 0) + (counts.failed ?? 0) ? "rev-kpi-error" : "rev-kpi-ok"
            }`}
          >
            <span className="rev-kpi-label">Rejected / failed</span>
            <span className="rev-kpi-value">{(counts.rejected ?? 0) + (counts.failed ?? 0)}</span>
          </div>
        </div>

        <div className="bo-actions" style={{ marginTop: "var(--space-4)" }}>
          <button type="button" onClick={() => nav("SesHospedajesSettings")}>SES.HOSPEDAJES connector</button>
          <button type="button" onClick={() => nav("ComplianceInbox")}>Open Compliance Inbox</button>
          <button type="button" onClick={load} disabled={busy}>Refresh</button>
        </div>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">New register entry</p>
            <h3 style={{ margin: 0 }}>Create parte de entrada</h3>
          </div>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div className="bo-grid three">
            <label className="bo-form-field">
              <span>Reservation ID <strong>required</strong></span>
              <input
                value={form.reservationId}
                onChange={(e) => set("reservationId", e.target.value)}
                placeholder="res_..."
                disabled={busy}
              />
            </label>
            <label className="bo-form-field">
              <span>First name <strong>required</strong></span>
              <input value={form.firstName} onChange={(e) => set("firstName", e.target.value)} disabled={busy} />
              {fieldErrors.firstName ? <small className="bo-field-error">{fieldErrors.firstName}</small> : null}
            </label>
            <label className="bo-form-field">
              <span>Surname 1 <strong>required</strong></span>
              <input value={form.surname1} onChange={(e) => set("surname1", e.target.value)} disabled={busy} />
              {fieldErrors.surname1 ? <small className="bo-field-error">{fieldErrors.surname1}</small> : null}
            </label>
            <label className="bo-form-field">
              <span>Surname 2</span>
              <input value={form.surname2} onChange={(e) => set("surname2", e.target.value)} disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Document type <strong>required</strong></span>
              <select
                value={form.documentType}
                onChange={(e) => set("documentType", e.target.value as FormState["documentType"])}
                disabled={busy}
              >
                <option value="DNI">DNI</option>
                <option value="PASSPORT">Passport</option>
                <option value="TIE">TIE</option>
              </select>
            </label>
            <label className="bo-form-field">
              <span>Document number <strong>required</strong></span>
              <input value={form.documentNumber} onChange={(e) => set("documentNumber", e.target.value)} disabled={busy} />
              {fieldErrors.documentNumber ? (
                <small className="bo-field-error">{fieldErrors.documentNumber}</small>
              ) : null}
            </label>
            <label className="bo-form-field">
              <span>Support number (DNI/TIE)</span>
              <input
                value={form.documentSupportNumber}
                onChange={(e) => set("documentSupportNumber", e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="bo-form-field">
              <span>Nationality <strong>required</strong></span>
              <input
                value={form.nationality}
                onChange={(e) => set("nationality", e.target.value)}
                placeholder="ES"
                maxLength={2}
                disabled={busy}
              />
              {fieldErrors.nationality ? (
                <small className="bo-field-error">{fieldErrors.nationality}</small>
              ) : null}
            </label>
            <label className="bo-form-field">
              <span>Date of birth <strong>required</strong></span>
              <input
                type="date"
                value={form.dateOfBirth}
                onChange={(e) => set("dateOfBirth", e.target.value)}
                disabled={busy}
              />
              {fieldErrors.dateOfBirth ? <small className="bo-field-error">{fieldErrors.dateOfBirth}</small> : null}
            </label>
          </div>

          <div className="bo-grid three" style={{ marginTop: "var(--space-2)" }}>
            <label className="bo-form-field" style={{ gridColumn: "span 2" }}>
              <span>Residence address <strong>required</strong></span>
              <input
                value={form.residenceFullAddress}
                onChange={(e) => set("residenceFullAddress", e.target.value)}
                disabled={busy}
              />
              {fieldErrors.residenceFullAddress ? (
                <small className="bo-field-error">{fieldErrors.residenceFullAddress}</small>
              ) : null}
            </label>
            <label className="bo-form-field">
              <span>Locality <strong>required</strong></span>
              <input
                value={form.residenceLocality}
                onChange={(e) => set("residenceLocality", e.target.value)}
                disabled={busy}
              />
              {fieldErrors.residenceLocality ? (
                <small className="bo-field-error">{fieldErrors.residenceLocality}</small>
              ) : null}
            </label>
            <label className="bo-form-field">
              <span>Country <strong>required</strong></span>
              <input
                value={form.residenceCountry}
                onChange={(e) => set("residenceCountry", e.target.value)}
                placeholder="ES"
                maxLength={2}
                disabled={busy}
              />
              {fieldErrors.residenceCountry ? (
                <small className="bo-field-error">{fieldErrors.residenceCountry}</small>
              ) : null}
            </label>
            <label className="bo-form-field">
              <span>Mobile phone</span>
              <input value={form.phoneMobile} onChange={(e) => set("phoneMobile", e.target.value)} disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Email</span>
              <input
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                disabled={busy}
              />
              {fieldErrors.email ? <small className="bo-field-error">{fieldErrors.email}</small> : null}
            </label>
          </div>

          <div className="bo-grid three" style={{ marginTop: "var(--space-2)" }}>
            <label className="bo-form-field">
              <span>Traveller count <strong>required</strong></span>
              <input
                type="number"
                min={1}
                value={form.travellerCount}
                onChange={(e) => set("travellerCount", e.target.value)}
                disabled={busy}
              />
              {fieldErrors.travellerCount ? (
                <small className="bo-field-error">{fieldErrors.travellerCount}</small>
              ) : null}
            </label>
            <label className="bo-form-field">
              <span>Contract reference <strong>required</strong></span>
              <input
                value={form.contractReference}
                onChange={(e) => set("contractReference", e.target.value)}
                disabled={busy}
              />
              {fieldErrors.contractReference ? (
                <small className="bo-field-error">{fieldErrors.contractReference}</small>
              ) : null}
            </label>
            <label className="bo-form-field">
              <span>Check-in</span>
              <input
                type="datetime-local"
                value={form.checkinAt}
                onChange={(e) => set("checkinAt", e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="bo-form-field">
              <span>Check-out</span>
              <input
                type="datetime-local"
                value={form.checkoutAt}
                onChange={(e) => set("checkoutAt", e.target.value)}
                disabled={busy}
              />
            </label>
          </div>

          <div className="bo-actions" style={{ marginTop: "var(--space-4)" }}>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? (
                <>
                  <Spinner size="sm" /> {submittingLabel}
                </>
              ) : (
                "Create and queue submission"
              )}
            </button>
            <button type="button" onClick={() => setForm(EMPTY_FORM)} disabled={busy}>
              Reset
            </button>
          </div>

          {submission.kind === "error" ? (
            <p
              className="bo-status error"
              style={{ marginTop: "var(--space-3)", display: "inline-flex", textTransform: "none", letterSpacing: 0 }}
              role="alert"
            >
              {submission.message}
            </p>
          ) : null}
          {submission.kind === "success" ? (
            <p
              className="bo-status ok"
              style={{ marginTop: "var(--space-3)", display: "inline-flex", textTransform: "none", letterSpacing: 0 }}
            >
              {submission.message}
              {submission.submissionId ? ` (submission ${submission.submissionId})` : ""}
            </p>
          ) : null}
        </form>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Submission queue</p>
            <h3 style={{ margin: 0 }}>Guest register records</h3>
          </div>
        </div>
        {records.length === 0 ? (
          <p className="bo-muted">No guest register records yet for this property.</p>
        ) : (
          <div className="bo-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Guest</th>
                  <th>Document</th>
                  <th>Status</th>
                  <th>Reservation</th>
                  <th>Created</th>
                  <th>Retention until</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {records.slice(0, 50).map((r) => {
                  const tone = STATUS_TONE[r.status] ?? "info";
                  const canRetryQueue = r.status === "failed" || r.status === "rejected" || r.status === "missing_data";
                  return (
                    <tr key={r.id}>
                      <td>
                        {[r.firstName, r.surname1, r.surname2].filter(Boolean).join(" ") || "—"}
                      </td>
                      <td>{r.documentType ? `${r.documentType} ${r.documentNumber ?? ""}` : "—"}</td>
                      <td>
                        <span className={`bo-status ${tone}`}>{r.status.replace(/_/g, " ")}</span>
                      </td>
                      <td>{r.reservationId}</td>
                      <td>{new Date(r.createdAt).toLocaleString("es-ES")}</td>
                      <td>
                        {r.retentionUntil ? new Date(r.retentionUntil).toLocaleDateString("es-ES") : "—"}
                      </td>
                      <td>
                        {canRetryQueue ? (
                          <button type="button" onClick={() => handleRetryQueue(r.id)} disabled={busy}>
                            Retry queue
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
