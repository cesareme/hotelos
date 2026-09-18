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
// Tanda L3 · lote F1 (2026-09-18): the module also owns what the «Añadir
// cargo» forms (centre and reservation) and the cancel / no-show dialogs need
// without touching the network: the manual charge types, a client mirror of
// `LINE_TYPE_CATEGORY` (default fiscal category per type; the API infers the
// same when the line carries none — L3-T) and the Spanish summaries of the
// penalty preview (`GET /reservations/:id/cancellation-charge`) and of the
// `cancellation` block answered by POST /cancel and /no-show (L3-B).
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
  // indemnities (not subject to VAT) — posted by the cancellation engine
  // (L3-B: cancel → cancellation_fee, no-show → no_show_fee)
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

/**
 * Charge types an operator posts by hand («Añadir cargo» in the billing
 * centre and in the reservation), in display order. Every code is a key of
 * the fiscal catalogue (`FOLIO_LINE_TYPES`), so the API infers a category for
 * it and the invoice never falls to the generic account. Penalties are NOT
 * offered: the cancellation engine posts them.
 */
export const MANUAL_CHARGE_TYPES: readonly string[] = Object.freeze([
  "room",
  "extra_night",
  "late_checkout",
  "early_checkin",
  "breakfast",
  "half_board",
  "restaurant",
  "bar",
  "room_service",
  "minibar",
  "spa",
  "parking",
  "laundry",
  "transfer",
  "extra",
  "adjustment"
]);

/** Fiscal categories of the indirect-tax catalogue (packages/compliance TAX_CATEGORIES), mirrored so this module stays offline. */
export type ChargeTaxCategory = "accommodation" | "food_beverage" | "general_services" | "transport" | "tourist_tax" | "not_subject";

/** What the API infers when a line arrives without category (`DEFAULT_TAX_CATEGORY`). */
export const FALLBACK_TAX_CATEGORY: ChargeTaxCategory = "general_services";

/**
 * Client mirror of `LINE_TYPE_CATEGORY` (packages/compliance/src/spain/
 * indirect-tax.ts): the category preselected in the «Categoría fiscal»
 * select when the operator picks a type. The test pins it to the catalogue
 * entry by entry, so a divergence fails instead of misleading the form.
 */
export const DEFAULT_TAX_CATEGORY_BY_TYPE: Readonly<Record<string, ChargeTaxCategory>> = Object.freeze({
  // accommodation
  room: "accommodation",
  extra_night: "accommodation",
  late_checkout: "accommodation",
  early_checkin: "accommodation",
  night: "accommodation",
  accommodation: "accommodation",
  // food & beverage
  breakfast: "food_beverage",
  half_board: "food_beverage",
  full_board: "food_beverage",
  restaurant: "food_beverage",
  bar: "food_beverage",
  room_service: "food_beverage",
  minibar: "food_beverage",
  fb: "food_beverage",
  // general services (general rate)
  spa: "general_services",
  parking: "general_services",
  laundry: "general_services",
  phone: "general_services",
  internet: "general_services",
  phone_internet: "general_services",
  meeting_room: "general_services",
  misc: "general_services",
  extra: "general_services",
  charge: "general_services",
  adjustment: "general_services",
  // passenger transport
  transport: "transport",
  transfer: "transport",
  // tourist tax passed on to the guest
  city_tax: "tourist_tax",
  tourist_tax: "tourist_tax",
  // indemnities (not subject, N1)
  no_show: "not_subject",
  no_show_fee: "not_subject",
  cancellation: "not_subject",
  cancellation_fee: "not_subject"
});

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

/** Options of the «Tipo» select of «Añadir cargo»: `MANUAL_CHARGE_TYPES` labelled, same order. */
export function manualChargeTypeOptions(): Array<{ value: string; label: string }> {
  return MANUAL_CHARGE_TYPES.map((value) => ({ value, label: chargeTypeLabel(value) }));
}

/** Category the form preselects for a type — exactly what the API would infer for a line without one. */
export function defaultTaxCategoryForType(type: string | null | undefined): ChargeTaxCategory {
  return DEFAULT_TAX_CATEGORY_BY_TYPE[normalizeChargeType(type)] ?? FALLBACK_TAX_CATEGORY;
}

/** Categories of operations subject to VAT (every category but the tourist tax and the indemnities). */
export const SUBJECT_TAX_CATEGORIES: readonly ChargeTaxCategory[] = Object.freeze(["accommodation", "food_beverage", "general_services", "transport"]);

/** Generic concepts («anything else»): any subject category is plausible. */
const GENERIC_CHARGE_TYPES: ReadonlySet<string> = new Set(["extra", "adjustment", "charge", "misc"]);

