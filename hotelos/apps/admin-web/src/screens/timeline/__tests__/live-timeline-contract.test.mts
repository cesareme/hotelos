import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { LIVE_TIMELINE_INSTRUCTIONS } from "../../../content/screen-instructions/timeline.ts";

// Tanda TL · lote TL-5: contrato de la pantalla Live Timeline sobre la fuente
// (la pantalla importa api-client vía los servicios y no carga bajo node
// --test, como payroll-cost-screen-contract.test.mts). Pinchos: Cocoa 22
// estricto en la pantalla, la hoja, los 15 componentes y el motor; CERO
// `style={` y cero `<table` en la pantalla (techo global 655 / 1 tras retirar
// LiveTimelineWorkspace.tsx en la fusión TL); presupuesto de estilos de
// los componentes (≤ 12, esperados 7, sin `style={{`); cabecera Cocoa,
// fecha de negocio, paginación por `nextCursor`, degradación honesta del 403,
// nombres de huésped por lotes, los nueve componentes compuestos, la única
// live region (la del shell: la pantalla ya no monta ninguna, UX-1 · U4/U9b),
// deshacer, creación por celdas, y que TODA escritura vive en applyPending
// (diálogo) / applyDirect (move y resize sin diálogo, F24) / onUndo; copy en
// español sin Intl; hoja por una sola vía; barrel; L3-F1 traspasado
// (previsualización de penalización + applyPolicy + toast de resultado).

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

