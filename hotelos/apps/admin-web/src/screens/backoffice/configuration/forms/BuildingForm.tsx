import { useState } from "react";
import {
  FormField,
  FormPage,
  FormSection,
  FormSelect,
  FormStickyActionBar,
  FormSwitch,
  FormTextarea,
  FormValidationSummary
} from "../../../../components/forms/FormComponents";
import { useToast } from "../../../../components/Toast";

const ZONES = ["Principal", "Anexo", "Jardín", "Frente al mar", "Ala de montaña"];

export function BuildingForm() {
  const { showToast } = useToast();
  const [values, setValues] = useState({
    name: "",
    code: "",
    address: "",
    zone: "",
    active: true
  });
  const [dirty, setDirty] = useState(false);

  function patch<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  const issues: string[] = [];
  if (!values.name.trim()) issues.push("El nombre del edificio es obligatorio.");
  if (!values.code.trim()) issues.push("El código del edificio es obligatorio.");

  function handleSave(addAnother: boolean) {
    if (issues.length > 0) {
      return;
    }
    setDirty(false);
    if (addAnother) {
      setValues({ name: "", code: "", address: "", zone: "", active: true });
    }
  }

  function handleDeactivate() {
    patch("active", false);
    showToast("Edificio desactivado", { variant: "info" });
  }

  return (
    <FormPage
      eyebrow="Configuración / Edificios"
      title="Edificio"
      summary="Edificios y áreas exteriores de la propiedad. Los edificios agrupan plantas y zonas."
    >
      {dirty ? (
        <div className="bo-card">
          <strong>Tienes cambios sin guardar</strong>
          <p>Guarda antes de salir o tus cambios se descartarán.</p>
        </div>
      ) : null}
      <FormValidationSummary issues={issues.length ? issues : ["No hay problemas de validación bloqueantes."]} />
      <FormSection title="Identidad del edificio">
        <FormField label="Nombre" required>
          <input aria-label="Nombre" value={values.name} onChange={(event) => patch("name", event.currentTarget.value)} placeholder="Edificio principal" />
        </FormField>
        <FormField label="Código" required>
          <input aria-label="Código" value={values.code} onChange={(event) => patch("code", event.currentTarget.value)} placeholder="MAIN" />
        </FormField>
        <FormTextarea label="Dirección" value={values.address} onChange={(value) => patch("address", value)} />
        <FormSelect label="Zona" options={ZONES} value={values.zone} onChange={(value) => patch("zone", value)} />
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
