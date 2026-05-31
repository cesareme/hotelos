import { useState } from "react";
import {
  FormField,
  FormMultiSelect,
  FormPage,
  FormSection,
  FormStickyActionBar,
  FormSwitch,
  FormTextarea,
  FormValidationSummary
} from "../../../../components/forms/FormComponents";
import { useToast } from "../../../../components/Toast";

const CATEGORIES = ["Climatización", "Fontanería", "Electricidad", "Mobiliario", "Cerraduras", "Ruido", "Daños por limpieza", "TI", "Seguridad"];
const PRIORITIES = ["Baja", "Normal", "Alta", "Bloqueante"];
const ASSET_FAMILIES = ["Climatización", "Fontanería", "Mobiliario", "TI", "Seguridad", "Ascensor", "Piscina"];

export function MaintenanceSetupForm() {
  const { showToast } = useToast();
  const [values, setValues] = useState({
    categories: [] as string[],
    priorities: [] as string[],
    slaPerPriority: "",
    assetFamilies: [] as string[],
    active: true
  });
  const [dirty, setDirty] = useState(false);

  function patch<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  const issues: string[] = [];
  if (values.categories.length === 0) issues.push("Se requiere al menos una categoría de mantenimiento.");
  if (values.priorities.length === 0) issues.push("Se requiere al menos un nivel de prioridad.");

  function handleSave(addAnother: boolean) {
    if (issues.length > 0) {
      return;
    }
    setDirty(false);
    if (addAnother) {
      setValues({ categories: [], priorities: [], slaPerPriority: "", assetFamilies: [], active: true });
    }
  }

  function handleDeactivate() {
    patch("active", false);
    showToast("Configuración de mantenimiento desactivada", { variant: "info" });
  }

  return (
    <FormPage
      eyebrow="Configuración / Operaciones / Mantenimiento"
      title="Configuración de mantenimiento"
      summary="Categorías de mantenimiento, niveles de prioridad, SLA y familias de activos usados por las órdenes de trabajo y el PMS."
    >
      {dirty ? (
        <div className="bo-card">
          <strong>Tienes cambios sin guardar</strong>
          <p>Guarda antes de salir o tus cambios se descartarán.</p>
        </div>
      ) : null}
      <FormValidationSummary issues={issues.length ? issues : ["No hay problemas de validación bloqueantes."]} />
      <FormSection title="Categorías y prioridades">
        <FormMultiSelect label="Categorías de mantenimiento" options={CATEGORIES} value={values.categories} onChange={(value) => patch("categories", value)} />
        <FormMultiSelect label="Niveles de prioridad" options={PRIORITIES} value={values.priorities} onChange={(value) => patch("priorities", value)} />
        <FormTextarea label="SLA por prioridad" value={values.slaPerPriority} onChange={(value) => patch("slaPerPriority", value)} />
      </FormSection>
      <FormSection title="Activos">
        <FormMultiSelect label="Familias de activos" options={ASSET_FAMILIES} value={values.assetFamilies} onChange={(value) => patch("assetFamilies", value)} />
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
