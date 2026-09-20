// Esquemas zod de las rutas del activo inmobiliario (Tanda ACT · L0a, diseño §7).
// Convención de documents.schemas.ts: `.strict()` (clave desconocida → 400
// VALIDATION_ERROR en español vía parseOr400 de rate-grid.schemas.ts). Los
// catálogos vienen de packages/shared/src/real-estate-types.ts (única fuente de
// las columnas String del schema y de estos esquemas). Dinero y porcentajes
// entran como número o cadena decimal y salen como Prisma.Decimal
// (`moneyInput` / `percentInput` de payables/money.ts); los días AAAA-MM-DD
// salen como Date UTC-medianoche (`dayInput`), lo que esperan las columnas
// `@db.Date`. La referencia catastral se normaliza (mayúsculas, sin espacios)
// y se valida con modules/real-estate/cadastral.ts. Los bytes de un documento
// viajan en base64 dentro del JSON (bodyLimit por ruta): aquí se valida la
// forma (isBase64) y el tamaño decodificado (base64DecodedSize); la lista
// blanca MIME y los magic bytes los comprueba el servicio.

import { z } from "zod";
import {
  CAPEX_WORK_KINDS,
  PROPERTY_TAX_KINDS,
  PROPERTY_TAX_PAID_WITH,
  PROPERTY_TAX_PERIODICITIES,
  PROPERTY_TAX_RECEIPT_STATUSES,
  PROPERTY_TAX_STATUSES,
  PROPERTY_TAX_TAXPAYERS,
  REAL_ESTATE_ASSET_STATUSES,
  REAL_ESTATE_CAPEX_RESPONSIBILITIES,
  REAL_ESTATE_CDE_STATES,
  REAL_ESTATE_CHARGE_KINDS,
  REAL_ESTATE_CONFIDENTIALITIES,
  REAL_ESTATE_COST_PAYERS,
  REAL_ESTATE_DEFECT_SEVERITIES,
  REAL_ESTATE_DOCUMENT_CATEGORIES,
  REAL_ESTATE_DOCUMENT_KINDS,
  REAL_ESTATE_DOCUMENT_STATUSES,
  REAL_ESTATE_ENERGY_RATINGS,
  REAL_ESTATE_INSPECTION_KINDS,
  REAL_ESTATE_INSPECTION_RESULTS,
  REAL_ESTATE_INSPECTION_STATUSES,
  REAL_ESTATE_INSURANCE_KINDS,
  REAL_ESTATE_INSURANCE_PATCH_STATUSES,
  REAL_ESTATE_LINKED_ENTITY_TYPES,
  REAL_ESTATE_POLICYHOLDERS,
  REAL_ESTATE_PROTECTION_LEVELS,
  REAL_ESTATE_RENT_KINDS,
  REAL_ESTATE_RENT_REVIEW_INDEXES,
  REAL_ESTATE_RENT_VARIABLE_BASES,
  REAL_ESTATE_TENURE_KINDS,
  REAL_ESTATE_TENURE_RENEWALS,
  REAL_ESTATE_TITLE_KINDS,
  REAL_ESTATE_UNIT_KINDS,
  REAL_ESTATE_USE_CODES,
  REAL_ESTATE_VALUATION_KINDS,
  REAL_ESTATE_VALUATION_PURPOSES
} from "@hotelos/shared";
import { isValidCadastralReference, normalizeCadastralReference } from "../modules/real-estate/cadastral.js";
import { isMonthDay, percentToHundredths } from "../modules/real-estate/tax-calendar.js";
import { dayInput, dec, moneyInput, percentInput } from "../modules/payables/money.js";
import { base64DecodedSize, isBase64 } from "./documents.schemas.js";

// ---------------------------------------------------------------------------
// Límites
// ---------------------------------------------------------------------------

/** Bytes decodificados máximos de un fichero (planos y proyectos; alineado con el bodyLimit de documentos de T9). */
export const REAL_ESTATE_DOCUMENT_MAX_BYTES = 40 * 1024 * 1024;
export const REAL_ESTATE_FILE_NAME_MAX_LENGTH = 200;
export const REAL_ESTATE_NOTE_MAX_LENGTH = 2000;
export const REAL_ESTATE_TITLE_MAX_LENGTH = 200;
/** Plazos máximos de un tributo fraccionado (PAC mensual = 12; margen para calendarios especiales). */
export const PROPERTY_TAX_MAX_INSTALLMENTS = 24;
export const CAPEX_MAX_EXECUTION_PREFIXES = 20;
export const REAL_ESTATE_MIN_YEAR = 1800;
export const REAL_ESTATE_MAX_YEAR = 2100;

