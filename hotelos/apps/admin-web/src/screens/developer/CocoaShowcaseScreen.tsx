// CocoaShowcaseScreen — developer-only "visual bible" page that exercises
// every Cocoa Edition component we ship.
//
// Layout: a CocoaPageHeader on top, then a stack of CocoaCard sections (one
// per category) — buttons, inputs, selectors, display, overlays, extras,
// globals, icons, typography and colors.
//
// All controls are interactive but self-contained (local state) so the page
// has no external dependencies — drop it on a route and it just works.

import { useRef, useState, type CSSProperties, type ReactNode } from "react";

// cocoa core
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import type {
  CocoaButtonSize,
  CocoaButtonTone,
  CocoaButtonVariant
} from "../../components/cocoa/CocoaButton";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import type { CocoaCardVariant } from "../../components/cocoa/CocoaCard";
import { CocoaInput } from "../../components/cocoa/CocoaInput";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaPopover } from "../../components/cocoa/CocoaPopover";
import { CocoaSearchInput } from "../../components/cocoa/CocoaSearchInput";
import { CocoaSegmentedControl } from "../../components/cocoa/CocoaSegmentedControl";
import { CocoaSelect } from "../../components/cocoa/CocoaSelect";
import { CocoaSheet } from "../../components/cocoa/CocoaSheet";
import { CocoaStepper } from "../../components/cocoa/CocoaStepper";
import { CocoaSwitch } from "../../components/cocoa/CocoaSwitch";
import { CocoaTable } from "../../components/cocoa/CocoaTable";
import type { CocoaTableColumn } from "../../components/cocoa/CocoaTable";
import { CocoaDatePicker } from "../../components/cocoa/CocoaDatePicker";

// cocoa extras
import { CocoaAlert } from "../../components/cocoa-extras/CocoaAlert";
import type { CocoaAlertType } from "../../components/cocoa-extras/CocoaAlert";
import { CocoaColorWell } from "../../components/cocoa-extras/CocoaColorWell";
import { CocoaContextMenu } from "../../components/cocoa-extras/CocoaContextMenu";
import { CocoaFormFieldset } from "../../components/cocoa-extras/CocoaFormFieldset";
import { CocoaToolbarSearchField } from "../../components/cocoa-extras/CocoaToolbarSearchField";

// cocoa global
import { CocoaCommandPalette } from "../../components/cocoa-global/CocoaCommandPalette";
import { CocoaPreferencesSheet } from "../../components/cocoa-global/CocoaPreferencesSheet";
import { CocoaNotificationCenter } from "../../components/cocoa-global/CocoaNotificationCenter";
import type { CocoaNotification } from "../../components/cocoa-global/CocoaNotificationCenter";
import { CocoaKeyboardShortcutsHelp } from "../../components/cocoa-global/CocoaKeyboardShortcutsHelp";
import { CocoaAboutDialog } from "../../components/cocoa-global/CocoaAboutDialog";

// cocoa icons
import {
  BellIcon,
  ChatBubbleIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  EyeIcon,
  HeartIcon,
  InfoCircleIcon,
  LockIcon,
  LockOpenIcon,
  StarIcon,
  XCircleIcon
} from "../../components/cocoa-icons/StatusIcons";

// ---------------------------------------------------------------------------
// shared style helpers
// ---------------------------------------------------------------------------

const pageStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-6)",
  padding: "var(--cocoa-space-6)",
  background: "var(--cocoa-background-window)",
  minHeight: "100vh",
  fontFamily: "var(--cocoa-font)",
  color: "var(--cocoa-label)"
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  marginBottom: "var(--cocoa-space-4)",
  fontFamily: "var(--cocoa-font-display)",
  fontSize: "var(--cocoa-fs-title-1)",
  fontWeight: "var(--cocoa-fw-bold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  color: "var(--cocoa-label)"
};

const sectionSubtitleStyle: CSSProperties = {
  margin: 0,
  marginBottom: "var(--cocoa-space-4)",
  fontSize: "var(--cocoa-fs-callout)",
  color: "var(--cocoa-label-secondary)",
  letterSpacing: "var(--cocoa-tracking-tight)"
};

const labelStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  textTransform: "uppercase",
  letterSpacing: "var(--cocoa-tracking-wide)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  color: "var(--cocoa-label-secondary)",
  marginBottom: "var(--cocoa-space-2)"
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "var(--cocoa-space-3)"
};

const colStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-4)"
};

const subgridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
  gap: "var(--cocoa-space-3)"
};

interface SectionProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

function Section({ title, subtitle, children }: SectionProps) {
  return (
    <CocoaCard variant="elevated" padding="lg">
      <h2 style={sectionTitleStyle}>{title}</h2>
      {subtitle ? <p style={sectionSubtitleStyle}>{subtitle}</p> : null}
      <div style={colStyle}>{children}</div>
    </CocoaCard>
  );
}

interface SubRowProps {
  label: string;
  children: ReactNode;
}

function SubRow({ label, children }: SubRowProps) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div style={rowStyle}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// demo data
// ---------------------------------------------------------------------------

const BUTTON_VARIANTS: ReadonlyArray<CocoaButtonVariant> = [
  "filled",
  "tinted",
  "bordered",
  "plain"
];
const BUTTON_TONES: ReadonlyArray<CocoaButtonTone> = [
  "accent",
  "neutral",
  "destructive"
];
const BUTTON_SIZES: ReadonlyArray<CocoaButtonSize> = [
  "small",
  "regular",
  "large"
];

const CARD_VARIANTS: ReadonlyArray<CocoaCardVariant> = [
  "elevated",
  "bordered",
  "plain"
];

interface DemoRow {
  id: string;
  name: string;
  room: string;
  status: string;
  nights: number;
}

const DEMO_ROWS: DemoRow[] = [
  { id: "r1", name: "Ada Lovelace", room: "201", status: "Check-in", nights: 3 },
  {
    id: "r2",
    name: "Grace Hopper",
    room: "302",
    status: "Confirmada",
    nights: 2
  },
  { id: "r3", name: "Alan Turing", room: "104", status: "Check-out", nights: 1 },
  {
    id: "r4",
    name: "Linus Torvalds",
    room: "405",
    status: "Pendiente",
    nights: 5
  }
];

const DEMO_COLUMNS: CocoaTableColumn<DemoRow>[] = [
  { key: "name", label: "Huésped", sortable: true },
  { key: "room", label: "Habitación", sortable: true, align: "center" },
  { key: "status", label: "Estado", sortable: true },
  { key: "nights", label: "Noches", sortable: true, align: "right" }
];

interface IconEntry {
  name: string;
  Icon: (props: { size?: number }) => ReactNode;
}

const ICON_ENTRIES: IconEntry[] = [
  { name: "CheckCircle", Icon: (p) => <CheckCircleIcon {...p} /> },
  { name: "ExclamationCircle", Icon: (p) => <ExclamationCircleIcon {...p} /> },
  { name: "XCircle", Icon: (p) => <XCircleIcon {...p} /> },
  { name: "InfoCircle", Icon: (p) => <InfoCircleIcon {...p} /> },
  { name: "Clock", Icon: (p) => <ClockIcon {...p} /> },
  { name: "Lock", Icon: (p) => <LockIcon {...p} /> },
  { name: "LockOpen", Icon: (p) => <LockOpenIcon {...p} /> },
  { name: "Star", Icon: (p) => <StarIcon {...p} /> },
  { name: "Heart", Icon: (p) => <HeartIcon {...p} /> },
  { name: "Bell", Icon: (p) => <BellIcon {...p} /> },
  { name: "ChatBubble", Icon: (p) => <ChatBubbleIcon {...p} /> },
  { name: "Eye", Icon: (p) => <EyeIcon {...p} /> }
];

interface TypographyEntry {
  token: string;
  label: string;
  family: "display" | "text";
}

const TYPOGRAPHY_SCALE: TypographyEntry[] = [
  { token: "large-title", label: "Large Title 26", family: "display" },
  { token: "title-1", label: "Title 1 / 22", family: "display" },
  { token: "title-2", label: "Title 2 / 17", family: "display" },
  { token: "title-3", label: "Title 3 / 15", family: "text" },
  { token: "headline", label: "Headline 13", family: "text" },
  { token: "body", label: "Body 13", family: "text" },
  { token: "callout", label: "Callout 12", family: "text" },
  { token: "subheadline", label: "Subheadline 11", family: "text" },
  { token: "footnote", label: "Footnote 11", family: "text" },
  { token: "caption-1", label: "Caption 1 / 10", family: "text" },
  { token: "caption-2", label: "Caption 2 / 10", family: "text" }
];

