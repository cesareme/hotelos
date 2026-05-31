import {
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import { CocoaSearchInput } from "../cocoa/CocoaSearchInput";
import { StarIcon, ClockIcon } from "../cocoa-icons/StatusIcons";

export interface SidebarItem {
  id: string;
  label: string;
  screen: string;
  icon?: ReactNode;
  shortcut?: string;
  badge?: string | number;
  rolesAllowed?: string[];
}

export interface SidebarGroup {
  id: string;
  label: string;
  defaultOpen?: boolean;
  rolesAllowed?: string[];
  items: SidebarItem[];
}

export interface CocoaSidebarV2Props {
  groups: SidebarGroup[];
  activeScreen: string;
  favorites: SidebarItem[];
  recent: SidebarItem[];
  onNavigate: (screen: string) => void;
  onToggleFavorite: (itemId: string) => void;
  userRole?: string;
  searchQuery?: string;
  onSearchChange?: (q: string) => void;
}

const SIDEBAR_WIDTH = 260;

const containerStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  width: SIDEBAR_WIDTH,
  minWidth: SIDEBAR_WIDTH,
  height: "100vh",
  display: "flex",
  flexDirection: "column",
  boxSizing: "border-box",
  background: "var(--cocoa-background-sidebar)",
  backdropFilter: "var(--cocoa-material-sidebar-blur)",
  WebkitBackdropFilter: "var(--cocoa-material-sidebar-blur)",
  borderRight: "1px solid var(--cocoa-separator)",
  fontFamily: "var(--cocoa-font)",
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-label)"
};

const topStyle: CSSProperties = {
  flex: "0 0 auto",
  padding: "var(--cocoa-space-3)",
  borderBottom: "1px solid var(--cocoa-separator)",
  boxSizing: "border-box",
  position: "relative"
};

const searchWrapStyle: CSSProperties = {
  position: "relative",
  width: "100%"
};

const shortcutHintStyle: CSSProperties = {
  position: "absolute",
  right: 8,
  top: "50%",
  transform: "translateY(-50%)",
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  padding: "2px 6px",
  borderRadius: "var(--cocoa-radius-sm)",
  background: "var(--cocoa-background-control)",
  border: "1px solid var(--cocoa-separator)",
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)",
  pointerEvents: "none",
  userSelect: "none",
  lineHeight: 1
};

const bodyStyle: CSSProperties = {
  flex: "1 1 auto",
  overflowY: "auto",
  overflowX: "hidden",
  padding: "var(--cocoa-space-3)",
  boxSizing: "border-box"
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  marginBottom: 8
};

const sectionHeaderBaseStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 8px 4px",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-wide)",
  textTransform: "uppercase",
  color: "var(--cocoa-label-secondary)",
  userSelect: "none",
  background: "transparent",
  border: "none",
  width: "100%",
  textAlign: "left",
  cursor: "pointer",
  font: "inherit"
};

const sectionHeaderStaticStyle: CSSProperties = {
  ...sectionHeaderBaseStyle,
  cursor: "default"
};

const itemListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 1
};

const itemBaseStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderRadius: "var(--cocoa-radius-sm)",
  cursor: "pointer",
  userSelect: "none",
  background: "transparent",
  border: "none",
  borderLeft: "3px solid transparent",
  width: "100%",
  textAlign: "left",
  color: "inherit",
  font: "inherit",
  fontSize: "var(--cocoa-fs-body)",
  transition:
    "background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), color var(--cocoa-duration-fast) var(--cocoa-ease-out)",
  boxSizing: "border-box"
};

const itemIconStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 16,
  height: 16,
  flexShrink: 0,
  color: "inherit"
};

const itemLabelStyle: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};

const shortcutBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "1px 5px",
  borderRadius: "var(--cocoa-radius-sm)",
  background: "var(--cocoa-background-control)",
  border: "1px solid var(--cocoa-separator)",
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)",
  lineHeight: 1,
  flexShrink: 0
};

const badgeBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 18,
  height: 16,
  padding: "0 6px",
  borderRadius: "var(--cocoa-radius-full)",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  lineHeight: 1,
  flexShrink: 0,
  background: "var(--cocoa-label-secondary)",
  color: "var(--cocoa-background-content)"
};

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 10,
        height: 10,
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition:
          "transform var(--cocoa-duration-fast) var(--cocoa-ease-out)",
        color: "var(--cocoa-label-secondary)"
      }}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M3.5 2L6.5 5L3.5 8"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function isItemAllowed(item: SidebarItem, role?: string): boolean {
  if (item.rolesAllowed === undefined || item.rolesAllowed.length === 0) {
    return true;
  }
  if (role === undefined) {
    return false;
  }
  return item.rolesAllowed.includes(role);
}

function isGroupAllowed(group: SidebarGroup, role?: string): boolean {
  if (group.rolesAllowed === undefined || group.rolesAllowed.length === 0) {
    return true;
  }
  if (role === undefined) {
    return false;
  }
  return group.rolesAllowed.includes(role);
}

function matchesSearch(item: SidebarItem, q: string): boolean {
  if (q === "") {
    return true;
  }
  const needle = q.toLowerCase();
  return item.label.toLowerCase().includes(needle);
}

interface ItemRowProps {
  item: SidebarItem;
  active: boolean;
  onNavigate: (screen: string) => void;
}

