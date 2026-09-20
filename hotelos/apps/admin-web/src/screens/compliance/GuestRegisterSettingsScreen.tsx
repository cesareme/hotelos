// Partes de entrada — Cumplimiento › Registro de viajeros
// (/cumplimiento/registro-viajeros, base tab of RegistroViajerosTabs; the legacy
// key still opens it standalone). Cocoa 22 · ola 8 · lote 8-A, archetype
// «dashboard» (docs/design/COCOA-22.md §4, plantilla DashboardAlojado).
//
// Real form over the Spain guest register (RD 933/2021): the KPI strip counts
// the records of the property, the form validates identity, residence,
// contract and contact with `validateSpainGuestRegisterForm` (Zod) before
// creating the record and queueing its SES.Hospedajes submission, and the
// table lists the last 50 records with the pipeline retry per row. Same
// calls, same validation and same outcomes as the legacy screen; the copy is
// now Spanish (browser-roles#13) and the paint uses the primitives.

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { date, dateTime, number, plural } from "../../lib/format";
import { navigateTo } from "../../lib/navigate";
import { ACTIONS } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
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
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
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
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

// The queue keeps the last 50 records on screen (the API returns the whole property).
const VISIBLE_RECORDS = 50;

const STATUS_LABEL: Record<GuestRegisterStatus, string> = {
  draft: "Borrador",
  missing_data: "Datos incompletos",
  ready_to_sign: "Listo para firmar",
  signed: "Firmado",
  ready_to_submit: "Listo para enviar",
  queued: "En cola",
  exported: "Exportado",
  submitted: "Enviado",
  accepted: "Aceptado",
  rejected: "Rechazado",
  failed: "Fallido",
  annulled: "Anulado",
  corrected: "Corregido",
  expired: "Caducado"
};

const STATUS_TONE: Record<GuestRegisterStatus, CocoaTone> = {
  draft: "neutral",
  missing_data: "warning",
  ready_to_sign: "info",
  signed: "info",
  ready_to_submit: "info",
  queued: "info",
  exported: "info",
  submitted: "info",
  accepted: "success",
  rejected: "danger",
  failed: "danger",
  annulled: "warning",
  corrected: "warning",
  expired: "warning"
};

// Status of the authority submission the queue answers with.
const SUBMISSION_STATUS_LABEL: Record<string, string> = {
  queued: "en cola",
  sent: "enviado",
  accepted: "aceptado",
  rejected: "rechazado",
  failed: "fallido",
  annulled: "anulado"
};

const DOCUMENT_TYPE_OPTIONS = [
  { value: "DNI", label: "DNI" },
  { value: "PASSPORT", label: "Pasaporte" },
  { value: "TIE", label: "TIE" }
];

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

// Field errors of the form: the Zod issues of the RD 933/2021 input plus the
// reservation, which travels outside that input (`createSpainGuestRegisterRecord`
// takes it apart) but is a required field of the same form.
type FieldErrors = FormValidationErrors & { reservationId?: string };

type SubmissionState =
  | { kind: "idle" }
  | { kind: "submitting"; phase: "create" | "queue" }
  | { kind: "success"; recordId: string; submissionId?: string; message: string }
  | { kind: "error"; message: string };

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

function canRetryQueue(record: GuestRegisterRecord): boolean {
  return record.status === "failed" || record.status === "rejected" || record.status === "missing_data";
}

// Widths measured at 1440 (wrapper 1150 px, qa#1 8-A): «Documento» is capped
// at 160 px — the API returns the stored number as is and one record carried
// an 83-character token that widened the column to 667 px (table 1610 px);
// a real «PASSPORT AB1234567» measures ≈ 130 px and the tooltip keeps the
// full value. The reservation column (the RES-… code the API resolves, or the
// cuid — 216 px, not truncated: a cuid differs by its tail — when a record has
// no code; FIX-1 · F9), the creation time and the retention date wait for the
// desktop tier, so a 1024 laptop (wrapper 734 px) keeps guest · document ·
// status · actions (≈ 643 px) without a horizontal scroller.
const COLUMNS: CocoaTableColumn<GuestRegisterRecord>[] = [
  { key: "guest", label: "Huésped", minWidth: 180, render: (r) => [r.firstName, r.surname1, r.surname2].filter(Boolean).join(" ") || "—" },
  { key: "document", label: "Documento", fit: true, truncate: 160, hideOnNarrow: true, render: (r) => (r.documentType ? `${r.documentType} ${r.documentNumber ?? ""}` : "—") },
  { key: "status", label: "Estado", fit: true, render: (r) => <CocoaBadge tone={STATUS_TONE[r.status] ?? "info"}>{STATUS_LABEL[r.status] ?? r.status}</CocoaBadge> },
  { key: "reservation", label: "Reserva", fit: true, showFrom: "desktop", render: (r) => <span className="cocoa-mono">{r.reservationCode ?? r.reservationId}</span> },
  { key: "createdAt", label: "Creado", fit: true, showFrom: "desktop", render: (r) => dateTime(r.createdAt) },
  { key: "retentionUntil", label: "Conservar hasta", fit: true, showFrom: "desktop", render: (r) => date(r.retentionUntil) }
];

function RegisterSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton variant="card" height={320} />
      <CocoaSkeleton variant="card" height={200} />
    </div>
  );
}

export function GuestRegisterSettingsScreen() {
  const hosted = useTabHost() !== null;
  const [records, setRecords] = useState<GuestRegisterRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submission, setSubmission] = useState<SubmissionState>({ kind: "idle" });
  const formRef = useRef<HTMLFormElement | null>(null);
  // Bumped by a rejected submit: the effect below moves the focus to the first
  // invalid control once the errors are painted (a plain effect on `fieldErrors`
  // would steal the focus again every time typing clears one of them).
  const [invalidFocusTick, setInvalidFocusTick] = useState(0);
  useEffect(() => {
    if (invalidFocusTick === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [invalidFocusTick]);

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
    if (fieldErrors[key as keyof FieldErrors]) {
      setFieldErrors((cur) => {
        const next = { ...cur };
        delete next[key as keyof FieldErrors];
        return next;
      });
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmission({ kind: "idle" });

    // One pass over every required field — the reservation and the Zod input —
    // so a single submit marks all of them with `CocoaField error` and the
    // callout only summarises (qa#15: the reservation check used to return
    // before the validation and no field was ever marked).
    const errors: FieldErrors = {};
    if (!form.reservationId.trim()) errors.reservationId = "El identificador de la reserva es obligatorio.";
    const validation = validateSpainGuestRegisterForm(formToInput(form));
    if (!validation.ok) Object.assign(errors, validation.errors);
    const invalid = Object.keys(errors).length;
    setFieldErrors(errors);
    if (!validation.ok || invalid > 0) {
      setInvalidFocusTick((tick) => tick + 1);
      setSubmission({
        kind: "error",
        message: `Faltan campos obligatorios o hay datos no válidos. Revisa ${invalid === 1 ? "el campo marcado" : `los ${plural(invalid, "campo marcado", "campos marcados")}`}.`
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
      let queueMessage = "Parte creado.";
      try {
        const queued = await queueSpainGuestRegisterSubmission(record.id, "checkin", {
          retries: 2,
          baseDelayMs: 400
        });
        submissionId = queued.id;
        queueMessage = `Parte creado y envío a la autoridad encolado (${SUBMISSION_STATUS_LABEL[queued.status] ?? queued.status}).`;
      } catch (queueErr) {
        queueMessage = `Parte creado. No se pudo encolar el envío a la autoridad: ${
          queueErr instanceof Error ? queueErr.message : "error desconocido"
        }. Reintenta desde la bandeja de cumplimiento.`;
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
        message: err instanceof Error ? err.message : "No se ha podido crear el parte de viajero."
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
        message: `Envío a la autoridad encolado (${SUBMISSION_STATUS_LABEL[queued.status] ?? queued.status}).`
      });
      load();
    } catch (err) {
      setSubmission({
        kind: "error",
        message: err instanceof Error ? err.message : "No se ha podido encolar el envío a la autoridad."
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
  const rows = useMemo(() => records.slice(0, VISIBLE_RECORDS), [records]);
  const rejectedOrFailed = (counts.rejected ?? 0) + (counts.failed ?? 0);

  const busy = submission.kind === "submitting";
  const submittingLabel =
    submission.kind === "submitting"
      ? submission.phase === "create"
        ? "Creando el parte…"
        : "Encolando el envío a la autoridad…"
      : "";

  return (
    <CocoaPage
      eyebrow="Cumplimiento · Registro de viajeros"
      title="Partes de entrada"
      subtitle={
        hosted
          ? undefined
          : "Registro de viajeros del RD 933/2021 y envío de los partes a SES.Hospedajes. Los datos obligatorios de identidad, residencia, contrato y contacto se validan antes de crear el parte."
      }
      actions={
        <>
          <CocoaBadge tone="info">{plural(records.length, "parte", "partes")}</CocoaBadge>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("SesHospedajesSettings")}>
            Conector SES.Hospedajes
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("ComplianceInbox")}>
            Bandeja de cumplimiento
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={load} disabled={busy || loading}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && records.length === 0 && !loadError ? "loading" : loadError && records.length === 0 ? "error" : "ready"}
      skeleton={<RegisterSkeleton />}
      error={{ title: "No se pudieron cargar los partes", message: loadError ?? undefined, onRetry: load }}
      commands={[
        { id: "guest-register-refresh", label: "Actualizar los partes de entrada", run: load },
        { id: "guest-register-ses", label: "Abrir el conector SES.Hospedajes", run: () => navigateTo("SesHospedajesSettings") }
      ]}
    >
      {loadError && records.length > 0 ? (
        <CocoaCallout tone="danger" title="No se pudieron actualizar los partes" role="alert" actions={<CocoaButton variant="bordered" tone="neutral" size="small" onClick={load}>{ACTIONS.retry}</CocoaButton>}>
          {loadError}
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip aria-label="Estado de los partes de viajeros">
        <CocoaKpi label="Aceptados" value={number(counts.accepted ?? 0)} polarity="neutral" status="ok" />
        <CocoaKpi label="Datos incompletos" value={number(counts.missing_data ?? 0)} polarity="neutral" status={(counts.missing_data ?? 0) > 0 ? "warning" : "ok"} />
        <CocoaKpi label="En cola" value={number(counts.queued ?? 0)} polarity="neutral" />
        <CocoaKpi label="Rechazados o fallidos" value={number(rejectedOrFailed)} polarity="neutral" status={rejectedOrFailed > 0 ? "critical" : "ok"} />
      </CocoaKpiStrip>

      <form ref={formRef} onSubmit={(event) => void handleSubmit(event)} noValidate>
        <CocoaFormSection
          title="Crear parte de entrada"
          description="Datos del viajero, residencia, contacto y contrato. Los campos marcados son obligatorios para SES.Hospedajes; el parte se crea y su envío se encola en la misma acción."
          actions={
            <>
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setForm(EMPTY_FORM)} disabled={busy}>
                Limpiar
              </CocoaButton>
              <CocoaButton type="submit" variant="filled" tone="accent" size="small" disabled={busy} loading={busy}>
                {busy ? submittingLabel : "Crear y encolar el envío"}
              </CocoaButton>
            </>
          }
        >
          <CocoaFormRow columns={3}>
            <CocoaField
              label="Identificador de la reserva"
              required
              help="Identificador interno de la reserva (el de la dirección /recepcion/reservas/<id>); el código RES-… aparece en la tabla."
              error={fieldErrors.reservationId}
            >
              <CocoaInput value={form.reservationId} onChange={(v) => set("reservationId", v)} placeholder="res_…" disabled={busy} />
            </CocoaField>
            <CocoaField label="Nombre" required error={fieldErrors.firstName}>
              <CocoaInput value={form.firstName} onChange={(v) => set("firstName", v)} autoComplete="given-name" disabled={busy} />
            </CocoaField>
            <CocoaField label="Primer apellido" required error={fieldErrors.surname1}>
              <CocoaInput value={form.surname1} onChange={(v) => set("surname1", v)} autoComplete="family-name" disabled={busy} />
            </CocoaField>
            <CocoaField label="Segundo apellido">
              <CocoaInput value={form.surname2} onChange={(v) => set("surname2", v)} disabled={busy} />
            </CocoaField>
            <CocoaField label="Tipo de documento" required>
              <CocoaSelect value={form.documentType} onChange={(v) => set("documentType", v as FormState["documentType"])} options={DOCUMENT_TYPE_OPTIONS} disabled={busy} />
            </CocoaField>
            <CocoaField label="Número de documento" required error={fieldErrors.documentNumber}>
              <CocoaInput value={form.documentNumber} onChange={(v) => set("documentNumber", v)} disabled={busy} />
            </CocoaField>
            <CocoaField label="Número de soporte (DNI/TIE)">
              <CocoaInput value={form.documentSupportNumber} onChange={(v) => set("documentSupportNumber", v)} disabled={busy} />
            </CocoaField>
            <CocoaField label="Nacionalidad" required error={fieldErrors.nationality} help="Código de país de dos letras.">
              <CocoaInput value={form.nationality} onChange={(v) => set("nationality", v)} placeholder="ES" maxLength={2} disabled={busy} />
            </CocoaField>
            <CocoaField label="Fecha de nacimiento" required error={fieldErrors.dateOfBirth}>
              <CocoaDatePicker value={form.dateOfBirth} onChange={(v) => set("dateOfBirth", v)} disabled={busy} />
            </CocoaField>
          </CocoaFormRow>

          <CocoaFormRow columns={3}>
            <CocoaField label="Dirección de residencia" required error={fieldErrors.residenceFullAddress} fullWidth>
              <CocoaInput value={form.residenceFullAddress} onChange={(v) => set("residenceFullAddress", v)} autoComplete="street-address" disabled={busy} />
            </CocoaField>
            <CocoaField label="Localidad" required error={fieldErrors.residenceLocality}>
              <CocoaInput value={form.residenceLocality} onChange={(v) => set("residenceLocality", v)} autoComplete="address-level2" disabled={busy} />
            </CocoaField>
            <CocoaField label="País" required error={fieldErrors.residenceCountry} help="Código de país de dos letras.">
              <CocoaInput value={form.residenceCountry} onChange={(v) => set("residenceCountry", v)} placeholder="ES" maxLength={2} disabled={busy} />
            </CocoaField>
            <CocoaField label="Teléfono móvil">
              <CocoaInput type="tel" inputMode="tel" value={form.phoneMobile} onChange={(v) => set("phoneMobile", v)} autoComplete="tel" disabled={busy} />
            </CocoaField>
            <CocoaField label="Correo electrónico" error={fieldErrors.email}>
              <CocoaInput type="email" inputMode="email" value={form.email} onChange={(v) => set("email", v)} autoComplete="email" disabled={busy} />
            </CocoaField>
          </CocoaFormRow>

          <CocoaFormRow columns={3}>
            <CocoaField label="Número de viajeros" required error={fieldErrors.travellerCount}>
              <CocoaInput type="number" inputMode="numeric" min={1} value={form.travellerCount} onChange={(v) => set("travellerCount", v)} disabled={busy} />
            </CocoaField>
            <CocoaField label="Referencia del contrato" required error={fieldErrors.contractReference}>
              <CocoaInput value={form.contractReference} onChange={(v) => set("contractReference", v)} disabled={busy} />
            </CocoaField>
            <CocoaField label="Entrada">
              <CocoaDatePicker withTime value={form.checkinAt} onChange={(v) => set("checkinAt", v)} disabled={busy} />
            </CocoaField>
            <CocoaField label="Salida">
              <CocoaDatePicker withTime value={form.checkoutAt} onChange={(v) => set("checkoutAt", v)} disabled={busy} />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>
      </form>

      {submission.kind === "error" ? (
        <CocoaCallout tone="danger" role="alert" title="No se pudo crear el parte">
          {submission.message}
        </CocoaCallout>
      ) : null}
      {submission.kind === "success" ? (
        <CocoaCallout tone="success" role="status">
          {submission.message}
          {submission.submissionId ? ` (envío ${submission.submissionId})` : ""}
        </CocoaCallout>
      ) : null}

      <CocoaSection
        title="Partes de viajeros"
        meta={
          records.length > VISIBLE_RECORDS
            ? `cola de envíos · ${number(VISIBLE_RECORDS)} de ${plural(records.length, "parte", "partes")}`
            : `cola de envíos · ${plural(records.length, "parte", "partes")}`
        }
        padding={rows.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
      >
        {rows.length === 0 ? (
          <CocoaState kind="empty" illustration="box" title="Sin partes de viajeros" message="Todavía no hay partes de viajeros en esta propiedad. Crea el primero con el formulario." />
        ) : (
          <CocoaTable
            columns={COLUMNS}
            rows={rows}
            rowKey="id"
            rowTone={(r) => (r.status === "rejected" || r.status === "failed" ? "danger" : r.status === "missing_data" ? "warning" : undefined)}
            rowActionsVisible="always"
            rowActions={(r) =>
              canRetryQueue(r) ? (
                <CocoaButton
                  variant="plain"
                  size="small"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleRetryQueue(r.id);
                  }}
                >
                  Reintentar envío
                </CocoaButton>
              ) : null
            }
            caption="Partes de viajeros"
            aria-label="Partes de viajeros"
          />
        )}
      </CocoaSection>
    </CocoaPage>
  );
}
