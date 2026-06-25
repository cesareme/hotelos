import { useState, type CSSProperties } from "react";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { exportToCsv, type CsvColumn } from "../../lib/csv";
import { EmptyState } from "../../components/States";
import { FrontDeskActionQueue } from "./FrontDeskActionQueue";
import { QuickCheckInDrawer } from "./QuickCheckInDrawer";
import { QuickCheckOutDrawer } from "./QuickCheckOutDrawer";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaTable, type CocoaTableColumn } from "../../components/cocoa/CocoaTable";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { FRONTDESK_COCKPIT_INSTRUCTIONS } from "../../content/screen-instructions/frontdesk-cockpit";

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

type StatusKind = "ok" | "warn" | "error" | "info";

const RESERVATION_STATUS_LABELS: Record<string, string> = {
  draft: "Borrador",
  confirmed: "Confirmada",
  checked_in: "Alojado",
  checked_out: "Salida realizada",
  cancelled: "Cancelada",
  no_show: "No-show"
};

const RESERVATION_STATUS_KIND: Record<string, StatusKind> = {
  draft: "info",
  confirmed: "info",
  checked_in: "ok",
  checked_out: "ok",
  cancelled: "error",
  no_show: "error"
};

function fmtNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("es-ES", { useGrouping: true }).format(value);
}

function fmtEur(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0,00 €";
  return new Intl.NumberFormat("es-ES", {
    useGrouping: true,
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", timeZone: "UTC" });
}

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 6 && h < 13) return "Buenos días";
  if (h >= 13 && h < 20) return "Buenas tardes";
  return "Buenas noches";
}

function todayLabel(): string {
  const label = new Date().toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Status pill (Cocoa-styled badge). CocoaBadge no existe aún en el sistema,
// por eso usamos un span con tokens `--cocoa-*` para conservar la apariencia
// de pill semántica (success / warning / danger / info).
const STATUS_COLOR_BY_KIND: Record<StatusKind, { bg: string; fg: string }> = {
  ok: { bg: "rgba(40, 167, 69, 0.12)", fg: "var(--cocoa-success)" },
  warn: { bg: "rgba(255, 149, 0, 0.14)", fg: "var(--cocoa-warning)" },
  error: { bg: "rgba(255, 59, 48, 0.14)", fg: "var(--cocoa-danger)" },
  info: { bg: "rgba(0, 100, 225, 0.10)", fg: "var(--cocoa-accent)" }
};

function pill(kind: StatusKind, label: string) {
  const colors = STATUS_COLOR_BY_KIND[kind];
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: 600,
    letterSpacing: "var(--cocoa-tracking-wide)",
    textTransform: "uppercase",
    borderRadius: "var(--cocoa-radius-full)",
    background: colors.bg,
    color: colors.fg,
    lineHeight: 1.4
  };
  return <span style={style}>{label}</span>;
}

function statusPill(status: string) {
  const kind = RESERVATION_STATUS_KIND[status] ?? "info";
  const label = RESERVATION_STATUS_LABELS[status] ?? status;
  return pill(kind, label);
}

function balancePill(value: number) {
  if (!Number.isFinite(value) || value === 0) return pill("ok", "saldado");
  if (value > 0) return pill("warn", "pendiente");
  return pill("info", "a favor");
}

function navigateTo(screen: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
  }
}

function openSearch() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("hotelos-open-search"));
  }
}

// Bienvenida de primera ejecución — se muestra cuando aún no hay ninguna
// reserva en el sistema. Los chips guían al recepcionista hacia los cuatro
// pasos mínimos para empezar a operar el hotel.
type FirstRunStep = { label: string; screen: string };

const FIRST_RUN_STEPS: FirstRunStep[] = [
  { label: "1. Crear habitaciones", screen: "RoomInventoryManager" },
  { label: "2. Tipos de habitación", screen: "RoomTypeManager" },
  { label: "3. Plan tarifario", screen: "RevenueSettings" },
  { label: "4. Primera reserva", screen: "ReservationCreate" }
];

