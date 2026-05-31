import { getActivePropertyId } from "../../services/activeProperty";
import { useEffect, useState } from "react";
import {
  fetchSesSettings,
  patchSesSettings,
  fetchSesSubmissions,
  retrySesSubmission,
  generateSesBatch,
  testSesConnection,
  type SesReportingSettings,
  type AuthoritySubmission
} from "../../services/sesApi";
import { LoadingBlock, ErrorState, Spinner } from "../../components/States";

const PROPERTY_ID = getActivePropertyId();

function nav(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

const STATUS_CLS: Record<AuthoritySubmission["status"], string> = {
  queued: "info",
  sent: "info",
  accepted: "ok",
  rejected: "error",
  failed: "error",
  annulled: "warn"
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

export function SesHospedajesSettingsScreen() {
  const [reporting, setReporting] = useState<SesReportingSettings | undefined>();
  const [form, setForm] = useState<Form>(toForm());
  const [submissions, setSubmissions] = useState<AuthoritySubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([fetchSesSettings(PROPERTY_ID), fetchSesSubmissions(PROPERTY_ID).catch(() => [])])
      .then(([settings, subs]) => {
        setReporting(settings.reporting);
        setForm(toForm(settings.reporting));
        setSubmissions(subs);
      })
      .catch(() => setError("No se pudo cargar la configuración SES.HOSPEDAJES."))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

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
      load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "No se pudo generar el lote.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRetry(id: string) {
    setBusy(true);
    try {
      await retrySesSubmission(id);
      setStatus("Reenvío encolado.");
      load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "No se pudo reintentar.");
    } finally {
      setBusy(false);
    }
  }

  // Live readiness derived from real settings.
  const credsReady = Boolean(form.establishmentCode && form.landlordCode);
  const webServiceReady = form.webServiceEnabled && form.officialSchemaConfigured && Boolean(form.webServiceSecretRef);
  const counts = submissions.reduce<Record<string, number>>((acc, s) => { acc[s.status] = (acc[s.status] ?? 0) + 1; return acc; }, {});
  const rejected = (counts.rejected ?? 0) + (counts.failed ?? 0);

  if (loading) return <section className="bo-card"><LoadingBlock label="Cargando configuración SES…" /></section>;
  if (error) return <section className="bo-card"><ErrorState message={error} onRetry={load} /></section>;

  return (
    <>
      <section className="bo-card">
        <div className="bo-card-head" style={{ marginBottom: "var(--space-2)" }}>
          <div>
            <p className="bo-page-eyebrow">Authority connector</p>
            <h2 className="bo-page-title" style={{ fontSize: "var(--fs-2xl)" }}>SES.HOSPEDAJES Settings</h2>
          </div>
          <span className={`bo-status ${credsReady ? "ok" : "warn"}`}>{credsReady ? "Codes configured" : "Setup required"}</span>
        </div>
        <p className="bo-page-subtitle" style={{ marginTop: 0 }}>
          Connector for the Spanish Ministry of Interior traveller register (RD 933/2021): establishment &amp; landlord codes,
          web-service credentials, batch export and the 24-hour submission queue.
        </p>

        <div className="rev-kpi-grid" style={{ marginTop: "var(--space-4)" }}>
          <div className={`rev-kpi ${credsReady ? "rev-kpi-ok" : "rev-kpi-warn"}`}>
            <span className="rev-kpi-label">Establishment &amp; landlord codes</span>
            <span className="rev-kpi-value" style={{ fontSize: "var(--fs-lg)" }}>{credsReady ? "Ready" : "Missing"}</span>
          </div>
          <div className={`rev-kpi ${form.batchExportEnabled ? "rev-kpi-ok" : "rev-kpi-warn"}`}>
            <span className="rev-kpi-label">Batch export</span>
            <span className="rev-kpi-value" style={{ fontSize: "var(--fs-lg)" }}>{form.batchExportEnabled ? "Enabled" : "Off"}</span>
          </div>
          <div className={`rev-kpi ${webServiceReady ? "rev-kpi-ok" : "rev-kpi-warn"}`}>
            <span className="rev-kpi-label">Web service</span>
            <span className="rev-kpi-value" style={{ fontSize: "var(--fs-lg)" }}>{webServiceReady ? "Ready" : "Blocked"}</span>
          </div>
          <div className={`rev-kpi ${rejected ? "rev-kpi-error" : "rev-kpi-ok"}`}>
            <span className="rev-kpi-label">Rejected / failed</span>
            <span className="rev-kpi-value">{rejected}</span>
          </div>
        </div>

        <div className="bo-actions" style={{ marginTop: "var(--space-4)" }}>
          <button type="button" onClick={handleTest} disabled={busy}>{busy ? <><Spinner size="sm" /> …</> : "Test connection"}</button>
          <button type="button" onClick={handleGenerateBatch} disabled={busy || !form.batchExportEnabled}>Generate batch export</button>
          <button type="button" onClick={() => nav("ComplianceInbox")}>Open Compliance Inbox</button>
        </div>
        {status ? <p className={/guardada|generado|encolado|conexión/.test(status) ? "bo-status ok" : "bo-muted"} style={{ marginTop: "var(--space-3)", display: "inline-flex", textTransform: "none", letterSpacing: 0 }}>{status}</p> : null}
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div><p className="bo-muted">Connector configuration</p><h3 style={{ margin: 0 }}>Codes, credentials &amp; queue policy</h3></div>
          {reporting?.updatedAt ? <span className="bo-muted" style={{ textTransform: "none", letterSpacing: 0 }}>Updated {new Date(reporting.updatedAt).toLocaleString("es-ES")}</span> : null}
        </div>

        <div className="bo-grid three">
          <label className="bo-form-field"><span>Código de establecimiento <strong>required</strong></span>
            <input value={form.establishmentCode} onChange={(e) => set("establishmentCode", e.target.value)} placeholder="EST-..." /></label>
          <label className="bo-form-field"><span>Código de arrendador <strong>required</strong></span>
            <input value={form.landlordCode} onChange={(e) => set("landlordCode", e.target.value)} placeholder="ARR-..." /></label>
          <label className="bo-form-field"><span>Usuario web service</span>
            <input value={form.webServiceUsername} onChange={(e) => set("webServiceUsername", e.target.value)} /></label>
          <label className="bo-form-field"><span>Referencia del secreto (secret ref)</span>
            <input value={form.webServiceSecretRef} onChange={(e) => set("webServiceSecretRef", e.target.value)} placeholder="secret://ses-hospedajes/..." />
            <small>Nunca se almacena el secreto en claro: solo una referencia al gestor de secretos.</small>
          </label>
          <label className="bo-form-field"><span>Hora de lote diario</span>
            <input type="time" value={form.defaultBatchTime} onChange={(e) => set("defaultBatchTime", e.target.value)} /></label>
          <label className="bo-form-field"><span>Aviso antes del plazo (horas)</span>
            <input type="number" min="0" value={form.alertBeforeDeadlineHours} onChange={(e) => set("alertBeforeDeadlineHours", e.target.value)} /></label>
          <label className="bo-form-field"><span>Retención de registros (años)</span>
            <input type="number" min="0" value={form.retentionYears} onChange={(e) => set("retentionYears", e.target.value)} /></label>
        </div>

        <div className="bo-grid three" style={{ marginTop: "var(--space-2)" }}>
          {([
            ["enabled", "Conector activo"],
            ["professionalActivity", "Actividad profesional (RD 933/2021)"],
            ["batchExportEnabled", "Exportación por lotes"],
            ["automaticSubmissionEnabled", "Envío automático (cola 24 h)"],
            ["webServiceEnabled", "Web service en producción"],
            ["officialSchemaConfigured", "Esquema/plantilla oficial cargado"]
          ] as Array<[keyof Form, string]>).map(([key, label]) => (
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
          <button type="button" className="primary" onClick={handleSave} disabled={saving}>{saving ? <><Spinner size="sm" /> Guardando…</> : "Guardar configuración"}</button>
        </div>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div><p className="bo-muted">Submission queue</p><h3 style={{ margin: 0 }}>Authority submissions</h3></div>
          <div className="bo-pill-row">
            <span className="bo-chip">{counts.queued ?? 0} queued</span>
            <span className="bo-chip">{counts.accepted ?? 0} accepted</span>
            {rejected ? <span className="bo-status error">{rejected} rejected/failed</span> : null}
          </div>
        </div>
        {submissions.length === 0 ? (
          <p className="bo-muted">No authority submissions yet. They appear here as guest-register records are queued.</p>
        ) : (
          <div className="bo-table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Authority</th><th>Status</th><th>Reference / error</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {submissions.slice(0, 30).map((s) => (
                  <tr key={s.id}>
                    <td>{s.submissionType.replace(/_/g, " ")}</td>
                    <td>{s.authorityType.replace(/_/g, " ")}</td>
                    <td><span className={`bo-status ${STATUS_CLS[s.status]}`}>{s.status}</span></td>
                    <td>{s.errorMessage ? <span className="bo-field-error">{s.errorCode ? `${s.errorCode}: ` : ""}{s.errorMessage}</span> : (s.externalReference ?? "—")}</td>
                    <td>{new Date(s.createdAt).toLocaleDateString("es-ES")}</td>
                    <td>{s.status === "rejected" || s.status === "failed" ? <button type="button" onClick={() => handleRetry(s.id)} disabled={busy}>Retry</button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
