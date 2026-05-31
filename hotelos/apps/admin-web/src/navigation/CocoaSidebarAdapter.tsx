// CocoaSidebarAdapter
// Adapts the existing back office navigation structure
// (`backOfficeNavigationGroups` from `./Sidebar`) to the `sections` shape
// expected by `CocoaSidebar`. Each `BackOfficeNavGroup` becomes one or more
// `CocoaSidebarSection`s (group items first, then one section per subgroup),
// and each `BackOfficeNavItem` becomes a `CocoaSidebarItem` with an icon
// resolved from the screen name via the mapping below.

import { useMemo, type ReactNode } from "react";
import {
  CocoaSidebar,
  type CocoaSidebarSection,
  type CocoaSidebarItem
} from "../components/cocoa/CocoaSidebar";
import {
  BedIcon,
  BuildingIcon,
  CalendarIcon,
  ChartIcon,
  CreditCardIcon,
  DoorOpenIcon,
  GearIcon,
  PeopleIcon,
  PersonIcon,
  SparkleIcon,
  WrenchIcon
} from "../components/cocoa-icons/NavigationIcons";
import { CheckCircleIcon } from "../components/cocoa-icons/StatusIcons";
import {
  backOfficeNavigationGroups,
  type BackOfficeNavGroup,
  type BackOfficeNavItem,
  type BackOfficeNavSubgroup
} from "./Sidebar";

// Icon resolution by screen name. We match on substrings so a single screen
// like "ReservationWorkspace" or "ReservationCreate" both map to the calendar
// icon without listing every variant. Order matters: earlier rules win, so
// more specific tokens (e.g. "Rack") should come before broader ones.
type IconResolver = (props: { size?: number }) => ReactNode;

interface IconRule {
  match: (screen: string) => boolean;
  render: IconResolver;
}

function includesAny(screen: string, tokens: string[]): boolean {
  const lower = screen.toLowerCase();
  return tokens.some((token) => lower.includes(token.toLowerCase()));
}

const ICON_RULES: IconRule[] = [
  // FrontDesk -> DoorOpenIcon
  {
    match: (screen) => includesAny(screen, ["FrontDesk", "Reception", "CheckIn", "Kiosk"]),
    render: ({ size = 16 }) => <DoorOpenIcon size={size} />
  },
  // Reservations -> CalendarIcon
  {
    match: (screen) => includesAny(screen, ["Reservation", "Calendar", "Allotment"]),
    render: ({ size = 16 }) => <CalendarIcon size={size} />
  },
  // Guests -> PersonIcon
  {
    match: (screen) => includesAny(screen, ["Guest", "Concierge", "CRM", "Loyalty"]),
    render: ({ size = 16 }) => <PersonIcon size={size} />
  },
  // Groups -> PeopleIcon
  {
    match: (screen) => includesAny(screen, ["Group", "Persona", "Workforce", "Shift", "User", "Role"]),
    render: ({ size = 16 }) => <PeopleIcon size={size} />
  },
  // Rooms / Rack -> BedIcon
  {
    match: (screen) => includesAny(screen, ["Room", "Rack", "Housekeeping", "Floor"]),
    render: ({ size = 16 }) => <BedIcon size={size} />
  },
  // Billing / Folio -> CreditCardIcon
  {
    match: (screen) =>
      includesAny(screen, [
        "Billing",
        "Folio",
        "Payment",
        "Invoice",
        "Tax",
        "Accounting",
        "Finance",
        "Bank",
        "Commission",
        "Payroll",
        "Cash",
        "Balance",
        "Trial"
      ]),
    render: ({ size = 16 }) => <CreditCardIcon size={size} />
  },
  // Compliance -> CheckCircleIcon
  {
    match: (screen) =>
      includesAny(screen, [
        "Compliance",
        "Audit",
        "Gdpr",
        "Authority",
        "Tbai",
        "Esrs",
        "Fiscal",
        "Ses"
      ]),
    render: ({ size = 16 }) => <CheckCircleIcon size={size} />
  },
  // AI -> SparkleIcon (placed before Settings so "AiSetup" -> sparkle, not gear)
  {
    match: (screen) =>
      includesAny(screen, ["Ai", "Copilot", "Assistant", "Smart", "Insight"]),
    render: ({ size = 16 }) => <SparkleIcon size={size} />
  },
  // Reports -> ChartIcon (placed before Settings so "RevenueSettings" stays gear,
  // but dashboards/analytics get the chart)
  {
    match: (screen) =>
      includesAny(screen, [
        "Report",
        "Analytics",
        "Dashboard",
        "Forecast",
        "Demand",
        "RateShopper",
        "Channel",
        "Pipeline",
        "Sustainability",
        "Energy",
        "Profitability",
        "Portfolio",
        "Reputation",
        "Survey",
        "Quality",
        "Upsell"
      ]),
    render: ({ size = 16 }) => <ChartIcon size={size} />
  },
  // Maintenance -> WrenchIcon
  {
    match: (screen) =>
      includesAny(screen, ["Maintenance", "Safety", "Incident", "Asset", "Inventory", "Procurement"]),
    render: ({ size = 16 }) => <WrenchIcon size={size} />
  },
  // Settings -> GearIcon
  {
    match: (screen) =>
      includesAny(screen, [
        "Setting",
        "Setup",
        "Config",
        "Manager",
        "Module",
        "Marketplace",
        "Integration",
        "Developer",
        "Webhook",
        "Migration",
        "Onboarding",
        "Cutover",
        "Mapping",
        "Mapper",
        "Field",
        "Notification",
        "Messaging",
        "Connector",
        "Department",
        "Zone",
        "Building",
        "Category",
        "Organization",
        "Property"
      ]),
    render: ({ size = 16 }) => <GearIcon size={size} />
  }
];

