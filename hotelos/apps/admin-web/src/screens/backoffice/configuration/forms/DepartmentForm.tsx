import { useState } from "react";
import {
  FormField,
  FormMultiSelect,
  FormPage,
  FormSection,
  FormSelect,
  FormStickyActionBar,
  FormSwitch,
  FormValidationSummary
} from "../../../../components/forms/FormComponents";
import { useToast } from "../../../../components/Toast";

const MANAGERS = ["Jefe de recepción", "Gobernanta", "Jefe de mantenimiento", "Revenue manager", "Jefe de A&B", "Jefe de spa"];
const MEMBERS = ["Ana", "Carlos", "Maria", "Jorge", "Lucia", "Diego", "Sara", "Marc"];
const COST_CENTERS = ["CC-Recepción", "CC-Pisos", "CC-Mantenimiento", "CC-Revenue", "CC-Spa", "CC-AyB"];

export function DepartmentForm() {
  const { showToast } = useToast();
  const [values, setValues] = useState({
    name: "",
    code: "",
    manager: "",
    members: [] as string[],
    costCenter: "",
    active: true
  });
  const [dirty, setDirty] = useState(false);

  function patch<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  const issues: string[] = [];
  if (!values.name.trim()) issues.push("El nombre del departamento es obligatorio.");
  if (!values.code.trim()) issues.push("El código del departamento es obligatorio.");

  function handleSave(addAnother: boolean) {
    if (issues.length > 0) {
      return;
    }
    setDirty(false);
    if (addAnother) {
      setValues({ name: "", code: "", manager: "", members: [], costCenter: "", active: true });
    }
  }

  function handleDeactivate() {
    patch("active", false);
    showToast("Departamento desactivado", { variant: "info" });
  }

  return (
    <FormPage
      eyebrow="Configuración / Departamentos"
      title="Departamento"
      summary="Equipos, responsables, miembros y centros de coste usados para el enrutamiento de tareas y los informes financieros."
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
          <input aria-label="Nombre" value={values.name} onChange={(event) => patch("name", event.currentTarget.value)} placeholder="Recepción" />
        </FormField>
        <FormField label="Código" required>
          <input aria-label="Código" value={values.code} onChange={(event) => patch("code", event.currentTarget.value)} placeholder="FO" />
        </FormField>
      </FormSection>
      <FormSection title="Responsable y finanzas">
        <FormSelect label="Responsable" options={MANAGERS} value={values.manager} onChange={(value) => patch("manager", value)} />
        <FormMultiSelect label="Miembros" options={MEMBERS} value={values.members} onChange={(value) => patch("members", value)} />
        <FormSelect label="Centro de coste" options={COST_CENTERS} value={values.costCenter} onChange={(value) => patch("costCenter", value)} />
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