/** Acciones de `PATCH …/tenures/:id`. */
export const REAL_ESTATE_TENURE_ACTIONS = ["activar", "resolver"] as const;
export type RealEstateTenureAction = (typeof REAL_ESTATE_TENURE_ACTIONS)[number];

/** Estados que un cliente puede fijar al crear un recibo (los demás los pone el servicio). */
export const PROPERTY_TAX_RECEIPT_CREATE_STATUSES = ["previsto", "recibido", "domiciliado"] as const;
/** Estados que admite `PATCH …/receipts/:id` (la máquina RECEIPT de state-machines.ts decide si la transición vale). */
export const PROPERTY_TAX_RECEIPT_PATCH_STATUSES = ["recibido", "domiciliado", "pagado", "recurrido"] as const;

// ---------------------------------------------------------------------------
// Piezas comunes
// ---------------------------------------------------------------------------

function enumOf<T extends readonly [string, ...string[]]>(values: T, field: string) {
  return z.enum(values, { errorMap: () => ({ message: `${field} debe ser uno de: ${values.join(", ")}.` }) });
}

function text(field: string, max: number, min = 1) {
  return z
    .string({ invalid_type_error: `${field} debe ser un texto.` })
    .trim()
    .min(min, { message: `${field} no puede estar vacío.` })
    .max(max, { message: `${field} no puede superar ${max} caracteres.` });
}

/** Texto opcional que también admite `null` para borrar el valor. */
function optionalText(field: string, max: number) {
  return text(field, max).nullable().optional();
}

function idOf(field: string) {
  return text(field, 64);
}

function intOf(field: string, min: number, max: number) {
  return z.number({ invalid_type_error: `${field} debe ser un número entero.` }).int({ message: `${field} debe ser un número entero.` }).min(min, { message: `${field} debe ser ≥ ${min}.` }).max(max, { message: `${field} debe ser ≤ ${max}.` });
}

function boolOf(field: string) {
  return z.boolean({ invalid_type_error: `${field} debe ser true o false.` });
}

const yearOf = (field: string) => intOf(field, REAL_ESTATE_MIN_YEAR, REAL_ESTATE_MAX_YEAR);
const money = () => moneyInput();
const optionalMoney = () => moneyInput().nullable().optional();
const optionalPercent = () => percentInput().nullable().optional();
const day = () => dayInput();
const optionalDay = () => dayInput().nullable().optional();

/** Tipo de gravamen (IBI 0,4-1,3 %; IAE cuota) con hasta 4 decimales, como `PropertyTax.ratePct` Decimal(8,4). */
const rateInput = () =>
  z
    .union([z.number().finite(), z.string().regex(/^\d{1,4}(\.\d{1,4})?$/, "ratePct no válido")])
    .transform((raw, ctx) => {
      const value = dec(raw);
      if (value.lt(0) || value.gt(1000)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ratePct debe estar entre 0 y 1000." });
        return z.NEVER;
      }
      if (value.decimalPlaces() > 4) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ratePct no puede tener más de 4 decimales." });
        return z.NEVER;
      }
      return value;
    });

/** `MM-DD` real (02-29 admitido; 13-01 y 04-31 no). */
const monthDaySchema = z
  .string({ invalid_type_error: "fecha MM-DD." })
  .regex(/^\d{2}-\d{2}$/, { message: "fecha MM-DD." })
  .refine(isMonthDay, { message: "día del año no válido (MM-DD)." });

/** Referencia catastral: se normaliza y se exige la forma de 20 caracteres [0-9A-Z]. */
export const cadastralReferenceSchema = z
  .string({ invalid_type_error: "cadastralReference debe ser un texto." })
  .transform((raw, ctx) => {
    const normalized = normalizeCadastralReference(raw);
    if (!isValidCadastralReference(normalized)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cadastralReference debe tener 20 caracteres alfanuméricos (sin guiones ni signos)." });
      return z.NEVER;
    }
    return normalized;
  });

const nonEmptyBody = <T extends z.ZodRawShape>(schema: z.ZodObject<T, "strict">) => schema.refine((body) => Object.keys(body).length > 0, { message: "El cuerpo de la petición no incluye ningún campo que modificar." });

// ---------------------------------------------------------------------------
// Activo (ficha)
// ---------------------------------------------------------------------------

