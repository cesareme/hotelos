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

const CONFIRMATION_RULES = ["Requerir siempre confirmación manual", "Auto-aplicar para impacto bajo", "Auto-aplicar para cualquier sugerencia de IA", "Desactivado"];
const PREVIEW_MODES = ["Previsualizar antes de aplicar", "Previsualización lado a lado", "Previsualización en línea", "Sin previsualización"];
const AUDIT_SCOPES = ["Sugerencias de IA", "Cambios aplicados por IA", "Sugerencias rechazadas de IA", "Cambios de configuración", "Cambios manuales del usuario"];

export function AISetupForm() {
  const { showToast } = useToast();
  const [values, setValues] = useState({
    suggestionsEnabled: true,
    confirmationRule: "",
    previewMode: "",
    auditScopes: [] as string[]
  });
  const [dirty, setDirty] = useState(false);

  function patch<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  const issues: string[] = [];
  if (!values.confirmationRule) issues.push("La regla de confirmación es obligatoria.");
  if (!values.previewMode) issues.push("El modo de previsualización es obligatorio.");

  function handleSave(addAnother: boolean) {
    if (issues.length > 0) {
      return;
    }
    setDirty(false);
    if (addAnother) {
      setValues({ suggestionsEnabled: true, confirmationRule: "", previewMode: "", auditScopes: [] });
    }
  }

  function handleDeactivate() {
    patch("suggestionsEnabled", false);
    showToast("Sugerencias de IA desactivadas", { variant: "info" });
  }

  return (
    <FormPage
      eyebrow="Configuración / IA"
      title="Configuración de IA"
      summary="Sugerencias de categorías de IA, reglas de confirmación, modo de previsualización y alcance de eventos de auditoría para cambios de configuración impulsados por IA."
    >
      {dirty ? (
        <div className="bo-card">
          <strong>Tienes cambios sin guardar</strong>
          <p>Guarda antes de salir o tus cambios se descartarán.</p>
        </div>
      ) : null}
      <FormValidationSummary issues={issues.length ? issues : ["No hay problemas de validación bloqueantes."]} />
      <FormSection title="Sugerencias y confirmación">
        <FormSwitch label="Sugerencias de categorías de IA activadas" value={values.suggestionsEnabled} onChange={(value) => patch("suggestionsEnabled", value)} />
        <FormSelect label="Regla de confirmación" required options={CONFIRMATION_RULES} value={values.confirmationRule} onChange={(value) => patch("confirmationRule", value)} />
        <FormSelect label="Modo de previsualización" required options={PREVIEW_MODES} value={values.previewMode} onChange={(value) => patch("previewMode", value)} />
      </FormSection>
      <FormSection title="Auditoría">
        <FormMultiSelect label="Alcance de eventos de auditoría" options={AUDIT_SCOPES} value={values.auditScopes} onChange={(value) => patch("auditScopes", value)} />
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
