/**
 * Gestión del activo inmobiliario (Tanda ACT · L0a, 2026-09-20): contrato wire
 * entre el API (`apps/api/src/modules/real-estate/*`) y el admin-web (Finanzas ›
 * Activo inmobiliario: Ficha, Documentación, Tributos, Obras, Inspecciones,
 * Contratos, Grupo). Diseño: docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md §4
 * (modelo), §5 (flujos y alertas), §7 (API y errores).
 *
 * Qué es. Un `RealEstateAsset` es la ficha del inmueble de un centro (una por
 * `Property`): sus unidades registrales / catastrales con sus cargas, las
 * valoraciones, la tenencia (propiedad, arrendamiento, gestión, franquicia…),
 * los tributos locales (IBI, IAE, tasas) con sus recibos, la documentación con
 * vigencia, las inspecciones obligatorias, las pólizas y las obras (CapexProject
 * ampliado). No confundir con `Asset` (técnico), `FixedAsset` (contable) ni con
 * la pantalla «Impuestos» de cumplimiento (IVA / tasa turística).
 *
 * Convenciones:
 *   · Dinero como `MoneyString` de payables-types ("1060.00", dos decimales,
 *     punto): nunca float. Porcentajes como cadena decimal (`PercentString`).
 *   · Días (`@db.Date`) como `IsoDay` ("YYYY-MM-DD"); instantes (`createdAt`,
 *     `updatedAt`, `deletedAt`) como ISO-8601.
 *   · Los catálogos `as const` de este fichero son la única fuente de los
 *     valores de las columnas `String` del schema (sin enums Prisma nuevos:
 *     `tests/finanzas-schema-contract.test.mjs` pina los enums existentes) y de
 *     los esquemas zod `.strict()` del API (`apps/api/src/schemas/real-estate.schemas.ts`).
 *   · Estados DERIVADOS (nunca persistidos): `RealEstateDocumentRecord.status`,
 *     `PropertyTaxReceiptRecord.overdue` (el «vencido» del diseño),
 *     `RealEstateInspectionRecord.dueState`.
 *   · Los bytes nunca viajan en los DTO de lectura: `RealEstateDocumentRecord`
 *     lleva `hasFile`, no `inline` ni `storageKey`; la descarga es binaria.
 *   · Todo 4xx tipado lleva `details.code` ∈ `REAL_ESTATE_ERROR_CODES` y un
 *     mensaje en español.
 *   · Sin dependencias de runtime.
 */
import type { ExpensePaidWith, IsoDay, MoneyString } from "./payables-types.js";

/** Porcentaje como cadena decimal ("21.00", "0.4"); nunca float. */
export type PercentString = string;

// ---------------------------------------------------------------------------
// Catálogos (= columnas String del schema y esquemas zod)
// ---------------------------------------------------------------------------

/** `RealEstateAsset.status`. */
export const REAL_ESTATE_ASSET_STATUSES = ["active", "sold", "closed"] as const;
export type RealEstateAssetStatus = (typeof REAL_ESTATE_ASSET_STATUSES)[number];

/** `RealEstateAsset.protectionLevel` (espejo de `CompliancePropertyProfile.buildingProtected`). */
export const REAL_ESTATE_PROTECTION_LEVELS = ["none", "catalogado", "bic"] as const;
export type RealEstateProtectionLevel = (typeof REAL_ESTATE_PROTECTION_LEVELS)[number];

/** `RealEstateAsset.energyRating` (CEE, RD 390/2021). */
export const REAL_ESTATE_ENERGY_RATINGS = ["A", "B", "C", "D", "E", "F", "G"] as const;
export type RealEstateEnergyRating = (typeof REAL_ESTATE_ENERGY_RATINGS)[number];

/** `RealEstateTenure.kind` (diseño §4). */
export const REAL_ESTATE_TENURE_KINDS = ["propiedad", "arrendamiento_local", "arrendamiento_industria", "gestion", "franquicia", "usufructo", "concesion"] as const;
export type RealEstateTenureKind = (typeof REAL_ESTATE_TENURE_KINDS)[number];

