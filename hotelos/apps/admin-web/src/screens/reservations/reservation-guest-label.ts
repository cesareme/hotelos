// Guest labels shared by the reservations list and the reservation detail
// (Cocoa 22 · ola 3 · fix:3-A qa#7). A reservation without a booker name only
// carries the primary guest id («cmrmvf0pr00ggfytlf41xybq8»); the operator
// must never read that id as the guest. Pure and unit-tested
// (__tests__/reservation-guest-label.test.mts).

/** Label painted while no name is known (and when the lookup fails). */
export const PENDING_GUEST_LABEL = "Huésped pendiente";

/** The fields of a guest record any endpoint may send (list, detail, reservation join). */
export type GuestNameParts = {
  fullName?: string | null;
  firstName?: string | null;
  surname1?: string | null;
  surname2?: string | null;
};

/** The reservation fields the label depends on. */
export type GuestLabelSource = {
  bookerName?: string | null;
  primaryGuestId?: string | null;
};

function text(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/** Full name of a guest record: `fullName` when the API sends it, else the composed parts; blank → null. */
export function guestFullName(guest: GuestNameParts | null | undefined): string | null {
  if (!guest) return null;
  const full = text(guest.fullName);
  if (full) return full;
  const composed = [guest.firstName, guest.surname1, guest.surname2].map(text).filter(Boolean).join(" ");
  return composed || null;
}

/**
 * Visible guest of a reservation: the booker name, then the resolved name of
 * the primary guest, then «Huésped pendiente». The internal id is never shown.
 */
export function reservationGuestLabel(reservation: GuestLabelSource, primaryGuestName?: string | null): string {
  return text(reservation.bookerName) || text(primaryGuestName) || PENDING_GUEST_LABEL;
}

/**
 * Primary guest ids still to resolve for a page of rows: only rows without a
 * booker name need the lookup, each id once, skipping the ones already
 * requested or resolved.
 */
export function pendingGuestIds(reservations: ReadonlyArray<GuestLabelSource>, known: ReadonlySet<string>): string[] {
  const ids = new Set<string>();
  for (const reservation of reservations) {
    if (text(reservation.bookerName)) continue;
    const id = text(reservation.primaryGuestId);
    if (id && !known.has(id)) ids.add(id);
  }
  return Array.from(ids);
}
