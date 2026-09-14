// Ajustes de cumplimiento fiscal (Tanda 3 · lote front-fiscal).
//
// Real form over GET/PATCH /backoffice/properties/:id/compliance-settings plus
// status cards fed ONLY by real endpoints: /compliance/health (integration
// modes, VeriFactu software block when exposed), /properties/:id/ses/establishment
// (contract F) and /backoffice/properties/:id/taxes (contract C). When a source
// is unavailable the card says so instead of guessing.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { getActivePropertyId } from "../services/activeProperty";
import { ApiError } from "../services/api-client";
import {
  fetchComplianceHealth,
  fetchComplianceSettings,
  fetchSesEstablishment,
  patchComplianceSettings,
  sesEstablishmentIssueLabel,
  verifactuSoftwareStatus,
  type ComplianceHealthReport,
  type ComplianceSettings,
  type ComplianceSettingsPatch,
  type SesEstablishment
} from "../services/complianceApi";
import {
  FISCAL_TERRITORY_OPTIONS,
  TAX_REGION_OPTIONS,
  TOURISM_TAX_REGION_OPTIONS,
  TOURIST_TAX_TREATMENT_OPTIONS,
  fetchPropertyTaxes,
  figureForRegion,
  normalizeTaxRegionClient,
  taxRegionLabel,
  type PropertyTaxProfile,
  type TaxRegion,
  type TouristTaxTreatment
} from "../services/taxesApi";
import { useToast } from "../components/Toast";
import { ErrorState, LoadingBlock, Spinner } from "../components/States";
import { CocoaPageHeader } from "../components/cocoa/CocoaPageHeader";
import { CocoaCard } from "../components/cocoa/CocoaCard";
import { CocoaButton } from "../components/cocoa/CocoaButton";
import { CocoaSelect } from "../components/cocoa/CocoaSelect";
import { CocoaInput } from "../components/cocoa/CocoaInput";
import { CocoaScreenInstructionsCard } from "../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { DegradedValue } from "../components/cocoa-extras/DegradedValue";
import { TAX_COMPLIANCE_INSTRUCTIONS } from "../content/screen-instructions/taxes";
import { toArray } from "../utils/toArray";
import { navigateTo } from "../lib/navigate";

const PROPERTY_ID = getActivePropertyId();

function openPropertyTaxes() {
  navigateTo("PropertyTaxesScreen");
}

const COUNTRY_OPTIONS = [
  { value: "ES", label: "España" },
  { value: "PT", label: "Portugal" },
  { value: "FR", label: "Francia" },
  { value: "IT", label: "Italia" }
];

