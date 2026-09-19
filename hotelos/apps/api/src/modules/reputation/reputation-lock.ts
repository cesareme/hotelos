// Reputación · Tanda T8 · corrección ronda 1 (BD-03 / BD-04) — advisory locks
// del bot de reseñas (apps/api/src/modules/reputation/reputation-lock.ts).
//
// Antes, el job diario ejecutaba TODO el tick (red a los portales, análisis,
// alertas y purga de todas las propiedades) dentro de UNA transacción
// interactiva de 300 s con `db: tx`: al expirar, Prisma revertía reseñas,
// ejecuciones y casos de calidad de todas las propiedades sin dejar rastro,
// mientras los eventos ReviewReceived ya emitidos por las colas globales
// quedaban huérfanos. Y la sincronización manual y la importación CSV no
// tomaban ningún lock, así que concurrían con el tick (upsert findFirst+create
// sin @@unique hasta T8-L0 → filas duplicadas).
//
// Diseño ahora:
//   · la transacción SOLO sostiene `pg_try_advisory_xact_lock(hashtext(key))`
//     (una consulta, sin escrituras); el trabajo corre fuera de ella sobre el
//     cliente normal (`prisma`): cada escritura se confirma por sí sola y nada
//     se revierte en bloque;
//   · claves: `reputation.sync` (exclusión entre réplicas del tick completo) y
//     `reputation.sync:<propertyId>` (exclusión entre el tick, la sincronización
//     manual y la importación de una misma propiedad);
//   · si la transacción del lock expira antes de que termine el trabajo, el
//     lock se libera (Prisma la revierte) pero el trabajo sigue y su resultado
//     se conserva: se registra un aviso; el tope es solo una red de seguridad;
//   · sin variables de entorno, sin red; `db` inyectable (stub en los tests).

export const REPUTATION_SYNC_LOCK_KEY = "reputation.sync";
/** Tope de la transacción que sostiene el lock global del tick (red de seguridad, no un límite del trabajo). */
export const REPUTATION_SYNC_LOCK_TIMEOUT_MS = 4 * 3_600_000;
/** Tope del lock por propiedad (tick de una propiedad, sincronización manual o importación). */
export const REPUTATION_PROPERTY_LOCK_TIMEOUT_MS = 30 * 60_000;
export const REPUTATION_LOCK_MAX_WAIT_MS = 5_000;

export type LockLogger = { warn: (obj: unknown, msg?: string) => void };

/** Cliente con `$transaction` interactiva (prisma o un stub). */
export type LockDb = {
  $transaction: <T>(fn: (tx: LockTx) => Promise<T>, options?: { maxWait?: number; timeout?: number }) => Promise<T>;
};
export type LockTx = { $queryRaw: <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T> };

/** Clave del lock por propiedad. */
export function reputationPropertyLockKey(propertyId: string): string {
  return `${REPUTATION_SYNC_LOCK_KEY}:${propertyId}`;
}

export type WithLockResult<T> = { locked: true; result: T; lockExpired: boolean } | { locked: false };

/**
 * Toma el advisory lock `key` en una transacción que no hace nada más, ejecuta
 * `run()` FUERA de ella (autocommit) mientras la mantiene abierta y la cierra al
 * terminar. `{ locked: false }` si otro proceso lo tiene. Si la transacción
 * expira antes que `run()`, el resultado se conserva y `lockExpired` es true.
 */
export async function withAdvisoryLock<T>(input: { db: LockDb; key: string; timeoutMs: number; maxWaitMs?: number; log?: LockLogger; run: () => Promise<T> }): Promise<WithLockResult<T>> {
  // Caja mutable: el callback de la transacción escribe aquí y el flujo de fuera lo lee.
  const box: { acquired: boolean; outcome: { result: T } | null; workError: { error: unknown } | null } = { acquired: false, outcome: null, workError: null };
  try {
    const locked = await input.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${input.key})) AS locked`;
        if (!rows[0]?.locked) return false;
        box.acquired = true;
        try {
          box.outcome = { result: await input.run() };
        } catch (error) {
          box.workError = { error };
        }
        return true;
      },
      { maxWait: input.maxWaitMs ?? REPUTATION_LOCK_MAX_WAIT_MS, timeout: input.timeoutMs }
    );
    if (!locked) return { locked: false };
  } catch (error) {
    // La transacción del lock expiró (o el commit falló) DESPUÉS de arrancar el trabajo: nada que revertir (autocommit).
    if (!box.acquired) throw error;
    input.log?.warn({ key: input.key, err: error instanceof Error ? error.message : String(error) }, "[reputation.lock] la transacción del lock expiró antes de terminar el trabajo (resultado conservado)");
    if (box.workError) throw box.workError.error;
    if (box.outcome === null) throw error;
    return { locked: true, result: box.outcome.result, lockExpired: true };
  }
  if (box.workError) throw box.workError.error;
  if (box.outcome === null) throw new Error("[reputation.lock] trabajo sin resultado");
  return { locked: true, result: box.outcome.result, lockExpired: false };
}
