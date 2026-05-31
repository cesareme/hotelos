import { useState } from "react";
import {
  FormField,
  FormMoneyInput,
  FormNumberInput,
  FormPage,
  FormSection,
  FormSelect,
  FormStickyActionBar,
  FormSwitch,
  FormValidationSummary
} from "../../../../components/forms/FormComponents";
import { useToast } from "../../../../components/Toast";

const RESOURCE_TYPES = ["parking", "reunión", "spa", "evento", "equipamiento", "punto de venta", "otro"];

export function SpaceResourceForm() {
  const { showToast } = useToast();
  const [values, setValues] = useState({
    name: "",
    type: "",
    capacity: "",
    hourlyRate: "",
    dailyRate: "",
    location: "",
    active: true
  });
  const [dirty, setDirty] = useState(false);

  function patch<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  const issues: string[] = [];
  if (!values.name.trim()) issues.push("El nombre es obligatorio.");
  if (!values.type) issues.push("El tipo de recurso es obligatorio.");

  function handleSave(addAnother: boolean) {
    if (issues.length > 0) {
      return;
    }
    setDirty(false);
    if (addAnother) {
      setValues({ name: "", type: "", capacity: "", hourlyRate: "", dailyRate: "", location: "", active: true });
    }
  }

  function handleDeactivate() {
    patch("active", false);
    showToast("Espacio o recurso desactivado", { variant: "info" });
  }

  return (
    <FormPage
      eyebrow="Configuración / Espacios y recursos"
      title="Espacio o recurso"
      summary="Espacios y recursos reservables fuera del inventario de habitaciones: parking, salas de reuniones, cabinas de spa, espacios para eventos, equipamiento y puntos de venta."
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
          <input aria-label="Nombre" value={values.name} onChange={(event) => patch("name", event.currentTarget.value)} placeholder="Sala de conferencias A" />
        </FormField>
        <FormSelect label="Tipo" required options={RESOURCE_TYPES} value={values.type} onChange={(value) => patch("type", value)} />
        <FormField label="Ubicación">
          <input aria-label="Ubicación" value={values.location} onChange={(event) => patch("location", event.currentTarget.value)} placeholder="Principal / Planta baja" />
        </FormField>
        <FormSwitch label="Activo" value={values.active} onChange={(value) => patch("active", value)} />
      </FormSection>
      <FormSection title="Capacidad y tarifas">
        <FormNumberInput label="Aforo" value={values.capacity} onChange={(value) => patch("capacity", value)} />
        <FormMoneyInput label="Tarifa por hora" value={values.hourlyRate} onChange={(value) => patch("hourlyRate", value)} />
        <FormMoneyInput label="Tarifa diaria" value={values.dailyRate} onChange={(value) => patch("dailyRate", value)} />
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
