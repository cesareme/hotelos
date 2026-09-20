import { expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_API_URL } from "../_helpers";
import type { PisosVariant } from "../pisos/_pisos";

/**
 * Medida automatizada del camino óptimo de pisos y mantenimiento (Tanda UX-3 ·
 * lote U0, cerrado por Q1 · docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md §7;
 * mismo método que `_measure.ts` de UX-1 §8.6, que no se toca: contrato
 * seed-ux-day-contract).
 *
 * Cada spec p1…p6 recorre el mejor camino disponible dos veces —con ratón a
 * 1280 × 900 y en la tablet de pasillo a 820 × 1180 con `hasTouch` + pointer:
 * coarse— con acciones contadas (`countedClick` = clic o toque, `countedPress`,
 * `countedFill`), cuenta las peticiones al API de la página (y de las páginas
 * que `attach` añada: la segunda persona de p1), marca inicio y fin con
 * `performance.mark` (`ui:<tarea>:<variante>:start|end`) y escribe el resultado
 * en `e2e/measure/results-pisos.json` (fusionado por tarea y variante).
 *
 * Con `MEASURE_STRICT=1` (medida final; la baseline de U0 se registró sin
 * fallar: p4 acabó `completed: false` porque «Reportar» no admitía foto, F4) se
 * afirma, por tarea y variante: completada; clics ≤ objetivo §7 (≤ 3; p2 ≤ 1);
 * peticiones ≤ presupuesto [S]; y NO PEOR que la baseline de U0
 * (`measure-baseline-2026-09-20.json`, solo si aquella acabó `completed`) en
 * peticiones y en clics, con el toque extra que el diseño acepta
 * (`BASELINE_CLICK_ALLOWANCE_P`: p5 +1 por el chip de alcance «Mías»/«Todas»,
 * §4.4; p6 +1 por el diálogo nominal de bloqueo, §5). Corrector UX-3-REV-M01:
 * antes la cabecera prometía la comparación y el estricto no la hacía.
 *
 * Escrituras diferidas (§5): «Limpia», «Inspeccionar», «Resuelta» y «Resolver»
 * viajan a los 8 s (o en pagehide). Las specs esperan la respuesta del API
 * ANTES de `finish`, así que `ms` incluye la ventana de «Deshacer» (como T6 de
 * UX-1: «el tiempo incluye la ventana de deshacer de 8 s antes del POST»).
 *
 * Fases (Q1): una tarea con vuelta atrás (p6: bloquear con diálogo nominal y
 * después desbloquear) mide la tarea principal con el arnés y anota la segunda
 * fase con otro arnés cuyo `snapshot()` se añade al resultado con `amend()`;
 * el objetivo de clics se afirma sobre la tarea principal (diseño §2: «bloquear
 * ≤ 3 con diálogo nominal · desbloquear aparte»).
 */

export type PisosTaskId = "p1" | "p2" | "p3" | "p4" | "p5" | "p6";
export type { PisosVariant };

/** Contadores acumulados en un punto del camino (una fase con nombre). */
export type MeasurePhaseP = { name: string; clicks: number; keys: number; requests: number; ms: number; path: string[] };

export type MeasureResultP = {
  task: PisosTaskId;
  variant: PisosVariant;
  viewport: { width: number; height: number } | null;
  touch: boolean;
  title: string;
  clicks: number;
  keys: number;
  requests: number;
  ms: number;
  completed: boolean;
  path: string[];
  /** Objetivo de clics (§7) y presupuesto de peticiones [S]. */
  target: { clicks: number; requests: number };
  /** Número de habitación, id de tarea o parte: nunca nombres. */
  context?: Record<string, string | number | boolean | null>;
  /** Fases medidas aparte (p6: bloquear / desbloquear); `clicks` es la tarea principal. */
  phases?: MeasurePhaseP[];
  note?: string;
  strict: boolean;
  measuredAt: string;
};

export type ResultsFileP = {
  generatedAt: string;
  baseUrl: string;
  apiUrl: string;
  tasks: Partial<Record<PisosTaskId, Partial<Record<PisosVariant, MeasureResultP>>>>;
};

/**
 * Objetivos por tarea (diseño §2 y §7: ≤ 3 toques; p2 ≤ 1 con la sección
 * recordada; p6 = bloquear ≤ 3 con diálogo nominal, desbloquear aparte) y
 * presupuesto de peticiones [S].
 */
