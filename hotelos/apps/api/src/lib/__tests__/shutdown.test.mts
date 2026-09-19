// Coordinador de apagado ordenado (lib/shutdown.ts · fusión T8 · E2): orden LIFO,
// paso que lanza, plazo agotado, segunda señal y `triggered`. Sin proceso ni red:
// `exit` y el logger son espías y setTimeout es el falso de node:test.
// Desde apps/api:
//   node --import tsx --test src/lib/__tests__/shutdown.test.mts

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createShutdownController, type ShutdownLogger } from "../shutdown.js";

type LogCall = { level: "info" | "warn" | "error"; obj: unknown; msg: string | undefined };

function makeLogger(): { log: ShutdownLogger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const log: ShutdownLogger = {
    info: (obj, msg) => calls.push({ level: "info", obj, msg }),
    warn: (obj, msg) => calls.push({ level: "warn", obj, msg }),
    error: (obj, msg) => calls.push({ level: "error", obj, msg })
  };
  return { log, calls };
}

/** Deja pasar las microtareas pendientes sin tocar los temporizadores falsos. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("createShutdownController", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it("ejecuta los pasos en orden inverso al registro, limpia el plazo y sale con 0", async () => {
    const exits: number[] = [];
    const { log, calls } = makeLogger();
    const order: string[] = [];
    const controller = createShutdownController({ timeoutMs: 10_000, exit: (code) => exits.push(code), log });
    controller.register("prisma", async () => {
      order.push("prisma");
    });
    controller.register("fastify", () => {
      order.push("fastify");
    });
    controller.register("scheduler", () => {
      order.push("scheduler");
    });

    await controller.trigger("SIGTERM");

    assert.deepEqual(order, ["scheduler", "fastify", "prisma"], "LIFO: el scheduler para antes que Fastify y Prisma");
    assert.deepEqual(exits, [0]);
    const received = calls.find((call) => call.msg === "[shutdown] señal recibida: apagado ordenado");
    assert.ok(received, "log de recepción");
    assert.deepEqual((received.obj as { signal: string; steps: string[] }).steps, ["scheduler", "fastify", "prisma"]);
    assert.equal((received.obj as { signal: string }).signal, "SIGTERM");
    assert.ok(calls.some((call) => call.msg === "[shutdown] completado"), "log de fin");

    // El plazo quedó limpio: al vencer no hay warn ni exit(1).
    mock.timers.tick(10_000);
    assert.deepEqual(exits, [0], "sin exit(1) tras el plazo");
    assert.equal(calls.filter((call) => call.level === "warn").length, 0);
  });

  it("un paso que lanza se registra a nivel error y el resto continúa hasta exit(0)", async () => {
    const exits: number[] = [];
    const { log, calls } = makeLogger();
    const order: string[] = [];
    const controller = createShutdownController({ exit: (code) => exits.push(code), log });
    controller.register("prisma", () => {
      order.push("prisma");
    });
    controller.register("fastify", async () => {
      throw new Error("close falló");
    });
    controller.register("scheduler", () => {
      order.push("scheduler");
    });

    await controller.trigger("SIGINT");

    assert.deepEqual(order, ["scheduler", "prisma"]);
    assert.deepEqual(exits, [0]);
    const failed = calls.find((call) => call.level === "error");
    assert.ok(failed, "el fallo del paso se registra");
    assert.equal((failed.obj as { step: string }).step, "fastify");
    assert.equal(((failed.obj as { err: Error }).err).message, "close falló");
  });

  it("un paso colgado agota el plazo: warn con los pendientes y exit(1)", async () => {
    const exits: number[] = [];
    const { log, calls } = makeLogger();
    const controller = createShutdownController({ timeoutMs: 10_000, exit: (code) => exits.push(code), log });
    controller.register("prisma", () => undefined);
    controller.register("fastify", () => new Promise<void>(() => undefined)); // nunca resuelve
    controller.register("scheduler", () => undefined);

    void controller.trigger("SIGTERM");
    await flush();
    assert.deepEqual(exits, [], "antes del plazo no sale");

    mock.timers.tick(9_999);
    assert.deepEqual(exits, [], "a 1 ms del plazo sigue esperando");
    mock.timers.tick(1);
    assert.deepEqual(exits, [1]);
    const warn = calls.find((call) => call.msg === "[shutdown] plazo agotado: salida con código 1");
    assert.ok(warn, "warn de plazo agotado");
    const obj = warn.obj as { signal: string; timeoutMs: number; pending: string[] };
    assert.equal(obj.signal, "SIGTERM");
    assert.equal(obj.timeoutMs, 10_000);
    assert.deepEqual(obj.pending, ["fastify", "prisma"], "el scheduler ya había terminado; fastify y prisma quedaban");
  });

  it("usa 10 000 ms por defecto y cae al defecto con un plazo no numérico", async () => {
    for (const timeoutMs of [undefined, Number.NaN, 0, -5]) {
      const exits: number[] = [];
      const { log } = makeLogger();
      const controller = createShutdownController({ ...(timeoutMs === undefined ? {} : { timeoutMs }), exit: (code) => exits.push(code), log });
      controller.register("colgado", () => new Promise<void>(() => undefined));
      void controller.trigger("SIGTERM");
      await flush();
      mock.timers.tick(9_999);
      assert.deepEqual(exits, [], `timeoutMs=${String(timeoutMs)}: no vence antes de 10 s`);
      mock.timers.tick(1);
      assert.deepEqual(exits, [1], `timeoutMs=${String(timeoutMs)}: vence a los 10 s`);
    }
  });

  it("la segunda señal sale con 1 de inmediato sin repetir los pasos", async () => {
    const exits: number[] = [];
    const { log, calls } = makeLogger();
    let runs = 0;
    const controller = createShutdownController({ timeoutMs: 10_000, exit: (code) => exits.push(code), log });
    controller.register("lento", () => {
      runs += 1;
      return new Promise<void>(() => undefined);
    });

    void controller.trigger("SIGTERM");
    await flush();
    assert.equal(runs, 1);
    assert.deepEqual(exits, []);

    await controller.trigger("SIGINT");
    assert.deepEqual(exits, [1], "salida inmediata");
    assert.equal(runs, 1, "no repite el paso");
    const warn = calls.find((call) => call.msg === "[shutdown] segunda señal: salida inmediata");
    assert.ok(warn);
    assert.equal((warn.obj as { signal: string }).signal, "SIGINT");
  });

  it("`triggered` refleja el estado", async () => {
    const { log } = makeLogger();
    const controller = createShutdownController({ exit: () => undefined, log });
    assert.equal(controller.triggered, false);
    controller.register("nada", () => undefined);
    const done = controller.trigger("SIGTERM");
    assert.equal(controller.triggered, true, "true desde la primera señal, antes de terminar");
    await done;
    assert.equal(controller.triggered, true);
  });
});

// Con temporizadores REALES: el plazo no lleva unref, así que un paso colgado sin
// ningún otro handle vivo sigue terminando en warn + exit(1) en vez de dejar que
// el bucle de eventos se vacíe y el proceso salga con 0 (E2-02).
describe("createShutdownController · plazo con temporizadores reales", () => {
  it("un paso colgado sin más handles vivos agota el plazo (50 ms) y sale con 1", async () => {
    const exits: number[] = [];
    const { log, calls } = makeLogger();
    const controller = createShutdownController({ timeoutMs: 50, exit: (code) => exits.push(code), log });
    controller.register("prisma", () => new Promise<void>(() => undefined)); // nunca resuelve
    void controller.trigger("SIGTERM");
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(exits, [1]);
    const warn = calls.find((call) => call.level === "warn");
    assert.ok(warn);
    assert.equal(warn.msg, "[shutdown] plazo agotado: salida con código 1");
    assert.deepEqual((warn.obj as { pending: string[] }).pending, ["prisma"]);
  });
});
