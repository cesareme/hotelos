// Ajustes de cumplimiento fiscal — Configuración › Contabilidad y fiscal › Fiscal
// (/configuracion/contabilidad-fiscal/fiscal, hosted in ContabilidadFiscalTabs).
// Cocoa 22 · ola 10 · lote 10-D, archetype «formulario / ajustes»
// (docs/design/COCOA-22.md §4): CocoaPage (hosted: the container paints eyebrow
// and title) → status sections on the 12-column grid, each fed ONLY by a real
// endpoint — /compliance/health (integration modes, VeriFactu software block
// when exposed), /properties/:id/ses/establishment (contract F) and
// /backoffice/properties/:id/taxes (contract C); when a source is unavailable
// the section says so instead of guessing — → CocoaFormSection over GET/PATCH
// /backoffice/properties/:id/compliance-settings (region, territory, tourist
// tax, CP / INE / SES registry with the server rules mirrored in
// CocoaField.error, connector switches) → CocoaActionBar (Cancelar · Guardar
// configuración; ⌘/Ctrl+Enter saves) with a discard dialog. The fiscal
// identity of the issuer (NIF, razón social) belongs to the legal entity and
// is only linked from here (Configuración › Estructura societaria).
import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaGrid,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaSwitch,
  DegradedValue,
  type CocoaTone
} from "../components/cocoa";
import { CocoaScreenInstructionsCard } from "../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { TAX_COMPLIANCE_INSTRUCTIONS } from "../content/screen-instructions/taxes";
import { ACTIONS, STATUS_LABELS, confirmDiscard } from "../content/actions";
import { toArray } from "../utils/toArray";
import { navigateTo } from "../lib/navigate";
import { dateTime, number, plural } from "../lib/format";
import { treeHeaderFor } from "./tabs/tab-helpers";

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

type ConnectorKey = "sesHospedajesEnabled" | "verifactuEnabled" | "ticketbaiEnabled" | "siiEnabled" | "b2bEinvoiceEnabled";

/** Connector switches of the form, in the order they are painted. */
const CONNECTOR_TOGGLES: ReadonlyArray<readonly [ConnectorKey, string]> = [
  ["sesHospedajesEnabled", "SES.HOSPEDAJES (parte de viajeros)"],
  ["verifactuEnabled", "VeriFactu (registro de facturación AEAT)"],
  ["ticketbaiEnabled", "TicketBAI (haciendas forales)"],
  ["siiEnabled", "SII (suministro inmediato de información)"],
  ["b2bEinvoiceEnabled", "Factura electrónica B2B"]
];

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

function isSameForm(a: Form, b: Form): boolean {
  return (Object.keys(a) as Array<keyof Form>).every((key) => a[key] === b[key]);
}

function modeLabel(mode: string | undefined): string {
  if (mode === "production") return "producción";
  if (mode === "preproduction") return "preproducción";
  if (mode === "sandbox") return "pruebas";
  return "—";
}

/** Connector line of a health entry: mode and certificate, as the API reports them. */
function connectorLine(entry: ComplianceHealthReport["integrations"][number]): string {
  const certificate = entry.cert.configured ? (entry.cert.certPathExists ? "configurado" : "ruta no encontrada") : "sin configurar";
  return `Modo ${modeLabel(entry.mode)} · certificado ${certificate}`;
}

/** Tone of an «activado / desactivado» badge: the switch decides the wording, the readiness the colour. */
function toggleTone(enabled: boolean, ready: boolean | undefined): CocoaTone {
  if (!enabled) return "neutral";
  return ready ? "success" : "warning";
}

