import { useCallback, useEffect, useState } from "react";
import { getActivePropertyId } from "../../../services/activeProperty";
import { FormPage } from "../../../components/forms/FormComponents";
import { EmptyState, ErrorState, LoadingBlock } from "../../../components/States";
import { ACTIONS, errorStateFor, loadingLabel } from "../../../content/actions";
import { fetchConfigurationCategory, type ConfigurationCategory } from "../../../services/backofficeApi";
import { CategoryOptionForm } from "./CategoryOptionForm";
import { openTabPath } from "../../../components/cocoa/CocoaRouteTabs";
import { urlForScreen } from "../../../navigation/nav-tree";

const MODE_LABELS: Record<string, string> = {
  property_editable: "Editable por la propiedad",
  property_extendable: "Ampliable por la propiedad",
  system_controlled: "Controlada por el sistema"
};

/** Sub-URL of the «Nueva opción» form of a category (the code travels in the URL, never a fixed fallback). */
function openOptionForm(categoryCode: string): void {
  const url = urlForScreen("CategoryOptionForm", { codigo: categoryCode });
  if (url) openTabPath(url);
}

function openManager(): void {
  const url = urlForScreen("CategoryManagerScreen");
  if (url) openTabPath(url);
}

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; category: ConfigurationCategory };

/**
 * `categoryCode` comes from the `:codigo` sub-URL of Configuración › Propiedad ›
 * Categorías (Tanda 5). L1c: without a code, or when the API fails, the screen
 * says so instead of painting the old «Room features» demo category.
 */
export function CategoryDetailScreen({ categoryCode }: { categoryCode?: string; embedded?: boolean } = {}) {
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

  return (
    <FormPage
      eyebrow="Configuración · Propiedad · Categorías"
      title={category?.name ?? categoryCode ?? "Categoría"}
      summary="Opciones de la categoría con color, icono, descripción, opción superior, número de usos y estado. Una opción en uso se desactiva, nunca se elimina."
    >
      {state.status === "loading" ? <LoadingBlock label={loadingLabel("opciones")} /> : null}
      {state.status === "error" ? (
        <ErrorState title={errorCopy.title} message={`${errorCopy.message} (${state.message})`} onRetry={categoryCode ? refreshCategory : openManager} retryLabel={categoryCode ? ACTIONS.retry : "Ver todas las categorías"} />
      ) : null}
      {category ? (
        <section className="bo-grid two" data-source={source}>
          <article className="bo-card">
            <div className="bo-card-head">
              <h3>Opciones</h3>
              <div className="bo-actions">
                {/* Nueva opción de ESTA categoría: /configuracion/propiedad/categorias/:codigo/opciones/nueva (Tanda 5). */}
                {category.mode === "system_controlled" ? null : (
                  <button className="primary" type="button" onClick={() => openOptionForm(category.code)}>Añadir opción</button>
                )}
              </div>
            </div>
            <p>
              <span className={`bo-status ${category.mode === "system_controlled" ? "warn" : "ok"}`}>{MODE_LABELS[category.mode] ?? category.mode}</span>
            </p>
            {category.options.length === 0 ? (
              <EmptyState title="Sin opciones" message="Esta categoría todavía no tiene opciones. Añade la primera con «Añadir opción»." />
            ) : (
              <ul className="bo-list">
                {category.options.map((option) => (
                  <li className="bo-row" key={option.id}>
                    <strong>{option.label}</strong>
                    <span>{option.code}</span>
                    {/* usageCount = linked records (rooms, reservations…) that still reference the option. */}
                    <span>{option.usageCount} registros vinculados</span>
                    <span className={`bo-status ${option.active ? "ok" : "warn"}`}>{option.active ? "activa" : "inactiva"}</span>
                  </li>
                ))}
              </ul>
            )}
          </article>
          <article className="bo-card">
            <CategoryOptionForm category={category} onSaved={refreshCategory} />
          </article>
        </section>
      ) : null}
    </FormPage>
  );
}