const assetShape = {
  name: text("name", REAL_ESTATE_TITLE_MAX_LENGTH),
  legalEntityId: idOf("legalEntityId").nullable().optional(),
  yearBuilt: yearOf("yearBuilt").nullable().optional(),
  yearLastRefurbished: yearOf("yearLastRefurbished").nullable().optional(),
  builtSurfaceM2: optionalMoney(),
  plotSurfaceM2: optionalMoney(),
  floorsAbove: intOf("floorsAbove", 0, 200).nullable().optional(),
  floorsBelow: intOf("floorsBelow", 0, 20).nullable().optional(),
  roomsCount: intOf("roomsCount", 0, 10_000).nullable().optional(),
  protectionLevel: enumOf(REAL_ESTATE_PROTECTION_LEVELS, "protectionLevel").optional(),
  energyRating: enumOf(REAL_ESTATE_ENERGY_RATINGS, "energyRating").nullable().optional(),
  energyCertValidUntil: optionalDay(),
  cadastralValueTotal: optionalMoney(),
  cadastralValueYear: yearOf("cadastralValueYear").nullable().optional(),
  referenceValue: optionalMoney(),
  notes: optionalText("notes", REAL_ESTATE_NOTE_MAX_LENGTH)
};

/** `POST /properties/:propertyId/real-estate` (alta de la ficha). */
export const RealEstateAssetCreateSchema = z.object(assetShape).strict();
export type RealEstateAssetCreateInput = z.output<typeof RealEstateAssetCreateSchema>;

/** `PATCH /properties/:propertyId/real-estate`. */
export const RealEstateAssetPatchSchema = nonEmptyBody(z.object({ ...assetShape, name: assetShape.name.optional(), status: enumOf(REAL_ESTATE_ASSET_STATUSES, "status").optional() }).strict());
export type RealEstateAssetPatchInput = z.output<typeof RealEstateAssetPatchSchema>;

// ---------------------------------------------------------------------------
// Unidades y cargas
// ---------------------------------------------------------------------------

const unitShape = {
  kind: enumOf(REAL_ESTATE_UNIT_KINDS, "kind").optional(),
  registryOffice: optionalText("registryOffice", 200),
  registryFincaNumber: optionalText("registryFincaNumber", 40),
  registryTomo: optionalText("registryTomo", 20),
  registryLibro: optionalText("registryLibro", 20),
  registryFolio: optionalText("registryFolio", 20),
  cru: optionalText("cru", 40),
  cadastralReference: cadastralReferenceSchema.nullable().optional(),
  useCode: enumOf(REAL_ESTATE_USE_CODES, "useCode").nullable().optional(),
  surfaceM2: optionalMoney(),
  cadastralValueLand: optionalMoney(),
  cadastralValueBuilding: optionalMoney(),
  titleKind: enumOf(REAL_ESTATE_TITLE_KINDS, "titleKind").optional(),
  titleHolderTaxId: optionalText("titleHolderTaxId", 20),
  titleHolderName: optionalText("titleHolderName", 200),
  titleDeedDate: optionalDay(),
  notary: optionalText("notary", 200),
  fixedAssetId: idOf("fixedAssetId").nullable().optional()
};

/** `POST …/real-estate/units`. */
export const RealEstateUnitCreateSchema = z.object(unitShape).strict();
export type RealEstateUnitCreateInput = z.output<typeof RealEstateUnitCreateSchema>;

/** `PATCH …/real-estate/units/:unitId`. */
export const RealEstateUnitPatchSchema = nonEmptyBody(z.object(unitShape).strict());
export type RealEstateUnitPatchInput = z.output<typeof RealEstateUnitPatchSchema>;

const chargeShape = {
  kind: enumOf(REAL_ESTATE_CHARGE_KINDS, "kind"),
  holderName: optionalText("holderName", 200),
  holderTaxId: optionalText("holderTaxId", 20),
  amount: optionalMoney(),
  outstandingAmount: optionalMoney(),
  registeredAt: optionalDay(),
  expiresAt: optionalDay(),
  cancelledAt: optionalDay(),
  documentId: idOf("documentId").nullable().optional(),
  note: optionalText("note", REAL_ESTATE_NOTE_MAX_LENGTH)
};

/** `POST …/units/:unitId/charges`. */
export const RealEstateChargeCreateSchema = z.object(chargeShape).strict();
export type RealEstateChargeCreateInput = z.output<typeof RealEstateChargeCreateSchema>;

/** `PATCH …/charges/:chargeId`. */
export const RealEstateChargePatchSchema = nonEmptyBody(z.object({ ...chargeShape, kind: chargeShape.kind.optional() }).strict());
export type RealEstateChargePatchInput = z.output<typeof RealEstateChargePatchSchema>;

// ---------------------------------------------------------------------------
// Valoraciones
// ---------------------------------------------------------------------------