function ItemRow({ item, active, onNavigate }: ItemRowProps) {
  const [hovered, setHovered] = useState(false);

  const style: CSSProperties = useMemo(() => {
    const merged: CSSProperties = { ...itemBaseStyle };
    if (active) {
      merged.background = "rgba(0, 100, 225, 0.12)";
      merged.borderLeft = "3px solid var(--cocoa-accent)";
      merged.color = "var(--cocoa-accent)";
    } else if (hovered) {
      merged.background = "rgba(0, 100, 225, 0.06)";
    }
    return merged;
  }, [active, hovered]);

  const hasBadge = item.badge !== undefined && item.badge !== null;
  const hasShortcut = item.shortcut !== undefined && item.shortcut !== "";

  return (
    <button
      type="button"
      className="cocoa-focus-ring"
      style={style}
      onClick={() => onNavigate(item.screen)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-current={active ? "page" : undefined}
    >
      {item.icon !== undefined ? (
        <span style={itemIconStyle} aria-hidden="true">
          {item.icon}
        </span>
      ) : null}
      <span style={itemLabelStyle}>{item.label}</span>
      {hasShortcut ? (
        <span style={shortcutBaseStyle} aria-hidden="true">
          {item.shortcut}
        </span>
      ) : null}
      {hasBadge ? <span style={badgeBaseStyle}>{item.badge}</span> : null}
    </button>
  );
}

interface PinnedSectionProps {
  title: string;
  icon: ReactNode;
  items: SidebarItem[];
  activeScreen: string;
  onNavigate: (screen: string) => void;
}

function PinnedSection({
  title,
  icon,
  items,
  activeScreen,
  onNavigate
}: PinnedSectionProps) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div style={sectionStyle}>
      <div style={sectionHeaderStaticStyle}>
        <span
          aria-hidden="true"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 12,
            height: 12,
            color: "var(--cocoa-label-secondary)"
          }}
        >
          {icon}
        </span>
        <span>{title}</span>
      </div>
      <div role="list" style={itemListStyle}>
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            active={item.screen === activeScreen}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}

interface GroupSectionProps {
  group: SidebarGroup;
  visibleItems: SidebarItem[];
  activeScreen: string;
  onNavigate: (screen: string) => void;
  forceOpen: boolean;
}

function GroupSection({
  group,
  visibleItems,
  activeScreen,
  onNavigate,
  forceOpen
}: GroupSectionProps) {
  const initialOpen = group.defaultOpen !== false;
  const [open, setOpen] = useState<boolean>(initialOpen);
  const sectionId = `cocoa-sidebar-v2-group-${group.id}`;
  const isOpen = forceOpen || open;

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <div style={sectionStyle}>
      <button
        type="button"
        className="cocoa-focus-ring"
        style={sectionHeaderBaseStyle}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-controls={sectionId}
      >
        <Chevron open={isOpen} />
        <span>{group.label}</span>
      </button>
      {isOpen ? (
        <div id={sectionId} role="list" style={itemListStyle}>
          {visibleItems.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              active={item.screen === activeScreen}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function CocoaSidebarV2(props: CocoaSidebarV2Props) {
  const {
    groups,
    activeScreen,
    favorites,
    recent,
    onNavigate,
    userRole,
    searchQuery,
    onSearchChange
  } = props;

  const [internalSearch, setInternalSearch] = useState<string>("");
  const effectiveSearch = searchQuery !== undefined ? searchQuery : internalSearch;
  const handleSearch = (v: string) => {
    if (onSearchChange !== undefined) {
      onSearchChange(v);
    } else {
      setInternalSearch(v);
    }
  };

  const trimmedSearch = effectiveSearch.trim();
  const hasSearch = trimmedSearch !== "";

  const visibleFavorites = useMemo(() => {
    return favorites.filter(
      (it) => isItemAllowed(it, userRole) && matchesSearch(it, trimmedSearch)
    );
  }, [favorites, userRole, trimmedSearch]);

  const visibleRecent = useMemo(() => {
    return recent.filter(
      (it) => isItemAllowed(it, userRole) && matchesSearch(it, trimmedSearch)
    );
  }, [recent, userRole, trimmedSearch]);

  const visibleGroups = useMemo(() => {
    return groups
      .filter((g) => isGroupAllowed(g, userRole))
      .map((g) => ({
        group: g,
        items: g.items.filter(
          (it) => isItemAllowed(it, userRole) && matchesSearch(it, trimmedSearch)
        )
      }));
  }, [groups, userRole, trimmedSearch]);

  return (
    <aside
      style={containerStyle}
      role="navigation"
      aria-label="Sidebar"
    >
      <div style={topStyle}>
        <div style={searchWrapStyle}>
          <CocoaSearchInput
            value={effectiveSearch}
            onChange={handleSearch}
            placeholder="Buscar"
          />
          {effectiveSearch === "" ? (
            <span style={shortcutHintStyle} aria-hidden="true">
              <span>⌘K</span>
            </span>
          ) : null}
        </div>
      </div>
      <div style={bodyStyle}>
        <PinnedSection
          title="Favoritos"
          icon={<StarIcon size={12} />}
          items={visibleFavorites}
          activeScreen={activeScreen}
          onNavigate={onNavigate}
        />
        <PinnedSection
          title="Recientes"
          icon={<ClockIcon size={12} />}
          items={visibleRecent}
          activeScreen={activeScreen}
          onNavigate={onNavigate}
        />
        {visibleGroups.map(({ group, items }) => (
          <GroupSection
            key={group.id}
            group={group}
            visibleItems={items}
            activeScreen={activeScreen}
            onNavigate={onNavigate}
            forceOpen={hasSearch}
          />
        ))}
      </div>
    </aside>
  );
}

export default CocoaSidebarV2;
