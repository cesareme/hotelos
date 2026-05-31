import { useState } from "react";
import {
  FormDateInput,
  FormField,
  FormPage,
  FormSection,
  FormSelect,
  FormStickyActionBar,
  FormTextarea,
  FormValidationSummary
} from "../../../../components/forms/FormComponents";
import { useToast } from "../../../../components/Toast";

const COUNTRIES = ["España", "Portugal", "Francia", "Italia", "Andorra"];
const TIMEZONES = ["Europe/Madrid", "Europe/Lisbon", "Europe/Paris", "Europe/Rome", "Europe/Andorra"];
const CURRENCIES = ["EUR", "GBP", "USD"];
const LANGUAGES = ["Español", "Inglés", "Catalán", "Francés", "Portugués", "Italiano"];
const TAX_REGIONS = ["España peninsular", "Islas Canarias", "Ceuta", "Melilla", "Otro"];
const TOURISM_TAX_REGIONS = ["Ninguna", "Cataluña", "Islas Baleares", "Valencia", "País Vasco"];

export function PropertyProfileForm() {
  const { showToast } = useToast();
  const [values, setValues] = useState({
    propertyName: "",
    legalName: "",
    taxId: "",
    address: "",
    country: "",
    region: "",
    province: "",
    city: "",
    postalCode: "",
    timezone: "",
    currency: "",
    language: "",
    taxRegion: "",
    tourismTaxRegion: "",
    businessDateStart: "",
    active: true
  });
  const [dirty, setDirty] = useState(false);

  function patch<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  const issues: string[] = [];
  if (!values.propertyName.trim()) issues.push("El nombre del establecimiento es obligatorio.");
  if (!values.legalName.trim()) issues.push("El nombre legal es obligatorio.");
  if (!values.taxId.trim()) issues.push("El NIF/CIF es obligatorio.");
  if (!values.country) issues.push("El país es obligatorio.");
  if (!values.city.trim()) issues.push("La ciudad es obligatoria.");
  if (!values.timezone) issues.push("La zona horaria es obligatoria.");
  if (!values.currency) issues.push("La moneda es obligatoria.");

  function handleSave(addAnother: boolean) {
    if (issues.length > 0) {
      return;
    }
    setDirty(false);
    if (addAnother) {
      setValues({
        propertyName: "",
        legalName: "",
        taxId: "",
        address: "",
        country: "",
        region: "",
        province: "",
        city: "",
        postalCode: "",
        timezone: "",
        currency: "",
        language: "",
        taxRegion: "",
        tourismTaxRegion: "",
        businessDateStart: "",
        active: true
      });
    }
  }

  function handleDeactivate() {
    patch("active", false);
    showToast("Perfil del establecimiento desactivado", { variant: "info" });
  }

  return (
    <FormPage
      eyebrow="Configuración / Perfil del establecimiento"
      title="Perfil del establecimiento"
      summary="Perfil legal, identidad fiscal, dirección, configuración regional y reglas de fecha de negocio usadas en PMS, facturación, cumplimiento y revenue."
    >
      {dirty ? (
        <div className="bo-card">
          <strong>Tienes cambios sin guardar</strong>
          <p>Guarda antes de salir o tus cambios se descartarán.</p>
        </div>
      ) : null}
      <FormValidationSummary issues={issues.length ? issues : ["No hay problemas de validación bloqueantes."]} />
      <FormSection title="Identidad">
        <FormField label="Nombre del establecimiento" required>
          <input aria-label="Nombre del establecimiento" value={values.propertyName} onChange={(event) => patch("propertyName", event.currentTarget.value)} placeholder="Hotel Aurora" />
        </FormField>
        <FormField label="Nombre legal" required>
          <input aria-label="Nombre legal" value={values.legalName} onChange={(event) => patch("legalName", event.currentTarget.value)} placeholder="Aurora Hospitality S.L." />
        </FormField>
        <FormField label="NIF/CIF" required>
          <input aria-label="NIF/CIF" value={values.taxId} onChange={(event) => patch("taxId", event.currentTarget.value)} placeholder="B12345678" />
        </FormField>
      </FormSection>
      <FormSection title="Dirección">
        <FormTextarea label="Dirección" value={values.address} onChange={(value) => patch("address", value)} />
        <FormSelect label="País" required options={COUNTRIES} value={values.country} onChange={(value) => patch("country", value)} />
        <FormField label="Comunidad autónoma">
          <input aria-label="Comunidad autónoma" value={values.region} onChange={(event) => patch("region", event.currentTarget.value)} />
        </FormField>
        <FormField label="Provincia">
          <input aria-label="Provincia" value={values.province} onChange={(event) => patch("province", event.currentTarget.value)} />
        </FormField>
        <FormField label="Ciudad" required>
          <input aria-label="Ciudad" value={values.city} onChange={(event) => patch("city", event.currentTarget.value)} />
        </FormField>
        <FormField label="Código postal">
          <input aria-label="Código postal" value={values.postalCode} onChange={(event) => patch("postalCode", event.currentTarget.value)} />
        </FormField>
      </FormSection>
      <FormSection title="Localización y finanzas">
        <FormSelect label="Zona horaria" required options={TIMEZONES} value={values.timezone} onChange={(value) => patch("timezone", value)} />
        <FormSelect label="Moneda" required options={CURRENCIES} value={values.currency} onChange={(value) => patch("currency", value)} />
        <FormSelect label="Idioma" options={LANGUAGES} value={values.language} onChange={(value) => patch("language", value)} />
        <FormSelect label="Región fiscal" options={TAX_REGIONS} value={values.taxRegion} onChange={(value) => patch("taxRegion", value)} />
        <FormSelect label="Región de tasa turística" options={TOURISM_TAX_REGIONS} value={values.tourismTaxRegion} onChange={(value) => patch("tourismTaxRegion", value)} />
        <FormDateInput label="Inicio del día de negocio" value={values.businessDateStart} onChange={(value) => patch("businessDateStart", value)} />
      </FormSection>
      <FormSection title="Historial de auditoría">
        <FormField label="Última modificación">
          <span>Última modificación por sistema, el 2026-05-17, ver registro de auditoría.</span>
        </FormField>
      </FormSection>
      <div className="bo-actions">
        <button className="primary" type="button" onClick={() => handleSave(false)}>Guardar</button>
        <button type="button" onClick={() => handleSave(true)}>Guardar y añadir otro</button>
        <button type="button" onClick={() => window.history.back()}>Cancelar</button>
        <button type="button" onClick={handleDeactivate}>Desactivar</button>
      </div>
      <FormStickyActionBar />
    </FormPage>
  );
}
