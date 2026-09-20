// Activo inmobiliario (Tanda ACT · lote ACT-F0, diseño docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md §7-§8).
// Cliente tipado de apps/api/src/modules/real-estate/*.routes.ts (agregador real-estate.register.ts)
// sobre packages/shared/src/real-estate-types.ts: dinero como cadena ("1060.00"),
// porcentajes como cadena decimal, días AAAA-MM-DD, `details.code` ∈
// REAL_ESTATE_ERROR_CODES en los 4xx (la frase en español la pone
// screens/realEstate/real-estate-helpers.ts · realEstateErrorMessage).
//
//   GET|POST|PATCH /properties/:propertyId/real-estate                        getRealEstateAsset · createRealEstateAsset · updateRealEstateAsset   real_estate.read / real_estate.manage
//   POST  …/real-estate/units · PATCH …/units/:unitId                          createRealEstateUnit · updateRealEstateUnit                          real_estate.manage
//   POST  …/units/:unitId/charges · PATCH …/charges/:chargeId                  createRealEstateCharge · updateRealEstateCharge                      real_estate.manage
//   GET|POST …/real-estate/valuations                                          listRealEstateValuations · createRealEstateValuation                 real_estate.read / real_estate.manage
//   GET|POST …/real-estate/tenures · PATCH …/tenures/:tenureId                 listRealEstateTenures · createRealEstateTenure · updateRealEstateTenure (action activar | resolver)
//   GET|POST …/real-estate/taxes · PATCH …/taxes/:taxId                        listPropertyTaxes · createPropertyTax · updatePropertyTax            real_estate.read / property_tax.manage
//   POST  …/taxes/:taxId/receipts · POST …/receipts/generate                   createPropertyTaxReceipt · generatePropertyTaxReceipts               property_tax.manage
//   GET   …/real-estate/receipts?year= · PATCH …/receipts/:receiptId           listPropertyTaxReceipts · updatePropertyTaxReceipt                   real_estate.read / property_tax.manage
//   POST  …/receipts/:receiptId/propose-entry                                  proposeReceiptEntry (asiento 631 en borrador)                        property_tax.manage (crítico)
//   GET   …/real-estate/tax-calendar?year=                                     getPropertyTaxCalendar                                               real_estate.read
//   GET   …/real-estate/documents?category=&status=&kind=                      listRealEstateDocuments                                              real_estate.read
//   POST  …/real-estate/documents · POST …/documents/:documentId/versions      uploadRealEstateDocument · uploadRealEstateDocumentVersion           real_estate.documents.manage (base64 en el JSON)
//   PATCH|DELETE …/documents/:documentId                                       updateRealEstateDocument · retireRealEstateDocument                  real_estate.documents.manage / real_estate.manage
//   GET   …/documents/:documentId/file?inline=1                                downloadRealEstateDocument (binario, apiRequestBlob)                 real_estate.read
//   GET   …/real-estate/works                                                  listRealEstateWorks                                                  real_estate.read
//   PATCH /capex-projects/:id/work · POST /capex-projects/:id/capitalize       updateCapexWork · capitalizeCapexProject                             capex.create / assets.manage (crítico)
//   POST  /capex-projects/:id/approve                                          (helper local de RealEstateWorksScreen: approveCapexProjectRequest)  asset.capex.approve (ACT-REV-05)
//   GET|POST …/real-estate/inspections · PATCH …/inspections/:inspectionId     listRealEstateInspections · createRealEstateInspection · updateRealEstateInspection
//   GET|POST …/real-estate/insurances · PATCH …/insurances/:insuranceId        listRealEstateInsurances · createRealEstateInsurance · updateRealEstateInsurance
//   GET   …/real-estate/alerts                                                 listRealEstateAlerts                                                 real_estate.read
//   GET   …/real-estate/calendar?year=                                         getRealEstateCalendar (12 meses del centro)                          real_estate.read (ACT-L6)
//   GET   /organizations/:organizationId/real-estate/overview                  getRealEstateGroupOverview                                           real_estate.read + ámbito (ACT-L6)
//   GET   /organizations/:organizationId/real-estate/calendar?year=            getRealEstateGroupCalendar (12 meses de los centros visibles)        real_estate.read + ámbito (ACT-L6)
//   GET   /organizations/:organizationId/real-estate/export?format=csv&what=   exportRealEstateCsv (text/csv, binario)                              real_estate.read + ámbito (ACT-L6)
//   POST  /journal-entries/:id/post                                            postProposedEntry (contabiliza el borrador propuesto)                accounting.journal.post + ai.high_risk.confirm (crítico)
//
// Estado del API (2026-09-20, tras ACT-L1…L6): existen las 41 rutas del módulo
// (core, tributos, documentos, obras, inspecciones/pólizas/alertas, calendario
// y vista de grupo); las rutas de documentos están registradas en
// documents.routes.ts pero el agregador real-estate.register.ts aún no las llama
// (pendiente del orquestador, ACT-L3 #1). Las funciones toman el centro / la
// organización activos por defecto (services/activeProperty.ts) y admiten
// pasarlos explícitamente (vista de grupo: nunca cambia la propiedad activa).
//
// Ficheros: el API recibe los bytes en base64 dentro del JSON
// (`file: { fileName, mimeType, base64 }`, alfabeto estándar sin prefijo
// `data:`); `readFileAsBase64` los lee con FileReader. La descarga y la
// exportación CSV vuelven como Blob por apiRequestBlob (nunca fetch crudo:
// tests/admin-web-no-raw-fetch). Los `…Path` / `…Query` existen para que las
// pantallas lean con `useApiData(path, { query })` y compartan la caché.

