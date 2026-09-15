// Front Desk Dashboard — Recepción, the base tab of Mi día (/hoy).
//
// Today's arrivals, departures, in-house stays and unassigned arrivals with
// the 90/60-second check-in / check-out drawers opened in place, the
// prioritised action queue and the first-run welcome card for a property
// without reservations yet.
//
// Cocoa 22 (ola 2 · lote 2-A): `CocoaPage` (hosted the container paints the
// H1; standalone eyebrow + H1 + subtitle), `CocoaKpiStrip` of `CocoaKpi`
// (three headline tiles + three risk tiles behind a toggle), the four tables
// as internal views of one `CocoaSection` (`CocoaSegmentedControl` + CSV
// export in a content toolbar, `CocoaTable` per view), `CocoaBadge` for the
// reservation / balance status, `CocoaState` for the empty tables and the
// shared toast (`useToast`) instead of a fixed local pill. Same endpoint,
// polling, actions and drawers.

import { useEffect, useState, type CSSProperties } from "react";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { fetchRoomTypes, fetchRooms } from "../../services/pmsCommerceApi";
import { fetchRatePlans } from "../../services/ratePlansApi";
import { useApiData } from "../../hooks/useApiData";
import { exportToCsv, type CsvColumn } from "../../lib/csv";
import { useToast } from "../../components/Toast";
import { navigateTo } from "../../lib/navigate";
import { date, money, number, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { CheckIcon } from "../../components/cocoa-icons/ActionIcons";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { FRONTDESK_COCKPIT_INSTRUCTIONS } from "../../content/screen-instructions/frontdesk-cockpit";
import { FrontDeskActionQueue } from "./FrontDeskActionQueue";
import { QuickCheckInDrawer } from "./QuickCheckInDrawer";
import { QuickCheckOutDrawer } from "./QuickCheckOutDrawer";
import {
  CocoaBadge,
  CocoaButton,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

type Kpis = {
  arrivalsToday: number;
  departuresToday: number;
  inHouseNow: number;
  unassignedRooms: number;
  overdueDepartures: number;
  pendingBalanceEur: number;
};

type ArrivalRow = {
  reservationId: string;
  guestName: string;
  arrivalDate: string;
  nights: number;
  roomNumber?: string;
  roomTypeName?: string;
  status: string;
  balanceEur: number;
  specialRequests?: string;
};

type DepartureRow = {
  reservationId: string;
  guestName: string;
  departureDate: string;
  roomNumber?: string;
  balanceEur: number;
  status: string;
};

type InHouseRow = {
  reservationId: string;
  guestName: string;
  roomNumber?: string;
  departureDate: string;
  nightsRemaining: number;
  balanceEur: number;
  status: string;
};

type UnassignedRow = {
  reservationId: string;
  guestName: string;
  arrivalDate: string;
  roomTypeName?: string;
  preferences?: string;
};

type FrontDeskDashboardData = {
  kpis: Kpis;
  arrivals: ArrivalRow[];
  departures: DepartureRow[];
  inHouse: InHouseRow[];
  unassigned: UnassignedRow[];
};

const RESERVATION_STATUS_LABELS: Record<string, string> = {
  draft: "Borrador",
  confirmed: "Confirmada",
  checked_in: "Alojado",
  checked_out: "Salida realizada",
  cancelled: "Cancelada",
  no_show: "No-show"
};

const RESERVATION_STATUS_TONE: Record<string, CocoaTone> = {
  draft: "info",
  confirmed: "info",
  checked_in: "success",
  checked_out: "success",
  cancelled: "danger",
  no_show: "danger"
};

function fmtNumber(value: number | null | undefined): string {
  return number(value);
}

function fmtEur(value: number | null | undefined): string {
  return money(value);
}

function fmtDay(iso: string | null | undefined): string {
  return date(iso, "dayMonth");
}

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 6 && h < 13) return "Buenos días";
  if (h >= 13 && h < 20) return "Buenas tardes";
  return "Buenas noches";
}