/** `POST …/real-estate/valuations` (actualiza la caché `lastValuation*` del activo). */
export const RealEstateValuationCreateSchema = z
  .object({
    kind: enumOf(REAL_ESTATE_VALUATION_KINDS, "kind"),
    purpose: enumOf(REAL_ESTATE_VALUATION_PURPOSES, "purpose").nullable().optional(),
    valuedAt: day(),
    value: moneyInput({ allowZero: false }),
    valuePerRoom: optionalMoney(),
    capRatePct: optionalPercent(),
    method: optionalText("method", 200),
    appraiser: optionalText("appraiser", 200),
    documentId: idOf("documentId").nullable().optional()
  })
  .strict();
export type RealEstateValuationCreateInput = z.output<typeof RealEstateValuationCreateSchema>;

// ---------------------------------------------------------------------------
// Tenencia
// ---------------------------------------------------------------------------

const tenureShape = {
  kind: enumOf(REAL_ESTATE_TENURE_KINDS, "kind"),
  counterpartyName: optionalText("counterpartyName", 200),
  counterpartyTaxId: optionalText("counterpartyTaxId", 20),
  counterpartyNonResident: boolOf("counterpartyNonResident").optional(),
  startDate: day(),
  endDate: optionalDay(),
  noticeMonths: intOf("noticeMonths", 0, 120).nullable().optional(),
  renewal: enumOf(REAL_ESTATE_TENURE_RENEWALS, "renewal").optional(),
  rentKind: enumOf(REAL_ESTATE_RENT_KINDS, "rentKind").nullable().optional(),
  rentMonthly: optionalMoney(),
  rentVariablePct: optionalPercent(),
  rentVariableBase: enumOf(REAL_ESTATE_RENT_VARIABLE_BASES, "rentVariableBase").nullable().optional(),
  rentReviewIndex: enumOf(REAL_ESTATE_RENT_REVIEW_INDEXES, "rentReviewIndex").nullable().optional(),
  rentReviewMonth: intOf("rentReviewMonth", 1, 12).nullable().optional(),
  depositAmount: optionalMoney(),
  vatApplies: boolOf("vatApplies").optional(),
  withholdingApplies: boolOf("withholdingApplies").optional(),
  withholdingRatePct: optionalPercent(),
  ibiPayer: enumOf(REAL_ESTATE_COST_PAYERS, "ibiPayer").optional(),
  insurancePayer: enumOf(REAL_ESTATE_COST_PAYERS, "insurancePayer").optional(),
  capexResponsibility: enumOf(REAL_ESTATE_CAPEX_RESPONSIBILITIES, "capexResponsibility").optional(),
  ffeReservePct: optionalPercent(),
  brandName: optionalText("brandName", 120),
  documentId: idOf("documentId").nullable().optional(),
  notes: optionalText("notes", REAL_ESTATE_NOTE_MAX_LENGTH)
};

const endAfterStart = (body: { startDate?: Date; endDate?: Date | null }) => !body.startDate || !body.endDate || body.endDate.getTime() >= body.startDate.getTime();

/** `POST …/real-estate/tenures` (nace `borrador`). */
export const RealEstateTenureCreateSchema = z.object(tenureShape).strict().refine(endAfterStart, { message: "endDate no puede ser anterior a startDate.", path: ["endDate"] });
export type RealEstateTenureCreateInput = z.output<typeof RealEstateTenureCreateSchema>;

/** `PATCH …/tenures/:tenureId`: campos y/o `action` (activar → vigente; resolver → resuelto). */
export const RealEstateTenurePatchSchema = nonEmptyBody(
  z
    .object({ ...tenureShape, kind: tenureShape.kind.optional(), startDate: tenureShape.startDate.optional(), action: enumOf(REAL_ESTATE_TENURE_ACTIONS, "action").optional() })
    .strict()
).refine(endAfterStart, { message: "endDate no puede ser anterior a startDate.", path: ["endDate"] });
export type RealEstateTenurePatchInput = z.output<typeof RealEstateTenurePatchSchema>;

// ---------------------------------------------------------------------------
// Tributos y recibos
// ---------------------------------------------------------------------------

/** Un plazo de `installmentsJson` (PAC): `pct` del importe anual, ventana `MM-DD`. */
export const PropertyTaxInstallmentSchema = z
  .object({
    label: text("label", 40),
    dueFrom: monthDaySchema,
    dueTo: monthDaySchema,
    pct: percentInput()
  })
  .strict();
export type PropertyTaxInstallmentInput = z.output<typeof PropertyTaxInstallmentSchema>;

