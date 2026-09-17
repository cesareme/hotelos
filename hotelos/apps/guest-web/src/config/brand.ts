// Copia mínima de la marca para el portal del huésped (rebrand ehotelOS, 2026-09).
// La FUENTE es apps/admin-web/src/config/brand.ts: tests/brand-contract.test.mjs
// exige que el `name` de las cuatro copias (admin-web, guest-web, mobile, api)
// coincida. No se exporta desde @hotelos/shared porque packages/shared/src
// mantiene espejos .js junto a los .ts que habría que sincronizar a mano.
export const BRAND = {
  name: "ehotelOS",
  legalSuffix: "",
  domain: "ehotelos.com",
  demoUrl: "https://demo.ehotelos.com",
} as const;