function todayLabel(): string {
  const label = date(new Date(), "weekday");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function elapsedText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function statusBadge(status: string) {
  return (
    <CocoaBadge tone={RESERVATION_STATUS_TONE[status] ?? "info"} size="small">
      {RESERVATION_STATUS_LABELS[status] ?? status}
    </CocoaBadge>
  );
}

function balanceBadge(value: number) {
  if (!Number.isFinite(value) || value === 0) return <CocoaBadge tone="success" size="small">saldado</CocoaBadge>;
  if (value > 0) return <CocoaBadge tone="warning" size="small">pendiente</CocoaBadge>;
  return <CocoaBadge tone="info" size="small">a favor</CocoaBadge>;
}

function openSearch() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("hotelos-open-search"));
  }
}

// Secondary cell text (caption, secondary ink); layout from the utilities.
const mutedStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)"
};

const mutedCellStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };

const bodyTextStyle: CSSProperties = { margin: 0, fontSize: "var(--cocoa-fs-body)", color: "var(--cocoa-label-secondary)" };

// Bienvenida de primera ejecución — se muestra cuando aún no hay ninguna
// reserva en el sistema. Los chips guían al recepcionista hacia los cuatro
// pasos mínimos para empezar a operar el hotel.
//
// Each step reflects the REAL state of the property: a hotel provisioned with
// rooms, room types and a rate plan but no reservation yet (the pilot case)
// must not be told to "create rooms". Three light GETs the setup forms already
// use decide it; a failed probe leaves the step as "unknown" rather than
// pretending it is pending.
type FirstRunStepKey = "rooms" | "roomTypes" | "ratePlans" | "reservation";
type FirstRunStep = { key: FirstRunStepKey; label: string; screen: "RoomInventoryManager" | "RoomTypeManager" | "RevenueSettings" | "ReservationCreate" };
type FirstRunProgress = Record<Exclude<FirstRunStepKey, "reservation">, boolean | null>;

const FIRST_RUN_STEPS: FirstRunStep[] = [
  { key: "rooms", label: "1. Crear habitaciones", screen: "RoomInventoryManager" },
  { key: "roomTypes", label: "2. Tipos de habitación", screen: "RoomTypeManager" },
  { key: "ratePlans", label: "3. Plan tarifario", screen: "RevenueSettings" },
  { key: "reservation", label: "4. Primera reserva", screen: "ReservationCreate" }
];

async function probeHasRows(load: () => Promise<unknown[]>): Promise<boolean | null> {
  try {
    const rows = await load();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    // Endpoint missing or transient failure: unknown, not "pending".
    return null;
  }
}

function FirstRunWelcomeCard({ propertyId }: { propertyId: string }) {
  const [progress, setProgress] = useState<FirstRunProgress>({ rooms: null, roomTypes: null, ratePlans: null });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      probeHasRows(() => fetchRooms(propertyId)),
      probeHasRows(() => fetchRoomTypes(propertyId)),
      probeHasRows(() => fetchRatePlans(propertyId))
    ]).then(([rooms, roomTypes, ratePlans]) => {
      if (!cancelled) setProgress({ rooms, roomTypes, ratePlans });
    });
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  const setupDone = progress.rooms === true && progress.roomTypes === true && progress.ratePlans === true;
  const stepDone = (step: FirstRunStep): boolean => step.key !== "reservation" && progress[step.key] === true;

  return (
    <CocoaSection
      variant="elevated"
      padding="lg"
      headingLevel={2}
      title={setupDone ? "Todo listo: registra la primera reserva" : "Configura tu hotel en 4 pasos"}
      meta="Bienvenido a Anfitorio"
    >
      <div className="cocoa-stack" data-gap="3">
        <p style={bodyTextStyle}>
          {setupDone
            ? "Habitaciones, tipos de habitación y plan tarifario ya están configurados. Solo falta la primera reserva para que recepción empiece a operar."
            : "Empieza por dar de alta tu inventario y crea la primera reserva. Estos cuatro pasos cubren lo mínimo para que recepción pueda operar."}
        </p>
        <div className="cocoa-row" data-gap="2">
          {FIRST_RUN_STEPS.map((step) => {
            const done = stepDone(step);
            // The only pending step gets the accent so the eye lands on it.
            const isNext = setupDone && step.key === "reservation";
            return (
              <CocoaButton
                key={step.screen}
                variant={isNext ? "filled" : "bordered"}
                tone={isNext ? "accent" : "neutral"}
                size="regular"
                icon={done ? <CheckIcon size={14} /> : undefined}
                onClick={() => navigateTo(step.screen)}
                aria-label={done ? `${step.label} (hecho) · revisar` : `Ir a ${step.label}`}
              >
                {step.label}
              </CocoaButton>
            );
          })}
        </div>
      </div>
    </CocoaSection>
  );
}

