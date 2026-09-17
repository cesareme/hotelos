// Detail of a configuration category (Configuración › Propiedad › Categorías › :codigo).
// Cocoa 22 · ola 10 · lote 10-C (detail archetype): CocoaPage with the mode
// badge and «Añadir opción» in the head → 8/4 grid: the options in a
// CocoaTable, the aside with the counts (CocoaStat) and the new-option form.
// The fetch and the sub-URL contract (`categoryCode` from `:codigo`) are untouched.
import { useCallback, useEffect, useState } from "react";
import { getActivePropertyId } from "../../../services/activeProperty";
import { errorStateFor } from "../../../content/actions";
import { plural } from "../../../lib/format";
import { fetchConfigurationCategory, type ConfigurationCategory, type ConfigurationCategoryOption } from "../../../services/backofficeApi";
import { urlForScreen } from "../../../navigation/nav-tree";
import { treeHeaderFor } from "../../tabs/tab-helpers";
import { CategoryOptionForm } from "./CategoryOptionForm";
import {
  CocoaBadge,
  CocoaButton,
  CocoaGrid,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaTable,
  openTabPath,
  type CocoaTableColumn,
  type CocoaTone
} from "../../../components/cocoa";

const MODE_LABELS: Record<string, string> = {
  property_editable: "Editable por la propiedad",
  property_extendable: "Ampliable por la propiedad",
  system_controlled: "Controlada por el sistema",
  read_only: "Solo lectura"
};

function modeTone(mode: string): CocoaTone {
  if (mode === "system_controlled") return "warning";
  if (mode === "read_only") return "neutral";
  return "success";
}

const HEADER = treeHeaderFor("CategoryDetailScreen", { eyebrow: "Configuración · Propiedad · Categorías", title: "Categoría" });

/** Sub-URL of the «Nueva opción» form of a category (the code travels in the URL, never a fixed fallback). */
function openOptionForm(categoryCode: string): void {
  const url = urlForScreen("CategoryOptionForm", { codigo: categoryCode });
  if (url) openTabPath(url);
}

function openManager(): void {
  const url = urlForScreen("CategoryManagerScreen");
  if (url) openTabPath(url);
}

// Columns outside the component (§4.2 A5).
// usageCount = linked records (rooms, reservations…) that still reference the option.
const OPTION_COLUMNS: CocoaTableColumn<ConfigurationCategoryOption>[] = [
  { key: "label", label: "Etiqueta", minWidth: 160, render: (option) => <strong>{option.label}</strong> },
  { key: "code", label: "Código", fit: true, hideOnNarrow: true },
  { key: "usageCount", label: "Registros vinculados", align: "right", fit: true, render: (option) => plural(option.usageCount, "registro", "registros") },
  {
    key: "active",
    label: "Estado",
    fit: true,
    render: (option) => <CocoaBadge tone={option.active ? "success" : "warning"}>{option.active ? "activa" : "inactiva"}</CocoaBadge>
  }
];

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; category: ConfigurationCategory };

/**
 * `categoryCode` comes from the `:codigo` sub-URL of Configuración › Propiedad ›
 * Categorías (Tanda 5). L1c: without a code, or when the API fails, the screen
 * says so instead of painting the old «Room features» demo category.
 */
export function CategoryDetailScreen({ categoryCode }: { categoryCode?: string } = {}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Data source marker (contract test): source: {source}
  const source = state.status === "ready" ? "api" : state.status;

  const refreshCategory = useCallback(() => {
    if (!categoryCode) {
      setState({ status: "error", message: "La URL no indica qué categoría abrir." });
      return;
    }
    setState({ status: "loading" });
    fetchConfigurationCategory(getActivePropertyId(), categoryCode)
      .then((payload) => setState({ status: "ready", category: payload }))
      .catch((error: unknown) => setState({ status: "error", message: error instanceof Error ? error.message : "No se ha podido cargar la categoría." }));
  }, [categoryCode]);

  useEffect(() => {
    refreshCategory();
  }, [refreshCategory]);

  const errorCopy = errorStateFor("la categoría");
  const category = state.status === "ready" ? state.category : null;
  const canAdd = category !== null && category.mode !== "system_controlled";
  const activeCount = category?.options.filter((option) => option.active).length ?? 0;
  const inactiveCount = category ? category.options.length - activeCount : 0;

  return (
    <div data-source={source}>
      <CocoaPage
        eyebrow={HEADER.eyebrow}
        title={category?.name ?? categoryCode ?? HEADER.title}
        subtitle="Opciones de la categoría con color, icono, descripción, opción superior, número de usos y estado. Una opción en uso se desactiva, nunca se elimina."
        actions={
          <>
            {category ? <CocoaBadge tone={modeTone(category.mode)}>{MODE_LABELS[category.mode] ?? category.mode}</CocoaBadge> : null}
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={openManager}>
              Ver todas las categorías
            </CocoaButton>
            {/* Nueva opción de ESTA categoría: /configuracion/propiedad/categorias/:codigo/opciones/nueva (Tanda 5). */}
            {category && canAdd ? (
              <CocoaButton variant="filled" tone="accent" size="small" onClick={() => openOptionForm(category.code)}>
                Añadir opción
              </CocoaButton>
            ) : null}
          </>
        }
        state={state.status === "loading" ? "loading" : state.status === "error" ? "error" : "ready"}
        skeleton={<CocoaSkeleton.Grid rows={[[8, 4]]} height={280} />}
        error={{
          title: errorCopy.title,
          message: state.status === "error" ? `${errorCopy.message} (${state.message})` : undefined,
          onRetry: categoryCode ? refreshCategory : undefined,
          primaryAction: categoryCode ? undefined : { label: "Ver todas las categorías", onClick: openManager }
        }}
        commands={category && canAdd ? [{ id: "category-detail-new-option", label: `Añadir opción a ${category.name}`, run: () => openOptionForm(category.code) }] : undefined}
      >
        {category ? (
          <CocoaGrid align="start" aria-label="Opciones de la categoría y nueva opción">
            <CocoaSpan cols={8} min={480}>
              {/* padding="none" + overflow clip: the table clips to the radius without creating a scroll container (§4.2 D26). */}
              <CocoaSection title="Opciones" meta={plural(category.options.length, "opción", "opciones")} padding={category.options.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
                {category.options.length === 0 ? (
                  <CocoaState
                    kind="empty"
                    illustration="box"
                    title="Sin opciones"
                    message="Esta categoría todavía no tiene opciones. Añade la primera con «Añadir opción»."
                    primaryAction={canAdd ? { label: "Añadir opción", onClick: () => openOptionForm(category.code) } : undefined}
                  />
                ) : (
                  <CocoaTable columns={OPTION_COLUMNS} rows={category.options} rowKey="id" caption={`Opciones de ${category.name}`} aria-label={`Opciones de ${category.name}`} />
                )}
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={4} min={320}>
              <div className="cocoa-stack" data-gap="4">
                <CocoaSection title="Resumen" meta={category.code}>
                  <div className="cocoa-stack" data-gap="3">
                    <CocoaStat label="Opciones activas" value={activeCount} tone="success" />
                    <CocoaStat label="Opciones inactivas" value={inactiveCount} tone={inactiveCount > 0 ? "warning" : "neutral"} />
                    {category.description ? <p className="cocoa-note">{category.description}</p> : null}
                  </div>
                </CocoaSection>
                <CategoryOptionForm category={category} onSaved={refreshCategory} />
              </div>
            </CocoaSpan>
          </CocoaGrid>
        ) : null}
      </CocoaPage>
    </div>
  );
}
