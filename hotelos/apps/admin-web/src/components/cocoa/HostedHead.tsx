// HostedHead — the head a hosted screen paints (Cocoa 22 · COCOA-22.md §3.2,
// §4 rule 20): subtitle (left), optional segmented inner views and the actions
// row (right). Never an eyebrow nor a title: the tab container (NavItemTabs →
// CocoaRouteTabs) already painted category and item label — the `eyebrow` prop
// is only registered with it (`useHostedEyebrow`) so «Finanzas · <sociedad>»
// reaches the container's header. `CocoaPage` paints it whenever
// `useTabHost() !== null`; a screen with a frame of its own can paint it
// directly. Paints nothing when it has nothing to say (no empty toolbar).
//
// Plain function without hooks of its own (the container tests call it
// directly): the eyebrow registration travels in the `HostedEyebrow` carrier.

import { HOSTED_TOOLBAR, useHostedEyebrow } from "../../screens/tabs/TabHost";
import type { CocoaPageHeaderProps } from "./CocoaPageHeader";
import { CocoaSegmentedControl } from "./CocoaSegmentedControl";

export type HostedHeadProps = Pick<CocoaPageHeaderProps, "title" | "subtitle" | "actions" | "tabs" | "activeTab" | "onTabChange" | "panelId"> & {
  /**
   * Not painted here (the container owns the eyebrow): registered with it through
   * `useHostedEyebrow` so «Finanzas · <sociedad>» qualifies the container's category
   * (design §5.3; fix:L7 qa#12). The title is never painted either (the container's H1).
   */
  eyebrow?: string;
};

// The subtitle sits in a COLUMN flex (leadStyle): a flex-basis here would become its height.
// `width: 0` + `minWidth: 100%`: the paragraph fills the column but adds nothing to its intrinsic
// width, so a long sentence never decides whether the actions wrap — only the segmented views do.
const subtitleStyle = { color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-body)", margin: 0, flex: "0 0 auto", width: 0, minWidth: "100%" } as const;
// Lead column: its flex basis is the width of its segmented views (fix:L7 qa#1: with a fixed 320 px
// basis the four USALI views were squeezed to 452 px beside a 688 px actions row at 1440 and the strip
// scrolled), at least 320 px — or the whole row on a phone — for a subtitle alone; items align to the
// start so the strip keeps its own width instead of stretching to the column.
const leadStyle = { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "var(--cocoa-space-3)", flex: "1 1 auto", minWidth: "min(320px, 100%)" } as const;
// Actions keep the right edge whichever line they land on (`marginLeft: auto` also on a wrapped line).
const actionsStyle = { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: "var(--cocoa-space-2)", marginLeft: "auto", minWidth: 0, maxWidth: "100%" } as const;

/** Hook carrier of HostedHead: keeps HostedHead a plain function (the tests call it directly) while its eyebrow reaches the container. */
function HostedEyebrow({ eyebrow }: { eyebrow: string }) {
  useHostedEyebrow(eyebrow);
  return null;
}
HostedEyebrow.displayName = "HostedEyebrow";

/**
 * Head of a hosted screen: subtitle (left), optional segmented inner views and
 * the actions row (right). No eyebrow, no title: the container already
 * painted them — the `eyebrow` prop is only registered with it (useHostedEyebrow)
 * so «Finanzas · <sociedad>» reaches the container's header. Paints nothing
 * when it has nothing to say. Layout: the lead column is as wide as its
 * segmented views and the actions wrap under them when both do not fit.
 */
export function HostedHead({ title, subtitle, actions, tabs, activeTab, onTabChange, panelId, eyebrow }: HostedHeadProps) {
  const hasTabs = Array.isArray(tabs) && tabs.length > 0;
  const register = eyebrow ? <HostedEyebrow eyebrow={eyebrow} /> : null;
  if (!subtitle && !hasTabs && !actions) return register;
  return (
    <div style={HOSTED_TOOLBAR} data-hosted-head={title}>
      {register}
      <div style={leadStyle}>
        {subtitle ? <p style={subtitleStyle}>{subtitle}</p> : null}
        {hasTabs ? (
          <CocoaSegmentedControl
            value={activeTab ?? tabs![0].value}
            onChange={(value) => onTabChange?.(value)}
            options={tabs!}
            size="small"
            panelId={panelId}
            aria-label={`${title}: vistas`}
          />
        ) : null}
      </div>
      {actions ? <div style={actionsStyle}>{actions}</div> : null}
    </div>
  );
}

export default HostedHead;
