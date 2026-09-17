// Copia mínima de la marca para la app móvil (rebrand ehotelOS, 2026-09).
// La FUENTE es apps/admin-web/src/config/brand.ts: tests/brand-contract.test.mjs
// exige que el `name` de las cuatro copias (admin-web, guest-web, mobile, api)
// coincida. No se exporta desde @hotelos/shared porque packages/shared/src
// mantiene espejos .js junto a los .ts que habría que sincronizar a mano.
// El slug, el scheme y el bundleId de app.json NO llevan la marca (D13).
export const BRAND = {
  name: "ehotelOS",
  legalSuffix: "",
  domain: "ehotelos.com",
  demoUrl: "https://demo.ehotelos.com",
} as const;
