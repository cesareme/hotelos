// Cierre del día · «¿estaba alojada esa noche?» (Tanda L5 · integrador, INT-L5-01).
// PURE: no Prisma, no clock — __tests__/night-audit-in-house.test.mts runs it
// under `node --test`.
//
// Until L5 the room-charge step billed EVERY `checked_in` reservation for the
// business date under close. With a business date that lags behind (the pilot
// hotels closed nothing between 2026-09-13 and 2026-09-19 while OPERA kept
// checking guests in on their arrival day), a retroactive close of 13/09 would
// have charged 13/09 to a guest who only arrived on 17/09. A reservation is
// «in house for the night D» when D is on or after its FIRST chargeable night:
//   · the booked arrival (the room was held from that day: a late arrival still
//     pays the first night), or
//   · the physical check-in day in the property's time zone when it came
//     earlier (early check-in with `allowEarlyCheckIn`: the guest slept there).
// Departure is deliberately NOT a bound: a guest who has not checked out after
// the departure date is an overstay and keeps paying (the preflight blocks on
// `departures_not_checked_out` for reception to resolve).

/** ISO calendar days (`YYYY-MM-DD`); `checkInDay` null when the stay has no check-in instant. */
export type NightlyPresence = { arrivalDay: string; checkInDay: string | null };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDay(value: string, label: string): void {
  if (!ISO_DAY.test(value)) throw new Error(`${label} debe ser un día ISO (YYYY-MM-DD): ${value}`);
}

/** First night the reservation pays: min(arrival day, physical check-in day). ISO days compare lexicographically. */
export function firstChargeableNight(presence: NightlyPresence): string {
  assertIsoDay(presence.arrivalDay, "arrivalDay");
  if (presence.checkInDay === null) return presence.arrivalDay;
  assertIsoDay(presence.checkInDay, "checkInDay");
  return presence.checkInDay < presence.arrivalDay ? presence.checkInDay : presence.arrivalDay;
}

/** Whether the night `businessDate` (ISO day) is chargeable to the reservation. */
export function isInHouseOnNight(presence: NightlyPresence, businessDate: string): boolean {
  assertIsoDay(businessDate, "businessDate");
  return businessDate >= firstChargeableNight(presence);
}

/** «llega el 17/09/2026» — the detail of a reservation skipped because it was not in house that night. */
export function notYetInHouseDetail(presence: NightlyPresence): string {
  const first = firstChargeableNight(presence);
  const [y, m, d] = first.split("-");
  return `Aún no alojada esa noche: su primera noche es el ${d}/${m}/${y}.`;
}
