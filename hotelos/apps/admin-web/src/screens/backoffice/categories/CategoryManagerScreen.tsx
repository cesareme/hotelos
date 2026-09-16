// Category manager (Configuración › Propiedad › Categorías). Cocoa 22 · ola 10 ·
// lote 10-C: CocoaPage (hosted in PropiedadTabs) → 4/8 grid: the groups as a
// section list and the categories in a CocoaTable whose rows open THEIR
// category («Ver») or the new-option form («Añadir opción»). Fetch and
// deep links are untouched.
import { useEffect, useState } from "react";
import { getActivePropertyId } from "../../../services/activeProperty";
import { urlForScreen } from "../../../navigation/nav-tree";
import { ACTIONS, errorStateFor } from "../../../content/actions";
import { plural } from "../../../lib/format";
import { fetchConfigurationCategories, type ConfigurationCategory, type ConfigurationCategoryGroup } from "../../../services/backofficeApi";
import { treeHeaderFor } from "../../tabs/tab-helpers";
import { CocoaBadge, CocoaButton, CocoaGrid, CocoaPage, CocoaSection, CocoaSkeleton, CocoaSpan, CocoaTable, openTabPath, type CocoaTableColumn, type CocoaTone } from "../../../components/cocoa";

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
  system_controlled: "Controlada por el sistema",
  read_only: "Solo lectura"
};

function groupLabel(group: string): string {
  return GROUP_LABELS[group] ?? group;
}

function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

function modeTone(mode: string): CocoaTone {
  if (mode === "system_controlled") return "warning";
  if (mode === "read_only") return "neutral";
  return "success";
}

const HEADER = treeHeaderFor("CategoryManagerScreen", { eyebrow: "Configuración · Propiedad", title: "Categorías de la propiedad" });

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

type CategoryRow = ConfigurationCategory & { groupLabel: string };

// Columns outside the component (§4.2 A5).
const CATEGORY_COLUMNS: CocoaTableColumn<CategoryRow>[] = [
  {
    key: "name",
    label: "Categoría",
    minWidth: 180,
    render: (category) => (
      <span className="cocoa-stack" data-gap="1">
        <strong>{category.name}</strong>
        <span className="cocoa-note">{category.groupLabel}</span>
      </span>
    )
  },
  { key: "options", label: "Opciones", fit: true, hideOnNarrow: true, render: (category) => `${category.activeOptions} activas / ${category.inactiveOptions} inactivas` },
  { key: "mode", label: "Modo", fit: true, render: (category) => <CocoaBadge tone={modeTone(category.mode)}>{modeLabel(category.mode)}</CocoaBadge> }
];

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
  const rows: CategoryRow[] = groups.flatMap((group) => group.categories.map((category) => ({ ...category, groupLabel: groupLabel(group.group) })));
  const categoryCount = rows.length;
  const errorCopy = errorStateFor("las categorías");
  const pageState = state.status === "loading" ? "loading" : state.status === "error" ? "error" : groups.length === 0 ? "empty" : "ready";

  return (
    <div data-source={source}>
      <CocoaPage
        eyebrow={HEADER.eyebrow}
        title={HEADER.title}
        subtitle="Listas de valores que usan el resto de pantallas (características de habitación, tipos de cama, segmentos de mercado, tipos de documento…). Cada categoría se abre en su propia página para añadir o desactivar opciones sin tocar código."
        state={pageState}
        skeleton={<CocoaSkeleton.Grid rows={[[4, 8]]} height={320} />}
        error={{ title: errorCopy.title, message: state.status === "error" ? `${errorCopy.message} (${state.message})` : undefined, onRetry: () => setAttempt((n) => n + 1) }}
        empty={{ title: "Sin categorías", message: "Esta propiedad todavía no tiene categorías configuradas. Se crean con la puesta en marcha o desde el API." }}
      >
        <CocoaGrid align="start" aria-label="Grupos y categorías">
          <CocoaSpan cols={4} min={240}>
            <CocoaSection title="Grupos" meta={plural(groups.length, "grupo", "grupos")}>
              <ul className="c22-section__list" aria-label="Grupos de categorías">
                {groups.map((group) => (
                  <li key={group.group}>
                    <span>{groupLabel(group.group)}</span>
                    <strong>{plural(group.categories.length, "categoría", "categorías")}</strong>
                  </li>
                ))}
              </ul>
            </CocoaSection>
          </CocoaSpan>
          <CocoaSpan cols={8} min={480}>
            {/* padding="none" + overflow clip: the table clips to the radius without creating a scroll container (§4.2 D26). */}
            <CocoaSection
              title="Categorías"
              meta={`${categoryCount} en la base de datos`}
              padding="none"
              style={{ overflow: "clip" }}
              footer={
                <span className="cocoa-note">
                  Las categorías controladas por el sistema (valores legales) se consultan pero no se renombran ni se eliminan; una opción en uso se desactiva y sigue visible en los registros históricos.
                </span>
              }
            >
              <CocoaTable
                columns={CATEGORY_COLUMNS}
                rows={rows}
                rowKey="code"
                onSelect={(category) => openCategory(category.code)}
                rowTitle={() => "Abrir la categoría"}
                rowActions={(category) => (
                  <>
                    <CocoaButton
                      variant="plain"
                      size="small"
                      onClick={(event) => {
                        event.stopPropagation();
                        openCategory(category.code);
                      }}
                    >
                      {ACTIONS.view}
                    </CocoaButton>
                    {category.mode === "system_controlled" ? null : (
                      <CocoaButton
                        variant="plain"
                        size="small"
                        onClick={(event) => {
                          event.stopPropagation();
                          openNewOption(category.code);
                        }}
                      >
                        Añadir opción
                      </CocoaButton>
                    )}
                  </>
                )}
                rowActionsVisible="always"
                caption="Categorías de la propiedad"
                aria-label="Categorías de la propiedad"
              />
            </CocoaSection>
          </CocoaSpan>
        </CocoaGrid>
      </CocoaPage>
    </div>
  );
}
