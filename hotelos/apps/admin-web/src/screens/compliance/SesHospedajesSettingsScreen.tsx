// Conector SES.Hospedajes — Cumplimiento › Registro de viajeros › SES.Hospedajes
// (/cumplimiento/registro-viajeros/ses-hospedajes, hosted in RegistroViajerosTabs;
// the legacy key still opens it standalone). Cocoa 22 · ola 8 · lote 8-A,
// archetype «dashboard» (docs/design/COCOA-22.md §4, plantilla DashboardAlojado).
//
// Four blocks over the real endpoints of Tanda 3 (lote front-fiscal):
//   - readiness KPIs derived from the settings and the establishment;
//   - establishment: GET /properties/:id/ses/establishment (contract F) with the
//     missing fields and the links to the profile and the tax settings;
//   - connector settings: GET/PATCH …/guest-register/settings (sesApi), the
//     connection test and the batch export;
//   - history: GET /properties/:id/ses/submissions (paginated, envelope) with
//     the row detail (summary · XML · authority response) in a CocoaDrawer that
//     polls GET /ses/submissions/:id while the submission is pending, and the
//     pipeline retry (POST /ses/submissions/:id/retry) per row and in the drawer.
//     The legacy fixed aside (.bo-*, retired in ola 11) is replaced by the
//     drawer; the calls are the same.

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { fetchSesSettings, patchSesSettings, generateSesBatch, testSesConnection, type SesReportingSettings } from "../../services/sesApi";
import {
  fetchSesEstablishment,
  fetchSesSubmissionsPage,
  retrySesPipelineSubmission,
  sesEstablishmentIssueLabel,
  type SesEstablishment,
  type SesSubmissionRow
} from "../../services/complianceApi";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { navigateTo } from "../../lib/navigate";
import { dateTime, number, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS as UI_STATUS } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import { SUBMISSION_PENDING_STATUSES } from "../fiscal/fiscal-shared";
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
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  toneInk,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
const HISTORY_PAGE_SIZE = 50;

function statusTone(status: string): CocoaTone {
  if (status === "accepted" || status === "accepted_with_warnings") return "success";
  if (status === "rejected" || status === "failed" || status === "abandoned") return "danger";
  if (["queued", "retrying", "submitting", "pending", "network_error", "sent"].includes(status)) return "warning";
  return "info";
}

const STATUS_LABELS: Record<string, string> = {
  queued: "En cola",
  pending: "Pendiente",
  submitting: "Enviando",
  sent: "Enviado",
  retrying: "Reintentando",
  network_error: "Error de red",
  accepted: "Aceptado",
  accepted_with_warnings: "Aceptado con avisos",
  rejected: "Rechazado",
  failed: "Fallido (máx. intentos)",
  abandoned: "Abandonado",
  annulled: "Anulado"
};

const STATUS_FILTER_OPTIONS = [
  { value: "", label: "Todos los estados" },
  { value: "queued", label: "En cola" },
  { value: "retrying", label: "Reintentando" },
  { value: "accepted", label: "Aceptados" },
  { value: "rejected", label: "Rechazados" },
  { value: "failed", label: "Fallidos" }
];

/** States the operator can force a resend from: the terminal ones too (the manual retry resets the attempt counter). */
const RETRYABLE = new Set(["rejected", "retrying", "network_error", "failed", "abandoned"]);
/** States the detail drawer keeps polling for (8 s), as the legacy panel did: the shared set of
 *  fiscal-shared, so «sent» (open for the API: ses-submission.service.ts SES_OPEN_STATUSES) keeps
 *  polling here too (Cocoa 22 · ola 11 · R3). */
const PENDING_STATUSES = SUBMISSION_PENDING_STATUSES;

const ESTABLISHMENT_FIELD_LABELS: Record<string, string> = {
  registryNumber: "Nº de registro turístico",
  taxId: "NIF del titular",
  legalName: "Razón social",
  address: "Dirección",
  municipality: "Municipio",
  municipalityCode: "Código INE del municipio",
  province: "Provincia",
  postalCode: "Código postal",
  country: "País"
};

