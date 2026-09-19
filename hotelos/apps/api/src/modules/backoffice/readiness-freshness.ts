// Tanda L5 (lote C) · ventana de frescura del readiness de puesta en marcha.
//
// GET /backoffice/properties/:id/readiness ya no sirve filas viejas ni responde
// «blocked + checks: []» cuando no hay filas: si las comprobaciones persistidas
// (property_readiness_checks) faltan o la más reciente supera la ventana, el
// servicio las evalúa de nuevo y las persiste (sin auditar); dentro de la
// ventana devuelve las filas tal cual con el mismo `computedAt`. Este módulo es
// PURO (sin Prisma) para que la regla se pruebe sin base de datos.

export const READINESS_MAX_AGE_MS = 10 * 60 * 1000;

export type ReadinessRowStamp = { updatedAt: Date | string };

function stampMs(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/** Instante de la fila más reciente (máximo de `updatedAt`), o null sin filas válidas. */
function latestStampMs(rows: ReadonlyArray<ReadinessRowStamp>): number | null {
  let latest: number | null = null;
  for (const row of rows) {
    const ms = stampMs(row.updatedAt);
    if (Number.isNaN(ms)) continue;
    if (latest === null || ms > latest) latest = ms;
  }
  return latest;
}

/**
 * true cuando hay que recalcular: sin filas (o sin ninguna fecha válida) o con
 * la más reciente más antigua que `maxAgeMs` respecto a `now`. Una fila con
 * fecha futura (reloj adelantado) cuenta como fresca.
 */
export function isReadinessStale(rows: ReadonlyArray<ReadinessRowStamp>, now: Date, maxAgeMs: number = READINESS_MAX_AGE_MS): boolean {
  const latest = latestStampMs(rows);
  if (latest === null) return true;
  const age = now.getTime() - latest;
  return age > maxAgeMs;
}

/** ISO 8601 del máximo `updatedAt` de las filas, o null sin filas válidas. */
export function readinessComputedAt(rows: ReadonlyArray<ReadinessRowStamp>): string | null {
  const latest = latestStampMs(rows);
  return latest === null ? null : new Date(latest).toISOString();
}