type Form = {
  country: string;
  taxRegion: TaxRegion | "";
  fiscalTerritory: string;
  tourismTaxRegion: string;
  sesHospedajesEnabled: boolean;
  verifactuEnabled: boolean;
  ticketbaiEnabled: boolean;
  siiEnabled: boolean;
  b2bEinvoiceEnabled: boolean;
  postalCode: string;
  ineMunicipalityCode: string;
  sesRegistryNumber: string;
  touristTaxTreatment: TouristTaxTreatment | "";
  ipsiOrdinanceConfirmed: boolean;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

/**
 * Fiscal text field as the API reports it. An explicit `null` from GET means
 * the value was cleared and must render empty — it must NOT fall back to the
 * stale copy in configurationJson (that fallback showed the old CP/INE after
 * a deletion). Only `undefined` (pre-Tanda-3 payload without the field) uses
 * the legacy configurationJson value.
 */
function fiscalText(value: string | null | undefined, legacy: unknown): string {
  if (value === null) return "";
  if (value !== undefined) return text(value);
  return text(legacy);
}

const FIVE_DIGITS_RE = /^\d{5}$/;
/** Spanish province codes 01–52 (CP prefix and INE province code share the numbering). */
const PROVINCE_CODE_RE = /^(0[1-9]|[1-4]\d|5[0-2])$/;
/** Mirror of the server's SES_REGISTRY_NUMBER_PATTERN (validateSesRegistryNumber): 3–64 alphanumerics or hyphens. */
const SES_REGISTRY_NUMBER_RE = /^[A-Za-z0-9-]{3,64}$/;

type FiscalCodeErrors = { postalCode?: string; ineMunicipalityCode?: string; sesRegistryNumber?: string };

/** Nullable text fields the PATCH clears with an explicit `null` (labels for the save feedback). */
const CLEARABLE_FIELD_LABELS: Record<"postalCode" | "ineMunicipalityCode" | "sesRegistryNumber", string> = {
  postalCode: "código postal",
  ineMunicipalityCode: "código INE",
  sesRegistryNumber: "nº de registro SES"
};

/**
 * Client mirror of the server rules (validatePostalCode / validateIneMunicipalityCode /
 * assertPostalAndIneCoherent / validateSesRegistryNumber): 5 digits, province 01–52,
 * CP + INE in the same province, registry number 3–64 [A-Za-z0-9-]. Empty values are
 * valid (they clear the field). The server re-validates and answers 400 regardless.
 */
function validateFiscalCodes(form: Pick<Form, "postalCode" | "ineMunicipalityCode" | "sesRegistryNumber">): FiscalCodeErrors {
  const errors: FiscalCodeErrors = {};
  const postalCode = form.postalCode.trim();
  const ine = form.ineMunicipalityCode.trim();
  const registry = form.sesRegistryNumber.trim();
  if (postalCode && (!FIVE_DIGITS_RE.test(postalCode) || !PROVINCE_CODE_RE.test(postalCode.slice(0, 2)))) {
    errors.postalCode = "El código postal debe tener 5 dígitos y empezar por el código de provincia (01–52).";
  }
  if (ine && (!FIVE_DIGITS_RE.test(ine) || !PROVINCE_CODE_RE.test(ine.slice(0, 2)))) {
    errors.ineMunicipalityCode = "El código INE debe tener 5 dígitos: 2 de provincia (01–52) + 3 de municipio.";
  }
  if (!errors.postalCode && !errors.ineMunicipalityCode && postalCode && ine && postalCode.slice(0, 2) !== ine.slice(0, 2)) {
    errors.ineMunicipalityCode = `El código postal (${postalCode}) y el código INE (${ine}) pertenecen a provincias distintas (${postalCode.slice(0, 2)} ≠ ${ine.slice(0, 2)}).`;
  }
  if (registry && !SES_REGISTRY_NUMBER_RE.test(registry)) {
    errors.sesRegistryNumber = "El número de registro SES.HOSPEDAJES debe tener entre 3 y 64 caracteres alfanuméricos o guiones, sin espacios.";
  }
  return errors;
}

function firstFiscalError(errors: FiscalCodeErrors): string | undefined {
  return errors.postalCode ?? errors.ineMunicipalityCode ?? errors.sesRegistryNumber;
}

function toForm(settings: ComplianceSettings): Form {
  const cfg = settings.configurationJson ?? {};
  return {
    country: settings.country || "ES",
    taxRegion: normalizeTaxRegionClient(settings.taxRegion) ?? "",
    // `null` from GET = no territory stored (the server treats it as common); only an
    // absent key (older payload) falls back to the legacy configurationJson copy.
    fiscalTerritory: fiscalText(settings.fiscalTerritory, cfg.fiscalTerritory) || "common",
    tourismTaxRegion: text(settings.tourismTaxRegion),
    sesHospedajesEnabled: Boolean(settings.sesHospedajesEnabled),
    verifactuEnabled: Boolean(settings.verifactuEnabled),
    ticketbaiEnabled: Boolean(settings.ticketbaiEnabled),
    siiEnabled: Boolean(settings.siiEnabled),
    b2bEinvoiceEnabled: Boolean(settings.b2bEinvoiceEnabled),
    postalCode: fiscalText(settings.postalCode, cfg.postalCode),
    ineMunicipalityCode: fiscalText(settings.ineMunicipalityCode, cfg.ineMunicipalityCode),
    sesRegistryNumber: fiscalText(settings.sesRegistryNumber, cfg.sesRegistryNumber),
    // Same null rule: the column is what the tax resolver reads, so a `null` renders "Sin definir".
    touristTaxTreatment: (settings.touristTaxTreatment === null
      ? ""
      : settings.touristTaxTreatment ?? (cfg.touristTaxTreatment as TouristTaxTreatment | undefined) ?? "") as TouristTaxTreatment | "",
    ipsiOrdinanceConfirmed: Boolean(settings.ipsiOrdinanceConfirmedAt ?? cfg.ipsiOrdinanceConfirmedAt)
  };
}

function modeLabel(mode: string | undefined): string {
  if (mode === "production") return "producción";
  if (mode === "preproduction") return "preproducción";
  if (mode === "sandbox") return "sandbox";
  return "—";
}

function StatusLine(props: { tone: "ok" | "warn" | "error" | "info"; children: ReactNode }) {
  return (
    <span className={`bo-status ${props.tone}`} style={{ textTransform: "none", letterSpacing: 0, display: "inline-flex" }}>
      {props.children}
    </span>
  );
}

export function TaxComplianceSettings() {
  const { showToast } = useToast();
  const [settings, setSettings] = useState<ComplianceSettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [rawRegion, setRawRegion] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState<ComplianceHealthReport | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [establishment, setEstablishment] = useState<SesEstablishment | null>(null);
  const [establishmentError, setEstablishmentError] = useState<string | null>(null);
  const [taxes, setTaxes] = useState<PropertyTaxProfile | null>(null);
  const [taxesError, setTaxesError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [settingsResult, healthResult, establishmentResult, taxesResult] = await Promise.allSettled([
      fetchComplianceSettings(PROPERTY_ID),
      fetchComplianceHealth(),
      fetchSesEstablishment(PROPERTY_ID),
      fetchPropertyTaxes(PROPERTY_ID)
    ]);
    if (settingsResult.status === "fulfilled") {
      setSettings(settingsResult.value);
      setForm(toForm(settingsResult.value));
      setRawRegion(text(settingsResult.value.taxRegion));
    } else {
      setError(settingsResult.reason instanceof Error ? settingsResult.reason.message : "No se pudo cargar la configuración de cumplimiento.");
    }
    if (healthResult.status === "fulfilled") {
      setHealth(healthResult.value);
      setHealthError(null);
    } else {
      setHealth(null);
      setHealthError(healthResult.reason instanceof Error ? healthResult.reason.message : "No disponible");
    }
    if (establishmentResult.status === "fulfilled") {
      setEstablishment(establishmentResult.value);
      setEstablishmentError(null);
    } else {
      setEstablishment(null);
      setEstablishmentError(establishmentResult.reason instanceof Error ? establishmentResult.reason.message : "No disponible");
    }
    if (taxesResult.status === "fulfilled") {
      setTaxes(taxesResult.value);
      setTaxesError(null);
    } else {
      setTaxes(null);
      setTaxesError(taxesResult.reason instanceof Error ? taxesResult.reason.message : "No disponible");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  async function handleSave() {
    if (!form || !settings) return;
    if (!form.taxRegion) {
      showToast("Selecciona la región fiscal: determina la figura del impuesto (IVA/IGIC/IPSI).", { variant: "error" });
      return;
    }
    const firstCodeError = firstFiscalError(validateFiscalCodes(form));
    if (firstCodeError) {
      showToast(firstCodeError, { variant: "error" });
      return;
    }
    setSaving(true);
    try {
      // Emptied CP / INE / registry inputs travel as an explicit `null`: the
      // API clears the stored value (a missing key would keep it, and "" is
      // never sent). The GET after saving then answers `null` for the field.
      const patch: ComplianceSettingsPatch = {
        country: form.country,
        taxRegion: form.taxRegion,
        fiscalTerritory: form.fiscalTerritory || "common",
        tourismTaxRegion: form.tourismTaxRegion,
        sesHospedajesEnabled: form.sesHospedajesEnabled,
        verifactuEnabled: form.verifactuEnabled,
        ticketbaiEnabled: form.ticketbaiEnabled,
        siiEnabled: form.siiEnabled,
        b2bEinvoiceEnabled: form.b2bEinvoiceEnabled,
        postalCode: form.postalCode.trim() || null,
        ineMunicipalityCode: form.ineMunicipalityCode.trim() || null,
        sesRegistryNumber: form.sesRegistryNumber.trim() || null
      };
      if (form.touristTaxTreatment) patch.touristTaxTreatment = form.touristTaxTreatment;
      const currentlyConfirmed = Boolean(settings.ipsiOrdinanceConfirmedAt);
      if (form.ipsiOrdinanceConfirmed !== currentlyConfirmed) patch.ipsiOrdinanceConfirmed = form.ipsiOrdinanceConfirmed;
      // Fields this save explicitly cleared (had a stored value, now travel as null).
      const cleared = (Object.keys(CLEARABLE_FIELD_LABELS) as Array<keyof typeof CLEARABLE_FIELD_LABELS>).filter(
        (key) => patch[key] === null && fiscalText(settings[key], (settings.configurationJson ?? {})[key]) !== ""
      );
      const saved = await patchComplianceSettings(PROPERTY_ID, patch);
      setSettings(saved);
      setForm(toForm(saved));
      setRawRegion(text(saved.taxRegion));
      showToast(
        cleared.length > 0
          ? `Configuración fiscal guardada. Borrado: ${cleared.map((key) => CLEARABLE_FIELD_LABELS[key]).join(", ")}.`
          : "Configuración fiscal guardada.",
        { variant: "success" }
      );
      // Re-read everything from GET so the form shows what is really stored
      // (including `null` for cleared fields) and the status cards refresh.
      await load();
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 403
          ? "No tienes permiso para modificar la configuración fiscal (compliance.configure)."
          : err instanceof Error
            ? err.message
            : "No se pudo guardar la configuración.";
      showToast(message, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  const integrations = useMemo(() => toArray<ComplianceHealthReport["integrations"][number]>(health?.integrations), [health]);
  const verifactuHealth = integrations.find((integration) => integration.integration === "verifactu");
  const sesHealth = integrations.find((integration) => integration.integration === "ses_hospedajes");
  const tbaiHealth = integrations.find((integration) => integration.integration === "tbai");
  const igicHealth = integrations.find((integration) => integration.integration === "igic");
  const software = verifactuSoftwareStatus(health);
  const degraded = useMemo(() => toArray<string>(health?.degraded), [health]);
  const establishmentMissing = useMemo(() => toArray<string>(establishment?.missing), [establishment]);
  const taxWarnings = useMemo(() => toArray<string>(taxes?.warnings), [taxes]);
  const fiscalErrors = useMemo<FiscalCodeErrors>(() => (form ? validateFiscalCodes(form) : {}), [form]);
  const figure = form?.taxRegion ? figureForRegion(form.taxRegion) : null;
  const isIpsi = form?.taxRegion === "ES_CEUTA" || form?.taxRegion === "ES_MELILLA";
  const isForal = Boolean(form?.fiscalTerritory && form.fiscalTerritory !== "common");
  const unrecognisedRegion = rawRegion && !normalizeTaxRegionClient(rawRegion);

  if (loading && !form) {
    return (
      <section className="bo-card">
        <LoadingBlock label="Cargando configuración fiscal…" />
      </section>
    );
  }
  if (error && !form) {
    return (
      <section className="bo-card">
        <ErrorState title="No se pudo cargar la configuración fiscal" message={error} onRetry={() => void load()} />
      </section>
    );
  }
  if (!form || !settings) return null;

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-5)" }}>
      <CocoaPageHeader
        eyebrow="Cumplimiento · Fiscal"
        title="Ajustes de cumplimiento fiscal"
        subtitle="País, región fiscal, conectores obligatorios y datos del establecimiento"
        actions={
          <span style={{ display: "inline-flex", gap: "var(--cocoa-space-2)", flexWrap: "wrap" }}>
            <CocoaButton variant="plain" onClick={openPropertyTaxes}>
              Impuestos de la propiedad
            </CocoaButton>
            <CocoaButton variant="plain" onClick={() => navigateTo("FiscalDashboard")}>
              Centro fiscal
            </CocoaButton>
            <CocoaButton variant="plain" onClick={() => navigateTo("ComplianceInbox")}>
              Bandeja de cumplimiento
            </CocoaButton>
          </span>
        }
      />

      <CocoaScreenInstructionsCard
        title="Ajustes de cumplimiento fiscal"
        description={TAX_COMPLIANCE_INSTRUCTIONS.whatIsThis}
        steps={TAX_COMPLIANCE_INSTRUCTIONS.howToUse}
        dismissible
        persistKey="tax-compliance-settings"
      />

      {!settings.provisioned ? (
        <StatusLine tone="info">Esta propiedad aún no tiene ajustes de cumplimiento guardados: se muestran los valores por defecto. Al guardar se crea el registro.</StatusLine>
      ) : null}
      {unrecognisedRegion ? (
        <StatusLine tone="warn">
          La región fiscal guardada («{rawRegion}») no es un código reconocido. Selecciona la región canónica y guarda para que el resolutor de impuestos la aplique.
        </StatusLine>
      ) : null}

      {/* ---- Real status cards ---- */}
      <div className="bo-grid two">
        <CocoaCard variant="bordered" padding="md">
          <div className="bo-card-head">
            <h3 style={{ margin: 0 }}>Impuestos indirectos</h3>
            <StatusLine tone={taxes ? (taxWarnings.length > 0 || !taxes.taxRegion ? "warn" : "ok") : "info"}>
              {taxes ? (taxes.taxRegion ? `${taxes.figure} · Impuesto ${taxes.impuesto}` : "sin región") : "no disponible"}
            </StatusLine>
          </div>
          {taxes ? (
            <>
              <p style={{ margin: "0 0 var(--cocoa-space-2)" }}>
                {taxRegionLabel(taxes.taxRegion)} · {toArray(taxes.rates).length} tipos vigentes
                {taxes.regionSource !== "property" ? " · región derivada, confirma en el perfil" : ""}
              </p>
              {taxWarnings.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
                  {taxWarnings.map((warning, index) => (
                    <li key={`${index}-${warning}`} className="bo-muted">
                      {warning}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="bo-muted" style={{ margin: 0 }}>
              No se pudo leer el perfil de impuestos{taxesError ? `: ${taxesError}` : "."}
            </p>
          )}
          <div className="bo-actions">
            <CocoaButton variant="plain" size="small" onClick={openPropertyTaxes}>
              Ver tipos por concepto
            </CocoaButton>
          </div>
        </CocoaCard>

        <CocoaCard variant="bordered" padding="md">
          <div className="bo-card-head">
            <h3 style={{ margin: 0 }}>VeriFactu (AEAT)</h3>
            <StatusLine tone={form.verifactuEnabled ? (verifactuHealth?.readyForReal ? "ok" : "warn") : "info"}>
              {form.verifactuEnabled ? "activado" : "desactivado"}
            </StatusLine>
          </div>
          {verifactuHealth ? (
            <p style={{ margin: "0 0 var(--cocoa-space-2)" }}>
              Modo {modeLabel(verifactuHealth.mode)} · certificado {verifactuHealth.cert.configured ? (verifactuHealth.cert.certPathExists ? "configurado" : "ruta no encontrada") : "sin configurar"}
              {verifactuHealth.notes ? <span className="bo-muted"> · {verifactuHealth.notes}</span> : null}
            </p>
          ) : (
            <p className="bo-muted" style={{ margin: "0 0 var(--cocoa-space-2)" }}>
              Estado del conector no disponible{healthError ? `: ${healthError}` : "."}
            </p>
          )}
          {software ? (
            software.ok ? (
              <StatusLine tone="ok">Bloque SistemaInformatico completo</StatusLine>
            ) : (
              <div>
                <StatusLine tone="error">Software VeriFactu incompleto</StatusLine>
                <ul style={{ margin: "var(--cocoa-space-2) 0 0", paddingLeft: "1.2em" }}>
                  {software.errors.map((message, index) => (
                    <li key={`${index}-${message}`} className="bo-muted">
                      {message}
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : (
            <p className="bo-muted" style={{ margin: 0 }}>
              El API no expone todavía la validación del bloque SistemaInformatico (NIF del productor, versión, instalación).
            </p>
          )}
          <div className="bo-actions">
            <CocoaButton variant="plain" size="small" onClick={() => navigateTo("FiscalDashboard")}>
              Colas y envíos
            </CocoaButton>
          </div>
        </CocoaCard>

        <CocoaCard variant="bordered" padding="md">
          <div className="bo-card-head">
            <h3 style={{ margin: 0 }}>SES.HOSPEDAJES (MIR)</h3>
            <StatusLine tone={form.sesHospedajesEnabled ? (establishment?.ok ? "ok" : "warn") : "info"}>
              {form.sesHospedajesEnabled ? "activado" : "desactivado"}
            </StatusLine>
          </div>
          {sesHealth ? (
            <p style={{ margin: "0 0 var(--cocoa-space-2)" }}>
              Modo {modeLabel(sesHealth.mode)} · certificado {sesHealth.cert.configured ? (sesHealth.cert.certPathExists ? "configurado" : "ruta no encontrada") : "sin configurar"}
            </p>
          ) : null}
          {establishment ? (
            establishment.ok ? (
              <StatusLine tone="ok">Datos del establecimiento completos</StatusLine>
            ) : (
              <div>
                <StatusLine tone="warn">Faltan datos del establecimiento</StatusLine>
                <p className="bo-muted" style={{ margin: "var(--cocoa-space-2) 0 0" }}>
                  {establishmentMissing.map(sesEstablishmentIssueLabel).join(", ")}
                </p>
              </div>
            )
          ) : (
            <p className="bo-muted" style={{ margin: 0 }}>
              Datos del establecimiento no disponibles{establishmentError ? `: ${establishmentError}` : "."}
            </p>
          )}
          <div className="bo-actions">
            <CocoaButton variant="plain" size="small" onClick={() => navigateTo("SesHospedajesSettings")}>
              Conector SES
            </CocoaButton>
            <CocoaButton variant="plain" size="small" onClick={() => navigateTo("GuestRegisterSettings")}>
              Registro de viajeros
            </CocoaButton>
            <CocoaButton variant="plain" size="small" onClick={() => navigateTo("AuthorityRoutingSettings")}>
              Enrutamiento
            </CocoaButton>
            <CocoaButton variant="plain" size="small" onClick={() => navigateTo("GuestRegisterRetentionSettings")}>
              Retención
            </CocoaButton>
          </div>
        </CocoaCard>

        <CocoaCard variant="bordered" padding="md">
          <div className="bo-card-head">
            <h3 style={{ margin: 0 }}>Territorio foral y Canarias</h3>
            <StatusLine tone={isForal ? (form.ticketbaiEnabled ? "ok" : "warn") : "info"}>{isForal ? "TicketBAI" : "territorio común"}</StatusLine>
          </div>
          <p style={{ margin: "0 0 var(--cocoa-space-2)" }}>
            {isForal
              ? `Las facturas se envían a la Hacienda Foral (${FISCAL_TERRITORY_OPTIONS.find((option) => option.value === form.fiscalTerritory)?.label ?? form.fiscalTerritory}).${tbaiHealth ? ` Conector TBAI en modo ${modeLabel(tbaiHealth.mode)}.` : ""}`
              : "Las facturas se envían a la AEAT por VeriFactu."}
            {form.taxRegion === "ES_CANARIAS" && igicHealth ? ` IGIC en modo ${modeLabel(igicHealth.mode)}.` : ""}
          </p>
          <p style={{ margin: 0 }}>
            Últimas 24 h · VeriFactu:{" "}
            <DegradedValue label="verifactuSubmissionsLast24h" degraded={degraded}>
              {health ? (health.stats.verifactuSubmissionsLast24h ?? "—") : "—"}
            </DegradedValue>{" "}
            envíos /{" "}
            <DegradedValue label="verifactuRejectedLast24h" degraded={degraded}>
              {health ? (health.stats.verifactuRejectedLast24h ?? "—") : "—"}
            </DegradedValue>{" "}
            rechazos · SES:{" "}
            <DegradedValue label="sesSubmissionsLast24h" degraded={degraded}>
              {health ? (health.stats.sesSubmissionsLast24h ?? "—") : "—"}
            </DegradedValue>{" "}
            envíos /{" "}
            <DegradedValue label="sesRejectedLast24h" degraded={degraded}>
              {health ? (health.stats.sesRejectedLast24h ?? "—") : "—"}
            </DegradedValue>{" "}
            rechazos
          </p>
          <div className="bo-actions">
            <CocoaButton variant="plain" size="small" onClick={() => navigateTo("TbaiForal")}>
              TicketBAI
            </CocoaButton>
            <CocoaButton variant="plain" size="small" onClick={() => navigateTo("FiscalSubmissionsCenter")}>
              Centro de envíos
            </CocoaButton>
          </div>
        </CocoaCard>
      </div>

      {/* ---- Form ---- */}
      <CocoaCard variant="bordered" padding="md">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted" style={{ margin: 0 }}>Configuración</p>
            <h3 style={{ margin: 0 }}>Región fiscal y conectores</h3>
          </div>
          {settings.updatedAt ? (
            <span className="bo-muted" style={{ textTransform: "none", letterSpacing: 0 }}>
              Actualizado {new Date(settings.updatedAt).toLocaleString("es-ES")}
            </span>
          ) : null}
        </div>

        <div className="bo-grid three">
          <label className="bo-form-field">
            <span>País</span>
            <CocoaSelect value={form.country} onChange={(value) => set("country", value)} options={COUNTRY_OPTIONS} />
          </label>
          <label className="bo-form-field">
            <span>Región fiscal <strong>obligatorio</strong></span>
            <CocoaSelect
              value={form.taxRegion}
              onChange={(value) => set("taxRegion", value as TaxRegion | "")}
              options={[{ value: "", label: "Seleccionar…" }, ...TAX_REGION_OPTIONS.map((option) => ({ value: option.value, label: option.label }))]}
            />
            <small>{figure ? `Figura: ${figure.figure} · Impuesto VeriFactu ${figure.impuesto}` : "Determina IVA, IGIC o IPSI."}</small>
          </label>
          <label className="bo-form-field">
            <span>Territorio foral (ruta de envío)</span>
            <CocoaSelect
              value={form.fiscalTerritory}
              onChange={(value) => set("fiscalTerritory", value)}
              options={FISCAL_TERRITORY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            />
          </label>
          <label className="bo-form-field">
            <span>Tasa turística autonómica</span>
            <CocoaSelect
              value={form.tourismTaxRegion}
              onChange={(value) => set("tourismTaxRegion", value)}
              options={[
                ...TOURISM_TAX_REGION_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
                ...(form.tourismTaxRegion && !TOURISM_TAX_REGION_OPTIONS.some((option) => option.value === form.tourismTaxRegion)
                  ? [{ value: form.tourismTaxRegion, label: `Valor actual: ${form.tourismTaxRegion}` }]
                  : [])
              ]}
            />
          </label>
          <label className="bo-form-field">
            <span>Tratamiento de la tasa turística</span>
            <CocoaSelect
              value={form.touristTaxTreatment}
              onChange={(value) => set("touristTaxTreatment", value as TouristTaxTreatment | "")}
              options={[{ value: "", label: "Sin definir" }, ...TOURIST_TAX_TREATMENT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))]}
            />
          </label>
          <label className="bo-form-field">
            <span>Código postal</span>
            <CocoaInput
              value={form.postalCode}
              onChange={(value) => set("postalCode", value)}
              placeholder="15001"
              inputMode="numeric"
              error={Boolean(fiscalErrors.postalCode)}
            />
            {fiscalErrors.postalCode ? (
              <small className="bo-status error" style={{ textTransform: "none", letterSpacing: 0 }}>{fiscalErrors.postalCode}</small>
            ) : (
              <small>Cinco dígitos. Déjalo vacío para borrar el valor guardado.</small>
            )}
          </label>
          <label className="bo-form-field">
            <span>Código INE del municipio</span>
            <CocoaInput
              value={form.ineMunicipalityCode}
              onChange={(value) => set("ineMunicipalityCode", value)}
              placeholder="15030"
              inputMode="numeric"
              error={Boolean(fiscalErrors.ineMunicipalityCode)}
            />
            {fiscalErrors.ineMunicipalityCode ? (
              <small className="bo-status error" style={{ textTransform: "none", letterSpacing: 0 }}>{fiscalErrors.ineMunicipalityCode}</small>
            ) : (
              <small>Cinco dígitos (provincia + municipio), misma provincia que el CP; SES.HOSPEDAJES lo exige en la dirección del establecimiento. Vacío = borrar.</small>
            )}
          </label>
          <label className="bo-form-field">
            <span>Nº de registro turístico (SES)</span>
            <CocoaInput
              value={form.sesRegistryNumber}
              onChange={(value) => set("sesRegistryNumber", value)}
              placeholder="H-CO-000123"
              error={Boolean(fiscalErrors.sesRegistryNumber)}
            />
            {fiscalErrors.sesRegistryNumber ? (
              <small className="bo-status error" style={{ textTransform: "none", letterSpacing: 0 }}>{fiscalErrors.sesRegistryNumber}</small>
            ) : (
              <small>Entre 3 y 64 caracteres alfanuméricos o guiones. Vacío = borrar el número guardado.</small>
            )}
          </label>
        </div>

        <div className="bo-grid three" style={{ marginTop: "var(--cocoa-space-2)" }}>
          {(
            [
              ["sesHospedajesEnabled", "SES.HOSPEDAJES (parte de viajeros)"],
              ["verifactuEnabled", "VeriFactu (registro de facturación AEAT)"],
              ["ticketbaiEnabled", "TicketBAI (haciendas forales)"],
              ["siiEnabled", "SII (suministro inmediato de información)"],
              ["b2bEinvoiceEnabled", "Factura electrónica B2B"]
            ] as Array<[keyof Form, string]>
          ).map(([key, label]) => (
            <label key={String(key)} className="bo-form-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={Boolean(form[key])} onChange={(event) => set(key, event.currentTarget.checked as Form[typeof key])} style={{ width: "auto" }} />
              <span style={{ fontWeight: 500 }}>{label}</span>
            </label>
          ))}
          {isIpsi ? (
            <label className="bo-form-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={form.ipsiOrdinanceConfirmed}
                onChange={(event) => set("ipsiOrdinanceConfirmed", event.currentTarget.checked)}
                style={{ width: "auto" }}
              />
              <span style={{ fontWeight: 500 }}>Tipos IPSI verificados con la ordenanza vigente</span>
            </label>
          ) : null}
        </div>

        {isForal && !form.ticketbaiEnabled ? (
          <StatusLine tone="warn">Has seleccionado un territorio foral sin activar TicketBAI: las facturas no se enviarán a la Hacienda Foral.</StatusLine>
        ) : null}
        {form.taxRegion === "ES_CANARIAS" && form.tourismTaxRegion ? (
          <StatusLine tone="warn">Canarias no tiene tasa turística autonómica en 2026; revisa la región de tasa turística.</StatusLine>
        ) : null}

        <div className="bo-actions" style={{ marginTop: "var(--cocoa-space-4)" }}>
          <CocoaButton
            variant="filled"
            tone="accent"
            onClick={() => void handleSave()}
            disabled={saving || Boolean(firstFiscalError(fiscalErrors))}
            loading={saving}
          >
            {saving ? (
              <>
                <Spinner size="sm" /> Guardando…
              </>
            ) : (
              "Guardar configuración"
            )}
          </CocoaButton>
          <CocoaButton variant="plain" onClick={() => navigateTo("PropertyProfileSetupForm")}>
            Perfil del establecimiento
          </CocoaButton>
        </div>
      </CocoaCard>
    </section>
  );
}

export default TaxComplianceSettings;