/** `RealEstateTenure.status` (máquina TENURE de state-machines.ts). */
export const REAL_ESTATE_TENURE_STATUSES = ["borrador", "vigente", "vencido", "resuelto"] as const;
export type RealEstateTenureStatus = (typeof REAL_ESTATE_TENURE_STATUSES)[number];

/** `RealEstateTenure.renewal`. */
export const REAL_ESTATE_TENURE_RENEWALS = ["tacita", "expresa", "ninguna"] as const;
export type RealEstateTenureRenewal = (typeof REAL_ESTATE_TENURE_RENEWALS)[number];

/** `RealEstateTenure.rentKind`. */
export const REAL_ESTATE_RENT_KINDS = ["fija", "variable", "mixta", "minimo_garantizado"] as const;
export type RealEstateRentKind = (typeof REAL_ESTATE_RENT_KINDS)[number];

/** `RealEstateTenure.rentVariableBase` (USALI: ingresos brutos / GOP). */
export const REAL_ESTATE_RENT_VARIABLE_BASES = ["gor", "gop"] as const;
export type RealEstateRentVariableBase = (typeof REAL_ESTATE_RENT_VARIABLE_BASES)[number];

/** `RealEstateTenure.rentReviewIndex`. */
export const REAL_ESTATE_RENT_REVIEW_INDEXES = ["ipc", "pct_fijo", "ninguno"] as const;
export type RealEstateRentReviewIndex = (typeof REAL_ESTATE_RENT_REVIEW_INDEXES)[number];

/** `RealEstateTenure.ibiPayer` / `insurancePayer`. */
export const REAL_ESTATE_COST_PAYERS = ["propietario", "arrendatario"] as const;
export type RealEstateCostPayer = (typeof REAL_ESTATE_COST_PAYERS)[number];

/** `RealEstateTenure.capexResponsibility`. */
export const REAL_ESTATE_CAPEX_RESPONSIBILITIES = ["propietario", "arrendatario", "compartido"] as const;
export type RealEstateCapexResponsibility = (typeof REAL_ESTATE_CAPEX_RESPONSIBILITIES)[number];

/** `RealEstateUnit.kind`. */
export const REAL_ESTATE_UNIT_KINDS = ["finca_registral", "referencia_catastral", "local"] as const;
export type RealEstateUnitKind = (typeof REAL_ESTATE_UNIT_KINDS)[number];

/** `RealEstateUnit.useCode` (uso catastral). */
export const REAL_ESTATE_USE_CODES = ["hotelero", "oficina", "aparcamiento", "local"] as const;
export type RealEstateUseCode = (typeof REAL_ESTATE_USE_CODES)[number];

/** `RealEstateUnit.titleKind` (orden de prelación del art. 61 TRLHL). */
export const REAL_ESTATE_TITLE_KINDS = ["pleno_dominio", "usufructo", "superficie", "concesion", "arrendamiento"] as const;
export type RealEstateTitleKind = (typeof REAL_ESTATE_TITLE_KINDS)[number];

/** `RealEstateCharge.kind`. */
export const REAL_ESTATE_CHARGE_KINDS = ["hipoteca", "embargo", "servidumbre", "afeccion_fiscal", "opcion", "arrendamiento_inscrito", "otra"] as const;
export type RealEstateChargeKind = (typeof REAL_ESTATE_CHARGE_KINDS)[number];

/** `RealEstateValuation.kind`. */
export const REAL_ESTATE_VALUATION_KINDS = ["eco_805", "rics", "interna", "notificacion_catastral", "seguro"] as const;
export type RealEstateValuationKind = (typeof REAL_ESTATE_VALUATION_KINDS)[number];

/** `RealEstateValuation.purpose`. */
export const REAL_ESTATE_VALUATION_PURPOSES = ["hipotecaria", "contable", "venta", "seguro", "ibi"] as const;
export type RealEstateValuationPurpose = (typeof REAL_ESTATE_VALUATION_PURPOSES)[number];

