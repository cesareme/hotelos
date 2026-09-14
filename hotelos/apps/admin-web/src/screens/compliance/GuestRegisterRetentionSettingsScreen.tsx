// Retención y privacidad del registro de viajeros (Tanda 3 · lote front-fiscal).
//
// Solo lectura sobre el bloque `privacy` (y `reporting.configurationJson.retentionYears`)
// de GET /compliance/spain/properties/:id/guest-register/settings. La política
// es fija en el servidor: la pantalla muestra los valores reales y lo dice.
import { useCallback, useEffect, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { fetchSesSettings, type SesSettings } from "../../services/sesApi";
import { ErrorState, LoadingBlock } from "../../components/States";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { toArray } from "../../utils/toArray";
import { navigateTo } from "../../lib/navigate";

const PROPERTY_ID = getActivePropertyId();

const VERIFICATION_LABELS: Record<string, string> = {
  email_code: "código por email",
  sms_code: "código por SMS",
  payment_match: "coincidencia con el pago",
  certificate: "certificado digital"
};

function yesNo(value: unknown): string {
  return value === true ? "Sí" : value === false ? "No" : "—";
}

export function GuestRegisterRetentionSettingsScreen() {
  const [settings, setSettings] = useState<SesSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSettings(await fetchSesSettings(PROPERTY_ID));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la política de retención.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !settings) {
    return (
      <section className="bo-card">
        <LoadingBlock label="Cargando política de retención…" />
      </section>
    );
  }
  if (error && !settings) {
    return (
      <section className="bo-card">
        <ErrorState title="No se pudo cargar la política" message={error} onRetry={() => void load()} />
      </section>
    );
  }

  const privacy = (settings?.privacy ?? {}) as Record<string, unknown>;
  const reportingCfg = (settings?.reporting?.configurationJson ?? {}) as Record<string, unknown>;
  const retentionYears = typeof reportingCfg.retentionYears === "number" ? reportingCfg.retentionYears : Number(reportingCfg.retentionYears) || 3;
  const methods = toArray<string>(privacy.onlineVerificationMethods);
  const imageDays = typeof privacy.documentImageRetentionDays === "number" ? privacy.documentImageRetentionDays : null;

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-5)" }}>
      <CocoaPageHeader
        eyebrow="Cumplimiento · Registro de viajeros"
        title="Retención y privacidad"
        subtitle="Minimización de datos, retención legal y tratamiento de imágenes de documentos de identidad"
        actions={
          <span style={{ display: "inline-flex", gap: "var(--cocoa-space-2)", flexWrap: "wrap" }}>
            <CocoaButton variant="plain" onClick={() => navigateTo("GuestRegisterSettings")}>
              Ajustes del registro
            </CocoaButton>
            <CocoaButton variant="plain" onClick={() => navigateTo("GdprRequestsScreen")}>
              Derechos RGPD
            </CocoaButton>
          </span>
        }
      />

      <div className="bo-status info" style={{ textTransform: "none" }}>
        Política fija, no configurable todavía: los valores proceden del servidor y se aplican a todas las propiedades. La retención de los partes de
        viajeros es la legal ({retentionYears} años desde el fin del servicio, Orden INT/1922/2003 y RD 933/2021).
      </div>

      <div className="bo-grid two">
        <CocoaCard variant="bordered" padding="md">
          <h3 style={{ marginTop: 0 }}>Retención de registros</h3>
          <div className="bo-row">
            <span>Partes de viajeros y acuses de la autoridad</span>
            <strong>{retentionYears} años</strong>
          </div>
          <div className="bo-row">
            <span>Imágenes de DNI / pasaporte / TIE</span>
            <strong>{imageDays === null ? "—" : imageDays === 0 ? "no se conservan (0 días)" : `${imageDays} días`}</strong>
          </div>
          <div className="bo-row">
            <span>Almacenar imagen del documento por defecto</span>
            <strong>{yesNo(privacy.storeIdImageDefault)}</strong>
          </div>
          <div className="bo-row">
            <span>Permitir almacenar imágenes (excepción manual)</span>
            <strong>{yesNo(privacy.allowIdImageStorage)}</strong>
          </div>
        </CocoaCard>

        <CocoaCard variant="bordered" padding="md">
          <h3 style={{ marginTop: 0 }}>OCR y verificación</h3>
          <div className="bo-row">
            <span>OCR temporal (se descarta tras extraer los campos)</span>
            <strong>{yesNo(privacy.temporaryOcrEnabled)}</strong>
          </div>
          <div className="bo-row">
            <span>OCR en el dispositivo preferido</span>
            <strong>{yesNo(privacy.onDeviceOcrPreferred)}</strong>
          </div>
          <div className="bo-row">
            <span>Verificación visual manual obligatoria</span>
            <strong>{yesNo(privacy.manualVisualVerificationRequired)}</strong>
          </div>
          <div className="bo-row">
            <span>Métodos de verificación online</span>
            <strong>{methods.length ? methods.map((method) => VERIFICATION_LABELS[method] ?? method).join(", ") : "—"}</strong>
          </div>
        </CocoaCard>
      </div>

      <CocoaCard variant="bordered" padding="md">
        <h3 style={{ marginTop: 0 }}>Acceso a datos sensibles</h3>
        <p className="bo-muted" style={{ margin: 0 }}>
          Números de documento, teléfono, email e identificadores de pago requieren el permiso <code>guest_register.view_sensitive</code>; cada vista o
          exportación genera un evento de auditoría. Las solicitudes de acceso, rectificación y supresión se tramitan desde Derechos RGPD.
        </p>
      </CocoaCard>
    </section>
  );
}

export default GuestRegisterRetentionSettingsScreen;
