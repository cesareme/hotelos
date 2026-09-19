// Reservation id of the detail sub-URL (Tanda 5 · L1c). Pure: no DOM, no API,
// so the rule is unit-testable and ReservationWorkspaceScreen only consumes it.

import { MOVED_URLS, allUrls, hasRouteParams, matchPath, urlForScreen } from "../../navigation/nav-tree";

// Detail sub-URL of the reservation item (Tanda 5): /recepcion/reservas/:id. The
// legacy standalone route is normally rewritten by the client-side 308 before
// this screen mounts, but reading it too keeps deep links honest.
const DETAIL_PATTERN = urlForScreen("ReservationDetailWorkspace") ?? "/recepcion/reservas/:id";
const LEGACY_DETAIL_PATTERN = "/backoffice/reservations/:id";

// Static sibling URLs under the same prefix (lista, tablero, nueva…) are tabs
// or items of the tree, never a reservation id. Derived from the tree so a new
// tab cannot be mistaken for an id; the moved URLs (`cronograma`, now a redirect
// to Hoy › Live Timeline) stay reserved for the same reason.
const RESERVED_SEGMENTS = new Set(
  [...allUrls(), ...MOVED_URLS.map((route) => route.from)]
    .filter((url) => !hasRouteParams(url) && matchPath(DETAIL_PATTERN, url) !== null)
    .map((url) => url.split("/").filter(Boolean).at(-1) ?? "")
    .filter(Boolean)
);

/**
 * Reservation id carried by the URL, or "" when the URL is a sibling tab or
 * does not match. Any opaque id is accepted (cuid, legacy `res_…`, codes): the
 * API's 404 decides whether the reservation exists, never a prefix regex
 * (browser-roles#1: real ids are cuids and were rejected before any request).
 */
export function reservationIdFromPathname(pathname: string): string {
  const params = matchPath(DETAIL_PATTERN, pathname) ?? matchPath(LEGACY_DETAIL_PATTERN, pathname);
  const id = params?.id?.trim() ?? "";
  if (!id || RESERVED_SEGMENTS.has(id)) return "";
  return id;
}

