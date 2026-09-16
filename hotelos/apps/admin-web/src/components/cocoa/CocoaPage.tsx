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
//               height, cell padding, control height) for the whole subtree
//   fullBleed   `data-full-bleed` — cocoa-22-layout.css lets the wide scroller
//               (a CocoaScrollArea, or the rate grid, as a direct child of the
//               body) bleed into the content gutter (`--cocoa-content-padding`,
//               24 / 16); header, toolbar, chips and states keep it (§5.1)
//   commands    registered in the page-command registry while mounted; the
//               command palette lists them as «Acciones de la página»
//
// Layout (stack, gap, full-bleed margins) is owned by the css lot through
// `.c22-page[data-gap]` / `[data-full-bleed]`; this component only emits the
// hooks (§8 contract: data-cocoa root + c22-* classes + data-* variants).

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { HostedHead } from "../../screens/tabs/tab-helpers";
import { useHostedEyebrow, useTabHost } from "../../screens/tabs/TabHost";
import { CocoaPageHeader, type CocoaPageHeaderProps } from "./CocoaPageHeader";
import { CocoaState, type CocoaStateProps } from "./CocoaState";
import { commandsKey, registerPageCommands, resolvePageState, type CocoaPageCommand, type CocoaPageState } from "./cocoa-page-commands";

export { commandsKey };

export type CocoaPageDensity = "comfortable" | "compact";
export type CocoaPageGap = 3 | 4 | 5;

export interface CocoaPageProps extends Pick<CocoaPageHeaderProps, "eyebrow" | "title" | "subtitle" | "icon" | "tabs" | "activeTab" | "onTabChange" | "wrap"> {
  /** Actions row (standalone → header; hosted → HOSTED_ACTIONS_ROW). */
  actions?: ReactNode;
  state?: CocoaPageState;
  /** Mirror skeleton painted while loading (default: CocoaState loading). */
  skeleton?: ReactNode;
  empty?: Partial<Omit<CocoaStateProps, "kind">>;
  error?: Partial<Omit<CocoaStateProps, "kind">>;
  density?: CocoaPageDensity;
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
  wrap,
  actions,
  state,
  skeleton,
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

  let body: ReactNode;
  if (resolved === "loading") body = skeleton ?? <CocoaState kind="loading" />;
  else if (resolved === "error") body = <CocoaState kind="error" {...error} />;
  else if (resolved === "empty") body = <CocoaState kind="empty" {...empty} />;
  else body = children;

  // A hosted page with nothing to add under the container's head paints no
  // header wrapper at all (an empty wrapper would still take a gap slot).
  const hasHostedHead = Boolean(subtitle || actions || (Array.isArray(tabs) && tabs.length > 0));

  return (
    <div
      id={id}
      className={["c22-page", "cocoa-page", className].filter(Boolean).join(" ")}
      style={{ minWidth: 0, ...style }}
      aria-label={ariaLabel}
      data-cocoa="page"
      data-state={resolved}
      data-gap={gap}
      data-cocoa-density={density}
      data-full-bleed={fullBleed ? "true" : undefined}
      data-hosted={hosted ? "true" : undefined}
    >
      {hosted ? (
        hasHostedHead ? (
          <div className="c22-page__header">
            <HostedHead title={title} subtitle={subtitle} actions={actions} tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} />
          </div>
        ) : null
      ) : (
        <div className="c22-page__header">
          <CocoaPageHeader eyebrow={eyebrow} title={title} subtitle={subtitle} icon={icon} actions={actions} tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} wrap={wrap} />
        </div>
      )}
      <div className="c22-page__body cocoa-page-body" aria-busy={resolved === "loading" || undefined}>
        {body}
      </div>
    </div>
  );
}

export default CocoaPage;
