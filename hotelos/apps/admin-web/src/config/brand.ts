// Single source of truth for the product brand (audit 2026-06 · Fase 0).
// New UI code should import BRAND instead of hardcoding the name, so the next
// rename is one edit. Existing literals were migrated HotelOS -> Anfitorio (2026-06) -> ehotelOS (2026-09).
// Minimal copies live in apps/guest-web/src/config/brand.ts,
// apps/mobile/src/config/brand.ts and apps/api/src/lib/brand.ts;
// tests/brand-contract.test.mjs keeps the four `name` values identical.
// legalSuffix stays empty until the legal owner is confirmed (D1): the ©
// line reads «© 2026 ehotelOS». The VeriFactu SIF name is NOT BRAND.name.
export const BRAND = {
  name: "ehotelOS",
  legalSuffix: "",
  tagline: "El PMS fintech para hoteles españoles que ya cumple con la ley.",
  domain: "ehotelos.com",
  demoUrl: "https://demo.ehotelos.com",
  supportEmail: "soporte@ehotelos.com",
  helpUrl: "https://ayuda.ehotelos.com",
  guestPortalHost: "huesped.ehotelos.com",
} as const;