import type {
  CapexProjectStatus,
  CapexWorkKind,
  CapexWorkRecord,
  FixedAssetDto,
  IsoDay,
  MoneyString,
  PercentString,
  PropertyTaxInstallment,
  PropertyTaxKind,
  PropertyTaxPaidWith,
  PropertyTaxPeriodicity,
  PropertyTaxReceiptRecord,
  PropertyTaxReceiptStatus,
  PropertyTaxRecord,
  PropertyTaxStatus,
  PropertyTaxTaxpayer,
  RealEstateAlert,
  RealEstateAssetDetail,
  RealEstateAssetStatus,
  RealEstateCalendarEvent,
  RealEstateCapexResponsibility,
  RealEstateCdeState,
  RealEstateChargeKind,
  RealEstateChargeRecord,
  RealEstateConfidentiality,
  RealEstateCostPayer,
  RealEstateDefectSeverity,
  RealEstateDocumentCategory,
  RealEstateDocumentKind,
  RealEstateDocumentRecord,
  RealEstateDocumentStatus,
  RealEstateEnergyRating,
  RealEstateGroupOverview,
  RealEstateInspectionKind,
  RealEstateInspectionRecord,
  RealEstateInspectionResult,
  RealEstateInspectionStatus,
  RealEstateInsuranceKind,
  RealEstateInsuranceRecord,
  RealEstateInsuranceStatus,
  RealEstateJournalEntryStatus,
  RealEstateLinkedEntityType,
  RealEstatePolicyholder,
  RealEstateProtectionLevel,
  RealEstateRentKind,
  RealEstateRentReviewIndex,
  RealEstateRentVariableBase,
  RealEstateTenureKind,
  RealEstateTenureRecord,
  RealEstateTenureRenewal,
  RealEstateTitleKind,
  RealEstateUnitKind,
  RealEstateUnitWithCharges,
  RealEstateUseCode,
  RealEstateValuationKind,
  RealEstateValuationPurpose,
  RealEstateValuationRecord
} from "@hotelos/shared";
import { apiRequest, apiRequestBlob, type BlobResponse } from "./api-client";
import { getActiveOrganizationId, getActivePropertyId } from "./activeProperty";
import { compactQuery, financeErrorMessage, type FinanceQuery } from "./finance-contracts";

export type {
  CapexWorkRecord,
  PropertyTaxReceiptRecord,
  PropertyTaxRecord,
  RealEstateAlert,
  RealEstateAssetDetail,
  RealEstateCalendarEvent,
  RealEstateChargeRecord,
  RealEstateDocumentRecord,
  RealEstateGroupOverview,
  RealEstateInspectionRecord,
  RealEstateInsuranceRecord,
  RealEstateTenureRecord,
  RealEstateUnitWithCharges,
  RealEstateValuationRecord
} from "@hotelos/shared";
export type { BlobResponse } from "./api-client";

const enc = encodeURIComponent;

/** Importe de entrada: cadena decimal ("1060.00") o número; el API lo normaliza a dos decimales. */
export type MoneyInput = MoneyString | number;
/** Porcentaje de entrada: cadena decimal ("6.25") o número. */
export type PercentInput = PercentString | number;

// ---------------------------------------------------------------------------
// Cuerpos de las peticiones (espejo de apps/api/src/schemas/real-estate.schemas.ts;
// `null` borra el valor en los PATCH, una clave ausente no toca el campo)
// ---------------------------------------------------------------------------

export type RealEstateAssetRequest = {
  name: string;
  legalEntityId?: string | null;
  yearBuilt?: number | null;
  yearLastRefurbished?: number | null;
  builtSurfaceM2?: MoneyInput | null;
  plotSurfaceM2?: MoneyInput | null;
  floorsAbove?: number | null;
  floorsBelow?: number | null;
  roomsCount?: number | null;
  protectionLevel?: RealEstateProtectionLevel;
  energyRating?: RealEstateEnergyRating | null;
  energyCertValidUntil?: IsoDay | null;
  cadastralValueTotal?: MoneyInput | null;
  cadastralValueYear?: number | null;
  referenceValue?: MoneyInput | null;
  notes?: string | null;
};

export type RealEstateAssetPatchRequest = Partial<RealEstateAssetRequest> & { status?: RealEstateAssetStatus };

export type RealEstateUnitRequest = {
  kind?: RealEstateUnitKind;
  registryOffice?: string | null;
  registryFincaNumber?: string | null;
  registryTomo?: string | null;
  registryLibro?: string | null;
  registryFolio?: string | null;
  cru?: string | null;
  /** 20 caracteres alfanuméricos; el API normaliza mayúsculas y espacios (INVALID_CADASTRAL_REFERENCE si no). */
  cadastralReference?: string | null;
  useCode?: RealEstateUseCode | null;
  surfaceM2?: MoneyInput | null;
  cadastralValueLand?: MoneyInput | null;
  cadastralValueBuilding?: MoneyInput | null;
  titleKind?: RealEstateTitleKind;
  titleHolderTaxId?: string | null;
  titleHolderName?: string | null;
  titleDeedDate?: IsoDay | null;
  notary?: string | null;
  fixedAssetId?: string | null;
};

export type RealEstateUnitPatchRequest = RealEstateUnitRequest;

export type RealEstateChargeRequest = {
  kind: RealEstateChargeKind;
  holderName?: string | null;
  holderTaxId?: string | null;
  amount?: MoneyInput | null;
  outstandingAmount?: MoneyInput | null;
  registeredAt?: IsoDay | null;
  expiresAt?: IsoDay | null;
  cancelledAt?: IsoDay | null;
  documentId?: string | null;
  note?: string | null;
};

export type RealEstateChargePatchRequest = Partial<RealEstateChargeRequest>;

export type RealEstateValuationRequest = {
  kind: RealEstateValuationKind;
  purpose?: RealEstateValuationPurpose | null;
  valuedAt: IsoDay;
  value: MoneyInput;
  valuePerRoom?: MoneyInput | null;
  capRatePct?: PercentInput | null;
  method?: string | null;
  appraiser?: string | null;
  documentId?: string | null;
};