const installmentsSchema = z
  .array(PropertyTaxInstallmentSchema, { invalid_type_error: "installmentsJson debe ser una lista de plazos." })
  .min(1, { message: "installmentsJson debe incluir al menos un plazo." })
  .max(PROPERTY_TAX_MAX_INSTALLMENTS, { message: `installmentsJson no puede incluir más de ${PROPERTY_TAX_MAX_INSTALLMENTS} plazos.` })
  .refine((items) => items.reduce((acc, item) => acc + (percentToHundredths(item.pct.toFixed(2)) ?? 0), 0) === 10_000, { message: "los porcentajes de installmentsJson deben sumar 100." });

const taxShape = {
  kind: enumOf(PROPERTY_TAX_KINDS, "kind"),
  taxpayer: enumOf(PROPERTY_TAX_TAXPAYERS, "taxpayer").optional(),
  authorityName: text("authorityName", 200),
  unitId: idOf("unitId").nullable().optional(),
  fiscalReference: optionalText("fiscalReference", 60),
  taxBase: optionalMoney(),
  ratePct: rateInput().nullable().optional(),
  expectedAnnualAmount: optionalMoney(),
  periodicity: enumOf(PROPERTY_TAX_PERIODICITIES, "periodicity").optional(),
  voluntaryFrom: monthDaySchema.nullable().optional(),
  voluntaryTo: monthDaySchema.nullable().optional(),
  directDebit: boolOf("directDebit").optional(),
  directDebitBonusPct: optionalPercent(),
  installmentsJson: installmentsSchema.nullable().optional(),
  accountCode: text("accountCode", 12, 3).regex(/^\d{3,12}$/, { message: "accountCode debe ser un código de cuenta numérico." }).optional(),
  capitalizable: boolOf("capitalizable").optional(),
  legalBasis: optionalText("legalBasis", 200)
};

const voluntaryWindowPaired = (body: { voluntaryFrom?: string | null; voluntaryTo?: string | null }) => (body.voluntaryFrom == null) === (body.voluntaryTo == null);

/** `POST …/real-estate/taxes`. */
export const PropertyTaxCreateSchema = z.object(taxShape).strict().refine(voluntaryWindowPaired, { message: "voluntaryFrom y voluntaryTo van juntos (los dos o ninguno).", path: ["voluntaryTo"] });
export type PropertyTaxCreateInput = z.output<typeof PropertyTaxCreateSchema>;

/** `PATCH …/taxes/:taxId`. */
export const PropertyTaxPatchSchema = nonEmptyBody(
  z.object({ ...taxShape, kind: taxShape.kind.optional(), authorityName: taxShape.authorityName.optional(), status: enumOf(PROPERTY_TAX_STATUSES, "status").optional() }).strict()
).refine(voluntaryWindowPaired, { message: "voluntaryFrom y voluntaryTo van juntos (los dos o ninguno).", path: ["voluntaryTo"] });
export type PropertyTaxPatchInput = z.output<typeof PropertyTaxPatchSchema>;

const dueWindowOrdered = (body: { dueFrom?: Date | null; dueTo?: Date | null }) => !body.dueFrom || !body.dueTo || body.dueTo.getTime() >= body.dueFrom.getTime();

/** `POST …/taxes/:taxId/receipts` (recibo manual; los `previsto` del ejercicio los genera el servicio con tax-calendar.ts). */
export const PropertyTaxReceiptCreateSchema = z
  .object({
    fiscalYear: yearOf("fiscalYear"),
    period: text("period", 40).optional(),
    issuedAt: optionalDay(),
    dueFrom: optionalDay(),
    dueTo: optionalDay(),
    amount: money().optional(),
    surchargeAmount: money().optional(),
    status: enumOf(PROPERTY_TAX_RECEIPT_CREATE_STATUSES, "status").optional(),
    capexProjectId: idOf("capexProjectId").nullable().optional(),
    documentId: idOf("documentId").nullable().optional(),
    notes: optionalText("notes", REAL_ESTATE_NOTE_MAX_LENGTH)
  })
  .strict()
  .refine(dueWindowOrdered, { message: "dueTo no puede ser anterior a dueFrom.", path: ["dueTo"] });
export type PropertyTaxReceiptCreateInput = z.output<typeof PropertyTaxReceiptCreateSchema>;

