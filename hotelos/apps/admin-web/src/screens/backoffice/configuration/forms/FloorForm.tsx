import { useState } from "react";
import {
  FormField,
  FormNumberInput,
  FormPage,
  FormSection,
  FormSelect,
  FormStickyActionBar,
  FormSwitch,
  FormValidationSummary
} from "../../../../components/forms/FormComponents";
import { useToast } from "../../../../components/Toast";

const BUILDINGS = ["Principal", "Anexo", "Jardín", "Frente al mar"];
const HOUSEKEEPING_SECTIONS = ["Ala norte", "Ala sur", "Suites", "Apartamentos"];
const MAINTENANCE_AREAS = ["Habitaciones", "Áreas públicas", "Salas técnicas", "Exterior"];

export function FloorForm() {
  const { showToast } = useToast();
  const [values, setValues] = useState({
    name: "",
    number: "",
    building: "",
    housekeepingSection: "",
    maintenanceArea: "",
    active: true
  });
  const [dirty, setDirty] = useState(false);

  function patch<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  const issues: string[] = [];
  if (!values.name.trim()) issues.push("El nombre de la planta es obligatorio.");
  if (!values.building) issues.push("El edificio es obligatorio.");

  function handleSave(addAnother: boolean) {
    if (issues.length > 0) {
      return;
    }
    setDirty(false);
    if (addAnother) {
      setValues({ name: "", number: "", building: "", housekeepingSection: "", maintenanceArea: "", active: true });
    }
  }

  function handleDeactivate() {
    patch("active", false);
    showToast("Planta desactivada", { variant: "info" });
  }

  return (
    <FormPage
      eyebrow="Configuración / Plantas"
      title="Planta"
      summary="Plantas dentro de un edificio, con áreas de pisos y mantenimiento. Se usan para organizar habitaciones y SLA."
    >
      {dirty ? (
        <div className="bo-card">
          <strong>Tienes cambios sin guardar</strong>
          <p>Guarda antes de salir o tus cambios se descartarán.</p>
        </div>
      ) : null}
      <FormValidationSummary issues={issues.length ? issues : ["No hay problemas de validación bloqueantes."]} />
      <FormSection title="Identidad de la planta">
        <FormField label="Nombre" required>
          <input aria-label="Nombre" value={values.name} onChange={(event) => patch("name", event.currentTarget.value)} placeholder="Cuarta planta" />
        </FormField>
        <FormNumberInput label="Número" value={values.number} onChange={(value) => patch("number", value)} />
        <FormSelect label="Edificio" required options={BUILDINGS} value={values.building} onChange={(value) => patch("building", value)} />
        <FormSelect label="Sección de pisos" options={HOUSEKEEPING_SECTIONS} value={values.housekeepingSection} onChange={(value) => patch("housekeepingSection", value)} />
        <FormSelect label="Área de mantenimiento" options={MAINTENANCE_AREAS} value={values.maintenanceArea} onChange={(value) => patch("maintenanceArea", value)} />
        <FormSwitch label="Activa" value={values.active} onChange={(value) => patch("active", value)} />
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