export type RealEstateTenureRequest = {
  kind: RealEstateTenureKind;
  counterpartyName?: string | null;
  counterpartyTaxId?: string | null;
  counterpartyNonResident?: boolean;
  startDate: IsoDay;
  endDate?: IsoDay | null;
  noticeMonths?: number | null;
  renewal?: RealEstateTenureRenewal;
  rentKind?: RealEstateRentKind | null;
  rentMonthly?: MoneyInput | null;
  rentVariablePct?: PercentInput | null;
  rentVariableBase?: RealEstateRentVariableBase | null;
  rentReviewIndex?: RealEstateRentReviewIndex | null;
  /** 1..12. */
  rentReviewMonth?: number | null;
  depositAmount?: MoneyInput | null;
  vatApplies?: boolean;
  withholdingApplies?: boolean;
  withholdingRatePct?: PercentInput | null;
  ibiPayer?: RealEstateCostPayer;
  insurancePayer?: RealEstateCostPayer;
  capexResponsibility?: RealEstateCapexResponsibility;
  ffeReservePct?: PercentInput | null;
  brandName?: string | null;
  documentId?: string | null;
  notes?: string | null;
};

/** `activar` → vigente (TENURE_ALREADY_ACTIVE si ya hay otra) · `resolver` → resuelto. */
export type RealEstateTenureAction = "activar" | "resolver";
export type RealEstateTenurePatchRequest = Partial<RealEstateTenureRequest> & { action?: RealEstateTenureAction };

/** Plazo de un tributo fraccionado (`installmentsJson[]`, ventanas `MM-DD`; los `pct` suman 100). */
export type PropertyTaxInstallmentRequest = Omit<PropertyTaxInstallment, "pct"> & { pct: PercentInput };

export type PropertyTaxRequest = {
  kind: PropertyTaxKind;
  taxpayer?: PropertyTaxTaxpayer;
  authorityName: string;
  unitId?: string | null;
  fiscalReference?: string | null;
  taxBase?: MoneyInput | null;
  /** Hasta 4 decimales ("0.4525"). */
  ratePct?: PercentInput | null;
  expectedAnnualAmount?: MoneyInput | null;
  periodicity?: PropertyTaxPeriodicity;
  /** `MM-DD`; van juntos (los dos o ninguno). */
  voluntaryFrom?: string | null;
  voluntaryTo?: string | null;
  directDebit?: boolean;
  directDebitBonusPct?: PercentInput | null;
  installmentsJson?: PropertyTaxInstallmentRequest[] | null;
  accountCode?: string;
  capitalizable?: boolean;
  legalBasis?: string | null;
};

export type PropertyTaxPatchRequest = Partial<PropertyTaxRequest> & { status?: PropertyTaxStatus };

/** Estados que puede fijar el alta manual de un recibo (los demás los pone el servicio). */
export type PropertyTaxReceiptCreateStatus = Extract<PropertyTaxReceiptStatus, "previsto" | "recibido" | "domiciliado">;
/** Estados que admite el PATCH (la máquina RECEIPT decide si la transición vale: RECEIPT_NOT_PAYABLE). */
export type PropertyTaxReceiptPatchStatus = Exclude<PropertyTaxReceiptStatus, "previsto">;

export type PropertyTaxReceiptRequest = {
  fiscalYear: number;
  /** `anual` · `1/2` · `PAC-03`…; por defecto `anual`. */
  period?: string;
  issuedAt?: IsoDay | null;
  dueFrom?: IsoDay | null;
  dueTo?: IsoDay | null;
  amount?: MoneyInput;
  surchargeAmount?: MoneyInput;
  status?: PropertyTaxReceiptCreateStatus;
  capexProjectId?: string | null;
  documentId?: string | null;
  notes?: string | null;
};

export type PropertyTaxReceiptPatchRequest = {
  status?: PropertyTaxReceiptPatchStatus;
  amount?: MoneyInput;
  surchargeAmount?: MoneyInput;
  issuedAt?: IsoDay | null;
  dueFrom?: IsoDay | null;
  dueTo?: IsoDay | null;
  /** Pagar sin `paidAt` → hoy; sin `paidWith` → banco. */
  paidAt?: IsoDay | null;
  paidWith?: PropertyTaxPaidWith | null;
  appealRef?: string | null;
  /** Enlace manual a un asiento contabilizado (ejercicio cerrado); `null` desenlaza. */
  journalEntryId?: string | null;
  documentId?: string | null;
  notes?: string | null;
};

/** Metadatos de un documento (sin fichero); `supersedesId` = nueva versión de otro documento. */
export type RealEstateDocumentMeta = {
  category: RealEstateDocumentCategory;
  kind: RealEstateDocumentKind;
  title: string;
  issuerName?: string | null;
  issueDate?: IsoDay | null;
  validFrom?: IsoDay | null;
  validUntil?: IsoDay | null;
  renewalDays?: number | null;
  cdeState?: RealEstateCdeState;
  confidentiality?: RealEstateConfidentiality;
  linkedEntityType?: RealEstateLinkedEntityType | null;
  linkedEntityId?: string | null;
  complianceRequirementCode?: string | null;
  retentionUntil?: IsoDay | null;
  legalHold?: boolean;
  supersedesId?: string;
};

/** Fichero tal como viaja en el JSON: base64 estándar (RFC 4648 §4) sin prefijo `data:`. */
export type RealEstateDocumentFile = { fileName: string; mimeType: string; base64: string };

export type RealEstateDocumentRequest = RealEstateDocumentMeta & { file?: RealEstateDocumentFile };

/** Metadatos de una versión nueva: hereda de la anterior lo que no se envíe (`null` borra); el fichero es obligatorio. */
export type RealEstateDocumentVersionMeta = Partial<Omit<RealEstateDocumentMeta, "supersedesId">>;

export type RealEstateDocumentPatchRequest = Partial<Omit<RealEstateDocumentMeta, "supersedesId">>;

export type RealEstateInspectionDefectRequest = {
  severity: RealEstateDefectSeverity;
  text: string;
  dueAt?: IsoDay | null;
  fixedAt?: IsoDay | null;
};

export type RealEstateInspectionRequest = {
  kind: RealEstateInspectionKind;
  legalBasis?: string | null;
  periodicityMonths?: number | null;
  installationRef?: string | null;
  technicalAssetId?: string | null;
  providerName?: string | null;
  supplierId?: string | null;
  scheduledAt?: IsoDay | null;
  nextDueAt?: IsoDay | null;
  complianceRequirementCode?: string | null;
  notes?: string | null;
};

