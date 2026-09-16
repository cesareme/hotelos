// Estructura societaria (Tanda 6b · L6). Typed client of
// apps/api/src/modules/structure/structure.routes.ts (design §5.4, runbook
// docs/runbooks/finanzas-contabilidad.md §17.8) on the shared contracts of
// packages/shared/src/legal-structure-types.ts, plus the three finance routes
// the Estructura societaria screens consume (allocation, VAT regime).
//
//   GET   /organizations/me/structure                       getOrganizationStructure   accounting.read (redacted without accounting.entity.read)
//   GET   /legal-entities/:id                               getLegalEntity             accounting.entity.read
//   PATCH /legal-entities/:id                               patchLegalEntity           organization.structure.manage (+ ai.high_risk.confirm / accounting.configure)
//   POST  /legal-entities/:id/properties  (dryRun)          provisionCentre            organization.structure.manage
//   GET   /legal-entities/:id/series                        listLegalEntitySeries      billing.configure
//   GET   /legal-entities/:id/verifactu/installations       listVerifactuInstallations accounting.configure
//   PATCH /properties/:id/establishment                     patchEstablishment         organization.structure.manage
//   POST  /admin/legal-entities/:id/verifactu-scope         setVerifactuChainScope     admin.tenants.manage (platform console)
//   GET|PUT /accounting/allocation                          getCorporateAllocation · putCorporateAllocation
//   GET   /fiscal/regime?year=                              getFiscalRegime
//
// Money never travels here; `surfaceM2` is a decimal string. Errors: every
// typed 4xx carries `details.code` (LegalStructureErrorCode) — the screens map
// it with structureErrorMessage (screens/structure/structure-ui.ts, on top of
// FINANCE_ERROR_MESSAGES of finance-contracts.ts).

import type {
  CorporateAllocationPutBody,
  CorporateAllocationView,
  FiscalRegimeReport,
  LegalEntityDto,
  LegalEntityPatchResponse,
  LegalForm,
  PgcVariant,
  PropertyEstablishmentDto,
  PropertyKind,
  StructureMode,
  VerifactuChainScope,
  VerifactuInstallationDto
} from "@hotelos/shared";
import { apiRequest } from "./api-client";

export type {
  CorporateAllocationPutBody,
  CorporateAllocationView,
  FiscalRegimeReport,
  LegalEntityDto,
  LegalEntityPatchResponse,
  PropertyEstablishmentDto,
  PropertyKind,
  StructureMode,
  VerifactuChainScope,
  VerifactuInstallationDto
} from "@hotelos/shared";

// ---------------------------------------------------------------------------
// GET /organizations/me/structure (single point of truth of the front)
// ---------------------------------------------------------------------------

export type StructureSeries = {
  id: string;
  propertyId: string;
  sequenceCode: string;
  prefix: string | null;
  year: number | null;
  nextNumber: number;
  padding: number;
  invoiceType: string;
  active: boolean;
};

export type StructureProperty = {
  id: string;
  code: string | null;
  name: string;
  tradeName: string | null;
  kind: PropertyKind;
  municipality: string | null;
  province: string | null;
  status: string;
  legalEntityId: string | null;
  verifactuEnabled: boolean;
  sesHospedajesEnabled: boolean;
  /** Empty when the caller only sees its assigned centres (`scope: "assigned_properties"`). */
  series: StructureSeries[];
  installation: VerifactuInstallationDto | null;
};

export type StructureVatSettings = { periodicity: string; regime: string; prorrataPct: string | null; taxFigure: string };

export type StructureLegalEntity = LegalEntityDto & {
  vatSettings: StructureVatSettings | null;
  properties: StructureProperty[];
};

export type StructureWarning = "LEGAL_ENTITY_PENDING" | "TAX_ID_PENDING" | "PROPERTIES_UNLINKED";

/** `entity` = the whole sociedad; `assigned_properties` = redacted to the caller's centres (no NIF, series, installations, VAT). */
export type StructureReadScope = "entity" | "assigned_properties";

export type OrganizationStructure = {
  organization: { id: string; name: string; country: string };
  legalEntity: StructureLegalEntity | null;
  mode: StructureMode;
  counts: { properties: number; hotels: number; offices: number; others: number; legalEntities: number };
  warnings: StructureWarning[];
  scope: StructureReadScope;
};

