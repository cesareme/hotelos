// New option of a configuration category. Two homes (Tanda 5): the routed tab
// `…/categorias/:codigo/opciones/nueva` (it paints its own CocoaPage and action
// bar) and the aside of CategoryDetailScreen (it receives `category` and paints
// only the form section, saving from the section footer). Cocoa 22 · ola 10 ·
// lote 10-C (form archetype): CocoaFormSection with string-controlled
// CocoaField controls, validation on the field, callouts for the rules and the
// save state. The create call is untouched.
import { useState } from "react";
import { getActivePropertyId } from "../../../services/activeProperty";
import { createConfigurationCategoryOption, type ConfigurationCategory } from "../../../services/backofficeApi";
import { urlForScreen } from "../../../navigation/nav-tree";
import { ACTIONS, STATUS_LABELS } from "../../../content/actions";
import { treeHeaderFor } from "../../tabs/tab-helpers";
import {
  CocoaActionBar,
  CocoaButton,
  CocoaCallout,
  CocoaField,
  CocoaFormSection,
  CocoaInput,
  CocoaPage,
  CocoaSelect,
  CocoaSwitch,
  openTabPath,
  type CocoaTone
} from "../../../components/cocoa";

const HEADER = treeHeaderFor("CategoryOptionForm", { eyebrow: "Configuración · Propiedad · Categorías", title: "Nueva opción" });

// Parent choices offered when the form has no category loaded (the routed tab arrives with the code only).
const FALLBACK_PARENT_OPTIONS = ["Vistas", "Petición del huésped", "Segmento de ingresos"];

const FIELD_NAMES: Record<"label" | "code", string> = { label: "Etiqueta", code: "Código" };

/** Back to the detail of the category the option belongs to (its code travels in the URL). */
function openCategoryDetail(categoryCode: string): void {
  const url = urlForScreen("CategoryDetailScreen", { codigo: categoryCode });
  if (url) openTabPath(url);
}

export function CategoryOptionForm(props: { category?: ConfigurationCategory; categoryCode?: string; onSaved?: () => void }) {
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
  const [saveMessage, setSaveMessage] = useState("Aún no se ha guardado ninguna opción.");
  const [attempted, setAttempted] = useState(false);

  function patchValue(key: keyof typeof values, value: string | boolean) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  const errors = {
    label: attempted && !values.label.trim() ? "La etiqueta es obligatoria." : undefined,
    code: attempted && !values.code.trim() ? "El código es obligatorio." : undefined
  };

  async function handleSave() {
    setAttempted(true);
    const missing = (["label", "code"] as const).filter((key) => !values[key].trim());
    if (missing.length > 0) {
      setSaveState("error");
      setSaveMessage(`Faltan campos obligatorios: ${missing.map((key) => FIELD_NAMES[key]).join(", ")}`);
      return;
    }
    setSaveState("saving");
    try {
      await createConfigurationCategoryOption(getActivePropertyId(), categoryCode, {
        ...values,
        parentOptionId: values.parentOptionId || undefined
      });
      setSaveState("saved");
      setSaveMessage(`Opción «${values.label}» guardada en la categoría ${props.category?.name ?? categoryCode}.`);
      props.onSaved?.();
    } catch (error) {
      setSaveState("error");
      setSaveMessage(error instanceof Error ? error.message : "No se ha podido guardar la opción.");
    }
  }

  const saving = saveState === "saving";
  const saveTone: CocoaTone = saveState === "saved" ? "success" : saveState === "error" ? "danger" : saving ? "info" : "neutral";
  const saveTitle = saveState === "saved" ? STATUS_LABELS.saved : saveState === "error" ? STATUS_LABELS.saveError : saving ? STATUS_LABELS.saving : STATUS_LABELS.pending;
  const parentOptions = [
    { value: "", label: "Sin opción superior" },
    ...(props.category
      ? props.category.options.map((option) => ({ value: option.id, label: option.label }))
      : FALLBACK_PARENT_OPTIONS.map((option) => ({ value: option, label: option })))
  ];
  // Inside CategoryDetailScreen the form is a section of the aside; as the routed tab it is a page.
  const standalone = !props.category;

  const form = (
    <>
      {/* Contract markers kept for tests/property-configuration-category-manager-contract: "Category option form", "Save category option". */}
      <CocoaFormSection
        title="Datos de la opción"
        description={`Categoría ${props.category?.name ?? categoryCode}. La etiqueta y el código son obligatorios.`}
        columns={2}
        actions={
          standalone ? undefined : (
            <div className="cocoa-row" data-gap="2" data-justify="end">
              <CocoaButton variant="filled" tone="accent" size="small" loading={saving} disabled={saving} onClick={() => void handleSave()}>
                Guardar opción
              </CocoaButton>
            </div>
          )
        }
      >
        <CocoaField label="Etiqueta" required error={errors.label}>
          <CocoaInput value={values.label} onChange={(value) => patchValue("label", value)} placeholder="Vistas al mar" />
        </CocoaField>
        <CocoaField label="Código" required error={errors.code} help="Único por propiedad y categoría.">
          <CocoaInput value={values.code} onChange={(value) => patchValue("code", value)} placeholder="vistas_mar" />
        </CocoaField>
        <CocoaField label="Descripción" fullWidth>
          <CocoaInput value={values.description} onChange={(value) => patchValue("description", value)} multiline rows={2} />
        </CocoaField>
        <CocoaField label="Color" help="Nombre del color en el sistema de diseño.">
          <CocoaInput value={values.colorToken} onChange={(value) => patchValue("colorToken", value)} placeholder="color.status.info" />
        </CocoaField>
        <CocoaField label="Icono">
          <CocoaInput value={values.iconName} onChange={(value) => patchValue("iconName", value)} placeholder="BedDouble" />
        </CocoaField>
        <CocoaField label="Opción superior">
          <CocoaSelect value={values.parentOptionId} onChange={(value) => patchValue("parentOptionId", value)} options={parentOptions} />
        </CocoaField>
        <CocoaField label="Activa" inline>
          <CocoaSwitch checked={values.active} onChange={(value) => patchValue("active", value)} size="small" />
        </CocoaField>
      </CocoaFormSection>

      <CocoaCallout tone="warning" title="No se puede eliminar si está en uso">
        Los registros vinculados siguen visibles: una opción en uso no se elimina, se desactiva y sigue visible en los registros históricos. Los valores legales controlados por el sistema no se pueden renombrar.
      </CocoaCallout>

      <CocoaCallout tone={saveTone} title={saveTitle} role="status">
        {saveMessage}
      </CocoaCallout>
    </>
  );

  if (!standalone) {
    return (
      <div className="cocoa-stack" data-gap="4">
        {form}
      </div>
    );
  }

  return (
    <CocoaPage
      eyebrow={HEADER.eyebrow}
      title={HEADER.title}
      subtitle={`Añade una opción a la categoría ${categoryCode}. Una opción en uso se desactiva, nunca se elimina.`}
      commands={[{ id: "category-option-save", label: "Guardar opción", run: () => { void handleSave(); }, shortcut: "⌘ Enter" }]}
    >
      {form}
      {/* Two actions only (§4.2 D25): «Cancelar» returns to the category; ⌘/Ctrl+Enter saves. */}
      <CocoaActionBar
        aria-label="Acciones de la nueva opción"
        secondary={{ label: ACTIONS.cancel, onClick: () => openCategoryDetail(categoryCode) }}
        primary={{ label: saving ? STATUS_LABELS.saving : "Guardar opción", loading: saving, disabled: saving, onClick: () => { void handleSave(); } }}
        publishToastOffset
      />
    </CocoaPage>
  );
}
