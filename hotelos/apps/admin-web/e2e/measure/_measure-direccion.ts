import { expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_API_URL } from "../_helpers";

/**
 * Medida automatizada del camino óptimo de DIRECCIÓN (Tanda UX-2 · lote D2;
 * mismo patrón que `_measure.ts` de UX-1, que comparte UX-3 y por eso no se
 * toca). Cada spec d1…d6 recorre el mejor camino disponible hoy con acciones
 * contadas (`countedClick` / `countedPress` / `countedFill`), cuenta las
 * peticiones al API (`page.on("request")` filtrado a E2E_API_URL), marca inicio
 * y fin con `performance.mark` (`ui:<tarea>:start|end`) y escribe el resultado
 * en `e2e/measure/results-direccion.json` (fusionado por tarea).
 *
 * Variantes: d3 y d5 miden además el camino solo teclado (⌘K); `finishVariant`
 * lo guarda bajo `tasks.<tarea>.variants.<nombre>` sin pisar la entrada
 * canónica, en cualquier orden de ejecución.
 *
 * Los objetivos solo se afirman con `MEASURE_STRICT=1`: la baseline de la tanda
 * se registra sin fallar (d2/d4/d6 pueden acabar `completed=false` si el tenant
 * no tiene pendientes, dos hoteles o un cierre sin revisar).
 */

export type TaskId = "d1" | "d2" | "d3" | "d4" | "d5" | "d6";

export type VariantResult = {
  clicks: number;
  keys: number;
  requests: number;
  ms: number;
  completed: boolean;
  path: string[];
  note?: string;
  measuredAt: string;
};

export type MeasureResult = {
  task: TaskId;
  title: string;
  clicks: number;
  keys: number;
  requests: number;
  ms: number;
  completed: boolean;
  path: string[];
  /** Objetivo de clics del brief UX-2 y presupuesto de peticiones (provisional [S]). */
  target: { clicks: number; requests: number };
  /** Ids de solicitud/cierre u otro dato de contexto sin PII (nunca nombres). */
  context?: Record<string, string | number | boolean | null>;
  note?: string;
  strict: boolean;
  measuredAt: string;
  /** Caminos alternativos (p. ej. `teclado`) medidos por la misma spec. */
  variants?: Record<string, VariantResult>;
};

export type ResultsFile = {
  generatedAt: string;
  baseUrl: string;
  apiUrl: string;
  tasks: Partial<Record<TaskId, MeasureResult>>;
};

/** Objetivos por tarea (brief UX-2: las 6 ≤ 4 clics; d1 0 clics) y presupuesto de peticiones (provisional [S]). */
export const TARGETS: Record<TaskId, { clicks: number; requests: number; title: string }> = {
  d1: { clicks: 0, requests: 20, title: "D1 · Revisar el día y los riesgos al aterrizar" },
  d2: { clicks: 3, requests: 16, title: "D2 · Aprobar una solicitud pendiente" },
  d3: { clicks: 3, requests: 14, title: "D3 · Leer ocupación e ingresos del mes de un hotel" },
  d4: { clicks: 3, requests: 14, title: "D4 · Comparar los hoteles de la cartera por ocupación" },
  d5: { clicks: 3, requests: 16, title: "D5 · Exportar un informe del Centro de informes" },
  d6: { clicks: 3, requests: 14, title: "D6 · Revisar el cierre del día" }
};

export const STRICT = process.env.MEASURE_STRICT === "1";

const RESULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), "results-direccion.json");

export type Outcome = { completed: boolean; context?: MeasureResult["context"]; note?: string };

