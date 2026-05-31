// CocoaGalleryScreen — Demo gallery showing every Cocoa component in one place.
//
// Each section is wrapped in a CocoaCard so the page reads as a catalog. All
// component imports use React.lazy so the screen still mounts even if a
// component file is missing (workflow parallel creates them). When a lazy
// chunk fails to resolve, we show a small placeholder note instead of crashing
// the whole gallery.

import {
  Component,
  Suspense,
  lazy,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";

// -----------------------------------------------------------------------------
// Lazy imports
// -----------------------------------------------------------------------------
//
// Each component is wrapped in a tiny error boundary so a missing module turns
// into "Componente no disponible" rather than blowing up the whole gallery.

const CocoaCard = lazy(() =>
  import("../../components/cocoa/CocoaCard").then((m) => ({
    default: m.CocoaCard
  }))
);

const CocoaButton = lazy(() =>
  import("../../components/cocoa/CocoaButton").then((m) => ({
    default: m.CocoaButton
  }))
);

const CocoaInput = lazy(() =>
  import("../../components/cocoa/CocoaInput").then((m) => ({
    default: m.CocoaInput
  }))
);

const CocoaSelect = lazy(() =>
  import("../../components/cocoa/CocoaSelect").then((m) => ({
    default: m.CocoaSelect
  }))
);

const CocoaSearchInput = lazy(() =>
  import("../../components/cocoa/CocoaSearchInput").then((m) => ({
    default: m.CocoaSearchInput
  }))
);

const CocoaStepper = lazy(() =>
  import("../../components/cocoa/CocoaStepper").then((m) => ({
    default: m.CocoaStepper
  }))
);

const CocoaDatePicker = lazy(() =>
  import("../../components/cocoa/CocoaDatePicker").then((m) => ({
    default: m.CocoaDatePicker
  }))
);

const CocoaSwitch = lazy(() =>
  import("../../components/cocoa/CocoaSwitch").then((m) => ({
    default: m.CocoaSwitch
  }))
);

const CocoaSegmentedControl = lazy(() =>
  import("../../components/cocoa/CocoaSegmentedControl").then((m) => ({
    default: m.CocoaSegmentedControl
  }))
);

const CocoaTable = lazy(() =>
  import("../../components/cocoa/CocoaTable").then((m) => ({
    default: m.CocoaTable as React.ComponentType<CocoaTableProps<DemoRow>>
  }))
);

const CocoaPopover = lazy(() =>
  import("../../components/cocoa/CocoaPopover").then((m) => ({
    default: m.CocoaPopover
  }))
);

const CocoaSheet = lazy(() =>
  import("../../components/cocoa/CocoaSheet").then((m) => ({
    default: m.CocoaSheet
  }))
);

// -----------------------------------------------------------------------------
// Shared types for the table component (loose mirror of its real props so the
// lazy cast type-checks even if the source file shape drifts slightly).
// -----------------------------------------------------------------------------

interface CocoaTableColumn<Row> {
  key: string;
  label: string;
  sortable?: boolean;
  align?: "left" | "right" | "center";
  width?: string;
  render?: (row: Row) => ReactNode;
}

interface CocoaTableSort {
  key: string;
  direction: "asc" | "desc";
}

interface CocoaTableProps<Row> {
  columns: CocoaTableColumn<Row>[];
  rows: Row[];
  sortBy?: CocoaTableSort;
  onSort?: (sort: CocoaTableSort) => void;
  rowKey?: string | ((row: Row) => string);
  selectedKey?: string;
  onSelect?: (row: Row) => void;
  emptyState?: ReactNode;
  loading?: boolean;
}

// -----------------------------------------------------------------------------
// Tiny error boundary so a missing chunk doesn't take down the page.
// -----------------------------------------------------------------------------

interface BoundaryProps {
  label: string;
  children: ReactNode;
}

interface BoundaryState {
  failed: boolean;
}

class ComponentBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    // Keep the gallery quiet — log to the console for debugging only.
    // eslint-disable-next-line no-console
    console.warn(`[CocoaGallery] ${this.props.label} no disponible`, error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div
          style={{
            padding: "12px 16px",
            border: "1px dashed var(--cocoa-separator)",
            borderRadius: "var(--cocoa-radius-md)",
            color: "var(--cocoa-label-secondary)",
            fontFamily: "var(--cocoa-font)",
            fontSize: "var(--cocoa-fs-callout)"
          }}
        >
          {this.props.label} aun no esta disponible.
        </div>
      );
    }
    return this.props.children;
  }
}

function Lazy({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ComponentBoundary label={label}>
      <Suspense fallback={<div>Cargando componente...</div>}>
        {children}
      </Suspense>
    </ComponentBoundary>
  );
}

