export * from "./types.js";
export * from "./permissions.js";
export * from "./rate-manager-types.js";
// Finanzas (2026-09-16, integración): wire contracts of the finance modules.
// `MoneyString`, `PaymentMethodCode` and `VatBookRowDto` are declared in more
// than one file; the explicit re-exports below pick the canonical one so the
// star exports stay unambiguous (TS2308).
export * from "./accounting-types.js";
export * from "./fiscal-types.js";
export * from "./payments-types.js";
export * from "./pos-types.js";
export * from "./payables-types.js";
export * from "./treasury-types.js";
export * from "./financial-statements-types.js";
export type { MoneyString } from "./accounting-types.js";
export type { PaymentMethodCode } from "./payments-types.js";
export type { VatBookRowDto } from "./fiscal-types.js";
