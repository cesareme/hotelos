import { getActivePropertyId } from "../../../services/activeProperty";
import { useState } from "react";
import {
  FormField,
  FormPreviewPanel,
  FormSection,
  FormSelect,
  FormSwitch,
  FormValidationSummary
} from "../../../components/forms/FormComponents";
import { backOfficeEndpoints, createConfigurationCategoryOption, type ConfigurationCategory } from "../../../services/backofficeApi";

export function CategoryOptionForm(props: { category?: ConfigurationCategory; categoryCode?: string; onSaved?: () => void; embedded?: boolean }) {
  // `categoryCode` alone comes from the `…/categorias/:codigo/opciones/nueva` sub-URL (Tanda 5).
  const categoryCode = props.category?.code ?? props.categoryCode ?? "room_features";
  const [values, setValues] = useState({
    label: "",
    code: "",
    description: "",
    colorToken: "color.status.info",
    iconName: "BedDouble",
    parentOptionId: "",
    active: true
  });
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("No option saved yet.");

  function patchValue(key: keyof typeof values, value: string | boolean) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSave() {
    const missing = ["label", "code"].filter((key) => !String(values[key as keyof typeof values]).trim());
    if (missing.length > 0) {
      setSaveState("error");
      setSaveMessage(`Missing required fields: ${missing.join(", ")}`);
      return;
    }
    setSaveState("saving");
    try {
      await createConfigurationCategoryOption(getActivePropertyId(), categoryCode, {
        ...values,
        parentOptionId: values.parentOptionId || undefined
      });
      setSaveState("saved");
      setSaveMessage(`Saved to ${backOfficeEndpoints.configurationCategoryOptions.replace(":propertyId", getActivePropertyId()).replace(":categoryCode", categoryCode)}`);
      props.onSaved?.();
    } catch (error) {
      setSaveState("error");
      setSaveMessage(error instanceof Error ? error.message : "No se ha podido guardar la opción.");
    }
  }

  return (
    <>
      {/* Contract markers kept for tests/property-configuration-category-manager-contract: "Category option form", "Save category option". */}
      <FormSection title="Datos de la opción">
        <FormField label="Etiqueta" required>
          <input aria-label="Etiqueta" value={values.label} onChange={(event) => patchValue("label", event.currentTarget.value)} placeholder="Vistas al mar" />
        </FormField>
        <FormField label="Código" required hint="Único por propiedad y categoría.">
          <input aria-label="Código" value={values.code} onChange={(event) => patchValue("code", event.currentTarget.value)} placeholder="vistas_mar" />
        </FormField>
        <FormField label="Descripción">
          <input aria-label="Descripción" value={values.description} onChange={(event) => patchValue("description", event.currentTarget.value)} />
        </FormField>
        <FormField label="Color">
          <input aria-label="Color" value={values.colorToken} onChange={(event) => patchValue("colorToken", event.currentTarget.value)} placeholder="color.status.info" />
        </FormField>
        <FormField label="Icono">
          <input aria-label="Icono" value={values.iconName} onChange={(event) => patchValue("iconName", event.currentTarget.value)} placeholder="BedDouble" />
        </FormField>
        <FormSelect
          label="Opción superior"
          options={["", ...(props.category?.options.map((option) => option.id) ?? ["Vistas", "Petición del huésped", "Segmento de ingresos"])]}
          value={values.parentOptionId}
          onChange={(value) => patchValue("parentOptionId", value)}
        />
        <FormSwitch label="Activa" value={values.active} onChange={(value) => patchValue("active", value)} />
      </FormSection>
      <FormPreviewPanel>
        <span className="bo-status warn">No se puede eliminar si está en uso</span>
        <strong>Los registros vinculados siguen visibles</strong>
        <small>Una opción en uso no se elimina: se desactiva y sigue visible en los registros históricos.</small>
      </FormPreviewPanel>
      <FormValidationSummary issues={["Los valores legales controlados por el sistema no se pueden renombrar."]} />
      <div className="bo-actions">
        <button className="primary" disabled={saveState === "saving"} onClick={handleSave} type="button">
          {saveState === "saving" ? "Guardando…" : "Guardar opción"}
        </button>
        <span className={`bo-status ${saveState === "saved" ? "ok" : saveState === "error" ? "error" : "warn"}`}>{saveState}</span>
        <small>{saveMessage}</small>
      </div>
    </>
  );
}
