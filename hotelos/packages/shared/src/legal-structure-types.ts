/**
 * Estructura societaria (Tanda 6b · L1, 2026-09-16): shared wire contract of the
 * legal-structure layer — Grupo (`Organization`) → Sociedad (`LegalEntity` = NIF) →
 * Centro de trabajo (`Property.kind`) — between the API
 * (`apps/api/src/lib/finance-scope.ts`, `modules/structure` in L2, the invoicing /
 * accounting guards of L3-L5) and the admin-web (L6 «Estructura societaria», L7
 * selector «Ámbito»).
 *
 * Fixed vocabulary (UI copy in Spanish): **Sociedad** (never «entidad legal»),
 * **Centro de trabajo** with subtypes **Hotel / Oficina / Otro**, **Grupo**, **Ámbito**.
 *
 * Rules this contract encodes (design §5.2):
 *   R2  the issuer identity (NIF, razón social, domicilio fiscal) is ALWAYS the
 *       legal entity's; the property contributes the establishment block only.
 *   R3  series prefixes are unique per legal entity and year → 409 SERIES_PREFIX_CLASH.
 *   R6  `office` / `other` centres carry finance rows only (no rooms, rates, POS…).
 *   R7  one VeriFactu chain per (obligado; instalación); the number is immutable.
 *   R10 exactly one legal entity per organization in this tanda → 409 MULTI_ENTITY_NOT_ENABLED.
 *
 * Money stays a decimal STRING with two decimals where it appears (none here);
 * `surfaceM2` follows the same convention. Dates are ISO timestamps (`…At`).
 *
 * Design: docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md §5.1, §5.2, §5.4.
 * Data contract: docs/runbooks/finanzas-contabilidad.md §17.
 */

// ---------------------------------------------------------------------------
// Enumerations (mirror the Prisma enums of packages/database/prisma/schema.prisma)
// ---------------------------------------------------------------------------

/** Work-centre type of a Property. Only `hotel` is operational (rooms, rates, POS, tasa, SES). */
export type PropertyKind = "hotel" | "office" | "other";
export type LegalForm = "sa" | "sl" | "slu" | "coop" | "persona_fisica" | "otra";
/** PGC template of the annual accounts (LSC arts. 257-258). */
export type PgcVariant = "pymes" | "general";
/** VeriFactu chain cardinality of a legal entity (Orden HAC/1177/2024 7.c). */
export type VerifactuChainScope = "per_center" | "per_entity";
export type LegalEntityStatus = "active" | "dormant";
export type VerifactuRoute = "verifactu" | "tbai" | "igic";

export const PROPERTY_KINDS: readonly PropertyKind[] = ["hotel", "office", "other"];
/** Kinds that run the hotel operation (night audit, portfolio, occupancy, tasa, SES, KPIs per room). */
export const OPERATIONAL_PROPERTY_KINDS: readonly PropertyKind[] = ["hotel"];
export const LEGAL_FORMS: readonly LegalForm[] = ["sa", "sl", "slu", "coop", "persona_fisica", "otra"];
export const PGC_VARIANTS: readonly PgcVariant[] = ["pymes", "general"];
export const VERIFACTU_CHAIN_SCOPES: readonly VerifactuChainScope[] = ["per_center", "per_entity"];

export const PROPERTY_KIND_LABELS_ES: Record<PropertyKind, string> = {
  hotel: "Hotel",
  office: "Oficina",
  other: "Otro"
};

export const LEGAL_FORM_LABELS_ES: Record<LegalForm, string> = {
  sa: "S.A.",
  sl: "S.L.",
  slu: "S.L.U.",
  coop: "Cooperativa",
  persona_fisica: "Persona física",
  otra: "Otra"
};

/** `LegalEntity.code` and `Property.code`: 2-6 upper-case letters or digits (RA, LT, OC, AMC…). */
export const STRUCTURE_CODE_PATTERN = /^[A-Z0-9]{2,6}$/;

// ---------------------------------------------------------------------------
// Structure mode (GET /organizations/me/structure → mode, L2)
// ---------------------------------------------------------------------------

/**
 * single_hotel  → 1 legal entity + 1 `hotel` property: no «grupo», no «centro», no selector.
 * multi_center  → 1 legal entity + ≥ 2 properties (Faranda): selector «Ámbito», oficina central.
 * group         → ≥ 2 legal entities (fase holding, not built in this tanda).
 */
