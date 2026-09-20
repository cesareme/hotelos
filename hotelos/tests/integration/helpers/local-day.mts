/**
 * Fecha civil «hoy + n días» en la zona del hotel (Tanda CIERRE-1 · lote C4a).
 * No es un test: el glob `tests/integration/*.test.mts` no lo ejecuta; las suites
 * pms-shadow lo importan.
 *
 * Motivo: el servidor ancla el corte al día LOCAL de la propiedad
 * (`pms-shadow.service.ts` → `localDateTime(new Date(), property.timezone)`,
 * Europe/Madrid) mientras las suites calculaban «hoy» con `getUTCDate()`. Entre
 * las 00:00 y las 02:00 CEST (22:00-00:00Z) los dos días difieren y las aserciones
 * sobre `businessDate` fallaban (flake de ventana horaria, FIX-1 §2.2 puerta 10).
 *
 *   import { localDay } from "./helpers/local-day.mts";
 *   const day = (offset: number): string => localDay(offset, TIMEZONE);
 *
 * Mismo cálculo que `localDateTime` (`pms-shadow.rules.ts`): partes de
 * `Intl.DateTimeFormat("en-CA")` en la zona pedida; zona inválida → UTC. El
 * desplazamiento se aplica en UTC sobre la fecha civil (sin horas), así el cambio
 * de hora nunca acorta ni alarga el día.
 */
export function localDay(offsetDays = 0, timezone = "Europe/Madrid", now: Date = new Date()): string {
  const [y, m, d] = civilDateParts(now, timezone);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

/** [año, mes 1-12, día] de `now` en `timezone`; zona no válida → partes UTC (como `localDateTime`). */
function civilDateParts(now: Date, timezone: string): [number, number, number] {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
    const [y, m, d] = [get("year"), get("month"), get("day")];
    if (Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d)) return [y, m, d];
  } catch {
    // zona no válida → UTC
  }
  return [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()];
}
