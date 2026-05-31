// Central re-export hub for all Zod request schemas.
//
// Handlers in server.ts (and future module routers) should import the schema
// they need from this file instead of redeclaring the same `z.object({...})`
// inline. Keeping the schemas in dedicated modules makes them testable in
// isolation and avoids drift between similar endpoints (e.g. the two paths
// that mutate the same folio).

export * from "./auth.schemas.js";
export * from "./reservations.schemas.js";
export * from "./folios.schemas.js";
export * from "./guests.schemas.js";
export * from "./finance.schemas.js";