export const TARGETS_P: Record<PisosTaskId, { clicks: number; requests: number; title: string }> = {
  p1: { clicks: 3, requests: 16, title: "P1 · Marcar limpia e inspeccionar una habitación" },
  p2: { clicks: 1, requests: 14, title: "P2 · Ver mi turno y la siguiente habitación" },
  p3: { clicks: 3, requests: 12, title: "P3 · Crear una tarea de limpieza" },
  p4: { clicks: 3, requests: 12, title: "P4 · Reportar una avería con foto" },
  p5: { clicks: 3, requests: 12, title: "P5 · Tomar y resolver un parte" },
  p6: { clicks: 3, requests: 16, title: "P6 · Bloquear y desbloquear una habitación" }
};

export const STRICT = process.env.MEASURE_STRICT === "1";

const RESULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), "results-pisos.json");

/** Baseline de U0 (copiada a docs/audits/ux-pisos): la referencia de «ninguna peor que la baseline» (§7). */
export const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../../docs/audits/ux-pisos/measure-baseline-2026-09-20.json");

/**
 * Toque extra sobre la baseline ACEPTADO por diseño (§2 «Regla de tanda» y §7):
 * p5 +1 por el chip de alcance (Mis averías arranca en «Mías» cuando el técnico
 * tiene partes, §4.4) y p6 +1 por el diálogo nominal «Bloquear la NNN» (§5).
 * Cualquier otra tarea debe igualar o mejorar la baseline en clics.
 */
export const BASELINE_CLICK_ALLOWANCE_P: Partial<Record<PisosTaskId, number>> = { p5: 1, p6: 1 };

/** Resultado de la baseline para la tarea y la variante, o null si el JSON no está o no la trae. */
export function readBaselineP(task: PisosTaskId, variant: PisosVariant, path: string = BASELINE_PATH): MeasureResultP | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ResultsFileP>;
    return parsed.tasks?.[task]?.[variant] ?? null;
  } catch {
    return null;
  }
}

/**
 * Pura: incumplimientos de «ninguna peor que la baseline» (clics con el toque
 * aceptado; peticiones sin margen). Una baseline ausente o no completada (p4 de
 * U0) no obliga a nada.
 */
export function baselineViolations(
  result: Pick<MeasureResultP, "task" | "clicks" | "requests">,
  baseline: Pick<MeasureResultP, "clicks" | "requests" | "completed"> | null,
  allowance: number = BASELINE_CLICK_ALLOWANCE_P[result.task] ?? 0
): string[] {
  if (!baseline || !baseline.completed) return [];
  const problems: string[] = [];
  if (result.clicks > baseline.clicks + allowance) problems.push(`clics ${result.clicks} > baseline ${baseline.clicks}${allowance > 0 ? ` + ${allowance} aceptado (§2)` : ""}`);
  if (result.requests > baseline.requests) problems.push(`peticiones ${result.requests} > baseline ${baseline.requests}`);
  return problems;
}

export type MeasurePisos = {
  task: PisosTaskId;
  variant: PisosVariant;
  /** Clic (ratón) o toque (tablet): 1 acción del usuario. */
  countedClick: (locator: Locator, label: string) => Promise<void>;
  /** Selección en un <select> nativo: 1 acción. */
  countedSelect: (locator: Locator, label: string, value: string | { label: string }) => Promise<void>;
  /** Tecla o atajo: 1 tecla. */
  countedPress: (page: Page, key: string, label?: string) => Promise<void>;
  /** Escritura en un campo: tantas teclas como caracteres (el texto no se guarda). */
  countedFill: (locator: Locator, value: string, label: string) => Promise<void>;
  /** Paso sin coste de interacción anotado en `path`. */
  step: (label: string) => void;
  mark: (page: Page, name: string) => Promise<void>;
  /** Cuenta también las peticiones de otra página (segunda persona). */
  attach: (page: Page) => void;
  /** Arranca el cronómetro y el contador de peticiones. */
  start: (page: Page) => Promise<void>;
  /** Para en el evento de dominio y escribe results-pisos.json. */
  finish: (page: Page, outcome: { completed: boolean; context?: MeasureResultP["context"]; phases?: MeasurePhaseP[]; note?: string }) => Promise<MeasureResultP>;
  /** Contadores acumulados con nombre de fase (tras `finish`, congelados en el momento de acabar). */
  snapshot: (name: string) => MeasurePhaseP;
  /** Reescribe el resultado ya escrito por `finish` con fases o notas añadidas (mismo task y variante). */
  amend: (patch: Partial<Pick<MeasureResultP, "phases" | "note" | "context">>) => MeasureResultP;
  counters: () => { clicks: number; keys: number; requests: number };
};