interface ColorToken {
  token: string;
  label: string;
}

const COLOR_TOKENS: ColorToken[] = [
  { token: "--cocoa-accent", label: "accent" },
  { token: "--cocoa-accent-hover", label: "accent-hover" },
  { token: "--cocoa-accent-pressed", label: "accent-pressed" },
  { token: "--cocoa-success", label: "success" },
  { token: "--cocoa-warning", label: "warning" },
  { token: "--cocoa-danger", label: "error / danger" },
  { token: "--cocoa-info", label: "info" },
  { token: "--cocoa-label", label: "label" },
  { token: "--cocoa-label-secondary", label: "label-secondary" },
  { token: "--cocoa-label-tertiary", label: "label-tertiary" },
  { token: "--cocoa-label-quaternary", label: "label-quaternary" },
  { token: "--cocoa-background-window", label: "background-window" },
  { token: "--cocoa-background-content", label: "background-content" },
  { token: "--cocoa-background-sidebar", label: "background-sidebar" },
  { token: "--cocoa-background-control", label: "background-control" },
  { token: "--cocoa-background-selection", label: "background-selection" },
  { token: "--cocoa-separator", label: "separator" },
  { token: "--cocoa-separator-opaque", label: "separator-opaque" },
  { token: "--cocoa-focus-ring", label: "focus-ring" },
  { token: "--cocoa-find-highlight", label: "find-highlight" }
];

// ---------------------------------------------------------------------------
// main screen
// ---------------------------------------------------------------------------

