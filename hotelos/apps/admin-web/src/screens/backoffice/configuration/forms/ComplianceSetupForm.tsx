import { useState } from "react";
import {
  FormField,
  FormMultiSelect,
  FormPage,
  FormSection,
  FormSelect,
  FormStickyActionBar,
  FormSwitch,
  FormTextarea,
  FormValidationSummary
} from "../../../../components/forms/FormComponents";
import { useToast } from "../../../../components/Toast";

const AUTHORITY_TYPES = ["SES.HOSPEDAJES", "Mossos", "Ertzaintza", "Manual", "Otro"];
const LEGAL_DOC_TYPES = ["DNI", "Pasaporte", "TIE", "NIE", "ID UE"];
const SUBMISSION_MODES = ["Cola automática", "Lote diario", "Exportación manual"];

export function ComplianceSetupForm() {
  const { showToast } = useToast();
  const [values, setValues] = useState({
    authorityTypes: [] as string[],
    legalDocumentTypes: [] as string[],
    submissionMode: "",
    retentionRules: "",
    active: true
  });
  const [dirty, setDirty] = useState(false);

  function patch<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  const issues: string[] = [];
  if (values.authorityTypes.length === 0) issues.push("Se requiere al menos un tipo de autoridad.");
  if (!values.submissionMode) issues.push("El modo de envío es obligatorio.");

  function handleSave(addAnother: boolean) {
    if (issues.length > 0) {
      return;
    }
    setDirty(false);
    if (addAnother) {
      setValues({ authorityTypes: [], legalDocumentTypes: [], submissionMode: "", retentionRules: "", active: true });
    }
  }

  function handleDeactivate() {
    patch("active", false);
    showToast("Configuración de cumplimiento desactivada", { variant: "info" });
  }

  return (
    <FormPage
      eyebrow="Configuración / Cumplimiento"
      title="Configuración de cumplimiento"
      summary="Tipos de autoridad, tipos de documento legal, modos de envío y reglas de retención para registros de huéspedes, facturas y exportaciones."
    >
      {dirty ? (
        <div className="bo-card">
          <strong>Tienes cambios sin guardar</strong>
          <p>Guarda antes de salir o tus cambios se descartarán.</p>
        </div>
      ) : null}
      <FormValidationSummary issues={issues.length ? issues : ["No hay problemas de validación bloqueantes."]} />
      <FormSection title="Autoridades y documentos">
        <FormMultiSelect label="Tipos de autoridad" options={AUTHORITY_TYPES} value={values.authorityTypes} onChange={(value) => patch("authorityTypes", value)} />
        <FormMultiSelect label="Tipos de documento legal" options={LEGAL_DOC_TYPES} value={values.legalDocumentTypes} onChange={(value) => patch("legalDocumentTypes", value)} />
        <FormSelect label="Modo de envío" required options={SUBMISSION_MODES} value={values.submissionMode} onChange={(value) => patch("submissionMode", value)} />
      </FormSection>
      <FormSection title="Retención">
        <FormTextarea label="Reglas de retención" value={values.retentionRules} onChange={(value) => patch("retentionRules", value)} />
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
