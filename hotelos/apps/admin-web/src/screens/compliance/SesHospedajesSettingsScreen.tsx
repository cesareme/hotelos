// Conector SES.HOSPEDAJES (Tanda 3 · lote front-fiscal).
//
// Tres bloques, todos sobre endpoints reales:
//   - configuración del conector: GET/PATCH …/guest-register/settings (sesApi)
//   - establecimiento: GET /properties/:id/ses/establishment (contract F) con
//     los campos que faltan y enlace al perfil
//   - historial: GET /properties/:id/ses/submissions (paginado, envelope) con
//     detalle XML (SubmissionDetailPanel) y reintento por fila
//     (POST /ses/submissions/:id/retry)
import { useCallback, useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { fetchSesSettings, patchSesSettings, generateSesBatch, testSesConnection, type SesReportingSettings } from "../../services/sesApi";
import {
  fetchSesEstablishment,
  fetchSesSubmissionsPage,
  retrySesPipelineSubmission,
  type SesEstablishment,
  type SesSubmissionRow
} from "../../services/complianceApi";
import { LoadingBlock, ErrorState, Spinner, EmptyState } from "../../components/States";
import { SubmissionDetailPanel } from "../../components/SubmissionDetailPanel";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaSelect } from "../../components/cocoa/CocoaSelect";
import { toArray } from "../../utils/toArray";
import { navigateTo } from "../../lib/navigate";

const PROPERTY_ID = getActivePropertyId();
const HISTORY_PAGE_SIZE = 50;

function statusTone(status: string): string {
  if (status === "accepted" || status === "accepted_with_warnings") return "ok";
  if (status === "rejected" || status === "failed" || status === "abandoned") return "error";
  if (["queued", "retrying", "submitting", "pending", "network_error", "sent"].includes(status)) return "warn";
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

const RETRYABLE = new Set(["rejected", "retrying", "network_error", "failed", "abandoned"]);

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

function fmtDateTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("es-ES");
}