/** Fuente sin comentarios de bloque ni de línea (fix-3a), con los `//` de URLs conservados. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const SCREEN = "LiveTimeline.tsx";
const screen = source("../LiveTimeline.tsx");
const code = stripComments(screen);
const engine = source("../timeline-engine.ts");
const instructions = source("../../../content/screen-instructions/timeline.ts");
const stylesheet = source("../../../styles/cocoa-22-timeline.css");
const barrel = source("../../../components/timeline/index.ts");

const COMPONENTS_DIR = new URL("../../../components/timeline/", import.meta.url);
const componentFiles = readdirSync(COMPONENTS_DIR)
  .filter((name) => name.endsWith(".tsx"))
  .sort()
  .map((name) => [name, readFileSync(new URL(name, COMPONENTS_DIR), "utf8")] as const);

const EXPECTED_COMPONENTS = [
  "TimelineActionDialog.tsx",
  "TimelineAvailabilityRow.tsx",
  "TimelineBar.tsx",
  "TimelineCreateDialog.tsx",
  "TimelineDateSelector.tsx",
  "TimelineDragLayer.tsx",
  "TimelineFilterBar.tsx",
  "TimelineGapAlert.tsx",
  "TimelineGrid.tsx",
  "TimelineHeader.tsx",
  "TimelineInspector.tsx",
  "TimelineLegend.tsx",
  "TimelineQuickCard.tsx",
  "TimelineRow.tsx",
  "TimelineUndoBar.tsx"
];

/** Reglas 1-5, 9-11 de tests/cocoa-22-contract.test.mjs + formato solo por lib/format, sobre un fichero. */
function assertCocoaRules(name: string, src: string) {
  assert.doesNotMatch(src, /(?<!-)\bbo-[a-z0-9-]+/, `${name}: no .bo-* classes`);
  assert.doesNotMatch(src, /<button\b/, `${name}: no raw <button>`);
  assert.doesNotMatch(src, /<table\b/, `${name}: no raw <table>`);
  assert.doesNotMatch(src, /<(?:input|select|textarea)\b/, `${name}: no raw form controls`);
  assert.doesNotMatch(src, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/, `${name}: no colour literals`);
  assert.doesNotMatch(src, /\p{Extended_Pictographic}/u, `${name}: no emoji`);
  assert.doesNotMatch(src, /transition:\s*["']all|position:\s*["'(]*fixed|zIndex:\s*["'(]*\d/, `${name}: no transition: all, fixed position nor numeric zIndex`);
  assert.doesNotMatch(src, /money\([^)]*"EUR"\)/, `${name}: the currency never travels as a literal`);
  assert.doesNotMatch(src, /\bfetch\s*\(/, `${name}: no raw fetch`);
  assert.doesNotMatch(src, /\bIntl\.|\.toLocale(?:Date|Time)?String\s*\(|\.toFixed\(/, `${name}: formats only through lib/format`);
}

/** [inicio, fin) de la llamada `const <name> = useCallback(` … `)` en la fuente sin comentarios (paréntesis emparejados, cadenas saltadas). */
function callbackRange(src: string, name: string): [number, number] {
  const header = `const ${name} = useCallback(`;
  const start = src.indexOf(header);
  assert.ok(start >= 0, `${SCREEN}: falta ${header}`);
  let depth = 0;
  for (let i = start + header.length - 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const close = src.indexOf(ch, i + 1);
      assert.ok(close > i, `${SCREEN}: cadena sin cerrar dentro de ${name}`);
      i = close;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return [start, i + 1];
    }
  }
  assert.fail(`${SCREEN}: ${name} sin cierre`);
}

// Literales ingleses del diccionario (tests/admin-web-spanish-copy-contract.test.mjs) + jerga.
const FORBIDDEN_EN = ["Status", "Guest", "Date", "Type", "Open", "Close", "Draft", "Cancelled", "In-house", "Upcoming", "Pending", "Loading", "Save", "Cancel", "Refresh", "Retry"];
const JARGON = ["TODO", "mock", "stub", "sandbox"];
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function englishLiteralPatterns(literal: string): RegExp[] {
  const word = escapeRe(literal);
  return [
    new RegExp(`>\\s*${word}\\s*(?=<|\\{|\\n)`, "m"),
    new RegExp(`\\b(label|title|placeholder|subtitle|aria-label|message|eyebrow|caption|hint|summary|description|cta|text|confirmLabel|cancelLabel)\\s*[=:]\\s*["']${word}["']`),
    new RegExp(`(\\?\\?|\\?|:)\\s*["']${word}["']\\s*(?=[:}),;\\]])`)
  ];
}

function assertSpanishCopy(name: string, src: string) {
  const stripped = stripComments(src).replace(/^import[\s\S]*?from\s+"[^"]+";[ \t]*$/gm, "");
  for (const literal of FORBIDDEN_EN) {
    for (const pattern of englishLiteralPatterns(literal)) assert.doesNotMatch(stripped, pattern, `${name}: literal en inglés «${literal}»`);
  }
  for (const word of JARGON) {
    assert.doesNotMatch(stripped, new RegExp(`>[^<>{}]*\\b${escapeRe(word)}\\b[^<>{}]*(?=<)`), `${name}: jerga «${word}» visible`);
    assert.doesNotMatch(stripped, new RegExp(`\\b(label|title|message|description)\\s*[=:]\\s*["'\`][^"'\`]*\\b${escapeRe(word)}\\b`), `${name}: jerga «${word}» en una etiqueta`);
  }
  assert.doesNotMatch(stripped, /\bIntl\./, `${name}: sin Intl`);
}

describe("Live Timeline · Cocoa 22 estricto (pantalla, instrucciones, componentes, motor, hoja)", () => {
  it("1 · reglas Cocoa sobre la pantalla, timeline.ts, los 15 componentes y el motor", () => {
    assertCocoaRules(SCREEN, screen);
    assertCocoaRules("screen-instructions/timeline.ts", instructions);
    assertCocoaRules("timeline-engine.ts", engine);
    assert.deepEqual(
      componentFiles.map(([name]) => name),
      EXPECTED_COMPONENTS,
      "components/timeline contiene exactamente los 15 componentes de TL-2/3/4"
    );
    for (const [name, src] of componentFiles) assertCocoaRules(`components/timeline/${name}`, src);
  });

  it("2 · la pantalla nace con 0 style={ y sin <table (techo global 655 / 1 tras retirar LiveTimelineWorkspace)", () => {
    assert.equal(count(screen, /\bstyle=\{/g), 0, `${SCREEN}: style={ ×${count(screen, /\bstyle=\{/g)}`);
    assert.doesNotMatch(screen, /<table/, `${SCREEN}: sin <table`);
    assert.doesNotMatch(screen, /<h1\b/, `${SCREEN}: sin <h1 crudo`);
  });

  it("3 · los componentes suman ≤ 12 style={ (esperados 7) y ninguno es un literal style={{", () => {
    const total = componentFiles.reduce((sum, [, src]) => sum + count(src, /\bstyle=\{/g), 0);
    assert.ok(total <= 12, `components/timeline: style={ ×${total} > 12`);
    assert.equal(total, 7, `components/timeline: style={ ×${total} (esperados 7: Grid 3 · Row 2 · Bar 1 · DragLayer 1)`);
    for (const [name, src] of componentFiles) assert.equal(count(src, /\bstyle=\{\{/g), 0, `${name}: sin style={{`);
  });

  it("4 · la hoja cocoa-22-timeline.css no lleva colores literales y solo define clases tl-*", () => {
    const css = stripComments(stylesheet);
    assert.doesNotMatch(css, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/, "cocoa-22-timeline.css: sin colores literales");
    const selectors = [...css.matchAll(/^\s*\.([a-z][a-z0-9_-]*)/gm)].map((m) => m[1]);
    assert.ok(selectors.length > 0, "la hoja define clases");
    assert.deepEqual(selectors.filter((cls) => !cls.startsWith("tl-")), [], "solo clases tl-* (sin conflicto con mobile.css)");
    assert.match(css, /var\(--cocoa-/, "la hoja usa tokens --cocoa-*");
  });
});

describe("Live Timeline · composición y contrato de pantalla", () => {
  it("5a · exporta LiveTimeline con la cabecera Cocoa (CocoaPage · Hoy · «Live Timeline», subtítulo solo standalone, full bleed compacta)", () => {
    assert.match(screen, /export function LiveTimeline\(\)/);
    assert.match(screen, /<CocoaPage\b/);
    assert.match(screen, /eyebrow="Hoy"/, "primera entrada del menú Hoy para todos los perfiles (no «Recepción»)");
    assert.match(screen, /export const LIVE_TIMELINE_TITLE = "Live Timeline";/);
    assert.match(screen, /title=\{LIVE_TIMELINE_TITLE\}/);
    assert.match(screen, /useTabHost\(/);
    assert.match(screen, /subtitle=\{hosted \? undefined : LIVE_TIMELINE_SUBTITLE\}/);
    assert.match(screen, /Pasa el ratón por un bloque para ver su ficha rápida, haz clic para abrir el detalle con folio y actividad, y arrastra \(o usa ⌥ con las flechas\) para mover o redimensionar la estancia: el cambio se aplica al momento y se puede deshacer durante 8 segundos\. Solo el check-in, el check-out, cancelar y el no-show piden confirmación\./);
    assert.match(screen, /fullBleed\s+density="compact"\s+state=\{pageState\}/);
    assert.match(screen, /skeleton=\{<CocoaSkeleton variant="chart" height=\{420\} \/>\}/);
    assert.match(screen, /error=\{\{ title: LOAD_ERROR_TITLE, message: error \?\? undefined, onRetry: \(\) => void loadBase\(\) \}\}/);
    assert.match(screen, /"No se pudo cargar el Live Timeline"/);
    assert.match(screen, /loading=\{rangeLoading\} disabled=\{forbidden\} onClick=\{\(\) => void refresh\(\)\}>\s*\{ACTIONS\.refresh\}/);
    for (const id of ["live-timeline-refresh", "live-timeline-today", "live-timeline-new"]) assert.match(screen, new RegExp(`id: "${id}"`), `comando ${id}`);
    assert.match(screen, /label: "Actualizar Live Timeline"/);
    assert.match(screen, /label: "Live Timeline: ir a hoy"/);
    assert.match(screen, /label: "Nueva reserva desde el timeline", run: openNewReservation/);
    // U9b (§5.11 (5)): «Mover un día» y «Deshacer» llegan a ⌘K (CocoaPage registra los commands en cocoa-page-commands).
    assert.match(screen, /export const MOVE_LATER_COMMAND = "Mover un día la reserva seleccionada";/);
    assert.match(screen, /export const MOVE_EARLIER_COMMAND = "Mover un día antes la reserva seleccionada";/);
    assert.match(screen, /export const UNDO_COMMAND = "Deshacer el último cambio del Live Timeline";/);
    assert.match(screen, /id: "live-timeline-move-later", label: MOVE_LATER_COMMAND, shortcut: "⌥→", run: \(\) => moveSelected\(1\)/);
    assert.match(screen, /id: "live-timeline-move-earlier", label: MOVE_EARLIER_COMMAND, shortcut: "⌥←", run: \(\) => moveSelected\(-1\)/);
    assert.match(screen, /\.\.\.\(undo \? \[\{ id: "live-timeline-undo", label: UNDO_COMMAND, shortcut: "⌘Z", run: \(\) => void onUndo\(\) \}\] : \[\]\)/, "Deshacer solo mientras hay algo que deshacer");
  });

  it("5b · importa primitivas solo del índice Cocoa, componentes del barrel timeline, lógica del motor y los servicios previstos", () => {
    assert.match(screen, /from "\.\.\/\.\.\/components\/cocoa";/);
    assert.match(screen, /from "\.\.\/\.\.\/components\/timeline";/);
    assert.match(screen, /from "\.\/timeline-engine";/);
    assert.doesNotMatch(screen, /from "\.\.\/\.\.\/components\/cocoa\/[A-Za-z]/, "las primitivas solo del índice");
    assert.doesNotMatch(screen, /from "\.\.\/\.\.\/components\/timeline\/[A-Za-z]/, "los componentes solo del barrel");
    assert.match(screen, /import \{ getActivePropertyId \} from "\.\.\/\.\.\/services\/activeProperty";/);
    assert.match(screen, /import \{ fetchNightAuditBusinessDate \} from "\.\.\/\.\.\/services\/posApi";/);
    assert.match(screen, /import \{ fetchGuest \} from "\.\.\/\.\.\/services\/guestsApi";/);
    assert.match(screen, /import \{ guestFullName, guestNamesFromRows, pendingGuestIds \} from "\.\.\/reservations\/reservation-guest-label";/, "L-15: los nombres que trae la lista se siembran sin GET /guests/:id");
    assert.match(screen, /import \{ CocoaScreenInstructionsCard \} from "\.\.\/\.\.\/components\/cocoa-guidance\/CocoaScreenInstructionsCard";/);
    assert.match(screen, /import \{ LIVE_TIMELINE_INSTRUCTIONS \} from "\.\.\/\.\.\/content\/screen-instructions\/timeline";/);
    assert.match(screen, /import \{ useToast \} from "\.\.\/\.\.\/components\/Toast";/);
    assert.match(screen, /import \{ navigateTo \} from "\.\.\/\.\.\/lib\/navigate";/);
    assert.match(screen, /import \{ urlForScreen \} from "\.\.\/\.\.\/navigation\/nav-tree";/);
    assert.doesNotMatch(screen, /HotelOS|Anfitorio|hotelos\.es/, "sin marcas antiguas");
    assert.doesNotMatch(screen, /\bfetch\s*\(/, "sin fetch crudo");
  });

  it("5c · datos: «hoy» = max(fecha de negocio, día local) como el check-in del API, anclaje en hoy, rango paginado por nextCursor con secuencia, refresh con callout de desactualizado", () => {
    assert.match(screen, /fetchNightAuditBusinessDate\(propertyId\)\.catch\(\(\) => null\)/);
    assert.match(screen, /fallback a la fecha local si el API de fecha de negocio no responde \(403\/red\)/);
    assert.match(screen, /const key = referenceToday\(businessDate\?\.currentDate, todayLocalIso\(\)\);/);
    assert.doesNotMatch(screen, /businessDate\?\.currentDate \?\? todayLocalIso\(\)/, "una fecha de negocio atrasada ya no ancla «hoy»");
    assert.match(screen, /setBusinessDateKey\(businessDate\?\.currentDate \?\? null\)/);
    assert.match(screen, /businessDateKey !== null && businessDateKey < todayKey/, "aviso de cierre nocturno pendiente");
    assert.match(screen, /Cierre nocturno pendiente · fecha de negocio/);
    assert.match(screen, /rangeFor\(anchor, granularity, \{ narrow, coarse \}\)/, "escala estrecha en teléfonos y barras de 44 px con el dedo (U9b)");
    assert.match(screen, /const coarse = useCoarsePointer\(\);/);
    assert.match(screen, /import \{ useCoarsePointer \} from "\.\.\/\.\.\/lib\/useCoarsePointer";/);
    assert.match(screen, /anchorForToday\(/);
    assert.match(screen, /nextCursor/);
    assert.match(screen, /MAX_RANGE_PAGES = 10/);
    assert.match(screen, /RANGE_PAGE_LIMIT = 500/);
    assert.match(screen, /from: toDateOnly\(addDays\(range\.start, -1\)\)|const from = toDateOnly\(addDays\(range\.start, -1\)\)/);
    assert.match(screen, /const to = toDateOnly\(addDays\(range\.end, 1\)\)/);
    assert.match(screen, /const requestSeq = useRef\(0\)/);
    assert.match(screen, /seq !== requestSeq\.current/);
    assert.match(screen, /arrivalFrom: todayKey, sort: "arrival_asc", limit: 1/);
    assert.match(screen, /sort: "arrival_desc", limit: 1/);
    assert.match(screen, /const anchoredRef = useRef\(false\)/);
    assert.match(screen, /Datos desactualizados desde/);
    assert.match(screen, /\{ACTIONS\.retry\}/);
    assert.match(screen, /Promise\.all\(\[fetchRooms\(propertyId\), fetchRangeReservations\(propertyId, range\)\]\)/);
  });

  it("5d · degradación honesta del 403: UN callout «Tu perfil no puede leer reservas» (sin estado degradado duplicado), Actualizar y comandos apagados, nunca en blanco", () => {
    assert.match(screen, /isForbidden\(/);
    assert.match(screen, /"Tu perfil no puede leer reservas"/);
    assert.match(screen, /"Pide acceso a dirección para ver el Live Timeline\."/);
    assert.match(screen, /<CocoaCallout tone="warning" role="alert" title=\{FORBIDDEN_TITLE\}>/);
    assert.doesNotMatch(screen, /<CocoaState kind="degraded"/, "el mismo mensaje no se pinta dos veces");
    assert.equal(count(screen, /FORBIDDEN_MESSAGE\}/g), 1, "FORBIDDEN_MESSAGE se pinta una sola vez");
    assert.match(screen, /disabled=\{forbidden\}/);
    assert.match(screen, /commands=\{\s*forbidden\s*\?\s*\[\]/);
    assert.match(screen, /const pageState = loading \? "loading" : error \? "error" : "ready";/);
    assert.match(screen, /Si el 403 es solo de la fecha de negocio se usa el fallback sin avisar en pantalla/);
    // Nombres de huésped con 403 (perfil sin guests.read): etiqueta honesta + callout, nunca «pendiente» eterno.
    assert.match(screen, /else if \(isForbidden\(result\.reason\)\) \{\s*resolved\[batch\[index\]\] = HIDDEN_GUEST_LABEL;/);
    assert.match(screen, /"Nombres de huésped no visibles"/);
    assert.match(screen, /<CocoaCallout tone="info" role="note" title=\{GUESTS_HIDDEN_TITLE\}>/);
  });

  it("5e · nombres de huésped: pendingGuestIds + fetchGuest por lotes de 20 con allSettled, caché en estado y pedidos en ref, etiqueta con guestLabel", () => {
    assert.match(screen, /pendingGuestIds\(/);
    assert.match(screen, /fetchGuest\(/);
    assert.match(screen, /GUEST_BATCH_SIZE = 20/);
    assert.match(screen, /Promise\.allSettled\(batch\.map\(\(id\) => fetchGuest\(id\)\)\)/);
    assert.match(screen, /guestFullName\(result\.value\.guest\)/);
    assert.match(screen, /useState<Record<string, string>>\(\{\}\)/);
    assert.match(screen, /const requestedGuestIds = useRef\(new Set<string>\(\)\)/);
    assert.match(screen, /guestLabel\(selected, selectedGuestName\)/);
  });

  it("5f · compone los nueve componentes en orden (el inspector acoplado junto a la parrilla), la tarjeta de instrucciones y la única live region", () => {
    const order = [
      "<CocoaScreenInstructionsCard",
      "<TimelineDateSelector",
      "<TimelineFilterBar",
      "<TimelineGapAlert",
      "<CocoaUndoBar",
      '<div className="tl-workspace" data-panel={inspected ? "open" : "closed"}>',
      "<TimelineGrid\n",
      "<TimelineLegend",
      "<TimelineInspector",
      "<TimelineActionDialog",
      "<TimelineCreateDialog"
    ];
    let last = -1;
    for (const marker of order) {
      const at = screen.indexOf(marker);
      assert.ok(at > last, `${marker} en orden`);
      last = at;
    }
    assert.match(screen, /persistKey="live-timeline"/);
    assert.match(screen, /description=\{LIVE_TIMELINE_INSTRUCTIONS\.whatIsThis\}/);
    assert.match(screen, /steps=\{\[\.\.\.LIVE_TIMELINE_INSTRUCTIONS\.howToUse\]\}/);
    assert.match(screen, /tip=\{LIVE_TIMELINE_INSTRUCTIONS\.tips\[0\]\}/);
    // U4/U9b: la única live region es la del shell (CocoaShellLiveRegion); la pantalla anuncia por useCocoaAnnounce y no monta otra.
    assert.equal(count(screen, /<CocoaLiveRegion/g), 0, "ninguna live region propia: la del shell es la única de la página");
    assert.doesNotMatch(screen, /CocoaLiveRegion|liveMessage|setLiveMessage/);
    assert.match(screen, /import \{ useCocoaAnnounce \} from "\.\.\/\.\.\/providers\/CocoaGlobalProvider";/);
    assert.match(screen, /const \{ announce \} = useCocoaAnnounce\(\);/);
    assert.equal(count(code, /\bannounce\(/g), 1, "la región del shell solo anuncia la selección");
    assert.match(screen, /announce\(`Seleccionada la reserva \$\{res\.code\}`\)/);
    assert.match(screen, /onDropRejected/);
    assert.match(screen, /maxHeight=\{narrow \? GRID_HEIGHT_NARROW : GRID_HEIGHT\}/);
    assert.match(screen, /const narrow = useIsNarrow\(\);/);
    assert.match(screen, /<CocoaState\s+kind="empty"/);
    assert.match(screen, /rows\.length === 0/);
    for (const chip of ["habitación\", \"habitaciones\"", "reserva visible\", \"reservas visibles\"", "En el hotel: {inHouseCount}", "Llegadas hoy: {arrivalsToday}", "Salidas hoy: {departuresToday}"]) {
      assert.ok(screen.includes(chip), `chip ${chip}`);
    }
    assert.match(screen, /<TimelineGapAlert days=\{overbooking\} roomOverlaps=\{roomOverlaps\} onGoToDay=\{goToDay\} \/>/);
    assert.match(screen, /setAnchor\(addDays\(parseDateOnly\(dayKey\), -1\)\)/);
    // Sin resultados (filtros/búsqueda sin coincidencias o periodo sin reservas): mensaje + CTA, no 120 filas mudas.
    assert.match(screen, /const noVisible = rooms\.length > 0 && visible\.length === 0;/);
    assert.match(screen, /"Sin reservas que coincidan"/);
    assert.match(screen, /"Sin reservas en este periodo"/);
    assert.match(screen, /title=\{reservations\.length === 0 \? NO_RESERVATIONS_TITLE : NO_MATCH_TITLE\}/);
  });

  it("5f-bis · selección ≠ detalle: flechas y clic seleccionan, clic/Intro abren un panel NO modal, Escape cierra antes de deseleccionar y devuelve el foco", () => {
    assert.match(screen, /const \[inspectorOpen, setInspectorOpen\] = useState\(false\);/);
    assert.match(screen, /const \[focusToken, setFocusToken\] = useState\(0\);/);
    assert.match(screen, /const inspected = inspectorOpen \? selected : null;/);
    assert.match(screen, /const detailId = inspected\?\.id \?\? null;/, "folio y actividad solo se piden con el detalle abierto");
    assert.match(screen, /const onSelect = useCallback\(\s*\(id: string \| null\) => \{\s*setSelectedId\(id\);/);
    assert.doesNotMatch(code.slice(code.indexOf("const onSelect = useCallback("), code.indexOf("const onOpen = useCallback(")), /setInspectorOpen/, "seleccionar no abre");
    assert.match(screen, /const onOpen = useCallback\(\(id: string, via: TimelineOpenVia\) => \{\s*setSelectedId\(id\);\s*setInspectorOpen\(true\);\s*if \(via === "keyboard"\) setFocusToken/);
    assert.match(screen, /setInspectorOpen\(false\);\s*if \(selectedId\) gridHandle\.current\?\.focusBar\(selectedId\);/, "cerrar conserva la selección y devuelve el foco a la barra");
    assert.match(screen, /onSelect=\{onSelect\}\s*onOpen=\{onOpen\}\s*onEscape=\{handleEscape\}/);
    assert.match(screen, /reservations=\{reservations\}\s*maxHeight=/, "la parrilla valida el arrastre con las reservas cargadas");
    assert.match(screen, /handleRef=\{gridHandle\}/);
    assert.match(screen, /res=\{inspected\}/);
    assert.match(screen, /focusToken=\{focusToken\}/);
    assert.match(screen, /onOpenFolio=\{openFolio\}/);
    assert.match(screen, /urlForScreen\("FolioDetail", \{ id: folio\.folio\.id \}\)/, "«Folio y facturación» abre el folio de la reserva");
    assert.match(screen, /if \(inspectorOpen && !selected\) setInspectorOpen\(false\);/, "el detalle se cierra solo si la reserva desaparece del rango");
  });

  it("5g · acciones: patchFor / assign-room / check-in / check-out con BALANCE_DUE / cancel / no-show, 409 tipado, toast, deshacer y live message", () => {
    assert.match(screen, /patchFor\(/);
    assert.match(screen, /balanceDueConflict\(/);
    assert.match(screen, /conflictCode\(/);
    assert.match(screen, /conflictMessage\(/);
    assert.match(screen, /undoEntryFor\(/);
    assert.match(screen, /setConflict\(\{ code: "BALANCE_DUE", message: balance\.message, balanceDue: balance\.balanceDue \}\)/);
    assert.match(screen, /checkInReservation\(res\.id, \{ roomId: res\.assignedRoomId \}\)/);
    assert.match(screen, /throw new Error\(CHECKIN_NEEDS_ROOM\)/);
    assert.match(screen, /checkOutReservation\(res\.id, \{ acknowledgeBalance: input\.acknowledgeBalance \}\)/);
    // L3-F1 (traspasado de LiveTimelineWorkspace): applyPolicy en cancel / no-show, previsualización al abrir y toast con el resultado del folio.
    assert.match(screen, /cancelReservation\(res\.id, input\.reason, \{ applyPolicy: true \}\)/);
    assert.match(screen, /noShowReservation\(res\.id, input\.reason, \{ applyPolicy: true \}\)/);
    assert.match(screen, /previewCancellationCharge\(lifecycleId, lifecycleMode\)/);
    assert.match(screen, /lifecycleOutcomeSummary\(mode, result\.cancellation \?\? null, \(amount\) => money\(amount, res\.currency\)\)/);
    assert.match(screen, /penaltyPreview=\{penaltyPreviewView\}/);
    assert.match(screen, /const chargeable = Boolean\(penalty && penalty\.amount > 0 && !penalty\.withinFreeWindow\);/);
    assert.match(screen, /"Calculando la penalización prevista…"/);
    // Una sola voz por resultado: deshacible → barra de deshacer (role=status); el resto → toast; nunca los tres a la vez.
    assert.match(screen, /const entry = undoEntryFor\(pending\);\s*if \(entry\) setUndo\(entry\);\s*else showToast\(done, \{ variant: "success" \}\);/);
    assert.doesNotMatch(screen, /announce\(copy\.done\)|announce\(done\)/, "la región del shell no repite el toast ni la barra de deshacer");
    assert.doesNotMatch(screen, /announce\(UNDO_DONE_MESSAGE\)/);
    assert.match(screen, /"Cambio deshecho\."/);
    assert.match(screen, /entry\.roomOnly \? IN_HOUSE_UNDO_DONE_MESSAGE : UNDO_DONE_MESSAGE/, "deshacer un traslado en casa lo dice con honestidad");
    assert.match(screen, /entry\.roomOnly/);
    assert.match(screen, /updateReservation\(entry\.reservationId, entry\.patch\)/);
    assert.match(screen, /<CocoaUndoBar entry=\{undo\} onUndo=\{onUndo\} onDismiss=\{dismissUndo\} \/>/);
    assert.match(screen, /dialogCopy\(pending, \{ roomLabel, guest \}\)/);
  });

  it("5h · TODA escritura vive en applyPending (diálogo), applyDirect (move / resize sin diálogo) u onUndo: las seis funciones de escritura solo ahí", () => {
    const ranges = [callbackRange(code, "applyPending"), callbackRange(code, "applyDirect"), callbackRange(code, "onUndo")];
    const inside = (at: number) => ranges.some(([start, end]) => at >= start && at < end);
    const writes = ["updateReservation", "assignReservationRoom", "checkInReservation", "checkOutReservation", "cancelReservation", "noShowReservation"];
    for (const name of writes) {
      const calls = [...code.matchAll(new RegExp(`\\b${name}\\(`, "g"))];
      assert.ok(calls.length > 0, `${SCREEN}: ${name}( se invoca`);
      for (const call of calls) {
        const line = code.slice(0, call.index).split("\n").length;
        assert.ok(inside(call.index ?? -1), `${SCREEN}:${line}: ${name}( fuera de applyPending / applyDirect / onUndo`);
      }
    }
    // applyDirect solo escribe move / resize (PATCH o assign-room): el resto de verbos siguen en el diálogo.
    const [directStart, directEnd] = callbackRange(code, "applyDirect");
    const direct = code.slice(directStart, directEnd);
    for (const name of ["checkInReservation", "checkOutReservation", "cancelReservation", "noShowReservation"]) {
      assert.doesNotMatch(direct, new RegExp(`\\b${name}\\(`), `applyDirect no hace ${name}`);
    }
    // applyPending recibe la entrada del diálogo y onUndo la entrada de deshacer: nada más escribe.
    assert.match(code, /onConfirm=\{applyPending\}/);
    assert.match(code, /onUndo=\{onUndo\}/);
  });

  it("5h-bis · U9b (F24, §4.2): mover / redimensionar sin diálogo — optimista + barra de deshacer 8 s, teclado por la misma vía, 409 → diálogo con el conflicto, deshacer espera al vuelo", () => {
    // El arrastre y ⌥ + flechas entran por onDrop: solo lo que el motor marca (needsConfirmation) abre el diálogo.
    const [dropStart, dropEnd] = callbackRange(code, "onDrop");
    const drop = code.slice(dropStart, dropEnd);
    assert.match(drop, /if \(needsConfirmation\(change\)\) \{\s*setPending\(change\);\s*return;\s*\}/);
    assert.match(drop, /void applyDirect\(change, via\);/);
    assert.match(code, /\(change: PendingChange, via: TimelineOpenVia = "pointer"\)/);
    // applyDirect: barra optimista y barra de deshacer ANTES de la petición; foco de vuelta a la barra si vino del teclado.
    const [directStart, directEnd] = callbackRange(code, "applyDirect");
    const direct = code.slice(directStart, directEnd);
    assert.match(direct, /const next = optimisticReservation\(change\);/);
    assert.match(direct, /const entry = undoEntryFor\(change\);/);
    assert.match(direct, /requestSeq\.current\+\+;/, "una carga en vuelo no pisa la barra optimista");
    assert.ok(direct.indexOf("setUndo(entry)") < direct.indexOf("await updateReservation("), "la barra de deshacer aparece antes de que responda el API");
    assert.match(direct, /if \(via === "keyboard"\) requestAnimationFrame\(\(\) => gridHandle\.current\?\.focusBar\(res\.id\)\);/);
    // Fallo: rollback de la barra y de la entrada de deshacer; 409 tipado → el diálogo explica el conflicto; otro error → toast.
    assert.match(direct, /setReservations\(\(prev\) => prev\.map\(\(item\) => \(item\.id === res\.id \? res : item\)\)\);/);
    assert.match(direct, /setUndo\(\(current\) => \(current === entry \? null : current\)\);/);
    assert.match(direct, /if \(code\) \{\s*setActionError\(null\);\s*setConflict\(\{ code, message: conflictMessage\(code\) \}\);\s*setPending\(change\);/);
    assert.match(direct, /showToast\(describeError\(err, UNKNOWN_CONFLICT_MESSAGE\), \{ variant: "error" \}\)/);
    assert.match(direct, /inflightRef\.current = request;/);
    // onUndo: espera al cambio directo en vuelo y revierte también en optimista.
    const [undoStart, undoEnd] = callbackRange(code, "onUndo");
    const undo = code.slice(undoStart, undoEnd);
    assert.match(undo, /if \(inflight && !\(await inflight\)\) return;/);
    assert.match(undo, /withPatch\(item, entry\.patch\)/);
    // ⌘K «Mover un día» usa la misma resolución que el teclado de la parrilla.
    assert.match(code, /resolveKeyboardMove\(\{ type: "dates", res: selected, mode: "move", dxDays \}, \{ rows, roomById, roomTypeById, reservations \}\)/);
    assert.match(screen, /"Selecciona una reserva del Live Timeline para moverla\."/);
    // Estados de reserva del diccionario, nunca el enum crudo (P6, U2).
    assert.match(screen, /\(id\) => reservationStatusLabel\(id\)/);
    assert.doesNotMatch(screen, /RES_STATUS_LABEL\[id\] \?\? id/);
  });

  it("5i · crear por celdas → Nueva reserva con la query; enlaces del inspector; teclado global con Escape en orden", () => {
    assert.match(screen, /selectionDates\(sel, range\)/);
    assert.match(screen, /newReservationSearch\(/);
    assert.match(screen, /urlForScreen\("ReservationCreate"\)/);
    assert.match(screen, /NEW_RESERVATION_FALLBACK_URL = "\/recepcion\/reservas\/nueva"/);
    assert.match(screen, /openTabPath\(`\$\{base\}\?\$\{search\}`\)/);
    assert.match(screen, /roomTypeId: cellSel\.room\.roomTypeId,\s*assignedRoomId: cellSel\.room\.id/);
    assert.match(screen, /urlForScreen\("ReservationDetailWorkspace", \{ id: selected\.id \}\)/);
    assert.match(screen, /urlForScreen\("GuestJourneyWorkspace", \{ id: selected\.id \}\)/);
    assert.match(screen, /onNavigate=\{navigateTo\}/);
    assert.match(screen, /if \(event\.key !== "Escape"\) return;\s*handleEscape\(\);/, "el manejador global delega en handleEscape (el mismo que usa la parrilla)");
    const escape = screen.slice(screen.indexOf("const handleEscape = useCallback("), screen.indexOf("useEffect(() => {\n    const onKeyDown"));
    assert.ok(escape.indexOf("cancelPending()") < escape.indexOf("setCellSel(null)"), "Escape: diálogo antes que la selección de celdas");
    assert.ok(escape.indexOf("setCellSel(null)") < escape.indexOf("closeInspector()"), "Escape: creación antes que el detalle");
    assert.ok(escape.indexOf("closeInspector()") < escape.indexOf("setSelectedId(null)"), "Escape: el detalle antes que la selección");
    assert.match(screen, /window\.addEventListener\("keydown", onKeyDown\)/);
    assert.match(screen, /window\.removeEventListener\("keydown", onKeyDown\)/);
  });

  it("6 · copy en español (sin literales prohibidos ni jerga) y sin Intl en pantalla, instrucciones y componentes", () => {
    assertSpanishCopy(SCREEN, screen);
    assertSpanishCopy("screen-instructions/timeline.ts", instructions);
    for (const [name, src] of componentFiles) assertSpanishCopy(`components/timeline/${name}`, src);
    assert.doesNotMatch(screen, /Intl|toLocale|toFixed/);
  });

  it("7 · la hoja cocoa-22-timeline.css entra por UNA vía: el gancho temporal de la pantalla (antes de la fusión) O styles.css tras cocoa-22-guide.css (línea de fusión (a)), nunca las dos ni ninguna", () => {
    const hook = /^import "\.\.\/\.\.\/styles\/cocoa-22-timeline\.css"; \/\/ Tanda TL: gancho temporal; el orquestador la mueve a src\/styles\.css \(nueva línea 26, tras cocoa-22-guide\.css y antes de mobile\.css\)$/m.test(screen);
    const styles = source("../../../styles.css");
    const imports = styles.split("\n").filter((line) => /^@import '\.\/styles\/[^']+\.css';/.test(line));
    const at = imports.indexOf("@import './styles/cocoa-22-timeline.css';");
    const merged = at >= 0;
    assert.ok(hook !== merged, hook ? "styles.css ya importa la hoja: retira el gancho temporal (línea de fusión (a))" : "ni la pantalla ni styles.css importan cocoa-22-timeline.css");
    if (merged) {
      assert.equal(imports[at - 1], "@import './styles/cocoa-22-guide.css';", "styles.css: la hoja va justo después de cocoa-22-guide.css");
      assert.equal(imports[at + 1], "@import './styles/mobile.css';", "styles.css: y antes de mobile.css (que debe seguir siendo la última)");
      assert.equal(count(screen, /^import "[^"]+\.css";/gm), 0, "sin hojas importadas desde la pantalla tras la fusión");
    } else {
      assert.equal(count(screen, /^import "[^"]+\.css";/gm), 1, "una sola hoja importada");
    }
  });

  it("8 · el barrel components/timeline/index.ts reexporta los nueve componentes y dialogCopy", () => {
    for (const name of ["TimelineGrid", "TimelineDateSelector", "TimelineFilterBar", "TimelineLegend", "TimelineGapAlert", "TimelineUndoBar", "TimelineInspector", "TimelineActionDialog", "TimelineCreateDialog"]) {
      assert.match(barrel, new RegExp(`export \\* from "\\./${name}";`), `barrel: ${name}`);
    }
    assert.match(barrel, /export \{ dialogCopy, type DialogCopy, type DialogCopyContext \} from "\.\/timeline-dialog-copy";/);
    for (const internal of ["TimelineRow", "TimelineBar", "TimelineHeader", "TimelineAvailabilityRow", "TimelineQuickCard", "TimelineDragLayer", "useTimelineDrag", "timeline-presentation"]) {
      assert.doesNotMatch(barrel, new RegExp(`from "\\./${internal}"`), `barrel: ${internal} es interno de la parrilla`);
    }
  });

  it("9 · LIVE_TIMELINE_INSTRUCTIONS: forma A (whatIsThis, 5 pasos sin numerar, 2 consejos, 7 atajos, 3 pantallas relacionadas {name, path})", () => {
    assert.match(LIVE_TIMELINE_INSTRUCTIONS.whatIsThis, /^Reservas en el hotel y proyectadas por habitación en un calendario/, "vocabulario D5 (U2): «en el hotel», no «en casa»");
    assert.equal(LIVE_TIMELINE_INSTRUCTIONS.howToUse.length, 5);
    for (const step of LIVE_TIMELINE_INSTRUCTIONS.howToUse) assert.doesNotMatch(step, /^\s*\d+[.)]\s/, `paso sin numerar: ${step}`);
    assert.equal(LIVE_TIMELINE_INSTRUCTIONS.tips.length, 2);
    assert.equal(LIVE_TIMELINE_INSTRUCTIONS.shortcuts.length, 7);
    assert.deepEqual(
      LIVE_TIMELINE_INSTRUCTIONS.shortcuts.map((shortcut) => shortcut.keys),
      ["←→↑↓", "Intro", "Esc", "⌥←→", "⌥⇧←→", "⌥↑↓", "⌘Z"]
    );
    // U9b: las instrucciones ya no prometen un diálogo por cambio; dicen que se aplica y se deshace, y hablan de «en el hotel» (D5).
    assert.match(LIVE_TIMELINE_INSTRUCTIONS.howToUse[2], /se aplica al momento y se puede deshacer durante 8 segundos/);
    assert.doesNotMatch(LIVE_TIMELINE_INSTRUCTIONS.howToUse[2], /cada cambio pide confirmación/);
    assert.match(LIVE_TIMELINE_INSTRUCTIONS.howToUse[2], /mantén pulsada/);
    assert.match(LIVE_TIMELINE_INSTRUCTIONS.tips[0], /en el hotel/);
    assert.doesNotMatch(instructions, /en casa/);
    assert.deepEqual(
      LIVE_TIMELINE_INSTRUCTIONS.relatedScreens.map((related) => related.path),
      ["/recepcion/reservas/lista", "/recepcion/reservas/tablero", "/hoy"]
    );
    for (const related of LIVE_TIMELINE_INSTRUCTIONS.relatedScreens) {
      assert.equal(typeof related.name, "string");
      assert.equal(typeof related.path, "string");
    }
    assert.doesNotMatch(instructions, /Timeline(Grid|Inspector|Bar|Row)|Cocoa[A-Z]/, "sin nombres de componentes en el texto de negocio");
  });
});
