// StyleGuideScreen — Cocoa 22 style guide (dev-only, /desarrollo/guia-estilo).
//
// Living reference of every Cocoa 22 primitive (docs/design/COCOA-22.md
// §2–§3, §8) in every state and tone: tokens (colour light/dark read at
// runtime from the CSSOM of cocoa-tokens.css, typography, spacing, radii,
// shadows, motion, z-index), buttons, form controls, badges and callouts, KPI
// strips, cards and sections, the 12-column grid, tables (stacked below
// 600 px), forms with the action bar, tabs, drawer / dialog / sheet / popover,
// toasts and the live region, empty / error / loading / degraded states and
// the SVG charts — every block with a copyable JSX sample — plus the visible
// migration checklist of §9 / §10. The page switches its own CocoaPage state
// (loading / empty / error) and full-bleed, so the frame is covered live and
// not only in a code sample.
//
// Self-contained: local state only, no API calls, no literal colours (every
// swatch paints `var(--cocoa-*)` or a value read at runtime from the served
// stylesheet), Spanish copy, English code. First adopter of `CocoaPage`.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  COCOA_TONES,
  CocoaActionBar,
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaCard,
  CocoaChart,
  CocoaDatePicker,
  CocoaDelta,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaGrid,
  CocoaInput,
  CocoaKbd,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaLiveRegion,
  CocoaPage,
  CocoaPopover,
  CocoaScrollArea,
  CocoaSearchInput,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSheet,
  CocoaSkeleton,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaStepper,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  DegradedBanner,
  DegradedCard,
  DegradedNote,
  DegradedValue,
  useIsNarrow,
  useViewportTier,
  VIRTUALIZE_CHUNK,
  VIRTUALIZE_THRESHOLD,
  type CocoaBadgeVariant,
  type CocoaButtonSize,
  type CocoaButtonTone,
  type CocoaButtonVariant,
  type CocoaDialogTone,
  type CocoaDrawerSide,
  type CocoaDrawerSize,
  type CocoaPageDensity,
  type CocoaSkeletonVariant,
  type CocoaSpanCols,
  type CocoaTableColumn,
  type CocoaTableSort,
  type CocoaTone
} from "../../components/cocoa";
import { useToast } from "../../components/Toast";
import { CheckIcon, DownloadIcon, PlusIcon, SearchIcon, TrashIcon } from "../../components/cocoa-icons/ActionIcons";
import { BellIcon, CheckCircleIcon, ClockIcon, ExclamationCircleIcon, InfoCircleIcon, StarIcon } from "../../components/cocoa-icons/StatusIcons";
import { SparkleIcon } from "../../components/cocoa-icons/NavigationIcons";
import { date, money, number, percent } from "../../lib/format";
import { navigateTo } from "../../lib/navigate";
import { getThemePreference, setThemePreference, type ThemePreference } from "../../theme";

// ---------------------------------------------------------------------------
// Runtime token reader (CSSOM). The light and dark values of a token are the
// declarations of cocoa-tokens.css (`:root`, `:root[data-theme="dark"]` and
// the `prefers-color-scheme: dark` block); `computed` is what the page paints
// right now. No colour literal lives in this file.
// ---------------------------------------------------------------------------

export interface TokenDeclaration {
  light: string | null;
  dark: string | null;
  computed: string;
}

const DARK_MEDIA = /prefers-color-scheme:\s*dark/;

function walkRules(rules: CSSRuleList, darkScope: boolean, onRule: (rule: CSSStyleRule, dark: boolean) => void): void {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule instanceof CSSStyleRule) {
      onRule(rule, darkScope);
      continue;
    }
    if (!("cssRules" in rule)) continue;
    const nested = (rule as CSSGroupingRule).cssRules;
    if (!nested) continue;
    const dark = darkScope || (rule instanceof CSSMediaRule && DARK_MEDIA.test(rule.conditionText));
    walkRules(nested, dark, onRule);
  }
}

/** Light / dark declarations plus the computed value of every token name (pure DOM read; empty map without a document). */
export function readTokenDeclarations(names: readonly string[]): Map<string, TokenDeclaration> {
  const out = new Map<string, TokenDeclaration>();
  if (typeof document === "undefined") return out;
  const computed = getComputedStyle(document.documentElement);
  for (const name of names) out.set(name, { light: null, dark: null, computed: computed.getPropertyValue(name).trim() });
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin stylesheet (fonts): not ours
    }
    walkRules(rules, false, (rule, darkScope) => {
      const selector = rule.selectorText ?? "";
      if (!selector.includes(":root") || selector.includes("data-cocoa-density")) return;
      const forcesLight = selector.includes('data-theme="light"') && !selector.includes(":not(");
      const dark = !forcesLight && (darkScope || selector.includes('data-theme="dark"'));
      for (const name of names) {
        const value = rule.style.getPropertyValue(name).trim();
        if (!value) continue;
        const entry = out.get(name);
        if (!entry) continue;
        if (dark) entry.dark = value;
        else entry.light = value;
      }
    });
  }
  return out;
}

/** Re-renders when the theme attribute or the system scheme changes (token table stays live). */
function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const bump = () => setVersion((current) => current + 1);
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", bump);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", bump);
    };
  }, []);
  return version;
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const SECTIONS = [
  { id: "guia-tokens-color", label: "Color" },
  { id: "guia-tokens-tipografia", label: "Tipografía" },
  { id: "guia-tokens-espacio", label: "Espacio y radios" },
  { id: "guia-tokens-sombras", label: "Sombras" },
  { id: "guia-tokens-motion", label: "Motion y capas" },
  { id: "guia-botones", label: "Botones" },
  { id: "guia-campos", label: "Campos" },
  { id: "guia-formulario", label: "Formulario" },
  { id: "guia-badges", label: "Badges y avisos" },
  { id: "guia-kpi", label: "KPI" },
  { id: "guia-tarjetas", label: "Tarjetas" },
  { id: "guia-rejilla", label: "Rejilla" },
  { id: "guia-tablas", label: "Tablas" },
  { id: "guia-pestanas", label: "Pestañas y barra" },
  { id: "guia-capas", label: "Drawer y diálogo" },
  { id: "guia-toast", label: "Toast" },
  { id: "guia-estados", label: "Estados" },
  { id: "guia-graficos", label: "Gráficos" },
  { id: "guia-checklist", label: "Checklist" }
] as const;

const monoStyle: CSSProperties = {
  fontFamily: "var(--cocoa-font-mono)",
  fontSize: "var(--cocoa-fs-callout)",
  lineHeight: "var(--cocoa-lh-callout)"
};

const preStyle: CSSProperties = {
  ...monoStyle,
  margin: 0,
  padding: "var(--cocoa-space-3)",
  background: "var(--cocoa-background-control)",
  border: "1px solid var(--cocoa-separator)",
  borderRadius: "var(--cocoa-radius-md)",
  color: "var(--cocoa-label)",
  overflowX: "auto",
  whiteSpace: "pre",
  tabSize: 2
};

const captionStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  lineHeight: "var(--cocoa-lh-caption)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  letterSpacing: "var(--cocoa-tracking-wide)",
  textTransform: "uppercase",
  color: "var(--cocoa-label-secondary)"
};

const secondaryTextStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-callout)",
  lineHeight: "var(--cocoa-lh-callout)",
  color: "var(--cocoa-label-secondary)"
};

const swatchStyle: CSSProperties = {
  display: "inline-block",
  width: 28,
  height: 20,
  borderRadius: "var(--cocoa-radius-sm)",
  boxShadow: "inset 0 0 0 1px var(--cocoa-separator)",
  flexShrink: 0
};

const demoBoxStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 56,
  padding: "var(--cocoa-space-3)",
  border: "1px dashed var(--cocoa-separator)",
  borderRadius: "var(--cocoa-radius-md)",
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-callout)"
};

/** Caption label of every block (10 px, uppercase, secondary). */
function Caption({ children, minWidth }: { children: ReactNode; minWidth?: number }) {
  return <span style={minWidth ? { ...captionStyle, minWidth } : captionStyle}>{children}</span>;
}

/** Secondary text (callout size); `as="span"` for inline uses. */
function Note({ children, as = "p", className, flex }: { children: ReactNode; as?: "p" | "span"; className?: string; flex?: string }) {
  const style = flex ? { ...secondaryTextStyle, flex } : secondaryTextStyle;
  if (as === "span") {
    return (
      <span className={className} style={style}>
        {children}
      </span>
    );
  }
  return (
    <p className={className} style={style}>
      {children}
    </p>
  );
}

/** Monospace snippet (token names, ids, props). */
function Mono({ children, minWidth, tertiary = false, wrap = false }: { children: ReactNode; minWidth?: number; tertiary?: boolean; wrap?: boolean }) {
  const style: CSSProperties = { ...monoStyle, minWidth, color: tertiary ? "var(--cocoa-label-tertiary)" : undefined, overflowWrap: wrap ? "anywhere" : undefined };
  return <code style={style}>{children}</code>;
}