/** `PATCH …/receipts/:receiptId` (recibido · domiciliado · pagado · recurrido; importe, ventana, pago, recurso, asiento enlazado). */
export const PropertyTaxReceiptPatchSchema = nonEmptyBody(
  z
    .object({
      status: enumOf(PROPERTY_TAX_RECEIPT_PATCH_STATUSES, "status").optional(),
      amount: money().optional(),
      surchargeAmount: money().optional(),
      issuedAt: optionalDay(),
      dueFrom: optionalDay(),
      dueTo: optionalDay(),
      paidAt: optionalDay(),
      paidWith: enumOf(PROPERTY_TAX_PAID_WITH, "paidWith").nullable().optional(),
      appealRef: optionalText("appealRef", 80),
      journalEntryId: idOf("journalEntryId").nullable().optional(),
      documentId: idOf("documentId").nullable().optional(),
      notes: optionalText("notes", REAL_ESTATE_NOTE_MAX_LENGTH)
    })
    .strict()
).refine(dueWindowOrdered, { message: "dueTo no puede ser anterior a dueFrom.", path: ["dueTo"] });
export type PropertyTaxReceiptPatchInput = z.output<typeof PropertyTaxReceiptPatchSchema>;

// ---------------------------------------------------------------------------
// Documentos
// ---------------------------------------------------------------------------

const fileNameSchema = text("fileName", REAL_ESTATE_FILE_NAME_MAX_LENGTH).regex(/^[^/\\\u0000-\u001f]+$/, { message: "fileName no puede contener barras ni caracteres de control." });

/** Fichero adjunto de un documento: forma base64 y tamaño decodificado (413 `DOCUMENT_TOO_LARGE` lo emite el servicio; aquí 400). */
export const RealEstateDocumentFileSchema = z
  .object({
    fileName: fileNameSchema,
    mimeType: text("mimeType", 120),
    base64: z
      .string({ invalid_type_error: "base64 debe ser un texto." })
      .min(1, { message: "base64 no puede estar vacío." })
      .refine(isBase64, { message: "base64 no válido: alfabeto estándar sin espacios ni prefijo data:, longitud múltiplo de 4." })
      .refine((raw) => base64DecodedSize(raw) <= REAL_ESTATE_DOCUMENT_MAX_BYTES, { message: `el fichero no puede superar ${REAL_ESTATE_DOCUMENT_MAX_BYTES / (1024 * 1024)} MiB.` })
  })
  .strict();
export type RealEstateDocumentFileInput = z.output<typeof RealEstateDocumentFileSchema>;

const validityOrdered = (body: { validFrom?: Date | null; validUntil?: Date | null }) => !body.validFrom || !body.validUntil || body.validUntil.getTime() >= body.validFrom.getTime();
const linkedPaired = (body: { linkedEntityType?: string | null; linkedEntityId?: string | null }) => (body.linkedEntityType == null) === (body.linkedEntityId == null);

const documentShape = {
  category: enumOf(REAL_ESTATE_DOCUMENT_CATEGORIES, "category"),
  kind: enumOf(REAL_ESTATE_DOCUMENT_KINDS, "kind"),
  title: text("title", REAL_ESTATE_TITLE_MAX_LENGTH),
  issuerName: optionalText("issuerName", 200),
  issueDate: optionalDay(),
  validFrom: optionalDay(),
  validUntil: optionalDay(),
  renewalDays: intOf("renewalDays", 1, 36_500).nullable().optional(),
  cdeState: enumOf(REAL_ESTATE_CDE_STATES, "cdeState").optional(),
  confidentiality: enumOf(REAL_ESTATE_CONFIDENTIALITIES, "confidentiality").optional(),
  linkedEntityType: enumOf(REAL_ESTATE_LINKED_ENTITY_TYPES, "linkedEntityType").nullable().optional(),
  linkedEntityId: idOf("linkedEntityId").nullable().optional(),
  complianceRequirementCode: optionalText("complianceRequirementCode", 40),
  retentionUntil: optionalDay(),
  legalHold: boolOf("legalHold").optional()
};

/** `POST …/real-estate/documents`: metadatos + `file` opcional (sin fichero = solo ficha, «Sin fichero»); `supersedesId` = nueva versión de otro documento. */
export const RealEstateDocumentCreateSchema = z
  .object({ ...documentShape, supersedesId: idOf("supersedesId").optional(), file: RealEstateDocumentFileSchema.optional() })
  .strict()
  .refine(validityOrdered, { message: "validUntil no puede ser anterior a validFrom.", path: ["validUntil"] })
  .refine(linkedPaired, { message: "linkedEntityType y linkedEntityId van juntos (los dos o ninguno).", path: ["linkedEntityId"] });
export type RealEstateDocumentCreateInput = z.output<typeof RealEstateDocumentCreateSchema>;

/** `PATCH …/documents/:documentId` (solo metadatos; el fichero se cambia con una versión nueva). */
export const RealEstateDocumentPatchSchema = nonEmptyBody(
  z.object({ ...documentShape, category: documentShape.category.optional(), kind: documentShape.kind.optional(), title: documentShape.title.optional() }).strict()
)
  .refine(validityOrdered, { message: "validUntil no puede ser anterior a validFrom.", path: ["validUntil"] })
  .refine(linkedPaired, { message: "linkedEntityType y linkedEntityId van juntos (los dos o ninguno).", path: ["linkedEntityId"] });
