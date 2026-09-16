// Retención y privacidad del registro de viajeros — Cumplimiento › Registro de
// viajeros › Conservación (/cumplimiento/registro-viajeros/conservacion, hosted
// in RegistroViajerosTabs). Cocoa 22 · ola 8 · lote 8-A, archetype «formulario /
// ajustes» (read only: the policy is fixed on the server).
//
// Read only over the `privacy` block (and `reporting.configurationJson.retentionYears`)
// of GET /compliance/spain/properties/:id/guest-register/settings: the screen shows
// the real values and says so. The head keeps `pageHead(embedded)` (host context
// inside the container, CocoaPageHeader standalone; the `embedded` prop is the L1c
// bridge the tabs contract still asserts); the body is Cocoa 22: a callout, two
// sections of key/value rows and the note on sensitive data.

import { useCallback, useEffect, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { fetchSesSettings, type SesSettings } from "../../services/sesApi";
import { pageHead } from "../tabs/tab-helpers";
import { useTabHost } from "../tabs/TabHost";
import { toArray } from "../../utils/toArray";
import { navigateTo } from "../../lib/navigate";
import { plural } from "../../lib/format";
import { STATUS_LABELS } from "../../content/actions";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaGrid, CocoaSection, CocoaSkeleton, CocoaSpan, CocoaState } from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

const VERIFICATION_LABELS: Record<string, string> = {
  email_code: "código por email",
  sms_code: "código por SMS",
  payment_match: "coincidencia con el pago",
  certificate: "certificado digital"
};

function yesNo(value: unknown): string {
  return value === true ? STATUS_LABELS.yes : value === false ? STATUS_LABELS.no : "—";
}

export function GuestRegisterRetentionSettingsScreen({ embedded = false }: { embedded?: boolean } = {}) {
  // Inside a tab container the page header belongs to the container: render a section head instead.
  const Head = pageHead(embedded);
  const host = useTabHost();
  const hosted = embedded || host !== null;
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

  const privacy = (settings?.privacy ?? {}) as Record<string, unknown>;
  const reportingCfg = (settings?.reporting?.configurationJson ?? {}) as Record<string, unknown>;
  const retentionYears = typeof reportingCfg.retentionYears === "number" ? reportingCfg.retentionYears : Number(reportingCfg.retentionYears) || 3;
  const methods = toArray<string>(privacy.onlineVerificationMethods);
  const imageDays = typeof privacy.documentImageRetentionDays === "number" ? privacy.documentImageRetentionDays : null;

  let body;
  if (loading && !settings) {
    body = <CocoaSkeleton.Grid rows={[[12], [6, 6], [12]]} height={160} label="Cargando la política de retención" />;
  } else if (error && !settings) {
    body = <CocoaState kind="error" title="No se pudo cargar la política" message={error} onRetry={() => void load()} />;
  } else {
    body = (
      <>
        <CocoaCallout tone="info" title="Política fija, no configurable todavía">
          Los valores proceden del servidor y se aplican a todas las propiedades. La retención de los partes de viajeros es la legal (
          {plural(retentionYears, "año", "años")} desde el fin del servicio, Orden INT/1922/2003 y RD 933/2021).
        </CocoaCallout>

        <CocoaGrid align="start">
          <CocoaSpan cols={6} min={320}>
            <CocoaSection title="Retención de registros">
              <ul className="c22-section__list" aria-label="Retención de registros">
                <li>
                  <span>Partes de viajeros y acuses de la autoridad</span>
                  <strong>{plural(retentionYears, "año", "años")}</strong>
                </li>
                <li>
                  <span>Imágenes de DNI, pasaporte o TIE</span>
                  <strong>{imageDays === null ? "—" : imageDays === 0 ? "no se conservan" : plural(imageDays, "día", "días")}</strong>
                </li>
                <li>
                  <span>Almacenar imagen del documento por defecto</span>
                  <strong>{yesNo(privacy.storeIdImageDefault)}</strong>
                </li>
                <li>
                  <span>Permitir almacenar imágenes (excepción manual)</span>
                  <strong>{yesNo(privacy.allowIdImageStorage)}</strong>
                </li>
              </ul>
            </CocoaSection>
          </CocoaSpan>

          <CocoaSpan cols={6} min={320}>
            <CocoaSection title="OCR y verificación">
              <ul className="c22-section__list" aria-label="OCR y verificación">
                <li>
                  <span>OCR temporal (se descarta tras extraer los campos)</span>
                  <strong>{yesNo(privacy.temporaryOcrEnabled)}</strong>
                </li>
                <li>
                  <span>OCR en el dispositivo preferido</span>
                  <strong>{yesNo(privacy.onDeviceOcrPreferred)}</strong>
                </li>
                <li>
                  <span>Verificación visual manual obligatoria</span>
                  <strong>{yesNo(privacy.manualVisualVerificationRequired)}</strong>
                </li>
                <li>
                  <span>Métodos de verificación en línea</span>
                  {methods.length ? (
                    <span className="cocoa-cluster">
                      {methods.map((method) => (
                        <CocoaBadge key={method} tone="neutral" size="small">
                          {VERIFICATION_LABELS[method] ?? method}
                        </CocoaBadge>
                      ))}
                    </span>
                  ) : (
                    <strong>—</strong>
                  )}
                </li>
              </ul>
            </CocoaSection>
          </CocoaSpan>
        </CocoaGrid>

        <CocoaSection title="Acceso a datos sensibles">
          <p className="cocoa-note">
            Números de documento, teléfono, email e identificadores de pago requieren el permiso <code className="cocoa-mono">guest_register.view_sensitive</code>;
            cada vista o exportación genera un evento de auditoría. Las solicitudes de acceso, rectificación y supresión se tramitan desde Derechos RGPD.
          </p>
        </CocoaSection>
      </>
    );
  }

  return (
    <div className="cocoa-stack" data-gap="4">
      <Head
        eyebrow="Cumplimiento · Registro de viajeros"
        title="Retención y privacidad"
        subtitle={hosted ? undefined : "Minimización de datos, retención legal y tratamiento de imágenes de documentos de identidad."}
        actions={
          <>
            <CocoaButton variant="plain" size="small" onClick={() => navigateTo("GuestRegisterSettings")}>
              Ajustes del registro
            </CocoaButton>
            <CocoaButton variant="plain" size="small" onClick={() => navigateTo("GdprRequestsScreen")}>
              Derechos RGPD
            </CocoaButton>
          </>
        }
      />
      {body}
    </div>
  );
}

export default GuestRegisterRetentionSettingsScreen;