export function getOrganizationStructure(): Promise<OrganizationStructure> {
  return apiRequest<OrganizationStructure>("/organizations/me/structure");
}

// ---------------------------------------------------------------------------
// Sociedad
// ---------------------------------------------------------------------------

export function getLegalEntity(legalEntityId: string): Promise<LegalEntityDto> {
  return apiRequest<LegalEntityDto>(`/legal-entities/${encodeURIComponent(legalEntityId)}`);
}

/**
 * Body of PATCH /legal-entities/:id (zod `.strict()`: only these keys). `taxId`,
 * `legalName`, `siiEnabled`, `largeCompany`, `pgcVariant` and
 * `fiscalYearStartMonth` are high risk: send `confirmHighRisk: true` after the
 * user confirmed, or the API answers 409 HIGH_RISK_CONFIRMATION_REQUIRED.
 * `verifactuChainScope` is NOT patchable here (platform console only, R7).
 */
export type LegalEntityPatchBody = Partial<{
  legalName: string;
  code: string;
  taxId: string | null;
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
  cccPrincipal: string | null;
  confirmHighRisk: boolean;
}>;

export function patchLegalEntity(legalEntityId: string, body: LegalEntityPatchBody): Promise<LegalEntityPatchResponse> {
  return apiRequest<LegalEntityPatchResponse>(`/legal-entities/${encodeURIComponent(legalEntityId)}`, { method: "PATCH", body });
}

// ---------------------------------------------------------------------------
// Alta de centro (POST /legal-entities/:id/properties · dryRun)
// ---------------------------------------------------------------------------

export type CentreCensusInput = Partial<{
  cadastralReference: string | null;
  surfaceM2: string | null;
  iaeEpigraph: string | null;
  bedCapacity: number | null;
  starRating: number | null;
  openingMonths: number | null;
  tourismRegistryNumber: string | null;
  sesEstablishmentCode: string | null;
  socialSecurityCcc: string | null;
  laborCenterCode: string | null;
}>;

export type CentreSeriesInput = {
  sequenceCode: string;
  /** F1 · F2 · F3 · R · R1-R5 (assertInvoiceSequenceCoherent). */
  invoiceType: string;
  /** Omitted → R3 default (flat with one billing centre, coded with several). */
  prefix?: string;
  year: number;
  padding?: number;
};

/** Spec of ONE work centre (structure.schemas.ts centreSpecSchema, `.strict()`); hotel sections only for `kind: "hotel"`. */
export type CentreSpecBody = {
  property: {
    name: string;
    kind: PropertyKind;
    code?: string | null;
    tradeName?: string | null;
    address?: string | null;
    municipality?: string | null;
    province?: string | null;
    country?: string;
    postalCode?: string | null;
    ineMunicipalityCode?: string | null;
    taxRegion?: string | null;
    fiscalTerritory?: "common" | "bizkaia" | "gipuzkoa" | "araba" | "navarra" | null;
    timezone?: string;
    sesHospedajesEnabled?: boolean;
    verifactuEnabled?: boolean;
    census?: CentreCensusInput;
  };
  building?: { name: string; code: string; floors: number };
  totalRooms?: number;
  roomTypes?: { items: Array<{ code: string; name: string; baseCapacity: number; maxOccupancy: number; count: number; defaultRateCategory?: string | null }> };
  invoiceSequences?: CentreSeriesInput[];
  /** true → validate only (plan, prefixes, clashes, code) and write nothing. */
  dryRun?: boolean;
};

export type PlannedWriteSummary = { table: string; op: string; count: number; where?: string };

export type ProvisionCentreResult = {
  dryRun: boolean;
  legalEntity: { id: string; code: string; legalName: string };
  property: { id: string | null; name: string; kind: PropertyKind; code: string; existed: boolean };
  plan: { writes: PlannedWriteSummary[]; skips: string[]; conflicts: string[] };
  series: Array<{ sequenceCode: string; year: number; prefix: string; prefixSource: "spec" | "default"; clash: { propertyId: string; sequenceId: string } | null }>;
  /** Series whose prefix a sister centre already uses (409 SERIES_PREFIX_CLASH on apply). */
  prefixClash: Array<{ sequenceCode: string; year: number; prefix: string; conflictingPropertyId: string; conflictingSequenceId: string }>;
  applied: { propertyId: string; establishment: PropertyEstablishmentDto } | null;
};

