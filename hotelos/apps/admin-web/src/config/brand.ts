// Single source of truth for the product brand (audit 2026-06 · Fase 0).
// New UI code should import BRAND instead of hardcoding the name, so the next
// rename is one edit. Existing literals were migrated HotelOS -> Anfitorio.
export const BRAND = {
  name: "Anfitorio",
  legalSuffix: "SL",
  tagline: "El PMS fintech para hoteles españoles que ya cumple con la ley.",
} as const;
