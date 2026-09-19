// CocoaPage — the page frame of Cocoa 22 (COCOA-22.md §3.2, §4, §8): header,
// state, density, full-bleed and ⌘K commands in one component so every
// screen reads the same.
//
//   standalone  CocoaPageHeader (eyebrow · h1 · subtitle · actions · tabs)
//   hosted      `useTabHost() !== null` → the container already painted the
//               category and the H1; the page paints `HostedHead` (subtitle,
//               inner views, actions row) and never an H1
//   state       ready (children) · loading (`skeleton` or CocoaState) · empty ·
//               error (CocoaState with `onRetry`)
//   density     `data-cocoa-density="compact|comfortable"` — cocoa-tokens.css
//               resolves the `--cocoa-density-*` set (card padding, row
//               height, cell padding, control height) for the whole subtree.
//               `density="operational"` (Tanda UX-1 · U10, D10, P5, R7) lo
//               resuelve la página por dispositivo: `compact` (filas 28 px) con
//               ratón y `comfortable` + objetivos de 44 px con puntero grueso
//               (`useCoarsePointer`); emite además `data-density-mode=
//               "operational"` y, en un iPad apaisado, `data-touch-laptop`
//               (`useIsTouchLaptop`, cocoa-viewport.ts) para la banda tablet
//               de cocoa-22-layout.css
//   fullBleed   `data-full-bleed` — cocoa-22-layout.css lets the wide scroller
//               (a CocoaScrollArea, or the rate grid, as a direct child of the
//               body) bleed into the content gutter (`--cocoa-content-padding`,
//               24 / 16); header, toolbar, chips and states keep it (§5.1)
//   commands    registered in the page-command registry while mounted; the
//               command palette lists them as «Acciones de la página»
//   tabs        inner views: the head (standalone or hosted) paints the
//               CocoaSegmentedControl and the BODY is their `role="tabpanel"`
//               (`useId()`, labelled with the active view) so the active tab
//               always carries `aria-controls` (qa#10). A screen that paints
//               its own panel passes `panelId` and the body stays a plain div.
//
// Layout (stack, gap, full-bleed margins) is owned by the css lot through
// `.c22-page[data-gap]` / `[data-full-bleed]`; this component only emits the
// hooks (§8 contract: data-cocoa root + c22-* classes + data-* variants).

import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { useCoarsePointer } from "../../lib/useCoarsePointer";
import { useHostedEyebrow, useTabHost } from "../../screens/tabs/TabHost";
import { useIsTouchLaptop } from "./cocoa-viewport";
import { CocoaPageHeader, type CocoaPageHeaderProps } from "./CocoaPageHeader";
import { HostedHead } from "./HostedHead";
import { CocoaState, SKELETON_DELAY_MS, fadeInClass, useFadeInAfterLoading, useSkeletonDelay, type CocoaStateProps } from "./CocoaState";
import { commandsKey, registerPageCommands, resolvePageState, type CocoaPageCommand, type CocoaPageState } from "./cocoa-page-commands";

export { commandsKey };

export type CocoaPageDensity = "comfortable" | "compact";
/** Densidad declarada por la pantalla: fija, u `operational` (resuelta por dispositivo, D10). */
export type CocoaPageDensityMode = CocoaPageDensity | "operational";
export type CocoaPageGap = 3 | 4 | 5;

/**
 * Densidad efectiva de la página (pura): `operational` → `compact` con ratón y
 * `comfortable` con puntero grueso (44 px); una densidad fija se respeta tal
 * cual; sin declaración, nada (heredan los tokens por defecto).
 */
export function resolvePageDensity(density: CocoaPageDensityMode | undefined, coarse: boolean): CocoaPageDensity | undefined {
  if (density === "operational") return coarse ? "comfortable" : "compact";
  return density;
}

export interface CocoaPageProps extends Pick<CocoaPageHeaderProps, "eyebrow" | "title" | "subtitle" | "icon" | "tabs" | "activeTab" | "onTabChange" | "panelId" | "wrap"> {
  /** Actions row (standalone → header; hosted → HOSTED_ACTIONS_ROW). */
  actions?: ReactNode;
  state?: CocoaPageState;
  /** Mirror skeleton painted while loading (default: CocoaState loading). */
  skeleton?: ReactNode;
  /** Delay before the skeleton paints (ms): 300 by default (NN/g), 0 = at once. The body fades in (`.cocoa-fade-in`) when the load resolves. */
  skeletonDelayMs?: number;
  empty?: Partial<Omit<CocoaStateProps, "kind">>;
  error?: Partial<Omit<CocoaStateProps, "kind">>;
  density?: CocoaPageDensityMode;
  fullBleed?: boolean;
  /** Stack gap between sections: 3 = 12 · 4 = 16 (default) · 5 = 24. */
  gap?: CocoaPageGap;
  commands?: readonly CocoaPageCommand[];
  children: ReactNode;
  id?: string;
  className?: string;
  /** Layout escape hatch only (min-height, overflow). */
  style?: CSSProperties;
  "aria-label"?: string;
}