function FirstRunWelcomeCard() {
  return (
    <CocoaCard variant="elevated" padding="lg">
      <div
        style={{
          borderLeft: "4px solid var(--cocoa-accent)",
          paddingLeft: "var(--cocoa-space-4)"
        }}
      >
        <div
          style={{
            color: "var(--cocoa-label-tertiary)",
            fontSize: "var(--cocoa-fs-caption)",
            fontWeight: 600,
            letterSpacing: "var(--cocoa-tracking-wide)",
            textTransform: "uppercase"
          }}
        >
          Bienvenido a Anfitorio
        </div>
        <h2
          style={{
            color: "var(--cocoa-label)",
            fontSize: "var(--cocoa-fs-large-title)",
            fontWeight: 700,
            margin: 0,
            marginTop: "var(--cocoa-space-2)"
          }}
        >
          Configura tu hotel en 4 pasos
        </h2>
        <p
          style={{
            color: "var(--cocoa-label-secondary)",
            fontSize: "var(--cocoa-fs-body)",
            margin: 0,
            marginTop: "var(--cocoa-space-2)",
            marginBottom: "var(--cocoa-space-4)"
          }}
        >
          Empieza por dar de alta tu inventario y crea la primera reserva. Estos
          cuatro pasos cubren lo mínimo para que recepción pueda operar.
        </p>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--cocoa-space-2)"
          }}
        >
          {FIRST_RUN_STEPS.map((step) => (
            <CocoaButton
              key={step.screen}
              variant="bordered"
              tone="neutral"
              size="regular"
              onClick={() => navigateTo(step.screen)}
              aria-label={`Ir a ${step.label}`}
            >
              {step.label}
            </CocoaButton>
          ))}
        </div>
      </div>
    </CocoaCard>
  );
}

type FrontDeskTab = "arrivals" | "departures" | "inhouse" | "unassigned";

// Styles for KPI cards' inner content (used inside CocoaCard wrappers).
const kpiHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--cocoa-space-2)"
};

const kpiLabelStyle: CSSProperties = {
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-subheadline)",
  fontWeight: 600,
  letterSpacing: "var(--cocoa-tracking-wide)",
  textTransform: "uppercase"
};

const kpiValueStyle: CSSProperties = {
  color: "var(--cocoa-label)",
  fontSize: "var(--cocoa-fs-large-title)",
  fontWeight: 700,
  marginTop: "var(--cocoa-space-2)",
  lineHeight: 1.1
};

const kpiGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: "var(--cocoa-space-3)"
};

const mutedTextStyle: CSSProperties = {
  color: "var(--cocoa-label-secondary)"
};

