import { useEffect, useState } from "react";
import { getActivePropertyId } from "../../../services/activeProperty";
import { FormPage } from "../../../components/forms/FormComponents";
import { openTabPath } from "../../../components/cocoa/CocoaRouteTabs";
import { urlForScreen } from "../../../navigation/nav-tree";
import { EmptyState, ErrorState, LoadingBlock } from "../../../components/States";
import { ACTIONS, errorStateFor, loadingLabel } from "../../../content/actions";
import { fetchConfigurationCategories, type ConfigurationCategoryGroup } from "../../../services/backofficeApi";

// Spanish names of the category groups the API returns (its codes stay in English).
const GROUP_LABELS: Record<string, string> = {
  Property: "Propiedad",
  Rooms: "Habitaciones",
  "Spaces & Resources": "Espacios y recursos",
  Operations: "Operaciones",
  Maintenance: "Mantenimiento",
  Housekeeping: "Pisos",
  Revenue: "Ingresos",
  Distribution: "Distribución",
  "Guest Experience": "Experiencia del huésped",
  Finance: "Finanzas",
  Compliance: "Cumplimiento",
  POS: "Punto de venta",
  Assets: "Activos",
  Safety: "Seguridad",
  AI: "IA"
};

const MODE_LABELS: Record<string, string> = {
  property_editable: "Editable por la propiedad",
  property_extendable: "Ampliable por la propiedad",
  system_controlled: "Controlada por el sistema"
};

function groupLabel(group: string): string {
  return GROUP_LABELS[group] ?? group;
}

function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

// Detail and «Nueva opción» are sub-URLs of Configuración › Propiedad › Categorías
// (Tanda 5): the category code travels in the URL, so every row opens ITS category.
function openCategory(code: string): void {
  const url = urlForScreen("CategoryDetailScreen", { codigo: code });
  if (url) openTabPath(url);
}

function openNewOption(code: string): void {
  const url = urlForScreen("CategoryOptionForm", { codigo: code });
  if (url) openTabPath(url);
}

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; groups: ConfigurationCategoryGroup[] };

/**
 * Category manager: the taxonomy of the property (room features, bed types,
 * market segments, document types…) as the API returns it. L1c: no static
 * fallback catalogue any more — when the API fails the screen says so and
 * offers a retry (plan §2.1: nothing fabricated on a hotelier's screen).
 */
export function CategoryManagerScreen() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Data source marker (contract test): source: {source}
  const source = state.status === "ready" ? "api" : state.status;

  useEffect(() => {
    let mounted = true;
    setState({ status: "loading" });
    fetchConfigurationCategories(getActivePropertyId())
      .then((payload) => {
        if (mounted) setState({ status: "ready", groups: payload.groups });
      })
      .catch((error: unknown) => {
        if (mounted) setState({ status: "error", message: error instanceof Error ? error.message : "No se han podido cargar las categorías." });
      });
    return () => {
      mounted = false;
    };
  }, [attempt]);

  const groups = state.status === "ready" ? state.groups : [];
  const categoryCount = groups.reduce((total, group) => total + group.categories.length, 0);
  const errorCopy = errorStateFor("las categorías");

  return (
    <FormPage
      eyebrow="Configuración · Propiedad"
      title="Categorías de la propiedad"
      summary="Listas de valores que usan el resto de pantallas (características de habitación, tipos de cama, segmentos de mercado, tipos de documento…). Cada categoría se abre en su propia página para añadir o desactivar opciones sin tocar código."
    >
      {state.status === "loading" ? <LoadingBlock label={loadingLabel("categorías")} /> : null}
      {state.status === "error" ? (
        <ErrorState title={errorCopy.title} message={`${errorCopy.message} (${state.message})`} onRetry={() => setAttempt((n) => n + 1)} retryLabel={ACTIONS.retry} />
      ) : null}
      {state.status === "ready" && groups.length === 0 ? (
        <EmptyState title="Sin categorías" message="Esta propiedad todavía no tiene categorías configuradas. Se crean con la puesta en marcha o desde el API." />
      ) : null}
      {state.status === "ready" && groups.length > 0 ? (
        <section className="bo-grid two" data-source={source}>
          <article className="bo-card">
            <div className="bo-card-head">
              <h3>Grupos</h3>
              <span className="bo-chip">{groups.length} grupos</span>
            </div>
            <ul className="bo-list">
              {groups.map((group) => (
                <li className="bo-row" key={group.group}>
                  <strong>{groupLabel(group.group)}</strong>
                  <span className="bo-muted">{group.categories.length} categorías</span>
                </li>
              ))}
            </ul>
          </article>
          <article className="bo-card">
            <div className="bo-card-head">
              <h3>Categorías</h3>
              <span className="bo-chip">{categoryCount} en la base de datos</span>
            </div>
            <ul className="bo-list">
              {groups.flatMap((group) =>
                group.categories.map((category) => (
                  <li className="bo-row" key={category.code}>
                    <strong>{category.name}</strong>
                    <span>
                      {category.activeOptions} activas / {category.inactiveOptions} inactivas
                    </span>
                    <span className={`bo-status ${category.mode === "system_controlled" ? "warn" : "ok"}`}>{modeLabel(category.mode)}</span>
                    <span className="bo-actions">
                      <button type="button" onClick={() => openCategory(category.code)}>{ACTIONS.view}</button>
                      {category.mode === "system_controlled" ? null : (
                        <button type="button" onClick={() => openNewOption(category.code)}>Añadir opción</button>
                      )}
                    </span>
                  </li>
                ))
              )}
            </ul>
            <p className="bo-muted" style={{ textTransform: "none", letterSpacing: 0 }}>
              Las categorías controladas por el sistema (valores legales) se consultan pero no se renombran ni se eliminan; una opción en uso se desactiva y sigue visible en los registros históricos.
            </p>
          </article>
        </section>
      ) : null}
    </FormPage>
  );
}
