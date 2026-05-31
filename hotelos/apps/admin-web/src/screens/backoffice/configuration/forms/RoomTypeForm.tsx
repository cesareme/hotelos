import { useState } from "react";
import {
  FormField,
  FormMoneyInput,
  FormMultiSelect,
  FormNumberInput,
  FormPage,
  FormSection,
  FormSelect,
  FormStickyActionBar,
  FormSwitch,
  FormValidationSummary
} from "../../../../components/forms/FormComponents";
import { useToast } from "../../../../components/Toast";

const CATEGORIES = ["Estándar", "Superior", "Suite", "Apartamento", "Dormitorio compartido"];
const BED_TYPES = ["King", "Queen", "Twin", "Sofá cama", "Litera", "Individual"];
const FEATURES = ["Balcón", "Vista al mar", "Vista a montaña", "Vista a ciudad", "Habitación comunicada", "Admite mascotas", "Kitchenette", "Bañera"];
const VIEWS = ["Mar", "Montaña", "Ciudad", "Jardín", "Piscina", "Patio interior"];
const ACCESSIBILITY = ["Ninguna", "Silla de ruedas", "Auditiva", "Visual", "Movilidad"];

export function RoomTypeForm() {
  const { showToast } = useToast();
  const [values, setValues] = useState({
    name: "",
    code: "",
    category: "",
    baseOccupancy: "",
    maxOccupancy: "",
    maxAdults: "",
    maxChildren: "",
    defaultBedType: "",
    features: [] as string[],
    view: "",
    accessibility: "",
    sellable: true,
    baseRate: "",
    active: true
  });
  const [dirty, setDirty] = useState(false);

  function patch<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  const issues: string[] = [];
  if (!values.name.trim()) issues.push("El nombre del tipo de habitación es obligatorio.");
  if (!values.code.trim()) issues.push("El código del tipo de habitación es obligatorio.");
  if (!values.category) issues.push("La categoría es obligatoria.");
  if (!values.baseOccupancy) issues.push("La ocupación base es obligatoria.");
  if (!values.maxOccupancy) issues.push("La ocupación máxima es obligatoria.");

  function handleSave(addAnother: boolean) {
    if (issues.length > 0) {
      return;
    }
    setDirty(false);
    if (addAnother) {
      setValues({
        name: "",
        code: "",
        category: "",
        baseOccupancy: "",
        maxOccupancy: "",
        maxAdults: "",
        maxChildren: "",
        defaultBedType: "",
        features: [],
        view: "",
        accessibility: "",
        sellable: true,
        baseRate: "",
        active: true
      });
    }
  }

  function handleDeactivate() {
    patch("active", false);
    patch("sellable", false);
    showToast("Tipo de habitación desactivado", { variant: "info" });
  }

  return (
    <FormPage
      eyebrow="Configuración / Tipos de habitación"
      title="Tipo de habitación"
      summary="Valores por defecto, características, ocupación, vistas, accesibilidad, estado vendible y tarifa base para un tipo de habitación."
    >
      {dirty ? (
        <div className="bo-card">
          <strong>Tienes cambios sin guardar</strong>
          <p>Guarda antes de salir o tus cambios se descartarán.</p>
        </div>
      ) : null}
      <FormValidationSummary issues={issues.length ? issues : ["No hay problemas de validación bloqueantes."]} />
      <FormSection title="Identidad">
        <FormField label="Nombre" required>
          <input aria-label="Nombre" value={values.name} onChange={(event) => patch("name", event.currentTarget.value)} placeholder="Junior Suite" />
        </FormField>
        <FormField label="Código" required>
          <input aria-label="Código" value={values.code} onChange={(event) => patch("code", event.currentTarget.value)} placeholder="JSU" />
        </FormField>
        <FormSelect label="Categoría" required options={CATEGORIES} value={values.category} onChange={(value) => patch("category", value)} />
      </FormSection>
      <FormSection title="Ocupación">
        <FormNumberInput label="Ocupación base" value={values.baseOccupancy} onChange={(value) => patch("baseOccupancy", value)} />
        <FormNumberInput label="Ocupación máxima" value={values.maxOccupancy} onChange={(value) => patch("maxOccupancy", value)} />
        <FormNumberInput label="Máximo de adultos" value={values.maxAdults} onChange={(value) => patch("maxAdults", value)} />
        <FormNumberInput label="Máximo de niños" value={values.maxChildren} onChange={(value) => patch("maxChildren", value)} />
        <FormSelect label="Tipo de cama por defecto" options={BED_TYPES} value={values.defaultBedType} onChange={(value) => patch("defaultBedType", value)} />
      </FormSection>
      <FormSection title="Características y precio">
        <FormMultiSelect label="Características" options={FEATURES} value={values.features} onChange={(value) => patch("features", value)} />
        <FormSelect label="Vista" options={VIEWS} value={values.view} onChange={(value) => patch("view", value)} />
        <FormSelect label="Accesibilidad" options={ACCESSIBILITY} value={values.accessibility} onChange={(value) => patch("accessibility", value)} />
        <FormSwitch label="Vendible" value={values.sellable} onChange={(value) => patch("sellable", value)} />
        <FormMoneyInput label="Tarifa base" value={values.baseRate} onChange={(value) => patch("baseRate", value)} />
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
