import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { NewGroupDialog } from "./NewGroupDialog";
import { RoomBlockGridDialog } from "./RoomBlockGridDialog";
import { NewEventDialog } from "./NewEventDialog";
import { RoomingListImportDialog } from "./RoomingListImportDialog";
import { GroupDetailDialog } from "./GroupDetailDialog";
import { GroupsPickupCard } from "./GroupsPickupCard";
import { useToast } from "../../components/Toast";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaTable, type CocoaTableColumn } from "../../components/cocoa/CocoaTable";
import { CocoaPopover } from "../../components/cocoa/CocoaPopover";

const PROPERTY_ID = getActivePropertyId();

type GroupsEventsDashboardData = {
  kpis: {
    activeGroupBookings: number;
    roomsBlockedTotal: number;
    pickupPct: number;
    upcomingEvents: number;
    fAndBRevenueMtdEur: number;
  };
  upcomingGroups: Array<{
    id: string;
    name: string;
    arrivalDate?: string;
    departureDate?: string;
    roomsBlocked: number;
    pickedUp: number;
    pickupPct: number;
  }>;
  upcomingEvents: Array<{
    id: string;
    name: string;
    eventDate: string;
    spaceName?: string;
    expectedAttendees?: number;
    revenueEur?: number;
  }>;
  topAccounts: Array<{ accountName: string; activeGroups: number; valueEur: number }>;
};

type UpcomingGroup = GroupsEventsDashboardData["upcomingGroups"][number];
type TopAccount = GroupsEventsDashboardData["topAccounts"][number];

type KpiStatus = "ok" | "warn" | "error";

const EMPTY: GroupsEventsDashboardData = {
  kpis: {
    activeGroupBookings: 0,
    roomsBlockedTotal: 0,
    pickupPct: 0,
    upcomingEvents: 0,
    fAndBRevenueMtdEur: 0
  },
  upcomingGroups: [],
  upcomingEvents: [],
  topAccounts: []
};

const eurFormat = new Intl.NumberFormat("es-ES", { useGrouping: true, style: "currency", currency: "EUR" });
const numFormat = new Intl.NumberFormat("es-ES", { useGrouping: true });

function formatEur(value: number): string {
  return eurFormat.format(value);
}

function formatNumber(value: number): string {
  return numFormat.format(value);
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("es-ES");
  } catch {
    return iso;
  }
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-ES", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
}

// -----------------------------------------------------------------------------
// Inline cocoa primitives — until the full primitive set ships we render the
// small building blocks (KPI card, status pill, badge, disclosure button)
// inline. All visual concerns route through --cocoa-* tokens so light/dark
// parity is preserved.
// -----------------------------------------------------------------------------

const STATUS_TOKENS: Record<KpiStatus, { ink: string; bg: string; label: string }> = {
  ok: {
    ink: "var(--cocoa-success)",
    bg: "rgb(48 209 88 / 0.12)",
    label: "OK"
  },
  warn: {
    ink: "var(--cocoa-warning)",
    bg: "rgb(255 159 10 / 0.14)",
    label: "Atención"
  },
  error: {
    ink: "var(--cocoa-danger)",
    bg: "rgb(255 69 58 / 0.14)",
    label: "Crítico"
  }
};

interface KpiCardProps {
  label: string;
  value: string;
  caption?: string;
  status: KpiStatus;
}