export type StructureMode = "single_hotel" | "multi_center" | "group";

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export type LegalEntityDto = {
  id: string;
  organizationId: string;
  code: string;
  legalName: string;
  /** Normalised NIF or null while pending («NIF pendiente»). */
  taxId: string | null;
  /** Checksum verdict of `taxId` (false when null). */
  taxIdValid: boolean;
  legalForm: LegalForm | null;
  fiscalAddress: string | null;
  fiscalPostalCode: string | null;
  fiscalMunicipality: string | null;
  fiscalIneCode: string | null;
  fiscalProvince: string | null;
  registeredOfficeAddress: string | null;
  registeredOfficePostalCode: string | null;
  registeredOfficeMunicipality: string | null;
  registeredOfficeProvince: string | null;
  mercantileRegistry: string | null;
  cnae: string | null;
  pgcVariant: PgcVariant;
  fiscalYearStartMonth: number;
  largeCompany: boolean;
  siiEnabled: boolean;
  verifactuChainScope: VerifactuChainScope;
  cccPrincipal: string | null;
  isDefault: boolean;
  status: LegalEntityStatus;
  createdAt: string;
  updatedAt: string;
};

/**
 * Body of the 200 of `PATCH /legal-entities/:id`: the DTO plus the warnings the
 * change produced. After a NIF change every active series whose issued invoices
 * carry the previous NIF is listed (one sentence per series: it answers 409
 * ISSUER_TAX_ID_SERIES_MISMATCH on the next issuance — close it and open the
 * successor with another prefix; nothing is ever renumbered). Empty otherwise.
 */
export type LegalEntityPatchResponse = LegalEntityDto & { warnings: string[] };

/** Establishment (centro de trabajo) view of a Property: what the census, IAE, SES and TGSS need. */
export type PropertyEstablishmentDto = {
  id: string;
  organizationId: string;
  legalEntityId: string | null;
  code: string | null;
  name: string;
  /** Nombre comercial printed in the invoice establishment block (never the razón social). */
  tradeName: string | null;
  kind: PropertyKind;
  address: string | null;
  postalCode: string | null;
  municipality: string | null;
  ineMunicipalityCode: string | null;
  province: string | null;
  country: string;
  taxRegion: string | null;
  fiscalTerritory: string | null;
  cadastralReference: string | null;
  /** Decimal string with two decimals ("120.50") or null. */
  surfaceM2: string | null;
  iaeEpigraph: string | null;
  bedCapacity: number | null;
  starRating: number | null;
  openingMonths: number | null;
  tourismRegistryNumber: string | null;
  sesEstablishmentCode: string | null;
  socialSecurityCcc: string | null;
  laborCenterCode: string | null;
  verifactuEnabled: boolean;
  status: string;
};

export type VerifactuInstallationDto = {
  id: string;
  legalEntityId: string;
  propertyId: string | null;
  /** Immutable once created (trigger); never reused. */
  numeroInstalacion: string;
  route: VerifactuRoute;
  territory: string | null;
  active: boolean;
  createdAt: string;
  retiredAt: string | null;
};

/**
 * Identity every finance reader uses instead of `Organization.taxId/legalName`
 * (`resolveLegalIdentity`, apps/api/src/lib/finance-scope.ts). `source` tells a
 * tenant whose implicit legal entity has not been backfilled yet
 * (`organization_fallback`): the UI shows «Sociedad pendiente» instead of failing.
 */
export type LegalIdentityDto = {
  legalEntityId: string | null;
  organizationId: string;
  code: string | null;
  legalName: string;
  taxId: string | null;
  taxIdValid: boolean;
  source: "legal_entity" | "organization_fallback";
  legalForm: LegalForm | null;
  fiscalAddress: string | null;
  fiscalPostalCode: string | null;
  fiscalMunicipality: string | null;
  fiscalIneCode: string | null;
  fiscalProvince: string | null;
  pgcVariant: PgcVariant;
  largeCompany: boolean;
  siiEnabled: boolean;
  verifactuChainScope: VerifactuChainScope;
  cccPrincipal: string | null;
};

// ---------------------------------------------------------------------------
// Ámbito (selector único de Finanzas y Cumplimiento, L7)
// ---------------------------------------------------------------------------

export type FinanceScopeKind = "entity" | "property" | "group";

/** Persisted in localStorage["hotelos-finance-scope"], separate from the active property; reflected in `?ambito=`. */
export type FinanceScope = {
  kind: FinanceScopeKind;
  id: string;
  label: string;
};

// ---------------------------------------------------------------------------
// Reparto informativo de la oficina central (AccountingSetting.configurationJson.corporateAllocation)
// ---------------------------------------------------------------------------

