import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { deferredCommit, undoDeferred } from "../deferred-commit.ts";
import { MANT_ACTIONS, MANT_TOASTS } from "../../../content/pisos-actions.ts";
import { MAINT_INSTRUCTIONS } from "../../../content/screen-instructions/maintenance.ts";

// Tanda UX-3 · P3 · «feel» de mantenimiento (docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md
// §4.3, §4.4, §5, §6): «Mías», «Resuelta»/«Resolver» diferidas 8 s con deshacer,
// diálogo nominal de bloqueo y «Asignarme»/«Asignar a». Contrato de fuente sobre
// las dos pantallas (.tsx no importables sin DOM, como maintenance-take-contract)
// más la copia compartida y la primitiva real de escritura diferida. Corrector
// UX-3-REV: toast sin pausa + «Deshacer» tardío honesto (REV-01), «Actualizar»
// vacía y espera las diferidas (REV-02), «Asignarme» sin blur ni intención
// perdida (REV-04). Los ids y nombres de los casos son ficticios.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const mobile = stripComments(read("../MaintenanceMobileScreen.tsx"));
const board = stripComments(read("../MaintenanceDashboard.tsx"));
const api = stripComments(read("../../../services/maintenanceApi.ts"));
const toast = read("../../../components/Toast.tsx");
const count = (source: string, needle: string) => source.split(needle).length - 1;

describe("Mis averías · chips «Mías · Todas» (F7)", () => {
  it("«Mías» = assignedTo igual al nombre completo o al correo de la sesión (sin mayúsculas ni espacios)", () => {
    assert.match(mobile, /export function isAssignedToUser\(assignedTo: string \| null \| undefined, user: \{ fullName\?: string; email\?: string \} \| null \| undefined\): boolean/);
    assert.match(mobile, /\[user\.fullName, user\.email\]\.some\(\(candidate\) => \(candidate \?\? ""\)\.trim\(\)\.toLowerCase\(\) === who\)/);
    assert.match(mobile, /const mine = items\.filter\(\(item\) => isAssignedToUser\(item\.assignedTo, user\)\);/);
  });

  it("los chips usan la copia compartida, van delante de los de prioridad y «Mías» es el inicial si hay alguna", () => {
    assert.match(mobile, /\{ id: "mine", label: MANT_ACTIONS\.mine \},\s*\{ id: "all", label: MANT_ACTIONS\.all \}/);
    assert.match(mobile, /const effectiveScope: Scope = scope \?\? \(mine\.length > 0 \? "mine" : "all"\);/);
    const scopeGroup = mobile.indexOf('aria-label="Mías o todas"');
    const priorityGroup = mobile.indexOf('aria-label="Filtrar por prioridad"');
    assert.ok(scopeGroup > 0 && priorityGroup > scopeGroup, "el grupo «Mías o todas» precede al de prioridad");
    assert.match(mobile, /const scoped = effectiveScope === "mine" \? mine : items;/);
    assert.match(mobile, /const counts = countByPriority\(scoped\);/, "los recuentos de prioridad siguen al ámbito elegido");
    assert.equal(MANT_ACTIONS.mine, "Mías");
    assert.equal(MANT_ACTIONS.all, "Todas");
  });

  it("⌘K ofrece «Mías» y «Todas» además de actualizar", () => {
    assert.match(mobile, /id: "maintenance-mobile-scope-mine"/);
    assert.match(mobile, /id: "maintenance-mobile-scope-all"/);
    assert.match(mobile, /id: "maintenance-mobile-refresh"/);
  });
});