/** Acta (`performedAt`, `result`, `documentId`), defectos, subsanación y/o `status` explícito (INSPECTION_INVALID_TRANSITION si no vale). */
export type RealEstateInspectionPatchRequest = Partial<RealEstateInspectionRequest> & {
  performedAt?: IsoDay | null;
  result?: RealEstateInspectionResult | null;
  defectsJson?: RealEstateInspectionDefectRequest[] | null;
  correctionDueAt?: IsoDay | null;
  correctedAt?: IsoDay | null;
  documentId?: string | null;
  status?: RealEstateInspectionStatus;
};

export type RealEstateInsuranceRequest = {
  kind: RealEstateInsuranceKind;
  insurerName: string;
  policyNumber: string;
  brokerName?: string | null;
  policyholder?: RealEstatePolicyholder;
  insuredSum?: MoneyInput | null;
  deductible?: MoneyInput | null;
  premiumAnnual?: MoneyInput | null;
  validFrom: IsoDay;
  validUntil: IsoDay;
  autoRenew?: boolean;
  noticeDays?: number;
  mandatoryBasis?: string | null;
  documentId?: string | null;
  notes?: string | null;
};

export type RealEstateInsurancePatchRequest = Partial<RealEstateInsuranceRequest> & { status?: RealEstateInsuranceStatus };

/** Estados que admite `PATCH …/work` (`approved` lo pone el motor de capex; `cancelled` no es una obra). */
export type CapexWorkPatchStatus = Extract<CapexProjectStatus, "in_progress" | "completed">;

/** Datos de obra de un proyecto de inversión; pasar a `in_progress` con licencia exigida y sin documento → LICENCE_REQUIRED. */
export type CapexWorkPatchRequest = {
  realEstateAssetId?: string | null;
  workKind?: CapexWorkKind | null;
  licenceRequired?: boolean;
  licenceDocumentId?: string | null;
  licenceGrantedAt?: IsoDay | null;
  icioAmount?: MoneyInput | null;
  projectDocumentId?: string | null;
  completionDocumentId?: string | null;
  /** Prefijos de cuenta (21x / 23x por centro) de los que se lee la ejecución real. */
  executionAccountPrefixes?: string[] | null;
  status?: CapexWorkPatchStatus;
};

// ---------------------------------------------------------------------------
// Respuestas compuestas (los DTO planos viven en @hotelos/shared)
// ---------------------------------------------------------------------------

export type PropertyTaxWithReceipts = PropertyTaxRecord & { receipts: PropertyTaxReceiptRecord[] };

export type PropertyTaxReceiptListItem = PropertyTaxReceiptRecord & {
  tax: Pick<PropertyTaxRecord, "id" | "kind" | "taxpayer" | "authorityName" | "fiscalReference" | "accountCode" | "status">;
};

/** 201 con `created` no vacío; 200 cuando el ejercicio ya tenía todos los previstos. */
export type PropertyTaxReceiptsGenerated = {
  year: number;
  created: PropertyTaxReceiptRecord[];
  existing: number;
  receipts: PropertyTaxReceiptRecord[];
};

/** Periodo del calendario del ejercicio sin recibo generado todavía. */
export type PropertyTaxPendingPeriod = {
  taxId: string;
  kind: PropertyTaxKind;
  period: string;
  dueFrom: IsoDay;
  dueTo: IsoDay;
  amount: MoneyString | null;
};

export type PropertyTaxCalendar = { year: number; events: RealEstateCalendarEvent[]; pending: PropertyTaxPendingPeriod[] };

export type RealEstateWorksResponse = { projects: CapexWorkRecord[]; alerts: RealEstateAlert[] };

/** Alta del inmovilizado (21x) con el coste de la obra y el proyecto ya `capitalizedAt`. */
export type CapexCapitalizationResult = { project: CapexWorkRecord; fixedAsset: FixedAssetDto };

/** Qué exporta `GET …/real-estate/export?format=csv`: la vista de grupo o el calendario anual. */
export type RealEstateExportWhat = "overview" | "calendar";

export type RealEstateCalendarProperty = { propertyId: string; propertyCode: string | null; propertyName: string };
export type RealEstateCalendarMonth = { month: number; events: RealEstateCalendarEvent[] };

/** Calendario anual (calendar.service.ts): siempre 12 meses (1..12) con sus eventos en orden cronológico; `properties` = un centro o los visibles del grupo. */
export type RealEstateCalendarYear = {
  year: number;
  properties: RealEstateCalendarProperty[];
  months: RealEstateCalendarMonth[];
  totalEvents: number;
};

export type ProposedEntryLine = { accountCode: string; debit: number; credit: number; description?: string };

/** Respuesta de `POST /journal-entries/:id/post` (borrador contabilizado, forma heredada del motor: importes numéricos). */
export type ProposedEntryPosted = {
  id: string;
  organizationId: string;
  propertyId?: string;
  sourceType: string;
  sourceId?: string;
  status: RealEstateJournalEntryStatus;
  entryDate?: string;
  entryNumber?: number | null;
  fiscalYearCode?: string | null;
  description?: string | null;
  reference?: string | null;
  lines: ProposedEntryLine[];
};

// ---------------------------------------------------------------------------
// Filtros de listado
// ---------------------------------------------------------------------------

export type PropertyTaxListInput = { year?: number | string; kind?: PropertyTaxKind; status?: PropertyTaxStatus; receiptStatus?: PropertyTaxReceiptStatus };
export type RealEstateYearInput = { year?: number | string };
export type RealEstateDocumentListInput = { category?: RealEstateDocumentCategory; status?: RealEstateDocumentStatus; kind?: RealEstateDocumentKind };
export type RealEstateInspectionListInput = { status?: RealEstateInspectionStatus; kind?: RealEstateInspectionKind };
/** `inline=1` → content-disposition inline (visor); sin él, attachment. */
export type RealEstateDownloadOptions = { inline?: boolean };

export function propertyTaxListQuery(input: PropertyTaxListInput = {}): FinanceQuery {
  return compactQuery({ year: input.year, kind: input.kind, status: input.status, receiptStatus: input.receiptStatus });
}