function KpiCard({ label, value, caption, status }: KpiCardProps) {
  const tone = STATUS_TOKENS[status];
  const cardStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-1)",
    padding: "var(--cocoa-space-4)",
    background: "var(--cocoa-background-content)",
    border: "1px solid var(--cocoa-separator)",
    borderRadius: "var(--cocoa-radius-lg)",
    borderLeft: `3px solid ${tone.ink}`,
    fontFamily: "var(--cocoa-font)"
  };
  const labelStyle: CSSProperties = {
    color: "var(--cocoa-label-secondary)",
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: 600,
    letterSpacing: "var(--cocoa-tracking-wide)",
    textTransform: "uppercase",
    margin: 0
  };
  const valueStyle: CSSProperties = {
    color: "var(--cocoa-label)",
    fontSize: "var(--cocoa-fs-title-1)",
    fontWeight: 700,
    letterSpacing: "var(--cocoa-tracking-tight)",
    margin: 0,
    lineHeight: 1.15
  };
  const captionStyle: CSSProperties = {
    color: "var(--cocoa-label-secondary)",
    fontSize: "var(--cocoa-fs-callout)",
    margin: 0
  };
  return (
    <article style={cardStyle}>
      <p style={labelStyle}>{label}</p>
      <p style={valueStyle}>{value}</p>
      {caption ? <p style={captionStyle}>{caption}</p> : null}
      <span style={{ position: "absolute", overflow: "hidden", width: 0, height: 0 }} aria-hidden>
        {tone.label}
      </span>
    </article>
  );
}

interface KpiGridProps {
  children: ReactNode;
}

function KpiGrid({ children }: KpiGridProps) {
  const style: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: "var(--cocoa-space-3)"
  };
  return <section style={style}>{children}</section>;
}

type PillTone = "ok" | "warn" | "error" | "neutral";

const PILL_TONES: Record<PillTone, { fg: string; bg: string }> = {
  ok: { fg: "var(--cocoa-success)", bg: "rgb(48 209 88 / 0.15)" },
  warn: { fg: "var(--cocoa-warning)", bg: "rgb(255 159 10 / 0.18)" },
  error: { fg: "var(--cocoa-danger)", bg: "rgb(255 69 58 / 0.18)" },
  neutral: { fg: "var(--cocoa-label-secondary)", bg: "var(--cocoa-background-sidebar)" }
};

function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px var(--cocoa-space-2)",
    borderRadius: "var(--cocoa-radius-full)",
    background: PILL_TONES[tone].bg,
    color: PILL_TONES[tone].fg,
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: 600,
    fontFamily: "var(--cocoa-font)",
    lineHeight: 1.4,
    whiteSpace: "nowrap"
  };
  return <span style={style}>{children}</span>;
}

function NeutralBadge({ children }: { children: ReactNode }) {
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px var(--cocoa-space-2)",
    borderRadius: "var(--cocoa-radius-full)",
    background: "var(--cocoa-background-sidebar)",
    color: "var(--cocoa-label-secondary)",
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: 600,
    fontFamily: "var(--cocoa-font)",
    lineHeight: 1.4
  };
  return <span style={style}>{children}</span>;
}

function pickupPill(pct: number, blocked: number) {
  if (blocked === 0) return <StatusPill tone="neutral">no block</StatusPill>;
  if (pct >= 80) return <StatusPill tone="ok">{pct}%</StatusPill>;
  if (pct >= 50) return <StatusPill tone="warn">{pct}%</StatusPill>;
  return <StatusPill tone="error">{pct}%</StatusPill>;
}

// -----------------------------------------------------------------------------
// Disclosure button — chevron rotates with expanded state, uses tokens only.
// Used both for "Mostrar más KPIs" and the pickup section header.
// -----------------------------------------------------------------------------

interface DisclosureButtonProps {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  align?: "start" | "end";
  trailing?: ReactNode;
}

function ChevronDown({ rotated }: { rotated: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden
      style={{
        transform: `rotate(${rotated ? 0 : -90}deg)`,
        transition: "transform var(--cocoa-duration-fast) var(--cocoa-ease-out)",
        flexShrink: 0
      }}
    >
      <path d="M2 3.5 L5 7 L8 3.5 Z" fill="currentColor" />
    </svg>
  );
}