// -----------------------------------------------------------------------------
// Section helper — title + body. We render it manually so we don't have to
// suspend the section title alongside its body.
// -----------------------------------------------------------------------------

function Section({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Lazy label={title}>
      <CocoaCard variant="bordered" padding="lg">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <h2
              style={{
                margin: 0,
                fontFamily: "var(--cocoa-font)",
                fontSize: "var(--cocoa-fs-title-2)",
                fontWeight:
                  "var(--cocoa-fw-semibold)" as unknown as CSSProperties["fontWeight"],
                color: "var(--cocoa-label)"
              }}
            >
              {title}
            </h2>
            {description !== undefined ? (
              <p
                style={{
                  margin: 0,
                  fontFamily: "var(--cocoa-font)",
                  fontSize: "var(--cocoa-fs-subheadline)",
                  color: "var(--cocoa-label-secondary)"
                }}
              >
                {description}
              </p>
            ) : null}
          </div>
          {children}
        </div>
      </CocoaCard>
    </Lazy>
  );
}

// -----------------------------------------------------------------------------
// Tokens for button variants/sizes/tones — used to fan out the grid.
// -----------------------------------------------------------------------------

const BUTTON_VARIANTS = ["filled", "tinted", "bordered", "plain"] as const;
const BUTTON_SIZES = ["small", "regular", "large"] as const;
const BUTTON_TONES = ["accent", "neutral", "destructive"] as const;

type ButtonVariant = (typeof BUTTON_VARIANTS)[number];
type ButtonSize = (typeof BUTTON_SIZES)[number];
type ButtonTone = (typeof BUTTON_TONES)[number];

const LABEL_STYLE: CSSProperties = {
  display: "block",
  marginBottom: 6,
  fontFamily: "var(--cocoa-font)",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as CSSProperties["fontWeight"],
  letterSpacing: "var(--cocoa-tracking-wide)",
  textTransform: "uppercase",
  color: "var(--cocoa-label-secondary)"
};

function FieldLabel({ children }: { children: ReactNode }) {
  return <span style={LABEL_STYLE}>{children}</span>;
}

// -----------------------------------------------------------------------------
// Demo data for the table.
// -----------------------------------------------------------------------------

interface DemoRow {
  id: string;
  guest: string;
  room: string;
  checkIn: string;
  status: string;
  total: number;
}

const DEMO_ROWS: DemoRow[] = [
  {
    id: "R-1001",
    guest: "Adriana Lopez",
    room: "204",
    checkIn: "2026-06-01",
    status: "Confirmada",
    total: 412
  },
  {
    id: "R-1002",
    guest: "Mateo Diaz",
    room: "107",
    checkIn: "2026-06-02",
    status: "Pendiente",
    total: 280
  },
  {
    id: "R-1003",
    guest: "Sofia Romero",
    room: "311",
    checkIn: "2026-06-03",
    status: "Confirmada",
    total: 540
  },
  {
    id: "R-1004",
    guest: "Bruno Castillo",
    room: "118",
    checkIn: "2026-06-04",
    status: "Cancelada",
    total: 0
  },
  {
    id: "R-1005",
    guest: "Camila Morales",
    room: "402",
    checkIn: "2026-06-05",
    status: "Confirmada",
    total: 720
  },
  {
    id: "R-1006",
    guest: "Diego Salazar",
    room: "215",
    checkIn: "2026-06-06",
    status: "Pendiente",
    total: 360
  },
  {
    id: "R-1007",
    guest: "Elena Vargas",
    room: "509",
    checkIn: "2026-06-07",
    status: "Confirmada",
    total: 980
  },
  {
    id: "R-1008",
    guest: "Felipe Navarro",
    room: "120",
    checkIn: "2026-06-08",
    status: "Confirmada",
    total: 305
  }
];

const TABLE_COLUMNS: CocoaTableColumn<DemoRow>[] = [
  { key: "id", label: "Reserva", sortable: true, width: "120px" },
  { key: "guest", label: "Huesped", sortable: true },
  { key: "room", label: "Habitacion", align: "center", width: "120px" },
  { key: "checkIn", label: "Check-in", sortable: true, width: "140px" },
  { key: "status", label: "Estado", width: "140px" },
  {
    key: "total",
    label: "Total",
    align: "right",
    width: "100px",
    render: (row) => `$${row.total.toFixed(2)}`
  }
];

// -----------------------------------------------------------------------------
// Screen
// -----------------------------------------------------------------------------