export function TaxComplianceSettings() {
  const header = treeHeaderFor("TaxComplianceSettings", { eyebrow: "Cumplimiento · Fiscal", title: "Ajustes de cumplimiento fiscal" });
  const { showToast } = useToast();
  const [settings, setSettings] = useState<ComplianceSettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [rawRegion, setRawRegion] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [askDiscard, setAskDiscard] = useState(false);
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
      // (including `null` for cleared fields) and the status sections refresh.
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
  const saved = useMemo(() => (settings ? toForm(settings) : null), [settings]);
  const dirty = form !== null && saved !== null && !isSameForm(form, saved);
  const figure = form?.taxRegion ? figureForRegion(form.taxRegion) : null;
  const isIpsi = form?.taxRegion === "ES_CEUTA" || form?.taxRegion === "ES_MELILLA";
  const isForal = Boolean(form?.fiscalTerritory && form.fiscalTerritory !== "common");
  const unrecognisedRegion = Boolean(rawRegion) && !normalizeTaxRegionClient(rawRegion);
  const territoryLabel = FISCAL_TERRITORY_OPTIONS.find((option) => option.value === form?.fiscalTerritory)?.label ?? form?.fiscalTerritory ?? "";
  const stat = (value: number | null | undefined) => (value === null || value === undefined ? "—" : number(value));
  const discard = confirmDiscard();

  return (
    <CocoaPage
      eyebrow={header.eyebrow}
      title={header.title}
      subtitle="País, región fiscal, conectores obligatorios y datos del establecimiento"
      actions={
        <>
          <CocoaButton variant="plain" onClick={openPropertyTaxes}>
            Impuestos de la propiedad
          </CocoaButton>
          <CocoaButton variant="plain" onClick={() => navigateTo("FiscalDashboard")}>
            Centro fiscal
          </CocoaButton>
          <CocoaButton variant="plain" onClick={() => navigateTo("ComplianceInbox")}>
            Bandeja de cumplimiento
          </CocoaButton>
        </>
      }
      state={loading && !form ? "loading" : error && !form ? "error" : "ready"}
      skeleton={<CocoaSkeleton.Grid rows={[[12], [6, 6], [6, 6], [12]]} height={160} label="Cargando configuración fiscal…" />}
      error={{ title: "No se pudo cargar la configuración fiscal", message: error ?? undefined, onRetry: () => void load() }}
      commands={[
        { id: "tax-compliance-save", label: `${ACTIONS.save}: configuración fiscal`, run: () => void handleSave(), shortcut: "⌘ Enter" },
        { id: "tax-compliance-refresh", label: "Actualizar los ajustes de cumplimiento fiscal", run: () => void load() }
      ]}
      id="tax-compliance-settings"
    >
      {form && settings ? (
        <>
          <CocoaScreenInstructionsCard
            title="Ajustes de cumplimiento fiscal"
            description={TAX_COMPLIANCE_INSTRUCTIONS.whatIsThis}
            steps={TAX_COMPLIANCE_INSTRUCTIONS.howToUse}
            dismissible
            persistKey="tax-compliance-settings"
          />

          {!settings.provisioned ? (
            <CocoaCallout tone="info" title="Sin ajustes guardados">
              Esta propiedad aún no tiene ajustes de cumplimiento guardados: se muestran los valores por defecto. Al guardar se crea el registro.
            </CocoaCallout>
          ) : null}
          {unrecognisedRegion ? (
            <CocoaCallout tone="warning" title="Región fiscal no reconocida" role="alert">
              La región fiscal guardada («{rawRegion}») no es un código reconocido. Selecciona la región canónica y guarda para que el resolutor de impuestos la
              aplique.
            </CocoaCallout>
          ) : null}

          <CocoaGrid aria-label="Estado de los impuestos y los conectores">
            <CocoaSpan cols={6} min={320}>
              <CocoaSection
                title="Impuestos indirectos"
                meta={
                  <CocoaBadge tone={taxes ? (taxWarnings.length > 0 || !taxes.taxRegion ? "warning" : "success") : "neutral"}>
                    {taxes ? (taxes.taxRegion ? `${taxes.figure} · Impuesto ${taxes.impuesto}` : "sin región") : "no disponible"}
                  </CocoaBadge>
                }
                action={
                  <CocoaButton variant="plain" size="small" onClick={openPropertyTaxes}>
                    Ver tipos por concepto
                  </CocoaButton>
                }
              >
                {taxes ? (
                  <>
                    <p>
                      {taxRegionLabel(taxes.taxRegion)} · {plural(toArray(taxes.rates).length, "tipo vigente", "tipos vigentes")}
                      {taxes.regionSource !== "property" ? " · región derivada, confirma en el perfil" : ""}
                    </p>
                    {taxWarnings.length > 0 ? (
                      <ul className="c22-section__list" aria-label="Avisos del perfil de impuestos">
                        {taxWarnings.map((warning, index) => (
                          <li key={`${index}-${warning}`}>
                            <span className="cocoa-note">{warning}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                ) : (
                  <p className="cocoa-note">No se pudo leer el perfil de impuestos{taxesError ? `: ${taxesError}` : "."}</p>
                )}
              </CocoaSection>
            </CocoaSpan>

            <CocoaSpan cols={6} min={320}>
              <CocoaSection
                title="VeriFactu (AEAT)"
                meta={<CocoaBadge tone={toggleTone(form.verifactuEnabled, verifactuHealth?.readyForReal)}>{form.verifactuEnabled ? STATUS_LABELS.enabled : STATUS_LABELS.disabled}</CocoaBadge>}
                action={
                  <CocoaButton variant="plain" size="small" onClick={() => navigateTo("FiscalDashboard")}>
                    Colas y envíos
                  </CocoaButton>
                }
              >
                {verifactuHealth ? (
                  <p>
                    {connectorLine(verifactuHealth)}
                    {verifactuHealth.notes ? ` · ${verifactuHealth.notes}` : ""}
                  </p>
                ) : (
                  <p className="cocoa-note">Estado del conector no disponible{healthError ? `: ${healthError}` : "."}</p>
                )}
                {software ? (
                  software.ok ? (
                    <div className="cocoa-cluster">
                      <CocoaBadge tone="success">Bloque SistemaInformatico completo</CocoaBadge>
                    </div>
                  ) : (
                    <CocoaCallout tone="danger" title="Software VeriFactu incompleto" role="alert">
                      <ul className="c22-section__list" aria-label="Errores del bloque SistemaInformatico">
                        {software.errors.map((message, index) => (
                          <li key={`${index}-${message}`}>
                            <span className="cocoa-note">{message}</span>
                          </li>
                        ))}
                      </ul>
                    </CocoaCallout>
                  )
                ) : (
                  <p className="cocoa-note">El API no expone todavía la validación del bloque SistemaInformatico (NIF del productor, versión, instalación).</p>
                )}
              </CocoaSection>
            </CocoaSpan>

            <CocoaSpan cols={6} min={320}>
              <CocoaSection
                title="SES.HOSPEDAJES (MIR)"
                meta={<CocoaBadge tone={toggleTone(form.sesHospedajesEnabled, establishment?.ok)}>{form.sesHospedajesEnabled ? STATUS_LABELS.enabled : STATUS_LABELS.disabled}</CocoaBadge>}
                footer={
                  <div className="cocoa-cluster">
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
                }
              >
                {sesHealth ? <p>{connectorLine(sesHealth)}</p> : null}
                {establishment ? (
                  establishment.ok ? (
                    <div className="cocoa-cluster">
                      <CocoaBadge tone="success">Datos del establecimiento completos</CocoaBadge>
                    </div>
                  ) : (
                    <CocoaCallout tone="warning" title="Faltan datos del establecimiento" role="alert">
                      {establishmentMissing.map(sesEstablishmentIssueLabel).join(", ")}
                    </CocoaCallout>
                  )
                ) : (
                  <p className="cocoa-note">Datos del establecimiento no disponibles{establishmentError ? `: ${establishmentError}` : "."}</p>
                )}
              </CocoaSection>
            </CocoaSpan>

            <CocoaSpan cols={6} min={320}>
              <CocoaSection
                title="Territorio foral y Canarias"
                meta={<CocoaBadge tone={isForal ? (form.ticketbaiEnabled ? "success" : "warning") : "neutral"}>{isForal ? "TicketBAI" : "territorio común"}</CocoaBadge>}
                footer={
                  <div className="cocoa-cluster">
                    <CocoaButton variant="plain" size="small" onClick={() => navigateTo("TbaiForal")}>
                      TicketBAI
                    </CocoaButton>
                    <CocoaButton variant="plain" size="small" onClick={() => navigateTo("FiscalSubmissionsCenter")}>
                      Centro de envíos
                    </CocoaButton>
                  </div>
                }
              >
                <p>
                  {isForal
                    ? `Las facturas se envían a la Hacienda Foral (${territoryLabel}).${tbaiHealth ? ` Conector TBAI en modo ${modeLabel(tbaiHealth.mode)}.` : ""}`
                    : "Las facturas se envían a la AEAT por VeriFactu."}
                  {form.taxRegion === "ES_CANARIAS" && igicHealth ? ` IGIC en modo ${modeLabel(igicHealth.mode)}.` : ""}
                </p>
                <p className="cocoa-note">
                  Últimas 24 h · VeriFactu:{" "}
                  <DegradedValue label="verifactuSubmissionsLast24h" degraded={degraded}>
                    {stat(health?.stats.verifactuSubmissionsLast24h)}
                  </DegradedValue>{" "}
                  envíos /{" "}
                  <DegradedValue label="verifactuRejectedLast24h" degraded={degraded}>
                    {stat(health?.stats.verifactuRejectedLast24h)}
                  </DegradedValue>{" "}
                  rechazos · SES:{" "}
                  <DegradedValue label="sesSubmissionsLast24h" degraded={degraded}>
                    {stat(health?.stats.sesSubmissionsLast24h)}
                  </DegradedValue>{" "}
                  envíos /{" "}
                  <DegradedValue label="sesRejectedLast24h" degraded={degraded}>
                    {stat(health?.stats.sesRejectedLast24h)}
                  </DegradedValue>{" "}
                  rechazos
                </p>
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>

          <CocoaCallout
            tone="neutral"
            title="Identidad fiscal del emisor"
            actions={
              <CocoaButton variant="plain" size="small" onClick={() => navigateTo("StructureScreen")}>
                Estructura societaria
              </CocoaButton>
            }
          >
            El NIF, la razón social y el domicilio fiscal son de la sociedad y se consultan en Configuración › Estructura societaria. Aquí solo se
            configuran la región fiscal, los conectores y los códigos de este establecimiento.
          </CocoaCallout>

          <CocoaFormSection
            title="Región fiscal y conectores"
            description={`País, región fiscal, ruta de envío, tasa turística y códigos del establecimiento.${settings.updatedAt ? ` Actualizado ${dateTime(settings.updatedAt)}.` : ""}`}
            actions={
              <CocoaButton variant="plain" size="small" onClick={() => navigateTo("PropertyProfileSetupForm")}>
                Perfil del establecimiento
              </CocoaButton>
            }
          >
            <CocoaFormRow columns={3}>
              <CocoaField label="País" required>
                <CocoaSelect value={form.country} onChange={(value) => set("country", value)} options={COUNTRY_OPTIONS} />
              </CocoaField>
              <CocoaField label="Región fiscal" required help={figure ? `Figura: ${figure.figure} · Impuesto VeriFactu ${figure.impuesto}` : "Determina IVA, IGIC o IPSI."}>
                <CocoaSelect
                  value={form.taxRegion}
                  onChange={(value) => set("taxRegion", value as TaxRegion | "")}
                  placeholder="Seleccionar…"
                  options={TAX_REGION_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                />
              </CocoaField>
              <CocoaField label="Territorio foral (ruta de envío)">
                <CocoaSelect
                  value={form.fiscalTerritory}
                  onChange={(value) => set("fiscalTerritory", value)}
                  options={FISCAL_TERRITORY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                />
              </CocoaField>
              <CocoaField label="Tasa turística autonómica">
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
              </CocoaField>
              <CocoaField label="Tratamiento de la tasa turística">
                <CocoaSelect
                  value={form.touristTaxTreatment}
                  onChange={(value) => set("touristTaxTreatment", value as TouristTaxTreatment | "")}
                  options={[{ value: "", label: "Sin definir" }, ...TOURIST_TAX_TREATMENT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))]}
                />
              </CocoaField>
              <CocoaField label="Código postal" error={fiscalErrors.postalCode} help="Cinco dígitos. Déjalo vacío para borrar el valor guardado.">
                <CocoaInput value={form.postalCode} onChange={(value) => set("postalCode", value)} placeholder="15001" inputMode="numeric" maxLength={5} autoComplete="postal-code" />
              </CocoaField>
              <CocoaField
                label="Código INE del municipio"
                error={fiscalErrors.ineMunicipalityCode}
                help="Cinco dígitos (provincia + municipio), misma provincia que el CP; SES.HOSPEDAJES lo exige en la dirección del establecimiento. Vacío = borrar."
              >
                <CocoaInput value={form.ineMunicipalityCode} onChange={(value) => set("ineMunicipalityCode", value)} placeholder="15030" inputMode="numeric" maxLength={5} />
              </CocoaField>
              <CocoaField label="Nº de registro turístico (SES)" error={fiscalErrors.sesRegistryNumber} help="Entre 3 y 64 caracteres alfanuméricos o guiones. Vacío = borrar el número guardado.">
                <CocoaInput value={form.sesRegistryNumber} onChange={(value) => set("sesRegistryNumber", value)} placeholder="H-CO-000123" maxLength={64} />
              </CocoaField>
            </CocoaFormRow>

            <CocoaFormRow columns={3} role="group" aria-label="Conectores obligatorios">
              {CONNECTOR_TOGGLES.map(([key, label]) => (
                <CocoaField key={key} label={label} inline>
                  <CocoaSwitch checked={form[key]} onChange={(value) => set(key, value)} size="small" />
                </CocoaField>
              ))}
              {isIpsi ? (
                <CocoaField label="Tipos IPSI verificados con la ordenanza vigente" inline>
                  <CocoaSwitch checked={form.ipsiOrdinanceConfirmed} onChange={(value) => set("ipsiOrdinanceConfirmed", value)} size="small" />
                </CocoaField>
              ) : null}
            </CocoaFormRow>

            {isForal && !form.ticketbaiEnabled ? (
              <CocoaCallout tone="warning" title="TicketBAI desactivado" role="status">
                Has seleccionado un territorio foral sin activar TicketBAI: las facturas no se enviarán a la Hacienda Foral.
              </CocoaCallout>
            ) : null}
            {form.taxRegion === "ES_CANARIAS" && form.tourismTaxRegion ? (
              <CocoaCallout tone="warning" title="Tasa turística en Canarias" role="status">
                Canarias no tiene tasa turística autonómica en 2026; revisa la región de tasa turística.
              </CocoaCallout>
            ) : null}
          </CocoaFormSection>

          <CocoaActionBar
            aria-label="Acciones de la configuración fiscal"
            status={dirty ? "Cambios sin guardar" : settings.provisioned ? undefined : "Valores por defecto, sin guardar"}
            secondary={{ label: ACTIONS.cancel, disabled: !dirty || saving, onClick: () => setAskDiscard(true) }}
            primary={{
              label: saving ? STATUS_LABELS.saving : "Guardar configuración",
              loading: saving,
              disabled: saving || Boolean(firstFiscalError(fiscalErrors)),
              onClick: () => void handleSave()
            }}
            publishToastOffset
          />

          <CocoaDialog
            open={askDiscard}
            onClose={() => setAskDiscard(false)}
            tone="destructive"
            title={discard.title}
            description={discard.message}
            confirmLabel={discard.confirmLabel}
            cancelLabel={discard.cancelLabel}
            onConfirm={() => {
              if (saved) setForm(saved);
              setAskDiscard(false);
            }}
          />
        </>
      ) : null}
    </CocoaPage>
  );
}

export default TaxComplianceSettings;