export function realEstateYearQuery(input: RealEstateYearInput = {}): FinanceQuery {
  return compactQuery({ year: input.year });
}

export function realEstateDocumentListQuery(input: RealEstateDocumentListInput = {}): FinanceQuery {
  return compactQuery({ category: input.category, status: input.status, kind: input.kind });
}

export function realEstateInspectionListQuery(input: RealEstateInspectionListInput = {}): FinanceQuery {
  return compactQuery({ status: input.status, kind: input.kind });
}

// ---------------------------------------------------------------------------
// Rutas (para useApiData y para las funciones de abajo)
// ---------------------------------------------------------------------------

export function realEstatePath(propertyId = getActivePropertyId()): string {
  return `/properties/${enc(propertyId)}/real-estate`;
}

export const realEstateValuationsPath = (propertyId = getActivePropertyId()): string => `${realEstatePath(propertyId)}/valuations`;
export const realEstateTenuresPath = (propertyId = getActivePropertyId()): string => `${realEstatePath(propertyId)}/tenures`;
export const realEstateTaxesPath = (propertyId = getActivePropertyId()): string => `${realEstatePath(propertyId)}/taxes`;
export const realEstateReceiptsPath = (propertyId = getActivePropertyId()): string => `${realEstatePath(propertyId)}/receipts`;
export const realEstateTaxCalendarPath = (propertyId = getActivePropertyId()): string => `${realEstatePath(propertyId)}/tax-calendar`;
export const realEstateDocumentsPath = (propertyId = getActivePropertyId()): string => `${realEstatePath(propertyId)}/documents`;
export const realEstateWorksPath = (propertyId = getActivePropertyId()): string => `${realEstatePath(propertyId)}/works`;
export const realEstateInspectionsPath = (propertyId = getActivePropertyId()): string => `${realEstatePath(propertyId)}/inspections`;
export const realEstateInsurancesPath = (propertyId = getActivePropertyId()): string => `${realEstatePath(propertyId)}/insurances`;
export const realEstateAlertsPath = (propertyId = getActivePropertyId()): string => `${realEstatePath(propertyId)}/alerts`;
export const realEstateCalendarPath = (propertyId = getActivePropertyId()): string => `${realEstatePath(propertyId)}/calendar`;

export function realEstateGroupPath(organizationId = getActiveOrganizationId()): string {
  return `/organizations/${enc(organizationId)}/real-estate`;
}

export const realEstateGroupOverviewPath = (organizationId = getActiveOrganizationId()): string => `${realEstateGroupPath(organizationId)}/overview`;
export const realEstateGroupCalendarPath = (organizationId = getActiveOrganizationId()): string => `${realEstateGroupPath(organizationId)}/calendar`;

// ---------------------------------------------------------------------------
// Ficha, unidades, cargas, valoraciones y tenencia (core.routes.ts · ACT-L1)
// ---------------------------------------------------------------------------

/** 404 ASSET_NOT_FOUND mientras el centro no tenga ficha (la pantalla enseña el estado vacío con el alta). */
export function getRealEstateAsset(propertyId = getActivePropertyId()): Promise<RealEstateAssetDetail> {
  return apiRequest<RealEstateAssetDetail>(realEstatePath(propertyId));
}

/** 201: nace con la unidad prellenada del censo del centro y la tenencia `propiedad` en borrador (ASSET_ALREADY_EXISTS si ya existe). */
export function createRealEstateAsset(body: RealEstateAssetRequest, propertyId = getActivePropertyId()): Promise<RealEstateAssetDetail> {
  return apiRequest<RealEstateAssetDetail>(realEstatePath(propertyId), { method: "POST", body });
}

export function updateRealEstateAsset(body: RealEstateAssetPatchRequest, propertyId = getActivePropertyId()): Promise<RealEstateAssetDetail> {
  return apiRequest<RealEstateAssetDetail>(realEstatePath(propertyId), { method: "PATCH", body });
}

/** 201 (INVALID_CADASTRAL_REFERENCE si la referencia no tiene 20 caracteres alfanuméricos). */
export function createRealEstateUnit(body: RealEstateUnitRequest, propertyId = getActivePropertyId()): Promise<RealEstateUnitWithCharges> {
  return apiRequest<RealEstateUnitWithCharges>(`${realEstatePath(propertyId)}/units`, { method: "POST", body });
}

export function updateRealEstateUnit(unitId: string, body: RealEstateUnitPatchRequest, propertyId = getActivePropertyId()): Promise<RealEstateUnitWithCharges> {
  return apiRequest<RealEstateUnitWithCharges>(`${realEstatePath(propertyId)}/units/${enc(unitId)}`, { method: "PATCH", body });
}

/** 201 (UNIT_NOT_FOUND si la unidad no es de este centro). */
export function createRealEstateCharge(unitId: string, body: RealEstateChargeRequest, propertyId = getActivePropertyId()): Promise<RealEstateChargeRecord> {
  return apiRequest<RealEstateChargeRecord>(`${realEstatePath(propertyId)}/units/${enc(unitId)}/charges`, { method: "POST", body });
}

export function updateRealEstateCharge(chargeId: string, body: RealEstateChargePatchRequest, propertyId = getActivePropertyId()): Promise<RealEstateChargeRecord> {
  return apiRequest<RealEstateChargeRecord>(`${realEstatePath(propertyId)}/charges/${enc(chargeId)}`, { method: "PATCH", body });
}

export function listRealEstateValuations(propertyId = getActivePropertyId()): Promise<RealEstateValuationRecord[]> {
  return apiRequest<RealEstateValuationRecord[]>(realEstateValuationsPath(propertyId));
}

/** 201; la más reciente por `valuedAt` actualiza la caché `lastValuation*` de la ficha y el valor por habitación. */
export function createRealEstateValuation(body: RealEstateValuationRequest, propertyId = getActivePropertyId()): Promise<RealEstateValuationRecord> {
  return apiRequest<RealEstateValuationRecord>(realEstateValuationsPath(propertyId), { method: "POST", body });
}

