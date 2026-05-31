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

export function CategoryOptionForm(props: { category?: ConfigurationCategory; onSaved?: () => void }) {
  const categoryCode = props.category?.code ?? "room_features";
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
      setSaveMessage(error instanceof Error ? error.message : "Unable to save category option.");
    }
  }

  return (
    <>
      <FormSection title="Category option form">
        <FormField label="Label" required>
          <input aria-label="Label" value={values.label} onChange={(event) => patchValue("label", event.currentTarget.value)} placeholder="Sea view" />
        </FormField>
        <FormField label="Code" required hint="Unique per property and category.">
          <input aria-label="Code" value={values.code} onChange={(event) => patchValue("code", event.currentTarget.value)} placeholder="sea_view" />
        </FormField>
        <FormField label="Description">
          <input aria-label="Description" value={values.description} onChange={(event) => patchValue("description", event.currentTarget.value)} />
        </FormField>
        <FormField label="Color token">
          <input aria-label="Color token" value={values.colorToken} onChange={(event) => patchValue("colorToken", event.currentTarget.value)} placeholder="color.status.info" />
        </FormField>
        <FormField label="Icon">
          <input aria-label="Icon" value={values.iconName} onChange={(event) => patchValue("iconName", event.currentTarget.value)} placeholder="BedDouble" />
        </FormField>
        <FormSelect
          label="Parent option"
          options={["", ...(props.category?.options.map((option) => option.id) ?? ["Room view", "Guest request", "Revenue segment"])]}
          value={values.parentOptionId}
          onChange={(value) => patchValue("parentOptionId", value)}
        />
        <FormSwitch label="Active" value={values.active} onChange={(value) => patchValue("active", value)} />
      </FormSection>
      <FormPreviewPanel>
        <span className="bo-status warn">Deletion blocked if in use</span>
        <strong>Linked records stay visible</strong>
        <small>Options with usage count cannot be deleted. They can be deactivated and remain visible on historical records.</small>
      </FormPreviewPanel>
      <FormValidationSummary issues={["System-controlled legal values cannot be renamed.", "Bulk category creation requires preview and confirmation."]} />
      <div className="bo-actions">
        <button className="primary" disabled={saveState === "saving"} onClick={handleSave} type="button">
          {saveState === "saving" ? "Saving..." : "Save category option"}
        </button>
        <button type="button">Guardar y añadir otro</button>
        <button type="button">Cancelar</button>
        <button type="button">Audit trail</button>
        <span className={`bo-status ${saveState === "saved" ? "ok" : saveState === "error" ? "error" : "warn"}`}>{saveState}</span>
        <small>{saveMessage}</small>
      </div>
    </>
  );
}