export type CorporateAllocationMethod = "none" | "revenue" | "rooms_available" | "headcount" | "manual";

/** Only changes USALI/PyG per centre reporting; the journal and the taxes are never touched (R5). */
export type CorporateAllocation = {
  method: CorporateAllocationMethod;
  /** Required with `manual` (weights must add up to 100); ignored otherwise. */
  weights?: Array<{ propertyId: string; weight: number }>;
};

// ---------------------------------------------------------------------------
// Typed 4xx codes of the structure layer (`details.code` on the error body)
// ---------------------------------------------------------------------------

export type LegalStructureErrorCode =
  /** POST /legal-entities while the organization already has its (only) legal entity. */
  | "MULTI_ENTITY_NOT_ENABLED"
  /** A sister centre of the same legal entity already uses the prefix in that year (R3). */
  | "SERIES_PREFIX_CLASH"
  /** Journal lines of groups 6/7, withholdings or payroll without a work centre (R4). */
  | "WORK_CENTER_REQUIRED"
  /** FiscalYear.propertyId is not accepted: fiscal years belong to the legal entity (R4). */
  | "FISCAL_YEAR_IS_ENTITY_SCOPED"
  /** The VeriFactu chain scope cannot change once records were sent (R7). */
  | "CHAIN_ALREADY_STARTED"
  | "TAX_ID_INVALID"
  | "TAX_ID_IN_USE"
  /** The property profile no longer writes the NIF / razón social (they belong to the legal entity). */
  | "LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY"
  /** Fase holding: several legal entities and no active one selected. */
  | "LEGAL_ENTITY_REQUIRED"
  | "LEGAL_ENTITY_NOT_FOUND"
  | "ISSUER_TAX_ID_MISSING"
  // Tanda 6b · L2 (modules/structure): sociedad and work-centre management.
  /**
   * A high-risk field of the sociedad — `taxId`, `legalName`, `siiEnabled`, `largeCompany`,
   * `pgcVariant`, `fiscalYearStartMonth` — changed without `confirmHighRisk: true` (besides
   * the ai.high_risk.confirm permission; the regime fields also need accounting.configure).
   * `details { field, fields, changes: { <field>: { from, to } }, currentTaxId, nextTaxId }`.
   */
  | "HIGH_RISK_CONFIRMATION_REQUIRED"
  /** `siiEnabled: true` while REAL (preproduction / production) VeriFactu records of the sociedad are not yet accepted / rejected (`details.unresolvedSubmissions`). */
  | "VERIFACTU_SUBMISSIONS_PENDING"
  /** `LegalEntity.code` already used in the organization or `Property.code` in the legal entity. */
  | "CODE_IN_USE"
  /** A hotel with rooms / room types cannot become an office or other centre (R10.6). */
  | "PROPERTY_KIND_CHANGE_BLOCKED"
  /** A centre with that name already exists in the organization. */
  | "PROPERTY_NAME_IN_USE"
  /** An operational routine (night audit…) was asked on an office / other centre (R6). */
  | "WORK_CENTER_NOT_OPERATIONAL"
  /** Structure routes while STRUCTURE_ENABLED=false (404). */
  | "STRUCTURE_DISABLED"
  // Tanda 6b · L3 (invoicing): numbering and VeriFactu installations.
  /** Same invoice number already issued by a sister centre of the same legal entity (substitute of the deferred partial unique index). */
  | "INVOICE_NUMBER_DUPLICATE"
  /** `verifactu_submissions.error_code` in preproduction / production when the centre has no declared VeriFactu installation (never the env). */
  | "INSTALLATION_NOT_DECLARED"
  // Tanda 6b · fix:L3 (t6b#1, t6b#2, t6b#11).
  /** The sociedad bills from several centres and this one has no `Property.code`: the R3 coded prefix cannot be built (never falls back to the flat prefix). `details.screen`. */
  | "WORK_CENTER_CODE_REQUIRED"
  /** The series row of the year (or the legacy one with year NULL) is `active = false`: a closed series never numbers again — open another prefix. */
  | "SERIES_CLOSED"
  /** The sociedad is in the SII (RD 1007/2023 art. 3.3): the document is expedited without VeriFactu record; also `verifactu_submissions.error_code` and the prefix of the warning kept in Invoice.warningsJson. */
  | "VERIFACTU_EXCLUDED_BY_SII";

export type SeriesPrefixClashDetails = {
  code: "SERIES_PREFIX_CLASH";
  prefix: string;
  year: number | null;
  conflictingPropertyId: string;
  conflictingSequenceId: string;
};
