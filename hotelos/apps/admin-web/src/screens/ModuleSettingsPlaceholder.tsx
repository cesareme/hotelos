// Dev-only placeholder of the 16 module settings screens without a backing
// endpoint (/desarrollo/*-ajustes, `?dev=1` + platform admin; App.tsx wires
// them through `makeModulePlaceholder`). Cocoa 22 · ola 11: a CocoaPage with
// an empty CocoaState that points at the module's real surface (dashboard,
// setup) and a grid of related screens; no legacy `.bo-*` classes, no raw
// buttons, no inline colours.

import { CocoaBadge, CocoaButton, CocoaCard, CocoaGrid, CocoaPage, CocoaSection, CocoaSpan, CocoaState, type CocoaTone } from "../components/cocoa";
import { plural } from "../lib/format";
import { navigateTo, type ScreenKey } from "../lib/navigate";

export type ModuleSettingsConfig = {
  moduleName: string;
  eyebrow?: string;
  summary?: string;
  dashboardScreen?: string;
  dashboardLabel?: string;
  setupScreen?: string;
  setupLabel?: string;
  relatedScreens?: Array<{ label: string; screen: string }>;
  status?: "ok" | "warn" | "error";
  statusLabel?: string;
};

const STATUS_TONE: Record<NonNullable<ModuleSettingsConfig["status"]>, CocoaTone> = {
  ok: "success",
  warn: "warning",
  error: "danger"
};

const EMPTY_MESSAGE =
  "Este módulo no tiene ajustes propios: su configuración vive en el tablero del módulo y en Puesta en marcha. Desde aquí puedes abrir el tablero y las pantallas relacionadas; si echas en falta un ajuste, pídelo a dirección: se activa desde «Configuración › Módulos e integraciones».";

const NO_LINKS_MESSAGE =
  "Este módulo no tiene ajustes propios. La configuración general (activar módulos, integraciones, campos personalizados) se gestiona en «Configuración › Módulos e integraciones».";

/** Screen keys arrive as plain strings from App.tsx; the registry is the source of truth. */
function open(screen: string): void {
  navigateTo(screen as ScreenKey);
}

export function ModuleSettingsPlaceholder(props: ModuleSettingsConfig) {
  const { dashboardScreen, setupScreen, relatedScreens } = props;
  const eyebrow = props.eyebrow ?? "Desarrollo · Ajustes del módulo";
  const hasLinks = Boolean(dashboardScreen || setupScreen || relatedScreens?.length);

  return (
    <CocoaPage
      eyebrow={eyebrow}
      title={props.moduleName}
      subtitle={props.summary}
      actions={
        props.statusLabel ? (
          <CocoaBadge tone={STATUS_TONE[props.status ?? "ok"]} variant="tinted">
            {props.statusLabel}
          </CocoaBadge>
        ) : undefined
      }
    >
      <CocoaState
        kind="empty"
        illustration="box"
        title="Módulo en preparación"
        message={hasLinks ? EMPTY_MESSAGE : NO_LINKS_MESSAGE}
        primaryAction={dashboardScreen ? { label: props.dashboardLabel ?? "Abrir tablero", onClick: () => open(dashboardScreen) } : undefined}
        secondaryAction={setupScreen ? { label: props.setupLabel ?? "Abrir configuración", onClick: () => open(setupScreen) } : undefined}
      />

      {relatedScreens?.length ? (
        <CocoaSection title="Pantallas relacionadas" meta={plural(relatedScreens.length, "pantalla", "pantallas")}>
          <CocoaGrid gap={3} align="start">
            {relatedScreens.map((rel) => (
              <CocoaSpan key={rel.screen + rel.label} cols={6} min={240}>
                <CocoaCard variant="bordered" padding="sm">
                  <div className="cocoa-row" data-justify="between" data-gap="2">
                    <strong>{rel.label}</strong>
                    <CocoaButton variant="plain" tone="accent" size="small" onClick={() => open(rel.screen)}>
                      Abrir
                    </CocoaButton>
                  </div>
                </CocoaCard>
              </CocoaSpan>
            ))}
          </CocoaGrid>
        </CocoaSection>
      ) : null}
    </CocoaPage>
  );
}

export function makeModulePlaceholder(config: ModuleSettingsConfig) {
  return function WiredModuleSettings() {
    return <ModuleSettingsPlaceholder {...config} />;
  };
}
