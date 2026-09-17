// Copia mínima de la marca para la API (rebrand ehotelOS, 2026-09): correos,
// PDFs y mensajes visibles importan BRAND en lugar de repetir el literal.
// La FUENTE es apps/admin-web/src/config/brand.ts: tests/brand-contract.test.mjs
// exige que el `name` de las cuatro copias (admin-web, guest-web, mobile, api)
// coincida. No se exporta desde @hotelos/shared porque packages/shared/src
// mantiene espejos .js junto a los .ts que habría que sincronizar a mano.
//
// NO usar BRAND.name para el SIF VeriFactu/TicketBAI (VERIFACTU_SYSTEM_NAME,
// packages/compliance/src/spain/verifactu/software.ts): el nombre del sistema
// informático es un valor declarado ante la AEAT en la declaración responsable
// y no debe cambiar implícitamente con la marca.
export const BRAND = {
  name: "ehotelOS",
  legalSuffix: "",
  domain: "ehotelos.com",
  demoUrl: "https://demo.ehotelos.com",
} as const;