export function CocoaGalleryScreen() {
  // Inputs
  const [inputValue, setInputValue] = useState("Hola mundo");
  const [selectValue, setSelectValue] = useState("usd");
  const [searchValue, setSearchValue] = useState("");
  const [stepperValue, setStepperValue] = useState(2);
  const [dateValue, setDateValue] = useState("2026-06-01");
  const [switchValue, setSwitchValue] = useState(true);

  // Segmented control
  const [segmentValue, setSegmentValue] = useState("dia");

  // Table
  const [tableSort, setTableSort] = useState<CocoaTableSort | undefined>({
    key: "checkIn",
    direction: "asc"
  });
  const [selectedRow, setSelectedRow] = useState<string | undefined>("R-1003");

  // Popover + sheet triggers
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverAnchorRef = useRef<HTMLSpanElement | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetName, setSheetName] = useState("");
  const [sheetEmail, setSheetEmail] = useState("");

  const pageStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 24,
    padding: 32,
    minHeight: "100vh",
    background: "var(--cocoa-background-window)",
    color: "var(--cocoa-label)",
    fontFamily: "var(--cocoa-font)"
  };

  const headerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 6
  };

  const buttonGridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 16
  };

  const inputsGridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 16
  };

  const popoverContent = (
    <div
      style={{
        minWidth: 220,
        padding: 16,
        background: "var(--cocoa-background-content)",
        border: "1px solid var(--cocoa-separator)",
        borderRadius: "var(--cocoa-radius-lg)",
        boxShadow: "var(--cocoa-shadow-popover, 0 12px 32px rgba(0,0,0,0.18))",
        display: "flex",
        flexDirection: "column",
        gap: 8
      }}
    >
      <strong style={{ fontSize: "var(--cocoa-fs-headline)" }}>
        Detalles rapidos
      </strong>
      <span
        style={{
          fontSize: "var(--cocoa-fs-subheadline)",
          color: "var(--cocoa-label-secondary)"
        }}
      >
        Este popover muestra contenido contextual sin abandonar la pantalla.
      </span>
    </div>
  );

  const sheetFooter = (
    <Lazy label="Sheet actions">
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <CocoaButton
          variant="bordered"
          tone="neutral"
          onClick={() => setSheetOpen(false)}
        >
          Cancelar
        </CocoaButton>
        <CocoaButton
          variant="filled"
          tone="accent"
          onClick={() => setSheetOpen(false)}
        >
          Guardar
        </CocoaButton>
      </div>
    </Lazy>
  );

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <h1
          style={{
            margin: 0,
            fontFamily: "var(--cocoa-font)",
            fontSize: "var(--cocoa-fs-large-title)",
            fontWeight:
              "var(--cocoa-fw-bold)" as unknown as CSSProperties["fontWeight"]
          }}
        >
          Cocoa Gallery
        </h1>
        <p
          style={{
            margin: 0,
            color: "var(--cocoa-label-secondary)",
            fontSize: "var(--cocoa-fs-body)"
          }}
        >
          Catalogo vivo de los componentes Cocoa Edition. Cada seccion carga
          de forma diferida; si un componente aun no existe veras un aviso.
        </p>
      </header>

      {/* 1. Buttons --------------------------------------------------------- */}
      <Section
        title="1. Buttons"
        description="Cuatro variantes x tres tamanos x tres tonos."
      >
        <div style={buttonGridStyle}>
          {BUTTON_VARIANTS.map((variant) =>
            BUTTON_SIZES.map((size) =>
              BUTTON_TONES.map((tone) => (
                <BtnDemo
                  key={`${variant}-${size}-${tone}`}
                  variant={variant}
                  size={size}
                  tone={tone}
                />
              ))
            )
          )}
        </div>
      </Section>

      {/* 2. Inputs ---------------------------------------------------------- */}
      <Section
        title="2. Inputs"
        description="Campos editables con la etiqueta encima."
      >
        <div style={inputsGridStyle}>
          <div>
            <FieldLabel>CocoaInput</FieldLabel>
            <Lazy label="CocoaInput">
              <CocoaInput
                value={inputValue}
                onChange={setInputValue}
                placeholder="Escribe algo..."
              />
            </Lazy>
          </div>
          <div>
            <FieldLabel>CocoaSelect</FieldLabel>
            <Lazy label="CocoaSelect">
              <CocoaSelect
                value={selectValue}
                onChange={setSelectValue}
                options={[
                  { value: "usd", label: "USD - Dolar" },
                  { value: "eur", label: "EUR - Euro" },
                  { value: "mxn", label: "MXN - Peso mexicano" }
                ]}
              />
            </Lazy>
          </div>
          <div>
            <FieldLabel>CocoaSearchInput</FieldLabel>
            <Lazy label="CocoaSearchInput">
              <CocoaSearchInput
                value={searchValue}
                onChange={setSearchValue}
                placeholder="Buscar reservas..."
              />
            </Lazy>
          </div>
          <div>
            <FieldLabel>CocoaStepper</FieldLabel>
            <Lazy label="CocoaStepper">
              <CocoaStepper
                value={stepperValue}
                onChange={setStepperValue}
                min={0}
                max={10}
              />
            </Lazy>
          </div>
          <div>
            <FieldLabel>CocoaDatePicker</FieldLabel>
            <Lazy label="CocoaDatePicker">
              <CocoaDatePicker value={dateValue} onChange={setDateValue} />
            </Lazy>
          </div>
          <div>
            <FieldLabel>CocoaSwitch</FieldLabel>
            <Lazy label="CocoaSwitch">
              <CocoaSwitch
                checked={switchValue}
                onChange={setSwitchValue}
                label="Recordatorios automaticos"
              />
            </Lazy>
          </div>
        </div>
      </Section>

      {/* 3. SegmentedControl ----------------------------------------------- */}
      <Section
        title="3. SegmentedControl"
        description="Selector de vista con cuatro opciones."
      >
        <Lazy label="CocoaSegmentedControl">
          <CocoaSegmentedControl
            value={segmentValue}
            onChange={setSegmentValue}
            options={[
              { value: "dia", label: "Dia" },
              { value: "semana", label: "Semana" },
              { value: "mes", label: "Mes" },
              { value: "anio", label: "Ano" }
            ]}
          />
        </Lazy>
      </Section>

      {/* 4. Tables --------------------------------------------------------- */}
      <Section
        title="4. Tables"
        description="CocoaTable con orden y seleccion."
      >
        <Lazy label="CocoaTable">
          <CocoaTable
            columns={TABLE_COLUMNS}
            rows={DEMO_ROWS}
            sortBy={tableSort}
            onSort={setTableSort}
            rowKey="id"
            selectedKey={selectedRow}
            onSelect={(row) => setSelectedRow(row.id)}
          />
        </Lazy>
      </Section>

      {/* 5. Popovers ------------------------------------------------------- */}
      <Section
        title="5. Popovers"
        description="Boton disparador que abre un popover con contenido demo."
      >
        <div style={{ display: "inline-flex" }}>
          <span ref={popoverAnchorRef} style={{ display: "inline-flex" }}>
            <Lazy label="Popover trigger">
              <CocoaButton
                variant="tinted"
                tone="accent"
                onClick={() => setPopoverOpen((v) => !v)}
              >
                Mostrar popover
              </CocoaButton>
            </Lazy>
          </span>
        </div>
        <Lazy label="CocoaPopover">
          <CocoaPopover
            open={popoverOpen}
            anchorEl={popoverAnchorRef.current}
            placement="bottom"
            onClose={() => setPopoverOpen(false)}
          >
            {popoverContent}
          </CocoaPopover>
        </Lazy>
      </Section>

      {/* 6. Sheets --------------------------------------------------------- */}
      <Section
        title="6. Sheets"
        description="Boton que abre CocoaSheet con un mini formulario."
      >
        <div style={{ display: "flex", gap: 8 }}>
          <Lazy label="Sheet trigger">
            <CocoaButton
              variant="filled"
              tone="accent"
              onClick={() => setSheetOpen(true)}
            >
              Abrir sheet
            </CocoaButton>
          </Lazy>
        </div>
        <Lazy label="CocoaSheet">
          <CocoaSheet
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            title="Nuevo contacto"
            footer={sheetFooter}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <FieldLabel>Nombre</FieldLabel>
                <Lazy label="Sheet name input">
                  <CocoaInput
                    value={sheetName}
                    onChange={setSheetName}
                    placeholder="Ej. Ana Garcia"
                  />
                </Lazy>
              </div>
              <div>
                <FieldLabel>Email</FieldLabel>
                <Lazy label="Sheet email input">
                  <CocoaInput
                    value={sheetEmail}
                    onChange={setSheetEmail}
                    placeholder="ana@hotel.com"
                    type="email"
                  />
                </Lazy>
              </div>
            </div>
          </CocoaSheet>
        </Lazy>
      </Section>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Single-button demo cell. Pulled out so each instance only re-renders when its
// own props change.
// -----------------------------------------------------------------------------

function BtnDemo({
  variant,
  size,
  tone
}: {
  variant: ButtonVariant;
  size: ButtonSize;
  tone: ButtonTone;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        alignItems: "flex-start"
      }}
    >
      <Lazy label={`Button ${variant}/${size}/${tone}`}>
        <CocoaButton variant={variant} size={size} tone={tone}>
          {`${variant} - ${size}`}
        </CocoaButton>
      </Lazy>
      <span
        style={{
          fontSize: "var(--cocoa-fs-caption)",
          color: "var(--cocoa-label-tertiary)"
        }}
      >
        tono: {tone}
      </span>
    </div>
  );
}

export default CocoaGalleryScreen;