export function createMeasurePisos(page: Page, task: PisosTaskId, variant: PisosVariant): MeasurePisos {
  const touch = variant === "tablet";
  let clicks = 0;
  let keys = 0;
  let requests = 0;
  let counting = false;
  let startedAt = 0;
  let finishedAt = 0;
  let written: MeasureResultP | null = null;
  const path: string[] = [];
  const apiPrefix = E2E_API_URL;
  const markName = (name: string) => `ui:${task}:${variant}:${name}`;

  function attach(target: Page): void {
    target.on("request", (request) => {
      if (!counting) return;
      if (request.url().startsWith(apiPrefix)) requests += 1;
    });
  }
  attach(page);

  async function mark(target: Page, name: string): Promise<void> {
    await target
      .evaluate((n) => {
        try {
          performance.mark(n);
        } catch {
          /* performance no disponible */
        }
      }, markName(name))
      .catch(() => undefined);
  }

  const elapsed = () => (startedAt ? (finishedAt || Date.now()) - startedAt : 0);

  const measure: MeasurePisos = {
    task,
    variant,
    async countedClick(locator, label) {
      if (touch) await locator.tap();
      else await locator.click();
      clicks += 1;
      path.push(`${touch ? "tap" : "click"}:${label}`);
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
    attach,
    async start(target) {
      counting = true;
      startedAt = Date.now();
      finishedAt = 0;
      await mark(target, "start");
    },
    async finish(target, outcome) {
      finishedAt = Date.now();
      const ms = elapsed();
      counting = false;
      await mark(target, "end");
      await target
        .evaluate((n) => {
          try {
            performance.measure(n, `${n}:start`, `${n}:end`);
          } catch {
            /* marcas ausentes */
          }
        }, `ui:${task}:${variant}`)
        .catch(() => undefined);
      const result: MeasureResultP = {
        task,
        variant,
        viewport: target.viewportSize(),
        touch,
        title: TARGETS_P[task].title,
        clicks,
        keys,
        requests,
        ms,
        completed: outcome.completed,
        path: [...path],
        target: { clicks: TARGETS_P[task].clicks, requests: TARGETS_P[task].requests },
        context: outcome.context,
        ...(outcome.phases ? { phases: outcome.phases } : {}),
        note: outcome.note,
        strict: STRICT,
        measuredAt: new Date().toISOString()
      };
      writeResultP(task, variant, result);
      written = result;
      // eslint-disable-next-line no-console
      console.log(`[measure:${task}:${variant}] clicks=${clicks} keys=${keys} requests=${requests} ms=${ms} completed=${outcome.completed}${outcome.note ? ` · ${outcome.note}` : ""}`);
      if (STRICT) {
        expect(outcome.completed, `${task} ${variant}: la tarea debe completarse en modo estricto`).toBe(true);
        expect(clicks, `${task} ${variant}: clics ≤ objetivo §7`).toBeLessThanOrEqual(TARGETS_P[task].clicks);
        expect(requests, `${task} ${variant}: peticiones ≤ presupuesto [S]`).toBeLessThanOrEqual(TARGETS_P[task].requests);
        // §7 «ninguna peor que la baseline de U0» (clics con el toque aceptado en §2, peticiones sin margen).
        expect(baselineViolations(result, readBaselineP(task, variant)), `${task} ${variant}: no peor que la baseline de U0 (§7)`).toEqual([]);
      }
      return result;
    },
    snapshot(name) {
      return { name, clicks, keys, requests, ms: elapsed(), path: [...path] };
    },
    amend(patch) {
      if (!written) throw new Error(`amend() antes de finish() en ${task} ${variant}`);
      const next: MeasureResultP = { ...written, ...patch, context: { ...(written.context ?? {}), ...(patch.context ?? {}) } };
      writeResultP(task, variant, next);
      written = next;
      return next;
    },
    counters: () => ({ clicks, keys, requests })
  };
  return measure;
}

export function readResultsP(): ResultsFileP {
  try {
    const parsed = JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as Partial<ResultsFileP>;
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

/** Fusiona el resultado de una tarea y variante en results-pisos.json (escritura atómica). */
export function writeResultP(task: PisosTaskId, variant: PisosVariant, result: MeasureResultP): void {
  const current = readResultsP();
  const next: ResultsFileP = {
    generatedAt: new Date().toISOString(),
    baseUrl: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    apiUrl: E2E_API_URL,
    tasks: { ...current.tasks, [task]: { ...(current.tasks[task] ?? {}), [variant]: result } }
  };
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  const tmp = `${RESULTS_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, RESULTS_PATH);
}