export function listRealEstateTenures(propertyId = getActivePropertyId()): Promise<RealEstateTenureRecord[]> {
  return apiRequest<RealEstateTenureRecord[]>(realEstateTenuresPath(propertyId));
}

/** 201; nace `borrador` (activar con `updateRealEstateTenure(id, { action: "activar" })`). */
export function createRealEstateTenure(body: RealEstateTenureRequest, propertyId = getActivePropertyId()): Promise<RealEstateTenureRecord> {
  return apiRequest<RealEstateTenureRecord>(realEstateTenuresPath(propertyId), { method: "POST", body });
}

/** Campos y/o `action`: TENURE_ALREADY_ACTIVE (segunda vigente) · TENURE_INVALID_TRANSITION (resuelta o vencida). */
export function updateRealEstateTenure(tenureId: string, body: RealEstateTenurePatchRequest, propertyId = getActivePropertyId()): Promise<RealEstateTenureRecord> {
  return apiRequest<RealEstateTenureRecord>(`${realEstateTenuresPath(propertyId)}/${enc(tenureId)}`, { method: "PATCH", body });
}

// ---------------------------------------------------------------------------
// Tributos locales y recibos (taxes.routes.ts · ACT-L2)
// ---------------------------------------------------------------------------

/** Cada tributo lleva sus recibos (`year` filtra los recibos incluidos). */
export function listPropertyTaxes(input: PropertyTaxListInput = {}, propertyId = getActivePropertyId()): Promise<PropertyTaxWithReceipts[]> {
  return apiRequest<PropertyTaxWithReceipts[]>(realEstateTaxesPath(propertyId), { query: propertyTaxListQuery(input) });
}

/** 201 (`accountCode` por defecto según `kind`; ICIO capitalizable). */
export function createPropertyTax(body: PropertyTaxRequest, propertyId = getActivePropertyId()): Promise<PropertyTaxWithReceipts> {
  return apiRequest<PropertyTaxWithReceipts>(realEstateTaxesPath(propertyId), { method: "POST", body });
}

export function updatePropertyTax(taxId: string, body: PropertyTaxPatchRequest, propertyId = getActivePropertyId()): Promise<PropertyTaxWithReceipts> {
  return apiRequest<PropertyTaxWithReceipts>(`${realEstateTaxesPath(propertyId)}/${enc(taxId)}`, { method: "PATCH", body });
}

/** 201 recibo manual (RECEIPT_ALREADY_EXISTS con el mismo ejercicio y periodo). */
export function createPropertyTaxReceipt(taxId: string, body: PropertyTaxReceiptRequest, propertyId = getActivePropertyId()): Promise<PropertyTaxReceiptRecord> {
  return apiRequest<PropertyTaxReceiptRecord>(`${realEstateTaxesPath(propertyId)}/${enc(taxId)}/receipts`, { method: "POST", body });
}

/** Genera los `previsto` del ejercicio con el calendario del municipio (PROPERTY_TAX_INACTIVE con el tributo de baja). */
export function generatePropertyTaxReceipts(taxId: string, year: number, propertyId = getActivePropertyId()): Promise<PropertyTaxReceiptsGenerated> {
  return apiRequest<PropertyTaxReceiptsGenerated>(`${realEstateTaxesPath(propertyId)}/${enc(taxId)}/receipts/generate`, { method: "POST", body: { year } });
}

/** Recibos del centro (todos los tributos) con el resumen de su tributo; `year` acota el ejercicio. */
export function listPropertyTaxReceipts(input: RealEstateYearInput = {}, propertyId = getActivePropertyId()): Promise<PropertyTaxReceiptListItem[]> {
  return apiRequest<PropertyTaxReceiptListItem[]>(realEstateReceiptsPath(propertyId), { query: realEstateYearQuery(input) });
}

/** recibido · domiciliado · pagado · recurrido, importes, pago y enlace manual del asiento (RECEIPT_NOT_PAYABLE · RECEIPT_ENTRY_EXISTS). */
export function updatePropertyTaxReceipt(receiptId: string, body: PropertyTaxReceiptPatchRequest, propertyId = getActivePropertyId()): Promise<PropertyTaxReceiptRecord> {
  return apiRequest<PropertyTaxReceiptRecord>(`${realEstateReceiptsPath(propertyId)}/${enc(receiptId)}`, { method: "PATCH", body });
}

/**
 * 201: propone el asiento 631 (o 23x si capitalizable) en BORRADOR y lo enlaza
 * (`journalEntryId`, `journalEntryStatus: "draft"`); nunca contabiliza. Lo
 * contabiliza el contable con `postProposedEntry`. TAXPAYER_NOT_ENTITY si el
 * sujeto pasivo no es la sociedad · RECEIPT_ENTRY_EXISTS si ya hay asiento ·
 * FISCAL_YEAR_CLOSED con el ejercicio cerrado (enlazar el asiento importado).
 */
export function proposeReceiptEntry(receiptId: string, propertyId = getActivePropertyId()): Promise<PropertyTaxReceiptRecord> {
  return apiRequest<PropertyTaxReceiptRecord>(`${realEstateReceiptsPath(propertyId)}/${enc(receiptId)}/propose-entry`, { method: "POST" });
}

/** Eventos TAX_DUE / TAX_OVERDUE del ejercicio y periodos del calendario municipal sin recibo generado. */
export function getPropertyTaxCalendar(input: RealEstateYearInput = {}, propertyId = getActivePropertyId()): Promise<PropertyTaxCalendar> {
  return apiRequest<PropertyTaxCalendar>(realEstateTaxCalendarPath(propertyId), { query: realEstateYearQuery(input) });
}

// ---------------------------------------------------------------------------
// Documentación con fichero (documents.routes.ts · ACT-L3)
// ---------------------------------------------------------------------------

/** Lista blanca MIME del almacén (magic-bytes.ts de T9): PDF, JPEG, PNG, TIFF y XML. */
export const REAL_ESTATE_DOCUMENT_ACCEPT = "application/pdf,image/jpeg,image/png,image/tiff,application/xml,text/xml";
/** Bytes máximos de un fichero (REAL_ESTATE_DOCUMENT_MAX_BYTES del API: 40 MiB; 413 DOCUMENT_TOO_LARGE por encima). */
export const REAL_ESTATE_DOCUMENT_MAX_BYTES = 40 * 1024 * 1024;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
  xml: "application/xml"
});