describe("«Resuelta» / «Resolver» · optimista + escritura diferida 8 s con «Deshacer» (F3, F6, §5)", () => {
  it("la ventana es la duración del toast con acción (ACTION_DURATION = 8000) en las dos pantallas", () => {
    assert.match(toast, /export const ACTION_DURATION = 8000;/);
    for (const [name, source] of [["Mis averías", mobile], ["tablero", board]] as const) {
      assert.match(source, /import \{ ACTION_DURATION, useToast \} from "\.\.\/\.\.\/components\/Toast";/, name);
      assert.match(source, /export const RESOLVE_UNDO_MS = ACTION_DURATION;/, name);
      assert.match(source, /deferredCommit\(RESOLVE_UNDO_MS\)/, name);
      assert.match(
        source,
        /duration: RESOLVE_UNDO_MS,\s*pauseOnHover: false,\s*action: \{ label: MANT_ACTIONS\.undo, onAction: \(\) => void undoDeferred\(commit, \(\) => showToast\(MANT_TOASTS\.undoExpired\(ref\), \{ variant: "warning" \}\)\) \},\s*announce: message/,
        `${name}: toast sin pausa con «Deshacer» que cancela la escritura o avisa si ya viajó (REV-01)`
      );
      assert.match(source, /import \{ deferredCommit, undoDeferred, type DeferredFlushReason \} from "\.\/deferred-commit";/, name);
      assert.match(source, /const go = await commit\.wait\(\);\s*if \(!go\) throw new UndoneError\(\);/, `${name}: nada viaja si se deshace`);
      assert.match(source, /if \(error instanceof UndoneError\)|if \(e instanceof UndoneError\)/, name);
      assert.match(source, /MANT_TOASTS\.undone\(ref\)/, name);
    }
  });

  it("el POST /resolve viaja al agotar la ventana, al salir de la pantalla o en pagehide (keepalive)", () => {
    for (const [name, source] of [["Mis averías", mobile], ["tablero", board]] as const) {
      assert.match(source, /window\.addEventListener\("pagehide", onPageHide\);/, name);
      assert.match(source, /flushPending\("pagehide"\)/, name);
      assert.match(source, /flushPending\("manual"\);\s*\};\s*\}, \[flushPending\]\);/, `${name}: al desmontar se vacía a mano`);
      assert.match(source, /pending\.current\.get\(id\)\?\.commit\.flush\(\);/, `${name}: una segunda acción sobre el mismo parte vacía la anterior`);
    }
    assert.match(mobile, /keepalive: commit\.reason\(\) === "pagehide"/);
    assert.match(board, /await resolveWorkOrder\(id, \{ releaseRoom: w\.blocksRoom \}, \{ keepalive: commit\.reason\(\) === "pagehide" \}\);/);
    assert.match(api, /export function resolveWorkOrder\(id: string, body: ResolveWorkOrderBody = \{\}, options: WorkOrderRequestOptions = \{\}\)/);
    assert.match(api, /\.\.\.\(options\.keepalive \? \{ keepalive: true \} : \{\}\)/);
  });

  it("la tarjeta sale de la cola al instante (Mis averías) y la orden pasa a resuelta al instante (tablero)", () => {
    assert.match(mobile, /const done = mutate\(\s*\(prev\) => withoutItem\(prev, item\),/);
    assert.match(mobile, /blockedRooms: item\.blocksRoom \? Math\.max\(0, summary\.blockedRooms - 1\) : summary\.blockedRooms/);
    assert.match(board, /patchOrder\(toArray<WorkOrder>\(prev\), id, \{ status: "resolved", resolvedAt: new Date\(\)\.toISOString\(\) \}\)/);
    assert.match(mobile, /MANT_TOASTS\.resolvedRoomReleased\(ref, item\.roomNumber\) : MANT_TOASTS\.resolved\(ref\)/);
    assert.match(board, /MANT_TOASTS\.resolvedRoomReleased\(ref, n\) : MANT_TOASTS\.resolved\(ref\)/);
    assert.equal(MANT_TOASTS.resolved("a1c3n"), "Parte a1c3n resuelto.");
    assert.equal(MANT_TOASTS.resolvedRoomReleased("a1c3n", "305"), "Parte a1c3n resuelto · habitación 305 liberada.");
  });

  it("«Actualizar» (cabecera, ⌘K, reintento y barra del pulgar) vacía las diferidas, espera a que lleguen y solo entonces revalida; nada llama a refresh() a secas (REV-02)", () => {
    for (const [name, source, fn] of [["Mis averías", mobile, "refreshQueue"], ["tablero", board, "refreshBoard"]] as const) {
      assert.match(source, /type PendingWrite = \{ commit: ReturnType<typeof deferredCommit>; done: Promise<void> \};/, name);
      assert.match(source, /const pending = useRef\(new Map<string, PendingWrite>\(\)\);/, name);
      assert.match(source, /pending\.current\.set\(id, \{ commit, done \}\);/, name);
      assert.match(
        source,
        new RegExp(`const ${fn} = useCallback\\(async \\(\\) => \\{\\s*const inFlight = Array\\.from\\(pending\\.current\\.values\\(\\), \\(write\\) => write\\.done\\);\\s*flushPending\\("manual"\\);\\s*await Promise\\.allSettled\\(inFlight\\);\\s*refresh\\(\\);`),
        `${name}: ${fn} vacía, espera y revalida`
      );
      const uses = source.match(/\b(onClick|run|onRetry|primary): [^\n]*\brefresh\b[^\n]*/g) ?? [];
      assert.deepEqual(uses.filter((line) => !line.includes(fn) && !line.includes("refreshing")), [], `${name}: ningún «Actualizar» llama a refresh() a secas`);
      assert.doesNotMatch(source, /\brefresh\(\);\s*\}\s*catch/, `${name}: crear/asignar no revalidan a ciegas`);
    }
    assert.match(mobile, /id: "maintenance-mobile-refresh", label: "Actualizar mis averías", run: \(\) => void refreshQueue\(\)/);
    assert.match(board, /id: "maintenance-refresh", label: "Actualizar el tablero de mantenimiento", run: \(\) => void refreshBoard\(\)/);
    assert.match(board, /showToast\(MANT_TOASTS\.created\(workOrderRef\(created\.id\)\), \{ variant: "success" \}\);\s*void refreshBoard\(\);/, "crear una orden también espera las diferidas");
  });

  it("undoDeferred real: dentro de la ventana cancela; agotada o vaciada avisa en vez de callar (REV-01)", async () => {
    const live = deferredCommit(1000);
    let warned = 0;
    assert.equal(undoDeferred(live, () => (warned += 1)), true);
    assert.equal(await live.wait(), false);
    const sent = deferredCommit(1000);
    sent.flush("manual");
    assert.equal(undoDeferred(sent, () => (warned += 1)), false);
    assert.equal(warned, 1);
    assert.equal(MANT_TOASTS.undoExpired("a1c3n"), "Parte a1c3n ya enviado: no se puede deshacer.");
  });

  it("primitiva real: deshacer → no viaja; agotar → viaja sin keepalive; pagehide → viaja con keepalive", async () => {
    // Mismo flujo que resolve()/resolveOrder(): go = await wait(); keepalive = reason() === "pagehide".
    async function run(commit: ReturnType<typeof deferredCommit>): Promise<{ sent: boolean; keepalive: boolean }> {
      const go = await commit.wait();
      if (!go) return { sent: false, keepalive: false };
      return { sent: true, keepalive: commit.reason() === "pagehide" };
    }
    const undone = deferredCommit(50);
    undone.cancel();
    assert.deepEqual(await run(undone), { sent: false, keepalive: false });

    const expired = deferredCommit(10);
    assert.deepEqual(await run(expired), { sent: true, keepalive: false });

    const hidden = deferredCommit(1000);
    hidden.flush("pagehide");
    assert.deepEqual(await run(hidden), { sent: true, keepalive: true });

    const left = deferredCommit(1000);
    left.flush("manual");
    assert.deepEqual(await run(left), { sent: true, keepalive: false });
  });
});