export type RealEstateDocumentPatchInput = z.output<typeof RealEstateDocumentPatchSchema>;

// ---------------------------------------------------------------------------
// Inspecciones
// ---------------------------------------------------------------------------

/** Un defecto del acta (`defectsJson[]`). */
export const RealEstateInspectionDefectSchema = z
  .object({
    severity: enumOf(REAL_ESTATE_DEFECT_SEVERITIES, "severity"),
    text: text("text", 500),
    dueAt: optionalDay(),
    fixedAt: optionalDay()
  })
  .strict();
export type RealEstateInspectionDefectInput = z.output<typeof RealEstateInspectionDefectSchema>;

const inspectionShape = {
  kind: enumOf(REAL_ESTATE_INSPECTION_KINDS, "kind"),
  legalBasis: optionalText("legalBasis", 200),
  periodicityMonths: intOf("periodicityMonths", 1, 600).nullable().optional(),
  installationRef: optionalText("installationRef", 80),
  technicalAssetId: idOf("technicalAssetId").nullable().optional(),
  providerName: optionalText("providerName", 200),
  supplierId: idOf("supplierId").nullable().optional(),
  scheduledAt: optionalDay(),
  nextDueAt: optionalDay(),
  complianceRequirementCode: optionalText("complianceRequirementCode", 40),
  notes: optionalText("notes", REAL_ESTATE_NOTE_MAX_LENGTH)
};

/** `POST …/real-estate/inspections` (nace `programada`). */
export const RealEstateInspectionCreateSchema = z.object(inspectionShape).strict();
export type RealEstateInspectionCreateInput = z.output<typeof RealEstateInspectionCreateSchema>;

/** `PATCH …/inspections/:inspectionId`: acta (`performedAt`, `result`, `documentId`), defectos, subsanación y/o `status` explícito. */
export const RealEstateInspectionPatchSchema = nonEmptyBody(
  z
    .object({
      ...inspectionShape,
      kind: inspectionShape.kind.optional(),
      performedAt: optionalDay(),
      result: enumOf(REAL_ESTATE_INSPECTION_RESULTS, "result").nullable().optional(),
      defectsJson: z.array(RealEstateInspectionDefectSchema, { invalid_type_error: "defectsJson debe ser una lista de defectos." }).max(200, { message: "defectsJson no puede incluir más de 200 defectos." }).nullable().optional(),
      correctionDueAt: optionalDay(),
      correctedAt: optionalDay(),
      documentId: idOf("documentId").nullable().optional(),
      status: enumOf(REAL_ESTATE_INSPECTION_STATUSES, "status").optional()
    })
    .strict()
);
export type RealEstateInspectionPatchInput = z.output<typeof RealEstateInspectionPatchSchema>;

// ---------------------------------------------------------------------------
// Seguros
// ---------------------------------------------------------------------------

const insuranceShape = {
  kind: enumOf(REAL_ESTATE_INSURANCE_KINDS, "kind"),
  insurerName: text("insurerName", 200),
  policyNumber: text("policyNumber", 80),
  brokerName: optionalText("brokerName", 200),
  policyholder: enumOf(REAL_ESTATE_POLICYHOLDERS, "policyholder").optional(),
  insuredSum: optionalMoney(),
  deductible: optionalMoney(),
  premiumAnnual: optionalMoney(),
  validFrom: day(),
  validUntil: day(),
  autoRenew: boolOf("autoRenew").optional(),
  noticeDays: intOf("noticeDays", 0, 365).optional(),
  mandatoryBasis: optionalText("mandatoryBasis", 200),
  documentId: idOf("documentId").nullable().optional(),
  notes: optionalText("notes", REAL_ESTATE_NOTE_MAX_LENGTH)
};

/** `POST …/real-estate/insurances`. */
export const RealEstateInsuranceCreateSchema = z.object(insuranceShape).strict().refine(validityOrdered, { message: "validUntil no puede ser anterior a validFrom.", path: ["validUntil"] });
export type RealEstateInsuranceCreateInput = z.output<typeof RealEstateInsuranceCreateSchema>;