/** `PropertyTax.kind` (tributos locales; `icio` capitalizable; `plusvalia` = IIVTNU). */
export const PROPERTY_TAX_KINDS = ["ibi", "iae", "residuos", "vados", "terrazas", "ocupacion_via_publica", "icio", "plusvalia", "otro_local"] as const;
export type PropertyTaxKind = (typeof PROPERTY_TAX_KINDS)[number];

/** `PropertyTax.taxpayer`: el asiento 631 solo se propone con `sociedad`. */
export const PROPERTY_TAX_TAXPAYERS = ["sociedad", "propietario_tercero", "arrendatario"] as const;
export type PropertyTaxTaxpayer = (typeof PROPERTY_TAX_TAXPAYERS)[number];

/** `PropertyTax.periodicity`. */
export const PROPERTY_TAX_PERIODICITIES = ["anual", "semestral", "trimestral", "mensual", "unico"] as const;
export type PropertyTaxPeriodicity = (typeof PROPERTY_TAX_PERIODICITIES)[number];

/** `PropertyTax.status`. */
export const PROPERTY_TAX_STATUSES = ["activo", "baja"] as const;
export type PropertyTaxStatus = (typeof PROPERTY_TAX_STATUSES)[number];

/** `PropertyTaxReceipt.status` persistido (máquina RECEIPT). «vencido» es derivado: `PropertyTaxReceiptRecord.overdue`. */
export const PROPERTY_TAX_RECEIPT_STATUSES = ["previsto", "recibido", "domiciliado", "pagado", "recurrido"] as const;
export type PropertyTaxReceiptStatus = (typeof PROPERTY_TAX_RECEIPT_STATUSES)[number];

/** `PropertyTaxReceipt.paidWith` (= `ExpensePaidWith`: cash → 570, card → 5721, bank → 572). */
export const PROPERTY_TAX_PAID_WITH = ["cash", "card", "bank"] as const satisfies readonly ExpensePaidWith[];
export type PropertyTaxPaidWith = (typeof PROPERTY_TAX_PAID_WITH)[number];

/** Estado del asiento enlazado a un recibo (`JournalEntry.status`). */
export const REAL_ESTATE_JOURNAL_ENTRY_STATUSES = ["draft", "posted", "reversed"] as const;
export type RealEstateJournalEntryStatus = (typeof REAL_ESTATE_JOURNAL_ENTRY_STATUSES)[number];

/** `RealEstateDocument.category`. */
export const REAL_ESTATE_DOCUMENT_CATEGORIES = ["legal", "planos", "proyectos", "licencias", "seguros", "inspecciones", "contratos", "tributos", "valoraciones", "otros"] as const;
export type RealEstateDocumentCategory = (typeof REAL_ESTATE_DOCUMENT_CATEGORIES)[number];

/** `RealEstateDocument.kind`. */
export const REAL_ESTATE_DOCUMENT_KINDS = [
  "escritura",
  "nota_simple",
  "certificacion_catastral",
  "plano_planta",
  "plano_instalaciones",
  "as_built",
  "proyecto",
  "libro_edificio",
  "licencia_actividad",
  "licencia_obras",
  "primera_ocupacion",
  "registro_turistico",
  "cee",
  "acta_oca",
  "acta_inspeccion",
  "plan_autoproteccion",
  "ppcl_legionella",
  "poliza",
  "recibo_poliza",
  "contrato_arrendamiento",
  "contrato_gestion",
  "contrato_mantenimiento",
  "recibo_tributo",
  "tasacion",
  "iee_ite",
  "otro"
] as const;
export type RealEstateDocumentKind = (typeof REAL_ESTATE_DOCUMENT_KINDS)[number];

/** Vigencia DERIVADA del documento (vigencias.ts `deriveDocumentStatus`); nunca se persiste. */
export const REAL_ESTATE_DOCUMENT_STATUSES = ["vigente", "caduca_pronto", "caducado", "sin_fecha", "sustituido"] as const;
export type RealEstateDocumentStatus = (typeof REAL_ESTATE_DOCUMENT_STATUSES)[number];

/** `RealEstateDocument.cdeState` (ISO 19650). */
export const REAL_ESTATE_CDE_STATES = ["wip", "compartido", "publicado", "archivado"] as const;
export type RealEstateCdeState = (typeof REAL_ESTATE_CDE_STATES)[number];

