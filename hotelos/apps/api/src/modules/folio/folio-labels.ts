// Folio labels — the technical value stored on `Folio.label` and the Spanish
// text the API uses when it composes a human-readable reference out of it
// (treasury receivables: «RES-00081 · Huésped»).
//
// Every primary folio is opened with PRIMARY_FOLIO_LABEL (folio.service
// ensurePrimaryFolio, folio-routing createSecondaryFolio, tourist-tax and the
// seeds); `company` / `travel_agent` are the canonical secondary labels the
// routing service documents in its 400 message. Secondary folios carry the
// label the operator typed («Empresa»), so unknown values pass through
// untouched. admin-web keeps the same dictionary in content/data-labels.ts
// for the labels it paints straight from GET /reservations/:id/folios.

export const PRIMARY_FOLIO_LABEL = "guest";

const FOLIO_LABEL_TEXT: Readonly<Record<string, string>> = {
  [PRIMARY_FOLIO_LABEL]: "Huésped",
  company: "Empresa",
  travel_agent: "Agencia de viajes"
};

/** Spanish text of a folio label: system values translated, free text untouched, empty → «Folio». */
export function folioDisplayLabel(label: string | null | undefined): string {
  const raw = label?.trim() ?? "";
  if (!raw) return "Folio";
  return FOLIO_LABEL_TEXT[raw] ?? raw;
}
