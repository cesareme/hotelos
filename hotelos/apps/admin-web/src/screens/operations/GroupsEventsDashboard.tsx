// GroupsEventsDashboard — Recepción › Grupos y eventos (/recepcion/grupos).
//
// Cocoa 22 (ola 3 · lote 3-B, archetype «dashboard», hosted inside
// GruposEventosTabs and standalone): CocoaPage with the actions row (hosted:
// the container paints the eyebrow and the H1; «Calendario» and «Cupos» are
// its tabs, so those two buttons only appear standalone), a CocoaKpiStrip
// (four KPIs plus the F&B revenue behind a disclosure), the pickup card
// behind a disclosure, the upcoming groups as a CocoaTable (row → detail
// drawer; row actions menu: block rooms · create event · import rooming
// list), and a 6/6 grid with the upcoming events list and the top accounts
// table. Every write goes through the group drawers (NewGroupDialog,
// RoomBlockGridDialog, NewEventDialog, RoomingListImportDialog,
// GroupDetailDialog).
//
// Endpoint: GET /dashboards/groups-events?propertyId (polled every two
// minutes). Sidebar deep links `#nuevo-grupo`, `#nuevo-evento` and
// `#importar-rooming` open the matching drawer on arrival.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { NewGroupDialog } from "./NewGroupDialog";
import { RoomBlockGridDialog } from "./RoomBlockGridDialog";
import { NewEventDialog } from "./NewEventDialog";
import { RoomingListImportDialog } from "./RoomingListImportDialog";
import { GroupDetailDialog } from "./GroupDetailDialog";
import { GroupsPickupCard } from "./GroupsPickupCard";
import { useToast } from "../../components/Toast";
import { useTabHost } from "../tabs/TabHost";
import { navigateTo } from "../../lib/navigate";
import { date, dateTime, money, number, percent, plural } from "../../lib/format";
import { ACTIONS, A11Y_LABELS, FIELD_LABELS, STATUS_LABELS } from "../../content/actions";
import { PlusIcon, UploadIcon } from "../../components/cocoa-icons/ActionIcons";
import { BedIcon, CalendarIcon } from "../../components/cocoa-icons/NavigationIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaPopover,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaKpiStatus,
  type CocoaTableColumn
} from "../../components/cocoa";

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
type UpcomingEvent = GroupsEventsDashboardData["upcomingEvents"][number];
type TopAccount = GroupsEventsDashboardData["topAccounts"][number];

const EMPTY_KPIS: GroupsEventsDashboardData["kpis"] = {
  activeGroupBookings: 0,
  roomsBlockedTotal: 0,
  pickupPct: 0,
  upcomingEvents: 0,
  fAndBRevenueMtdEur: 0
};

function pickupBadge(pct: number, blocked: number): ReactNode {
  if (blocked === 0) return <CocoaBadge tone="neutral">sin bloqueo</CocoaBadge>;
  const tone = pct >= 80 ? "success" : pct >= 50 ? "warning" : "danger";
  return (
    <CocoaBadge tone={tone} variant="tinted">
      {percent(pct, { maximumFractionDigits: 0 })}
    </CocoaBadge>
  );
}

// Columns live outside the component (rule A5); the row actions are a closure.
const UPCOMING_GROUP_COLUMNS: CocoaTableColumn<UpcomingGroup>[] = [
  { key: "name", label: "Grupo", minWidth: 160, render: (g) => <strong>{g.name}</strong> },
  { key: "arrivalDate", label: "Llegada", fit: true, render: (g) => date(g.arrivalDate) },
  { key: "departureDate", label: "Salida", fit: true, hideOnNarrow: true, render: (g) => date(g.departureDate) },
  { key: "roomsBlocked", label: "Bloqueadas", align: "right", render: (g) => number(g.roomsBlocked) },
  { key: "pickedUp", label: "Vendidas", align: "right", hideOnNarrow: true, render: (g) => number(g.pickedUp) },
  { key: "pickupPct", label: "Pickup", align: "right", fit: true, render: (g) => pickupBadge(g.pickupPct, g.roomsBlocked) }
];

const TOP_ACCOUNT_COLUMNS: CocoaTableColumn<TopAccount>[] = [
  { key: "accountName", label: "Cuenta", render: (row) => <strong>{row.accountName}</strong> },
  { key: "activeGroups", label: "Grupos activos", align: "right", fit: true, render: (row) => number(row.activeGroups) },
  { key: "valueEur", label: "Valor", align: "right", fit: true, render: (row) => money(row.valueEur) }
];

// Secondary line of a list item: identity from the system.
const NOTE_STYLE: CSSProperties = {
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-callout)"
};