export function SesHospedajesSettingsScreen() {
  const [reporting, setReporting] = useState<SesReportingSettings | undefined>();
  const [form, setForm] = useState<Form>(toForm());
  const [loading, setLoading] = useState(true);
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
      setStatus(`Lote generado: ${b.recordCount} registros (${b.fileFormat ?? "json"}).`);
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

  if (loading) {
    return (
      <section className="bo-card">
        <LoadingBlock label="Cargando configuración SES…" />
      </section>
    );
  }
  if (error) {
    return (
      <section className="bo-card">
        <ErrorState message={error} onRetry={load} />
      </section>
    );
  }

  return (
    <>
      <section className="bo-card">
        <div className="bo-card-head" style={{ marginBottom: "var(--space-2)" }}>
          <div>
            <p className="bo-page-eyebrow">Conector de autoridad</p>
            <h2 className="bo-page-title" style={{ fontSize: "var(--fs-2xl)" }}>
              SES.HOSPEDAJES
            </h2>
          </div>
          <span className={`bo-status ${credsReady ? "ok" : "warn"}`}>{credsReady ? "Códigos configurados" : "Configuración pendiente"}</span>
        </div>
        <p className="bo-page-subtitle" style={{ marginTop: 0 }}>
          Parte de viajeros del Ministerio del Interior (RD 933/2021): códigos de establecimiento y arrendador, credenciales del web service, exportación
          por lotes y cola de envío con plazo de 24 h.
        </p>

        <div className="rev-kpi-grid" style={{ marginTop: "var(--space-4)" }}>
          <div className={`rev-kpi ${credsReady ? "rev-kpi-ok" : "rev-kpi-warn"}`}>
            <span className="rev-kpi-label">Códigos establecimiento y arrendador</span>
            <span className="rev-kpi-value" style={{ fontSize: "var(--fs-lg)" }}>{credsReady ? "Listos" : "Faltan"}</span>
          </div>
          <div className={`rev-kpi ${establishment ? (establishment.ok ? "rev-kpi-ok" : "rev-kpi-warn") : "rev-kpi-warn"}`} title={establishmentError ?? undefined}>
            <span className="rev-kpi-label">Datos del establecimiento</span>
            <span className="rev-kpi-value" style={{ fontSize: "var(--fs-lg)" }}>{establishment ? (establishment.ok ? "Completos" : `Faltan ${missing.length}`) : "—"}</span>
          </div>
          <div className={`rev-kpi ${webServiceReady ? "rev-kpi-ok" : "rev-kpi-warn"}`}>
            <span className="rev-kpi-label">Web service</span>
            <span className="rev-kpi-value" style={{ fontSize: "var(--fs-lg)" }}>{webServiceReady ? "Listo" : "Bloqueado"}</span>
          </div>
          <div className={`rev-kpi ${submissionsError ? "rev-kpi-warn" : rejected ? "rev-kpi-error" : "rev-kpi-ok"}`} title={submissionsError ?? undefined}>
            <span className="rev-kpi-label">Rechazados / fallidos</span>
            {/* "—" when the history could not be loaded: a green 0 would be a lie. */}
            <span className="rev-kpi-value">{submissionsError ? "—" : rejected}</span>
          </div>
        </div>

        <div className="bo-actions" style={{ marginTop: "var(--space-4)" }}>
          <button type="button" onClick={handleTest} disabled={busy}>
            {busy ? (
              <>
                <Spinner size="sm" /> …
              </>
            ) : (
              "Probar conexión"
            )}
          </button>
          <button type="button" onClick={handleGenerateBatch} disabled={busy || !form.batchExportEnabled}>
            Generar lote de exportación
          </button>
          <button type="button" onClick={() => navigateTo("ComplianceInbox")}>
            Bandeja de cumplimiento
          </button>
          <button type="button" onClick={() => navigateTo("GuestRegisterSettings")}>
            Registro de viajeros
          </button>
        </div>
        {status ? (
          <p
            className={/guardada|generado|encolado|conexión/.test(status) ? "bo-status ok" : "bo-muted"}
            style={{ marginTop: "var(--space-3)", display: "inline-flex", textTransform: "none", letterSpacing: 0 }}
          >
            {status}
          </p>
        ) : null}
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Alta en el MIR</p>
            <h3 style={{ margin: 0 }}>Establecimiento</h3>
          </div>
          {establishment ? (
            <span className={`bo-status ${establishment.ok ? "ok" : "warn"}`} style={{ textTransform: "none" }}>
              {establishment.ok ? "Datos completos" : `Faltan ${missing.length} dato${missing.length === 1 ? "" : "s"}`}
            </span>
          ) : null}
        </div>
        {establishment ? (
          <>
            <div className="bo-grid three">
              {(Object.keys(ESTABLISHMENT_FIELD_LABELS) as Array<keyof SesEstablishment["establishment"]>).map((key) => {
                const value = establishment.establishment[key];
                const isMissing = missing.includes(key);
                return (
                  <div key={key} className="bo-row" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                    <span className="bo-muted">{ESTABLISHMENT_FIELD_LABELS[key]}</span>
                    {value ? <strong>{value}</strong> : <span className={`bo-status ${isMissing ? "warn" : "info"}`} style={{ textTransform: "none" }}>{isMissing ? "falta" : "—"}</span>}
                  </div>
                );
              })}
            </div>
            {!establishment.ok ? (
              <p className="bo-muted" style={{ marginTop: "var(--space-3)" }}>
                SES.HOSPEDAJES rechaza el alta sin estos datos. El NIF, la razón social y la dirección se editan en el perfil del establecimiento; el
                código INE, el código postal y el número de registro turístico en Ajustes fiscales.
              </p>
            ) : null}
            <div className="bo-actions">
              <button type="button" onClick={() => navigateTo("PropertyProfileSetupForm")}>
                Perfil del establecimiento
              </button>
              <button type="button" onClick={() => navigateTo("TaxComplianceSettings")}>
                Ajustes fiscales
              </button>
              <button type="button" onClick={() => void loadEstablishment()}>
                ↻
              </button>
            </div>
          </>
        ) : (
          <ErrorState title="Datos del establecimiento no disponibles" message={establishmentError ?? undefined} onRetry={() => void loadEstablishment()} />
        )}
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Configuración del conector</p>
            <h3 style={{ margin: 0 }}>Códigos, credenciales y política de cola</h3>
          </div>
          {reporting?.updatedAt ? (
            <span className="bo-muted" style={{ textTransform: "none", letterSpacing: 0 }}>
              Actualizado {new Date(reporting.updatedAt).toLocaleString("es-ES")}
            </span>
          ) : null}
        </div>

        <div className="bo-grid three">
          <label className="bo-form-field">
            <span>
              Código de establecimiento <strong>obligatorio</strong>
            </span>
            <input value={form.establishmentCode} onChange={(e) => set("establishmentCode", e.target.value)} placeholder="EST-..." />
          </label>
          <label className="bo-form-field">
            <span>
              Código de arrendador <strong>obligatorio</strong>
            </span>
            <input value={form.landlordCode} onChange={(e) => set("landlordCode", e.target.value)} placeholder="ARR-..." />
          </label>
          <label className="bo-form-field">
            <span>Usuario web service</span>
            <input value={form.webServiceUsername} onChange={(e) => set("webServiceUsername", e.target.value)} />
          </label>
          <label className="bo-form-field">
            <span>Referencia del secreto (secret ref)</span>
            <input value={form.webServiceSecretRef} onChange={(e) => set("webServiceSecretRef", e.target.value)} placeholder="secret://ses-hospedajes/..." />
            <small>Nunca se almacena el secreto en claro: solo una referencia al gestor de secretos.</small>
          </label>
          <label className="bo-form-field">
            <span>Hora de lote diario</span>
            <input type="time" value={form.defaultBatchTime} onChange={(e) => set("defaultBatchTime", e.target.value)} />
          </label>
          <label className="bo-form-field">
            <span>Aviso antes del plazo (horas)</span>
            <input type="number" min="0" value={form.alertBeforeDeadlineHours} onChange={(e) => set("alertBeforeDeadlineHours", e.target.value)} />
          </label>
          <label className="bo-form-field">
            <span>Retención de registros (años)</span>
            <input type="number" min="0" value={form.retentionYears} onChange={(e) => set("retentionYears", e.target.value)} />
          </label>
        </div>

        <div className="bo-grid three" style={{ marginTop: "var(--space-2)" }}>
          {(
            [
              ["enabled", "Conector activo"],
              ["professionalActivity", "Actividad profesional (RD 933/2021)"],
              ["batchExportEnabled", "Exportación por lotes"],
              ["automaticSubmissionEnabled", "Envío automático (cola 24 h)"],
              ["webServiceEnabled", "Web service en producción"],
              ["officialSchemaConfigured", "Esquema/plantilla oficial cargado"]
            ] as Array<[keyof Form, string]>
          ).map(([key, label]) => (
            <label key={String(key)} className="bo-form-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={Boolean(form[key])} onChange={(e) => set(key, e.target.checked as Form[typeof key])} style={{ width: "auto" }} />
              <span style={{ fontWeight: 500 }}>{label}</span>
            </label>
          ))}
        </div>

        {form.automaticSubmissionEnabled && !webServiceReady ? (
          <p className="bo-status warn" style={{ display: "inline-flex", marginTop: "var(--space-2)", textTransform: "none", letterSpacing: 0 }}>
            El envío automático usará exportación por lotes hasta que el web service esté listo (credenciales + esquema oficial).
          </p>
        ) : null}

        <div className="bo-actions" style={{ marginTop: "var(--space-4)" }}>
          <button type="button" className="primary" onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Spinner size="sm" /> Guardando…
              </>
            ) : (
              "Guardar configuración"
            )}
          </button>
        </div>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Cola de envío</p>
            <h3 style={{ margin: 0 }}>Historial de partes enviados</h3>
          </div>
          <div className="bo-pill-row" style={{ display: "inline-flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
            {submissionsError ? null : (
              <>
                <span className="bo-chip">{submissionsTotal ?? submissions.length} en total</span>
                <span className="bo-chip">{counts.queued ?? 0} en cola</span>
                <span className="bo-chip">{counts.accepted ?? 0} aceptados</span>
                {rejected ? <span className="bo-status error">{rejected} rechazados/fallidos</span> : null}
              </>
            )}
            <div style={{ minWidth: 180 }}>
              <CocoaSelect value={statusFilter} onChange={setStatusFilter} options={STATUS_FILTER_OPTIONS} size="small" />
            </div>
            <button type="button" onClick={() => void loadSubmissions()} disabled={submissionsLoading} aria-label="Recargar historial">
              ↻
            </button>
          </div>
        </div>
        {submissionsError ? (
          <ErrorState
            title="No se pudo cargar el historial de envíos"
            message={`${submissionsError} Los partes SES tienen un plazo legal de 24 h: reintenta o revisa el conector.`}
            onRetry={() => void loadSubmissions()}
          />
        ) : submissionsLoading && submissions.length === 0 ? (
          <LoadingBlock label="Cargando envíos…" />
        ) : submissions.length === 0 ? (
          <EmptyState
            title="Sin partes enviados"
            message={statusFilter ? "Ningún envío con ese estado." : "Los partes aparecen aquí cuando el check-in encola el registro de viajeros de una reserva."}
          />
        ) : (
          <>
            <div className="bo-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th>Reserva</th>
                    <th>Estado</th>
                    <th>Referencia / error</th>
                    <th>Intentos</th>
                    <th>Enviado</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {submissions.map((s) => (
                    <tr key={s.id}>
                      <td>{(s.submissionType ?? "—").replace(/_/g, " ")}</td>
                      <td>{s.reservationId ? <code>{s.reservationId}</code> : "—"}</td>
                      <td>
                        <span className={`bo-status ${statusTone(s.status)}`} style={{ textTransform: "none" }}>
                          {STATUS_LABELS[s.status] ?? s.status}
                        </span>
                      </td>
                      <td>
                        {s.errorMessage ? (
                          <span className="bo-field-error">
                            {s.errorCode ? `${s.errorCode}: ` : ""}
                            {s.errorMessage}
                          </span>
                        ) : (
                          s.acknowledgementCode ?? s.trackingNumber ?? s.externalReference ?? "—"
                        )}
                      </td>
                      <td>{s.attempts ?? 0}</td>
                      <td>{fmtDateTime(s.submittedAt ?? s.createdAt)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <CocoaButton variant="plain" size="small" onClick={() => setDetailId(s.id)}>
                          Ver XML
                        </CocoaButton>
                        {RETRYABLE.has(s.status) ? (
                          <CocoaButton variant="plain" size="small" onClick={() => void handleRetry(s.id)} disabled={retryingId === s.id} loading={retryingId === s.id}>
                            Reintentar
                          </CocoaButton>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {nextCursor ? (
              <div style={{ display: "flex", justifyContent: "center", marginTop: "var(--space-3)" }}>
                <CocoaButton variant="bordered" tone="neutral" onClick={() => void loadSubmissions({ cursor: nextCursor, append: true })} disabled={submissionsLoading} loading={submissionsLoading}>
                  Cargar más envíos
                </CocoaButton>
              </div>
            ) : null}
          </>
        )}
      </section>

      <SubmissionDetailPanel open={detailId !== null} authority="ses" submissionId={detailId} onClose={() => setDetailId(null)} onRetried={() => void loadSubmissions()} />
    </>
  );
}

export default SesHospedajesSettingsScreen;