/** `RealEstateDocument.confidentiality`. */
export const REAL_ESTATE_CONFIDENTIALITIES = ["interno", "solo_propiedad"] as const;
export type RealEstateConfidentiality = (typeof REAL_ESTATE_CONFIDENTIALITIES)[number];

/** `RealEstateDocument.linkedEntityType`. */
export const REAL_ESTATE_LINKED_ENTITY_TYPES = ["unit", "tenure", "tax_receipt", "inspection", "insurance", "capex_project", "fixed_asset"] as const;
export type RealEstateLinkedEntityType = (typeof REAL_ESTATE_LINKED_ENTITY_TYPES)[number];

/** `RealEstateInspection.kind` (catálogo del diseño §4.1). */
export const REAL_ESTATE_INSPECTION_KINDS = ["oca_bt", "oca_ascensor", "oca_pci", "rite", "gas", "equipos_presion", "legionella", "piscina", "iee_ite", "cee", "simulacro", "otra"] as const;
export type RealEstateInspectionKind = (typeof REAL_ESTATE_INSPECTION_KINDS)[number];

/** `RealEstateInspection.result`. */
export const REAL_ESTATE_INSPECTION_RESULTS = ["favorable", "condicionada", "negativa", "pendiente"] as const;
export type RealEstateInspectionResult = (typeof REAL_ESTATE_INSPECTION_RESULTS)[number];

/** `RealEstateInspection.status` (máquina INSPECTION). */
export const REAL_ESTATE_INSPECTION_STATUSES = ["programada", "realizada", "con_defectos", "cerrada"] as const;
export type RealEstateInspectionStatus = (typeof REAL_ESTATE_INSPECTION_STATUSES)[number];

/** Plazo DERIVADO de la inspección (vigencias.ts `inspectionDueState`). */
export const REAL_ESTATE_INSPECTION_DUE_STATES = ["sin_fecha", "en_plazo", "proxima", "vencida"] as const;
export type RealEstateInspectionDueState = (typeof REAL_ESTATE_INSPECTION_DUE_STATES)[number];

/** Gravedad de un defecto de inspección (`defectsJson[].severity`). */
export const REAL_ESTATE_DEFECT_SEVERITIES = ["leve", "grave", "muy_grave"] as const;
export type RealEstateDefectSeverity = (typeof REAL_ESTATE_DEFECT_SEVERITIES)[number];

/** `RealEstateInsurance.kind`. */
export const REAL_ESTATE_INSURANCE_KINDS = ["rc", "multirriesgo", "perdida_beneficios", "decenal", "todo_riesgo_construccion", "otro"] as const;
export type RealEstateInsuranceKind = (typeof REAL_ESTATE_INSURANCE_KINDS)[number];

/** `RealEstateInsurance.policyholder`. */
export const REAL_ESTATE_POLICYHOLDERS = ["sociedad", "propietario_tercero"] as const;
export type RealEstatePolicyholder = (typeof REAL_ESTATE_POLICYHOLDERS)[number];

/** `RealEstateInsurance.status` (`vencida` es DERIVADO: validUntil < hoy; nunca se persiste ni se envía). */
export const REAL_ESTATE_INSURANCE_STATUSES = ["vigente", "vencida", "cancelada"] as const;
export type RealEstateInsuranceStatus = (typeof REAL_ESTATE_INSURANCE_STATUSES)[number];
/** Estados que admite `PATCH …/insurances/:insuranceId` (ACT-REV-17: `vencida` fuera del contrato; renovar = ampliar validUntil). */
export const REAL_ESTATE_INSURANCE_PATCH_STATUSES = ["vigente", "cancelada"] as const;
export type RealEstateInsurancePatchStatus = (typeof REAL_ESTATE_INSURANCE_PATCH_STATUSES)[number];

/** `CapexProject.workKind`. */
export const CAPEX_WORK_KINDS = ["reforma", "ampliacion", "mantenimiento_mayor", "pip", "eficiencia_energetica", "accesibilidad"] as const;
export type CapexWorkKind = (typeof CAPEX_WORK_KINDS)[number];

