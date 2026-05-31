import { useState } from "react";
import {
  FormField,
  FormMultiSelect,
  FormPage,
  FormSection,
  FormStickyActionBar,
  FormSwitch,
  FormValidationSummary
} from "../../../../components/forms/FormComponents";
import { useToast } from "../../../../components/Toast";

const MARKET_SEGMENTS = ["Directo", "OTA", "Corporativo", "Grupo", "Mayorista", "Walk-in", "Ocio", "Negocio"];
const SOURCE_CODES = ["Web", "Teléfono", "Booking.com", "Expedia", "Google", "Corporativo", "Email"];
const RATE_CATEGORIES = ["BAR flexible", "No reembolsable", "Paquete", "Corporativo", "Grupo", "Estancia larga"];
const FORECAST_DRIVERS = ["Pickup", "Ritmo", "Competidor", "Evento", "Tiempo (placeholder)", "Calendario de demanda"];

export function RevenueCategorySetupForm() {
  const { showToast } = useToast();
  const [values, setValues] = useState({
    marketSegments: [] as string[],
    sourceCodes: [] as string[],
    rateCategories: [] as string[],
    forecastDrivers: [] as string[],
    active: true
  });
  const [dirty, setDirty] = useState(false);

  function patch<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  const issues: string[] = [];
  if (values.marketSegments.length === 0) issues.push("Se requiere al menos un segmento de mercado.");
  if (values.rateCategories.length === 0) issues.push("Se requiere al menos una categoría de tarifa.");

  function handleSave(addAnother: boolean) {
    if (issues.length > 0) {
      return;
    }
    setDirty(false);
    if (addAnother) {
      setValues({ marketSegments: [], sourceCodes: [], rateCategories: [], forecastDrivers: [], active: true });
    }
  }

  function handleDeactivate() {
    patch("active", false);
    showToast("Configuración de revenue desactivada", { variant: "info" });
  }

  return (
    <FormPage
      eyebrow="Configuración / Revenue"
      title="Configuración de categorías de revenue"
      summary="Segmentos de mercado, códigos de origen, categorías de tarifa y drivers de pronóstico usados por revenue management."
    >
      {dirty ? (
        <div className="bo-card">
          <strong>Tienes cambios sin guardar</strong>
          <p>Guarda antes de salir o tus cambios se descartarán.</p>
        </div>
      ) : null}
      <FormValidationSummary issues={issues.length ? issues : ["No hay problemas de validación bloqueantes."]} />
      <FormSection title="Segmentos y canales">
        <FormMultiSelect label="Segmentos de mercado" options={MARKET_SEGMENTS} value={values.marketSegments} onChange={(value) => patch("marketSegments", value)} />
        <FormMultiSelect label="Códigos de origen" options={SOURCE_CODES} value={values.sourceCodes} onChange={(value) => patch("sourceCodes", value)} />
      </FormSection>
      <FormSection title="Tarifas y pronóstico">
        <FormMultiSelect label="Categorías de tarifa" options={RATE_CATEGORIES} value={values.rateCategories} onChange={(value) => patch("rateCategories", value)} />
        <FormMultiSelect label="Drivers de pronóstico" options={FORECAST_DRIVERS} value={values.forecastDrivers} onChange={(value) => patch("forecastDrivers", value)} />
        <FormSwitch label="Activo" value={values.active} onChange={(value) => patch("active", value)} />
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