function DisclosureButton({ label, expanded, onToggle, align = "start", trailing }: DisclosureButtonProps) {
  const wrapperStyle: CSSProperties = {
    display: "flex",
    justifyContent: align === "end" ? "flex-end" : "flex-start"
  };
  const buttonStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--cocoa-space-2)",
    padding: "var(--cocoa-space-1) var(--cocoa-space-2)",
    background: "transparent",
    border: "none",
    borderRadius: "var(--cocoa-radius-sm)",
    color: "var(--cocoa-label-secondary)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-callout)",
    fontWeight: 600,
    cursor: "pointer"
  };
  return (
    <div style={wrapperStyle}>
      <button type="button" style={buttonStyle} onClick={onToggle} aria-expanded={expanded}>
        <ChevronDown rotated={expanded} />
        <span>{label}</span>
        {trailing}
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Section header (card title + trailing badge) — replaces the bo-card-head /
// bo-chip pair.
// -----------------------------------------------------------------------------

function CardHeader({ title, badge }: { title: string; badge?: ReactNode }) {
  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--cocoa-space-3)",
    marginBottom: "var(--cocoa-space-3)"
  };
  const titleStyle: CSSProperties = {
    color: "var(--cocoa-label)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-headline)",
    fontWeight: 600,
    letterSpacing: "var(--cocoa-tracking-tight)",
    margin: 0
  };
  return (
    <div style={style}>
      <h3 style={titleStyle}>{title}</h3>
      {badge}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Empty-state caption — replaces p.bo-muted for "no data" copy in cards.
// -----------------------------------------------------------------------------

function EmptyCaption({ children }: { children: ReactNode }) {
  const style: CSSProperties = {
    color: "var(--cocoa-label-secondary)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-body)",
    margin: 0,
    paddingBlock: "var(--cocoa-space-3)"
  };
  return <p style={style}>{children}</p>;
}

// -----------------------------------------------------------------------------
// Lucide-style inline icons for the popover menu items + page actions.
// Using inline SVG keeps the migration self-contained (no new dep).
// -----------------------------------------------------------------------------

const ICON_SIZE = 14;

function IconAdd() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13.5 8.5a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3.5h-3.5" />
    </svg>
  );
}

function IconMore() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="3" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="13" cy="8" r="1.4" />
    </svg>
  );
}

function IconBed() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 11V4M2 8h12v3M14 11v2M2 13v-2" />
      <circle cx="5.5" cy="7" r="1.2" />
    </svg>
  );
}

function IconMic() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="6" y="2" width="4" height="8" rx="2" />
      <path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14" />
    </svg>
  );
}

function IconClipboard() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="3" width="8" height="11" rx="1.5" />
      <path d="M6 3V2h4v1" />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// Popover menu — anchors a list of actions to a kebab trigger button. Replaces
// the manual overlay + zIndex hand-roll. Tracks its own open state.
// -----------------------------------------------------------------------------

interface MenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
}

interface RowKebabProps {
  items: MenuItem[];
}

function RowKebab({ items }: RowKebabProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  const triggerStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    padding: 0,
    background: "transparent",
    border: "1px solid var(--cocoa-separator)",
    borderRadius: "var(--cocoa-radius-sm)",
    color: "var(--cocoa-label)",
    cursor: "pointer",
    fontFamily: "var(--cocoa-font)"
  };

  const menuStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-1)",
    minWidth: 200
  };

  const itemStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--cocoa-space-2)",
    padding: "var(--cocoa-space-2)",
    background: "transparent",
    border: "none",
    borderRadius: "var(--cocoa-radius-sm)",
    color: "var(--cocoa-label)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-body)",
    cursor: "pointer",
    textAlign: "left",
    width: "100%"
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        style={triggerStyle}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Más acciones"
        onClick={() => setOpen((v) => !v)}
      >
        <IconMore />
      </button>
      <CocoaPopover open={open} anchorEl={anchorRef.current} placement="bottom" onClose={() => setOpen(false)}>
        <div role="menu" style={menuStyle}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              style={itemStyle}
              onClick={() => {
                item.onSelect();
                setOpen(false);
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--cocoa-background-sidebar)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <span style={{ color: "var(--cocoa-label-secondary)", display: "inline-flex" }}>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </CocoaPopover>
    </>
  );
}