export type Measure = {
  task: TaskId;
  /** Clic contado (1 por acción del usuario; `selectOption` cuenta como clic). */
  countedClick: (locator: Locator, label: string, options?: Parameters<Locator["click"]>[0]) => Promise<void>;
  /** Selección en un <select> nativo: 1 clic. */
  countedSelect: (locator: Locator, label: string, value: string | { label: string }) => Promise<void>;
  /** Tecla o atajo (Enter, Meta+k, Tab…): 1 tecla. */
  countedPress: (page: Page, key: string, label?: string) => Promise<void>;
  /** Escritura en un campo: tantas teclas como caracteres (el texto no se guarda en el resultado). */
  countedFill: (locator: Locator, value: string, label: string) => Promise<void>;
  /** Paso sin coste de interacción (navegación inicial, espera de un evento) que se anota en `path`. */
  step: (label: string) => void;
  /** `performance.mark("ui:<task>:<name>")` en la página. */
  mark: (page: Page, name: string) => Promise<void>;
  /** Arranca el cronómetro y el contador de peticiones (d1: antes del goto; d2…d6: tras aterrizar). */
  start: (page: Page) => Promise<void>;
  /** Para el cronómetro en el evento de dominio y escribe la entrada canónica en results-direccion.json. */
  finish: (page: Page, outcome: Outcome) => Promise<MeasureResult>;
  /** Como `finish`, pero guarda el resultado como variante (p. ej. «teclado») de la tarea. */
  finishVariant: (page: Page, name: string, outcome: Pick<Outcome, "completed" | "note">) => Promise<VariantResult>;
  counters: () => { clicks: number; keys: number; requests: number };
};

export function createMeasure(page: Page, task: TaskId): Measure {
  let clicks = 0;
  let keys = 0;
  let requests = 0;
  let counting = false;
  let startedAt = 0;
  const path: string[] = [];
  const apiPrefix = E2E_API_URL;

  page.on("request", (request) => {
    if (!counting) return;
    if (request.url().startsWith(apiPrefix)) requests += 1;
  });

  async function mark(target: Page, name: string): Promise<void> {
    await target
      .evaluate((markName) => {
        try {
          performance.mark(markName);
        } catch {
          /* performance no disponible */
        }
      }, `ui:${task}:${name}`)
      .catch(() => undefined);
  }

  async function stop(target: Page): Promise<number> {
    const ms = startedAt ? Date.now() - startedAt : 0;
    counting = false;
    await mark(target, "end");
    await target
      .evaluate((name) => {
        try {
          performance.measure(`ui:${name}`, `ui:${name}:start`, `ui:${name}:end`);
        } catch {
          /* marcas ausentes */
        }
      }, task)
      .catch(() => undefined);
    return ms;
  }

  function assertStrict(label: string, outcome: { completed: boolean }): void {
    if (!STRICT) return;
    expect(outcome.completed, `${label}: la tarea debe completarse en modo estricto`).toBe(true);
    expect(clicks, `${label}: clics ≤ objetivo del brief UX-2`).toBeLessThanOrEqual(TARGETS[task].clicks);
    expect(requests, `${label}: peticiones ≤ presupuesto [S]`).toBeLessThanOrEqual(TARGETS[task].requests);
  }

  const measure: Measure = {
    task,
    async countedClick(locator, label, options) {
      await locator.click(options);
      clicks += 1;
      path.push(`click:${label}`);
    },
    async countedSelect(locator, label, value) {
      await locator.selectOption(value);
      clicks += 1;
      path.push(`select:${label}`);
    },
    async countedPress(target, key, label) {
      await target.keyboard.press(key);
      keys += 1;
      path.push(`press:${label ?? key}`);
    },
    async countedFill(locator, value, label) {
      await locator.fill(value);
      keys += value.length;
      path.push(`fill:${label}(${value.length})`);
    },
    step(label) {
      path.push(`step:${label}`);
    },
    mark,
    async start(target) {
      counting = true;
      startedAt = Date.now();
      await mark(target, "start");
    },
    async finish(target, outcome) {
      const ms = await stop(target);
      const result: MeasureResult = {
        task,
        title: TARGETS[task].title,
        clicks,
        keys,
        requests,
        ms,
        completed: outcome.completed,
        path: [...path],
        target: { clicks: TARGETS[task].clicks, requests: TARGETS[task].requests },
        context: outcome.context,
        note: outcome.note,
        strict: STRICT,
        measuredAt: new Date().toISOString()
      };
      writeResult(task, result);
      // eslint-disable-next-line no-console
      console.log(`[measure:${task}] clicks=${clicks} keys=${keys} requests=${requests} ms=${ms} completed=${outcome.completed}${outcome.note ? ` · ${outcome.note}` : ""}`);
      assertStrict(task, outcome);
      return result;
    },
    async finishVariant(target, name, outcome) {
      const ms = await stop(target);
      const variant: VariantResult = { clicks, keys, requests, ms, completed: outcome.completed, path: [...path], note: outcome.note, measuredAt: new Date().toISOString() };
      writeVariant(task, name, variant);
      // eslint-disable-next-line no-console
      console.log(`[measure:${task}:${name}] clicks=${clicks} keys=${keys} requests=${requests} ms=${ms} completed=${outcome.completed}${outcome.note ? ` · ${outcome.note}` : ""}`);
      assertStrict(`${task}:${name}`, outcome);
      return variant;
    },
    counters: () => ({ clicks, keys, requests })
  };
  return measure;
}

