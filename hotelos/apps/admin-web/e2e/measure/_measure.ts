import { expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_API_URL } from "../_helpers";

/**
 * Medida automatizada del camino óptimo (Tanda UX-1 · lote U1 ·
 * docs/design/UX-RECEPCION-FEEL.md §8.6 y §8.3).
 *
 * Cada spec t1…t6 recorre el MEJOR camino disponible hoy con acciones contadas
 * (`countedClick` / `countedPress` / `countedFill`), cuenta las peticiones al
 * API (`page.on("request")` filtrado a E2E_API_URL), marca el inicio y el fin
 * con `performance.mark` en la página (nombres estables `ui:<tarea>:start|end`)
 * y escribe el resultado en `e2e/measure/results.json` (fusionado por tarea).
 *
 * Los objetivos (§8.2 / §8.3) solo se afirman con `MEASURE_STRICT=1`: en la
 * baseline de esta tanda (antes de U6) se registran sin fallar; U6+ enciende el
 * modo estricto. Los presupuestos de peticiones son provisionales [S], derivados
 * de §6.2 (Mi día al aterrizar 2 rondas; drawer 1 ronda + catálogos; acción
 * ≤ 4 POST; revalidación de los dashboards afectados).
 */

export type TaskId = "t1" | "t2" | "t3" | "t4" | "t5" | "t6";

export type MeasureResult = {
  task: TaskId;
  title: string;
  clicks: number;
  keys: number;
  requests: number;
  ms: number;
  completed: boolean;
  path: string[];
  /** Objetivo de clics de §8.2 / §8.3 y presupuesto de peticiones de §6.2 [S]. */
  target: { clicks: number; requests: number };
  /** Código de reserva u otro dato de contexto sin PII (nunca nombres). */
  context?: Record<string, string | number | boolean | null>;
  note?: string;
  strict: boolean;
  measuredAt: string;
};

export type ResultsFile = {
  generatedAt: string;
  baseUrl: string;
  apiUrl: string;
  tasks: Partial<Record<TaskId, MeasureResult>>;
};

/** Objetivos por tarea (§8.3 «Clics y teclas») y presupuesto de peticiones (§6.2, provisional [S]). */
export const TARGETS: Record<TaskId, { clicks: number; requests: number; title: string }> = {
  t1: { clicks: 4, requests: 12, title: "T1 · Check-in de una llegada sin habitación" },
  t2: { clicks: 11, requests: 30, title: "T2 · Walk-in: crear, cobrar y check-in" },
  t3: { clicks: 3, requests: 12, title: "T3 · Salida con 120 € pendientes: cobrar y cerrar" },
  t4: { clicks: 4, requests: 10, title: "T4 · Avería: cambiar de habitación a un alojado" },
  t5: { clicks: 7, requests: 24, title: "T5 · Reserva por teléfono para una empresa" },
  t6: { clicks: 6, requests: 12, title: "T6 · Buscar por apellido y añadir un cargo de 12 €" }
};

export const STRICT = process.env.MEASURE_STRICT === "1";

const RESULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), "results.json");

export type Measure = {
  task: TaskId;
  /** Clic contado (1 por acción del usuario; `selectOption` cuenta como clic). */
  countedClick: (locator: Locator, label: string, options?: Parameters<Locator["click"]>[0]) => Promise<void>;
  /** Selección en un <select> nativo: 1 clic. */
  countedSelect: (locator: Locator, label: string, value: string | { label: string }) => Promise<void>;
  /** Tecla o atajo (Enter, Meta+k…): 1 tecla. */
  countedPress: (page: Page, key: string, label?: string) => Promise<void>;
  /** Escritura en un campo: tantas teclas como caracteres (el texto no se guarda en el resultado). */
  countedFill: (locator: Locator, value: string, label: string) => Promise<void>;
  /** Paso sin coste de interacción (navegación inicial, espera de un evento) que se anota en `path`. */
  step: (label: string) => void;
  /** `performance.mark("ui:<task>:<name>")` en la página. */
  mark: (page: Page, name: string) => Promise<void>;
  /** Arranca el cronómetro y el contador de peticiones (tras aterrizar en Mi día). */
  start: (page: Page) => Promise<void>;
  /** Para el cronómetro en el evento de dominio y escribe results.json. */
  finish: (page: Page, outcome: { completed: boolean; context?: MeasureResult["context"]; note?: string }) => Promise<MeasureResult>;
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
      if (STRICT) {
        expect(outcome.completed, `${task}: la tarea debe completarse en modo estricto`).toBe(true);
        expect(clicks, `${task}: clics ≤ objetivo §8.3`).toBeLessThanOrEqual(TARGETS[task].clicks);
        expect(requests, `${task}: peticiones ≤ presupuesto §6.2`).toBeLessThanOrEqual(TARGETS[task].requests);
      }
      return result;
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

/** Fusiona el resultado de una tarea en results.json (escritura atómica). */
export function writeResult(task: TaskId, result: MeasureResult): void {
  const current = readResults();
  const next: ResultsFile = {
    generatedAt: new Date().toISOString(),
    baseUrl: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    apiUrl: E2E_API_URL,
    tasks: { ...current.tasks, [task]: result }
  };
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  const tmp = `${RESULTS_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, RESULTS_PATH);
}

/** Mi día listo: KPI «Llegadas hoy» visible (FrontDeskDashboard.tsx CocoaKpi). */
export async function waitForMiDia(page: Page): Promise<void> {
  await expect(page.getByText("Llegan hoy").first()).toBeVisible({ timeout: 15_000 });
}

/** Fila de una tabla de Mi día que contiene un texto (código de reserva en «Solicitudes» o número de habitación). */
export function rowContaining(page: Page, text: string | RegExp): Locator {
  return page.getByRole("row").filter({ hasText: text }).first();
}

/** Toast del ToastHost (`data-cocoa="toast"`; lo anuncia la región viva del shell, L-04) que contiene el texto. */
export function toastContaining(page: Page, text: string | RegExp): Locator {
  return page.locator('[data-cocoa="toast"]').filter({ hasText: text }).first();
}