/** Dashed placeholder of the grid demos; `surface` paints it on content, `fill` stretches it inside its cell. */
function DemoBox({ children, surface = false, fill = false }: { children: ReactNode; surface?: boolean; fill?: boolean }) {
  return <div style={{ ...demoBoxStyle, background: surface ? "var(--cocoa-background-content)" : undefined, flex: fill ? "1 1 auto" : undefined }}>{children}</div>;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Copyable JSX sample: <pre> + «Copiar» (CocoaButton). */
function CodeSample({ code, label = "Código de ejemplo" }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const { showToast } = useToast();
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  const onCopy = async () => {
    const ok = await copyText(code);
    if (!ok) {
      showToast("No se pudo copiar al portapapeles", { variant: "error" });
      return;
    }
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="cocoa-stack" data-gap="2" data-cocoa="code-sample">
      <div className="cocoa-row" data-justify="between" data-gap="2">
        <Caption>{label}</Caption>
        <CocoaButton variant="bordered" tone="neutral" size="small" icon={copied ? <CheckIcon size={12} /> : undefined} onClick={onCopy}>
          {copied ? "Copiado" : "Copiar"}
        </CocoaButton>
      </div>
      <pre style={preStyle} tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Swatch({ value, fallbackToken }: { value: string | null; fallbackToken: string }) {
  const isReference = value !== null && /^(var|color-mix)\(/.test(value);
  return (
    <span className="cocoa-cluster" data-gap="2">
      <span aria-hidden="true" style={{ ...swatchStyle, background: value ?? `var(${fallbackToken})` }} />
      <Mono>{value ?? "—"}</Mono>
      {isReference ? <CocoaBadge tone="neutral" size="small">ref.</CocoaBadge> : null}
    </span>
  );
}

function scrollToSection(id: string) {
  const element = document.getElementById(id);
  if (!element) return;
  element.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

// ---------------------------------------------------------------------------
// Sample data (deterministic, no request)
// ---------------------------------------------------------------------------

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

const TODAY = new Date();

const PACE_POINTS = Array.from({ length: 30 }, (_, index) => {
  const x = date(addDays(TODAY, index), "dayMonth");
  const otb = Math.round(38 + index * 1.4 + Math.sin(index / 3) * 6);
  return { x, otb, forecast: otb + 6 + Math.round(Math.cos(index / 4) * 3), ly: Math.round(otb * 0.92) };
});

const PICKUP_7D = [
  { label: "L", value: 6 },
  { label: "M", value: 9 },
  { label: "X", value: -3 },
  { label: "J", value: 4 },
  { label: "V", value: 12 },
  { label: "S", value: 15, hint: "Grupo Faranda · 8 hab." },
  { label: "D", value: -1 }
];

const CHANNEL_MIX = [
  { label: "Directo", value: 42 },
  { label: "Booking", value: 31 },
  { label: "Expedia", value: 14 },
  { label: "Agencias", value: 13 }
];

const SPARK_UP = [12, 14, 13, 17, 19, 18, 22, 25];
const SPARK_DOWN = [25, 24, 22, 21, 19, 18, 17, 15];
const SPARK_FLAT = [14, 15, 14, 15, 14, 15, 14, 15];

type ReservationStatus = "confirmada" | "pendiente" | "en-casa" | "cancelada";

interface ReservationRow {
  id: string;
  guest: string;
  arrival: string;
  nights: number;
  amount: number;
  channel: string;
  status: ReservationStatus;
}

const RESERVATIONS: ReservationRow[] = [
  { id: "RA-10412", guest: "Marta Otero", arrival: "2026-09-18", nights: 3, amount: 486, channel: "Directo", status: "confirmada" },
  { id: "RA-10413", guest: "Xoán Pereira", arrival: "2026-09-18", nights: 1, amount: 132.5, channel: "Booking", status: "en-casa" },
  { id: "RA-10415", guest: "Lucía Freire", arrival: "2026-09-19", nights: 5, amount: 910, channel: "Expedia", status: "pendiente" },
  { id: "RA-10418", guest: "Antón Barreiro", arrival: "2026-09-20", nights: 2, amount: 268, channel: "Directo", status: "confirmada" },
  { id: "RA-10420", guest: "Carla Souto", arrival: "2026-09-21", nights: 4, amount: 704, channel: "Agencia", status: "cancelada" },
  { id: "RA-10421", guest: "Helena Vidal", arrival: "2026-09-22", nights: 2, amount: 312, channel: "Booking", status: "confirmada" }
];

const STATUS_TONE: Record<ReservationStatus, CocoaTone> = {
  confirmada: "success",
  pendiente: "warning",
  "en-casa": "accent",
  cancelada: "danger"
};

const STATUS_LABEL: Record<ReservationStatus, string> = {
  confirmada: "Confirmada",
  pendiente: "Pendiente de pago",
  "en-casa": "En casa",
  cancelada: "Cancelada"
};

const LONG_CHANNELS = ["Directo", "Booking", "Expedia", "Agencia"];
const LONG_STATUSES: ReservationStatus[] = ["confirmada", "pendiente", "en-casa", "cancelada"];

/** 250 deterministic rows for the `virtualize` demo (200 painted first, then chunks of 100). */
const LONG_RESERVATIONS: ReservationRow[] = Array.from({ length: 250 }, (_, index) => ({
  id: `RA-${11000 + index}`,
  guest: RESERVATIONS[index % RESERVATIONS.length].guest,
  arrival: addDays(TODAY, index % 45).toISOString().slice(0, 10),
  nights: 1 + (index % 5),
  amount: 96 + (index % 17) * 23.5,
  channel: LONG_CHANNELS[index % LONG_CHANNELS.length],
  status: LONG_STATUSES[index % LONG_STATUSES.length]
}));

/** Eight weekly ADR points for the legend-less line chart. */
const ADR_WEEKS = Array.from({ length: 8 }, (_, index) => ({
  x: date(addDays(TODAY, index * 7), "dayMonth"),
  y: Math.round(104 + index * 3.5 + Math.sin(index / 1.5) * 9)
}));

// ---------------------------------------------------------------------------
// Tokens · colour
// ---------------------------------------------------------------------------

interface TokenRow {
  token: string;
  role: string;
  group: string;
}

const TONE_LABEL: Record<CocoaTone, string> = {
  success: "Éxito",
  warning: "Aviso",
  danger: "Peligro",
  info: "Informativo",
  neutral: "Neutro",
  accent: "Acento",
  ai: "IA"
};

const COLOUR_TOKENS: TokenRow[] = [
  { group: "Superficies", token: "--cocoa-background-window", role: "Lienzo del contenido (= --canvas de Aurora)" },
  { group: "Superficies", token: "--cocoa-background-content", role: "Tarjetas, KPI, popovers, tabla" },
  { group: "Superficies", token: "--cocoa-background-sidebar", role: "Barra lateral y cabecera sticky de tabla" },
  { group: "Superficies", token: "--cocoa-background-control", role: "Inputs, segmented, botón neutro" },
  { group: "Superficies", token: "--cocoa-background-control-hover", role: "Hover de controles" },
  { group: "Superficies", token: "--cocoa-background-selection", role: "Fila o ítem seleccionado" },
  { group: "Superficies", token: "--cocoa-background-toolbar", role: "Barra superior (único material con blur)" },
  { group: "Texto", token: "--cocoa-label", role: "Títulos, cifras, cuerpo (15,1:1)" },
  { group: "Texto", token: "--cocoa-label-secondary", role: "Subtítulos, etiquetas KPI, captions (≥ 5,3:1)" },
  { group: "Texto", token: "--cocoa-label-tertiary", role: "Solo decorativo: ejes, placeholders" },
  { group: "Texto", token: "--cocoa-label-quaternary", role: "Deshabilitado" },
  { group: "Separadores", token: "--cocoa-separator", role: "Bordes de tarjeta, filas, rejilla de gráfico" },
  { group: "Separadores", token: "--cocoa-separator-opaque", role: "Sobre fondos translúcidos" },
  { group: "Acento", token: "--cocoa-accent", role: "Único acento (Esmeralda)" },
  { group: "Acento", token: "--cocoa-accent-hover", role: "Hover de filled, enlaces" },
  { group: "Acento", token: "--cocoa-accent-pressed", role: "Pulsado" },
  { group: "Acento", token: "--cocoa-accent-contrast", role: "Tinta sobre acento" },
  { group: "Acento", token: "--cocoa-accent-bg", role: "Fondo tintado (banners, ítem activo)" },
  { group: "Acento", token: "--cocoa-accent-border", role: "Borde tintado" },
  { group: "Acento", token: "--cocoa-focus-ring", role: "Halo de foco 3 px" },
  { group: "Acento", token: "--cocoa-scrim", role: "Velo de drawer, diálogo y sheet" },
  ...COCOA_TONES.flatMap((tone) => [
    { group: "Tonos", token: `--cocoa-tone-${tone}`, role: `${TONE_LABEL[tone]} · barras 3 px, deltas, puntos` },
    { group: "Tonos", token: `--cocoa-tone-${tone}-text`, role: `${TONE_LABEL[tone]} · texto AA (tinta)` },
    { group: "Tonos", token: `--cocoa-tone-${tone}-bg`, role: `${TONE_LABEL[tone]} · fondo tintado` },
    { group: "Tonos", token: `--cocoa-tone-${tone}-border`, role: `${TONE_LABEL[tone]} · borde tintado` }
  ]),
  { group: "Gráficos", token: "--cocoa-chart-grid", role: "Rejilla" },
  { group: "Gráficos", token: "--cocoa-chart-axis", role: "Ejes y etiquetas (10 px)" },
  { group: "Gráficos", token: "--cocoa-chart-primary", role: "Serie principal (OTB)" },
  { group: "Gráficos", token: "--cocoa-chart-forecast", role: "Previsión (discontinua)" },
  { group: "Gráficos", token: "--cocoa-chart-reference", role: "Referencia (año anterior)" },
  { group: "Gráficos", token: "--cocoa-chart-series-2", role: "Serie 2" },
  { group: "Gráficos", token: "--cocoa-chart-series-3", role: "Serie 3" },
  { group: "Gráficos", token: "--cocoa-chart-series-4", role: "Serie 4" },
  { group: "Gráficos", token: "--cocoa-chart-track", role: "Pista de gauge y progreso" }
];

const COLOUR_TOKEN_NAMES = COLOUR_TOKENS.map((row) => row.token);

const COLOUR_SAMPLE = `// Nunca un color literal en pantallas: todo sale de var(--cocoa-*)
<span style={{ color: "var(--cocoa-label-secondary)" }}>Subtítulo</span>
<CocoaBadge tone="success" variant="tinted">Confirmada</CocoaBadge>
// Texto de tono ≤ 13 px → tinta AA: var(--cocoa-tone-success-text)`;

type ColourTableRow = TokenRow & TokenDeclaration;

function ColourTokensSection() {
  const version = useThemeVersion();
  const declarations = useMemo(() => readTokenDeclarations(COLOUR_TOKEN_NAMES), [version]);
  const [group, setGroup] = useState("Superficies");
  const groups = useMemo(() => Array.from(new Set(COLOUR_TOKENS.map((row) => row.group))), []);
  const rows = useMemo<ColourTableRow[]>(
    () =>
      COLOUR_TOKENS.filter((row) => row.group === group).map((row) => ({
        ...row,
        ...(declarations.get(row.token) ?? { light: null, dark: null, computed: "" })
      })),
    [declarations, group]
  );
  const columns: CocoaTableColumn<ColourTableRow>[] = [
    { key: "token", label: "Token", minWidth: 220, render: (row) => <Mono>{row.token}</Mono> },
    { key: "role", label: "Uso", minWidth: 200, hideOnNarrow: true },
    { key: "light", label: "Claro", minWidth: 180, render: (row) => <Swatch value={row.light} fallbackToken={row.token} /> },
    { key: "dark", label: "Oscuro", minWidth: 180, render: (row) => <Swatch value={row.dark} fallbackToken={row.token} /> },
    { key: "computed", label: "Ahora", minWidth: 160, hideOnNarrow: true, render: (row) => <Swatch value={row.computed || null} fallbackToken={row.token} /> }
  ];
  return (
    <CocoaSection
      id="guia-tokens-color"
      headingLevel={2}
      title="Tokens · Color"
      meta="Valores declarados en cocoa-tokens.css (claro / oscuro) y valor pintado ahora"
      action={
        <CocoaSegmentedControl
          size="small"
          value={group}
          onChange={setGroup}
          options={groups.map((value) => ({ value, label: value }))}
          aria-label="Grupo de tokens"
        />
      }
      padding="none"
      footer={
        <div className="cocoa-stack" data-gap="3" style={{ padding: "var(--cocoa-space-4)" }}>
          <Note>
            Reglas: un solo acento cromático por pantalla · tonos solo en barras de 3 px, deltas, badges y puntos · texto de tono ≤ 13 px con la tinta
            <Mono> --cocoa-tone-*-text</Mono> · <Mono>--cocoa-info</Mono> no es un acento.
          </Note>
          <CodeSample code={COLOUR_SAMPLE} />
        </div>
      }
    >
      <CocoaTable<ColourTableRow> columns={columns} rows={rows} rowKey="token" caption={`Tokens de color · ${group}`} />
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Tokens · typography
// ---------------------------------------------------------------------------

interface TypeRow {
  name: string;
  use: string;
  fs: string;
  lh: string;
  weight: string;
  tracking: string;
  display?: boolean;
  tabular?: boolean;
  uppercase?: boolean;
}

const TYPE_SCALE: TypeRow[] = [
  { name: "Large title", use: "H1 de página", fs: "--cocoa-fs-large-title", lh: "--cocoa-lh-large-title", weight: "--cocoa-fw-bold", tracking: "--cocoa-tracking-tight", display: true },
  { name: "KPI", use: "Cifra de tile (32 px, tabular)", fs: "--cocoa-fs-kpi", lh: "--cocoa-lh-kpi", weight: "--cocoa-fw-semibold", tracking: "--cocoa-tracking-tight", tabular: true },
  { name: "KPI compacta", use: "Cifra compacta (24 px)", fs: "--cocoa-fs-kpi-compact", lh: "--cocoa-lh-kpi", weight: "--cocoa-fw-semibold", tracking: "--cocoa-tracking-tight", tabular: true },
  { name: "Title 1", use: "Cifra del gauge, título de sheet", fs: "--cocoa-fs-title-1", lh: "--cocoa-lh-title-1", weight: "--cocoa-fw-semibold", tracking: "--cocoa-tracking-tight" },
  { name: "Title 2", use: "Estado vacío, CocoaStat grande", fs: "--cocoa-fs-title-2", lh: "--cocoa-lh-title-2", weight: "--cocoa-fw-semibold", tracking: "--cocoa-tracking-tight" },
  { name: "Title 3", use: "Cabecera de tarjeta (h3)", fs: "--cocoa-fs-title-3", lh: "--cocoa-lh-title-3", weight: "--cocoa-fw-semibold", tracking: "--cocoa-tracking-tight" },
  { name: "Headline", use: "Énfasis en cuerpo", fs: "--cocoa-fs-headline", lh: "--cocoa-lh-headline", weight: "--cocoa-fw-semibold", tracking: "--cocoa-tracking-normal" },
  { name: "Body", use: "Cuerpo, subtítulo, tabla", fs: "--cocoa-fs-body", lh: "--cocoa-lh-body", weight: "--cocoa-fw-regular", tracking: "--cocoa-tracking-normal" },
  { name: "Callout", use: "Notas, ayuda de campo", fs: "--cocoa-fs-callout", lh: "--cocoa-lh-callout", weight: "--cocoa-fw-regular", tracking: "--cocoa-tracking-normal" },
  { name: "Subheadline", use: "Descripción de estado vacío", fs: "--cocoa-fs-subheadline", lh: "--cocoa-lh-subheadline", weight: "--cocoa-fw-regular", tracking: "--cocoa-tracking-normal" },
  { name: "Footnote", use: "Delta, botón small", fs: "--cocoa-fs-footnote", lh: "--cocoa-lh-footnote", weight: "--cocoa-fw-medium", tracking: "--cocoa-tracking-normal", tabular: true },
  { name: "Caption", use: "Eyebrow, etiqueta KPI, th, badge", fs: "--cocoa-fs-caption", lh: "--cocoa-lh-caption", weight: "--cocoa-fw-semibold", tracking: "--cocoa-tracking-wide", uppercase: true }
];

const TYPE_TOKEN_NAMES = Array.from(new Set(TYPE_SCALE.flatMap((row) => [row.fs, row.lh, row.weight, row.tracking])));

const TYPE_SAMPLE = `<h3 style={{ font: "var(--cocoa-fw-semibold) var(--cocoa-fs-title-3)/var(--cocoa-lh-title-3) var(--cocoa-font-display)", letterSpacing: "var(--cocoa-tracking-tight)" }}>
  Pace próximos 30 días
</h3>
<span className="cocoa-tabular">{money(1234.5)}</span>   // "1.234,50 €" · lib/format
<span style={captionStyle}>Ocupación</span>               // 10 px 600 uppercase +0,012em`;

function TypographySection() {
  const version = useThemeVersion();
  const declarations = useMemo(() => readTokenDeclarations(TYPE_TOKEN_NAMES), [version]);
  const valueOf = (token: string) => declarations.get(token)?.light ?? declarations.get(token)?.computed ?? "—";
  return (
    <CocoaSection id="guia-tokens-tipografia" headingLevel={2} title="Tokens · Tipografía" meta="Inter Variable · cifras tabulares · formato es-ES vía lib/format">
      <div className="cocoa-stack" data-gap="4">
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
          {TYPE_SCALE.map((row) => (
            <li key={row.name} className="cocoa-row" data-align="baseline" data-gap="4" style={{ padding: "var(--cocoa-space-2) 0", borderBottom: "1px solid var(--cocoa-separator)" }}>
              <Caption minWidth={96}>{row.name}</Caption>
              <span
                className={row.tabular ? "cocoa-tabular" : undefined}
                style={{
                  flex: "1 1 240px",
                  minWidth: 0,
                  fontFamily: row.display ? "var(--cocoa-font-display)" : "var(--cocoa-font)",
                  fontSize: `var(${row.fs})`,
                  lineHeight: `var(${row.lh})`,
                  fontWeight: `var(${row.weight})` as CSSProperties["fontWeight"],
                  letterSpacing: `var(${row.tracking})`,
                  textTransform: row.uppercase ? "uppercase" : undefined,
                  color: "var(--cocoa-label)",
                  overflowWrap: "anywhere"
                }}
              >
                {row.tabular ? `${percent(67.4)} · ${money(1234.5)}` : "Mi día · Rías Altas"}
              </span>
              <Note as="span" flex="0 1 auto">
                {row.use} · <Mono>{valueOf(row.fs)}</Mono> / <Mono>{valueOf(row.lh)}</Mono> · {valueOf(row.weight)} · {valueOf(row.tracking)}
              </Note>
            </li>
          ))}
        </ul>
        <CodeSample code={TYPE_SAMPLE} />
      </div>
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Tokens · spacing, radii, shadows, motion, z-index
// ---------------------------------------------------------------------------

const SPACE_TOKENS = [1, 2, 3, 4, 5, 6, 7, 8].map((step) => `--cocoa-space-${step}`);
const RADIUS_TOKENS = ["--cocoa-radius-sm", "--cocoa-radius-md", "--cocoa-radius-lg", "--cocoa-radius-full"];
const SHADOW_TOKENS = [
  { token: "--cocoa-shadow-control", use: "Tarjeta bordered en reposo, tab activa" },
  { token: "--cocoa-shadow-card", use: "Tarjeta canónica (anillo + ambiente + proyección)" },
  { token: "--cocoa-shadow-popover", use: "Menús, tooltips, toast" },
  { token: "--cocoa-shadow-window", use: "Hover de tarjeta interactiva (−2 px)" },
  { token: "--cocoa-shadow-modal", use: "Diálogo, sheet, drawer" },
  { token: "--cocoa-shadow-floating", use: "Botón flotante (sin halo de acento)" },
  { token: "--cocoa-shadow-sticky", use: "Cabecera sticky de tabla (sin blur)" }
];
const MOTION_TOKENS = ["--cocoa-duration-fast", "--cocoa-duration-base", "--cocoa-duration-slow", "--cocoa-duration-enter", "--cocoa-stagger-step", "--cocoa-ease-out", "--cocoa-ease-in-out", "--cocoa-ease-spring"];
const Z_TOKENS = ["--cocoa-z-base", "--cocoa-z-sticky", "--cocoa-z-toolbar", "--cocoa-z-sidebar", "--cocoa-z-dropdown", "--cocoa-z-popover", "--cocoa-z-sheet", "--cocoa-z-modal", "--cocoa-z-toast", "--cocoa-z-tooltip"];
const SHELL_TOKENS = ["--cocoa-toolbar-height", "--cocoa-sidebar-width", "--cocoa-drawer-width", "--cocoa-content-padding", "--cocoa-touch-target", "--cocoa-action-bar-height", "--cocoa-kpi-min", "--cocoa-grid-gap"];

const SPACE_SAMPLE = `// Ritmo de 4 pt: 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64
<div className="cocoa-stack" data-gap="4">…</div>       // 16 px entre secciones
<div className="cocoa-row" data-gap="2">…</div>         // 8 px entre controles
<CocoaCard variant="bordered" padding="md">…</CocoaCard> // radio 12, padding 16`;

const SHADOW_SAMPLE = `// Tres niveles de profundidad: lienzo → tarjeta → flotante
<CocoaCard variant="elevated">…</CocoaCard>          // --cocoa-shadow-card
<CocoaCard variant="elevated" onClick={open}>…</CocoaCard> // hover → --cocoa-shadow-window + translateY(-2px)
// Prohibido: sombra de 3 capas en la toolbar, halo de acento, blur en la cabecera de tabla`;

const MOTION_SAMPLE = `<CocoaKpiStrip stagger>…</CocoaKpiStrip>   // cocoa-slide-in-up 220 ms, 40 ms × n (hasta 12)
<CocoaGrid stagger>…</CocoaGrid>
// prefers-reduced-motion y data-cocoa-reduced-motion → animation: none
// Único «infinite» permitido: shimmer del skeleton y spinner del botón`;

function SpacingSection() {
  const declarations = useMemo(() => readTokenDeclarations([...SPACE_TOKENS, ...RADIUS_TOKENS, ...SHELL_TOKENS]), []);
  const valueOf = (token: string) => declarations.get(token)?.computed || declarations.get(token)?.light || "—";
  return (
    <CocoaSection id="guia-tokens-espacio" headingLevel={2} title="Tokens · Espacio, radios y shell" meta="Ritmo de 4 pt · dos radios (8 / 12) · métricas del shell">
      <CocoaGrid gap={4} align="start">
        <CocoaSpan cols={6} min={320}>
          <div className="cocoa-stack" data-gap="2">
            <Caption>Espaciado</Caption>
            {SPACE_TOKENS.map((token) => (
              <div key={token} className="cocoa-row" data-gap="3" data-wrap="nowrap">
                <Mono minWidth={150}>{token}</Mono>
                <span aria-hidden="true" style={{ height: 12, width: `var(${token})`, background: "var(--cocoa-accent)", borderRadius: "var(--cocoa-radius-sm)", flexShrink: 0 }} />
                <Note as="span">{valueOf(token)}</Note>
              </div>
            ))}
          </div>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <div className="cocoa-stack" data-gap="4">
            <div className="cocoa-stack" data-gap="2">
              <Caption>Radios</Caption>
              <div className="cocoa-row" data-gap="4">
                {RADIUS_TOKENS.map((token) => (
                  <div key={token} className="cocoa-stack" data-gap="1" style={{ alignItems: "center" }}>
                    <span aria-hidden="true" style={{ width: 56, height: 40, background: "var(--cocoa-background-content)", boxShadow: "var(--cocoa-shadow-control)", border: "1px solid var(--cocoa-separator)", borderRadius: `var(${token})` }} />
                    <Mono>{token.replace("--cocoa-radius-", "")}</Mono>
                    <Note as="span">{valueOf(token)}</Note>
                  </div>
                ))}
              </div>
              <Note>Badge y botón small 4 · botón, input y segmented 8 · tarjeta 12 · avatar full. Prohibidos los radios Aurora 16 / 20 / 28 en contenido.</Note>
            </div>
            <div className="cocoa-stack" data-gap="2">
              <Caption>Shell</Caption>
              {SHELL_TOKENS.map((token) => (
                <div key={token} className="cocoa-row" data-justify="between" data-gap="3">
                  <Mono>{token}</Mono>
                  <Note as="span">{valueOf(token)}</Note>
                </div>
              ))}
            </div>
          </div>
        </CocoaSpan>
        <CocoaSpan cols={12}>
          <CodeSample code={SPACE_SAMPLE} />
        </CocoaSpan>
      </CocoaGrid>
    </CocoaSection>
  );
}

function ShadowsSection() {
  const version = useThemeVersion();
  const declarations = useMemo(() => readTokenDeclarations(SHADOW_TOKENS.map((row) => row.token)), [version]);
  return (
    <CocoaSection id="guia-tokens-sombras" headingLevel={2} title="Tokens · Sombras y profundidad" meta="En oscuro el anillo es blanco translúcido; nunca un halo de acento">
      <div className="cocoa-stack" data-gap="4">
        <div className="cocoa-row" data-align="start" data-gap="4">
          {SHADOW_TOKENS.map((row) => (
            <div key={row.token} className="cocoa-stack" data-gap="2" style={{ flex: "1 1 160px", maxWidth: 240 }}>
              <div aria-hidden="true" style={{ height: 72, borderRadius: "var(--cocoa-radius-lg)", background: "var(--cocoa-background-content)", boxShadow: `var(${row.token})` }} />
              <Mono>{row.token.replace("--cocoa-shadow-", "shadow-")}</Mono>
              <Note as="span">{row.use}</Note>
              <Mono tertiary wrap>{declarations.get(row.token)?.computed || "—"}</Mono>
            </div>
          ))}
        </div>
        <CodeSample code={SHADOW_SAMPLE} />
      </div>
    </CocoaSection>
  );
}

function MotionSection() {
  const declarations = useMemo(() => readTokenDeclarations([...MOTION_TOKENS, ...Z_TOKENS]), []);
  const valueOf = (token: string) => declarations.get(token)?.computed || declarations.get(token)?.light || "—";
  const [replay, setReplay] = useState(0);
  return (
    <CocoaSection
      id="guia-tokens-motion"
      headingLevel={2}
      title="Tokens · Motion y capas"
      meta="Compositor-only, 100–400 ms; z-index solo por token"
      action={
        <CocoaButton variant="plain" tone="accent" size="small" onClick={() => setReplay((current) => current + 1)}>
          Reproducir entrada
        </CocoaButton>
      }
    >
      <CocoaGrid gap={4} align="start">
        <CocoaSpan cols={7} min={320}>
          <div className="cocoa-stack" data-gap="3">
            <CocoaKpiStrip key={replay} stagger min={180} aria-label="Demostración de entrada escalonada">
              {["Ocupación", "ADR", "RevPAR", "Pickup", "Riesgo", "NPS"].map((label, index) => (
                <CocoaKpi key={label} label={label} value={number(40 + index * 7)} size="compact" status={index % 3 === 0 ? "ok" : index % 3 === 1 ? "warning" : "critical"} />
              ))}
            </CocoaKpiStrip>
            <div className="cocoa-stack" data-gap="1">
              {MOTION_TOKENS.map((token) => (
                <div key={token} className="cocoa-row" data-justify="between" data-gap="3">
                  <Mono>{token}</Mono>
                  <Note as="span">{valueOf(token)}</Note>
                </div>
              ))}
            </div>
          </div>
        </CocoaSpan>
        <CocoaSpan cols={5} min={240}>
          <div className="cocoa-stack" data-gap="1">
            <Caption>Capas (z-index)</Caption>
            {Z_TOKENS.map((token) => (
              <div key={token} className="cocoa-row" data-justify="between" data-gap="3">
                <Mono>{token}</Mono>
                <Note as="span" className="cocoa-tabular">{valueOf(token)}</Note>
              </div>
            ))}
            <Note>Ningún componente escribe un z-index numérico; drawer, diálogo, toast y popover consumen estos tokens.</Note>
          </div>
        </CocoaSpan>
        <CocoaSpan cols={12}>
          <CodeSample code={MOTION_SAMPLE} />
        </CocoaSpan>
      </CocoaGrid>
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const BUTTON_VARIANTS: CocoaButtonVariant[] = ["filled", "tinted", "bordered", "plain"];
const BUTTON_TONES: CocoaButtonTone[] = ["accent", "neutral", "destructive"];
const BUTTON_SIZES: CocoaButtonSize[] = ["small", "regular", "large"];

const BUTTON_SAMPLE = `<CocoaButton variant="filled" tone="accent" icon={<PlusIcon size={14} />}>Nueva reserva</CocoaButton>
<CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>Actualizar</CocoaButton>
<CocoaButton variant="plain" tone="destructive" loading={busy}>Eliminar</CocoaButton>
<CocoaButton variant="plain" tone="neutral" aria-label="Avisos" icon={<BellIcon size={16} />} />   // icono solo: aria-label obligatorio
<CocoaButton variant="plain" tone="neutral">Buscar <CocoaKbd>⌘K</CocoaKbd></CocoaButton>`;

function ButtonsSection() {
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();
  const simulate = () => {
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      showToast("Acción completada", { variant: "success" });
    }, 900);
  };
  return (
    <CocoaSection id="guia-botones" headingLevel={2} title="Botones · CocoaButton" meta="4 variantes × 3 tonos × 3 tamaños · icono, carga, deshabilitado, solo icono">
      <div className="cocoa-stack" data-gap="4">
        <div className="cocoa-stack" data-gap="2">
          {BUTTON_VARIANTS.map((variant) => (
            <div key={variant} className="cocoa-row" data-gap="2">
              <Caption minWidth={72}>{variant}</Caption>
              {BUTTON_TONES.map((tone) => (
                <CocoaButton key={tone} variant={variant} tone={tone}>
                  {tone === "accent" ? "Guardar" : tone === "neutral" ? "Cancelar" : "Eliminar"}
                </CocoaButton>
              ))}
              <CocoaButton variant={variant} tone="accent" disabled>
                Deshabilitado
              </CocoaButton>
            </div>
          ))}
        </div>
        <div className="cocoa-row" data-gap="2" data-align="end">
          <Caption minWidth={72}>tamaños</Caption>
          {BUTTON_SIZES.map((size) => (
            <CocoaButton key={size} variant="bordered" tone="neutral" size={size}>
              {size === "small" ? "Small · 22 px" : size === "regular" ? "Regular · 28 px" : "Large · 34 px"}
            </CocoaButton>
          ))}
        </div>
        <div className="cocoa-row" data-gap="2">
          <Caption minWidth={72}>estados</Caption>
          <CocoaButton variant="filled" tone="accent" icon={<PlusIcon size={14} />}>
            Nueva reserva
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" icon={<DownloadIcon size={14} />} iconPosition="right">
            Exportar
          </CocoaButton>
          <CocoaButton variant="tinted" tone="accent" loading={busy} onClick={simulate}>
            {busy ? "Guardando…" : "Simular carga"}
          </CocoaButton>
          <CocoaButton variant="plain" tone="neutral" aria-label="Avisos" title="Avisos" icon={<BellIcon size={16} />} />
          <CocoaButton variant="plain" tone="destructive" aria-label="Eliminar" title="Eliminar" icon={<TrashIcon size={14} />} />
          <CocoaButton variant="plain" tone="neutral">
            Buscar <CocoaKbd>⌘K</CocoaKbd>
          </CocoaButton>
        </div>
        <Note>Foco: halo de 3 px Esmeralda vía <Mono>.cocoa-focus-ring:focus-visible</Mono>. En pantallas migradas no queda ningún botón nativo crudo.</Note>
        <CodeSample code={BUTTON_SAMPLE} />
      </div>
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

const FIELDS_SAMPLE = `<CocoaField label="Nombre comercial" required help="Como aparece en la factura" error={errors.name}>
  <CocoaInput value={name} onChange={setName} placeholder="Hotel Rías Altas" />
</CocoaField>
<CocoaField label="Canal" hint="opcional">
  <CocoaSelect value={channel} onChange={setChannel} options={CHANNELS} placeholder="Selecciona un canal" />
</CocoaField>
<CocoaField inline label="Publicar en el motor">
  <CocoaSwitch checked={published} onChange={setPublished} />
</CocoaField>
<CocoaField label="Llegada"><CocoaDatePicker value={arrival} onChange={setArrival} min={today} /></CocoaField>
<CocoaField label="Noches mínimas"><CocoaStepper value={minNights} onChange={setMinNights} min={1} max={14} /></CocoaField>`;

const CHANNEL_OPTIONS = [
  { value: "direct", label: "Directo" },
  { value: "booking", label: "Booking.com" },
  { value: "expedia", label: "Expedia" },
  { value: "agency", label: "Agencia", disabled: true }
];

function FieldsSection() {
  const [text, setText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [amount, setAmount] = useState("120");
  const [notes, setNotes] = useState("");
  const [channel, setChannel] = useState("");
  const [arrival, setArrival] = useState(TODAY.toISOString().slice(0, 10));
  const [nights, setNights] = useState(2);
  const [enabled, setEnabled] = useState(true);
  const [small, setSmall] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState("lista");
  return (
    <CocoaSection id="guia-campos" headingLevel={2} title="Campos · CocoaField + controles" meta="Input, textarea, select, switch, fecha, stepper, búsqueda y segmented; 16 px en táctil">
      <div className="cocoa-stack" data-gap="4">
        <CocoaFormRow columns={3} min={220}>
          <CocoaField label="Texto" help="Ayuda en callout secondary">
            <CocoaInput value={text} onChange={setText} placeholder="Escribe algo" />
          </CocoaField>
          <CocoaField label="Con error" required error={errorText.trim() ? undefined : "Este campo es obligatorio"}>
            <CocoaInput value={errorText} onChange={setErrorText} placeholder="Vacío = error" error={!errorText.trim()} />
          </CocoaField>
          <CocoaField label="Importe" hint="decimal">
            <CocoaInput value={amount} onChange={setAmount} inputMode="decimal" rightSlot={<Note as="span">€</Note>} />
          </CocoaField>
          <CocoaField label="Con icono">
            <CocoaInput value={query} onChange={setQuery} icon={<SearchIcon size={14} />} placeholder="Buscar huésped" />
          </CocoaField>
          <CocoaField label="Solo lectura">
            <CocoaInput value="RA-10412" onChange={() => undefined} readOnly />
          </CocoaField>
          <CocoaField label="Deshabilitado">
            <CocoaInput value="No editable" onChange={() => undefined} disabled />
          </CocoaField>
          <CocoaField label="Pequeño (22 px)">
            <CocoaInput value={text} onChange={setText} size="small" placeholder="small" />
          </CocoaField>
          <CocoaField label="Grande (34 px)">
            <CocoaInput value={text} onChange={setText} size="large" placeholder="large" />
          </CocoaField>
          <CocoaField label="Selector" hint="opcional">
            <CocoaSelect value={channel} onChange={setChannel} options={CHANNEL_OPTIONS} placeholder="Selecciona un canal" />
          </CocoaField>
          <CocoaField label="Selector con error">
            <CocoaSelect value="" onChange={() => undefined} options={CHANNEL_OPTIONS} placeholder="Obligatorio" error />
          </CocoaField>
          <CocoaField label="Fecha">
            <CocoaDatePicker value={arrival} onChange={setArrival} />
          </CocoaField>
          <CocoaField label="Contador">
            <CocoaStepper value={nights} onChange={setNights} min={1} max={14} />
          </CocoaField>
          <CocoaField inline label="Interruptor (inline)">
            <CocoaSwitch checked={enabled} onChange={setEnabled} />
          </CocoaField>
          <CocoaField inline label="Interruptor pequeño">
            <CocoaSwitch checked={small} onChange={setSmall} size="small" />
          </CocoaField>
          <CocoaField inline label="Interruptor deshabilitado">
            <CocoaSwitch checked onChange={() => undefined} disabled />
          </CocoaField>
          <CocoaField label="Texto largo" fullWidth>
            <CocoaInput value={notes} onChange={setNotes} multiline rows={3} placeholder="Notas internas (textarea = CocoaInput multiline)" />
          </CocoaField>
        </CocoaFormRow>
        <div className="cocoa-row" data-gap="3">
          <CocoaSearchInput value={query} onChange={setQuery} placeholder="Búsqueda con retardo" onClear={() => setQuery("")} />
          <CocoaSegmentedControl
            value={view}
            onChange={setView}
            options={[
              { value: "lista", label: "Lista" },
              { value: "cronograma", label: "Cronograma" },
              { value: "mapa", label: "Mapa", disabled: true }
            ]}
            aria-label="Vista"
          />
          <CocoaSegmentedControl size="small" value={view} onChange={setView} options={[{ value: "lista", label: "Lista" }, { value: "cronograma", label: "Cronograma" }]} aria-label="Vista pequeña" />
        </div>
        <CodeSample code={FIELDS_SAMPLE} />
      </div>
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Form archetype (sections + rows + action bar)
// ---------------------------------------------------------------------------

const FORM_SAMPLE = `<CocoaPage eyebrow="Revenue · Rías Altas" title="Plan tarifario" subtitle="Identidad y condiciones">
  <CocoaFormSection title="Identidad" description="Nombre y código del plan" columns={2}>
    <CocoaField label="Nombre" required error={errors.name}><CocoaInput value={name} onChange={setName} /></CocoaField>
    <CocoaField label="Código" help="Mayúsculas, sin espacios"><CocoaInput value={code} onChange={setCode} /></CocoaField>
  </CocoaFormSection>
  <CocoaActionBar
    status={dirty ? "Cambios sin guardar" : "Guardado a las 10:12"}
    secondary={{ label: "Cancelar", onClick: reset }}
    primary={{ label: "Guardar", loading: saving, onClick: save }}   // Ctrl/⌘ + Enter
  />
  <CocoaActionBar mobileOnly primary={{ label: "Guardar", onClick: save }} />   // < 600 px: fija abajo; en escritorio no se pinta
</CocoaPage>`;

function FormSection() {
  const { showToast } = useToast();
  const [name, setName] = useState("Tarifa flexible");
  const [code, setCode] = useState("FLEX");
  const [channel, setChannel] = useState("direct");
  const [price, setPrice] = useState("129");
  const [minNights, setMinNights] = useState(1);
  const [published, setPublished] = useState(true);
  const [notes, setNotes] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [mobileBar, setMobileBar] = useState(false);
  const isNarrow = useIsNarrow();
  const nameError = submitted && !name.trim() ? "Indica un nombre" : undefined;
  const codeError = submitted && !/^[A-Z0-9-]{2,12}$/.test(code) ? "Código en mayúsculas, sin espacios (2–12)" : undefined;
  const save = () => {
    setSubmitted(true);
    if (!name.trim() || !/^[A-Z0-9-]{2,12}$/.test(code)) {
      showToast("Revisa los campos marcados", { variant: "warning" });
      return;
    }
    setSaving(true);
    window.setTimeout(() => {
      setSaving(false);
      setSavedAt(new Date());
      showToast("Plan tarifario guardado", { variant: "success" });
    }, 800);
  };
  const reset = () => {
    setName("Tarifa flexible");
    setCode("FLEX");
    setChannel("direct");
    setPrice("129");
    setMinNights(1);
    setPublished(true);
    setNotes("");
    setSubmitted(false);
  };
  return (
    <CocoaSection id="guia-formulario" headingLevel={2} title="Formulario · CocoaFormSection + CocoaActionBar" meta="Validación en el campo, guardado optimista con toast, Ctrl/⌘ + Enter dispara la primaria" padding="none">
      <div className="cocoa-stack" data-gap="4" style={{ padding: "var(--cocoa-space-4)" }}>
        <CocoaFormSection title="Identidad" description="Nombre visible y código interno del plan" columns={2}>
          <CocoaField label="Nombre" required error={nameError}>
            <CocoaInput value={name} onChange={setName} error={Boolean(nameError)} />
          </CocoaField>
          <CocoaField label="Código" required help="Mayúsculas, sin espacios" error={codeError}>
            <CocoaInput value={code} onChange={(value) => setCode(value.toUpperCase())} error={Boolean(codeError)} maxLength={12} />
          </CocoaField>
        </CocoaFormSection>
        <CocoaFormSection title="Condiciones" description="Canal, precio base y estancia mínima" columns={2}>
          <CocoaField label="Canal">
            <CocoaSelect value={channel} onChange={setChannel} options={CHANNEL_OPTIONS} />
          </CocoaField>
          <CocoaField label="Precio base" hint="por noche">
            <CocoaInput value={price} onChange={setPrice} inputMode="decimal" rightSlot={<Note as="span">€</Note>} />
          </CocoaField>
          <CocoaField label="Noches mínimas">
            <CocoaStepper value={minNights} onChange={setMinNights} min={1} max={14} />
          </CocoaField>
          <CocoaField inline label="Publicar en el motor de reservas">
            <CocoaSwitch checked={published} onChange={setPublished} />
          </CocoaField>
          <CocoaField label="Notas internas" fullWidth>
            <CocoaInput value={notes} onChange={setNotes} multiline rows={2} />
          </CocoaField>
        </CocoaFormSection>
        <div className="cocoa-row" data-gap="3">
          <CocoaSwitch size="small" checked={mobileBar} onChange={setMobileBar} label="Barra solo móvil (mobileOnly)" />
          <Note as="span">
            {mobileBar
              ? isNarrow
                ? "Visible: fija abajo, botones a ancho completo, safe-area; el contenido se despeja por encima."
                : "Activa pero oculta: en ≥ 600 px la página conserva sus acciones de cabecera. Estrecha la ventana para verla."
              : "Apagada. Para pantallas cuyo escritorio ya tiene las acciones en la cabecera."}
          </Note>
        </div>
        <CodeSample code={FORM_SAMPLE} />
      </div>
      <CocoaActionBar
        sticky={false}
        status={savedAt ? `Guardado a las ${date(savedAt, "short")}` : submitted ? "Cambios sin guardar" : `Precio ${money(price)} · ${number(minNights)} noche(s) mín.`}
        secondary={{ label: "Cancelar", onClick: reset }}
        primary={{ label: "Guardar", loading: saving, onClick: save }}
        aria-label="Acciones del formulario de ejemplo"
      />
      {mobileBar ? <CocoaActionBar mobileOnly status="mobileOnly · fija abajo con safe-area" primary={{ label: "Ocultar barra", onClick: () => setMobileBar(false) }} aria-label="Barra de acciones solo móvil de ejemplo" /> : null}
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Badges & callouts
// ---------------------------------------------------------------------------

const BADGE_VARIANTS: CocoaBadgeVariant[] = ["outline", "tinted", "dot"];

const BADGE_SAMPLE = `<CocoaBadge tone="success">Confirmada</CocoaBadge>                      // outline, caption uppercase
<CocoaBadge tone="warning" variant="tinted">3 indicadores no disponibles</CocoaBadge>
<CocoaBadge tone="accent" variant="dot" uppercase={false}>En casa</CocoaBadge>  // pill con punto
<CocoaBadge tone="ai" size="small" icon={<SparkleIcon size={10} />}>IA</CocoaBadge>
<CocoaCallout tone="warning" title="Sin feed externo">Activa la integración para ver el comp-set.</CocoaCallout>
<CocoaCallout tone="accent" variant="banner" actions={<CocoaButton size="small">Ver qué falta</CocoaButton>}>Puesta en marcha pendiente</CocoaCallout>
<CocoaCallout tone="neutral" role="note" title="Cómo se calcula">…</CocoaCallout>   // danger → alert · resto → status · note = ayuda estática, no se anuncia`;

function BadgesSection() {
  return (
    <CocoaSection id="guia-badges" headingLevel={2} title="Badges y avisos · CocoaBadge + CocoaCallout" meta="7 tonos × outline / tinted / dot × 2 tamaños · callout inline y banner">
      <div className="cocoa-stack" data-gap="4">
        <div className="cocoa-stack" data-gap="2">
          {COCOA_TONES.map((tone) => (
            <div key={tone} className="cocoa-row" data-gap="2">
              <Caption minWidth={72}>{tone}</Caption>
              {BADGE_VARIANTS.map((variant) => (
                <CocoaBadge key={variant} tone={tone} variant={variant}>
                  {variant === "dot" ? TONE_LABEL[tone] : variant}
                </CocoaBadge>
              ))}
              <CocoaBadge tone={tone} variant="tinted" size="small">
                small
              </CocoaBadge>
              <CocoaBadge tone={tone} variant="outline" size="small" icon={tone === "ai" ? <SparkleIcon size={10} /> : <CheckCircleIcon size={10} />}>
                icono
              </CocoaBadge>
            </div>
          ))}
        </div>
        <CocoaGrid gap={3} align="start">
          {COCOA_TONES.map((tone) => (
            <CocoaSpan key={tone} cols={4} min={240}>
              <CocoaCallout tone={tone} title={`Callout ${TONE_LABEL[tone].toLowerCase()}`} icon={tone === "danger" ? <ExclamationCircleIcon size={14} /> : tone === "ai" ? <SparkleIcon size={14} /> : <InfoCircleIcon size={14} />}>
                Texto corto, verbo primero en la acción. Tono solo en la barra y el icono.
              </CocoaCallout>
            </CocoaSpan>
          ))}
        </CocoaGrid>
        <CocoaCallout
          tone="accent"
          variant="banner"
          title="Puesta en marcha pendiente"
          actions={
            <>
              <CocoaButton variant="filled" tone="accent" size="small">
                Ver qué falta
              </CocoaButton>
              <CocoaButton variant="bordered" tone="neutral" size="small">
                Más tarde
              </CocoaButton>
            </>
          }
        >
          Variante banner: la que usa el shell bajo la barra superior.
        </CocoaCallout>
        <CocoaCallout tone="neutral" role="note" title="Nota de ayuda (role=note)" icon={<InfoCircleIcon size={14} />}>
          Por defecto <Mono>danger</Mono> anuncia (role=alert) y el resto es cortés (role=status); <Mono>role=&quot;note&quot;</Mono> es para texto de ayuda estático que no debe anunciarse al lector de pantalla.
        </CocoaCallout>
        <CodeSample code={BADGE_SAMPLE} />
      </div>
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// KPI
// ---------------------------------------------------------------------------

const KPI_SAMPLE = `<CocoaKpiStrip stagger>
  <CocoaKpi label="Ocupación" value={percent(67.4)} delta={3.2} deltaUnit="pp" deltaLabel="vs LY" polarity="positive-good" sparkline={occ} status="ok" />
  <CocoaKpi label="ADR" value={money(118.4)} delta={-2.4} deltaUnit="%" deltaLabel="vs LY" status="warning" sparkline={adr} />
  <CocoaKpi label="Cancelaciones" value={number(12)} delta={-8} deltaUnit="%" polarity="negative-good" status="ok" />
  <CocoaKpi label="Comp-set" value="—" degraded />                               // «—» con tooltip, nunca un 0 verde
  <CocoaKpi label="Pendientes" value={number(4)} size="compact" icon={<ClockIcon size={14} />} onClick={openQueue} />
</CocoaKpiStrip>
<CocoaDelta delta={12} unit="%" label="vs ayer" polarity="positive-good" />
<CocoaStat label="Ingresos" value={money(48210, { decimals: 0 })} hint="Mes en curso" tone="success" />`;

function KpiSection() {
  const { showToast } = useToast();
  const degraded = ["compset"];
  return (
    <CocoaSection id="guia-kpi" headingLevel={2} title="KPI · CocoaKpiStrip, CocoaKpi, CocoaDelta, CocoaStat" meta="Tile del canon: barra 3 px, etiqueta caption, cifra 32 px tabular, delta con polaridad, sparkline 60×20">
      <div className="cocoa-stack" data-gap="4">
        <CocoaKpiStrip aria-label="Indicadores de ejemplo">
          <CocoaKpi label="Ocupación" value={percent(67.4)} delta={3.2} deltaUnit="pp" deltaLabel="vs LY" polarity="positive-good" sparkline={SPARK_UP} status="ok" />
          <CocoaKpi label="ADR" value={money(118.4)} delta={-2.4} deltaUnit="%" deltaLabel="vs LY" polarity="positive-good" sparkline={SPARK_DOWN} status="warning" />
          <CocoaKpi label="RevPAR" value={money(79.8)} delta={-6.1} deltaUnit="%" deltaLabel="vs LY" polarity="positive-good" sparkline={SPARK_DOWN} status="critical" />
          <CocoaKpi label="Cancelaciones" value={number(12)} delta={-8} deltaUnit="%" deltaLabel="vs LY" polarity="negative-good" sparkline={SPARK_FLAT} status="ok" />
          <CocoaKpi label="Comp-set" value="—" degraded />
        </CocoaKpiStrip>
        <CocoaKpiStrip min={200} aria-label="Indicadores compactos de ejemplo">
          <CocoaKpi label="Pendientes" value={number(4)} unit="reservas" size="compact" icon={<ClockIcon size={14} />} onClick={() => showToast("Abriría la cola de pendientes", { variant: "info" })} />
          <CocoaKpi label="Llegadas hoy" value={number(23)} size="compact" delta={0} deltaUnit="%" deltaLabel="vs ayer" polarity="neutral" />
          <CocoaKpi label="Sin estado" value={percent(12.5)} size="compact" sparkline={SPARK_FLAT} />
          <CocoaKpi label="Cifra en tono" value={money(1240)} size="compact" tone="danger" delta={18} deltaUnit="%" polarity="negative-good" />
        </CocoaKpiStrip>
        <div className="cocoa-row" data-gap="4">
          <Caption minWidth={72}>delta</Caption>
          <CocoaDelta delta={12} unit="%" label="vs ayer" polarity="positive-good" />
          <CocoaDelta delta={-4.5} unit="pp" label="vs LY" polarity="positive-good" />
          <CocoaDelta delta={-4.5} unit="%" label="vs LY" polarity="negative-good" />
          <CocoaDelta delta={0} unit="%" label="sin cambio" polarity="neutral" />
          <CocoaDelta unit="%" label="sin dato" />
        </div>
        <div className="cocoa-row" data-align="start" data-gap="4">
          <Caption minWidth={72}>stat</Caption>
          <CocoaStat label="Ingresos" value={money(48210, { decimals: 0 })} hint="Mes en curso" tone="success" />
          <CocoaStat label="Con sufijo" value={number(1234)} suffix=",50 €" />
          <CocoaStat label="Grande" value={percent(92.3)} size="large" />
          <CocoaStat label="Derecha" value={money(-320)} tone="danger" align="right" hint="Reembolsos" />
          <CocoaStat label="Texto" value="Alta" tabular={false} hint="Demanda" tone="warning" />
          <CocoaStat
            label="Degradado"
            value={
              <DegradedValue label="compset" degraded={degraded}>
                {number(3)}
              </DegradedValue>
            }
            hint="Comp-set"
          />
        </div>
        <div className="cocoa-row" data-gap="3">
          <DegradedBanner degraded={degraded} />
          <DegradedNote label="compset" degraded={degraded}>
            Esta nota solo se pinta si el indicador está disponible.
          </DegradedNote>
        </div>
        <CodeSample code={KPI_SAMPLE} />
      </div>
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Cards & sections
// ---------------------------------------------------------------------------

const CARD_SAMPLE = `<CocoaSection title="Pace próximos 30 días" meta="OTB · Forecast · LY" action={<CocoaButton variant="plain" size="small">Ver detalle</CocoaButton>}>
  <CocoaChart.Line series={pace} />
</CocoaSection>
<CocoaSection title="Anomalías" scroll="y" maxHeight={200} footer={<CocoaButton variant="plain" size="small">Ver todas</CocoaButton>}>…</CocoaSection>
<CocoaCard variant="elevated" padding="md" onClick={open} aria-label="Abrir reserva">…</CocoaCard>   // hover → window shadow, −2 px`;

function CardsSection() {
  const { showToast } = useToast();
  return (
    <CocoaSection id="guia-tarjetas" headingLevel={2} title="Tarjetas y secciones · CocoaCard + CocoaSection" meta="bordered (por defecto) · elevated (destacada / interactiva) · plain · cabecera title-3 + caption">
      <div className="cocoa-stack" data-gap="4">
        <CocoaGrid gap={3} align="start">
          <CocoaSpan cols={4} min={240}>
            <CocoaCard variant="bordered" padding="md">
              <div className="cocoa-stack" data-gap="1">
                <Caption>bordered</Caption>
                <Note>Fondo content, borde separator, sombra control, radio 12, padding 16.</Note>
              </div>
            </CocoaCard>
          </CocoaSpan>
          <CocoaSpan cols={4} min={240}>
            <CocoaCard variant="elevated" padding="md" onClick={() => showToast("Tarjeta interactiva pulsada", { variant: "info" })} aria-label="Tarjeta interactiva de ejemplo">
              <div className="cocoa-stack" data-gap="1">
                <Caption>elevated · interactiva</Caption>
                <Note>Sombra card; al pasar el ratón sube 2 px con sombra window. Enter / Espacio la activan.</Note>
              </div>
            </CocoaCard>
          </CocoaSpan>
          <CocoaSpan cols={4} min={240}>
            <CocoaCard variant="plain" padding="sm">
              <div className="cocoa-stack" data-gap="1">
                <Caption>plain · padding sm</Caption>
                <Note>Sin borde ni sombra: solo para tiles dentro de otra tarjeta.</Note>
              </div>
            </CocoaCard>
          </CocoaSpan>
        </CocoaGrid>
        <CocoaGrid gap={3} align="start">
          <CocoaSpan cols={6} min={320}>
            <CocoaSection
              title="Sección con cabecera"
              meta="datos a 08:12"
              action={
                <CocoaButton variant="plain" tone="accent" size="small">
                  Ver detalle
                </CocoaButton>
              }
              footer={<Note as="span">Pie de sección: totales o enlace secundario.</Note>}
            >
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {[
                  ["Llegadas", number(23)],
                  ["Salidas", number(19)],
                  ["En casa", number(64)]
                ].map(([label, value]) => (
                  <li key={label} className="cocoa-row" data-justify="between" style={{ padding: "var(--cocoa-space-2) 0", borderBottom: "1px solid var(--cocoa-separator)" }}>
                    <span>{label}</span>
                    <strong className="cocoa-tabular">{value}</strong>
                  </li>
                ))}
              </ul>
            </CocoaSection>
          </CocoaSpan>
          <CocoaSpan cols={6} min={320}>
            <CocoaSection title="Sección con scroll vertical" meta="maxHeight 160" scroll="y" maxHeight={160}>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {Array.from({ length: 12 }, (_, index) => (
                  <li key={index} className="cocoa-row" data-justify="between" style={{ padding: "var(--cocoa-space-2) 0", borderBottom: "1px solid var(--cocoa-separator)" }}>
                    <span>Anomalía {number(index + 1)}</span>
                    <CocoaBadge tone={index % 4 === 0 ? "danger" : index % 3 === 0 ? "warning" : "neutral"} size="small">
                      {index % 4 === 0 ? "alta" : index % 3 === 0 ? "media" : "baja"}
                    </CocoaBadge>
                  </li>
                ))}
              </ul>
            </CocoaSection>
          </CocoaSpan>
        </CocoaGrid>
        <CodeSample code={CARD_SAMPLE} />
      </div>
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

const GRID_ROWS: ReadonlyArray<ReadonlyArray<{ cols: CocoaSpanCols; min: number }>> = [
  [
    { cols: 8, min: 480 },
    { cols: 2, min: 200 },
    { cols: 2, min: 200 }
  ],
  [
    { cols: 4, min: 320 },
    { cols: 4, min: 320 },
    { cols: 2, min: 200 },
    { cols: 2, min: 200 }
  ],
  [
    { cols: 3, min: 240 },
    { cols: 3, min: 240 },
    { cols: 3, min: 240 },
    { cols: 3, min: 240 }
  ],
  [
    { cols: 5, min: 320 },
    { cols: 4, min: 320 },
    { cols: 3, min: 240 }
  ]
];

const GRID_SAMPLE = `<CocoaGrid stagger>                                   // 12 col · gap 12 (canon)
  <CocoaSpan cols={8} min={480}><CocoaSection title="Pace">…</CocoaSection></CocoaSpan>
  <CocoaSpan cols={2} min={200}><CocoaSection title="Pickup 7d">…</CocoaSection></CocoaSpan>
  <CocoaSpan cols={2} min={200}><CocoaSection title="Riesgo">…</CocoaSection></CocoaSpan>
</CocoaGrid>
// < 600 px → 1 columna · 600–899 → spans < 6 pasan a 6 · < 912 px de contenido → «min» promociona · ≥ 912 spans reales
<CocoaGrid columns={4} gap={3} align="start">          // 6 | 4 columnas para tiras de tiles · align start = sin estirar
  <CocoaSpan cols={1} rowSpan={2}>…</CocoaSpan>       // ocupa dos filas
</CocoaGrid>
<CocoaSkeleton.Grid rows={[[8, 2, 2], [4, 4, 2, 2]]} />   // esqueleto espejo (sin CLS)`;

const TIER_LABEL = { phone: "teléfono (< 600)", tablet: "tableta (600–899)", laptop: "portátil (900–1199)", desktop: "escritorio (≥ 1200)" } as const;

function GridSection() {
  const tier = useViewportTier();
  const [gridAlign, setGridAlign] = useState<"start" | "stretch">("stretch");
  return (
    <CocoaSection id="guia-rejilla" headingLevel={2} title="Rejilla · CocoaGrid + CocoaSpan" meta={`Filas canónicas del director: 8/2/2 · 4/4/2/2 · 3×4 · 5/4/3 — ahora: ${TIER_LABEL[tier]}`}>
      <div className="cocoa-stack" data-gap="4">
        {GRID_ROWS.map((row, rowIndex) => (
          <CocoaGrid key={rowIndex} stagger>
            {row.map((cell, index) => (
              <CocoaSpan key={`${rowIndex}-${index}`} cols={cell.cols} min={cell.min}>
                <DemoBox surface>
                  <span className="cocoa-tabular">
                    {number(cell.cols)} col · min {number(cell.min)}
                  </span>
                </DemoBox>
              </CocoaSpan>
            ))}
          </CocoaGrid>
        ))}
        <div className="cocoa-stack" data-gap="2">
          <Caption>columns=6 · gap 2 · tiras de tiles (en teléfono, 1 por fila)</Caption>
          <CocoaGrid columns={6} gap={2} aria-label="Rejilla de 6 columnas de ejemplo">
            {Array.from({ length: 6 }, (_, index) => (
              <CocoaSpan key={index} cols={1}>
                <DemoBox surface>{number(index + 1)}</DemoBox>
              </CocoaSpan>
            ))}
            <CocoaSpan cols={3}>
              <DemoBox surface>3 col</DemoBox>
            </CocoaSpan>
            <CocoaSpan cols={3}>
              <DemoBox surface>3 col</DemoBox>
            </CocoaSpan>
          </CocoaGrid>
        </div>
        <div className="cocoa-stack" data-gap="2">
          <div className="cocoa-row" data-justify="between" data-gap="2">
            <Caption>columns=4 · rowSpan=2 · align</Caption>
            <CocoaSegmentedControl
              size="small"
              value={gridAlign}
              onChange={(value) => setGridAlign(value as "start" | "stretch")}
              options={[
                { value: "stretch", label: "stretch" },
                { value: "start", label: "start" }
              ]}
              aria-label="Alineación de las celdas"
            />
          </div>
          <CocoaGrid columns={4} gap={3} align={gridAlign} aria-label="Rejilla de 4 columnas con rowSpan de ejemplo">
            <CocoaSpan cols={1} rowSpan={2}>
              <DemoBox surface fill>
                1 col · rowSpan 2
              </DemoBox>
            </CocoaSpan>
            {Array.from({ length: 6 }, (_, index) => (
              <CocoaSpan key={index} cols={1}>
                <DemoBox surface fill>
                  tile {number(index + 1)}
                </DemoBox>
              </CocoaSpan>
            ))}
          </CocoaGrid>
          <Note>
            Con «stretch» (por defecto) cada celda llena la altura de su fila y la celda alta ocupa dos; con «start» cada una conserva la altura de su contenido. En tableta la rejilla de 4 pasa a 2 columnas; en teléfono todo a 1.
          </Note>
        </div>
        <div className="cocoa-stack" data-gap="2">
          <Caption>Esqueleto espejo</Caption>
          <CocoaSkeleton.Grid rows={[[8, 2, 2]] as const} height={72} />
        </div>
        <CodeSample code={GRID_SAMPLE} />
      </div>
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const TABLE_SAMPLE = `const columns: CocoaTableColumn<Row>[] = [
  { key: "id", label: "Reserva", sortable: true },
  { key: "guest", label: "Huésped", sortable: true },
  { key: "arrival", label: "Llegada", render: (r) => date(r.arrival, "short"), hideOnNarrow: true },
  { key: "amount", label: "Importe", align: "right", render: (r) => money(r.amount), footer: money(total) },
  { key: "status", label: "Estado", render: (r) => <CocoaBadge tone={STATUS_TONE[r.status]}>{r.status}</CocoaBadge> }
];
<CocoaSection title="Reservas" padding="none">
  <CocoaTable columns={columns} rows={rows} rowKey="id" sortBy={sort} onSort={setSort}
    selectedKey={selected?.id} onSelect={setSelected} rowActions={(r) => <CocoaButton variant="plain" size="small">Abrir</CocoaButton>}
    footer caption="Reservas de la semana" />
</CocoaSection>
// < 600 px → tarjetas apiladas etiqueta / valor · parrillas anchas → <CocoaScrollArea axis="x" stickyFirstColumn>
<CocoaTable columns={columns} rows={rows} rowKey="id" virtualize maxHeight={320} />   // > 200 filas: 200 y bloques de 100
<CocoaScrollArea axis="y" maxHeight={160} aria-label="Actividad">…</CocoaScrollArea>   // scroller vertical (sin fade)`;

function compareRows(a: ReservationRow, b: ReservationRow, sort: CocoaTableSort): number {
  const direction = sort.direction === "asc" ? 1 : -1;
  const key = sort.key as keyof ReservationRow;
  const left = a[key];
  const right = b[key];
  if (typeof left === "number" && typeof right === "number") return (left - right) * direction;
  return String(left).localeCompare(String(right), "es") * direction;
}

function TablesSection() {
  const isNarrow = useIsNarrow();
  const [sort, setSort] = useState<CocoaTableSort>({ key: "arrival", direction: "asc" });
  const [selected, setSelected] = useState<ReservationRow | null>(null);
  const [loading, setLoading] = useState(false);
  const rows = useMemo(() => [...RESERVATIONS].sort((a, b) => compareRows(a, b, sort)), [sort]);
  const total = RESERVATIONS.filter((row) => row.status !== "cancelada").reduce((sum, row) => sum + row.amount, 0);
  const columns: CocoaTableColumn<ReservationRow>[] = [
    { key: "id", label: "Reserva", sortable: true, minWidth: 110, render: (row) => <Mono>{row.id}</Mono> },
    { key: "guest", label: "Huésped", sortable: true, minWidth: 140 },
    { key: "arrival", label: "Llegada", sortable: true, hideOnNarrow: true, render: (row) => date(row.arrival, "short") },
    { key: "nights", label: "Noches", align: "right", sortable: true, render: (row) => number(row.nights), footer: number(RESERVATIONS.reduce((sum, row) => sum + row.nights, 0)) },
    { key: "amount", label: "Importe", align: "right", sortable: true, render: (row) => money(row.amount), footer: money(total) },
    { key: "channel", label: "Canal", hideOnNarrow: true },
    {
      key: "status",
      label: "Estado",
      render: (row) => (
        <CocoaBadge tone={STATUS_TONE[row.status]} variant={row.status === "en-casa" ? "dot" : "outline"}>
          {STATUS_LABEL[row.status]}
        </CocoaBadge>
      )
    }
  ];
  const wideColumns: CocoaTableColumn<ReservationRow>[] = [
    { key: "id", label: "Reserva", minWidth: 120 },
    ...Array.from({ length: 10 }, (_, index) => ({
      key: `day-${index}`,
      label: date(addDays(TODAY, index), "dayMonth"),
      align: "right" as const,
      minWidth: 96,
      render: (row: ReservationRow) => money(row.amount / row.nights + index * 3)
    }))
  ];
  return (
    <>
      <CocoaSection
        id="guia-tablas"
        headingLevel={2}
        title="Tablas · CocoaTable"
        meta={isNarrow ? "Ahora en tarjetas apiladas (< 600 px)" : "Cabecera sticky sin blur, ordenación, numéricos tabulares a la derecha, totales, acciones, selección; < 600 px → tarjetas"}
        action={
          <CocoaButton variant="plain" tone="accent" size="small" onClick={() => setLoading((current) => !current)}>
            {loading ? "Mostrar datos" : "Simular carga"}
          </CocoaButton>
        }
        padding="none"
      >
        <CocoaTable<ReservationRow>
          columns={columns}
          rows={rows}
          rowKey="id"
          sortBy={sort}
          onSort={setSort}
          selectedKey={selected?.id}
          onSelect={setSelected}
          loading={loading}
          footer
          caption="Reservas de la semana (ejemplo)"
          rowActions={(row) => (
            <CocoaButton variant="plain" tone="accent" size="small" onClick={() => setSelected(row)}>
              Abrir
            </CocoaButton>
          )}
        />
        <div className="cocoa-stack" data-gap="4" style={{ padding: "var(--cocoa-space-4)" }}>
          <div className="cocoa-stack" data-gap="2">
            <Caption>Tabla vacía</Caption>
            <CocoaTable<ReservationRow> columns={columns.slice(0, 3)} rows={[]} rowKey="id" caption="Tabla vacía de ejemplo" emptyState={<CocoaState kind="empty" inline title="Sin reservas para este filtro" message="Amplía el rango de fechas o quita el canal." />} />
          </div>
          <div className="cocoa-stack" data-gap="2">
            <Caption>Parrilla ancha · CocoaScrollArea axis=&quot;x&quot; stickyFirstColumn</Caption>
            <CocoaScrollArea axis="x" stickyFirstColumn aria-label="Parrilla de tarifas de ejemplo">
              <CocoaTable<ReservationRow> columns={wideColumns} rows={RESERVATIONS.slice(0, 3)} rowKey="id" density="compact" caption="Parrilla de ejemplo" style={{ minWidth: 1100 }} />
            </CocoaScrollArea>
          </div>
          <div className="cocoa-stack" data-gap="2">
            <Caption>Lista larga · virtualize · maxHeight 320 · {number(LONG_RESERVATIONS.length)} filas</Caption>
            <CocoaTable<ReservationRow> columns={columns} rows={LONG_RESERVATIONS} rowKey="id" density="compact" virtualize maxHeight={320} caption="Lista larga de ejemplo (250 filas)" />
            <Note>
              Se pintan {number(VIRTUALIZE_THRESHOLD)} filas y, al llegar al final del scroller, bloques de {number(VIRTUALIZE_CHUNK)} (IntersectionObserver; «Mostrar más» como alternativa). En teléfono, tarjetas apiladas con el mismo bloque.
            </Note>
          </div>
          <div className="cocoa-stack" data-gap="2">
            <Caption>Scroll vertical · CocoaScrollArea axis=&quot;y&quot; maxHeight 160</Caption>
            <CocoaScrollArea axis="y" maxHeight={160} aria-label="Registro de actividad de ejemplo">
              <ul className="c22-section__list">
                {LONG_RESERVATIONS.slice(0, 16).map((row) => (
                  <li key={row.id}>
                    <span>
                      {row.guest} · <Mono>{row.id}</Mono>
                    </span>
                    <CocoaBadge tone={STATUS_TONE[row.status]} size="small">
                      {STATUS_LABEL[row.status]}
                    </CocoaBadge>
                  </li>
                ))}
              </ul>
            </CocoaScrollArea>
          </div>
          <CodeSample code={TABLE_SAMPLE} />
        </div>
      </CocoaSection>
      <CocoaDrawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `Reserva ${selected.id}` : "Reserva"}
        subtitle={selected ? `${selected.guest} · ${STATUS_LABEL[selected.status]}` : undefined}
        side={isNarrow ? "bottom" : "right"}
        size="sm"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelected(null)}>
              Cerrar
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => setSelected(null)}>
              Hacer check-in
            </CocoaButton>
          </>
        }
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="3">
            <CocoaStat label="Importe" value={money(selected.amount)} hint={`${number(selected.nights)} noche(s) · ${selected.channel}`} />
            <CocoaStat label="Llegada" value={date(selected.arrival, "medium")} tabular={false} />
            <CocoaBadge tone={STATUS_TONE[selected.status]} variant="tinted">
              {STATUS_LABEL[selected.status]}
            </CocoaBadge>
          </div>
        ) : null}
      </CocoaDrawer>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tabs & content toolbar
// ---------------------------------------------------------------------------

const TABS_SAMPLE = `// Pestañas de página = URL (contenedor de screens/tabs/**):
<CocoaRouteTabs basePath="/recepcion/reservas" defaultTab="lista"
  tabs={[{ key: "lista", label: "Lista", path: "/recepcion/reservas", lazy: () => import("../reservations/ReservationsList") },
         { key: "cronograma", label: "Cronograma", lazy: () => import("../reservations/LiveTimeline") }]} />
// Vistas internas sin URL (≤ 4 opciones): CocoaSegmentedControl
<CocoaPage title="Mi día" tabs={[{ value: "hoy", label: "Hoy" }, { value: "semana", label: "Semana" }]} activeTab={view} onTabChange={setView}>…</CocoaPage>
// Barra de filtros de contenido:
<CocoaToolbar variant="content" leftSlot={<CocoaSearchInput … />} rightSlot={<CocoaSelect … />} />`;

function TabsSection() {
  const [view, setView] = useState("hoy");
  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState("");
  const [range, setRange] = useState("7d");
  return (
    <CocoaSection id="guia-pestanas" headingLevel={2} title="Pestañas y barra de contenido · CocoaSegmentedControl + CocoaToolbar" meta="Pestaña activa 600 sobre content con sombra inset; en teléfono la tira hace scroll con fade">
      <div className="cocoa-stack" data-gap="4">
        <div className="cocoa-row" data-gap="3">
          <CocoaSegmentedControl
            value={view}
            onChange={setView}
            options={[
              { value: "hoy", label: "Hoy" },
              { value: "semana", label: "Semana" },
              { value: "mes", label: "Mes" },
              { value: "trimestre", label: "Trimestre" }
            ]}
            aria-label="Periodo de ejemplo"
          />
          <CocoaSegmentedControl fullWidth value={view} onChange={setView} options={[{ value: "hoy", label: "Hoy" }, { value: "semana", label: "Semana" }]} aria-label="Periodo a ancho completo" style={{ maxWidth: 320 }} />
        </div>
        <div style={{ border: "1px dashed var(--cocoa-separator)", borderRadius: "var(--cocoa-radius-md)" }}>
          <CocoaToolbar
            variant="content"
            aria-label="Filtros de ejemplo"
            leftSlot={
              <>
                <CocoaSearchInput value={query} onChange={setQuery} placeholder="Buscar reserva" onClear={() => setQuery("")} />
                <CocoaSelect value={channel} onChange={setChannel} options={CHANNEL_OPTIONS} placeholder="Todos los canales" size="small" />
              </>
            }
            rightSlot={
              <>
                <CocoaSegmentedControl size="small" value={range} onChange={setRange} options={[{ value: "7d", label: "7 días" }, { value: "30d", label: "30 días" }]} aria-label="Rango" />
                <CocoaButton variant="bordered" tone="neutral" size="small" icon={<DownloadIcon size={12} />}>
                  Exportar
                </CocoaButton>
              </>
            }
          />
        </div>
        <CodeSample code={TABS_SAMPLE} />
      </div>
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Drawer / dialog / sheet / popover
// ---------------------------------------------------------------------------

const OVERLAY_SAMPLE = `<CocoaDrawer open={open} onClose={close} title="Reserva RA-10412" subtitle="Marta Otero · Confirmada" side="right" size="md"
  dismissible={!dirty} initialFocus={() => checkInRef.current}   // flujo obligatorio: Esc y velo no cierran · foco inicial en la primaria
  footer={<><CocoaButton variant="bordered" tone="neutral" onClick={close}>Cerrar</CocoaButton><CocoaButton ref={checkInRef} onClick={checkIn}>Hacer check-in</CocoaButton></>}>…</CocoaDrawer>
<CocoaDialog open={ask} onClose={cancel} tone="destructive" title="¿Eliminar el plan tarifario?"
  description="Se retirará de los canales conectados. Esta acción no se puede deshacer." confirmLabel="Eliminar" onConfirm={remove} busy={removing} />
<CocoaSheet open={preview} onClose={closePreview} title="Vista previa de la importación" size="lg">…</CocoaSheet>
<CocoaPopover open={menu} anchorEl={anchor} placement="bottom" onClose={closeMenu} role="menu">…</CocoaPopover>`;

function OverlaysSection() {
  const { showToast } = useToast();
  const isNarrow = useIsNarrow();
  const [drawerSide, setDrawerSide] = useState<CocoaDrawerSide>("right");
  const [drawerSize, setDrawerSize] = useState<CocoaDrawerSize>("md");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerLocked, setDrawerLocked] = useState(false);
  const [drawerFocusPrimary, setDrawerFocusPrimary] = useState(false);
  const checkInRef = useRef<HTMLButtonElement>(null);
  const [dialogTone, setDialogTone] = useState<CocoaDialogTone | "ack">("primary");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const openDialog = (tone: CocoaDialogTone | "ack") => {
    setDialogTone(tone);
    setDialogOpen(true);
  };
  const confirm = () => {
    setDialogBusy(true);
    window.setTimeout(() => {
      setDialogBusy(false);
      setDialogOpen(false);
      showToast(dialogTone === "destructive" ? "Plan tarifario eliminado" : "Cambios aplicados", { variant: dialogTone === "destructive" ? "warning" : "success" });
    }, 700);
  };
  return (
    <CocoaSection id="guia-capas" headingLevel={2} title="Drawer, diálogo, sheet y popover" meta="Focus trap, Esc, scrim por token, scroll bloqueado; nunca un position: fixed propio">
      <div className="cocoa-stack" data-gap="4">
        <div className="cocoa-row" data-gap="3">
          <Caption minWidth={72}>drawer</Caption>
          <CocoaSegmentedControl size="small" value={drawerSide} onChange={(value) => setDrawerSide(value as CocoaDrawerSide)} options={[{ value: "right", label: "Derecha" }, { value: "left", label: "Izquierda" }, { value: "bottom", label: "Abajo" }]} aria-label="Lado del drawer" />
          <CocoaSegmentedControl size="small" value={drawerSize} onChange={(value) => setDrawerSize(value as CocoaDrawerSize)} options={[{ value: "sm", label: "360" }, { value: "md", label: "480" }, { value: "lg", label: "640" }]} aria-label="Tamaño del drawer" />
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setDrawerOpen(true)}>
            Abrir drawer
          </CocoaButton>
        </div>
        <div className="cocoa-row" data-gap="3">
          <Caption minWidth={72}>opciones</Caption>
          <CocoaSwitch size="small" checked={drawerLocked} onChange={setDrawerLocked} label="No descartable (dismissible=false)" />
          <CocoaSwitch size="small" checked={drawerFocusPrimary} onChange={setDrawerFocusPrimary} label="Foco inicial en «Hacer check-in» (initialFocus)" />
        </div>
        <div className="cocoa-row" data-gap="3">
          <Caption minWidth={72}>diálogo</Caption>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openDialog("primary")}>
            Confirmación
          </CocoaButton>
          <CocoaButton variant="bordered" tone="destructive" size="small" onClick={() => openDialog("destructive")}>
            Destructivo
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openDialog("ack")}>
            Solo aceptar
          </CocoaButton>
        </div>
        <div className="cocoa-row" data-gap="3">
          <Caption minWidth={72}>otros</Caption>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setSheetOpen(true)}>
            Abrir sheet
          </CocoaButton>
          <span ref={anchorRef} style={{ display: "inline-flex" }}>
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setPopoverOpen((current) => !current)} aria-haspopup="menu" aria-expanded={popoverOpen}>
              Abrir popover
            </CocoaButton>
          </span>
        </div>
        <CodeSample code={OVERLAY_SAMPLE} />
      </div>
      <CocoaDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Reserva RA-10412"
        subtitle="Marta Otero · Confirmada"
        side={isNarrow ? "bottom" : drawerSide}
        size={drawerSize}
        dismissible={!drawerLocked}
        initialFocus={drawerFocusPrimary ? () => checkInRef.current : undefined}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setDrawerOpen(false)}>
              Cerrar
            </CocoaButton>
            <CocoaButton ref={checkInRef} variant="filled" tone="accent" onClick={() => setDrawerOpen(false)}>
              Hacer check-in
            </CocoaButton>
          </>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          {drawerLocked ? (
            <CocoaCallout tone="warning" title="Flujo obligatorio">
              Esc y el velo no cierran este drawer (dismissible=false): solo los botones del pie o el aspa de la cabecera.
            </CocoaCallout>
          ) : null}
          <CocoaFormSection title="Estancia" columns={2}>
            <CocoaField label="Llegada">
              <CocoaDatePicker value="2026-09-18" onChange={() => undefined} />
            </CocoaField>
            <CocoaField label="Noches">
              <CocoaStepper value={3} onChange={() => undefined} min={1} />
            </CocoaField>
          </CocoaFormSection>
          <Note>
            En teléfono el drawer siempre sube desde abajo con asa y safe-area.
            {drawerFocusPrimary ? " El foco inicial ha ido a «Hacer check-in» (initialFocus); por defecto va al primer control." : " El foco inicial va al primer control (aquí, la fecha)."}
          </Note>
        </div>
      </CocoaDrawer>
      <CocoaDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        tone={dialogTone === "destructive" ? "destructive" : "primary"}
        hideCancel={dialogTone === "ack"}
        title={dialogTone === "destructive" ? "¿Eliminar el plan tarifario?" : dialogTone === "ack" ? "Exportación en cola" : "¿Aplicar los cambios?"}
        description={
          dialogTone === "destructive"
            ? "Se retirará de los canales conectados. Esta acción no se puede deshacer."
            : dialogTone === "ack"
              ? "Recibirás un aviso cuando el fichero esté listo."
              : "Los precios nuevos se publican en todos los canales conectados."
        }
        confirmLabel={dialogTone === "destructive" ? "Eliminar" : dialogTone === "ack" ? "Entendido" : "Aplicar"}
        onConfirm={confirm}
        busy={dialogBusy}
      />
      <CocoaSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Vista previa de la importación"
        size="md"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setSheetOpen(false)}>
              Cerrar
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => setSheetOpen(false)}>
              Importar
            </CocoaButton>
          </>
        }
      >
        <Note>La sheet baja desde arriba (400 ms) y queda para hojas de importación y previsualización; el resto de paneles son drawers.</Note>
      </CocoaSheet>
      <CocoaPopover open={popoverOpen} anchorEl={anchorRef.current} placement="bottom" onClose={() => setPopoverOpen(false)} role="dialog" aria-label="Popover de ejemplo">
        <div className="cocoa-stack" data-gap="2" style={{ padding: "var(--cocoa-space-3)", minWidth: 200 }}>
          <Caption>Popover</Caption>
          <Note>Sombra popover, radio 8, se cierra con Esc o clic fuera.</Note>
          <CocoaButton variant="plain" tone="accent" size="small" onClick={() => setPopoverOpen(false)}>
            Cerrar
          </CocoaButton>
        </div>
      </CocoaPopover>
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Toast & live region
// ---------------------------------------------------------------------------

const TOAST_SAMPLE = `const { showToast } = useToast();                       // components/Toast (tokens Cocoa, misma API)
showToast("Plan tarifario guardado", { variant: "success" });
showToast("No se pudo guardar", { variant: "error", duration: 8000 });
// Una sola live region por página para «guardado», «N nuevos»:
<CocoaLiveRegion message={\`\${count} reservas nuevas\`} announceKey={count} />
<CocoaLiveRegion message={error} politeness="assertive" />   // role=alert: interrumpe; solo para errores`;

function ToastSection() {
  const { showToast } = useToast();
  const [count, setCount] = useState(0);
  const [politeness, setPoliteness] = useState<"polite" | "assertive">("polite");
  return (
    <CocoaSection id="guia-toast" headingLevel={2} title="Toast y live region · useToast + CocoaLiveRegion" meta="Esquina inferior derecha (arriba y a ancho completo en teléfono), barra 3 px de tono, máx. 3, 4 s">
      <div className="cocoa-stack" data-gap="4">
        <div className="cocoa-row" data-gap="2">
          <CocoaButton variant="bordered" tone="neutral" size="small" icon={<CheckCircleIcon size={12} />} onClick={() => showToast("Cambios guardados", { variant: "success" })}>
            Éxito
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" icon={<InfoCircleIcon size={12} />} onClick={() => showToast("Datos actualizados a las 08:12", { variant: "info" })}>
            Informativo
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" icon={<ExclamationCircleIcon size={12} />} onClick={() => showToast("3 celdas sin guardar", { variant: "warning" })}>
            Aviso
          </CocoaButton>
          <CocoaButton variant="bordered" tone="destructive" size="small" onClick={() => showToast("No se pudo guardar. Reintenta en unos segundos.", { variant: "error", duration: 8000 })}>
            Error (8 s)
          </CocoaButton>
        </div>
        <div className="cocoa-row" data-gap="3">
          <CocoaSegmentedControl
            size="small"
            value={politeness}
            onChange={(value) => setPoliteness(value as "polite" | "assertive")}
            options={[
              { value: "polite", label: "polite" },
              { value: "assertive", label: "assertive" }
            ]}
            aria-label="Cortesía de la live region"
          />
          <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => setCount((current) => current + 1)}>
            Anunciar «reserva nueva»
          </CocoaButton>
          <Note as="span">
            Anunciado {number(count)} veces (role={politeness === "assertive" ? "alert" : "status"}, aria-live={politeness}, visualmente oculta). «assertive» interrumpe lo que se esté leyendo: solo para errores.
          </Note>
          <CocoaLiveRegion message={count > 0 ? `${number(count)} reservas nuevas` : ""} announceKey={count} politeness={politeness} />
        </div>
        <CodeSample code={TOAST_SAMPLE} />
      </div>
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

const SKELETON_VARIANTS: CocoaSkeletonVariant[] = ["text", "title", "kpi", "card", "chart", "row", "avatar", "button"];

const STATE_SAMPLE = `<CocoaPage state={loading ? "loading" : error ? "error" : rows.length ? "ready" : "empty"}
  skeleton={<CocoaSkeleton.Grid rows={[[8, 2, 2], [4, 4, 2, 2]]} />}
  error={{ message: error, onRetry: refresh }}
  empty={{ title: "Sin reservas hoy", message: "Las llegadas aparecerán aquí.", illustration: "box" }}>…</CocoaPage>
<CocoaState kind="empty" inline message="Sin anomalías detectadas." />          // dentro de tarjeta
<CocoaState kind="empty" dashed title="Conectar STR / CoStar" primaryAction={{ label: "Conectar", onClick: connect }} />
<DegradedValue label="occupancy" degraded={degraded}>{percent(occ)}</DegradedValue>  // «—» con tooltip
<DegradedCard label="goppar" degraded={degraded} title="GOPPAR"><CocoaKpi label="GOPPAR" value={money(goppar)} /></DegradedCard>  // hueco de rejilla con «—»`;

function StatesSection() {
  const { showToast } = useToast();
  const retry = () => showToast("Reintentando…", { variant: "info" });
  const [gopparDegraded, setGopparDegraded] = useState(true);
  return (
    <CocoaSection id="guia-estados" headingLevel={2} title="Estados · CocoaState + CocoaSkeleton" meta="Vacío, error, carga y degradado; skeleton neutro (única animación infinita), réplica de la rejilla real">
      <div className="cocoa-stack" data-gap="4">
        <CocoaGrid gap={3} align="start">
          <CocoaSpan cols={4} min={240}>
            <CocoaCard variant="bordered" padding="none">
              <CocoaState kind="empty" illustration="box" title="Sin reservas hoy" message="Las llegadas aparecerán aquí en cuanto entre la primera." primaryAction={{ label: "Nueva reserva", onClick: retry }} secondaryAction={{ label: "Importar", onClick: retry }} />
            </CocoaCard>
          </CocoaSpan>
          <CocoaSpan cols={4} min={240}>
            <CocoaCard variant="bordered" padding="none">
              <CocoaState kind="error" title="No se pudo cargar el pace" message="El servicio de previsión no responde. Reintenta o revisa el log del servidor." onRetry={retry} />
            </CocoaCard>
          </CocoaSpan>
          <CocoaSpan cols={4} min={240}>
            <CocoaCard variant="bordered" padding="none">
              <CocoaState kind="degraded" title="Indicadores parciales" message="El comp-set no está disponible; el resto de datos es real." />
            </CocoaCard>
          </CocoaSpan>
          <CocoaSpan cols={4} min={240}>
            <CocoaCard variant="bordered" padding="none">
              <CocoaState kind="empty" illustration="search" title="Sin resultados" message="Prueba con otro nombre o quita los filtros." />
            </CocoaCard>
          </CocoaSpan>
          <CocoaSpan cols={4} min={240}>
            <CocoaCard variant="bordered" padding="none">
              <CocoaState kind="empty" illustration="connection" title="Sin conexión con el canal" message="Revisa las credenciales de la integración." primaryAction={{ label: "Revisar credenciales", onClick: retry }} />
            </CocoaCard>
          </CocoaSpan>
          <CocoaSpan cols={4} min={240}>
            <CocoaCard variant="bordered" padding="none" style={{ minHeight: 200 }}>
              <CocoaState kind="loading" />
            </CocoaCard>
          </CocoaSpan>
        </CocoaGrid>
        <CocoaGrid gap={3} align="start">
          <CocoaSpan cols={6} min={320}>
            <CocoaSection title="Anomalías" meta="estado inline">
              <CocoaState kind="empty" inline message="Sin anomalías detectadas." />
            </CocoaSection>
          </CocoaSpan>
          <CocoaSpan cols={6} min={320}>
            <CocoaSection title="Comp-set" meta="caja punteada con CTA">
              <CocoaState kind="empty" dashed title="Conectar STR / CoStar" message="Sin feed externo. Activa la integración para comparar tarifas." primaryAction={{ label: "Conectar", onClick: retry }} />
            </CocoaSection>
          </CocoaSpan>
        </CocoaGrid>
        <div className="cocoa-stack" data-gap="2">
          <div className="cocoa-row" data-justify="between" data-gap="2">
            <Caption>DegradedCard · hueco de rejilla que conserva el layout</Caption>
            <CocoaSwitch size="small" checked={gopparDegraded} onChange={setGopparDegraded} label="GOPPAR degradado" />
          </div>
          <CocoaKpiStrip min={200} aria-label="Tiles con DegradedCard de ejemplo">
            <CocoaKpi label="RevPAR" value={money(79.8)} delta={2.1} deltaUnit="%" deltaLabel="vs LY" polarity="positive-good" status="ok" />
            <DegradedCard label="goppar" degraded={gopparDegraded ? ["goppar"] : []} title="GOPPAR">
              <CocoaKpi label="GOPPAR" value={money(41.2)} deltaLabel="proxy" polarity="positive-good" />
            </DegradedCard>
            <CocoaKpi label="Coste laboral" value={money(1860, { decimals: 0 })} deltaLabel="hoy" polarity="negative-good" />
          </CocoaKpiStrip>
          <Note>
            El tile cuyas props solo aceptan números se envuelve en <Mono>DegradedCard</Mono>: si su etiqueta está en <Mono>degraded[]</Mono> pinta una tarjeta con el título y «—» (con tooltip) y la tira no se mueve.
          </Note>
        </div>
        <div className="cocoa-stack" data-gap="2">
          <Caption>Skeleton</Caption>
          <div className="cocoa-row" data-align="start" data-gap="4">
            {SKELETON_VARIANTS.map((variant) => (
              <div key={variant} className="cocoa-stack" data-gap="1" style={{ flex: "1 1 120px", maxWidth: 200 }}>
                <CocoaSkeleton variant={variant} lines={variant === "text" ? 3 : undefined} />
                <Mono>{variant}</Mono>
              </div>
            ))}
          </div>
          <CocoaSkeleton.Strip count={4} />
        </div>
        <CodeSample code={STATE_SAMPLE} />
      </div>
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

const CHART_SAMPLE = `<CocoaChart.Line series={[
  { id: "otb", label: "OTB", points: pace.map((p) => ({ x: p.x, y: p.otb })), tone: "accent", width: 2 },
  { id: "forecast", label: "Previsión", points: …, tone: "warning", dashed: true, width: 2 },
  { id: "ly", label: "Año anterior", points: …, tone: "tertiary", width: 1 }
]} yLabel="hab." tooltip legend aria-label="Pace de los próximos 30 días" />
<CocoaChart.Line series={adr} height={140} legend={false} tooltipTitle={(x) => \`Semana del \${x}\`} />   // sin leyenda, título de tooltip propio
<CocoaChart.Bars data={pickup} polarity="positive-good" valueFormat={(v) => number(v, { signDisplay: "always" })} />
<CocoaChart.Gauge value={risk} thresholds={[30, 60]} label="Riesgo de cancelación" caption="12 reservas en riesgo" />
<CocoaChart.Gauge value={occ} thresholds={[40, 70]} invert label="Ocupación prevista" />   // invert: más alto = mejor
<CocoaChart.Donut slices={mix} centerValue={percent(42)} centerLabel="Directo" />
<CocoaChart.Sparkline values={occ} tone="success" />   ·   <CocoaChart.Progress value={68} label="Ocupación" />`;

function ChartsSection() {
  const lineSeries = useMemo(
    () => [
      { id: "otb", label: "OTB", points: PACE_POINTS.map((point) => ({ x: point.x, y: point.otb })), tone: "accent" as const, width: 2 as const },
      { id: "forecast", label: "Previsión", points: PACE_POINTS.map((point) => ({ x: point.x, y: point.forecast })), tone: "warning" as const, dashed: true, width: 2 as const },
      { id: "ly", label: "Año anterior", points: PACE_POINTS.map((point) => ({ x: point.x, y: point.ly })), tone: "tertiary" as const, width: 1 as const }
    ],
    []
  );
  const adrSeries = useMemo(() => [{ id: "adr", label: "ADR semanal", points: ADR_WEEKS, tone: "accent" as const, width: 2 as const }], []);
  return (
    <CocoaSection id="guia-graficos" headingLevel={2} title="Gráficos · CocoaChart" meta="SVG propio con viewBox + xMidYMid meet, solo var(--cocoa-*), role=img con aria-label">
      <div className="cocoa-stack" data-gap="4">
        <CocoaGrid gap={3} align="start">
          <CocoaSpan cols={8} min={480}>
            <CocoaSection title="Pace próximos 30 días" meta="OTB · Previsión · Año anterior">
              <CocoaChart.Line series={lineSeries} yLabel="hab." tooltip legend aria-label="Pace de los próximos 30 días" />
            </CocoaSection>
          </CocoaSpan>
          <CocoaSpan cols={2} min={200}>
            <CocoaSection title="Pickup 7 días">
              <CocoaChart.Bars data={PICKUP_7D} polarity="positive-good" valueFormat={(value) => number(value, { signDisplay: "always" })} aria-label="Pickup de los últimos 7 días" />
            </CocoaSection>
          </CocoaSpan>
          <CocoaSpan cols={2} min={200}>
            <CocoaSection title="Riesgo de cancelación">
              <CocoaChart.Gauge value={45} thresholds={[30, 60]} label="Riesgo" caption="12 reservas en riesgo" format={(value) => percent(value)} />
            </CocoaSection>
          </CocoaSpan>
          <CocoaSpan cols={4} min={240}>
            <CocoaSection title="Mix de canales">
              <CocoaChart.Donut slices={CHANNEL_MIX} centerValue={percent(42)} centerLabel="Directo" valueFormat={(value) => percent(value)} aria-label="Mix de canales" />
            </CocoaSection>
          </CocoaSpan>
          <CocoaSpan cols={4} min={240}>
            <CocoaSection title="Gauge por umbral" meta="18 · 78">
              <div className="cocoa-row" data-gap="3" data-align="start">
                <CocoaChart.Gauge value={18} thresholds={[30, 60]} label="Bajo" format={(value) => percent(value)} />
                <CocoaChart.Gauge value={78} thresholds={[30, 60]} label="Alto" format={(value) => percent(value)} />
              </div>
            </CocoaSection>
          </CocoaSpan>
          <CocoaSpan cols={4} min={240}>
            <CocoaSection title="Sparkline y progreso">
              <div className="cocoa-stack" data-gap="3">
                <div className="cocoa-row" data-gap="3">
                  {(["success", "warning", "danger", "accent", "neutral"] as CocoaTone[]).map((tone) => (
                    <span key={tone} className="cocoa-cluster" data-gap="1">
                      <CocoaChart.Sparkline values={tone === "danger" ? SPARK_DOWN : SPARK_UP} tone={tone} aria-label={`Tendencia ${TONE_LABEL[tone].toLowerCase()}`} />
                      <Mono>{tone}</Mono>
                    </span>
                  ))}
                </div>
                <CocoaChart.Progress value={68} label="Ocupación" />
                <CocoaChart.Progress value={92} tone="success" label="Checklist de salida en vivo" />
                <CocoaChart.Progress value={35} tone="warning" label="Registro de viajeros" />
                <CocoaChart.Progress value={12} tone="danger" label="Cobros pendientes" showValue={false} />
              </div>
            </CocoaSection>
          </CocoaSpan>
          <CocoaSpan cols={4} min={240}>
            <CocoaSection title="Gauge invert" meta="más alto = mejor · umbrales 40 / 70">
              <div className="cocoa-row" data-gap="3" data-align="start">
                <CocoaChart.Gauge value={82} thresholds={[40, 70]} invert label="Ocupación prevista" caption="≥ 70 → éxito" format={(value) => percent(value)} />
                <CocoaChart.Gauge value={28} thresholds={[40, 70]} invert label="NPS" caption="< 40 → peligro" format={(value) => number(value)} />
              </div>
            </CocoaSection>
          </CocoaSpan>
          <CocoaSpan cols={8} min={480}>
            <CocoaSection title="Línea sin leyenda" meta="legend={false} · tooltipTitle · height 140 · una serie">
              <CocoaChart.Line series={adrSeries} height={140} ticks={3} legend={false} tooltipTitle={(x) => `Semana del ${x}`} valueFormat={(value) => money(value, { decimals: 0 })} aria-label="ADR semanal de ejemplo" />
            </CocoaSection>
          </CocoaSpan>
        </CocoaGrid>
        <CodeSample code={CHART_SAMPLE} />
      </div>
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Migration checklist (COCOA-22.md §9 rules + §10 definition of done)
// ---------------------------------------------------------------------------

interface ChecklistItem {
  id: string;
  rule: string;
  detail: string;
  scope: "contrato" | "hecho";
}

const CHECKLIST: ChecklistItem[] = [
  { id: "r1", scope: "contrato", rule: "0 clases legacy del back office (prefijo «bo»)", detail: "CocoaCard / CocoaSection en lugar de la tarjeta legacy; las clases de la barra lateral legacy solo en navigation/ y layouts/" },
  { id: "r2", scope: "contrato", rule: "0 botones nativos crudos", detail: "CocoaButton; iconos con variant=\"plain\" y aria-label" },
  { id: "r3", scope: "contrato", rule: "0 tablas nativas crudas", detail: "CocoaTable; parrillas envueltas en CocoaScrollArea con data-cocoa-grid-table" },
  { id: "r4", scope: "contrato", rule: "0 controles nativos crudos (input, select, textarea)", detail: "CocoaField + CocoaInput / Select / Switch / DatePicker; textarea = CocoaInput multiline" },
  { id: "r5", scope: "contrato", rule: "0 colores literales", detail: "Ni hexadecimales, ni funciones de color, ni fallbacks literales dentro de var(): todo var(--cocoa-*)" },
  { id: "r6", scope: "contrato", rule: "style={} solo de layout y acotado", detail: "≤ 25 (dashboard) · ≤ 15 (lista / detalle / formulario) · ≤ 40 (calendario / workspace); solo display, gap, flex, grid, min/max, margin, padding, overflow, position" },
  { id: "r7", scope: "contrato", rule: "Cabecera obligatoria", detail: "CocoaPage (o CocoaPageHeader / HostedHead / useTabHost en pantallas alojadas)" },
  { id: "r8", scope: "contrato", rule: "0 encabezados h1 crudos", detail: "El h1 lo pinta CocoaPageHeader; uno por página" },
  { id: "r9", scope: "contrato", rule: "0 position: fixed ni zIndex numérico", detail: "Drawer, diálogo, toast y action bar consumen --cocoa-z-*" },
  { id: "r10", scope: "contrato", rule: "0 emoji en JSX", detail: "Iconos de cocoa-icons con aria-hidden + texto" },
  { id: "r11", scope: "contrato", rule: "0 transition: all · 0 animation infinite", detail: "Excepciones: shimmer del skeleton y spinner del botón" },
  { id: "r12", scope: "contrato", rule: "Todos los tokens --cocoa-* existen", detail: "Definidos en cocoa-tokens.css o cocoa-base.css" },
  { id: "r13", scope: "contrato", rule: "El presupuesto global no crece", detail: "scripts/cocoa-22-inventory.mjs: tarjetas legacy, botones, tablas e inputs nativos, colores literales y style={} ≤ inventario commiteado" },
  { id: "r14", scope: "contrato", rule: "Ningún proveedor escribe --cocoa-accent", detail: "Un solo acento: Esmeralda; sin preferencia de acento de usuario" },
  { id: "r15", scope: "contrato", rule: "Inventario al día", detail: "node scripts/cocoa-22-inventory.mjs y commit de docs/design/cocoa-22-inventory.json" },
  { id: "d1", scope: "hecho", rule: "Misma URL y pestaña", detail: "Sin cambios en el árbol de navegación ni en los deep links" },
  { id: "d2", scope: "hecho", rule: "Mismos datos y acciones", detail: "Ninguna función se pierde en la migración" },
  { id: "d3", scope: "hecho", rule: "Estados carga / vacío / error / degradado", detail: "CocoaState o CocoaPage state; DegradedValue «—», nunca un 0 verde falso" },
  { id: "d4", scope: "hecho", rule: "AA medido en textos secundarios", detail: "label-secondary ≥ 4,5:1; texto de tono con --cocoa-tone-*-text" },
  { id: "d5", scope: "hecho", rule: "Sin scroll horizontal en 390 px", detail: "Salvo parrillas dentro de CocoaScrollArea; gutter 16, 1 columna, tablas en tarjetas" },
  { id: "d6", scope: "hecho", rule: "Skeleton espejo", detail: "Mismos spans que el contenido (sin CLS)" },
  { id: "d7", scope: "hecho", rule: "Foco y teclado verificados", detail: "Halo visible, Esc cierra, Enter abre filas, Ctrl/⌘ + Enter en la barra de acciones" },
  { id: "d8", scope: "hecho", rule: "Revisión visual a 1440 / 1024 / 390, claro y oscuro", detail: "Checklist de §3–§5 sobre el canon /hoy/direccion" },
  { id: "d9", scope: "hecho", rule: "Ruta añadida a cocoa-22-migrated.json", detail: "docs/design/cocoa-22-migrated.json (la lista que activa el contrato)" }
];

const CHECKLIST_COMMANDS = `corepack pnpm --filter @hotelos/admin-web typecheck
corepack pnpm test                                  # incluye tests/cocoa-22-contract.test.mjs
node scripts/cocoa-22-inventory.mjs                 # regenera docs/design/cocoa-22-inventory.json
node scripts/check-discoverability.mjs`;

function ChecklistSection() {
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [scope, setScope] = useState<"todo" | "contrato" | "hecho">("todo");
  const rows = useMemo(() => CHECKLIST.filter((item) => scope === "todo" || item.scope === scope), [scope]);
  const completed = CHECKLIST.filter((item) => done[item.id]).length;
  const progress = Math.round((completed / CHECKLIST.length) * 100);
  const columns: CocoaTableColumn<ChecklistItem>[] = [
    {
      key: "done",
      label: "Hecho",
      width: "72px",
      render: (item) => <CocoaSwitch size="small" checked={Boolean(done[item.id])} onChange={(value) => setDone((current) => ({ ...current, [item.id]: value }))} aria-label={`Marcar «${item.rule}»`} />
    },
    { key: "scope", label: "Ámbito", width: "110px", hideOnNarrow: true, render: (item) => <CocoaBadge tone={item.scope === "contrato" ? "accent" : "neutral"} size="small">{item.scope === "contrato" ? "Contrato §9" : "Hecho §10"}</CocoaBadge> },
    { key: "rule", label: "Regla", minWidth: 200, render: (item) => <strong style={{ textDecoration: done[item.id] ? "line-through" : undefined, color: done[item.id] ? "var(--cocoa-label-secondary)" : undefined }}>{item.rule}</strong> },
    { key: "detail", label: "Cómo se cumple", minWidth: 280, render: (item) => <Note as="span">{item.detail}</Note> }
  ];
  return (
    <CocoaSection
      id="guia-checklist"
      headingLevel={2}
      title="Checklist de migración"
      meta="Las 15 reglas del contrato (§9) y la definición de «hecho» por pantalla (§10); el progreso no se guarda"
      action={
        <div className="cocoa-row" data-gap="2">
          <CocoaSegmentedControl size="small" value={scope} onChange={(value) => setScope(value as typeof scope)} options={[{ value: "todo", label: "Todo" }, { value: "contrato", label: "Contrato" }, { value: "hecho", label: "Hecho" }]} aria-label="Ámbito del checklist" />
          <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setDone({})} disabled={completed === 0}>
            Restablecer
          </CocoaButton>
        </div>
      }
      padding="none"
      footer={
        <div className="cocoa-stack" data-gap="3" style={{ padding: "var(--cocoa-space-4)" }}>
          <CodeSample code={CHECKLIST_COMMANDS} label="Puertas de cada ola" />
        </div>
      }
    >
      <div style={{ padding: "var(--cocoa-space-4) var(--cocoa-space-4) 0" }}>
        <CocoaChart.Progress value={progress} tone={progress === 100 ? "success" : "accent"} label={`${number(completed)} de ${number(CHECKLIST.length)} puntos`} aria-label="Progreso del checklist" />
      </div>
      <CocoaTable<ChecklistItem> columns={columns} rows={rows} rowKey="id" caption="Checklist de migración Cocoa 22" />
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

const PAGE_SAMPLE = `<CocoaPage
  eyebrow="Gerencia · Rías Altas" title="Dashboard del director" subtitle="Vista estratégica del día · datos a 08:12"
  actions={<CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>Actualizar</CocoaButton>}
  state={isLoading ? "loading" : error ? "error" : rows.length ? "ready" : "empty"} skeleton={<CocoaSkeleton.Grid rows={[[8, 2, 2]]} />}
  empty={{ title: "Sin datos hoy", illustration: "box", primaryAction: { label: "Actualizar", onClick: refresh } }}
  error={{ message: error, onRetry: refresh }}
  fullBleed={false}   // true en parrillas y calendarios: el cuerpo cancela el gutter (24 / 16), la cabecera lo conserva
  commands={[{ id: "refresh", label: "Actualizar datos", run: refresh, shortcut: "⌘R" }]}   // aparecen en ⌘K
  density="comfortable">
  <CocoaKpiStrip stagger>…</CocoaKpiStrip>
  <CocoaGrid>…</CocoaGrid>
</CocoaPage>`;

const THEME_OPTIONS = [
  { value: "system", label: "Sistema" },
  { value: "light", label: "Claro" },
  { value: "dark", label: "Oscuro" }
];

type GuidePageState = "ready" | "loading" | "empty" | "error";

/** Mirror skeleton of the guide (banner, KPI strip, three grid rows) while the page simulates `loading`. */
function GuideSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="5" data-cocoa="guide-skeleton">
      <CocoaSkeleton variant="row" height={44} />
      <CocoaSkeleton.Strip count={6} />
      <CocoaSkeleton.Grid rows={[[12], [6, 6], [4, 4, 4]] as const} height={160} />
    </div>
  );
}

export function StyleGuideScreen() {
  const [theme, setTheme] = useState<ThemePreference>(() => getThemePreference());
  const [density, setDensity] = useState<CocoaPageDensity>("comfortable");
  const [pageState, setPageState] = useState<GuidePageState>("ready");
  const [fullBleed, setFullBleed] = useState(false);
  const loadTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (loadTimer.current) window.clearTimeout(loadTimer.current);
    },
    []
  );
  const simulateLoading = useCallback(() => {
    setPageState("loading");
    if (loadTimer.current) window.clearTimeout(loadTimer.current);
    loadTimer.current = window.setTimeout(() => setPageState("ready"), 1500);
  }, []);
  const backToReady = useCallback(() => setPageState("ready"), []);
  const changeTheme = useCallback((value: string) => {
    const next = value as ThemePreference;
    setTheme(next);
    setThemePreference(next);
  }, []);
  const toggleDensity = useCallback(() => setDensity((current) => (current === "compact" ? "comfortable" : "compact")), []);
  const commands = useMemo(
    () => [
      { id: "guia-canon", label: "Abrir el canon (Dashboard del director)", run: () => navigateTo("GeneralManagerScreen") },
      { id: "guia-densidad", label: "Alternar densidad de la guía", run: toggleDensity },
      { id: "guia-estado-carga", label: "Simular la carga de la página (1,5 s)", run: simulateLoading },
      { id: "guia-checklist", label: "Ir al checklist de migración", run: () => scrollToSection("guia-checklist") }
    ],
    [toggleDensity, simulateLoading]
  );

  const actions: ReactNode = (
    <>
      <CocoaSegmentedControl size="small" value={theme} onChange={changeTheme} options={THEME_OPTIONS} aria-label="Tema" />
      <CocoaSegmentedControl
        size="small"
        value={density}
        onChange={(value) => setDensity(value as CocoaPageDensity)}
        options={[
          { value: "comfortable", label: "Cómoda" },
          { value: "compact", label: "Compacta" }
        ]}
        aria-label="Densidad"
      />
      <CocoaButton variant="filled" tone="accent" size="small" icon={<StarIcon size={12} />} onClick={() => navigateTo("GeneralManagerScreen")}>
        Abrir el canon
      </CocoaButton>
    </>
  );

  return (
    <CocoaPage
      eyebrow="Desarrollo · Cocoa 22"
      title="Guía de estilo Cocoa 22"
      subtitle="Todas las primitivas en todos sus estados y tonos, con el código para copiarlas. El canon es el Dashboard del director (/hoy/direccion)."
      actions={actions}
      state={pageState}
      skeleton={<GuideSkeleton />}
      empty={{
        title: "Guía vacía (estado «empty»)",
        message: "Así se ve una página sin datos: ilustración, título, mensaje y acción primaria. La cabecera y ⌘K siguen disponibles.",
        illustration: "box",
        primaryAction: { label: "Volver a la guía", onClick: backToReady }
      }}
      error={{
        title: "No se pudo cargar la guía (estado «error»)",
        message: "Simulación: el servicio no responde. «Reintentar» devuelve la página al estado «ready».",
        onRetry: backToReady
      }}
      fullBleed={fullBleed}
      density={density}
      commands={commands}
      gap={5}
      aria-label="Guía de estilo Cocoa 22"
    >
      <CocoaCallout tone="accent" variant="banner" title="Premium = restricción" icon={<SparkleIcon size={14} />}>
        Un acento (Esmeralda), una familia (Inter), dos radios (8 / 12), una sombra de tarjeta, un ritmo de 4 pt. Nada de blur en cabeceras de tabla, halos de acento, shimmer teñido ni pulsos infinitos. Especificación: <Mono>docs/design/COCOA-22.md</Mono>.
      </CocoaCallout>
      <CocoaSection title="Índice" meta={`${number(SECTIONS.length)} bloques`} padding="sm">
        <div className="cocoa-row" data-gap="1">
          {SECTIONS.map((section) => (
            <CocoaButton key={section.id} variant="plain" tone="neutral" size="small" onClick={() => scrollToSection(section.id)}>
              {section.label}
            </CocoaButton>
          ))}
        </div>
      </CocoaSection>
      <CocoaSection title="Página · CocoaPage" meta="Cabecera (eyebrow · h1 · subtítulo · acciones · pestañas) → estado (ready · loading · empty · error) → contenido; fullBleed; comandos en ⌘K; densidad por token">
        <div className="cocoa-stack" data-gap="3">
          <Note>
            Esta misma pantalla es un <Mono>CocoaPage</Mono>: prueba <CocoaKbd announce>⌘K</CocoaKbd> y busca «Alternar densidad de la guía». En pantallas alojadas en un contenedor de pestañas la página no pinta eyebrow ni h1 (los pone el contenedor).
          </Note>
          <div className="cocoa-row" data-gap="2">
            <Caption minWidth={72}>estado</Caption>
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={simulateLoading}>
              Simular carga (1,5 s)
            </CocoaButton>
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setPageState("empty")}>
              Simular vacío
            </CocoaButton>
            <CocoaButton variant="bordered" tone="destructive" size="small" onClick={() => setPageState("error")}>
              Simular error
            </CocoaButton>
          </div>
          <div className="cocoa-row" data-gap="2">
            <Caption minWidth={72}>fullBleed</Caption>
            <CocoaSwitch size="small" checked={fullBleed} onChange={setFullBleed} label="Contenido a sangre (fullBleed)" />
            <Note as="span">
              {fullBleed ? "Activo: el cuerpo cancela el gutter (24 / 16 px) y la cabecera lo conserva. Para parrillas, calendarios y cronogramas." : "Inactivo: gutter normal del contenido."}
            </Note>
          </div>
          <Note>
            Los tres estados sustituyen el cuerpo entero (la cabecera y ⌘K siguen): «loading» pinta el skeleton espejo 1,5 s; «empty» y «error» vuelven con su acción. Al volver a «ready» las secciones se remontan y pierden su estado local (formulario, checklist).
          </Note>
          <CodeSample code={PAGE_SAMPLE} />
        </div>
      </CocoaSection>
      <ColourTokensSection />
      <TypographySection />
      <SpacingSection />
      <ShadowsSection />
      <MotionSection />
      <ButtonsSection />
      <FieldsSection />
      <FormSection />
      <BadgesSection />
      <KpiSection />
      <CardsSection />
      <GridSection />
      <TablesSection />
      <TabsSection />
      <OverlaysSection />
      <ToastSection />
      <StatesSection />
      <ChartsSection />
      <ChecklistSection />
    </CocoaPage>
  );
}

export default StyleGuideScreen;