const SWITCHES: Array<[keyof Form, string]> = [
  ["enabled", "Conector activo"],
  ["professionalActivity", "Actividad profesional (RD 933/2021)"],
  ["batchExportEnabled", "Exportación por lotes"],
  ["automaticSubmissionEnabled", "Envío automático (cola 24 h)"],
  ["webServiceEnabled", "Web service en producción"],
  ["officialSchemaConfigured", "Esquema o plantilla oficial cargado"]
];

type Form = {
  establishmentCode: string;
  landlordCode: string;
  webServiceUsername: string;
  webServiceSecretRef: string;
  enabled: boolean;
  professionalActivity: boolean;
  webServiceEnabled: boolean;
  batchExportEnabled: boolean;
  automaticSubmissionEnabled: boolean;
  defaultBatchTime: string;
  alertBeforeDeadlineHours: string;
  retentionYears: string;
  officialSchemaConfigured: boolean;
};

function toForm(r?: SesReportingSettings): Form {
  const cfg = (r?.configurationJson ?? {}) as Record<string, unknown>;
  return {
    establishmentCode: r?.establishmentCode ?? "",
    landlordCode: r?.landlordCode ?? "",
    webServiceUsername: r?.webServiceUsername ?? "",
    webServiceSecretRef: r?.webServiceSecretRef ?? "",
    enabled: r?.enabled ?? false,
    professionalActivity: r?.professionalActivity ?? false,
    webServiceEnabled: r?.webServiceEnabled ?? false,
    batchExportEnabled: r?.batchExportEnabled ?? false,
    automaticSubmissionEnabled: r?.automaticSubmissionEnabled ?? false,
    defaultBatchTime: String(cfg.defaultBatchTime ?? "06:00"),
    alertBeforeDeadlineHours: String(cfg.alertBeforeDeadlineHours ?? 4),
    retentionYears: String(cfg.retentionYears ?? 3),
    officialSchemaConfigured: Boolean(cfg.officialSchemaConfigured)
  };
}

// Error text of a submission row: 13 px in the AA danger ink (rule 6: outside a
// literal). `overflowWrap: anywhere` lets an authority code with underscores
// («SES_ESTABLISHMENT_INCOMPLETE:», 228 px on one line) break as a last resort,
// so the text column can shrink to its `minWidth` on a 1024 laptop (qa#6 8-A).
const errorStyle: CSSProperties = { color: toneInk("danger"), overflowWrap: "anywhere" };

// Six columns plus two actions: at 1024 the wrapper offers 734 px and the
// full row measured 1060 (Tipo 102 · Reserva 216 · Estado 177 · Referencia
// 252 · Intentos 76 · Enviado 143 · Acciones 95; qa#6 8-A). Below the
// desktop tier the row keeps what identifies and explains the submission —
// reservation, status, reference or error, actions (≈ 712 px) — and the type,
// the attempts and the timestamp wait for ≥ 1200 (the drawer shows them all).
// The reservation id is not truncated: a cuid differs by its tail.
const SUBMISSION_COLUMNS: CocoaTableColumn<SesSubmissionRow>[] = [
  { key: "submissionType", label: "Tipo", fit: true, showFrom: "desktop", render: (s) => (s.submissionType ?? "—").replace(/_/g, " ") },
  { key: "reservationId", label: "Reserva", fit: true, hideOnNarrow: true, render: (s) => (s.reservationId ? <span className="cocoa-mono">{s.reservationId}</span> : "—") },
  { key: "status", label: "Estado", fit: true, render: (s) => <CocoaBadge tone={statusTone(s.status)}>{STATUS_LABELS[s.status] ?? s.status}</CocoaBadge> },
  {
    key: "reference",
    label: "Referencia o error",
    minWidth: 200,
    render: (s) =>
      s.errorMessage ? (
        <span style={errorStyle}>
          {s.errorCode ? `${s.errorCode}: ` : ""}
          {s.errorMessage}
        </span>
      ) : (
        s.acknowledgementCode ?? s.trackingNumber ?? s.externalReference ?? "—"
      )
  },
  { key: "attempts", label: "Intentos", align: "right", fit: true, showFrom: "desktop", render: (s) => number(s.attempts ?? 0) },
  { key: "submittedAt", label: "Enviado", fit: true, showFrom: "desktop", render: (s) => dateTime(s.submittedAt ?? s.createdAt) }
];

function SesSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton variant="card" height={200} />
      <CocoaSkeleton variant="card" height={320} />
    </div>
  );
}

export function SesHospedajesSettingsScreen() {
  const hosted = useTabHost() !== null;
  const [reporting, setReporting] = useState<SesReportingSettings | undefined>();
  const [form, setForm] = useState<Form>(toForm());
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  // Establishment block (contract F).
  const [establishment, setEstablishment] = useState<SesEstablishment | null>(null);
  const [establishmentError, setEstablishmentError] = useState<string | null>(null);

  // QC-06: the submission history has a 24h legal deadline; a failed load is
  // reported on its own (the settings form keeps working) instead of showing
  // "no submissions yet".
  const [submissions, setSubmissions] = useState<SesSubmissionRow[]>([]);
  const [submissionsTotal, setSubmissionsTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [submissionsError, setSubmissionsError] = useState<string | null>(null);
  const [submissionsLoading, setSubmissionsLoading] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const loadSubmissions = useCallback(
    async (options: { cursor?: string | null; append?: boolean } = {}) => {
      setSubmissionsLoading(true);
      setSubmissionsError(null);
      try {
        const page = await fetchSesSubmissionsPage(PROPERTY_ID, {
          limit: HISTORY_PAGE_SIZE,
          cursor: options.cursor ?? undefined,
          status: statusFilter || undefined
        });
        setSubmissions((current) => {
          if (!options.append) return page.items;
          const seen = new Set(current.map((row) => row.id));
          return [...current, ...page.items.filter((row) => !seen.has(row.id))];
        });
        setNextCursor(page.nextCursor);
        setSubmissionsTotal(page.total);
      } catch (err: unknown) {
        if (!options.append) setSubmissions([]);
        setSubmissionsError(err instanceof Error ? err.message : "No se pudo cargar el historial de envíos.");
      } finally {
        setSubmissionsLoading(false);
      }
    },
    [statusFilter]
  );

  const loadEstablishment = useCallback(async () => {
    try {
      setEstablishment(await fetchSesEstablishment(PROPERTY_ID));
      setEstablishmentError(null);
    } catch (err) {
      setEstablishment(null);
      setEstablishmentError(err instanceof Error ? err.message : "No se pudieron leer los datos del establecimiento.");
    }
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchSesSettings(PROPERTY_ID)
      .then((settings) => {
        setReporting(settings.reporting);
        setForm(toForm(settings.reporting));
        setLoaded(true);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudo cargar la configuración SES.HOSPEDAJES."))
      .finally(() => setLoading(false));
    void loadEstablishment();
    void loadSubmissions();
  }, [loadEstablishment, loadSubmissions]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadSubmissions();
  }, [loadSubmissions]);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((cur) => ({ ...cur, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    setStatus(null);
    try {
      const updated = await patchSesSettings(PROPERTY_ID, {
        establishmentCode: form.establishmentCode || undefined,
        landlordCode: form.landlordCode || undefined,
        webServiceUsername: form.webServiceUsername || undefined,
        webServiceSecretRef: form.webServiceSecretRef || undefined,
        enabled: form.enabled,
        professionalActivity: form.professionalActivity,
        webServiceEnabled: form.webServiceEnabled,
        batchExportEnabled: form.batchExportEnabled,
        automaticSubmissionEnabled: form.automaticSubmissionEnabled,
        defaultBatchTime: form.defaultBatchTime,
        alertBeforeDeadlineHours: Number(form.alertBeforeDeadlineHours) || 4,
        retentionYears: Number(form.retentionYears) || 3,
        officialSchemaConfigured: form.officialSchemaConfigured
      });
      setReporting(updated);
      setForm(toForm(updated));
      setStatus("Configuración guardada.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setBusy(true);
    setStatus(null);
    try {
      const r = await testSesConnection(PROPERTY_ID);
      setStatus(`Prueba de conexión: ${r.status} — ${r.message}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Falló la prueba de conexión.");
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateBatch() {
    setBusy(true);
    setStatus(null);
    try {
      const b = await generateSesBatch(PROPERTY_ID);
      setStatus(`Lote generado: ${plural(b.recordCount, "registro", "registros")} (${b.fileFormat ?? "json"}).`);
      void loadSubmissions();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "No se pudo generar el lote.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRetry(id: string) {
    setRetryingId(id);
    try {
      await retrySesPipelineSubmission(id);
      setStatus("Reenvío encolado.");
      window.setTimeout(() => void loadSubmissions(), 600);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "No se pudo reintentar.");
    } finally {
      setRetryingId(null);
    }
  }

  // Live readiness derived from real settings.
  const credsReady = Boolean(form.establishmentCode && form.landlordCode);
  const webServiceReady = form.webServiceEnabled && form.officialSchemaConfigured && Boolean(form.webServiceSecretRef);
  const counts = useMemo(
    () =>
      submissions.reduce<Record<string, number>>((acc, s) => {
        acc[s.status] = (acc[s.status] ?? 0) + 1;
        return acc;
      }, {}),
    [submissions]
  );
  const rejected = (counts.rejected ?? 0) + (counts.failed ?? 0) + (counts.abandoned ?? 0);
  const missing = useMemo(() => toArray<string>(establishment?.missing), [establishment]);
  // The legacy heuristic: outcomes read as success, the rest as a plain note.
  const noticeTone = status && /guardada|generado|encolado|conexión/.test(status) ? "success" : "neutral";
  const historyReady = !submissionsError && submissions.length > 0;

  return (
    <CocoaPage
      eyebrow="Cumplimiento · Registro de viajeros"
      title="SES.Hospedajes"
      subtitle={
        hosted
          ? undefined
          : "Parte de viajeros del Ministerio del Interior (RD 933/2021): códigos de establecimiento y arrendador, credenciales del web service, exportación por lotes y cola de envío con plazo de 24 h."
      }
      actions={
        <>
          <CocoaBadge tone={credsReady ? "success" : "warning"}>{credsReady ? "Códigos configurados" : "Configuración pendiente"}</CocoaBadge>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void handleTest()} disabled={busy} loading={busy}>
            Probar conexión
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void handleGenerateBatch()} disabled={busy || !form.batchExportEnabled}>
            Generar lote de exportación
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("ComplianceInbox")}>
            Bandeja de cumplimiento
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("GuestRegisterSettings")}>
            Registro de viajeros
          </CocoaButton>
        </>
      }
      state={loading && !loaded ? "loading" : error && !loaded ? "error" : "ready"}
      skeleton={<SesSkeleton />}
      error={{ title: "No se pudo cargar la configuración", message: error ?? undefined, onRetry: load }}
      commands={[
        { id: "ses-hospedajes-save", label: `${ACTIONS.save}: configuración SES.Hospedajes`, run: () => void handleSave(), shortcut: "⌘ Enter" },
        { id: "ses-hospedajes-test", label: "Probar la conexión con SES.Hospedajes", run: () => void handleTest() },
        { id: "ses-hospedajes-refresh", label: "Actualizar el conector SES.Hospedajes", run: load }
      ]}
    >
      {status ? (
        <CocoaCallout
          tone={noticeTone}
          role="status"
          actions={
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setStatus(null)}>
              {ACTIONS.close}
            </CocoaButton>
          }
        >
          {status}
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip aria-label="Preparación del conector">
        <CocoaKpi label="Códigos de establecimiento y arrendador" value={credsReady ? "Listos" : "Faltan"} polarity="neutral" status={credsReady ? "ok" : "warning"} />
        <CocoaKpi
          label="Datos del establecimiento"
          value={establishment ? (establishment.ok ? "Completos" : `Faltan ${number(missing.length)}`) : "—"}
          degraded={!establishment}
          polarity="neutral"
          status={establishment?.ok ? "ok" : "warning"}
        />
        <CocoaKpi label="Web service" value={webServiceReady ? "Listo" : "Bloqueado"} polarity="neutral" status={webServiceReady ? "ok" : "warning"} />
        {/* «—» when the history could not be loaded: a green 0 would be a lie. */}
        <CocoaKpi label="Rechazados o fallidos" value={submissionsError ? "—" : number(rejected)} degraded={Boolean(submissionsError)} polarity="neutral" status={submissionsError ? "warning" : rejected ? "critical" : "ok"} />
      </CocoaKpiStrip>

      <CocoaSection
        title="Establecimiento"
        meta={
          establishment ? (
            <CocoaBadge tone={establishment.ok ? "success" : "warning"} size="small">
              {establishment.ok ? "Datos completos" : plural(missing.length, "dato que falta", "datos que faltan")}
            </CocoaBadge>
          ) : (
            "alta en el MIR"
          )
        }
        action={
          <CocoaButton variant="plain" size="small" onClick={() => void loadEstablishment()}>
            {ACTIONS.refresh}
          </CocoaButton>
        }
      >
        {establishment ? (
          <>
            <ul className="c22-section__list" aria-label="Datos del establecimiento">
              {(Object.keys(ESTABLISHMENT_FIELD_LABELS) as Array<keyof SesEstablishment["establishment"]>).map((key) => {
                const value = establishment.establishment[key];
                const isMissing = missing.includes(key);
                return (
                  <li key={key}>
                    <span>{ESTABLISHMENT_FIELD_LABELS[key]}</span>
                    {value ? (
                      <strong>{value}</strong>
                    ) : (
                      <CocoaBadge tone={isMissing ? "warning" : "neutral"} size="small">
                        {isMissing ? "falta" : "—"}
                      </CocoaBadge>
                    )}
                  </li>
                );
              })}
            </ul>
            {!establishment.ok ? (
              <p className="cocoa-note">
                SES.HOSPEDAJES rechaza el alta sin estos datos. El NIF, la razón social y la dirección se editan en el perfil del establecimiento; el código INE, el
                código postal y el número de registro turístico en Ajustes fiscales.
              </p>
            ) : null}
            <div className="cocoa-row" data-gap="2">
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("PropertyProfileSetupForm")}>
                Perfil del establecimiento
              </CocoaButton>
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("TaxComplianceSettings")}>
                Ajustes fiscales
              </CocoaButton>
            </div>
          </>
        ) : (
          <CocoaState kind="error" inline title="Datos del establecimiento no disponibles" message={establishmentError ?? undefined} onRetry={() => void loadEstablishment()} />
        )}
      </CocoaSection>

      <CocoaFormSection
        title="Códigos, credenciales y política de cola"
        description={reporting?.updatedAt ? `Configuración del conector · actualizada ${dateTime(reporting.updatedAt)}.` : "Configuración del conector: códigos del MIR, credenciales del web service y política de la cola de envío."}
        actions={
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void handleSave()} disabled={saving} loading={saving}>
            {saving ? UI_STATUS.saving : "Guardar configuración"}
          </CocoaButton>
        }
      >
        <CocoaFormRow columns={3}>
          <CocoaField label="Código de establecimiento" required>
            <CocoaInput value={form.establishmentCode} onChange={(v) => set("establishmentCode", v)} placeholder="EST-…" />
          </CocoaField>
          <CocoaField label="Código de arrendador" required>
            <CocoaInput value={form.landlordCode} onChange={(v) => set("landlordCode", v)} placeholder="ARR-…" />
          </CocoaField>
          <CocoaField label="Usuario del web service">
            <CocoaInput value={form.webServiceUsername} onChange={(v) => set("webServiceUsername", v)} autoComplete="off" />
          </CocoaField>
          <CocoaField label="Referencia del secreto" help="Nunca se almacena el secreto en claro: solo una referencia al gestor de secretos.">
            <CocoaInput value={form.webServiceSecretRef} onChange={(v) => set("webServiceSecretRef", v)} placeholder="secret://ses-hospedajes/…" autoComplete="off" />
          </CocoaField>
          <CocoaField label="Hora del lote diario">
            <CocoaInput type="time" value={form.defaultBatchTime} onChange={(v) => set("defaultBatchTime", v)} />
          </CocoaField>
          <CocoaField label="Aviso antes del plazo (horas)">
            <CocoaInput type="number" inputMode="numeric" min={0} value={form.alertBeforeDeadlineHours} onChange={(v) => set("alertBeforeDeadlineHours", v)} />
          </CocoaField>
          <CocoaField label="Retención de registros (años)">
            <CocoaInput type="number" inputMode="numeric" min={0} value={form.retentionYears} onChange={(v) => set("retentionYears", v)} />
          </CocoaField>
        </CocoaFormRow>

        <CocoaFormRow columns={3} min={200}>
          {SWITCHES.map(([key, label]) => (
            <CocoaField key={key} label={label} inline>
              <CocoaSwitch checked={Boolean(form[key])} onChange={(v) => set(key, v as Form[typeof key])} size="small" />
            </CocoaField>
          ))}
        </CocoaFormRow>

        {form.automaticSubmissionEnabled && !webServiceReady ? (
          <CocoaCallout tone="warning" role="status">
            El envío automático usará exportación por lotes hasta que el web service esté listo (credenciales + esquema oficial).
          </CocoaCallout>
        ) : null}
      </CocoaFormSection>

      <CocoaToolbar
        variant="content"
        aria-label="Filtros del historial de envíos"
        leftSlot={<CocoaSelect inline value={statusFilter} onChange={setStatusFilter} options={STATUS_FILTER_OPTIONS} size="small" aria-label="Filtrar el historial por estado" />}
        rightSlot={
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void loadSubmissions()} disabled={submissionsLoading} loading={submissionsLoading}>
            {ACTIONS.refresh}
          </CocoaButton>
        }
      />

      <CocoaSection
        title="Historial de partes enviados"
        meta={
          submissionsError ? undefined : (
            <span className="cocoa-cluster">
              <CocoaBadge tone="neutral" size="small">{`${number(submissionsTotal ?? submissions.length)} en total`}</CocoaBadge>
              <CocoaBadge tone="neutral" size="small">{`${number(counts.queued ?? 0)} en cola`}</CocoaBadge>
              <CocoaBadge tone="neutral" size="small">{`${number(counts.accepted ?? 0)} aceptados`}</CocoaBadge>
              {rejected ? <CocoaBadge tone="danger" size="small">{`${number(rejected)} rechazados o fallidos`}</CocoaBadge> : null}
            </span>
          )
        }
        padding={historyReady || (submissionsLoading && submissions.length === 0) ? "none" : "md"}
        style={{ overflow: "clip" }}
        footer={
          historyReady ? (
            <>
              <span>
                {number(submissions.length)}
                {submissionsTotal !== null ? ` de ${number(submissionsTotal)}` : ""} envíos
              </span>
              {nextCursor ? (
                <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void loadSubmissions({ cursor: nextCursor, append: true })} disabled={submissionsLoading} loading={submissionsLoading}>
                  Cargar más envíos
                </CocoaButton>
              ) : null}
            </>
          ) : undefined
        }
      >
        {submissionsError ? (
          <CocoaState
            kind="error"
            title="No se pudo cargar el historial de envíos"
            message={`${submissionsError} Los partes SES tienen un plazo legal de 24 h: reintenta o revisa el conector.`}
            onRetry={() => void loadSubmissions()}
          />
        ) : submissionsLoading && submissions.length === 0 ? (
          <CocoaTable columns={SUBMISSION_COLUMNS} rows={[]} loading caption="Historial de partes enviados" aria-label="Historial de partes enviados" />
        ) : submissions.length === 0 ? (
          <CocoaState
            kind="empty"
            illustration={statusFilter ? "search" : "box"}
            title="Sin partes enviados"
            message={statusFilter ? "Ningún envío con ese estado." : "Los partes aparecen aquí cuando el check-in encola el registro de viajeros de una reserva."}
          />
        ) : (
          <CocoaTable
            columns={SUBMISSION_COLUMNS}
            rows={submissions}
            rowKey="id"
            selectedKey={detailId ?? undefined}
            onSelect={(s) => setDetailId(s.id)}
            rowTone={(s) => (statusTone(s.status) === "danger" ? "danger" : undefined)}
            rowTitle={() => "Abrir el detalle del envío"}
            rowActionsVisible="always"
            rowActions={(s) => (
              <span className="cocoa-cluster">
                <CocoaButton variant="plain" size="small" onClick={(event) => { event.stopPropagation(); setDetailId(s.id); }}>
                  Ver XML
                </CocoaButton>
                {RETRYABLE.has(s.status) ? (
                  <CocoaButton
                    variant="plain"
                    size="small"
                    onClick={(event) => { event.stopPropagation(); void handleRetry(s.id); }}
                    disabled={retryingId === s.id}
                    loading={retryingId === s.id}
                  >
                    {ACTIONS.retry}
                  </CocoaButton>
                ) : null}
              </span>
            )}
            caption="Historial de partes enviados"
            aria-label="Historial de partes enviados"
          />
        )}
      </CocoaSection>

      <SesSubmissionDrawer submissionId={detailId} onClose={() => setDetailId(null)} onRetried={() => void loadSubmissions()} />
    </CocoaPage>
  );
}

// ----------------------------------------------------------------- submission detail drawer

/** Row of GET /ses/submissions/:id: the list row plus the payloads the detail exposes. */
type SesSubmissionDetail = SesSubmissionRow & {
  invoiceNumber?: string | null;
  xmlPayload?: string | null;
  responseAck?: string | null;
  signatureMode?: string | null;
  signedAt?: string | null;
};

type DetailView = "summary" | "xml" | "response";
const DETAIL_VIEWS: { value: DetailView; label: string }[] = [
  { value: "summary", label: "Resumen" },
  { value: "xml", label: "XML canónico" },
  { value: "response", label: "Respuesta de la autoridad" }
];
const DETAIL_PANEL_ID = "ses-submission-detail-panel";

// Payload viewer: callout metrics in mono over the quaternary fill (rule 6: system values only).
const payloadStyle: CSSProperties = {
  margin: 0,
  maxHeight: 480,
  overflow: "auto",
  padding: "var(--cocoa-space-3)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontSize: "var(--cocoa-fs-callout)",
  lineHeight: "var(--cocoa-leading-text)",
  color: "var(--cocoa-label)",
  background: "var(--cocoa-fill-quaternary)",
  border: "1px solid var(--cocoa-separator)",
  borderRadius: "var(--cocoa-radius-md)"
};

// Value of a key/value row: semibold, right-aligned, breaks anywhere (ids, endpoints, hashes).
const kvValueStyle: CSSProperties = {
  minWidth: 0,
  textAlign: "right",
  wordBreak: "break-all",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"]
};

function KvRow({ label, value, mono = false }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <li>
      <span>{label}</span>
      <span className={mono ? "cocoa-mono" : undefined} style={kvValueStyle}>
        {value || "—"}
      </span>
    </li>
  );
}

function SesSubmissionDrawer({ submissionId, onClose, onRetried }: { submissionId: string | null; onClose: () => void; onRetried: () => void }) {
  const open = submissionId !== null;
  const [view, setView] = useState<DetailView>("summary");
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  // Same endpoint and polling policy as the legacy panel: every 8 s while the submission is pending.
  const { data, loading, error, refresh } = useApiData<SesSubmissionDetail>(open ? `/ses/submissions/${submissionId}` : null, {
    pollIntervalMs: 8000,
    pollWhile: (d) => PENDING_STATUSES.has((d as SesSubmissionDetail | null)?.status ?? "")
  });

  useEffect(() => {
    setView("summary");
    setRetryError(null);
  }, [submissionId]);

  async function handleRetry() {
    if (!submissionId) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await retrySesPipelineSubmission(submissionId);
      window.setTimeout(() => refresh(), 600);
      onRetried();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }

  const sub = data;
  const canRetry = Boolean(sub && RETRYABLE.has(sub.status));
  const pending = Boolean(sub && PENDING_STATUSES.has(sub.status));
  const missing = toArray<string>(sub?.missing);

  return (
    <CocoaDrawer
      open={open}
      onClose={onClose}
      title={sub?.invoiceNumber ?? sub?.externalReference ?? "Detalle del envío"}
      subtitle="MIR · Interior · SES.Hospedajes"
      side="right"
      size="lg"
      focusKey={submissionId ?? undefined}
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={refresh} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
          {canRetry ? (
            <CocoaButton variant="filled" tone="accent" onClick={() => void handleRetry()} disabled={retrying} loading={retrying}>
              Reintentar envío
            </CocoaButton>
          ) : (
            <CocoaButton variant="filled" tone="accent" onClick={onClose}>
              {ACTIONS.close}
            </CocoaButton>
          )}
        </>
      }
    >
      {loading && !sub ? (
        <CocoaState kind="loading" title={UI_STATUS.loading} />
      ) : error ? (
        <CocoaState kind="error" title="No se pudo cargar el envío" message={error} onRetry={refresh} />
      ) : !sub ? (
        <CocoaState kind="empty" title="Envío no encontrado" />
      ) : (
        <div className="cocoa-stack" data-gap="4">
          <div className="cocoa-cluster">
            <CocoaBadge tone={statusTone(sub.status)}>{STATUS_LABELS[sub.status] ?? sub.status}</CocoaBadge>
            {sub.submissionType ? <CocoaBadge tone="neutral" size="small">{sub.submissionType.replace(/_/g, " ")}</CocoaBadge> : null}
            {sub.signatureMode ? <CocoaBadge tone="neutral" size="small">{`XAdES ${sub.signatureMode}`}</CocoaBadge> : null}
            <CocoaBadge tone="neutral" size="small">{plural(sub.attempts ?? 0, "intento", "intentos")}</CocoaBadge>
          </div>

          <CocoaSegmentedControl value={view} onChange={(v) => setView(v as DetailView)} options={DETAIL_VIEWS} size="small" aria-label="Vistas del envío" panelId={DETAIL_PANEL_ID} />

          <div id={DETAIL_PANEL_ID} role="tabpanel" aria-label={DETAIL_VIEWS.find((option) => option.value === view)?.label} className="cocoa-stack" data-gap="3">
            {view === "summary" ? (
              <>
                <CocoaSection title="Identificadores">
                  <ul className="c22-section__list" aria-label="Identificadores del envío">
                    <KvRow label="Identificador del envío" value={sub.id} mono />
                    <KvRow label="Referencia" value={sub.invoiceNumber ?? sub.externalReference} mono />
                    <KvRow label="Reserva" value={sub.reservationId} mono />
                    <KvRow label="Registro de viajero" value={sub.guestRegisterRecordId} mono />
                    {sub.acknowledgementCode ? <KvRow label="Código de la autoridad" value={sub.acknowledgementCode} mono /> : null}
                    {sub.trackingNumber ? <KvRow label="Nº de seguimiento" value={sub.trackingNumber} mono /> : null}
                  </ul>
                </CocoaSection>
                <CocoaSection title="Ciclo de vida">
                  <ul className="c22-section__list" aria-label="Ciclo de vida del envío">
                    <KvRow label="Creado" value={dateTime(sub.createdAt)} />
                    <KvRow label="Firmado" value={dateTime(sub.signedAt)} />
                    <KvRow label="Enviado" value={dateTime(sub.submittedAt)} />
                    <KvRow label="Confirmado" value={dateTime(sub.acknowledgedAt)} />
                    {sub.nextRetryAt ? <KvRow label="Siguiente reintento" value={dateTime(sub.nextRetryAt)} /> : null}
                  </ul>
                </CocoaSection>
                <CocoaSection title="Transporte">
                  <ul className="c22-section__list" aria-label="Transporte del envío">
                    <KvRow label="Punto de acceso" value={sub.endpoint} mono />
                    <KvRow label="Modo de firma" value={sub.signatureMode} />
                  </ul>
                </CocoaSection>
                {sub.errorCode || sub.errorMessage ? (
                  <CocoaCallout tone="danger" title="Error de la autoridad" role="alert">
                    {sub.errorCode ? <CocoaBadge tone="danger" size="small">{sub.errorCode}</CocoaBadge> : null}
                    {sub.errorMessage ? <p>{sub.errorMessage}</p> : null}
                  </CocoaCallout>
                ) : null}
                {missing.length > 0 ? (
                  <CocoaCallout tone="warning" title="Datos del establecimiento que bloquean el envío">
                    {missing.map((issue) => sesEstablishmentIssueLabel(issue)).join(", ")}
                  </CocoaCallout>
                ) : null}
              </>
            ) : view === "xml" ? (
              <pre className="cocoa-mono" style={payloadStyle}>{sub.xmlPayload ?? "(sin XML canónico)"}</pre>
            ) : (
              <pre className="cocoa-mono" style={payloadStyle}>{sub.responseAck ?? "(sin respuesta todavía)"}</pre>
            )}
          </div>

          <p className="cocoa-note">{pending ? "Se actualiza cada 8 segundos mientras el envío esté pendiente." : "Actualización manual."}</p>
          {retryError ? (
            <CocoaCallout tone="danger" title="No se pudo reintentar" role="alert">
              {retryError}
            </CocoaCallout>
          ) : null}
        </div>
      )}
    </CocoaDrawer>
  );
}

export default SesHospedajesSettingsScreen;
