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
// Gestión del activo inmobiliario (Tanda ACT · L0a): catálogos (tenencia, unidades,
// cargas, valoraciones, tributos y recibos, documentos, inspecciones, seguros, obras,
// alertas), DTOs de lectura, KPIs, vista de grupo y códigos de error compartidos por
// el API y el admin-web.
export * from "./real-estate-types.js";
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
// Check-in automatizado y recepcionista IA (Tanda CHK · W1-A): estados de la sesión y
// del viajero, canales, métodos de verificación, vocabulario de preferencias, DTOs sin
// PII, resultado de lectura de documentos, candidatas de asignación y códigos de error
// compartidos por el API, el portal del huésped, el kiosco y el admin-web.
export * from "./checkin-types.js";
// Estado honesto de las integraciones (Tanda L8 · L8-01): modo none|sandbox|real,
// claves fijas del inventario, DTO de estado por integración, entrada del bloque
// `integrations` de /health y catálogos (etiquetas, pantallas) compartidos por el
// API y el admin-web.
export * from "./integrations-status-types.js";
// Portal del huésped · estancia y salida (Tanda L7 · L7-02): etapa de la estancia,
// vista `GET /guest-portal/stay`, peticiones de salida, enlace de pago honesto y
// códigos de error compartidos por el API, el portal del huésped y el admin-web.
export * from "./guest-portal-types.js";
// RRHH · plantilla, convenio, estándares, previsión y nómina (Tanda RRHH · RRHH-1): DTOs wire sin
// PII en listados, vocabularios, valores por defecto de convenios y estándares, tipos de
// cotización 2026, panel de costes de personal y códigos de error compartidos por el API y el admin-web.
export * from "./hr-types.js";
export type { MoneyString } from "./accounting-types.js";
export type { PaymentMethodCode } from "./payments-types.js";
export type { VatBookRowDto } from "./fiscal-types.js";