// ---------------------------------------------------------------------------
// Row actions menu — a small «Acciones» button anchoring a CocoaPopover menu
// with the three group operations. Clicks stop at the cell so the row (which
// opens the detail drawer) does not fire.
// ---------------------------------------------------------------------------

interface MenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
}

function RowActionsMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <CocoaButton
        ref={anchorRef}
        variant="bordered"
        tone="neutral"
        size="small"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {FIELD_LABELS.actions}
      </CocoaButton>
      <CocoaPopover open={open} anchorEl={anchorRef.current} placement="bottom" onClose={() => setOpen(false)} role="menu" aria-label={label}>
        <div className="cocoa-stack" data-gap="1" style={{ minWidth: 220 }}>
          {items.map((item) => (
            <CocoaButton
              key={item.key}
              variant="plain"
              tone="neutral"
              size="small"
              role="menuitem"
              icon={item.icon}
              style={{ width: "100%", justifyContent: "flex-start" }}
              onClick={(event) => {
                event.stopPropagation();
                item.onSelect();
                setOpen(false);
              }}
            >
              {item.label}
            </CocoaButton>
          ))}
        </div>
      </CocoaPopover>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[12], [6, 6]]} />
    </div>
  );
}

export function GroupsEventsDashboard() {
  const hosted = useTabHost() !== null;
  const propertyId = getActivePropertyId();
  const state = useApiData<GroupsEventsDashboardData>(`/dashboards/groups-events?propertyId=${propertyId}`, { pollIntervalMs: 120000 });

  const { showToast } = useToast();
  const kpis = state.data?.kpis ?? EMPTY_KPIS;
  const upcomingGroups = toArray<UpcomingGroup>(state.data?.upcomingGroups);
  const upcomingEvents = toArray<UpcomingEvent>(state.data?.upcomingEvents);
  const topAccounts = toArray<TopAccount>(state.data?.topAccounts);

  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [blockGroupId, setBlockGroupId] = useState<string | null>(null);
  const [eventGroupId, setEventGroupId] = useState<string | null>(null);
  const [roomingGroupId, setRoomingGroupId] = useState<string | null>(null);
  const [detailGroupId, setDetailGroupId] = useState<string | null>(null);
  // Standalone drawer state: opened from the sidebar deep links the user has
  // no group selected yet; the event and rooming drawers need a target group,
  // so they pick the first upcoming one (or toast when there is none).
  const [standaloneEventOpen, setStandaloneEventOpen] = useState(false);
  const [standaloneRoomingOpen, setStandaloneRoomingOpen] = useState(false);

  // Sidebar deep links — `GroupsEventsDashboard#nuevo-grupo` and friends land
  // here and open the right drawer. The hash is cleared afterwards so a
  // reload does not reopen it uninvited.
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

  // «Nuevo evento» without a selected group: the first upcoming group is the
  // highest-signal default; without groups, nudge the user to create one.
  useEffect(() => {
    if (!standaloneEventOpen) return;
    if (upcomingGroups.length > 0) {
      setEventGroupId(upcomingGroups[0].id);
    } else {
      showToast("Crea un grupo antes de añadir un evento.", { variant: "info" });
    }
    setStandaloneEventOpen(false);
  }, [standaloneEventOpen, upcomingGroups, showToast]);

  // Same flow for «Importar rooming list».
  useEffect(() => {
    if (!standaloneRoomingOpen) return;
    if (upcomingGroups.length > 0) {
      setRoomingGroupId(upcomingGroups[0].id);
    } else {
      showToast("Crea un grupo antes de importar una rooming list.", { variant: "info" });
    }
    setStandaloneRoomingOpen(false);
  }, [standaloneRoomingOpen, upcomingGroups, showToast]);

  // The fifth KPI (F&B revenue) belongs to the events block: behind a disclosure.
  const [showSecondaryKpis, setShowSecondaryKpis] = useState(false);
  // The pickup card is collapsible.
  const [pickupExpanded, setPickupExpanded] = useState(true);

  const groupsStatus: CocoaKpiStatus = kpis.activeGroupBookings > 0 ? "ok" : "warning";
  const blockedStatus: CocoaKpiStatus = kpis.roomsBlockedTotal > 0 ? "ok" : "warning";
  const pickupStatus: CocoaKpiStatus = kpis.pickupPct >= 80 ? "ok" : kpis.pickupPct >= 50 ? "warning" : "critical";
  const eventsStatus: CocoaKpiStatus = kpis.upcomingEvents > 0 ? "ok" : "warning";
  const revenueStatus: CocoaKpiStatus = kpis.fAndBRevenueMtdEur > 0 ? "ok" : "warning";

  function groupById(id: string | null): UpcomingGroup | undefined {
    return id ? upcomingGroups.find((g) => g.id === id) : undefined;
  }

  const headerActions = (
    <>
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => state.refresh()}>
        {ACTIONS.refresh}
      </CocoaButton>
      {hosted ? null : (
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" icon={<CalendarIcon size={14} />} onClick={() => navigateTo("GroupsCalendarScreen")}>
            Calendario
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("Allotments")}>
            Cupos
          </CocoaButton>
        </>
      )}
      <CocoaButton variant="bordered" tone="neutral" size="small" icon={<UploadIcon size={14} />} onClick={() => setStandaloneRoomingOpen(true)}>
        Importar rooming list
      </CocoaButton>
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setStandaloneEventOpen(true)}>
        Nuevo evento
      </CocoaButton>
      <CocoaButton variant="filled" tone="accent" size="small" icon={<PlusIcon size={14} />} onClick={() => setNewGroupOpen(true)}>
        Nuevo grupo
      </CocoaButton>
    </>
  );

  const blockGroup = groupById(blockGroupId);
  const eventGroup = groupById(eventGroupId);
  const roomingGroup = groupById(roomingGroupId);

  return (
    <CocoaPage
      eyebrow={`Recepción · ${getActiveProperty().propertyName}`}
      title="Grupos y eventos"
      subtitle={
        hosted
          ? undefined
          : "Bloques de grupo y eventos del periodo: reservas de grupo activas, habitaciones bloqueadas y pickup, próximos eventos con espacio y asistentes, ingresos de restauración del mes y cuentas con mayor actividad. Se actualiza cada dos minutos."
      }
      actions={headerActions}
      state={state.loading && !state.data ? "loading" : state.error && !state.data ? "error" : "ready"}
      skeleton={<DashboardSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: state.error ?? undefined, onRetry: () => state.refresh() }}
      commands={[
        { id: "groups-events-refresh", label: "Actualizar grupos y eventos", run: () => state.refresh() },
        { id: "groups-events-new-group", label: "Nuevo grupo", run: () => setNewGroupOpen(true) },
        { id: "groups-events-new-event", label: "Nuevo evento", run: () => setStandaloneEventOpen(true) },
        { id: "groups-events-import-rooming", label: "Importar rooming list", run: () => setStandaloneRoomingOpen(true) }
      ]}
    >
      {state.error && state.data ? (
        <CocoaCallout tone="danger" title="No hemos podido actualizar esta vista" role="alert">
          Se muestran los últimos datos cargados. {state.error}
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Indicadores de grupos y eventos">
        <CocoaKpi label="Reservas de grupo activas" value={number(kpis.activeGroupBookings)} caption="en curso o próximas" polarity="neutral" status={groupsStatus} />
        <CocoaKpi label="Habitaciones bloqueadas" value={number(kpis.roomsBlockedTotal)} caption="en los bloques activos" polarity="neutral" status={blockedStatus} />
        <CocoaKpi label="Pickup" value={percent(kpis.pickupPct, { maximumFractionDigits: 0 })} caption="vendidas sobre bloqueadas" status={pickupStatus} />
        <CocoaKpi label="Próximos eventos" value={number(kpis.upcomingEvents)} caption="este mes y el siguiente" polarity="neutral" status={eventsStatus} />
      </CocoaKpiStrip>

      <div className="cocoa-row" data-justify="end">
        <CocoaButton
          variant="plain"
          tone="neutral"
          size="small"
          aria-expanded={showSecondaryKpis}
          aria-controls="groups-events-secondary-kpis"
          onClick={() => setShowSecondaryKpis((v) => !v)}
        >
          {showSecondaryKpis ? "Ocultar indicadores secundarios" : "Mostrar más indicadores"}
        </CocoaButton>
      </div>

      {showSecondaryKpis ? (
        <div id="groups-events-secondary-kpis">
          <CocoaKpiStrip aria-label="Indicadores secundarios">
            <CocoaKpi label="Ingresos de restauración del mes" value={money(kpis.fAndBRevenueMtdEur)} caption="eventos, mes en curso" status={revenueStatus} />
          </CocoaKpiStrip>
        </div>
      ) : null}

      <div className="cocoa-row" data-justify="between">
        <span className="cocoa-caption">Captación de grupos · ciclo y liberación</span>
        <CocoaButton
          variant="plain"
          tone="neutral"
          size="small"
          aria-expanded={pickupExpanded}
          aria-controls="groups-events-pickup"
          onClick={() => setPickupExpanded((v) => !v)}
        >
          {pickupExpanded ? A11Y_LABELS.collapse : A11Y_LABELS.expand}
        </CocoaButton>
      </div>
      {pickupExpanded ? (
        <div id="groups-events-pickup">
          <GroupsPickupCard propertyId={propertyId} onSelect={(groupId) => setDetailGroupId(groupId)} />
        </div>
      ) : null}

      <CocoaSection title="Próximos grupos" meta={plural(upcomingGroups.length, "grupo", "grupos")} padding="none" style={{ overflow: "clip" }}>
        {upcomingGroups.length === 0 ? (
          <CocoaState kind="empty" inline title="Sin reservas de grupo próximas en el periodo." style={{ padding: "var(--cocoa-space-4)" }} />
        ) : (
          <CocoaTable<UpcomingGroup>
            columns={UPCOMING_GROUP_COLUMNS}
            rows={upcomingGroups}
            rowKey="id"
            onSelect={(g) => setDetailGroupId(g.id)}
            rowTitle={() => "Abrir el detalle del grupo"}
            rowActions={(g) => (
              <RowActionsMenu
                label={`Acciones del grupo ${g.name}`}
                items={[
                  { key: "block", label: "Bloquear habitaciones", icon: <BedIcon size={14} />, onSelect: () => setBlockGroupId(g.id) },
                  { key: "event", label: "Crear evento", icon: <CalendarIcon size={14} />, onSelect: () => setEventGroupId(g.id) },
                  { key: "rooming", label: "Importar rooming list", icon: <UploadIcon size={14} />, onSelect: () => setRoomingGroupId(g.id) }
                ]}
              />
            )}
            caption="Próximos grupos"
            aria-label="Próximos grupos"
          />
        )}
      </CocoaSection>

      <CocoaGrid align="start" aria-label="Eventos y cuentas">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Próximos eventos" meta={plural(upcomingEvents.length, "evento", "eventos")}>
            {upcomingEvents.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin eventos programados en el periodo." />
            ) : (
              <ul className="c22-section__list" aria-label="Próximos eventos">
                {upcomingEvents.map((e) => (
                  <li key={e.id}>
                    <CocoaBadge tone="neutral">{dateTime(e.eventDate, { style: "dayMonth" })}</CocoaBadge>
                    <span className="cocoa-stack" data-gap="1" style={{ flex: "1 1 auto", minWidth: 0 }}>
                      <span>{e.name}</span>
                      <span style={NOTE_STYLE}>
                        {e.spaceName ?? "Sin espacio asignado"}
                        {e.expectedAttendees !== undefined ? ` · ${plural(e.expectedAttendees, "asistente", "asistentes")}` : null}
                      </span>
                    </span>
                    {e.revenueEur !== undefined ? <strong>{money(e.revenueEur)}</strong> : null}
                  </li>
                ))}
              </ul>
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Principales cuentas" meta={plural(topAccounts.length, "cuenta", "cuentas")} padding="none" style={{ overflow: "clip" }}>
            {topAccounts.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin cuentas con reservas de grupo activas." style={{ padding: "var(--cocoa-space-4)" }} />
            ) : (
              <CocoaTable<TopAccount> columns={TOP_ACCOUNT_COLUMNS} rows={topAccounts} rowKey="accountName" caption="Principales cuentas" aria-label="Principales cuentas" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

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
          groupName={blockGroup?.name ?? "Grupo"}
          arrivalDate={blockGroup?.arrivalDate ?? ""}
          departureDate={blockGroup?.departureDate ?? ""}
          onClose={() => setBlockGroupId(null)}
          onSaved={(count) => {
            setBlockGroupId(null);
            showToast(`Bloqueo guardado · ${plural(count, "celda actualizada", "celdas actualizadas")}.`, { variant: "success" });
            state.refresh();
          }}
          onError={(msg) => showToast(msg, { variant: "error" })}
        />
      ) : null}

      {eventGroupId ? (
        <NewEventDialog
          groupBookingId={eventGroupId}
          groupName={eventGroup?.name ?? "Grupo"}
          arrivalDate={eventGroup?.arrivalDate ?? ""}
          departureDate={eventGroup?.departureDate ?? ""}
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
          groupName={roomingGroup?.name ?? "Grupo"}
          arrivalDate={roomingGroup?.arrivalDate ?? ""}
          departureDate={roomingGroup?.departureDate ?? ""}
          onClose={() => setRoomingGroupId(null)}
          onImported={(count) => {
            setRoomingGroupId(null);
            showToast(`Rooming list importada · ${plural(count, "entrada", "entradas")}.`, { variant: "success" });
            state.refresh();
          }}
          onError={(msg) => showToast(msg, { variant: "error" })}
        />
      ) : null}

      {detailGroupId ? <GroupDetailDialog groupBookingId={detailGroupId} onClose={() => setDetailGroupId(null)} /> : null}
    </CocoaPage>
  );
}
