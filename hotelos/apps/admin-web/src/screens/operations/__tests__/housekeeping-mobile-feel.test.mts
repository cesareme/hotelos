import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HK_INSTRUCTIONS } from "../../../content/screen-instructions/housekeeping.ts";

// Contrato de fuente de Tanda UX-3 · P2 (Mi turno, HousekeepingMobileScreen;
// docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md §4.2, §5, §6; F1 F3 F5 F11 F12
// F14, D1): chips de sección recordados por propiedad, tarjeta «Siguiente»,
// «Limpia»/«Inspeccionada» optimistas con «Deshacer» diferido, «Limpia» cierra
// la tarea (PATCH done tras el POST), densidad operativa, barra de acciones en
// tablet, ayuda plegada con el dedo y busy por habitación. Corrector UX-3-REV:
// toast sin pausa + «Deshacer» tardío honesto (REV-01), POST + PATCH a la vez en
// pagehide (REV-03), ayuda no descartable con el dedo (REV-06) y etiquetas de
// prioridad por priorityLabel (REV-07). La pantalla no se importa (React +
// import.meta.env); se lee el fuente sin comentarios.
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const source = stripComments(readFileSync(new URL("../HousekeepingMobileScreen.tsx", import.meta.url), "utf8"));
const slice = (from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `bloque «${from}» … «${to}» no encontrado`);
  return source.slice(start, end);
};
const deferredWrite = slice("function deferredRoomWrite(", "function markClean(");
const markClean = slice("function markClean(", "function markInspected(");
const markInspected = slice("function markInspected(", "async function startCleaning(");
const startCleaning = slice("async function startCleaning(", "function openReport(");
const reportSent = slice("function reportSent(", "function RoomCard(");
const roomCard = source.slice(source.indexOf("function RoomCard("));