export function CocoaShowcaseScreen() {
  // -- form state (inputs, selectors)
  const [textValue, setTextValue] = useState("Aurora Cocoa");
  const [emailValue, setEmailValue] = useState("dev@hotelos.app");
  const [numberValue, setNumberValue] = useState("42");
  const [passwordValue, setPasswordValue] = useState("");
  const [areaValue, setAreaValue] = useState("Edición visual completa.");
  const [searchValue, setSearchValue] = useState("");
  const [toolbarSearch, setToolbarSearch] = useState("");

  const [selectValue, setSelectValue] = useState("standard");
  const [segmented, setSegmented] = useState("list");
  const [switchValue, setSwitchValue] = useState(true);
  const [stepperValue, setStepperValue] = useState(3);
  const [dateValue, setDateValue] = useState("2026-05-30");

  // -- display
  const [tableSelected, setTableSelected] = useState<string | undefined>("r1");

  // -- overlays
  const popoverAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [alertOpen, setAlertOpen] = useState<CocoaAlertType | null>(null);

  // -- extras
  const [colorValue, setColorValue] = useState("#0064E1");

  // -- globals
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  const demoNotifications: CocoaNotification[] = [
    {
      id: "n1",
      title: "Nueva reserva",
      message: "Ada Lovelace, habitación 201.",
      type: "info",
      timestamp: new Date().toISOString()
    },
    {
      id: "n2",
      title: "Check-in completado",
      message: "Grace Hopper, habitación 302.",
      type: "success",
      timestamp: new Date(Date.now() - 86_400_000).toISOString(),
      read: true
    },
    {
      id: "n3",
      title: "Pago rechazado",
      message: "Revisar reserva 405.",
      type: "warning",
      timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString()
    }
  ];

  // ------------------------------------------------------------------ buttons
  const buttonsMatrix = (
    <div style={colStyle}>
      {BUTTON_SIZES.map((size) => (
        <SubRow key={size} label={`Size: ${size}`}>
          {BUTTON_VARIANTS.flatMap((variant) =>
            BUTTON_TONES.map((tone) => (
              <CocoaButton
                key={`${size}-${variant}-${tone}`}
                size={size}
                variant={variant}
                tone={tone}
              >
                {`${variant} · ${tone}`}
              </CocoaButton>
            ))
          )}
        </SubRow>
      ))}
      <SubRow label="States">
        <CocoaButton>Default</CocoaButton>
        <CocoaButton disabled>Disabled</CocoaButton>
        <CocoaButton loading>Loading…</CocoaButton>
        <CocoaButton icon={<StarIcon />}>With icon</CocoaButton>
        <CocoaButton icon={<HeartIcon />} iconPosition="right">
          Right icon
        </CocoaButton>
      </SubRow>
    </div>
  );

  // ------------------------------------------------------------------- inputs
  const inputsBlock = (
    <div style={subgridStyle}>
      <div>
        <div style={labelStyle}>Text</div>
        <CocoaInput
          value={textValue}
          onChange={setTextValue}
          placeholder="Type something"
        />
      </div>
      <div>
        <div style={labelStyle}>Email</div>
        <CocoaInput
          value={emailValue}
          onChange={setEmailValue}
          type="email"
          inputMode="email"
          placeholder="you@example.com"
        />
      </div>
      <div>
        <div style={labelStyle}>Number</div>
        <CocoaInput
          value={numberValue}
          onChange={setNumberValue}
          type="number"
          inputMode="numeric"
          placeholder="0"
        />
      </div>
      <div>
        <div style={labelStyle}>Password</div>
        <CocoaInput
          value={passwordValue}
          onChange={setPasswordValue}
          type="password"
          placeholder="••••••"
        />
      </div>
      <div style={{ gridColumn: "1 / -1" }}>
        <div style={labelStyle}>Textarea</div>
        <textarea
          value={areaValue}
          onChange={(e) => setAreaValue(e.target.value)}
          rows={3}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "var(--cocoa-background-control)",
            color: "var(--cocoa-label)",
            border: "1px solid var(--cocoa-separator)",
            borderRadius: "var(--cocoa-radius-md)",
            padding: "8px 12px",
            fontFamily: "var(--cocoa-font)",
            fontSize: "var(--cocoa-fs-body)",
            lineHeight: "var(--cocoa-lh-body)",
            outline: "none",
            resize: "vertical"
          }}
        />
      </div>
      <div style={{ gridColumn: "1 / -1" }}>
        <div style={labelStyle}>Search</div>
        <CocoaSearchInput
          value={searchValue}
          onChange={setSearchValue}
          placeholder="Buscar…"
        />
      </div>
    </div>
  );

  // ---------------------------------------------------------------- selectors
  const selectorsBlock = (
    <div style={colStyle}>
      <div style={subgridStyle}>
        <div>
          <div style={labelStyle}>Select</div>
          <CocoaSelect
            value={selectValue}
            onChange={setSelectValue}
            options={[
              { value: "standard", label: "Standard" },
              { value: "deluxe", label: "Deluxe" },
              { value: "suite", label: "Suite" }
            ]}
          />
        </div>
        <div>
          <div style={labelStyle}>Segmented</div>
          <CocoaSegmentedControl
            value={segmented}
            onChange={setSegmented}
            options={[
              { value: "list", label: "List" },
              { value: "grid", label: "Grid" },
              { value: "card", label: "Card" }
            ]}
          />
        </div>
        <div>
          <div style={labelStyle}>Switch</div>
          <CocoaSwitch
            checked={switchValue}
            onChange={setSwitchValue}
            label="Habilitar"
          />
        </div>
        <div>
          <div style={labelStyle}>Stepper</div>
          <CocoaStepper
            value={stepperValue}
            onChange={setStepperValue}
            min={0}
            max={10}
          />
        </div>
        <div>
          <div style={labelStyle}>Date picker</div>
          <CocoaDatePicker value={dateValue} onChange={setDateValue} />
        </div>
      </div>
    </div>
  );

  // ------------------------------------------------------------------ display
  const displayBlock = (
    <div style={colStyle}>
      <SubRow label="Card variants">
        {CARD_VARIANTS.map((variant) => (
          <div key={variant} style={{ minWidth: 200 }}>
            <CocoaCard variant={variant} padding="md">
              <strong>{variant}</strong>
              <div
                style={{
                  fontSize: "var(--cocoa-fs-callout)",
                  color: "var(--cocoa-label-secondary)",
                  marginTop: 4
                }}
              >
                CocoaCard variant
              </div>
            </CocoaCard>
          </div>
        ))}
      </SubRow>
      <div>
        <div style={labelStyle}>Table (NSTableView)</div>
        <div
          style={{
            border: "1px solid var(--cocoa-separator)",
            borderRadius: "var(--cocoa-radius-md)",
            overflow: "hidden"
          }}
        >
          <CocoaTable
            columns={DEMO_COLUMNS}
            rows={DEMO_ROWS}
            rowKey="id"
            selectedKey={tableSelected}
            onSelect={(row) => setTableSelected(row.id)}
          />
        </div>
      </div>
      <div>
        <div style={labelStyle}>Page header (inline)</div>
        <div
          style={{
            background: "var(--cocoa-background-content)",
            border: "1px solid var(--cocoa-separator)",
            borderRadius: "var(--cocoa-radius-md)",
            padding: "var(--cocoa-space-4)"
          }}
        >
          <CocoaPageHeader
            eyebrow="Section"
            title="Sample header"
            subtitle="CocoaPageHeader rendered in a card"
          />
        </div>
      </div>
    </div>
  );

  // ----------------------------------------------------------------- overlays
  const overlaysBlock = (
    <div style={colStyle}>
      <SubRow label="Triggers">
        <CocoaButton
          onClick={() => setPopoverOpen((v) => !v)}
          variant="bordered"
        >
          <span ref={popoverAnchorRef as never}>Open popover</span>
        </CocoaButton>
        <CocoaButton onClick={() => setSheetOpen(true)} variant="bordered">
          Open sheet
        </CocoaButton>
        <CocoaButton
          onClick={() => setAlertOpen("info")}
          variant="tinted"
        >
          Alert · info
        </CocoaButton>
        <CocoaButton
          onClick={() => setAlertOpen("warning")}
          variant="tinted"
          tone="neutral"
        >
          Alert · warning
        </CocoaButton>
        <CocoaButton
          onClick={() => setAlertOpen("critical")}
          variant="filled"
          tone="destructive"
        >
          Alert · critical
        </CocoaButton>
      </SubRow>
      <div>
        <div style={labelStyle}>Context menu (right-click here)</div>
        <CocoaContextMenu
          items={[
            { id: "open", label: "Abrir", shortcut: "⌘O" },
            { id: "edit", label: "Editar", shortcut: "⌘E" },
            { id: "sep1", label: "", separator: true, onClick: () => {} },
            {
              id: "delete",
              label: "Eliminar",
              shortcut: "⌫",
              destructive: true
            }
          ]}
        >
          <div
            style={{
              padding: "var(--cocoa-space-4)",
              border: "1px dashed var(--cocoa-separator)",
              borderRadius: "var(--cocoa-radius-md)",
              textAlign: "center",
              color: "var(--cocoa-label-secondary)",
              fontSize: "var(--cocoa-fs-callout)"
            }}
          >
            Click derecho para abrir el menú contextual.
          </div>
        </CocoaContextMenu>
      </div>
      <CocoaPopover
        open={popoverOpen}
        anchorEl={popoverAnchorRef.current}
        onClose={() => setPopoverOpen(false)}
      >
        <div style={{ minWidth: 200 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Popover</div>
          <div
            style={{
              fontSize: "var(--cocoa-fs-callout)",
              color: "var(--cocoa-label-secondary)"
            }}
          >
            Anchored to the trigger button.
          </div>
        </div>
      </CocoaPopover>
      <CocoaSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Cocoa sheet"
        size="md"
        footer={
          <>
            <CocoaButton
              variant="bordered"
              onClick={() => setSheetOpen(false)}
            >
              Cancelar
            </CocoaButton>
            <CocoaButton onClick={() => setSheetOpen(false)}>OK</CocoaButton>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          Sheets descienden desde el borde superior con el ease lento de
          Cocoa.
        </p>
      </CocoaSheet>
      <CocoaAlert
        open={alertOpen !== null}
        type={alertOpen ?? "info"}
        title={
          alertOpen === "critical"
            ? "¿Eliminar registro?"
            : alertOpen === "warning"
              ? "Advertencia"
              : "Información"
        }
        message={
          alertOpen === "critical"
            ? "Esta acción no se puede deshacer."
            : alertOpen === "warning"
              ? "Algunos cambios podrían perderse."
              : "Esta es una alerta informativa de ejemplo."
        }
        primaryAction={{
          label: alertOpen === "critical" ? "Eliminar" : "OK",
          destructive: alertOpen === "critical",
          onClick: () => setAlertOpen(null)
        }}
        cancelAction={
          alertOpen === "critical"
            ? { label: "Cancelar", onClick: () => setAlertOpen(null) }
            : undefined
        }
        onClose={() => setAlertOpen(null)}
      />
    </div>
  );

  // ------------------------------------------------------------------ extras
  const extrasBlock = (
    <div style={colStyle}>
      <SubRow label="Color well">
        <CocoaColorWell value={colorValue} onChange={setColorValue} />
        <CocoaColorWell
          value={colorValue}
          onChange={setColorValue}
          size="small"
        />
        <CocoaColorWell
          value={colorValue}
          onChange={setColorValue}
          size="large"
        />
        <span
          style={{
            fontFamily: "var(--cocoa-font-mono)",
            fontSize: "var(--cocoa-fs-footnote)",
            color: "var(--cocoa-label-secondary)"
          }}
        >
          {colorValue}
        </span>
      </SubRow>
      <CocoaFormFieldset
        title="Form fieldset"
        description="Agrupa controles relacionados bajo un encabezado."
      >
        <div style={subgridStyle}>
          <div>
            <div style={labelStyle}>Field A</div>
            <CocoaInput
              value={textValue}
              onChange={setTextValue}
              placeholder="Valor"
            />
          </div>
          <div>
            <div style={labelStyle}>Field B</div>
            <CocoaSelect
              value={selectValue}
              onChange={setSelectValue}
              options={[
                { value: "standard", label: "Standard" },
                { value: "deluxe", label: "Deluxe" }
              ]}
            />
          </div>
        </div>
      </CocoaFormFieldset>
      <div>
        <div style={labelStyle}>Toolbar search field</div>
        <CocoaToolbarSearchField
          value={toolbarSearch}
          onChange={setToolbarSearch}
          placeholder="Buscar en toolbar…"
          expandOnFocus
        />
      </div>
    </div>
  );

  // ----------------------------------------------------------------- globals
  const globalsBlock = (
    <SubRow label="Trigger globals">
      <CocoaButton onClick={() => setCommandPaletteOpen(true)}>
        Command Palette (⌘K)
      </CocoaButton>
      <CocoaButton
        variant="bordered"
        onClick={() => setPreferencesOpen(true)}
      >
        Preferences (⌘,)
      </CocoaButton>
      <CocoaButton
        variant="bordered"
        onClick={() => setNotificationsOpen(true)}
      >
        Notification Center
      </CocoaButton>
      <CocoaButton
        variant="bordered"
        onClick={() => setShortcutsOpen(true)}
      >
        Shortcuts Help (⌘/)
      </CocoaButton>
      <CocoaButton variant="bordered" onClick={() => setAboutOpen(true)}>
        About
      </CocoaButton>
    </SubRow>
  );

  // ------------------------------------------------------------------ icons
  const iconsBlock = (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
        gap: "var(--cocoa-space-3)"
      }}
    >
      {ICON_ENTRIES.map(({ name, Icon }) => (
        <div
          key={name}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            padding: "var(--cocoa-space-3)",
            background: "var(--cocoa-background-content)",
            border: "1px solid var(--cocoa-separator)",
            borderRadius: "var(--cocoa-radius-md)",
            color: "var(--cocoa-label)"
          }}
        >
          <Icon size={24} />
          <span
            style={{
              fontSize: "var(--cocoa-fs-caption)",
              color: "var(--cocoa-label-secondary)",
              fontFamily: "var(--cocoa-font-mono)",
              textAlign: "center"
            }}
          >
            {name}
          </span>
        </div>
      ))}
    </div>
  );

  // --------------------------------------------------------------- typography
  const typographyBlock = (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {TYPOGRAPHY_SCALE.map((entry) => {
        const fontFamily =
          entry.family === "display"
            ? "var(--cocoa-font-display)"
            : "var(--cocoa-font)";
        const fontSize =
          entry.token === "caption-2"
            ? "var(--cocoa-fs-caption)"
            : `var(--cocoa-fs-${entry.token})`;
        const lineHeight =
          entry.token === "caption-2"
            ? "var(--cocoa-lh-caption)"
            : `var(--cocoa-lh-${entry.token})`;
        return (
          <div
            key={entry.token}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "var(--cocoa-space-4)",
              padding: "6px 0",
              borderBottom: "1px solid var(--cocoa-separator)"
            }}
          >
            <span
              style={{
                minWidth: 120,
                fontSize: "var(--cocoa-fs-caption)",
                color: "var(--cocoa-label-secondary)",
                fontFamily: "var(--cocoa-font-mono)",
                textTransform: "uppercase",
                letterSpacing: "var(--cocoa-tracking-wide)"
              }}
            >
              {entry.token}
            </span>
            <span
              style={{
                fontFamily,
                fontSize,
                lineHeight,
                letterSpacing: "var(--cocoa-tracking-tight)",
                color: "var(--cocoa-label)"
              }}
            >
              {entry.label}
            </span>
          </div>
        );
      })}
    </div>
  );

  // ------------------------------------------------------------------ colors
  const colorsBlock = (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
        gap: "var(--cocoa-space-3)"
      }}
    >
      {COLOR_TOKENS.map((c) => (
        <div
          key={c.token}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "var(--cocoa-space-2)",
            background: "var(--cocoa-background-content)",
            border: "1px solid var(--cocoa-separator)",
            borderRadius: "var(--cocoa-radius-md)"
          }}
        >
          <div
            style={{
              height: 56,
              borderRadius: "var(--cocoa-radius-sm)",
              background: `var(${c.token})`,
              border: "1px solid var(--cocoa-separator)"
            }}
          />
          <div>
            <div
              style={{
                fontSize: "var(--cocoa-fs-callout)",
                fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
                color: "var(--cocoa-label)"
              }}
            >
              {c.label}
            </div>
            <div
              style={{
                fontFamily: "var(--cocoa-font-mono)",
                fontSize: "var(--cocoa-fs-caption)",
                color: "var(--cocoa-label-secondary)"
              }}
            >
              {c.token}
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  // ------------------------------------------------------------------- render
  return (
    <div style={pageStyle}>
      <CocoaPageHeader
        eyebrow="Developer · Cocoa Edition"
        title="Component Showcase"
        subtitle="Todos los componentes Aurora Cocoa en vivo"
      />

      <Section title="1. Buttons" subtitle="Variants × tones × sizes.">
        {buttonsMatrix}
      </Section>

      <Section
        title="2. Inputs"
        subtitle="CocoaInput, CocoaTextarea (nativo styled), CocoaSearchInput."
      >
        {inputsBlock}
      </Section>

      <Section
        title="3. Selectors"
        subtitle="Select, segmented control, switch, stepper, date picker."
      >
        {selectorsBlock}
      </Section>

      <Section
        title="4. Display"
        subtitle="Cards, tablas y page header en distintas variantes."
      >
        {displayBlock}
      </Section>

      <Section
        title="5. Overlays"
        subtitle="Popover, sheet, alerts y context menu."
      >
        {overlaysBlock}
      </Section>

      <Section
        title="6. Extras"
        subtitle="ColorWell, FormFieldset y toolbar search."
      >
        {extrasBlock}
      </Section>

      <Section
        title="7. Globals"
        subtitle="Disparadores para command palette, preferencias, notificaciones, atajos y about."
      >
        {globalsBlock}
      </Section>

      <Section
        title="8. Icons"
        subtitle="Set de cocoa-icons renderizados a 24px."
      >
        {iconsBlock}
      </Section>

      <Section
        title="9. Typography"
        subtitle="Escala completa según los tokens --cocoa-fs-*."
      >
        {typographyBlock}
      </Section>

      <Section
        title="10. Colors"
        subtitle="Tokens de color en swatches (light/dark theme-aware)."
      >
        {colorsBlock}
      </Section>

      {/* Global overlays (managed locally for the showcase) */}
      <CocoaCommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        items={[
          {
            id: "cmd-new",
            label: "Nueva reserva",
            category: "Bookings",
            shortcut: "⌘N",
            onSelect: () => setCommandPaletteOpen(false)
          },
          {
            id: "cmd-search",
            label: "Buscar huésped",
            category: "Guests",
            shortcut: "⌘F",
            onSelect: () => setCommandPaletteOpen(false)
          },
          {
            id: "cmd-prefs",
            label: "Abrir preferencias",
            category: "Settings",
            shortcut: "⌘,",
            onSelect: () => {
              setCommandPaletteOpen(false);
              setPreferencesOpen(true);
            }
          }
        ]}
      />
      <CocoaPreferencesSheet
        open={preferencesOpen}
        onClose={() => setPreferencesOpen(false)}
      />
      <CocoaNotificationCenter
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        notifications={demoNotifications}
        onMarkAllAsRead={() => setNotificationsOpen(false)}
      />
      <CocoaKeyboardShortcutsHelp
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      <CocoaAboutDialog
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
      />
    </div>
  );
}

export default CocoaShowcaseScreen;
