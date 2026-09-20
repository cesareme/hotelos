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
// Documentos y digitalización con IA (Tanda T9 · L0): catálogos (tipos, estados,
// canales, acciones propuestas, motivos de rechazo, comprobaciones), DTOs de
// documento / extracción / propuesta, recepciones de mercancía, cotejo y códigos
// de error compartidos por el API y el admin-web.
export * from "./documents-types.js";
export * from "./treasury-types.js";
export * from "./financial-statements-types.js";
// Estructura societaria (Tanda 6b · L1, integración): LegalEntity / work-centre
// DTOs, enums (PropertyKind, LegalForm, PgcVariant, VerifactuChainScope) and the
// LegalStructureErrorCode union shared by the API and the front.
export * from "./legal-structure-types.js";
// Coste de personal importado (Tanda 6c): lotes agregados centro × mes × grupo ×
// departamento (nunca personas), previsualización, informe de coste y códigos de
// error compartidos por el API, el CLI payroll:import-cost y el admin-web.
export * from "./payroll-cost-types.js";
// Importación masiva de reservas (Tanda 7 · L0): límites, campos canónicos (33),
// catálogos, previsualización, lote / filas sin PII y códigos de error de lote y de
// fila compartidos por el API, el CLI reservations:import y el admin-web.
export * from "./reservation-import-types.js";
// OPERA Cloud · modo sombra (Tanda 7b · L0): sistemas, feeds, runs, enlaces, alertas,
// ingresos diarios, perfil de mapeo preinstalado «OPERA Cloud» y códigos de error
// compartidos por el API, el CLI pms-shadow:pull, el job del líder y el admin-web.
export * from "./pms-shadow-types.js";
export * from "./pms-shadow-profiles/opera-cloud.js";
// Importación contable desde Sage 200 (Tanda 7c · L0): tipos de lote, formatos, mapa de
// cuentas y analítico, previsualización, lotes, reconciliación, límites y códigos de error
// compartidos por el API, el CLI sage200:import y el admin-web.
export * from "./ledger-import-types.js";
// RBAC por departamento, nivel y ámbito (Tanda 8a · L0): levels, scopes, thresholds,
// approval kinds, static SoD pairs, error/audit codes and the wire DTOs of the rbac,
// approvals, supervisor-PIN and break-glass routes shared by the API and the admin-web.
export * from "./rbac-types.js";
export type { MoneyString } from "./accounting-types.js";
export type { PaymentMethodCode } from "./payments-types.js";
export type { VatBookRowDto } from "./fiscal-types.js";