export function FrontDeskDashboard() {
  const { data, loading, error, refresh } = useApiData<FrontDeskDashboardData>(
    `/dashboards/front-desk?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 30000 }
  );

  // Drawers in-place — abren el flujo de check-in/check-out de 90/60 s sin
  // perder el contexto del dashboard. Solo conservamos el reservationId porque
  // los drawers cargan la reserva completa desde la API.
  const [checkInTarget, setCheckInTarget] = useState<string | null>(null);
  const [checkOutTarget, setCheckOutTarget] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);
  // DEV #5 layout declutter — tabs y toggle "riesgos" para reducir scroll.
  // Mantenemos las 4 tablas pero solo una visible a la vez; los 3 KPIs
  // secundarios (sin habitación / salidas con retraso / saldo pendiente)
  // están detrás de un toggle "Riesgos" para limpiar la cabecera.
  const [activeTab, setActiveTab] = useState<FrontDeskTab>("arrivals");
  const [showRiskKpis, setShowRiskKpis] = useState(false);

  function showToast(kind: "ok" | "warn" | "error", text: string) {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 5000);
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

  function handleExport<T extends object>(
    rows: readonly T[],
    columns: CsvColumn<T>[],
    filename: string,
    label: string
  ) {
    if (rows.length === 0) {
      showToast("warn", `${label}: no hay datos para exportar`);
      return;
    }
    exportToCsv(rows, `${filename}-${todayStamp}`, columns);
    showToast("ok", `${label} exportadas (${rows.length})`);
  }

  const unassignedKind: StatusKind = kpis.unassignedRooms > 0 ? "warn" : "ok";
  const overdueKind: StatusKind = kpis.overdueDepartures > 0 ? "error" : "ok";
  const balanceKind: StatusKind = kpis.pendingBalanceEur > 0 ? "warn" : "ok";
  const propertyName = getActiveProperty().propertyName;

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
  const summaryParts = [
    `${fmtNumber(kpis.arrivalsToday)} ${kpis.arrivalsToday === 1 ? "llegada" : "llegadas"}`,
    `${fmtNumber(kpis.departuresToday)} ${kpis.departuresToday === 1 ? "salida" : "salidas"}`
  ];
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
        <>
          <strong>{row.guestName}</strong>
          {row.specialRequests ? (
            <div
              style={{
                color: "var(--cocoa-label-secondary)",
                fontSize: "var(--cocoa-fs-caption)",
                marginTop: 2
              }}
            >
              {row.specialRequests}
            </div>
          ) : null}
        </>
      )
    },
    {
      key: "roomNumber",
      label: "Habitación",
      render: (row) =>
        row.roomNumber ? (
          <strong>{row.roomNumber}</strong>
        ) : (
          <span style={mutedTextStyle}>sin asignar</span>
        )
    },
    {
      key: "roomTypeName",
      label: "Tipo",
      render: (row) => row.roomTypeName ?? <span style={mutedTextStyle}>—</span>
    },
    {
      key: "nights",
      label: "Noches",
      render: (row) => fmtNumber(row.nights)
    },
    {
      key: "status",
      label: "Estado",
      render: (row) => statusPill(row.status)
    },
    {
      key: "balance",
      label: "Saldo",
      render: (row) => (
        <>
          <strong>{fmtEur(row.balanceEur)}</strong>
          <div style={{ marginTop: 2 }}>{balancePill(row.balanceEur)}</div>
        </>
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
          <div
            style={{
              display: "flex",
              gap: "var(--cocoa-space-1)",
              flexWrap: "wrap"
            }}
          >
            <span title={checkInTooltip}>
              <CocoaButton
                variant="filled"
                tone="accent"
                size="small"
                disabled={!canCheckIn}
                onClick={() => setCheckInTarget(row.reservationId)}
              >
                Hacer check-in
              </CocoaButton>
            </span>
            <CocoaButton
              variant="plain"
              tone="neutral"
              size="small"
              onClick={() => navigateTo("ReservationDetailWorkspace")}
            >
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
      render: (row) =>
        row.roomNumber ? <strong>{row.roomNumber}</strong> : <span style={mutedTextStyle}>—</span>
    },
    { key: "status", label: "Estado", render: (row) => statusPill(row.status) },
    {
      key: "balance",
      label: "Saldo",
      render: (row) => (
        <>
          <strong>{fmtEur(row.balanceEur)}</strong>
          <div style={{ marginTop: 2 }}>{balancePill(row.balanceEur)}</div>
        </>
      )
    },
    {
      key: "actions",
      label: "Acciones",
      render: (row) => {
        const canCheckOut = row.status === "checked_in";
        const checkOutTooltip = !canCheckOut
          ? row.status === "checked_out"
            ? "Ya hizo el check-out"
            : "El huésped no está alojado"
          : "Check-out disponible";
        return (
          <div
            style={{
              display: "flex",
              gap: "var(--cocoa-space-1)",
              flexWrap: "wrap"
            }}
          >
            <span title={checkOutTooltip}>
              <CocoaButton
                variant="filled"
                tone="accent"
                size="small"
                disabled={!canCheckOut}
                onClick={() => setCheckOutTarget(row.reservationId)}
              >
                Hacer check-out
              </CocoaButton>
            </span>
            <CocoaButton
              variant="plain"
              tone="neutral"
              size="small"
              onClick={() => navigateTo("ReservationDetailWorkspace")}
            >
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
      render: (row) =>
        row.roomNumber ? <strong>{row.roomNumber}</strong> : <span style={mutedTextStyle}>—</span>
    },
    {
      key: "departureDate",
      label: "Sale",
      render: (row) => fmtDay(row.departureDate)
    },
    {
      key: "nightsRemaining",
      label: "Noches restantes",
      render: (row) => fmtNumber(row.nightsRemaining)
    },
    {
      key: "balance",
      label: "Saldo",
      render: (row) => (
        <>
          <strong>{fmtEur(row.balanceEur)}</strong>
          <div style={{ marginTop: 2 }}>{balancePill(row.balanceEur)}</div>
        </>
      )
    },
    {
      key: "actions",
      label: "Acciones",
      render: () => (
        <CocoaButton
          variant="plain"
          tone="neutral"
          size="small"
          onClick={() => navigateTo("ReservationDetailWorkspace")}
        >
          Ver folio
        </CocoaButton>
      )
    }
  ];

  const unassignedTableColumns: CocoaTableColumn<UnassignedRow>[] = [
    { key: "guestName", label: "Huésped", render: (row) => <strong>{row.guestName}</strong> },
    { key: "arrivalDate", label: "Llegada", render: (row) => fmtDay(row.arrivalDate) },
    {
      key: "roomTypeName",
      label: "Tipo",
      render: (row) => row.roomTypeName ?? <span style={mutedTextStyle}>—</span>
    },
    {
      key: "preferences",
      label: "Preferencias",
      render: (row) =>
        row.preferences ? row.preferences : <span style={mutedTextStyle}>—</span>
    },
    {
      key: "actions",
      label: "Acciones",
      render: (row) => (
        <span title="Abrir la reserva para asignar habitación">
          <CocoaButton
            variant="filled"
            tone="accent"
            size="small"
            onClick={() => navigateTo("ReservationDetailWorkspace")}
          >
            Asignar habitación
          </CocoaButton>
        </span>
      )
    }
  ];

  const pageActions = (
    <>
      {loading ? pill("info", "cargando") : null}
      {error ? pill("error", error) : null}
      <CocoaButton variant="plain" tone="neutral" onClick={refresh}>
        ↻ Actualizar
      </CocoaButton>
      <CocoaButton variant="plain" tone="neutral" onClick={openSearch}>
        Buscar (⌘K)
      </CocoaButton>
      <CocoaButton
        variant="plain"
        tone="neutral"
        onClick={() => navigateTo("LiveTimelineWorkspace")}
      >
        Live Timeline
      </CocoaButton>
      <CocoaButton
        variant="filled"
        tone="accent"
        onClick={() => navigateTo("ReservationCreate")}
      >
        Crear reserva
      </CocoaButton>
    </>
  );

  return (
    <>
      <CocoaPageHeader
        eyebrow={`Operations · Recepción · ${todayLabel()}`}
        title="Front Desk"
        subtitle={subtitle}
        actions={pageActions}
      />

      <CocoaScreenInstructionsCard {...FRONTDESK_COCKPIT_INSTRUCTIONS} dismissible persistKey="frontdesk-cockpit" />

      {/* Clean-slate — bienvenida de primera ejecución cuando aún no hay reservas. */}
      {isCleanSlate ? <FirstRunWelcomeCard /> : null}

      {/* Cola de acciones priorizada — la vista que dice qué hacer ahora. */}
      <FrontDeskActionQueue />

      <div style={kpiGridStyle}>
        <CocoaCard variant="elevated" padding="md">
          <div style={kpiHeadStyle}>
            <span style={kpiLabelStyle}>Llegadas hoy</span>
            {pill("info", "hoy")}
          </div>
          <div style={kpiValueStyle}>{fmtNumber(kpis.arrivalsToday)}</div>
        </CocoaCard>
        <CocoaCard variant="elevated" padding="md">
          <div style={kpiHeadStyle}>
            <span style={kpiLabelStyle}>Salidas hoy</span>
            {pill("info", "hoy")}
          </div>
          <div style={kpiValueStyle}>{fmtNumber(kpis.departuresToday)}</div>
        </CocoaCard>
        <CocoaCard variant="elevated" padding="md">
          <div style={kpiHeadStyle}>
            <span style={kpiLabelStyle}>En el hotel</span>
            {pill("ok", "ocupadas")}
          </div>
          <div style={kpiValueStyle}>{fmtNumber(kpis.inHouseNow)}</div>
        </CocoaCard>
      </div>

      {/* DEV #5 — bloque "Riesgos" colapsable: los 3 KPIs operativos
          (sin habitación, retrasos, saldo) se muestran bajo demanda. */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginTop: "calc(var(--cocoa-space-1) * -1)"
        }}
      >
        <CocoaButton
          variant="plain"
          tone="neutral"
          size="small"
          onClick={() => setShowRiskKpis((v) => !v)}
          aria-label={showRiskKpis ? "Ocultar KPIs de riesgo" : "Mostrar KPIs de riesgo"}
        >
          {showRiskKpis ? "▾ Ocultar riesgos" : "▸ Mostrar riesgos"}
          {!showRiskKpis &&
          (kpis.unassignedRooms + kpis.overdueDepartures > 0 || kpis.pendingBalanceEur > 0) ? (
            <span
              style={{
                marginLeft: "var(--cocoa-space-2)",
                padding: "2px 6px",
                borderRadius: "var(--cocoa-radius-full)",
                background: "rgba(255, 149, 0, 0.14)",
                color: "var(--cocoa-warning)",
                fontSize: "var(--cocoa-fs-caption)",
                fontWeight: 600
              }}
            >
              {kpis.unassignedRooms + kpis.overdueDepartures} alertas
            </span>
          ) : null}
        </CocoaButton>
      </div>

      {showRiskKpis ? (
        <div style={kpiGridStyle}>
          <CocoaCard variant="elevated" padding="md">
            <div style={kpiHeadStyle}>
              <span style={kpiLabelStyle}>Sin habitación</span>
              {pill(unassignedKind, unassignedKind === "ok" ? "al día" : "pendiente")}
            </div>
            <div style={kpiValueStyle}>{fmtNumber(kpis.unassignedRooms)}</div>
          </CocoaCard>
          <CocoaCard variant="elevated" padding="md">
            <div style={kpiHeadStyle}>
              <span style={kpiLabelStyle}>Salidas con retraso</span>
              {pill(overdueKind, overdueKind === "ok" ? "a tiempo" : "con retraso")}
            </div>
            <div style={kpiValueStyle}>{fmtNumber(kpis.overdueDepartures)}</div>
          </CocoaCard>
          <CocoaCard variant="elevated" padding="md">
            <div style={kpiHeadStyle}>
              <span style={kpiLabelStyle}>Saldo pendiente</span>
              {pill(balanceKind, balanceKind === "ok" ? "saldado" : "por cobrar")}
            </div>
            <div style={kpiValueStyle}>{fmtEur(kpis.pendingBalanceEur)}</div>
          </CocoaCard>
        </div>
      ) : null}

      {/* DEV #5 — las 4 tablas pasan a tabs internos en una sola CocoaCard.
          Solo una tabla visible a la vez → recorta ~60% el scroll. */}
      <CocoaCard variant="elevated" padding="md">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "var(--cocoa-space-3)",
            marginBottom: "var(--cocoa-space-3)"
          }}
        >
          <div
            role="tablist"
            aria-label="Vista de recepción"
            style={{ display: "flex", flexWrap: "wrap", gap: "var(--cocoa-space-1)" }}
          >
            {(
              [
                { id: "arrivals", label: "Llegadas", count: arrivals.length },
                { id: "departures", label: "Salidas", count: departures.length },
                { id: "inhouse", label: "En el hotel", count: inHouse.length },
                { id: "unassigned", label: "Sin habitación", count: unassigned.length }
              ] as Array<{ id: FrontDeskTab; label: string; count: number }>
            ).map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <CocoaButton
                  key={tab.id}
                  variant={isActive ? "filled" : "plain"}
                  tone={isActive ? "accent" : "neutral"}
                  size="small"
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label} ({fmtNumber(tab.count)})
                </CocoaButton>
              );
            })}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--cocoa-space-2)"
            }}
          >
            {activeTab === "arrivals" ? (
              <CocoaButton
                variant="plain"
                tone="neutral"
                size="small"
                onClick={() => handleExport(arrivals, arrivalsColumns, "llegadas", "Llegadas")}
                aria-label="Descargar la tabla en formato CSV"
              >
                Exportar CSV
              </CocoaButton>
            ) : null}
            {activeTab === "departures" ? (
              <CocoaButton
                variant="plain"
                tone="neutral"
                size="small"
                onClick={() => handleExport(departures, departuresColumns, "salidas", "Salidas")}
                aria-label="Descargar la tabla en formato CSV"
              >
                Exportar CSV
              </CocoaButton>
            ) : null}
            {activeTab === "inhouse" ? (
              <CocoaButton
                variant="plain"
                tone="neutral"
                size="small"
                onClick={() => handleExport(inHouse, inHouseColumns, "en-el-hotel", "Estancias")}
                aria-label="Descargar la tabla en formato CSV"
              >
                Exportar CSV
              </CocoaButton>
            ) : null}
            {activeTab === "unassigned" ? (
              <CocoaButton
                variant="plain"
                tone="neutral"
                size="small"
                onClick={() =>
                  handleExport(unassigned, unassignedColumns, "sin-habitacion", "Sin habitación")
                }
                aria-label="Descargar la tabla en formato CSV"
              >
                Exportar CSV
              </CocoaButton>
            ) : null}
          </div>
        </div>

        {activeTab === "arrivals" ? (
          arrivals.length === 0 ? (
            <EmptyState
              title="No hay llegadas previstas para hoy"
              message="Cuando se confirmen reservas con entrada hoy aparecerán aquí, listas para asignar habitación y hacer check-in."
            />
          ) : (
            <CocoaTable
              columns={arrivalsTableColumns}
              rows={arrivals}
              rowKey="reservationId"
            />
          )
        ) : null}

        {activeTab === "departures" ? (
          departures.length === 0 ? (
            <EmptyState
              title="No hay salidas previstas para hoy"
              message="Cuando los huéspedes tengan fecha de salida hoy aparecerán aquí para gestionar el check-out."
            />
          ) : (
            <CocoaTable
              columns={departuresTableColumns}
              rows={departures}
              rowKey="reservationId"
            />
          )
        ) : null}

        {activeTab === "inhouse" ? (
          inHouse.length === 0 ? (
            <EmptyState
              title="No hay estancias activas ahora mismo"
              message="Cuando haya huéspedes alojados en el hotel aparecerán aquí."
            />
          ) : (
            <CocoaTable
              columns={inHouseTableColumns}
              rows={inHouse}
              rowKey="reservationId"
            />
          )
        ) : null}

        {activeTab === "unassigned" ? (
          unassigned.length === 0 ? (
            <p style={mutedTextStyle}>Todas las llegadas tienen habitación asignada.</p>
          ) : (
            <CocoaTable
              columns={unassignedTableColumns}
              rows={unassigned}
              rowKey="reservationId"
            />
          )
        ) : null}
      </CocoaCard>

      {/* Drawers in-place — abren slide-over sin perder contexto del dashboard. */}
      {checkInTarget ? (
        <QuickCheckInDrawer
          reservationId={checkInTarget}
          onClose={() => setCheckInTarget(null)}
          onCompleted={({ elapsedSeconds }) => {
            showToast(
              "ok",
              `Check-in completado en ${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`
            );
            refresh();
          }}
        />
      ) : null}
      {checkOutTarget ? (
        <QuickCheckOutDrawer
          reservationId={checkOutTarget}
          onClose={() => setCheckOutTarget(null)}
          onCompleted={({ elapsedSeconds }) => {
            showToast(
              "ok",
              `Check-out completado en ${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`
            );
            refresh();
          }}
        />
      ) : null}

      {toast ? (
        <div
          style={{
            position: "fixed",
            bottom: "var(--cocoa-space-4)",
            right: "var(--cocoa-space-4)",
            zIndex: 70
          }}
        >
          {pill(toast.kind, toast.text)}
        </div>
      ) : null}
    </>
  );
}