export function provisionCentre(legalEntityId: string, body: CentreSpecBody): Promise<ProvisionCentreResult> {
  return apiRequest<ProvisionCentreResult>(`/legal-entities/${encodeURIComponent(legalEntityId)}/properties`, { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Series y VeriFactu (sociedad-wide)
// ---------------------------------------------------------------------------

export type LegalEntitySeriesRow = StructureSeries & {
  propertyCode: string | null;
  propertyName: string;
  propertyKind: PropertyKind;
  /** Another centre of the same sociedad uses the same prefix in the same year (R3). */
  clash: { propertyId: string; sequenceId: string } | null;
};

export type LegalEntitySeriesResponse = { legalEntityId: string; series: LegalEntitySeriesRow[]; clashCount: number };

export function listLegalEntitySeries(legalEntityId: string): Promise<LegalEntitySeriesResponse> {
  return apiRequest<LegalEntitySeriesResponse>(`/legal-entities/${encodeURIComponent(legalEntityId)}/series`);
}

export type VerifactuInstallationView = VerifactuInstallationDto & {
  propertyCode: string | null;
  propertyName: string | null;
  /** Records sent under this installation (any mode) and the last chained invoice. */
  submissions: number;
  lastInvoice: { invoiceNumber: string | null; issuedAt: string | null } | null;
};

export type VerifactuInstallationsResponse = { legalEntityId: string; chainScope: VerifactuChainScope; installations: VerifactuInstallationView[] };

export function listVerifactuInstallations(legalEntityId: string): Promise<VerifactuInstallationsResponse> {
  return apiRequest<VerifactuInstallationsResponse>(`/legal-entities/${encodeURIComponent(legalEntityId)}/verifactu/installations`);
}

// ---------------------------------------------------------------------------
// Ficha del centro (PATCH /properties/:id/establishment — never NIF nor razón social)
// ---------------------------------------------------------------------------

export type EstablishmentPatchBody = Partial<{ kind: PropertyKind; code: string; tradeName: string | null }> & CentreCensusInput;

export function patchEstablishment(propertyId: string, body: EstablishmentPatchBody): Promise<PropertyEstablishmentDto> {
  return apiRequest<PropertyEstablishmentDto>(`/properties/${encodeURIComponent(propertyId)}/establishment`, { method: "PATCH", body });
}

// ---------------------------------------------------------------------------
// Consola de plataforma · política de cadena (R7)
// ---------------------------------------------------------------------------

export type VerifactuScopeResult = { legalEntity: LegalEntityDto; changed: boolean; realSubmissions: number };

/** Platform console only: `confirm: true` is mandatory (the decision is recorded in the declaración responsable). */
export function setVerifactuChainScope(legalEntityId: string, scope: VerifactuChainScope): Promise<VerifactuScopeResult> {
  return apiRequest<VerifactuScopeResult>(`/admin/legal-entities/${encodeURIComponent(legalEntityId)}/verifactu-scope`, { method: "POST", body: { scope, confirm: true } });
}

// ---------------------------------------------------------------------------
// Reparto informativo (GET/PUT /accounting/allocation) y régimen (GET /fiscal/regime)
// ---------------------------------------------------------------------------

export function getCorporateAllocation(): Promise<CorporateAllocationView> {
  return apiRequest<CorporateAllocationView>("/accounting/allocation");
}

/** Never posts anything: the key only changes the USALI / PyG por centro reports (R5). */
export function putCorporateAllocation(body: CorporateAllocationPutBody): Promise<CorporateAllocationView> {
  return apiRequest<CorporateAllocationView>("/accounting/allocation", { method: "PUT", body });
}

export function getFiscalRegime(year: number): Promise<FiscalRegimeReport> {
  return apiRequest<FiscalRegimeReport>("/fiscal/regime", { query: { year } });
}
