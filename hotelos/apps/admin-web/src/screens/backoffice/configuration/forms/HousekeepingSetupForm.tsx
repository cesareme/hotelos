import { useState } from "react";
import {
  FormField,
  FormMultiSelect,
  FormNumberInput,
  FormPage,
  FormSection,
  FormSelect,
  FormStickyActionBar,
  FormSwitch,
  FormTextarea,
  FormValidationSummary
} from "../../../../components/forms/FormComponents";
import { useToast } from "../../../../components/Toast";

const INSPECTION_RULES = ["Obligatoria tras limpieza de salida", "Muestreo 25%", "Muestreo 50%", "Obligatoria para VIP", "Nunca"];
const ROOM_TYPES = ["Doble estándar", "Superior twin", "Junior suite", "Apartamento", "Dormitorio compartido"];

export function HousekeepingSetupForm() {
  const { showToast } = useToast();
  const [values, setValues] = useState({
    sections: [] as string[],
    inspectionRule: "",
    slaMinutes: "",
    defaultDurations: "",
    cleaningRoomTypes: [] as string[],
    active: true
  });
  const [dirty, setDirty] = useState(false);

  function patch<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  const issues: string[] = [];
  if (values.sections.length === 0) issues.push("Se requiere al menos una sección de pisos.");
  if (!values.inspectionRule) issues.push("La regla de inspección es obligatoria.");

  function handleSave(addAnother: boolean) {
    if (issues.length > 0) {
      return;
    }
    setDirty(false);
    if (addAnother) {
      setValues({ sections: [], inspectionRule: "", slaMinutes: "", defaultDurations: "", cleaningRoomTypes: [], active: true });
    }
  }

  function handleDeactivate() {
    patch("active", false);
    showToast("Configuración de pisos desactivada", { variant: "info" });
  }

  return (
    <FormPage
      eyebrow="Configuración / Operaciones / Pisos"
      title="Configuración de pisos"
      summary="Secciones de pisos, reglas de inspección, objetivos de SLA y duraciones de limpieza por defecto por tipo de habitación."
    >
      {dirty ? (
        <div className="bo-card">
          <strong>Tienes cambios sin guardar</strong>
          <p>Guarda antes de salir o tus cambios se descartarán.</p>
        </div>
      ) : null}
      <FormValidationSummary issues={issues.length ? issues : ["No hay problemas de validación bloqueantes."]} />
      <FormSection title="Secciones e inspección">
        <FormMultiSelect label="Secciones" options={["Ala norte", "Ala sur", "Suites", "Apartamentos", "Áreas públicas", "Spa"]} value={values.sections} onChange={(value) => patch("sections", value)} />
        <FormSelect label="Regla de inspección" required options={INSPECTION_RULES} value={values.inspectionRule} onChange={(value) => patch("inspectionRule", value)} />
        <FormNumberInput label="Minutos de SLA" value={values.slaMinutes} onChange={(value) => patch("slaMinutes", value)} />
        <FormSwitch label="Activo" value={values.active} onChange={(value) => patch("active", value)} />
      </FormSection>
      <FormSection title="Duraciones de limpieza por defecto">
        <FormMultiSelect label="Se aplica a tipos de habitación" options={ROOM_TYPES} value={values.cleaningRoomTypes} onChange={(value) => patch("cleaningRoomTypes", value)} />
        <FormTextarea label="Excepciones de duración" value={values.defaultDurations} onChange={(value) => patch("defaultDurations", value)} />
        <FormField label="Notas">
          <span>Estándar: 30 min. Suite: 45 min. Apartamento: 60 min.</span>
        </FormField>
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