/** `CapexProject.status` (existente; máquina CAPEX_WORK). */
export const CAPEX_PROJECT_STATUSES = ["proposed", "approved", "in_progress", "completed", "cancelled"] as const;
export type CapexProjectStatus = (typeof CAPEX_PROJECT_STATUSES)[number];

/** De dónde sale la ejecución de una obra: diario real (cuentas 21x/23x por centro) o partidas del proyecto. */
export const CAPEX_EXECUTION_SOURCES = ["ledger", "items"] as const;
export type CapexExecutionSource = (typeof CAPEX_EXECUTION_SOURCES)[number];

// ---------------------------------------------------------------------------
// Alertas y calendario (diseño §5)
// ---------------------------------------------------------------------------

export const REAL_ESTATE_ALERT_KINDS = [
  "DOCUMENT_EXPIRED",
  "DOCUMENT_EXPIRING",
  "INSPECTION_DUE",
  "INSPECTION_OVERDUE",
  "INSPECTION_NEGATIVE_OPEN",
  "INSURANCE_EXPIRING",
  "TENURE_NOTICE",
  "RENT_REVIEW",
  "TAX_DUE",
  "TAX_OVERDUE",
  "CAPEX_LICENCE_MISSING"
] as const;
export type RealEstateAlertKind = (typeof REAL_ESTATE_ALERT_KINDS)[number];

export const REAL_ESTATE_ALERT_SEVERITIES = ["alta", "media", "baja"] as const;
export type RealEstateAlertSeverity = (typeof REAL_ESTATE_ALERT_SEVERITIES)[number];

/** Umbrales de aviso en días (baja ≤ 90 · media ≤ 30 · alta ≤ 7 o vencido). */
export const REAL_ESTATE_ALERT_THRESHOLD_DAYS = [90, 30, 7] as const;

/** Entidad a la que enlaza una alerta o un evento de calendario. */
export const REAL_ESTATE_ALERT_ENTITY_TYPES = ["real_estate_document", "real_estate_inspection", "real_estate_insurance", "real_estate_tenure", "property_tax_receipt", "property_tax", "capex_project"] as const;
export type RealEstateAlertEntityType = (typeof REAL_ESTATE_ALERT_ENTITY_TYPES)[number];

export type RealEstateAlert = {
  kind: RealEstateAlertKind;
  severity: RealEstateAlertSeverity;
  /** Fecha de referencia (vencimiento, plazo, preaviso). */
  dueAt: IsoDay;
  entityType: RealEstateAlertEntityType;
  entityId: string;
  propertyId: string;
  /** Mensaje en español, listo para mostrar; sin datos personales. */
  message: string;
};

/** Evento del calendario anual del activo (diseño §5 «Calendario anual»). */
export type RealEstateCalendarEvent = {
  kind: RealEstateAlertKind;
  dueAt: IsoDay;
  entityType: RealEstateAlertEntityType;
  entityId: string;
  propertyId: string;
  label: string;
};

// ---------------------------------------------------------------------------
// Códigos de error (errors.ts · `details.code`)
// ---------------------------------------------------------------------------