/**
 * Resolve which icon to show for a given screen name. Falls back to
 * BuildingIcon for any screen that does not match a more specific rule.
 */
export function resolveScreenIcon(screen: string, size = 16): ReactNode {
  for (const rule of ICON_RULES) {
    if (rule.match(screen)) return rule.render({ size });
  }
  return <BuildingIcon size={size} />;
}

function buildItemId(groupTitle: string, subTitle: string | null, item: BackOfficeNavItem): string {
  // Keep the id stable and unique across groups: the same screen can appear
  // under multiple sections in the existing tree, so we namespace by group +
  // subgroup + screen rather than relying on `screen` alone.
  const subPart = subTitle ?? "_";
  return `${groupTitle}::${subPart}::${item.screen}`;
}

function toItem(
  groupTitle: string,
  subTitle: string | null,
  item: BackOfficeNavItem,
  activeScreen: string | undefined
): CocoaSidebarItem {
  return {
    id: buildItemId(groupTitle, subTitle, item),
    label: item.label,
    icon: resolveScreenIcon(item.screen),
    selected: activeScreen !== undefined && activeScreen === item.screen
  };
}

function groupToSections(
  group: BackOfficeNavGroup,
  activeScreen: string | undefined
): CocoaSidebarSection[] {
  const sections: CocoaSidebarSection[] = [];

  if (group.items && group.items.length > 0) {
    sections.push({
      title: group.title,
      collapsible: true,
      defaultOpen: true,
      items: group.items.map((item) => toItem(group.title, null, item, activeScreen))
    });
  }

  for (const sub of group.subgroups ?? []) {
    if (!sub.items || sub.items.length === 0) continue;
    const subgroupTitle: string = `${group.title} - ${sub.title}`;
    sections.push({
      title: subgroupTitle,
      collapsible: true,
      defaultOpen: false,
      items: sub.items.map((item) => toItem(group.title, sub.title, item, activeScreen))
    });
  }

  return sections;
}

/**
 * Build the `sections` prop expected by `CocoaSidebar` from the back office
 * navigation tree. Exported for tests and consumers that want to render the
 * underlying `CocoaSidebar` directly.
 */
export function buildSectionsFromGroups(
  groups: BackOfficeNavGroup[],
  activeScreen: string | undefined
): CocoaSidebarSection[] {
  return groups.flatMap((group) => groupToSections(group, activeScreen));
}

// Parse the screen back out of the namespaced item id so callers receive the
// same `screen` string that the old `Sidebar` would have produced via
// `onSelect`.
function parseScreenFromId(itemId: string): string {
  const parts = itemId.split("::");
  return parts[parts.length - 1] ?? itemId;
}

export interface CocoaSidebarAdapterProps {
  activeScreen?: string;
  onSelect: (screen: string) => void;
  width?: number;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /**
   * Optional override of the navigation tree. Defaults to the exported
   * `backOfficeNavigationGroups`. Useful for tests and for callers that want
   * to pre-filter the tree (e.g. by role / permission) before rendering.
   */
  groups?: BackOfficeNavGroup[];
}

/**
 * Drop-in replacement for the legacy `Sidebar` that renders the back office
 * navigation tree using `CocoaSidebar`. Permission / role gating is left to
 * the caller; pass a pre-filtered `groups` array if you want to hide groups
 * the current user shouldn't see.
 */
export function CocoaSidebarAdapter({
  activeScreen,
  onSelect,
  width,
  header,
  footer,
  className,
  groups
}: CocoaSidebarAdapterProps) {
  const sourceGroups: BackOfficeNavGroup[] = groups ?? backOfficeNavigationGroups;
  const sections: CocoaSidebarSection[] = useMemo(
    () => buildSectionsFromGroups(sourceGroups, activeScreen),
    [sourceGroups, activeScreen]
  );

  return (
    <CocoaSidebar
      sections={sections}
      onSelect={(itemId) => onSelect(parseScreenFromId(itemId))}
      width={width}
      header={header}
      footer={footer}
      className={className}
    />
  );
}

// Re-export the underlying section/item types and the helper so consumers can
// build sections imperatively without importing from two places.
export type {
  BackOfficeNavGroup,
  BackOfficeNavItem,
  BackOfficeNavSubgroup
};

export default CocoaSidebarAdapter;