export function GroupsEventsDashboard() {
  const state = useApiData<GroupsEventsDashboardData>(
    `/dashboards/groups-events?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 120000 }
  );

  const { showToast } = useToast();
  const data = state.data ?? EMPTY;
  const { kpis, upcomingGroups, upcomingEvents, topAccounts } = data;
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [blockGroupId, setBlockGroupId] = useState<string | null>(null);
  const [eventGroupId, setEventGroupId] = useState<string | null>(null);
  const [roomingGroupId, setRoomingGroupId] = useState<string | null>(null);
  const [detailGroupId, setDetailGroupId] = useState<string | null>(null);
  // Standalone-dialog state: when opened via sidebar deep-links the user has
  // no group selected yet, so the dialogs need their own "no preselected
  // group" mode. Event + rooming dialogs require a target group id, so they
  // surface a chooser when launched without one.
  const [standaloneEventOpen, setStandaloneEventOpen] = useState(false);
  const [standaloneRoomingOpen, setStandaloneRoomingOpen] = useState(false);

  // Sidebar deep-link handler — entries like
  // `GroupsEventsDashboard#nuevo-grupo` land on this screen and auto-open
  // the right modal so users get the dialog they clicked, not just the
  // landing page. We clear the hash after opening so a hard refresh does
  // not re-fire the dialog uninvited.
  useEffect(() => {
    function handleHash() {
      const hash = window.location.hash.replace(/^#/, "");
      if (!hash) return;
      if (hash === "nuevo-grupo") setNewGroupOpen(true);
      else if (hash === "nuevo-evento") setStandaloneEventOpen(true);
      else if (hash === "importar-rooming") setStandaloneRoomingOpen(true);
      // Defer the hash clear so React processes the state update first.
      window.setTimeout(() => {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }, 0);
    }
    handleHash();
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  // Standalone-event resolver: when the user opens the "Nuevo evento" CTA
  // (or deep-links to #nuevo-evento) without selecting a group first, we
  // either pre-select the most relevant upcoming group or — if none exist —
  // surface a warning and bounce the user toward creating a group first.
  // A future iteration can swap this for an inline group picker; for now
  // the first upcoming group is the highest-signal default.
  useEffect(() => {
    if (!standaloneEventOpen) return;
    if (upcomingGroups.length > 0) {
      setEventGroupId(upcomingGroups[0].id);
    } else {
      showToast("Crea un grupo antes de añadir un evento.", { variant: "info" });
    }
    setStandaloneEventOpen(false);
  }, [standaloneEventOpen, upcomingGroups, showToast]);

  // Same flow for "Importar rooming list" — choose the first upcoming group
  // as the import target, or toast if there are no groups yet.
  useEffect(() => {
    if (!standaloneRoomingOpen) return;
    if (upcomingGroups.length > 0) {
      setRoomingGroupId(upcomingGroups[0].id);
    } else {
      showToast("Crea un grupo antes de importar una rooming list.", { variant: "info" });
    }
    setStandaloneRoomingOpen(false);
  }, [standaloneRoomingOpen, upcomingGroups, showToast]);
  // DEV #5 layout declutter — toggle para esconder el 5º KPI (F&B revenue)
  // que estaba "descontextualizado".
  const [showSecondaryKpis, setShowSecondaryKpis] = useState(false);
  // DEV #5 — accordion para la pickup card (sección detallada).
  const [pickupExpanded, setPickupExpanded] = useState(true);
  // showToast is hoisted higher (right after `state`) so the standalone-CTA
  // useEffects above can call it without a TDZ violation.

  const groupsStatus: KpiStatus = kpis.activeGroupBookings > 0 ? "ok" : "warn";
  const blockedStatus: KpiStatus = kpis.roomsBlockedTotal > 0 ? "ok" : "warn";
  const pickupStatus: KpiStatus =
    kpis.pickupPct >= 80 ? "ok" : kpis.pickupPct >= 50 ? "warn" : "error";
  const eventsStatus: KpiStatus = kpis.upcomingEvents > 0 ? "ok" : "warn";
  const revenueStatus: KpiStatus = kpis.fAndBRevenueMtdEur > 0 ? "ok" : "warn";

  // -----------------------------------------------------------------
  // Upcoming-groups table columns. Numeric cells align right; the
  // group-name cell uses a link-styled CocoaButton to open the detail
  // dialog. Actions cell holds the row-level kebab with the three
  // group operations.
  // -----------------------------------------------------------------
  const upcomingGroupColumns: CocoaTableColumn<UpcomingGroup>[] = [
    {
      key: "name",
      label: "Group",
      render: (g) => (
        <CocoaButton variant="plain" size="small" tone="accent" onClick={() => setDetailGroupId(g.id)}>
          {g.name}
        </CocoaButton>
      )
    },
    {
      key: "arrivalDate",
      label: "Arrival",
      render: (g) => formatDate(g.arrivalDate)
    },
    {
      key: "departureDate",
      label: "Departure",
      render: (g) => formatDate(g.departureDate)
    },
    {
      key: "roomsBlocked",
      label: "Blocked",
      align: "right",
      render: (g) => formatNumber(g.roomsBlocked)
    },
    {
      key: "pickedUp",
      label: "Picked up",
      align: "right",
      render: (g) => formatNumber(g.pickedUp)
    },
    {
      key: "pickupPct",
      label: "Pickup",
      align: "right",
      render: (g) => pickupPill(g.pickupPct, g.roomsBlocked)
    },
    {
      key: "actions",
      label: "Acciones",
      align: "center",
      render: (g) => (
        <RowKebab
          items={[
            { key: "block", label: "Bloquear habitaciones", icon: <IconBed />, onSelect: () => setBlockGroupId(g.id) },
            { key: "event", label: "Crear evento", icon: <IconMic />, onSelect: () => setEventGroupId(g.id) },
            { key: "rooming", label: "Importar rooming list", icon: <IconClipboard />, onSelect: () => setRoomingGroupId(g.id) }
          ]}
        />
      )
    }
  ];

  // Top-accounts columns — numeric columns align right.
  const topAccountColumns: CocoaTableColumn<TopAccount>[] = [
    {
      key: "accountName",
      label: "Account",
      render: (row) => <strong style={{ color: "var(--cocoa-label)" }}>{row.accountName}</strong>
    },
    {
      key: "activeGroups",
      label: "Active groups",
      align: "right",
      render: (row) => formatNumber(row.activeGroups)
    },
    {
      key: "valueEur",
      label: "Value",
      align: "right",
      render: (row) => formatEur(row.valueEur)
    }
  ];

  // Quick navigation helpers — both honour the existing hotelos-nav event so
  // we stay consistent with the rest of the shell instead of touching
  // window.location directly.
  function navigateScreen(target: string) {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: target }));
  }

  const headerActions = (
    <>
      <CocoaButton variant="bordered" tone="neutral" icon={<IconRefresh />} onClick={() => state.refresh()}>
        Refresh
      </CocoaButton>
      <CocoaButton
        variant="bordered"
        tone="neutral"
        onClick={() => navigateScreen("GroupsCalendarScreen")}
      >
        Calendario
      </CocoaButton>
      <CocoaButton
        variant="bordered"
        tone="neutral"
        onClick={() => navigateScreen("Allotments")}
      >
        Cupos / Allotments
      </CocoaButton>
      <CocoaButton
        variant="bordered"
        tone="neutral"
        onClick={() => setStandaloneRoomingOpen(true)}
      >
        Importar rooming
      </CocoaButton>
      <CocoaButton
        variant="bordered"
        tone="neutral"
        onClick={() => setStandaloneEventOpen(true)}
      >
        Nuevo evento
      </CocoaButton>
      <CocoaButton variant="filled" tone="accent" icon={<IconAdd />} onClick={() => setNewGroupOpen(true)}>
        Nuevo grupo
      </CocoaButton>
    </>
  );

  const twoColumnGridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: "var(--cocoa-space-4)"
  };

  const screenStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-4)",
    fontFamily: "var(--cocoa-font)"
  };

  const eventListStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-3)",
    listStyle: "none",
    margin: 0,
    padding: 0
  };

  const eventItemStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-1)",
    paddingBlock: "var(--cocoa-space-2)",
    borderBottom: "1px solid var(--cocoa-separator)"
  };

  const eventRowTopStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--cocoa-space-2)",
    flexWrap: "wrap"
  };

  const eventCaptionStyle: CSSProperties = {
    color: "var(--cocoa-label-secondary)",
    fontSize: "var(--cocoa-fs-callout)",
    margin: 0
  };

  return (
    <div style={screenStyle}>
      <CocoaPageHeader
        eyebrow="Commercial · Groups & Events"
        title="Groups & Events"
        subtitle="Vista de solo lectura de bloques de grupo y eventos del periodo: reservas de grupo activas, habitaciones bloqueadas y pickup, próximos eventos con espacio y asistentes esperados, ingresos F&B del mes y cuentas con mayor actividad. Refresco automático cada dos minutos."
        actions={headerActions}
      />

      {state.error ? (
        <CocoaCard variant="bordered" padding="md">
          <p style={{ color: "var(--cocoa-danger)", margin: 0, fontFamily: "var(--cocoa-font)", fontSize: "var(--cocoa-fs-body)" }}>
            Couldn't load this view right now. Refresh to retry.
          </p>
        </CocoaCard>
      ) : null}

      {/* DEV #5 — 4 KPIs principales en la grid (límite). El 5º "F&B revenue MTD"
          va detrás de un toggle "Mostrar más" porque pertenece al bloque de eventos. */}
      <KpiGrid>
        <KpiCard
          label="Active group bookings"
          value={formatNumber(kpis.activeGroupBookings)}
          caption="in progress or upcoming"
          status={groupsStatus}
        />
        <KpiCard
          label="Rooms blocked"
          value={formatNumber(kpis.roomsBlockedTotal)}
          caption="across active blocks"
          status={blockedStatus}
        />
        <KpiCard
          label="Pickup"
          value={`${kpis.pickupPct}%`}
          caption="picked up / blocked"
          status={pickupStatus}
        />
        <KpiCard
          label="Upcoming events"
          value={formatNumber(kpis.upcomingEvents)}
          caption="current + next month"
          status={eventsStatus}
        />
      </KpiGrid>

      <DisclosureButton
        label={showSecondaryKpis ? "Ocultar detalles" : "Mostrar más KPIs"}
        expanded={showSecondaryKpis}
        onToggle={() => setShowSecondaryKpis((v) => !v)}
        align="end"
      />

      {showSecondaryKpis ? (
        <KpiGrid>
          <KpiCard
            label="F&B revenue MTD"
            value={formatEur(kpis.fAndBRevenueMtdEur)}
            caption="events month-to-date"
            status={revenueStatus}
          />
        </KpiGrid>
      ) : null}

      {/* DEV #5 — accordion: pickup card colapsable; usuario decide cuándo ver el detalle. */}
      <section style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-2)" }}>
        <DisclosureButton
          label="Pickup de grupos · ciclo y release"
          expanded={pickupExpanded}
          onToggle={() => setPickupExpanded((v) => !v)}
          trailing={
            <span style={{ marginLeft: "var(--cocoa-space-2)", color: "var(--cocoa-label-tertiary)", fontWeight: 400 }}>
              {pickupExpanded ? "Click para colapsar" : "Click para expandir"}
            </span>
          }
        />
        {pickupExpanded ? <GroupsPickupCard propertyId={PROPERTY_ID} /> : null}
      </section>

      <CocoaCard variant="bordered" padding="md">
        <CardHeader title="Upcoming groups" badge={<NeutralBadge>{upcomingGroups.length} groups</NeutralBadge>} />
        {upcomingGroups.length === 0 ? (
          <EmptyCaption>No upcoming group bookings in the period.</EmptyCaption>
        ) : (
          <CocoaTable<UpcomingGroup>
            columns={upcomingGroupColumns}
            rows={upcomingGroups}
            rowKey="id"
          />
        )}
      </CocoaCard>

      <section style={twoColumnGridStyle}>
        <CocoaCard variant="bordered" padding="md">
          <CardHeader title="Upcoming events" badge={<NeutralBadge>{upcomingEvents.length} events</NeutralBadge>} />
          {upcomingEvents.length === 0 ? (
            <EmptyCaption>No events scheduled in the period.</EmptyCaption>
          ) : (
            <ul style={eventListStyle}>
              {upcomingEvents.map((e) => (
                <li key={e.id} style={eventItemStyle}>
                  <div style={eventRowTopStyle}>
                    <NeutralBadge>{formatDateTime(e.eventDate)}</NeutralBadge>
                    <strong style={{ color: "var(--cocoa-label)" }}>{e.name}</strong>
                    {e.revenueEur !== undefined ? (
                      <NeutralBadge>{formatEur(e.revenueEur)}</NeutralBadge>
                    ) : null}
                  </div>
                  <small style={eventCaptionStyle}>
                    {e.spaceName ? <>{e.spaceName}</> : <>No space assigned</>}
                    {e.expectedAttendees !== undefined ? <> · {formatNumber(e.expectedAttendees)} pax</> : null}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </CocoaCard>

        <CocoaCard variant="bordered" padding="md">
          <CardHeader title="Top accounts" badge={<NeutralBadge>top {topAccounts.length}</NeutralBadge>} />
          {topAccounts.length === 0 ? (
            <EmptyCaption>No accounts with active group bookings.</EmptyCaption>
          ) : (
            <CocoaTable<TopAccount>
              columns={topAccountColumns}
              rows={topAccounts}
              rowKey="accountName"
            />
          )}
        </CocoaCard>
      </section>

      {newGroupOpen ? (
        <NewGroupDialog
          onClose={() => setNewGroupOpen(false)}
          onCreated={(group) => {
            setNewGroupOpen(false);
            state.refresh();
            showToast(`Grupo «${group.name ?? group.code ?? group.id}» creado.`, { variant: "success" });
          }}
          onError={(msg) => showToast(msg, { variant: "error" })}
        />
      ) : null}

      {blockGroupId ? (
        <RoomBlockGridDialog
          groupBookingId={blockGroupId}
          groupName={upcomingGroups.find((g) => g.id === blockGroupId)?.name ?? "Grupo"}
          arrivalDate={upcomingGroups.find((g) => g.id === blockGroupId)?.arrivalDate ?? ""}
          departureDate={upcomingGroups.find((g) => g.id === blockGroupId)?.departureDate ?? ""}
          onClose={() => setBlockGroupId(null)}
          onSaved={(count) => {
            setBlockGroupId(null);
            showToast(`Bloqueo guardado · ${count} celdas actualizadas.`, { variant: "success" });
            state.refresh();
          }}
          onError={(msg) => showToast(msg, { variant: "error" })}
        />
      ) : null}

      {eventGroupId ? (
        <NewEventDialog
          groupBookingId={eventGroupId}
          groupName={upcomingGroups.find((g) => g.id === eventGroupId)?.name ?? "Grupo"}
          arrivalDate={upcomingGroups.find((g) => g.id === eventGroupId)?.arrivalDate ?? ""}
          departureDate={upcomingGroups.find((g) => g.id === eventGroupId)?.departureDate ?? ""}
          onClose={() => setEventGroupId(null)}
          onCreated={(event) => {
            setEventGroupId(null);
            showToast(`Evento «${event.name ?? event.id}» creado.`, { variant: "success" });
            state.refresh();
          }}
          onError={(msg) => showToast(msg, { variant: "error" })}
        />
      ) : null}

      {roomingGroupId ? (
        <RoomingListImportDialog
          groupBookingId={roomingGroupId}
          groupName={upcomingGroups.find((g) => g.id === roomingGroupId)?.name ?? "Grupo"}
          arrivalDate={upcomingGroups.find((g) => g.id === roomingGroupId)?.arrivalDate ?? ""}
          departureDate={upcomingGroups.find((g) => g.id === roomingGroupId)?.departureDate ?? ""}
          onClose={() => setRoomingGroupId(null)}
          onImported={(count) => {
            setRoomingGroupId(null);
            showToast(`Rooming list importada · ${count} entradas.`, { variant: "success" });
            state.refresh();
          }}
          onError={(msg) => showToast(msg, { variant: "error" })}
        />
      ) : null}

      {detailGroupId ? (
        <GroupDetailDialog groupBookingId={detailGroupId} onClose={() => setDetailGroupId(null)} />
      ) : null}
    </div>
  );
}