/** MIME declarado por el navegador o, si viene vacío, deducido de la extensión; `application/octet-stream` si no se sabe (el API lo rechaza con DOCUMENT_MIME_NOT_ALLOWED). */
export function mimeTypeOfFile(file: { name: string; type?: string | null }): string {
  const declared = (file.type ?? "").trim().toLowerCase();
  if (declared) return declared;
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/** Base64 estándar (alfabeto RFC 4648 §4, con relleno `=`) de un fichero, sin el prefijo `data:…;base64,` de FileReader. */
export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer el fichero."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      const base64 = comma >= 0 ? result.slice(comma + 1) : "";
      if (!base64) {
        reject(new Error("El fichero está vacío."));
        return;
      }
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

/** `{ fileName, mimeType, base64 }` de un File del navegador, tal como lo espera el API. */
export async function documentFileOf(file: File): Promise<RealEstateDocumentFile> {
  return { fileName: file.name, mimeType: mimeTypeOfFile(file), base64: await readFileAsBase64(file) };
}

/** `status` es la vigencia derivada (vigente · caduca_pronto · caducado · sin_fecha · sustituido); ASSET_NOT_FOUND sin ficha. */
export function listRealEstateDocuments(input: RealEstateDocumentListInput = {}, propertyId = getActivePropertyId()): Promise<RealEstateDocumentRecord[]> {
  return apiRequest<RealEstateDocumentRecord[]>(realEstateDocumentsPath(propertyId), { query: realEstateDocumentListQuery(input) });
}

/**
 * 201: metadatos + fichero (leído con FileReader → base64). Sin `file` se
 * registra solo la ficha («Sin fichero»). 413 DOCUMENT_TOO_LARGE · 400
 * DOCUMENT_MIME_NOT_ALLOWED / DOCUMENT_CONTENT_MISMATCH (magic bytes).
 */
export async function uploadRealEstateDocument(meta: RealEstateDocumentMeta, file?: File | null, propertyId = getActivePropertyId()): Promise<RealEstateDocumentRecord> {
  const body: RealEstateDocumentRequest = file ? { ...meta, file: await documentFileOf(file) } : { ...meta };
  return apiRequest<RealEstateDocumentRecord>(realEstateDocumentsPath(propertyId), { method: "POST", body });
}

/** 201 versión nueva (hereda los metadatos no enviados; DOCUMENT_SUPERSEDED si ya hay una posterior · LEGAL_HOLD). */
export async function uploadRealEstateDocumentVersion(documentId: string, file: File, meta: RealEstateDocumentVersionMeta = {}, propertyId = getActivePropertyId()): Promise<RealEstateDocumentRecord> {
  const body = { ...meta, file: await documentFileOf(file) };
  return apiRequest<RealEstateDocumentRecord>(`${realEstateDocumentsPath(propertyId)}/${enc(documentId)}/versions`, { method: "POST", body });
}

/** Solo metadatos (el fichero se cambia con una versión nueva); `legalHold` exige real_estate.manage. */
export function updateRealEstateDocument(documentId: string, body: RealEstateDocumentPatchRequest, propertyId = getActivePropertyId()): Promise<RealEstateDocumentRecord> {
  return apiRequest<RealEstateDocumentRecord>(`${realEstateDocumentsPath(propertyId)}/${enc(documentId)}`, { method: "PATCH", body });
}

/** Retirada lógica (200 con `deletedAt`); LEGAL_HOLD si está bloqueado. El fichero permanece en el almacén. */
export function retireRealEstateDocument(documentId: string, propertyId = getActivePropertyId()): Promise<RealEstateDocumentRecord> {
  return apiRequest<RealEstateDocumentRecord>(`${realEstateDocumentsPath(propertyId)}/${enc(documentId)}`, { method: "DELETE" });
}

/** Bytes del documento (visor con `inline`, descarga sin él); DOCUMENT_NO_FILE si la ficha no tiene fichero. Auditado por el API. */
export function downloadRealEstateDocument(documentId: string, options: RealEstateDownloadOptions = {}, propertyId = getActivePropertyId()): Promise<BlobResponse> {
  return apiRequestBlob(`${realEstateDocumentsPath(propertyId)}/${enc(documentId)}/file`, { query: compactQuery({ inline: options.inline }) });
}

// ---------------------------------------------------------------------------
// Obras (works.routes.ts · ACT-L4)
// ---------------------------------------------------------------------------

/** Proyectos de inversión del centro con su ejecución (diario 21x/23x o partidas) y las alertas CAPEX_LICENCE_MISSING. */
export function listRealEstateWorks(propertyId = getActivePropertyId()): Promise<RealEstateWorksResponse> {
  return apiRequest<RealEstateWorksResponse>(realEstateWorksPath(propertyId));
}

/** Transaccional: si el paso a `in_progress` cae por LICENCE_REQUIRED no se escribe nada; `completed` es final. */
export function updateCapexWork(capexProjectId: string, body: CapexWorkPatchRequest): Promise<CapexWorkRecord> {
  return apiRequest<CapexWorkRecord>(`/capex-projects/${enc(capexProjectId)}/work`, { method: "PATCH", body });
}

/** 201: alta del inmovilizado con el coste ejecutado (+ ICIO). CAPEX_NOT_COMPLETED · CAPEX_ALREADY_CAPITALIZED · CAPEX_NOT_LINKED. Crítico. */
/** `POST /capex-projects/:id/capitalize`; `acquisitionDate` opcional = fin de obra (por defecto `targetEndDate` ya pasado, si no hoy). */
export function capitalizeCapexProject(capexProjectId: string, body?: { acquisitionDate?: string }): Promise<CapexCapitalizationResult> {
  return apiRequest<CapexCapitalizationResult>(`/capex-projects/${enc(capexProjectId)}/capitalize`, body ? { method: "POST", body } : { method: "POST" });
}

// ---------------------------------------------------------------------------
// Inspecciones obligatorias, pólizas y alertas (inspections.routes.ts · ACT-L5)
// ---------------------------------------------------------------------------

/** `dueState` derivado (sin_fecha · en_plazo · proxima · vencida). */
export function listRealEstateInspections(input: RealEstateInspectionListInput = {}, propertyId = getActivePropertyId()): Promise<RealEstateInspectionRecord[]> {
  return apiRequest<RealEstateInspectionRecord[]>(realEstateInspectionsPath(propertyId), { query: realEstateInspectionListQuery(input) });
}

/** 201; nace `programada` con la base legal y la periodicidad por defecto del catálogo del tipo. */
export function createRealEstateInspection(body: RealEstateInspectionRequest, propertyId = getActivePropertyId()): Promise<RealEstateInspectionRecord> {
  return apiRequest<RealEstateInspectionRecord>(realEstateInspectionsPath(propertyId), { method: "POST", body });
}

/** Acta, defectos, subsanación o cierre (INSPECTION_INVALID_TRANSITION con `details.allowed`); cerrar programa la sucesora. */
export function updateRealEstateInspection(inspectionId: string, body: RealEstateInspectionPatchRequest, propertyId = getActivePropertyId()): Promise<RealEstateInspectionRecord> {
  return apiRequest<RealEstateInspectionRecord>(`${realEstateInspectionsPath(propertyId)}/${enc(inspectionId)}`, { method: "PATCH", body });
}

/** `status` derivado: `vigente` pasa a `vencida` al superar `validUntil`; el «vence pronto» llega como alerta INSURANCE_EXPIRING. */
export function listRealEstateInsurances(propertyId = getActivePropertyId()): Promise<RealEstateInsuranceRecord[]> {
  return apiRequest<RealEstateInsuranceRecord[]>(realEstateInsurancesPath(propertyId));
}

export function createRealEstateInsurance(body: RealEstateInsuranceRequest, propertyId = getActivePropertyId()): Promise<RealEstateInsuranceRecord> {
  return apiRequest<RealEstateInsuranceRecord>(realEstateInsurancesPath(propertyId), { method: "POST", body });
}

export function updateRealEstateInsurance(insuranceId: string, body: RealEstateInsurancePatchRequest, propertyId = getActivePropertyId()): Promise<RealEstateInsuranceRecord> {
  return apiRequest<RealEstateInsuranceRecord>(`${realEstateInsurancesPath(propertyId)}/${enc(insuranceId)}`, { method: "PATCH", body });
}

/** Todas las alertas abiertas del centro (documentos, inspecciones, pólizas, tenencia, recibos, obras), ordenadas por gravedad y fecha. */
export function listRealEstateAlerts(propertyId = getActivePropertyId()): Promise<RealEstateAlert[]> {
  return apiRequest<RealEstateAlert[]>(realEstateAlertsPath(propertyId));
}

// ---------------------------------------------------------------------------
// Calendario anual del centro (group.routes.ts · ACT-L6)
// ---------------------------------------------------------------------------

/** 12 meses del centro con vencimientos de documentos, inspecciones, pólizas, tenencia y tributos (`year` por defecto el actual); ASSET_NOT_FOUND sin ficha. */
export function getRealEstateCalendar(input: RealEstateYearInput = {}, propertyId = getActivePropertyId()): Promise<RealEstateCalendarYear> {
  return apiRequest<RealEstateCalendarYear>(realEstateCalendarPath(propertyId), { query: realEstateYearQuery(input) });
}

// ---------------------------------------------------------------------------
// Vista de grupo (group.routes.ts · ACT-L6): filas por centro dentro del ámbito
// ---------------------------------------------------------------------------

export function getRealEstateGroupOverview(organizationId = getActiveOrganizationId()): Promise<RealEstateGroupOverview> {
  return apiRequest<RealEstateGroupOverview>(realEstateGroupOverviewPath(organizationId));
}

/** Calendario anual consolidado (12 meses) de los centros visibles del ámbito (`year` por defecto el actual en el API). */
export function getRealEstateGroupCalendar(input: RealEstateYearInput = {}, organizationId = getActiveOrganizationId()): Promise<RealEstateCalendarYear> {
  return apiRequest<RealEstateCalendarYear>(realEstateGroupCalendarPath(organizationId), { query: realEstateYearQuery(input) });
}

/** `text/csv` («activo-inmobiliario-<what>-<año>.csv») de la vista de grupo o del calendario; `year` por defecto el actual. */
export function exportRealEstateCsv(what: RealEstateExportWhat, year?: number | string, organizationId = getActiveOrganizationId()): Promise<BlobResponse> {
  return apiRequestBlob(`${realEstateGroupPath(organizationId)}/export`, { query: compactQuery({ format: "csv", what, year }) });
}

// ---------------------------------------------------------------------------
// Asiento propuesto → contabilizado (server.ts · POST /journal-entries/:id/post)
// ---------------------------------------------------------------------------

/** Contabiliza el borrador propuesto para un recibo (`journalEntryStatus` pasa a `posted`). accounting.journal.post + ai.high_risk.confirm; crítico. */
export function postProposedEntry(journalEntryId: string): Promise<ProposedEntryPosted> {
  return apiRequest<ProposedEntryPosted>(`/journal-entries/${enc(journalEntryId)}/post`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export const REAL_ESTATE_API_ERROR_FALLBACK = "No se pudo completar la operación del activo inmobiliario. Inténtalo de nuevo.";

/**
 * Frase de los códigos comunes de finanzas (VALIDATION_ERROR, FISCAL_PERIOD_CLOSED,
 * RBAC…) o el mensaje del API. Los códigos propios del módulo
 * (REAL_ESTATE_ERROR_CODES) los traduce screens/realEstate/real-estate-helpers.ts ·
 * realEstateErrorMessage, que consulta su mapa y cae aquí.
 */
export function realEstateApiErrorMessage(error: unknown, fallback = REAL_ESTATE_API_ERROR_FALLBACK): string {
  return financeErrorMessage(error, fallback);
}