/** `PATCH …/insurances/:insuranceId`. */
export const RealEstateInsurancePatchSchema = nonEmptyBody(
  z
    .object({
      ...insuranceShape,
      kind: insuranceShape.kind.optional(),
      insurerName: insuranceShape.insurerName.optional(),
      policyNumber: insuranceShape.policyNumber.optional(),
      validFrom: insuranceShape.validFrom.optional(),
      validUntil: insuranceShape.validUntil.optional(),
      // ACT-REV-17: `vencida` es derivado (validUntil < hoy) y no forma parte del contrato de escritura.
      status: enumOf(REAL_ESTATE_INSURANCE_PATCH_STATUSES, "status").optional()
    })
    .strict()
).refine(validityOrdered, { message: "validUntil no puede ser anterior a validFrom.", path: ["validUntil"] });
export type RealEstateInsurancePatchInput = z.output<typeof RealEstateInsurancePatchSchema>;

// ---------------------------------------------------------------------------
// Obras (CapexProject + 12 columnas)
// ---------------------------------------------------------------------------

/** `PATCH /capex-projects/:id/work`: datos de obra; `executionAccountPrefixes` como lista (el servicio la guarda separada por comas). */
export const CapexWorkPatchSchema = nonEmptyBody(
  z
    .object({
      realEstateAssetId: idOf("realEstateAssetId").nullable().optional(),
      workKind: enumOf(CAPEX_WORK_KINDS, "workKind").nullable().optional(),
      licenceRequired: boolOf("licenceRequired").optional(),
      licenceDocumentId: idOf("licenceDocumentId").nullable().optional(),
      licenceGrantedAt: optionalDay(),
      icioAmount: optionalMoney(),
      projectDocumentId: idOf("projectDocumentId").nullable().optional(),
      completionDocumentId: idOf("completionDocumentId").nullable().optional(),
      executionAccountPrefixes: z
        .array(text("executionAccountPrefixes", 10).regex(/^\d{2,10}$/, { message: "cada prefijo de executionAccountPrefixes debe ser numérico (21x / 23x)." }), { invalid_type_error: "executionAccountPrefixes debe ser una lista de prefijos de cuenta." })
        .max(CAPEX_MAX_EXECUTION_PREFIXES, { message: `executionAccountPrefixes no puede incluir más de ${CAPEX_MAX_EXECUTION_PREFIXES} prefijos.` })
        .nullable()
        .optional()
    })
    .strict()
);
export type CapexWorkPatchInput = z.output<typeof CapexWorkPatchSchema>;

// ---------------------------------------------------------------------------
// Queries de listado
// ---------------------------------------------------------------------------

const yearQuery = z
  .string({ invalid_type_error: "year debe ser un año (AAAA)." })
  .regex(/^\d{4}$/, { message: "year debe ser un año (AAAA)." })
  .transform(Number)
  .refine((year) => year >= REAL_ESTATE_MIN_YEAR && year <= REAL_ESTATE_MAX_YEAR, { message: `year debe estar entre ${REAL_ESTATE_MIN_YEAR} y ${REAL_ESTATE_MAX_YEAR}.` });

/** `GET …/real-estate/calendar?year=` · `…/receipts?year=`. */
export const RealEstateYearQuerySchema = z.object({ year: yearQuery.optional() }).strict();
export type RealEstateYearQueryInput = z.output<typeof RealEstateYearQuerySchema>;

/** `GET …/real-estate/documents?category=&status=&kind=` (`status` = vigencia derivada). */
export const RealEstateDocumentListQuerySchema = z
  .object({
    category: enumOf(REAL_ESTATE_DOCUMENT_CATEGORIES, "category").optional(),
    status: enumOf(REAL_ESTATE_DOCUMENT_STATUSES, "status").optional(),
    kind: enumOf(REAL_ESTATE_DOCUMENT_KINDS, "kind").optional()
  })
  .strict();
export type RealEstateDocumentListQueryInput = z.output<typeof RealEstateDocumentListQuerySchema>;

/** `GET …/real-estate/inspections?status=&kind=`. */
export const RealEstateInspectionListQuerySchema = z
  .object({
    status: enumOf(REAL_ESTATE_INSPECTION_STATUSES, "status").optional(),
    kind: enumOf(REAL_ESTATE_INSPECTION_KINDS, "kind").optional()
  })
  .strict();
export type RealEstateInspectionListQueryInput = z.output<typeof RealEstateInspectionListQuerySchema>;

/** `GET …/real-estate/taxes?year=&kind=&status=` (`year` filtra los recibos incluidos). */
export const PropertyTaxListQuerySchema = z
  .object({
    year: yearQuery.optional(),
    kind: enumOf(PROPERTY_TAX_KINDS, "kind").optional(),
    status: enumOf(PROPERTY_TAX_STATUSES, "status").optional(),
    receiptStatus: enumOf(PROPERTY_TAX_RECEIPT_STATUSES, "receiptStatus").optional()
  })
  .strict();
export type PropertyTaxListQueryInput = z.output<typeof PropertyTaxListQuerySchema>;