export function CocoaPage({
  eyebrow,
  title,
  subtitle,
  icon,
  tabs,
  activeTab,
  onTabChange,
  panelId,
  wrap,
  actions,
  state,
  skeleton,
  skeletonDelayMs = SKELETON_DELAY_MS,
  empty,
  error,
  density,
  fullBleed = false,
  gap = 4,
  commands,
  children,
  id,
  className,
  style,
  "aria-label": ariaLabel
}: CocoaPageProps) {
  const hosted = useTabHost() !== null;
  // Densidad por dispositivo (U10, D10): la pantalla declara la intención y la página la resuelve.
  const coarse = useCoarsePointer();
  const touchLaptop = useIsTouchLaptop();
  const resolvedDensity = resolvePageDensity(density, coarse);
  // Hosted: the container paints the eyebrow — hand it ours so it can qualify its category
  // («Finanzas · CELUISMA S.A.», design §5.3; fix:L7 qa#12). No-op standalone.
  useHostedEyebrow(eyebrow);
  const resolved = resolvePageState({ state });

  // ⌘K: register once per command set; the latest `run` closures are read through a ref.
  const latest = useRef<readonly CocoaPageCommand[]>(commands ?? []);
  latest.current = commands ?? [];
  const key = commandsKey(commands);
  useEffect(() => {
    if (!key) return undefined;
    const proxies = latest.current.map((command) => ({
      id: command.id,
      label: command.label,
      shortcut: command.shortcut,
      run: () => latest.current.find((candidate) => candidate.id === command.id)?.run()
    }));
    return registerPageCommands(proxies);
  }, [key]);

  // Skeleton with delay (U4): nothing under `skeletonDelayMs`, then the mirror
  // skeleton; once resolved the body fades in (`.cocoa-fade-in`).
  const loading = resolved === "loading";
  const showSkeleton = useSkeletonDelay(loading, skeletonDelayMs);
  const fade = useFadeInAfterLoading(loading);

  let body: ReactNode;
  if (loading) body = showSkeleton ? (skeleton ?? <CocoaState kind="loading" />) : null;
  else if (resolved === "error") body = <CocoaState kind="error" {...error} />;
  else if (resolved === "empty") body = <CocoaState kind="empty" {...empty} />;
  else body = children;

  // A hosted page with nothing to add under the container's head paints no
  // header wrapper at all (an empty wrapper would still take a gap slot).
  const hasTabs = Array.isArray(tabs) && tabs.length > 0;
  const hasHostedHead = Boolean(subtitle || actions || hasTabs);

  // Inner views own a panel: unless the screen paints its own (`panelId`
  // given), the body is the `role="tabpanel"` the active tab controls.
  const generatedPanelId = useId();
  const ownsPanel = hasTabs && !panelId;
  const resolvedPanelId = hasTabs ? (panelId ?? generatedPanelId) : undefined;
  const activeView = hasTabs ? (tabs!.find((tab) => tab.value === activeTab) ?? tabs![0]) : undefined;

  return (
    <div
      id={id}
      className={["c22-page", "cocoa-page", className].filter(Boolean).join(" ")}
      style={{ minWidth: 0, ...style }}
      aria-label={ariaLabel}
      data-cocoa="page"
      data-state={resolved}
      data-gap={gap}
      data-cocoa-density={resolvedDensity}
      data-density-mode={density === "operational" ? "operational" : undefined}
      data-touch-laptop={touchLaptop ? "true" : undefined}
      data-full-bleed={fullBleed ? "true" : undefined}
      data-hosted={hosted ? "true" : undefined}
    >
      {hosted ? (
        hasHostedHead ? (
          <div className="c22-page__header">
            <HostedHead title={title} subtitle={subtitle} actions={actions} tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} panelId={resolvedPanelId} />
          </div>
        ) : null
      ) : (
        <div className="c22-page__header">
          <CocoaPageHeader eyebrow={eyebrow} title={title} subtitle={subtitle} icon={icon} actions={actions} tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} panelId={resolvedPanelId} wrap={wrap} />
        </div>
      )}
      <div
        className={["c22-page__body", "cocoa-page-body", fadeInClass(fade)].filter(Boolean).join(" ")}
        id={ownsPanel ? resolvedPanelId : undefined}
        role={ownsPanel ? "tabpanel" : undefined}
        aria-label={ownsPanel ? activeView?.label : undefined}
        aria-busy={loading || undefined}
        data-skeleton={loading ? (showSkeleton ? "visible" : "pending") : undefined}
      >
        {body}
      </div>
    </div>
  );
}

export default CocoaPage;