type FrontDeskTab = "arrivals" | "departures" | "inhouse" | "unassigned";

// Mirror skeleton: KPI strip, the queue card and the tables card.
function FrontDeskSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={200} />
      <CocoaSkeleton.Strip count={3} label="Cargando indicadores de hoy…" />
      <CocoaSkeleton variant="card" height={320} />
    </div>
  );
}

export function FrontDeskDashboard() {
  const { showToast } = useToast();
  const { data, loading, error, refresh } = useApiData<FrontDeskDashboardData>(
    `/dashboards/front-desk?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 30000 }
  );

  // Drawers in-place — abren el flujo de check-in/check-out de 90/60 s sin
  // perder el contexto del dashboard. Solo conservamos el reservationId porque
  // los drawers cargan la reserva completa desde la API.
  const [checkInTarget, setCheckInTarget] = useState<string | null>(null);
  const [checkOutTarget, setCheckOutTarget] = useState<string | null>(null);
  // DEV #5 layout declutter — tabs y toggle "riesgos" para reducir scroll.
  // Mantenemos las 4 tablas pero solo una visible a la vez; los 3 KPIs
  // secundarios (sin habitación / salidas con retraso / saldo pendiente)
  // están detrás de un toggle "Riesgos" para limpiar la cabecera.
  const [activeTab, setActiveTab] = useState<FrontDeskTab>("arrivals");
  const [showRiskKpis, setShowRiskKpis] = useState(false);

  function notify(kind: "ok" | "warn" | "error", text: string) {
    showToast(text, { variant: kind === "ok" ? "success" : kind === "warn" ? "warning" : "error", duration: 5000 });
  }

  const kpis: Kpis = data?.kpis ?? {
    arrivalsToday: 0,
    departuresToday: 0,
    inHouseNow: 0,
    unassignedRooms: 0,
    overdueDepartures: 0,
    pendingBalanceEur: 0
  };
  const arrivals = data?.arrivals ?? [];
  const departures = data?.departures ?? [];
  const inHouse = data?.inHouse ?? [];
  const unassigned = data?.unassigned ?? [];

  // CSV exports — one per table. Filenames carry the date so the operator can
  // archive the file without renaming it.
  const todayStamp = new Date().toISOString().slice(0, 10);

  const arrivalsColumns: CsvColumn<ArrivalRow>[] = [
    { key: "reservationId", label: "Reserva" },
    { key: "guestName", label: "Huésped" },
    { key: "arrivalDate", label: "Llegada" },
    { key: "nights", label: "Noches" },
    { key: "roomNumber", label: "Habitación" },
    { key: "roomTypeName", label: "Tipo habitación" },
    {
      key: "status",
      label: "Estado",
      format: (v) => RESERVATION_STATUS_LABELS[String(v)] ?? String(v ?? "")
    },
    { key: "balanceEur", label: "Saldo (EUR)" },
    { key: "specialRequests", label: "Peticiones" }
  ];
  const departuresColumns: CsvColumn<DepartureRow>[] = [
    { key: "reservationId", label: "Reserva" },
    { key: "guestName", label: "Huésped" },
    { key: "departureDate", label: "Salida" },
    { key: "roomNumber", label: "Habitación" },
    {
      key: "status",
      label: "Estado",
      format: (v) => RESERVATION_STATUS_LABELS[String(v)] ?? String(v ?? "")
    },
    { key: "balanceEur", label: "Saldo (EUR)" }
  ];
  const inHouseColumns: CsvColumn<InHouseRow>[] = [
    { key: "reservationId", label: "Reserva" },
    { key: "guestName", label: "Huésped" },
    { key: "roomNumber", label: "Habitación" },
    { key: "departureDate", label: "Sale" },
    { key: "nightsRemaining", label: "Noches restantes" },
    { key: "balanceEur", label: "Saldo (EUR)" },
    {
      key: "status",
      label: "Estado",
      format: (v) => RESERVATION_STATUS_LABELS[String(v)] ?? String(v ?? "")
    }
  ];
  const unassignedColumns: CsvColumn<UnassignedRow>[] = [
    { key: "reservationId", label: "Reserva" },
    { key: "guestName", label: "Huésped" },
    { key: "arrivalDate", label: "Llegada" },
    { key: "roomTypeName", label: "Tipo habitación" },
    { key: "preferences", label: "Preferencias" }
  ];

  function handleExport<T extends object>(rows: readonly T[], columns: CsvColumn<T>[], filename: string, label: string) {
    if (rows.length === 0) {
      notify("warn", `${label}: no hay datos para exportar`);
      return;
    }
    exportToCsv(rows, `${filename}-${todayStamp}`, columns);
    notify("ok", `${label} exportadas (${rows.length})`);
  }

  const exportActive: Record<FrontDeskTab, () => void> = {
    arrivals: () => handleExport(arrivals, arrivalsColumns, "llegadas", "Llegadas"),
    departures: () => handleExport(departures, departuresColumns, "salidas", "Salidas"),
    inhouse: () => handleExport(inHouse, inHouseColumns, "en-el-hotel", "Estancias"),
    unassigned: () => handleExport(unassigned, unassignedColumns, "sin-habitacion", "Sin habitación")
  };

  const propertyName = getActiveProperty().propertyName;
  const riskCount = kpis.unassignedRooms + kpis.overdueDepartures;
  const hasRisks = riskCount > 0 || kpis.pendingBalanceEur > 0;

  // Caso "DB vacía" — las 4 colecciones vacías Y no hay error de carga. Cuando
  // se cumple, mostramos la bienvenida de primera ejecución (clean-slate) para
  // guiar al usuario a configurar su hotel desde cero.
  const isCleanSlate =
    !error &&
    !loading &&
    Boolean(data) &&
    arrivals.length === 0 &&
    departures.length === 0 &&
    inHouse.length === 0 &&
    unassigned.length === 0;

  // One-line human summary of the day.
  const summaryParts = [plural(kpis.arrivalsToday, "llegada", "llegadas"), plural(kpis.departuresToday, "salida", "salidas")];
  if (kpis.unassignedRooms > 0) {
    summaryParts.push(`${fmtNumber(kpis.unassignedRooms)} sin habitación`);
  }

  const subtitle = `${greeting()}, ${propertyName}. Hoy tienes ${summaryParts.join(" · ")}.`;

  // Cocoa table columns for each tab. Action buttons go inside `render`.
  const arrivalsTableColumns: CocoaTableColumn<ArrivalRow>[] = [
    {
      key: "guestName",
      label: "Huésped",
      render: (row) => (
        <div className="cocoa-stack" data-gap="1">
          <strong>{row.guestName}</strong>
          {row.specialRequests ? <span style={mutedStyle}>{row.specialRequests}</span> : null}
        </div>
      )
    },
    {
      key: "roomNumber",
      label: "Habitación",
      render: (row) => (row.roomNumber ? <strong>{row.roomNumber}</strong> : <span style={mutedCellStyle}>sin asignar</span>)
    },
    {
      key: "roomTypeName",
      label: "Tipo",
      render: (row) => row.roomTypeName ?? <span style={mutedCellStyle}>—</span>,
      hideOnNarrow: true
    },
    {
      key: "nights",
      label: "Noches",
      align: "right",
      render: (row) => fmtNumber(row.nights),
      hideOnNarrow: true
    },
    {
      key: "status",
      label: "Estado",
      render: (row) => statusBadge(row.status)
    },
    {
      key: "balance",
      label: "Saldo",
      align: "right",
      render: (row) => (
        <div className="cocoa-stack" data-gap="1">
          <strong>{fmtEur(row.balanceEur)}</strong>
          <span>{balanceBadge(row.balanceEur)}</span>
        </div>
      )
    },
    {
      key: "actions",
      label: "Acciones",
      render: (row) => {
        const canCheckIn = Boolean(row.roomNumber) && row.status === "confirmed";
        const checkInTooltip = !row.roomNumber
          ? "Asigna una habitación antes de hacer el check-in"
          : row.status === "checked_in"
            ? "Ya hizo el check-in"
            : row.status === "checked_out"
              ? "Ya hizo el check-out"
              : row.status === "cancelled" || row.status === "no_show"
                ? "Reserva cerrada"
                : "Check-in disponible";
        return (
          <div className="cocoa-row" data-gap="1">
            <CocoaButton variant="filled" tone="accent" size="small" disabled={!canCheckIn} title={checkInTooltip} onClick={() => setCheckInTarget(row.reservationId)}>
              Hacer check-in
            </CocoaButton>
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => navigateTo("ReservationDetailWorkspace")}>
              Ver folio
            </CocoaButton>
          </div>
        );
      }
    }
  ];

  const departuresTableColumns: CocoaTableColumn<DepartureRow>[] = [
    { key: "guestName", label: "Huésped", render: (row) => <strong>{row.guestName}</strong> },
    {
      key: "roomNumber",
      label: "Habitación",
      render: (row) => (row.roomNumber ? <strong>{row.roomNumber}</strong> : <span style={mutedCellStyle}>—</span>)
    },
    { key: "status", label: "Estado", render: (row) => statusBadge(row.status) },
    {
      key: "balance",
      label: "Saldo",
      align: "right",
      render: (row) => (
        <div className="cocoa-stack" data-gap="1">
          <strong>{fmtEur(row.balanceEur)}</strong>
          <span>{balanceBadge(row.balanceEur)}</span>
        </div>
      )
    },
    {
      key: "actions",
      label: "Acciones",
      render: (row) => {
        const canCheckOut = row.status === "checked_in";
        const checkOutTooltip = !canCheckOut ? (row.status === "checked_out" ? "Ya hizo el check-out" : "El huésped no está alojado") : "Check-out disponible";
        return (
          <div className="cocoa-row" data-gap="1">
            <CocoaButton variant="filled" tone="accent" size="small" disabled={!canCheckOut} title={checkOutTooltip} onClick={() => setCheckOutTarget(row.reservationId)}>
              Hacer check-out
            </CocoaButton>
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => navigateTo("ReservationDetailWorkspace")}>
              Ver folio
            </CocoaButton>
          </div>
        );
      }
    }
  ];

  const inHouseTableColumns: CocoaTableColumn<InHouseRow>[] = [
    { key: "guestName", label: "Huésped", render: (row) => <strong>{row.guestName}</strong> },
    {
      key: "roomNumber",
      label: "Habitación",
      render: (row) => (row.roomNumber ? <strong>{row.roomNumber}</strong> : <span style={mutedCellStyle}>—</span>)
    },
    { key: "departureDate", label: "Sale", render: (row) => fmtDay(row.departureDate) },
    { key: "nightsRemaining", label: "Noches restantes", align: "right", render: (row) => fmtNumber(row.nightsRemaining), hideOnNarrow: true },
    {
      key: "balance",
      label: "Saldo",
      align: "right",
      render: (row) => (
        <div className="cocoa-stack" data-gap="1">
          <strong>{fmtEur(row.balanceEur)}</strong>
          <span>{balanceBadge(row.balanceEur)}</span>
        </div>
      )
    },
    {
      key: "actions",
      label: "Acciones",
      render: () => (
        <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => navigateTo("ReservationDetailWorkspace")}>
          Ver folio
        </CocoaButton>
      )
    }
  ];

  const unassignedTableColumns: CocoaTableColumn<UnassignedRow>[] = [
    { key: "guestName", label: "Huésped", render: (row) => <strong>{row.guestName}</strong> },
    { key: "arrivalDate", label: "Llegada", render: (row) => fmtDay(row.arrivalDate) },
    { key: "roomTypeName", label: "Tipo", render: (row) => row.roomTypeName ?? <span style={mutedCellStyle}>—</span>, hideOnNarrow: true },
    { key: "preferences", label: "Preferencias", render: (row) => (row.preferences ? row.preferences : <span style={mutedCellStyle}>—</span>), hideOnNarrow: true },
    {
      key: "actions",
      label: "Acciones",
      render: () => (
        <CocoaButton variant="filled" tone="accent" size="small" title="Abrir la reserva para asignar habitación" onClick={() => navigateTo("ReservationDetailWorkspace")}>
          Asignar habitación
        </CocoaButton>
      )
    }
  ];

  const pageActions = (
    <>
      {loading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
      {error ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
        {ACTIONS.refresh}
      </CocoaButton>
      <CocoaButton variant="plain" tone="neutral" size="small" onClick={openSearch}>
        Buscar (⌘K)
      </CocoaButton>
      <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => navigateTo("LiveTimelineWorkspace")}>
        Cronograma
      </CocoaButton>
      <CocoaButton variant="filled" tone="accent" size="small" onClick={() => navigateTo("ReservationCreate")}>
        Crear reserva
      </CocoaButton>
    </>
  );

  const tabOptions = [
    { value: "arrivals", label: `Llegadas (${fmtNumber(arrivals.length)})` },
    { value: "departures", label: `Salidas (${fmtNumber(departures.length)})` },
    { value: "inhouse", label: `En el hotel (${fmtNumber(inHouse.length)})` },
    { value: "unassigned", label: `Sin habitación (${fmtNumber(unassigned.length)})` }
  ];

  return (
    <CocoaPage
      eyebrow={`Recepción · ${todayLabel()}`}
      title="Recepción"
      subtitle={subtitle}
      actions={pageActions}
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<FrontDeskSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[
        { id: "front-desk-refresh", label: "Actualizar recepción", run: refresh },
        { id: "front-desk-new-reservation", label: "Crear reserva", run: () => navigateTo("ReservationCreate") },
        { id: "front-desk-timeline", label: "Abrir cronograma", run: () => navigateTo("LiveTimelineWorkspace") }
      ]}
    >
      <CocoaScreenInstructionsCard {...FRONTDESK_COCKPIT_INSTRUCTIONS} dismissible persistKey="frontdesk-cockpit" />

      {/* Clean-slate — bienvenida de primera ejecución cuando aún no hay reservas. */}
      {isCleanSlate ? <FirstRunWelcomeCard propertyId={PROPERTY_ID} /> : null}

      {/* Cola de acciones priorizada — la vista que dice qué hacer ahora. */}
      <FrontDeskActionQueue />

      <CocoaKpiStrip stagger aria-label="Indicadores de hoy">
        <CocoaKpi label="Llegadas hoy" value={fmtNumber(kpis.arrivalsToday)} deltaLabel="hoy" polarity="neutral" status="ok" />
        <CocoaKpi label="Salidas hoy" value={fmtNumber(kpis.departuresToday)} deltaLabel="hoy" polarity="neutral" status="ok" />
        <CocoaKpi label="En el hotel" value={fmtNumber(kpis.inHouseNow)} deltaLabel="ocupadas" polarity="neutral" status="ok" />
      </CocoaKpiStrip>

      {/* DEV #5 — bloque "Riesgos" colapsable: los 3 KPIs operativos
          (sin habitación, retrasos, saldo) se muestran bajo demanda. */}
      <div className="cocoa-row" data-gap="2" data-justify="end">
        {!showRiskKpis && hasRisks ? (
          <CocoaBadge tone="warning" variant="tinted" size="small">
            {plural(riskCount, "alerta", "alertas")}
          </CocoaBadge>
        ) : null}
        <CocoaButton
          variant="plain"
          tone="neutral"
          size="small"
          onClick={() => setShowRiskKpis((v) => !v)}
          aria-expanded={showRiskKpis}
          aria-label={showRiskKpis ? "Ocultar KPIs de riesgo" : "Mostrar KPIs de riesgo"}
        >
          {showRiskKpis ? "Ocultar riesgos" : "Mostrar riesgos"}
        </CocoaButton>
      </div>

      {showRiskKpis ? (
        <CocoaKpiStrip stagger aria-label="Riesgos de hoy">
          <CocoaKpi
            label="Sin habitación"
            value={fmtNumber(kpis.unassignedRooms)}
            deltaLabel={kpis.unassignedRooms > 0 ? "pendiente" : "al día"}
            polarity="neutral"
            status={kpis.unassignedRooms > 0 ? "warning" : "ok"}
          />
          <CocoaKpi
            label="Salidas con retraso"
            value={fmtNumber(kpis.overdueDepartures)}
            deltaLabel={kpis.overdueDepartures > 0 ? "con retraso" : "a tiempo"}
            polarity="neutral"
            status={kpis.overdueDepartures > 0 ? "critical" : "ok"}
          />
          <CocoaKpi
            label="Saldo pendiente"
            value={fmtEur(kpis.pendingBalanceEur)}
            deltaLabel={kpis.pendingBalanceEur > 0 ? "por cobrar" : "saldado"}
            polarity="neutral"
            status={kpis.pendingBalanceEur > 0 ? "warning" : "ok"}
          />
        </CocoaKpiStrip>
      ) : null}

      {/* DEV #5 — las 4 tablas pasan a vistas internas en una sola sección.
          Solo una tabla visible a la vez → recorta ~60% el scroll. */}
      <CocoaSection title="Movimientos de hoy">
        <div className="cocoa-stack" data-gap="3">
          <CocoaToolbar
            variant="content"
            aria-label="Vista de recepción"
            leftSlot={<CocoaSegmentedControl size="small" aria-label="Vista de recepción" value={activeTab} onChange={(value) => setActiveTab(value as FrontDeskTab)} options={tabOptions} />}
            rightSlot={
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={exportActive[activeTab]} aria-label="Descargar la tabla en formato CSV">
                Exportar CSV
              </CocoaButton>
            }
          />

          {activeTab === "arrivals" ? (
            arrivals.length === 0 ? (
              <CocoaState
                kind="empty"
                title="No hay llegadas previstas para hoy"
                message="Cuando se confirmen reservas con entrada hoy aparecerán aquí, listas para asignar habitación y hacer check-in."
                primaryAction={{ label: "Crear reserva", onClick: () => navigateTo("ReservationCreate") }}
              />
            ) : (
              <CocoaTable columns={arrivalsTableColumns} rows={arrivals} rowKey="reservationId" caption="Llegadas de hoy" />
            )
          ) : null}

          {activeTab === "departures" ? (
            departures.length === 0 ? (
              <CocoaState kind="empty" title="No hay salidas previstas para hoy" message="Cuando los huéspedes tengan fecha de salida hoy aparecerán aquí para gestionar el check-out." />
            ) : (
              <CocoaTable columns={departuresTableColumns} rows={departures} rowKey="reservationId" caption="Salidas de hoy" />
            )
          ) : null}

          {activeTab === "inhouse" ? (
            inHouse.length === 0 ? (
              <CocoaState kind="empty" title="No hay estancias activas ahora mismo" message="Cuando haya huéspedes alojados en el hotel aparecerán aquí." />
            ) : (
              <CocoaTable columns={inHouseTableColumns} rows={inHouse} rowKey="reservationId" caption="Huéspedes alojados" />
            )
          ) : null}

          {activeTab === "unassigned" ? (
            unassigned.length === 0 ? (
              <CocoaState kind="empty" inline title="Todas las llegadas tienen habitación asignada." />
            ) : (
              <CocoaTable columns={unassignedTableColumns} rows={unassigned} rowKey="reservationId" caption="Llegadas sin habitación asignada" />
            )
          ) : null}
        </div>
      </CocoaSection>

      {/* Drawers in-place — abren slide-over sin perder contexto del dashboard. */}
      {checkInTarget ? (
        <QuickCheckInDrawer
          reservationId={checkInTarget}
          onClose={() => setCheckInTarget(null)}
          onCompleted={({ elapsedSeconds }) => {
            notify("ok", `Check-in completado en ${elapsedText(elapsedSeconds)}`);
            refresh();
          }}
        />
      ) : null}
      {checkOutTarget ? (
        <QuickCheckOutDrawer
          reservationId={checkOutTarget}
          onClose={() => setCheckOutTarget(null)}
          onCompleted={({ elapsedSeconds }) => {
            notify("ok", `Check-out completado en ${elapsedText(elapsedSeconds)}`);
            refresh();
          }}
        />
      ) : null}
    </CocoaPage>
  );
}
