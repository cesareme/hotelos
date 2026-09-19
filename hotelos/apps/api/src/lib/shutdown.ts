// Coordinador de apagado ordenado del API (fusión T8 · E2).
//
// Motivo: cada scheduler in-process registraba su propio `process.once("SIGTERM", …)`
// que solo paraba su temporizador y nunca terminaba el proceso; en cuanto existe
// un manejador Node retira la salida por defecto, así que el API ignoraba
// SIGTERM/SIGINT y el 2026-09-19 hubo que matarlo con SIGKILL. Ahora server.ts
// instala UN manejador por señal tras `app.listen` y lo delega en este helper.
//
// Puro a propósito: no toca `process.*` ni variables de entorno. `exit` y `log`
// se inyectan, de modo que los tests lo ejercitan con temporizadores falsos y
// espías (lib/__tests__/shutdown.test.mts). Semántica:
//   - 1.ª señal: marca `triggered`, arma el plazo `timeoutMs` (por defecto
//     10 000 ms) y ejecuta los pasos en orden INVERSO al de registro (LIFO: los
//     schedulers, registrados después, se detienen antes que Fastify y Prisma).
//     Un paso que lanza se registra y se continúa. Al terminar limpia el plazo
//     y llama a `exit(0)`; si el plazo vence antes, warn y `exit(1)`.
//   - 2.ª señal (con `triggered` ya a true): warn y `exit(1)` síncrono.

export type ShutdownLogger = {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
};

export type ShutdownController = {
  /** Registra un paso; los pasos se ejecutan en orden inverso al de registro. */
  register(name: string, fn: () => void | Promise<void>): void;
  /** Primera señal: apagado ordenado; segunda señal: salida inmediata con código 1. */
  trigger(signal: string): Promise<void>;
  /** True desde la primera señal recibida. */
  readonly triggered: boolean;
};

export type ShutdownControllerOptions = {
  /** Plazo total para todos los pasos; vencido → warn + exit(1). Defecto 10 000 ms. */
  timeoutMs?: number;
  exit: (code: number) => void;
  log: ShutdownLogger;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export function createShutdownController(options: ShutdownControllerOptions): ShutdownController {
  // Un valor no numérico o no positivo (SHUTDOWN_TIMEOUT_MS mal escrito) cae al
  // defecto en vez de armar un plazo de 0/NaN ms que vencería al instante.
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0 ? (options.timeoutMs as number) : DEFAULT_TIMEOUT_MS;
  const steps: Array<{ name: string; fn: () => void | Promise<void> }> = [];
  let triggered = false;

  async function trigger(signal: string): Promise<void> {
    if (triggered) {
      options.log.warn({ signal }, "[shutdown] segunda señal: salida inmediata");
      options.exit(1);
      return;
    }
    triggered = true;
    const ordered = [...steps].reverse();
    const names = ordered.map((step) => step.name);
    const pending = new Set(names);
    options.log.info({ signal, steps: names }, "[shutdown] señal recibida: apagado ordenado");
    const timer = setTimeout(() => {
      options.log.warn({ signal, timeoutMs, pending: [...pending] }, "[shutdown] plazo agotado: salida con código 1");
      options.exit(1);
    }, timeoutMs);
    // Sin unref a propósito: si un paso queda colgado sin ningún otro handle vivo
    // (p. ej. $disconnect del motor napi de Prisma), el bucle de eventos se
    // vaciaría y Node saldría con código 0 sin el warn; el plazo debe mantenerse
    // referenciado para forzar exit(1). En el camino normal clearTimeout lo libera.
    for (const step of ordered) {
      try {
        await step.fn();
      } catch (err) {
        options.log.error({ err, step: step.name }, "[shutdown] paso fallido: se continúa con el resto");
      }
      pending.delete(step.name);
    }
    clearTimeout(timer);
    options.log.info({ signal, steps: names }, "[shutdown] completado");
    options.exit(0);
  }

  return {
    register(name, fn) {
      steps.push({ name, fn });
    },
    trigger,
    get triggered() {
      return triggered;
    }
  };
}