/**
 * Corrector L3 (FC-4 / DS-08): client mirror of `compatibleTaxCategories`
 * (apps/api/src/modules/folio/folio.service.ts): the categories the API
 * accepts for a line of `type`. The «Categoría fiscal» select of «Añadir
 * cargo» only offers these, so «Habitación» is never posted as «No sujeto»
 * or «Tasa turística» (the API answers 400 anyway). Pure.
 */
export function compatibleTaxCategoriesForType(type: string | null | undefined): readonly ChargeTaxCategory[] {
  const key = normalizeChargeType(type);
  const inferred = DEFAULT_TAX_CATEGORY_BY_TYPE[key];
  if (inferred === undefined || GENERIC_CHARGE_TYPES.has(key)) return SUBJECT_TAX_CATEGORIES;
  switch (inferred) {
    case "accommodation":
      return ["accommodation"];
    case "food_beverage":
      return ["food_beverage", "general_services"];
    case "transport":
      return ["transport", "general_services"];
    case "tourist_tax":
      return ["tourist_tax"];
    case "not_subject":
      return ["not_subject", "accommodation"];
    case "general_services":
    default:
      return ["general_services"];
  }
}

/** Options of a «Categoría fiscal» select restricted to the categories compatible with `type` (keeps the catalogue's order and labels). Pure. */
export function taxCategoryOptionsForType<T extends { value: string; label: string }>(type: string | null | undefined, options: readonly T[]): T[] {
  const allowed = new Set<string>(compatibleTaxCategoriesForType(type));
  return options.filter((option) => allowed.has(option.value));
}

// ---------------------------------------------------------------------------
// Cancellation / no-show — preview and outcome summaries (Tanda L3 · F1)
// ---------------------------------------------------------------------------

export type PenaltyMode = "cancellation" | "no_show";

/** Structural subset of `ChargeBreakdown` (services/cancellationApi.ts). */
export type PenaltyPreviewLike = {
  amount: number;
  withinFreeWindow: boolean;
  policyName: string | null;
  label: string;
};

/** Structural subset of the `cancellation` block of POST /reservations/:id/cancel · /no-show (L3-B). */
export type LifecycleOutcomeLike = {
  applied: boolean;
  policyWaived: boolean;
  waivedAmount: number;
  charge: { amount: number };
  /** `pendingInvoice` (corrector L3 · FC-2): settled but its charges are not invoiced yet, so it stays open. */
  folio: { status: "open" | "closed" | string; balanceDue: number; pendingInvoice?: boolean } | null;
};

const MODE_NOUN: Readonly<Record<PenaltyMode, string>> = Object.freeze({ cancellation: "cancelación", no_show: "no-show" });

/**
 * Sentence of the dialog before confirming. `null` = the preview could not be
 * read (the API still applies the policy on confirm). Amounts are formatted
 * by the caller (lib/format.money).
 */
export function penaltyPreviewSummary(mode: PenaltyMode, preview: PenaltyPreviewLike | null, formatAmount: (amount: number) => string): string {
  if (!preview) return `No se pudo calcular la penalización de ${MODE_NOUN[mode]}; al confirmar se aplicará la política vigente de la reserva.`;
  const policy = preview.policyName ? ` (política «${preview.policyName}»)` : " (sin política de cancelación configurada)";
  if (preview.withinFreeWindow) return `Dentro del plazo de cancelación gratuita${policy}: sin penalización.`;
  if (preview.amount > 0) return `Penalización prevista de ${formatAmount(preview.amount)}${policy}: se cargará al folio como línea no sujeta a IVA.`;
  return `Sin penalización${policy}.`;
}

/**
 * Toast after the write: state of the reservation, the penalty posted (or
 * waived) and the folio outcome (`closed` at balance 0, or `open` with its
 * balance). Without `cancellation` (an older API) only the state is named.
 */
export function lifecycleOutcomeSummary(mode: PenaltyMode, outcome: LifecycleOutcomeLike | null | undefined, formatAmount: (amount: number) => string): string {
  const head = mode === "no_show" ? "No-show registrado" : "Reserva cancelada";
  if (!outcome) return `${head}.`;
  const parts = [head];
  if (outcome.policyWaived) parts.push(outcome.waivedAmount > 0 ? `penalización de ${formatAmount(outcome.waivedAmount)} renunciada` : "sin penalización");
  else if (outcome.charge.amount > 0) parts.push(`penalización de ${formatAmount(outcome.charge.amount)} cargada al folio`);
  else parts.push("sin penalización");
  if (outcome.folio) {
    if (outcome.folio.status === "closed") parts.push("folio cerrado");
    else if (outcome.folio.pendingInvoice) parts.push("folio saldado y abierto: emite la factura de la penalización para cerrarlo");
    else parts.push(`folio abierto con saldo pendiente de ${formatAmount(outcome.folio.balanceDue)}`);
  }
  return `${parts.join(" · ")}.`;
}