describe("Tablero · «Bloquear habitación» con diálogo nominal (F8) y «Asignarme» / «Asignar a» (F15)", () => {
  it("el botón abre un CocoaDialog destructivo «Bloquear la NNN» / «Mantenerla en venta» y solo se pinta con permiso (D4)", () => {
    assert.match(board, /\{mayBlock && !w\.blocksRoom && w\.roomId \? \(\s*<CocoaButton variant="bordered" tone="neutral" disabled=\{busy\} onClick=\{\(\) => setBlockFor\(w\)\}>\s*\{MANT_ACTIONS\.blockRoom\}/);
    assert.doesNotMatch(board.slice(board.indexOf("function renderDetailActions(")), /blockRoomForWorkOrder\(/, "el botón no bloquea directamente");
    assert.match(board, /export function canBlockRooms\(permissions: readonly string\[\] \| undefined\): boolean/);
    assert.match(board, /permissions\.includes\("maintenance\.workorder\.manage"\) && permissions\.includes\("ai\.high_risk\.confirm"\)/);
    const dialog = board.slice(board.indexOf("<CocoaDialog"), board.indexOf("/>", board.indexOf("<CocoaDialog")));
    assert.match(dialog, /tone="destructive"/);
    assert.match(dialog, /title=\{MANT_ACTIONS\.blockRoomConfirm\(blockRoomNumber\)\}/);
    assert.match(dialog, /confirmLabel=\{MANT_ACTIONS\.blockRoomConfirm\(blockRoomNumber\)\}/);
    assert.match(dialog, /cancelLabel=\{MANT_ACTIONS\.keepRoomOnSale\}/);
    assert.match(dialog, /submitOnEnter/);
    assert.match(dialog, /busy=\{blockBusy\}/);
    assert.equal(MANT_ACTIONS.blockRoomConfirm("305"), "Bloquear la 305");
    assert.equal(MANT_ACTIONS.keepRoomOnSale, "Mantenerla en venta");
  });

  it("al confirmar: POST /block-room optimista sobre blocksRoom y toast con número («Habitación 305 bloqueada.»)", () => {
    const block = board.slice(board.indexOf("async function blockRoom("), board.indexOf("async function resolveOrder("));
    assert.match(block, /patchOrder\(toArray<WorkOrder>\(prev\), w\.id, \{ blocksRoom: true \}\)/);
    assert.match(block, /await blockRoomForWorkOrder\(w\.id\);/);
    assert.match(block, /showToast\(MANT_TOASTS\.roomBlocked\(n\)/);
    assert.equal(MANT_TOASTS.roomBlocked("305"), "Habitación 305 bloqueada.");
    assert.doesNotMatch(board, /"Habitación bloqueada\."/, "nunca sin número (P7)");
  });

  it("«Asignar a» es un CocoaInput con datalist (responsables vistos + sesión) y «Asignarme» hace el mismo PATCH", () => {
    assert.match(board, /export function assigneeSuggestions\(orders: readonly WorkOrder\[\], me: string\): string\[\]/);
    assert.match(board, /const assignees = useMemo\(\(\) => assigneeSuggestions\(orders, me\), \[orders, me\]\);/);
    assert.match(board, /<CocoaField label=\{MANT_ACTIONS\.assignTo\}/);
    assert.match(board, /suggestions=\{assignees\}/);
    assert.match(board, /onBlur=\{\(\) => void assign\(w, assignDraft\)\}/);
    assert.match(board, /if \(event\.key === "Enter"\) \{\s*event\.preventDefault\(\);\s*void assign\(w, assignDraft\);/);
    assert.match(board, /onClick=\{\(\) => void assign\(w, me\)\}>\s*\{MANT_ACTIONS\.assignMe\}/);
    const assign = board.slice(board.indexOf("async function assign("), board.indexOf("async function blockRoom("));
    assert.match(assign, /patchOrder\(toArray<WorkOrder>\(prev\), w\.id, \{ assignedTo: value \}\)/);
    assert.match(assign, /await updateWorkOrder\(w\.id, \{ assignedTo: value \}\);/);
    assert.match(assign, /MANT_TOASTS\.assigned\(ref, value\)/);
    assert.match(assign, /if \(!value \|\| value === \(w\.assignedTo \?\? ""\)\)/, "vacío o sin cambio: nada viaja");
    // REV-04: «Asignarme» no dispara el blur del campo (que asignaba el texto a medias) y una intención con otra en vuelo se encola.
    assert.match(board, /<span onMouseDown=\{\(event\) => event\.preventDefault\(\)\}>\s*<CocoaButton variant="bordered" tone="neutral" disabled=\{busy \|\| !me \|\| \(w\.assignedTo \?\? ""\) === me\} onClick=\{\(\) => void assign\(w, me\)\}>/);
    assert.match(board, /const queuedAssign = useRef<\{ id: string; who: string \} \| null>\(null\);/);
    assert.match(assign, /if \(busyId === w\.id\) \{\s*queuedAssign\.current = \{ id: w\.id, who: value \};\s*return;\s*\}/);
    assert.match(assign, /const queued = queuedAssign\.current;\s*if \(queued && queued\.id === w\.id\) \{\s*queuedAssign\.current = null;\s*void assign\(\{ \.\.\.w, assignedTo \}, queued\.who\);/);
    assert.match(api, /assignedTo\?: string \| null;/, "el PATCH admite null (inversa de «Tomar»)");
    assert.equal(MANT_TOASTS.assigned("a1c3n", "Técnico UXDAY"), "Parte a1c3n → asignado a Técnico UXDAY");
  });

  it("⌘K: nueva orden, asignarme y resolver (sobre la orden elegida y abierta)", () => {
    assert.match(board, /id: "maintenance-new-order", label: MANT_ACTIONS\.newWorkOrder/);
    assert.match(board, /id: "maintenance-assign-me"/);
    assert.match(board, /id: "maintenance-resolve"/);
    assert.match(board, /\.\.\.\(selected && !isClosed\(selected\)/);
  });
});

describe("Densidad, barra de pulgar, ayuda, busy por parte y diccionario (F1, F2, F11, F12, P5, P6)", () => {
  it("las dos páginas declaran density=\"operational\"", () => {
    assert.match(mobile, /density="operational"/);
    assert.match(board, /density="operational"/);
  });

  it("Mis averías: CocoaActionBar también con puntero grueso en tablet y la ayuda bajo la lista con el dedo (D9)", () => {
    assert.match(mobile, /import \{ useCoarsePointer \} from "\.\.\/\.\.\/lib\/useCoarsePointer";/);
    assert.match(mobile, /const coarse = useCoarsePointer\(\);/);
    assert.match(mobile, /<CocoaActionBar\s*mobileOnly=\{!coarse\}/);
    const before = mobile.indexOf("{coarse ? null : help}");
    const list = mobile.indexOf("<CocoaKpiStrip min={320}");
    const after = mobile.indexOf("{coarse ? help : null}");
    assert.ok(before > 0 && list > before && after > list, "ayuda antes de la lista con ratón y después con el dedo");
  });

  it("busy por parte: ninguna acción apaga la tarjeta o la ficha que no tocaste", () => {
    assert.match(mobile, /const \[busy, setBusy\] = useState<Record<string, true>>\(\{\}\);/);
    assert.match(mobile, /busy=\{busy\[item\.workOrderId\] === true\}/);
    assert.match(board, /const \[busyId, setBusyId\] = useState<string \| null>\(null\);/);
    assert.doesNotMatch(board, /setBusy\(true\)/, "sin busy global (F1)");
    assert.doesNotMatch(board, /async function run\(/, "sin await fn\\(\\); refresh\\(\\) global");
  });

  it("etiquetas solo por operations-director-labels.ts: 0 mapas locales de estado/prioridad y 0 enum crudo", () => {
    for (const source of [mobile, board]) {
      assert.match(source, /import \{ priorityLabel, woStatusLabel \} from "\.\/operations-director-labels";/);
      assert.doesNotMatch(source, /const STATUS_LABEL\b/);
      assert.doesNotMatch(source, /const PRIORITY_LABEL\b/);
      assert.doesNotMatch(source, /Record<string, string> = \{ (open|emergency|urgent)/);
    }
    assert.match(board, /STATUS_OPTIONS\.map\(\(s\) => \(\{ value: s, label: woStatusLabel\(s\) \}\)\)/);
    assert.match(board, /PRIORITIES\.map\(\(p\) => \(\{ value: p, label: priorityLabel\(p\) \}\)\)/);
  });

  it("la prioridad «Baja» ya no es un badge tinted neutral (borde 1,35:1 en oscuro, hallazgo de U0)", () => {
    assert.match(mobile, /const PRIORITY_TONE: Record<Priority, CocoaTone> = \{ urgent: "danger", high: "warning", normal: "info", low: "success" \};/);
  });

  it("0 style= inline nuevos (8 y 5 objetos con nombre, como antes)", () => {
    assert.equal(count(mobile, "style={{"), 0);
    assert.equal(count(board, "style={{"), 0);
    assert.ok(count(mobile, "style={") <= 8, `Mis averías: ${count(mobile, "style={")} style={`);
    assert.ok(count(board, "style={") <= 5, `tablero: ${count(board, "style={")} style={`);
  });
});

describe("Ayuda de Mis averías (F12): sin promesas falsas, con «Mías» y «Deshacer»", () => {
  const steps = MAINT_INSTRUCTIONS.howToUse.join("\n");
  it("ya no dice que «Tomar» no asigna a nadie (falso desde FIX-1 · F9)", () => {
    assert.doesNotMatch(steps, /no la asigna a nadie/);
    assert.match(steps, /«Tomar»[^\n]*queda asignada a ti/);
  });
  it("explica «Mías» / «Todas», los 8 segundos de «Deshacer» y que resuelta no se reabre", () => {
    assert.match(steps, /«Mías»/);
    assert.match(steps, /«Todas»/);
    assert.equal((steps.match(/«Deshacer» durante 8 segundos/g) ?? []).length, 2, "Tomar y Resuelta ofrecen deshacer");
    assert.match(steps, /ya no se puede reabrir/);
    assert.match(steps, /«Bloquear la 305» \/ «Mantenerla en venta»/);
  });
  it("sin nombres de personas ni enums del API en la copia", () => {
    const copy = `${MAINT_INSTRUCTIONS.whatIsThis}\n${steps}\n${MAINT_INSTRUCTIONS.tips.join("\n")}`;
    assert.doesNotMatch(copy, /\b(in_progress|waiting_vendor|assignedTo|blocksRoom)\b/);
    assert.doesNotMatch(copy, /UXDAY/);
  });
});