describe("Mi turno · chips de sección recordados por propiedad (§4.2, F5, D8)", () => {
  it("el grupo «Filtrar por sección» va antes del de prioridad, con «Todas» + sections[] del API y aria-pressed", () => {
    const section = source.indexOf('aria-label="Filtrar por sección"');
    const priority = source.indexOf('aria-label="Filtrar por prioridad"');
    assert.ok(section >= 0 && priority > section, "sección antes que prioridad");
    assert.match(source, /const sections = toArray<HkSection>\(data\?\.sections\);/);
    assert.match(source, /\{PISOS_ACTIONS\.allSections\} · \{number\(rooms\.length\)\}/);
    assert.match(source, /\{s\.name\} · \{number\(s\.total\)\}/);
    assert.match(source, /aria-pressed=\{activeSection === ALL_SECTIONS\}/);
    assert.match(source, /sections\.length > 0 \? \(/, "sin secciones (o degradado) no se pintan chips");
  });

  it("la sección elegida se recuerda en localStorage por propiedad con try/catch y vuelve como «Mi sección»", () => {
    assert.match(source, /const SECTION_STORAGE_PREFIX = "hotelos\.pisos\.mi-turno\.section:";/);
    assert.match(source, /function sectionStorageKey\(propertyId: string\): string \{\s*return `\$\{SECTION_STORAGE_PREFIX\}\$\{propertyId\}`;/);
    assert.match(source, /function readRememberedSection\(propertyId: string\): string \| null \{[\s\S]*?try \{\s*return window\.localStorage\.getItem\(sectionStorageKey\(propertyId\)\);\s*\} catch \{\s*return null;/);
    assert.match(source, /function rememberSection\(propertyId: string, sectionId: string \| null\): void \{[\s\S]*?try \{[\s\S]*?window\.localStorage\.setItem\(sectionStorageKey\(propertyId\), sectionId\)[\s\S]*?window\.localStorage\.removeItem\(sectionStorageKey\(propertyId\)\)[\s\S]*?\} catch \{/);
    assert.match(source, /useState<string>\(\(\) => readRememberedSection\(propertyId\) \?\? ALL_SECTIONS\)/);
    assert.match(source, /rememberSection\(propertyId, id === ALL_SECTIONS \? null : id\);/);
    assert.match(source, /\{activeSection === ALL_SECTIONS \? "Sección" : PISOS_ACTIONS\.mySection\}/);
    assert.match(source, /function effectiveSection\(section: string, sections: readonly HkSection\[\]\): string/, "una sección borrada vuelve a «Todas»");
  });

  it("los recuentos de prioridad y la lista se calculan sobre la sección elegida", () => {
    assert.match(source, /const inSection = activeSection === ALL_SECTIONS \? rooms : rooms\.filter\(\(r\) => r\.sectionId === activeSection\);/);
    assert.match(source, /const filtered = filter === "all" \? inSection : inSection\.filter\(\(r\) => r\.priority === filter\);/);
    assert.match(source, /const counts = countByPriority\(inSection\);/);
  });
});

describe("Mi turno · tarjeta «Siguiente» arriba (§4.2)", () => {
  it("es la primera habitación de la lista filtrada; el resto sigue en la rejilla", () => {
    assert.match(source, /const next = filtered\[0\];\s*const rest = filtered\.slice\(1\);/);
    assert.match(source, /<CocoaSection variant="plain" padding="none" title=\{PISOS_ACTIONS\.next\} meta=\{countLabel\}>\s*<RoomCard\s+key=\{next\.roomId\}\s+room=\{next\}\s+next/);
    assert.match(source, /rest\.length > 0 \? \(\s*<CocoaKpiStrip min=\{320\} aria-label="Habitaciones del turno">\s*\{rest\.map\(\(room\) => \(/);
  });

  it("la tarjeta sigue siendo un group «Habitación NNN» (specs p1/p2) con el número en title-1 y el primario grande en su propia fila", () => {
    assert.match(roomCard, /aria-label=\{`Habitación \$\{room\.roomNumber\}`\}/);
    assert.match(roomCard, /<strong style=\{roomNumberStyle\}>\{room\.roomNumber\}<\/strong>/);
    assert.match(source, /fontSize: "var\(--cocoa-fs-title-1\)"/);
    assert.match(roomCard, /const primary = next \? actions\.find\(\(a\) => a\.primary\) : undefined;/);
    assert.match(roomCard, /<CocoaButton size="large" loading=\{busy\} onClick=\{primary\.onClick\}>/);
    assert.match(roomCard, /variant=\{next \? "elevated" : "bordered"\}/);
  });

  it("un primario por tarjeta según el estado (P1): Iniciar · Limpia (en limpieza) · Inspeccionada (limpia)", () => {
    assert.match(roomCard, /if \(!isInProgress && !isClean\) actions\.push\(\{ key: "start", label: PISOS_ACTIONS\.startCleaning, onClick: onStart, primary: true \}\);/);
    assert.match(roomCard, /if \(!isInspected\) actions\.push\(\{ key: "clean", label: PISOS_ACTIONS\.clean, onClick: onComplete, primary: isInProgress \}\);/);
    assert.match(roomCard, /actions\.push\(\{ key: "inspect", label: PISOS_ACTIONS\.inspected, onClick: onInspect, primary: isClean && !isInProgress \}\);/);
    assert.match(roomCard, /variant=\{a\.primary \? "filled" : "bordered"\}/);
    assert.equal((roomCard.match(/variant="filled"/g) ?? []).length, 0, "ningún filled fijo: el primario sale del estado");
  });
});

describe("Mi turno · optimista + «Deshacer» diferido (§5, F1, F3, D7)", () => {
  it("usa mutate de useApiData y la primitiva deferredCommit de D0 con la ventana de 8 s", () => {
    assert.match(source, /import \{ useApiData, type MutateRequest \} from "\.\.\/\.\.\/hooks\/useApiData";/);
    assert.match(source, /import \{ deferredCommit, undoDeferred, type DeferredFlushReason \} from "\.\/deferred-commit";/);
    assert.match(source, /const \{ data, loading, error, refresh, mutate \} = useApiData<HkData>\(/);
    assert.match(source, /const UNDO_MS = 8000;/);
    assert.match(deferredWrite, /const pending = deferredCommit\(UNDO_MS\);/);
  });

  it("el toast lleva «Deshacer» (undoDeferred: cancela o avisa «ya enviada»), no se pausa con el ratón ni el foco y se anuncia en la región viva (REV-01)", () => {
    assert.match(source, /import \{ deferredCommit, undoDeferred, type DeferredFlushReason \} from "\.\/deferred-commit";/);
    assert.match(deferredWrite, /pauseOnHover: false,\s*action: \{ label: PISOS_ACTIONS\.undo, onAction: \(\) => void undoDeferred\(pending, \(\) => showToast\(PISOS_TOASTS\.undoExpired\(room\.roomNumber\), \{ variant: "warning" \}\)\) \},\s*announce: input\.toast/);
    assert.doesNotMatch(deferredWrite, /onAction: \(\) => pending\.cancel\(\)/, "un «Deshacer» con la ventana agotada nunca calla");
  });

  it("deshacer no envía nada y aplica el estado anterior sobre la caché actual (no rollback al snapshot)", () => {
    assert.match(deferredWrite, /const go = await pending\.wait\(\);\s*if \(!go\) \{\s*await mutate\(\(prev\) => patchRoom\(prev, room\.roomId, revert\), async \(\) => undefined\);\s*showToast\(PISOS_TOASTS\.undone\(room\.roomNumber\), \{ variant: "info" \}\);\s*return;\s*\}/);
    assert.match(deferredWrite, /const revert: Partial<HkRoom> = \{ housekeepingStatus: room\.housekeepingStatus, taskStatus: room\.taskStatus \};/);
  });

  it("una ventana por habitación: la segunda acción vacía la anterior; pagehide vacía todas con keepalive; salir de la pantalla también", () => {
    assert.match(deferredWrite, /pendingByRoom\.current\.get\(room\.roomId\)\?\.commit\.flush\("manual"\);/);
    assert.match(deferredWrite, /await input\.write\(request, pending\.reason\(\) === "pagehide"\);/);
    assert.match(source, /window\.addEventListener\("pagehide", onPageHide\);/);
    assert.match(source, /window\.removeEventListener\("pagehide", onPageHide\);\s*flushPending\("manual"\);/);
    assert.match(markClean, /body: \{ status: "clean" \}, keepalive \}/);
    assert.match(markInspected, /body: \{ status: "inspected" \}, keepalive \}/);
  });

  it("«Actualizar» vacía las pendientes y espera a que lleguen antes de revalidar (R2); ninguna acción hace refresh() a ciegas", () => {
    assert.match(source, /const refreshTurn = useCallback\(async \(\) => \{\s*const inFlight = Array\.from\(pendingByRoom\.current\.values\(\), \(pending\) => pending\.done\);\s*flushPending\("manual"\);\s*await Promise\.allSettled\(inFlight\);\s*refresh\(\);/);
    for (const [name, block] of [
      ["deferredRoomWrite", deferredWrite],
      ["markClean", markClean],
      ["markInspected", markInspected],
      ["startCleaning", startCleaning]
    ] as const) {
      assert.doesNotMatch(block, /\brefresh\(\)/, `${name} no llama a refresh()`);
      assert.doesNotMatch(block, /postAction\(/, `${name} no usa postAction (viaja por mutate)`);
    }
    assert.match(source, /primary=\{\{ label: ACTIONS\.refresh, onClick: \(\) => void refreshTurn\(\), loading: refreshing \}\}/);
  });

  it("«Iniciar» es optimista sin deshacer (§5) y tampoco espera un refresh", () => {
    assert.match(startCleaning, /showToast\(PISOS_TOASTS\.cleaningStarted\(room\.roomNumber\), \{ variant: "success" \}\);/);
    assert.match(startCleaning, /patchRoom\(prev, room\.roomId, room\.taskId \? \{ taskStatus: "in_progress" \} : \{ housekeepingStatus: "dirty" \}\)/);
    assert.doesNotMatch(startCleaning, /deferredCommit|PISOS_ACTIONS\.undo/);
  });
});

describe("Mi turno · «Limpia» cierra la tarea abierta (D1, F14)", () => {
  it("tras el POST de estado clean envía PATCH /housekeeping/tasks/:id { status: done } solo si hay tarea abierta", () => {
    assert.match(markClean, /const closesTask = Boolean\(room\.taskId\) && room\.taskStatus !== "done";/);
    assert.match(markClean, /const markRoom = \(\) => request<unknown>\(`\/rooms\/\$\{encodeURIComponent\(room\.roomId\)\}\/housekeeping-status`, \{ method: "POST", body: \{ status: "clean" \}, keepalive \}\);/);
    assert.match(markClean, /if \(!closesTask \|\| !room\.taskId\) \{\s*await markRoom\(\);\s*return;\s*\}/);
    assert.match(markClean, /const closeTask = \(\) => request<unknown>\(`\/housekeeping\/tasks\/\$\{encodeURIComponent\(taskId\)\}`, \{ method: "PATCH", body: \{ status: "done" \}, keepalive \}\);/);
    assert.match(markClean, /await markRoom\(\);\s*try \{\s*await closeTask\(\);/, "sin pagehide el PATCH done va después del POST clean");
  });

  it("en pagehide (keepalive) estado y tarea viajan A LA VEZ: tras la descarga no queda JS para el segundo (REV-03)", () => {
    assert.match(markClean, /if \(keepalive\) \{[\s\S]*?const \[state, task\] = await Promise\.allSettled\(\[markRoom\(\), closeTask\(\)\]\);\s*if \(state\.status === "rejected"\) throw state\.reason;\s*if \(task\.status === "rejected"\) showToast\(taskStillOpen\(task\.reason\), \{ variant: "warning" \}\);\s*return;\s*\}/);
  });

  it("toast «Hab. NNN → Limpia · tarea cerrada» cuando cierra la tarea y «Hab. NNN → Limpia» si no; el fallo del cierre avisa sin deshacer la limpieza", () => {
    assert.match(markClean, /toast: closesTask \? PISOS_TOASTS\.hkCleanTaskClosed\(n\) : PISOS_TOASTS\.hkClean\(n\),/);
    assert.match(markClean, /const taskStillOpen = \(error: unknown\) => `Hab\. \$\{n\} limpia, pero la tarea sigue abierta: \$\{errorMessage\(error, "no se pudo cerrar"\)\}`;/);
    assert.match(markClean, /\} catch \(error\) \{\s*showToast\(taskStillOpen\(error\), \{ variant: "warning" \}\);/);
    assert.match(markClean, /optimistic: \{ housekeepingStatus: room\.housekeepingStatus === "inspected" \? "inspected" : "clean", \.\.\.\(closesTask \? \{ taskStatus: "done" \} : \{\}\) \}/);
  });
});

describe("Mi turno · tablet y densidad (§6, F11, F12, D9)", () => {
  it("density=\"operational\" y CocoaActionBar también en tablet (mobileOnly solo con puntero fino)", () => {
    assert.match(source, /import \{ useCoarsePointer \} from "\.\.\/\.\.\/lib\/useCoarsePointer";/);
    assert.match(source, /const coarse = useCoarsePointer\(\);/);
    assert.match(source, /density="operational"/);
    assert.match(source, /<CocoaActionBar\s+mobileOnly=\{!coarse\}\s+publishToastOffset/);
  });

  it("la ayuda va antes de la lista con ratón y plegada bajo la lista con el dedo (aria-expanded), sin tocar CocoaScreenInstructionsCard", () => {
    const top = source.indexOf("{!coarse ? help : null}");
    const list = source.indexOf('aria-label="Habitaciones del turno"');
    const folded = source.indexOf("{coarse ? (");
    assert.ok(top >= 0 && list > top && folded > list, "ayuda arriba (ratón) · lista · ayuda plegada (dedo)");
    assert.match(source, /aria-expanded=\{helpOpen\}/);
    assert.match(source, /\{helpOpen \? <div id="housekeeping-help">\{help\}<\/div> : null\}/);
    // REV-06: con el dedo la tarjeta plegada no es descartable (una descartada dejaba el botón «Ayuda» muerto); con ratón sigue recordándose.
    assert.match(source, /<CocoaScreenInstructionsCard\s+title="Housekeeping"[\s\S]*?dismissible=\{!coarse\}\s+persistKey=\{coarse \? undefined : "housekeeping"\}/);
  });

  it("etiquetas de prioridad solo por priorityLabel: 0 mapas locales de etiquetas (P6, REV-07)", () => {
    assert.match(source, /import \{ priorityLabel \} from "\.\/operations-director-labels";/);
    assert.doesNotMatch(source, /const PRIORITY_LABEL\b/);
    assert.doesNotMatch(source, /Record<Priority, string>/);
    assert.doesNotMatch(source, /"Urgente"|"Alta"|"Normal"|"Baja"/, "ningún literal de prioridad en la pantalla");
    assert.match(source, /\{ id: "urgent", label: priorityLabel\("urgent"\) \}/);
    assert.match(roomCard, /\{priorityLabel\(room\.priority\)\}<\/CocoaBadge>/);
  });

  it("busy por habitación (Set), nunca un busy global", () => {
    assert.match(source, /useState<ReadonlySet<string>>\(\(\) => new Set\(\)\)/);
    assert.match(source, /busy=\{busy\.has\(next\.roomId\)\}/);
    assert.match(source, /busy=\{busy\.has\(room\.roomId\)\}/);
    assert.doesNotMatch(source, /busy === room\.roomId|setBusy\(null\)/);
  });

  it("0 estilos inline nuevos (solo los objetos con nombre ya existentes) y el diccionario de estados", () => {
    assert.doesNotMatch(source, /style=\{\{/);
    assert.match(source, /roomStatus\(hk\)/);
  });
});

describe("Mi turno · «Reportar» abre ReportIncidentDrawer (P4, F4)", () => {
  it("el cajón de solo texto ya no vive en la pantalla: se monta ReportIncidentDrawer con room/onClose/onReported", () => {
    assert.match(source, /import \{ ReportIncidentDrawer, type ReportIncidentResult \} from "\.\/ReportIncidentDrawer";/);
    assert.doesNotMatch(source, /<CocoaDrawer/, "el CocoaDrawer inline de P2 lo sustituye ReportIncidentDrawer");
    assert.doesNotMatch(source, /postAction\("\/work-orders"/, "el POST /work-orders viaja por createWorkOrder dentro del cajón");
    assert.match(source, /function openReport\(room: HkRoom\) \{\s*setReportFor\(room\);\s*\}/);
    assert.match(source, /<ReportIncidentDrawer room=\{reportFor \? \{ roomId: reportFor\.roomId, roomNumber: reportFor\.roomNumber \} : null\} onClose=\{\(\) => setReportFor\(null\)\} onReported=\{reportSent\} \/>/);
  });

  it("al volver del cajón: toast con número y fotos, cierre y «+1 incidencia» optimista por mutate (sin refresh a ciegas)", () => {
    assert.match(reportSent, /const message = PISOS_TOASTS\.incidentReported\(n, result\.photos\);/);
    assert.match(reportSent, /setReportFor\(null\);\s*showToast\(message, \{ variant: "success", announce: message \}\);/);
    assert.match(reportSent, /openIncidents: \(toArray<HkRoom>\(prev\.rooms\)\.find\(\(r\) => r\.roomId === result\.room\.roomId\)\?\.openIncidents \?\? 0\) \+ 1/);
    assert.doesNotMatch(reportSent, /\brefresh\(\)/);
  });
});

describe("Ayuda de Mi turno (screen-instructions/housekeeping.ts)", () => {
  it("explica la sección recordada, la tarjeta «Siguiente», «Deshacer» y que «Limpia» cierra la tarea", () => {
    const steps = HK_INSTRUCTIONS.howToUse.join(" ");
    assert.match(HK_INSTRUCTIONS.whatIsThis, /tu sección/);
    assert.match(HK_INSTRUCTIONS.whatIsThis, /«Siguiente»/);
    assert.match(steps, /«Mi sección»/);
    assert.match(steps, /«Siguiente» es la primera habitación/);
    assert.match(steps, /«Limpia».*su tarea se cierra/);
    assert.match(steps, /«Deshacer»/);
    assert.doesNotMatch(steps, /Tarea empezar/, "sin infinitivos como aviso (F13)");
  });
});
