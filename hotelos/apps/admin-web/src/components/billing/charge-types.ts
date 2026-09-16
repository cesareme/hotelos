// Finanzas · Facturación y cobros (Cocoa 22 · lote 6-A) — Spanish labels for
// the `type` of a folio line («cargo»), shared by FolioDetailScreen (column
// «Tipo», routing rules) and FolioRoutingScreen (rule selector, lines per
// folio) so both screens name the same code the same way.
//
// The catalogue covers every code of `FOLIO_LINE_TYPES` in
// packages/compliance/src/spain/indirect-tax.ts (the types the API posts:
// night audit, POS `folioLineTypeForOutlet`, tourist tax, penalties) plus the
// codes the routing selector and the revenue snapshot use. An unknown code is
// never painted raw: it is humanised («spa_day» → «Spa day»).
//
// No React, no network, no import.meta: components/billing/__tests__ runs this
// module under `node --test`.

/** Routing wildcard: a rule with this source matches every charge. */
export const ANY_CHARGE_TYPE = "*";

export const CHARGE_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  // accommodation
  room: "Alojamiento",
  night: "Alojamiento",
  accommodation: "Alojamiento",
  extra_night: "Noche adicional",
  late_checkout: "Salida tardía",
  early_checkin: "Entrada anticipada",
  // food & beverage
  breakfast: "Desayuno",
  half_board: "Media pensión",
  full_board: "Pensión completa",
  restaurant: "Restaurante",
  bar: "Bar",
  room_service: "Servicio de habitaciones",
  minibar: "Minibar",
  fb: "Restauración",
  f_and_b: "Restauración",
  food_beverage: "Restauración",
  fnb: "Restauración",
  pos: "Punto de venta",
  // general services
  spa: "Spa",
  parking: "Aparcamiento",
  laundry: "Lavandería",
  phone: "Teléfono",
  telephone: "Teléfono",
  internet: "Internet",
  phone_internet: "Teléfono e internet",
  meeting_room: "Sala de reuniones",
  misc: "Varios",
  extra: "Extras",
  charge: "Cargo",
  service: "Servicios",
  service_charge: "Cargo por servicio",
  upsell: "Ventas adicionales",
  package: "Paquete",
  adjustment: "Ajuste",
  discount: "Descuento",
  // passenger transport
  transport: "Transporte",
  transfer: "Traslado",
  // taxes
  tax: "Impuestos",
  city_tax: "Tasa turística",
  tourist_tax: "Tasa turística",
  // indemnities (not subject to VAT)
  no_show: "Penalización por no presentarse",
  no_show_fee: "Penalización por no presentarse",
  cancellation: "Penalización por cancelación",
  cancellation_fee: "Penalización por cancelación",
  // money movements that may appear as lines in legacy folios
  deposit: "Depósito",
  payment: "Cobro",
  refund: "Devolución",
  other: "Otros"
});

/** Source types offered by the routing rule selector, in display order (the wildcard goes first). */
export const ROUTING_SOURCE_TYPES: readonly string[] = Object.freeze([
  "room",
  "tax",
  "city_tax",
  "f_and_b",
  "minibar",
  "breakfast",
  "spa",
  "laundry",
  "telephone",
  "parking",
  "service_charge",
  "adjustment"
]);

/** `" No-Show Fee "` → `"no_show_fee"`: the key the catalogue and the API routing match on. */
export function normalizeChargeType(type: string | null | undefined): string {
  return (type ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Fallback for a code outside the catalogue: underscores to spaces, first letter capitalised. */
function humanize(code: string): string {
  const words = code.replace(/_+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * «Restaurante», «Penalización por no presentarse», «Cualquier cargo» for the
 * wildcard, «Sin tipo» when empty; an unknown code is humanised, never raw.
 */
export function chargeTypeLabel(type: string | null | undefined): string {
  const raw = (type ?? "").trim();
  if (raw === ANY_CHARGE_TYPE) return "Cualquier cargo";
  const key = normalizeChargeType(raw);
  if (!key) return "Sin tipo";
  return CHARGE_TYPE_LABELS[key] ?? humanize(key);
}

/** Options of the routing rule «Origen» selector: wildcard first, then `ROUTING_SOURCE_TYPES` labelled. */
export function routingSourceOptions(): Array<{ value: string; label: string }> {
  return [ANY_CHARGE_TYPE, ...ROUTING_SOURCE_TYPES].map((value) => ({ value, label: chargeTypeLabel(value) }));
}