export function readResults(): ResultsFile {
  try {
    const parsed = JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as Partial<ResultsFile>;
    return {
      generatedAt: parsed.generatedAt ?? new Date().toISOString(),
      baseUrl: parsed.baseUrl ?? "",
      apiUrl: parsed.apiUrl ?? "",
      tasks: parsed.tasks ?? {}
    };
  } catch {
    return { generatedAt: new Date().toISOString(), baseUrl: "", apiUrl: "", tasks: {} };
  }
}

function writeFile(tasks: ResultsFile["tasks"]): void {
  const next: ResultsFile = {
    generatedAt: new Date().toISOString(),
    baseUrl: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    apiUrl: E2E_API_URL,
    tasks
  };
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  const tmp = `${RESULTS_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, RESULTS_PATH);
}

/** Fusiona la entrada canónica de una tarea en results-direccion.json conservando sus variantes (escritura atómica). */
export function writeResult(task: TaskId, result: MeasureResult): void {
  const current = readResults();
  const variants = current.tasks[task]?.variants;
  writeFile({ ...current.tasks, [task]: variants ? { ...result, variants } : result });
}

/** Guarda una variante bajo `tasks.<tarea>.variants.<nombre>`; si la entrada canónica aún no existe, deja un esqueleto sin medida. */
export function writeVariant(task: TaskId, name: string, variant: VariantResult): void {
  const current = readResults();
  const existing: MeasureResult = current.tasks[task] ?? {
    task,
    title: TARGETS[task].title,
    clicks: 0,
    keys: 0,
    requests: 0,
    ms: 0,
    completed: false,
    path: [],
    target: { clicks: TARGETS[task].clicks, requests: TARGETS[task].requests },
    note: "sin medida canónica todavía",
    strict: STRICT,
    measuredAt: new Date().toISOString()
  };
  writeFile({ ...current.tasks, [task]: { ...existing, variants: { ...(existing.variants ?? {}), [name]: variant } } });
}

/** Entrada del menú lateral (navigation/Sidebar.tsx: `.c22-nav-item[data-nav-item=<screenKey>]`; los grupos vienen abiertos por defecto). */
export function navItem(page: Page, screenKey: string): Locator {
  return page.locator(`.c22-nav-item[data-nav-item="${screenKey}"]`).first();
}

/** Filas con datos de una CocoaTable (sin la cabecera ni las filas vacías de carga). */
export function dataRows(table: Locator): Locator {
  return table.getByRole("row").filter({ has: table.page().locator("td") });
}

/** Toast del ToastHost (`data-cocoa="toast"`; lo anuncia la región viva del shell) que contiene el texto. */
export function toastContaining(page: Page, text: string | RegExp): Locator {
  return page.locator('[data-cocoa="toast"]').filter({ hasText: text }).first();
}

/** Paleta ⌘K (components/CommandPalette.tsx: diálogo «Buscar en la aplicación»). */
export function commandPalette(page: Page): Locator {
  return page.getByRole("dialog", { name: "Buscar en la aplicación" });
}

/** Porcentaje «62,5 %» / «62,5%» → 62.5 (NaN si la celda no es un porcentaje). */
export function parsePercent(text: string): number {
  const match = text.replace(/\s/g, "").match(/(-?\d+(?:[.,]\d+)?)%/);
  return match ? Number(match[1].replace(",", ".")) : Number.NaN;
}