export const REAL_ESTATE_ERROR_CODES = [
  "ASSET_ALREADY_EXISTS",
  "ASSET_NOT_FOUND",
  "INVALID_CADASTRAL_REFERENCE",
  "UNIT_NOT_FOUND",
  "TENURE_ALREADY_ACTIVE",
  "TENURE_INVALID_TRANSITION",
  "RECEIPT_NOT_PAYABLE",
  "RECEIPT_ENTRY_EXISTS",
  "RECEIPT_ALREADY_EXISTS",
  "TAXPAYER_NOT_ENTITY",
  "DOCUMENT_SUPERSEDED",
  "LEGAL_HOLD",
  "DOCUMENT_NO_FILE",
  "LICENCE_REQUIRED",
  "CAPEX_NOT_COMPLETED",
  "CAPEX_ALREADY_CAPITALIZED",
  "CAPEX_NOT_LINKED",
  "INSPECTION_INVALID_TRANSITION"
] as const;
export type RealEstateErrorCode = (typeof REAL_ESTATE_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// DTOs de lectura (fechas IsoDay, importes MoneyString, ids string)
// ---------------------------------------------------------------------------

export type RealEstateAssetRecord = {
  id: string;
  organizationId: string;
  legalEntityId: string | null;
  propertyId: string;
  name: string;
  yearBuilt: number | null;
  yearLastRefurbished: number | null;
  builtSurfaceM2: MoneyString | null;
  plotSurfaceM2: MoneyString | null;
  floorsAbove: number | null;
  floorsBelow: number | null;
  roomsCount: number | null;
  protectionLevel: RealEstateProtectionLevel;
  energyRating: RealEstateEnergyRating | null;
  energyCertValidUntil: IsoDay | null;
  cadastralValueTotal: MoneyString | null;
  cadastralValueYear: number | null;
  referenceValue: MoneyString | null;
  /** Caché de la última `RealEstateValuation`. */
  lastValuationValue: MoneyString | null;
  lastValuationAt: IsoDay | null;
  /** Caché del `kind` de la tenencia vigente. */
  currentTenureKind: RealEstateTenureKind | null;
  status: RealEstateAssetStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RealEstateChargeRecord = {
  id: string;
  unitId: string;
  kind: RealEstateChargeKind;
  holderName: string | null;
  holderTaxId: string | null;
  amount: MoneyString | null;
  outstandingAmount: MoneyString | null;
  registeredAt: IsoDay | null;
  expiresAt: IsoDay | null;
  cancelledAt: IsoDay | null;
  documentId: string | null;
  note: string | null;
  createdAt: string;
};

export type RealEstateUnitRecord = {
  id: string;
  organizationId: string;
  assetId: string;
  kind: RealEstateUnitKind;
  registryOffice: string | null;
  registryFincaNumber: string | null;
  registryTomo: string | null;
  registryLibro: string | null;
  registryFolio: string | null;
  /** CRU / IDUFIR. */
  cru: string | null;
  /** 20 caracteres [0-9A-Z] ya normalizados (cadastral.ts). */
  cadastralReference: string | null;
  useCode: RealEstateUseCode | null;
  surfaceM2: MoneyString | null;
  cadastralValueLand: MoneyString | null;
  cadastralValueBuilding: MoneyString | null;
  titleKind: RealEstateTitleKind;
  titleHolderTaxId: string | null;
  titleHolderName: string | null;
  titleDeedDate: IsoDay | null;
  notary: string | null;
  /** `FixedAsset.id` (210/211). */
  fixedAssetId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RealEstateUnitWithCharges = RealEstateUnitRecord & { charges: RealEstateChargeRecord[] };

export type RealEstateValuationRecord = {
  id: string;
  assetId: string;
  kind: RealEstateValuationKind;
  purpose: RealEstateValuationPurpose | null;
  valuedAt: IsoDay;
  value: MoneyString;
  valuePerRoom: MoneyString | null;
  capRatePct: PercentString | null;
  method: string | null;
  appraiser: string | null;
  documentId: string | null;
  createdAt: string;
};

export type RealEstateTenureRecord = {
  id: string;
  assetId: string;
  kind: RealEstateTenureKind;
  counterpartyName: string | null;
  counterpartyTaxId: string | null;
  counterpartyNonResident: boolean;
  startDate: IsoDay;
  endDate: IsoDay | null;
  noticeMonths: number | null;
  renewal: RealEstateTenureRenewal;
  rentKind: RealEstateRentKind | null;
  rentMonthly: MoneyString | null;
  rentVariablePct: PercentString | null;
  rentVariableBase: RealEstateRentVariableBase | null;
  rentReviewIndex: RealEstateRentReviewIndex | null;
  /** 1..12. */
  rentReviewMonth: number | null;
  depositAmount: MoneyString | null;
  vatApplies: boolean;
  withholdingApplies: boolean;
  withholdingRatePct: PercentString | null;
  ibiPayer: RealEstateCostPayer;
  insurancePayer: RealEstateCostPayer;
  capexResponsibility: RealEstateCapexResponsibility;
  ffeReservePct: PercentString | null;
  brandName: string | null;
  status: RealEstateTenureStatus;
  documentId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Plazo de un tributo fraccionado (`PropertyTax.installmentsJson[]`; `dueFrom`/`dueTo` en `MM-DD`). */
export type PropertyTaxInstallment = {
  label: string;
  dueFrom: string;
  dueTo: string;
  pct: PercentString;
};

export type PropertyTaxRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  assetId: string;
  unitId: string | null;
  kind: PropertyTaxKind;
  taxpayer: PropertyTaxTaxpayer;
  authorityName: string;
  ineMunicipalityCode: string | null;
  fiscalReference: string | null;
  taxBase: MoneyString | null;
  ratePct: PercentString | null;
  expectedAnnualAmount: MoneyString | null;
  periodicity: PropertyTaxPeriodicity;
  /** `MM-DD`. */
  voluntaryFrom: string | null;
  voluntaryTo: string | null;
  directDebit: boolean;
  directDebitBonusPct: PercentString | null;
  installmentsJson: PropertyTaxInstallment[] | null;
  accountCode: string;
  capitalizable: boolean;
  legalBasis: string | null;
  status: PropertyTaxStatus;
  createdAt: string;
  updatedAt: string;
};

export type PropertyTaxReceiptRecord = {
  id: string;
  taxId: string;
  fiscalYear: number;
  /** `anual` · `1/2` · `PAC-03`… */
  period: string;
  issuedAt: IsoDay | null;
  dueFrom: IsoDay | null;
  dueTo: IsoDay | null;
  amount: MoneyString;
  surchargeAmount: MoneyString;
  status: PropertyTaxReceiptStatus;
  paidAt: IsoDay | null;
  paidWith: PropertyTaxPaidWith | null;
  journalEntryId: string | null;
  journalEntryStatus: RealEstateJournalEntryStatus | null;
  capexProjectId: string | null;
  documentId: string | null;
  appealRef: string | null;
  notes: string | null;
  /** Derivado: sin pagar y `dueTo` anterior a hoy (el «vencido» del diseño). */
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RealEstateDocumentRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  assetId: string;
  category: RealEstateDocumentCategory;
  kind: RealEstateDocumentKind;
  title: string;
  issuerName: string | null;
  issueDate: IsoDay | null;
  validFrom: IsoDay | null;
  validUntil: IsoDay | null;
  renewalDays: number | null;
  version: number;
  supersedesId: string | null;
  supersededById: string | null;
  /** Derivado (vigencias.ts): vigente · caduca_pronto · caducado · sin_fecha · sustituido. */
  status: RealEstateDocumentStatus;
  cdeState: RealEstateCdeState;
  confidentiality: RealEstateConfidentiality;
  linkedEntityType: RealEstateLinkedEntityType | null;
  linkedEntityId: string | null;
  complianceRequirementCode: string | null;
  /** Hay bytes en el almacén (descarga por `GET …/documents/:id/file`). */
  hasFile: boolean;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  uploadedBy: string | null;
  retentionUntil: IsoDay | null;
  legalHold: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Defecto de un acta (`RealEstateInspection.defectsJson[]`). */
export type RealEstateInspectionDefect = {
  severity: RealEstateDefectSeverity;
  text: string;
  dueAt: IsoDay | null;
  fixedAt: IsoDay | null;
};

export type RealEstateInspectionRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  assetId: string;
  kind: RealEstateInspectionKind;
  legalBasis: string | null;
  periodicityMonths: number | null;
  installationRef: string | null;
  technicalAssetId: string | null;
  providerName: string | null;
  supplierId: string | null;
  scheduledAt: IsoDay | null;
  performedAt: IsoDay | null;
  result: RealEstateInspectionResult | null;
  defectsJson: RealEstateInspectionDefect[] | null;
  correctionDueAt: IsoDay | null;
  correctedAt: IsoDay | null;
  nextDueAt: IsoDay | null;
  documentId: string | null;
  complianceRequirementCode: string | null;
  status: RealEstateInspectionStatus;
  /** Derivado (vigencias.ts `inspectionDueState`). */
  dueState: RealEstateInspectionDueState;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RealEstateInsuranceRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  assetId: string;
  kind: RealEstateInsuranceKind;
  insurerName: string;
  policyNumber: string;
  brokerName: string | null;
  policyholder: RealEstatePolicyholder;
  insuredSum: MoneyString | null;
  deductible: MoneyString | null;
  premiumAnnual: MoneyString | null;
  validFrom: IsoDay;
  validUntil: IsoDay;
  autoRenew: boolean;
  noticeDays: number;
  mandatoryBasis: string | null;
  documentId: string | null;
  status: RealEstateInsuranceStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

/** `CapexProject` + las 12 columnas de obra (ACT-L0b) + ejecución calculada. */
export type CapexWorkRecord = {
  id: string;
  propertyId: string;
  name: string;
  description: string | null;
  budget: MoneyString;
  status: CapexProjectStatus;
  startDate: IsoDay | null;
  targetEndDate: IsoDay | null;
  ownerApprovedBy: string | null;
  createdByUserId: string | null;
  realEstateAssetId: string | null;
  workKind: CapexWorkKind | null;
  licenceRequired: boolean;
  licenceDocumentId: string | null;
  licenceGrantedAt: IsoDay | null;
  icioAmount: MoneyString | null;
  projectDocumentId: string | null;
  completionDocumentId: string | null;
  /** Prefijos de cuenta (21x/23x por centro) separados por coma. */
  executionAccountPrefixes: string | null;
  /** Ejecución leída del diario (cuentas de `executionAccountPrefixes`), si hay. */
  executedAmountLedger: MoneyString | null;
  /** Σ `CapexItem.actualCost`. */
  executedAmountItems: MoneyString;
  /** = `executedAmountLedger` cuando existe, si no `executedAmountItems`. */
  executedAmount: MoneyString;
  executionSource: CapexExecutionSource;
  capitalizedFixedAssetId: string | null;
  capitalizedAt: IsoDay | null;
};

/** KPIs calculados del activo (diseño §4 «KPIs»); `null` = no calculable con los datos actuales. */
export type RealEstateKpis = {
  cadastralValueTotal: MoneyString | null;
  lastValuationValue: MoneyString | null;
  valuePerRoom: MoneyString | null;
  /** IBI + IAE + tasas previstos del ejercicio (`taxpayer = sociedad`). */
  annualTaxBurden: MoneyString | null;
  /** % de documentos con vigencia `vigente` o `sin_fecha` sobre los no sustituidos; null sin documentos. */
  documentsValidPct: PercentString | null;
  /** % de inspecciones no vencidas sobre las abiertas; null sin inspecciones. */
  inspectionsOnTimePct: PercentString | null;
  openAlerts: number;
};

export type RealEstateAssetDetail = {
  asset: RealEstateAssetRecord;
  units: RealEstateUnitWithCharges[];
  valuations: RealEstateValuationRecord[];
  currentTenure: RealEstateTenureRecord | null;
  taxes: PropertyTaxRecord[];
  kpis: RealEstateKpis;
  alerts: RealEstateAlert[];
};

/** Una fila por centro de la vista de grupo (`GET /organizations/:id/real-estate/overview`). */
export type RealEstateGroupRow = {
  propertyId: string;
  propertyCode: string | null;
  propertyName: string;
  tenureKind: RealEstateTenureKind | null;
  cadastralValueTotal: MoneyString | null;
  lastValuationValue: MoneyString | null;
  annualTaxBurden: MoneyString | null;
  documentsValidPct: PercentString | null;
  inspectionsOnTimePct: PercentString | null;
  openAlertsHigh: number;
  openAlerts: number;
};

export type RealEstateGroupTotals = {
  properties: number;
  cadastralValueTotal: MoneyString;
  lastValuationValue: MoneyString;
  annualTaxBurden: MoneyString;
  openAlertsHigh: number;
  openAlerts: number;
};

export type RealEstateGroupOverview = {
  rows: RealEstateGroupRow[];
  totals: RealEstateGroupTotals;
  alerts: RealEstateAlert[];
};
