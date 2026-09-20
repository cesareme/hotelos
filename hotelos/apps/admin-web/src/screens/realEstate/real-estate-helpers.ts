// Activo inmobiliario · helpers PUROS de presentación (Tanda ACT · lote ACT-F0,
// diseño docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md §8): la frase en español
// de cada `details.code` del módulo (REAL_ESTATE_ERROR_MESSAGES ·
// realEstateErrorMessage), las etiquetas de todos los catálogos de
// packages/shared/src/real-estate-types.ts, los tonos Cocoa de los estados y
// los formateadores de importe y día (lib/format.ts: es-ES, hora de Madrid).
// No React, no api-client: screens/realEstate/__tests__ lo ejecuta bajo
// `node --test` como screens/payables/payables-helpers.ts.
//
// Etiquetas: un valor desconocido (catálogo ampliado antes que el front) se
// humaniza («nuevo_valor» → «Nuevo valor») en vez de enseñar el guion bajo;
// null / vacío → «—». Tonos: un estado desconocido es `neutral`.

import type {
  CapexExecutionSource,
  CapexProjectStatus,
  CapexWorkKind,
  PropertyTaxKind,
  PropertyTaxPaidWith,
  PropertyTaxPeriodicity,
  PropertyTaxReceiptStatus,
  PropertyTaxStatus,
  PropertyTaxTaxpayer,
  RealEstateAlertEntityType,
  RealEstateAlertKind,
  RealEstateAlertSeverity,
  RealEstateAssetStatus,
  RealEstateCapexResponsibility,
  RealEstateCdeState,
  RealEstateChargeKind,
  RealEstateConfidentiality,
  RealEstateCostPayer,
  RealEstateDefectSeverity,
  RealEstateDocumentCategory,
  RealEstateDocumentKind,
  RealEstateDocumentStatus,
  RealEstateErrorCode,
  RealEstateInspectionDueState,
  RealEstateInspectionKind,
  RealEstateInspectionResult,
  RealEstateInspectionStatus,
  RealEstateInsuranceKind,
  RealEstateInsuranceStatus,
  RealEstateJournalEntryStatus,
  RealEstateLinkedEntityType,
  RealEstatePolicyholder,
  RealEstateProtectionLevel,
  RealEstateRentKind,
  RealEstateRentReviewIndex,
  RealEstateRentVariableBase,
  RealEstateTenureKind,
  RealEstateTenureRenewal,
  RealEstateTenureStatus,
  RealEstateTitleKind,
  RealEstateUnitKind,
  RealEstateUseCode,
  RealEstateValuationKind,
  RealEstateValuationPurpose
} from "@hotelos/shared";
import {
  CAPEX_EXECUTION_SOURCES,
  CAPEX_PROJECT_STATUSES,
  CAPEX_WORK_KINDS,
  PROPERTY_TAX_KINDS,
  PROPERTY_TAX_PAID_WITH,
  PROPERTY_TAX_PERIODICITIES,
  PROPERTY_TAX_RECEIPT_STATUSES,
  PROPERTY_TAX_STATUSES,
  PROPERTY_TAX_TAXPAYERS,
  REAL_ESTATE_ALERT_ENTITY_TYPES,
  REAL_ESTATE_ALERT_KINDS,
  REAL_ESTATE_ALERT_SEVERITIES,
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
  REAL_ESTATE_ERROR_CODES,
  REAL_ESTATE_INSPECTION_DUE_STATES,
  REAL_ESTATE_INSPECTION_KINDS,
  REAL_ESTATE_INSPECTION_RESULTS,
  REAL_ESTATE_INSPECTION_STATUSES,
  REAL_ESTATE_INSURANCE_KINDS,
  REAL_ESTATE_INSURANCE_STATUSES,
  REAL_ESTATE_JOURNAL_ENTRY_STATUSES,
  REAL_ESTATE_LINKED_ENTITY_TYPES,
  REAL_ESTATE_POLICYHOLDERS,
  REAL_ESTATE_PROTECTION_LEVELS,
  REAL_ESTATE_RENT_KINDS,
  REAL_ESTATE_RENT_REVIEW_INDEXES,
  REAL_ESTATE_RENT_VARIABLE_BASES,
  REAL_ESTATE_TENURE_KINDS,
  REAL_ESTATE_TENURE_RENEWALS,
  REAL_ESTATE_TENURE_STATUSES,
  REAL_ESTATE_TITLE_KINDS,
  REAL_ESTATE_UNIT_KINDS,
  REAL_ESTATE_USE_CODES,
  REAL_ESTATE_VALUATION_KINDS,
  REAL_ESTATE_VALUATION_PURPOSES
} from "@hotelos/shared";
import { financeErrorCode, financeErrorDetails, financeErrorMessage } from "../../services/finance-contracts";
import { EMPTY, date, money, percent, type CurrencyInput, type DateInput, type Numeric } from "../../lib/format";
import type { CocoaTone } from "../../components/cocoa/cocoa-tones";

// ---------------------------------------------------------------------------
// Errores: details.code → frase en español
// ---------------------------------------------------------------------------

/**
 * Códigos que llegan por `details.code` sin estar en REAL_ESTATE_ERROR_CODES:
 * el ejercicio cerrado del motor contable (propose-entry), los del almacén de
 * documentos de T9 que reutiliza la subida (DOCUMENT_*) y el tributo de baja
 * (ACT-L2, ConflictError genérico).
 */
export const REAL_ESTATE_EXTRA_ERROR_CODES = ["FISCAL_YEAR_CLOSED", "DOCUMENT_TOO_LARGE", "DOCUMENT_MIME_NOT_ALLOWED", "DOCUMENT_CONTENT_MISMATCH", "DOCUMENT_STORAGE_IO", "PROPERTY_TAX_INACTIVE"] as const;
export type RealEstateExtraErrorCode = (typeof REAL_ESTATE_EXTRA_ERROR_CODES)[number];
export type RealEstateMessageCode = RealEstateErrorCode | RealEstateExtraErrorCode;

export const REAL_ESTATE_ERROR_MESSAGES: Readonly<Record<RealEstateMessageCode, string>> = Object.freeze({
  ASSET_ALREADY_EXISTS: "Este centro ya tiene ficha de activo inmobiliario: edítala en vez de crear otra.",
  ASSET_NOT_FOUND: "Este centro aún no tiene activo inmobiliario: crea la ficha antes de continuar.",
  INVALID_CADASTRAL_REFERENCE: "La referencia catastral debe tener 20 caracteres alfanuméricos, sin guiones ni espacios.",
  UNIT_NOT_FOUND: "La unidad registral no existe o no pertenece a este centro.",
  TENURE_ALREADY_ACTIVE: "Ya hay una tenencia vigente en este centro: resuélvela antes de activar otra.",
  TENURE_INVALID_TRANSITION: "La tenencia no admite ese cambio en su estado actual.",
  RECEIPT_NOT_PAYABLE: "El recibo no se puede marcar como pagado en su estado actual.",
  RECEIPT_ENTRY_EXISTS: "El recibo ya tiene un asiento enlazado: desenlázalo antes de cambiar importes o pago, o de proponer otro.",
  RECEIPT_ALREADY_EXISTS: "Ya existe un recibo de ese tributo para el mismo ejercicio y periodo.",
  TAXPAYER_NOT_ENTITY: "Solo se propone asiento cuando el sujeto pasivo es la sociedad: este tributo lo paga un tercero.",
  DOCUMENT_SUPERSEDED: "El documento está sustituido por una versión posterior: trabaja sobre la versión vigente.",
  LEGAL_HOLD: "El documento tiene bloqueo legal: no se puede retirar ni sustituir mientras siga activo.",
  DOCUMENT_NO_FILE: "El documento no tiene fichero adjunto: sube una versión con el fichero.",
  LICENCE_REQUIRED: "La obra requiere licencia: registra el documento de licencia antes de iniciarla.",
  CAPEX_NOT_COMPLETED: "Solo se capitaliza una obra terminada: marca el proyecto como completado.",
  CAPEX_ALREADY_CAPITALIZED: "La obra ya está capitalizada en el inmovilizado.",
  CAPEX_NOT_LINKED: "El proyecto no está enlazado a la ficha del activo inmobiliario: enlázalo en los datos de obra.",
  INSPECTION_INVALID_TRANSITION: "La inspección no admite ese cambio en su estado actual.",
  FISCAL_YEAR_CLOSED: "El ejercicio está cerrado: enlaza el asiento importado en vez de proponer uno nuevo.",
  DOCUMENT_TOO_LARGE: "El fichero supera el tamaño máximo admitido (40 MiB): comprímelo o divide el documento.",
  DOCUMENT_MIME_NOT_ALLOWED: "Tipo de fichero no admitido: sube un PDF, una imagen (JPEG, PNG, TIFF) o un XML.",
  DOCUMENT_CONTENT_MISMATCH: "El contenido del fichero no corresponde con su tipo: vuelve a exportarlo o escanéalo de nuevo.",
  DOCUMENT_STORAGE_IO: "No se pudo guardar o leer el fichero en el almacén de documentos. Inténtalo de nuevo.",
  PROPERTY_TAX_INACTIVE: "El tributo está de baja: reactívalo antes de generar los recibos previstos."
});

export const REAL_ESTATE_ERROR_FALLBACK = "No se pudo completar la operación del activo inmobiliario. Inténtalo de nuevo.";

/** Todos los códigos con frase propia (catálogo compartido + extras), para tests y pantallas. */
export const REAL_ESTATE_MESSAGE_CODES: readonly RealEstateMessageCode[] = [...REAL_ESTATE_ERROR_CODES, ...REAL_ESTATE_EXTRA_ERROR_CODES];

function hasOwnMessage(code: string): code is RealEstateMessageCode {
  return Object.hasOwn(REAL_ESTATE_ERROR_MESSAGES, code);
}

/** Las máquinas de estado envían `details.allowed` (transiciones posibles desde el estado actual). */
function withAllowedTransitions(base: string, details: Record<string, unknown> | null): string {
  const allowed = details?.allowed;
  if (!Array.isArray(allowed) || allowed.length === 0) return base;
  const list = allowed.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return list.length > 0 ? `${base} Cambios posibles: ${list.join(", ")}.` : base;
}

/**
 * Frase en español de un fallo del módulo: primero REAL_ESTATE_ERROR_MESSAGES
 * (con las transiciones posibles cuando el API las manda), después el
 * diccionario común de finanzas (financeErrorMessage: VALIDATION_ERROR,
 * FISCAL_PERIOD_CLOSED, RBAC…), después el mensaje del API y por último `fallback`.
 */
export function realEstateErrorMessage(error: unknown, fallback: string = REAL_ESTATE_ERROR_FALLBACK): string {
  const code = financeErrorCode(error);
  if (code && hasOwnMessage(code)) {
    const base = REAL_ESTATE_ERROR_MESSAGES[code];
    if (code === "TENURE_INVALID_TRANSITION" || code === "INSPECTION_INVALID_TRANSITION") return withAllowedTransitions(base, financeErrorDetails(error));
    return base;
  }
  return financeErrorMessage(error, fallback);
}

// ---------------------------------------------------------------------------
// Etiquetas de los catálogos
// ---------------------------------------------------------------------------

export const ASSET_STATUS_LABELS: Record<RealEstateAssetStatus, string> = { active: "En explotación", sold: "Vendido", closed: "Cerrado" };

export const PROTECTION_LEVEL_LABELS: Record<RealEstateProtectionLevel, string> = { none: "Sin protección", catalogado: "Catalogado", bic: "Bien de interés cultural" };

export const TENURE_KIND_LABELS: Record<RealEstateTenureKind, string> = {
  propiedad: "Propiedad",
  arrendamiento_local: "Arrendamiento de local",
  arrendamiento_industria: "Arrendamiento de industria",
  gestion: "Contrato de gestión",
  franquicia: "Franquicia",
  usufructo: "Usufructo",
  concesion: "Concesión"
};

export const TENURE_STATUS_LABELS: Record<RealEstateTenureStatus, string> = { borrador: "Borrador", vigente: "Vigente", vencido: "Vencido", resuelto: "Resuelto" };

export const TENURE_RENEWAL_LABELS: Record<RealEstateTenureRenewal, string> = { tacita: "Tácita", expresa: "Expresa", ninguna: "Sin renovación" };

export const RENT_KIND_LABELS: Record<RealEstateRentKind, string> = { fija: "Renta fija", variable: "Renta variable", mixta: "Renta mixta", minimo_garantizado: "Mínimo garantizado" };

export const RENT_VARIABLE_BASE_LABELS: Record<RealEstateRentVariableBase, string> = { gor: "Ingresos brutos (GOR)", gop: "Resultado operativo (GOP)" };

export const RENT_REVIEW_INDEX_LABELS: Record<RealEstateRentReviewIndex, string> = { ipc: "IPC", pct_fijo: "Porcentaje fijo", ninguno: "Sin revisión" };

export const COST_PAYER_LABELS: Record<RealEstateCostPayer, string> = { propietario: "Propietario", arrendatario: "Arrendatario" };

export const CAPEX_RESPONSIBILITY_LABELS: Record<RealEstateCapexResponsibility, string> = { propietario: "Propietario", arrendatario: "Arrendatario", compartido: "Compartida" };

export const UNIT_KIND_LABELS: Record<RealEstateUnitKind, string> = { finca_registral: "Finca registral", referencia_catastral: "Referencia catastral", local: "Local" };

export const USE_CODE_LABELS: Record<RealEstateUseCode, string> = { hotelero: "Hotelero", oficina: "Oficina", aparcamiento: "Aparcamiento", local: "Local comercial" };

export const TITLE_KIND_LABELS: Record<RealEstateTitleKind, string> = { pleno_dominio: "Pleno dominio", usufructo: "Usufructo", superficie: "Derecho de superficie", concesion: "Concesión", arrendamiento: "Arrendamiento" };

export const CHARGE_KIND_LABELS: Record<RealEstateChargeKind, string> = {
  hipoteca: "Hipoteca",
  embargo: "Embargo",
  servidumbre: "Servidumbre",
  afeccion_fiscal: "Afección fiscal",
  opcion: "Opción de compra",
  arrendamiento_inscrito: "Arrendamiento inscrito",
  otra: "Otra carga"
};

export const VALUATION_KIND_LABELS: Record<RealEstateValuationKind, string> = {
  eco_805: "Tasación ECO 805",
  rics: "Valoración RICS",
  interna: "Valoración interna",
  notificacion_catastral: "Notificación catastral",
  seguro: "Valor a efectos de seguro"
};

export const VALUATION_PURPOSE_LABELS: Record<RealEstateValuationPurpose, string> = { hipotecaria: "Hipotecaria", contable: "Contable", venta: "Venta", seguro: "Seguro", ibi: "IBI" };

export const TAX_KIND_LABELS: Record<PropertyTaxKind, string> = {
  ibi: "IBI",
  iae: "IAE",
  residuos: "Tasa de residuos",
  vados: "Tasa de vados",
  terrazas: "Tasa de terrazas",
  ocupacion_via_publica: "Ocupación de vía pública",
  icio: "ICIO",
  plusvalia: "Plusvalía municipal",
  otro_local: "Otro tributo local"
};

export const TAXPAYER_LABELS: Record<PropertyTaxTaxpayer, string> = { sociedad: "La sociedad", propietario_tercero: "Propietario tercero", arrendatario: "Arrendatario" };

export const TAX_PERIODICITY_LABELS: Record<PropertyTaxPeriodicity, string> = { anual: "Anual", semestral: "Semestral", trimestral: "Trimestral", mensual: "Mensual", unico: "Pago único" };

export const TAX_STATUS_LABELS: Record<PropertyTaxStatus, string> = { activo: "Activo", baja: "De baja" };

export const RECEIPT_STATUS_LABELS: Record<PropertyTaxReceiptStatus, string> = { previsto: "Previsto", recibido: "Recibido", domiciliado: "Domiciliado", pagado: "Pagado", recurrido: "Recurrido" };

export const PAID_WITH_LABELS: Record<PropertyTaxPaidWith, string> = { cash: "Efectivo", card: "Tarjeta", bank: "Banco" };

export const JOURNAL_ENTRY_STATUS_LABELS: Record<RealEstateJournalEntryStatus, string> = { draft: "Asiento en borrador", posted: "Asiento contabilizado", reversed: "Asiento anulado" };

export const DOCUMENT_CATEGORY_LABELS: Record<RealEstateDocumentCategory, string> = {
  legal: "Legal y registral",
  planos: "Planos",
  proyectos: "Proyectos",
  licencias: "Licencias",
  seguros: "Seguros",
  inspecciones: "Inspecciones",
  contratos: "Contratos",
  tributos: "Tributos",
  valoraciones: "Valoraciones",
  otros: "Otros"
};

export const DOCUMENT_KIND_LABELS: Record<RealEstateDocumentKind, string> = {
  escritura: "Escritura",
  nota_simple: "Nota simple",
  certificacion_catastral: "Certificación catastral",
  plano_planta: "Plano de planta",
  plano_instalaciones: "Plano de instalaciones",
  as_built: "Planos as built",
  proyecto: "Proyecto",
  libro_edificio: "Libro del edificio",
  licencia_actividad: "Licencia de actividad",
  licencia_obras: "Licencia de obras",
  primera_ocupacion: "Licencia de primera ocupación",
  registro_turistico: "Registro turístico",
  cee: "Certificado de eficiencia energética",
  acta_oca: "Acta de OCA",
  acta_inspeccion: "Acta de inspección",
  plan_autoproteccion: "Plan de autoprotección",
  ppcl_legionella: "Plan de prevención de legionela",
  poliza: "Póliza",
  recibo_poliza: "Recibo de póliza",
  contrato_arrendamiento: "Contrato de arrendamiento",
  contrato_gestion: "Contrato de gestión",
  contrato_mantenimiento: "Contrato de mantenimiento",
  recibo_tributo: "Recibo de tributo",
  tasacion: "Tasación",
  iee_ite: "Informe de evaluación del edificio (IEE/ITE)",
  otro: "Otro documento"
};

export const DOCUMENT_STATUS_LABELS: Record<RealEstateDocumentStatus, string> = { vigente: "Vigente", caduca_pronto: "Caduca pronto", caducado: "Caducado", sin_fecha: "Sin vigencia", sustituido: "Sustituido" };

export const CDE_STATE_LABELS: Record<RealEstateCdeState, string> = { wip: "En elaboración", compartido: "Compartido", publicado: "Publicado", archivado: "Archivado" };

export const CONFIDENTIALITY_LABELS: Record<RealEstateConfidentiality, string> = { interno: "Interno", solo_propiedad: "Solo propiedad" };

export const LINKED_ENTITY_TYPE_LABELS: Record<RealEstateLinkedEntityType, string> = {
  unit: "Unidad registral",
  tenure: "Tenencia",
  tax_receipt: "Recibo de tributo",
  inspection: "Inspección",
  insurance: "Póliza",
  capex_project: "Obra",
  fixed_asset: "Inmovilizado"
};

export const INSPECTION_KIND_LABELS: Record<RealEstateInspectionKind, string> = {
  oca_bt: "OCA de baja tensión",
  oca_ascensor: "OCA de ascensores",
  oca_pci: "OCA de protección contra incendios",
  rite: "Inspección RITE",
  gas: "Inspección de gas",
  equipos_presion: "Equipos a presión",
  legionella: "Control de legionela",
  piscina: "Piscina",
  iee_ite: "Evaluación del edificio (IEE/ITE)",
  cee: "Certificado de eficiencia energética",
  simulacro: "Simulacro de emergencia",
  otra: "Otra inspección"
};

export const INSPECTION_RESULT_LABELS: Record<RealEstateInspectionResult, string> = { favorable: "Favorable", condicionada: "Favorable con defectos", negativa: "Negativa", pendiente: "Pendiente de resultado" };

export const INSPECTION_STATUS_LABELS: Record<RealEstateInspectionStatus, string> = { programada: "Programada", realizada: "Realizada", con_defectos: "Con defectos", cerrada: "Cerrada" };

export const INSPECTION_DUE_STATE_LABELS: Record<RealEstateInspectionDueState, string> = { sin_fecha: "Sin fecha", en_plazo: "En plazo", proxima: "Próxima", vencida: "Vencida" };

export const DEFECT_SEVERITY_LABELS: Record<RealEstateDefectSeverity, string> = { leve: "Leve", grave: "Grave", muy_grave: "Muy grave" };

export const INSURANCE_KIND_LABELS: Record<RealEstateInsuranceKind, string> = {
  rc: "Responsabilidad civil",
  multirriesgo: "Multirriesgo",
  perdida_beneficios: "Pérdida de beneficios",
  decenal: "Seguro decenal",
  todo_riesgo_construccion: "Todo riesgo construcción",
  otro: "Otro seguro"
};

export const INSURANCE_STATUS_LABELS: Record<RealEstateInsuranceStatus, string> = { vigente: "Vigente", vencida: "Vencida", cancelada: "Cancelada" };

export const POLICYHOLDER_LABELS: Record<RealEstatePolicyholder, string> = { sociedad: "La sociedad", propietario_tercero: "Propietario tercero" };

export const CAPEX_WORK_KIND_LABELS: Record<CapexWorkKind, string> = {
  reforma: "Reforma",
  ampliacion: "Ampliación",
  mantenimiento_mayor: "Mantenimiento mayor",
  pip: "Plan de mejora (PIP)",
  eficiencia_energetica: "Eficiencia energética",
  accesibilidad: "Accesibilidad"
};

export const CAPEX_STATUS_LABELS: Record<CapexProjectStatus, string> = { proposed: "Propuesto", approved: "Aprobado", in_progress: "En obra", completed: "Terminado", cancelled: "Cancelado" };

export const CAPEX_EXECUTION_SOURCE_LABELS: Record<CapexExecutionSource, string> = { ledger: "Diario contable", items: "Partidas del proyecto" };

export const ALERT_KIND_LABELS: Record<RealEstateAlertKind, string> = {
  DOCUMENT_EXPIRED: "Documento caducado",
  DOCUMENT_EXPIRING: "Documento a punto de caducar",
  INSPECTION_DUE: "Inspección próxima",
  INSPECTION_OVERDUE: "Inspección vencida",
  INSPECTION_NEGATIVE_OPEN: "Inspección negativa sin subsanar",
  INSURANCE_EXPIRING: "Póliza a punto de vencer",
  TENURE_NOTICE: "Preaviso de la tenencia",
  RENT_REVIEW: "Revisión de renta",
  TAX_DUE: "Tributo próximo a vencer",
  TAX_OVERDUE: "Tributo vencido",
  CAPEX_LICENCE_MISSING: "Obra sin licencia"
};

export const ALERT_SEVERITY_LABELS: Record<RealEstateAlertSeverity, string> = { alta: "Alta", media: "Media", baja: "Baja" };

export const ALERT_ENTITY_TYPE_LABELS: Record<RealEstateAlertEntityType, string> = {
  real_estate_document: "Documento",
  real_estate_inspection: "Inspección",
  real_estate_insurance: "Póliza",
  real_estate_tenure: "Tenencia",
  property_tax_receipt: "Recibo de tributo",
  property_tax: "Tributo",
  capex_project: "Obra"
};

/** Un catálogo compartido con su mapa de etiquetas (para el test «cada valor tiene etiqueta» y los selectores). */
export type RealEstateCatalog = { name: string; values: readonly string[]; labels: Readonly<Record<string, string>> };

export const REAL_ESTATE_CATALOGS: readonly RealEstateCatalog[] = Object.freeze([
  { name: "assetStatus", values: REAL_ESTATE_ASSET_STATUSES, labels: ASSET_STATUS_LABELS },
  { name: "protectionLevel", values: REAL_ESTATE_PROTECTION_LEVELS, labels: PROTECTION_LEVEL_LABELS },
  { name: "tenureKind", values: REAL_ESTATE_TENURE_KINDS, labels: TENURE_KIND_LABELS },
  { name: "tenureStatus", values: REAL_ESTATE_TENURE_STATUSES, labels: TENURE_STATUS_LABELS },
  { name: "tenureRenewal", values: REAL_ESTATE_TENURE_RENEWALS, labels: TENURE_RENEWAL_LABELS },
  { name: "rentKind", values: REAL_ESTATE_RENT_KINDS, labels: RENT_KIND_LABELS },
  { name: "rentVariableBase", values: REAL_ESTATE_RENT_VARIABLE_BASES, labels: RENT_VARIABLE_BASE_LABELS },
  { name: "rentReviewIndex", values: REAL_ESTATE_RENT_REVIEW_INDEXES, labels: RENT_REVIEW_INDEX_LABELS },
  { name: "costPayer", values: REAL_ESTATE_COST_PAYERS, labels: COST_PAYER_LABELS },
  { name: "capexResponsibility", values: REAL_ESTATE_CAPEX_RESPONSIBILITIES, labels: CAPEX_RESPONSIBILITY_LABELS },
  { name: "unitKind", values: REAL_ESTATE_UNIT_KINDS, labels: UNIT_KIND_LABELS },
  { name: "useCode", values: REAL_ESTATE_USE_CODES, labels: USE_CODE_LABELS },
  { name: "titleKind", values: REAL_ESTATE_TITLE_KINDS, labels: TITLE_KIND_LABELS },
  { name: "chargeKind", values: REAL_ESTATE_CHARGE_KINDS, labels: CHARGE_KIND_LABELS },
  { name: "valuationKind", values: REAL_ESTATE_VALUATION_KINDS, labels: VALUATION_KIND_LABELS },
  { name: "valuationPurpose", values: REAL_ESTATE_VALUATION_PURPOSES, labels: VALUATION_PURPOSE_LABELS },
  { name: "taxKind", values: PROPERTY_TAX_KINDS, labels: TAX_KIND_LABELS },
  { name: "taxpayer", values: PROPERTY_TAX_TAXPAYERS, labels: TAXPAYER_LABELS },
  { name: "taxPeriodicity", values: PROPERTY_TAX_PERIODICITIES, labels: TAX_PERIODICITY_LABELS },
  { name: "taxStatus", values: PROPERTY_TAX_STATUSES, labels: TAX_STATUS_LABELS },
  { name: "receiptStatus", values: PROPERTY_TAX_RECEIPT_STATUSES, labels: RECEIPT_STATUS_LABELS },
  { name: "paidWith", values: PROPERTY_TAX_PAID_WITH, labels: PAID_WITH_LABELS },
  { name: "journalEntryStatus", values: REAL_ESTATE_JOURNAL_ENTRY_STATUSES, labels: JOURNAL_ENTRY_STATUS_LABELS },
  { name: "documentCategory", values: REAL_ESTATE_DOCUMENT_CATEGORIES, labels: DOCUMENT_CATEGORY_LABELS },
  { name: "documentKind", values: REAL_ESTATE_DOCUMENT_KINDS, labels: DOCUMENT_KIND_LABELS },
  { name: "documentStatus", values: REAL_ESTATE_DOCUMENT_STATUSES, labels: DOCUMENT_STATUS_LABELS },
  { name: "cdeState", values: REAL_ESTATE_CDE_STATES, labels: CDE_STATE_LABELS },
  { name: "confidentiality", values: REAL_ESTATE_CONFIDENTIALITIES, labels: CONFIDENTIALITY_LABELS },
  { name: "linkedEntityType", values: REAL_ESTATE_LINKED_ENTITY_TYPES, labels: LINKED_ENTITY_TYPE_LABELS },
  { name: "inspectionKind", values: REAL_ESTATE_INSPECTION_KINDS, labels: INSPECTION_KIND_LABELS },
  { name: "inspectionResult", values: REAL_ESTATE_INSPECTION_RESULTS, labels: INSPECTION_RESULT_LABELS },
  { name: "inspectionStatus", values: REAL_ESTATE_INSPECTION_STATUSES, labels: INSPECTION_STATUS_LABELS },
  { name: "inspectionDueState", values: REAL_ESTATE_INSPECTION_DUE_STATES, labels: INSPECTION_DUE_STATE_LABELS },
  { name: "defectSeverity", values: REAL_ESTATE_DEFECT_SEVERITIES, labels: DEFECT_SEVERITY_LABELS },
  { name: "insuranceKind", values: REAL_ESTATE_INSURANCE_KINDS, labels: INSURANCE_KIND_LABELS },
  { name: "insuranceStatus", values: REAL_ESTATE_INSURANCE_STATUSES, labels: INSURANCE_STATUS_LABELS },
  { name: "policyholder", values: REAL_ESTATE_POLICYHOLDERS, labels: POLICYHOLDER_LABELS },
  { name: "capexWorkKind", values: CAPEX_WORK_KINDS, labels: CAPEX_WORK_KIND_LABELS },
  { name: "capexStatus", values: CAPEX_PROJECT_STATUSES, labels: CAPEX_STATUS_LABELS },
  { name: "capexExecutionSource", values: CAPEX_EXECUTION_SOURCES, labels: CAPEX_EXECUTION_SOURCE_LABELS },
  { name: "alertKind", values: REAL_ESTATE_ALERT_KINDS, labels: ALERT_KIND_LABELS },
  { name: "alertSeverity", values: REAL_ESTATE_ALERT_SEVERITIES, labels: ALERT_SEVERITY_LABELS },
  { name: "alertEntityType", values: REAL_ESTATE_ALERT_ENTITY_TYPES, labels: ALERT_ENTITY_TYPE_LABELS }
]);

/** «nuevo_valor» → «Nuevo valor»: un código que el front aún no conoce nunca enseña el guion bajo. */
function humanise(code: string): string {
  const words = code.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : EMPTY;
}

/** Etiqueta de `labels[code]`; código desconocido humanizado; null / vacío → «—». */
export function catalogLabel(labels: Readonly<Record<string, string>>, code: string | null | undefined): string {
  const raw = typeof code === "string" ? code.trim() : "";
  if (!raw) return EMPTY;
  return Object.hasOwn(labels, raw) ? labels[raw] : humanise(raw);
}

/** Opciones `{ value, label }` de un catálogo para CocoaSelect, en el orden del catálogo compartido. */
export function catalogOptions<T extends string>(values: readonly T[], labels: Readonly<Record<T, string>>): Array<{ value: T; label: string }> {
  return values.map((value) => ({ value, label: labels[value] }));
}

export const assetStatusLabel = (code: string | null | undefined): string => catalogLabel(ASSET_STATUS_LABELS, code);
export const protectionLevelLabel = (code: string | null | undefined): string => catalogLabel(PROTECTION_LEVEL_LABELS, code);
export const tenureKindLabel = (code: string | null | undefined): string => catalogLabel(TENURE_KIND_LABELS, code);
export const tenureStatusLabel = (code: string | null | undefined): string => catalogLabel(TENURE_STATUS_LABELS, code);
export const tenureRenewalLabel = (code: string | null | undefined): string => catalogLabel(TENURE_RENEWAL_LABELS, code);
export const rentKindLabel = (code: string | null | undefined): string => catalogLabel(RENT_KIND_LABELS, code);
export const rentVariableBaseLabel = (code: string | null | undefined): string => catalogLabel(RENT_VARIABLE_BASE_LABELS, code);
export const rentReviewIndexLabel = (code: string | null | undefined): string => catalogLabel(RENT_REVIEW_INDEX_LABELS, code);
export const costPayerLabel = (code: string | null | undefined): string => catalogLabel(COST_PAYER_LABELS, code);
export const capexResponsibilityLabel = (code: string | null | undefined): string => catalogLabel(CAPEX_RESPONSIBILITY_LABELS, code);
export const unitKindLabel = (code: string | null | undefined): string => catalogLabel(UNIT_KIND_LABELS, code);
export const useCodeLabel = (code: string | null | undefined): string => catalogLabel(USE_CODE_LABELS, code);
export const titleKindLabel = (code: string | null | undefined): string => catalogLabel(TITLE_KIND_LABELS, code);
export const chargeKindLabel = (code: string | null | undefined): string => catalogLabel(CHARGE_KIND_LABELS, code);
export const valuationKindLabel = (code: string | null | undefined): string => catalogLabel(VALUATION_KIND_LABELS, code);
export const valuationPurposeLabel = (code: string | null | undefined): string => catalogLabel(VALUATION_PURPOSE_LABELS, code);
export const taxKindLabel = (code: string | null | undefined): string => catalogLabel(TAX_KIND_LABELS, code);
export const taxpayerLabel = (code: string | null | undefined): string => catalogLabel(TAXPAYER_LABELS, code);
export const taxPeriodicityLabel = (code: string | null | undefined): string => catalogLabel(TAX_PERIODICITY_LABELS, code);
export const taxStatusLabel = (code: string | null | undefined): string => catalogLabel(TAX_STATUS_LABELS, code);
export const receiptStatusLabel = (code: string | null | undefined): string => catalogLabel(RECEIPT_STATUS_LABELS, code);
export const paidWithLabel = (code: string | null | undefined): string => catalogLabel(PAID_WITH_LABELS, code);
export const journalEntryStatusLabel = (code: string | null | undefined): string => catalogLabel(JOURNAL_ENTRY_STATUS_LABELS, code);
export const documentCategoryLabel = (code: string | null | undefined): string => catalogLabel(DOCUMENT_CATEGORY_LABELS, code);
export const documentKindLabel = (code: string | null | undefined): string => catalogLabel(DOCUMENT_KIND_LABELS, code);
export const documentStatusLabel = (code: string | null | undefined): string => catalogLabel(DOCUMENT_STATUS_LABELS, code);
export const cdeStateLabel = (code: string | null | undefined): string => catalogLabel(CDE_STATE_LABELS, code);
export const confidentialityLabel = (code: string | null | undefined): string => catalogLabel(CONFIDENTIALITY_LABELS, code);
export const linkedEntityTypeLabel = (code: string | null | undefined): string => catalogLabel(LINKED_ENTITY_TYPE_LABELS, code);
export const inspectionKindLabel = (code: string | null | undefined): string => catalogLabel(INSPECTION_KIND_LABELS, code);
export const inspectionResultLabel = (code: string | null | undefined): string => catalogLabel(INSPECTION_RESULT_LABELS, code);
export const inspectionStatusLabel = (code: string | null | undefined): string => catalogLabel(INSPECTION_STATUS_LABELS, code);
export const inspectionDueStateLabel = (code: string | null | undefined): string => catalogLabel(INSPECTION_DUE_STATE_LABELS, code);
export const defectSeverityLabel = (code: string | null | undefined): string => catalogLabel(DEFECT_SEVERITY_LABELS, code);
export const insuranceKindLabel = (code: string | null | undefined): string => catalogLabel(INSURANCE_KIND_LABELS, code);
export const insuranceStatusLabel = (code: string | null | undefined): string => catalogLabel(INSURANCE_STATUS_LABELS, code);
export const policyholderLabel = (code: string | null | undefined): string => catalogLabel(POLICYHOLDER_LABELS, code);
export const capexWorkKindLabel = (code: string | null | undefined): string => catalogLabel(CAPEX_WORK_KIND_LABELS, code);
export const capexStatusLabel = (code: string | null | undefined): string => catalogLabel(CAPEX_STATUS_LABELS, code);
export const capexExecutionSourceLabel = (code: string | null | undefined): string => catalogLabel(CAPEX_EXECUTION_SOURCE_LABELS, code);
export const alertKindLabel = (code: string | null | undefined): string => catalogLabel(ALERT_KIND_LABELS, code);
export const alertSeverityLabel = (code: string | null | undefined): string => catalogLabel(ALERT_SEVERITY_LABELS, code);
export const alertEntityTypeLabel = (code: string | null | undefined): string => catalogLabel(ALERT_ENTITY_TYPE_LABELS, code);

// ---------------------------------------------------------------------------
// Tonos Cocoa de los estados (verde · ámbar · rojo · gris)
// ---------------------------------------------------------------------------

/** Vigencia derivada del documento: verde vigente · ámbar caduca pronto · rojo caducado · gris sin fecha / sustituido. */
export const DOCUMENT_STATUS_TONES: Record<RealEstateDocumentStatus, CocoaTone> = { vigente: "success", caduca_pronto: "warning", caducado: "danger", sin_fecha: "neutral", sustituido: "neutral" };

/** Gravedad de una alerta: rojo alta · ámbar media · azul baja (sigue abierta: nunca gris). */
export const ALERT_SEVERITY_TONES: Record<RealEstateAlertSeverity, CocoaTone> = { alta: "danger", media: "warning", baja: "info" };

export const TENURE_STATUS_TONES: Record<RealEstateTenureStatus, CocoaTone> = { borrador: "neutral", vigente: "success", vencido: "danger", resuelto: "neutral" };

export const RECEIPT_STATUS_TONES: Record<PropertyTaxReceiptStatus, CocoaTone> = { previsto: "neutral", recibido: "info", domiciliado: "info", pagado: "success", recurrido: "warning" };

export const JOURNAL_ENTRY_STATUS_TONES: Record<RealEstateJournalEntryStatus, CocoaTone> = { draft: "warning", posted: "success", reversed: "danger" };

export const TAX_STATUS_TONES: Record<PropertyTaxStatus, CocoaTone> = { activo: "success", baja: "neutral" };

export const INSPECTION_RESULT_TONES: Record<RealEstateInspectionResult, CocoaTone> = { favorable: "success", condicionada: "warning", negativa: "danger", pendiente: "neutral" };

export const INSPECTION_STATUS_TONES: Record<RealEstateInspectionStatus, CocoaTone> = { programada: "info", realizada: "success", con_defectos: "warning", cerrada: "neutral" };

export const INSPECTION_DUE_STATE_TONES: Record<RealEstateInspectionDueState, CocoaTone> = { sin_fecha: "neutral", en_plazo: "success", proxima: "warning", vencida: "danger" };

export const DEFECT_SEVERITY_TONES: Record<RealEstateDefectSeverity, CocoaTone> = { leve: "info", grave: "warning", muy_grave: "danger" };

export const INSURANCE_STATUS_TONES: Record<RealEstateInsuranceStatus, CocoaTone> = { vigente: "success", vencida: "danger", cancelada: "neutral" };

export const CAPEX_STATUS_TONES: Record<CapexProjectStatus, CocoaTone> = { proposed: "neutral", approved: "info", in_progress: "accent", completed: "success", cancelled: "danger" };

export const ASSET_STATUS_TONES: Record<RealEstateAssetStatus, CocoaTone> = { active: "success", sold: "neutral", closed: "neutral" };

/** Un mapa de tonos con su catálogo (para el test «tonos por estado»: todo valor tiene tono y todo tono existe en Cocoa). */
export type RealEstateToneMap = { name: string; values: readonly string[]; tones: Readonly<Record<string, CocoaTone>> };

export const REAL_ESTATE_TONE_MAPS: readonly RealEstateToneMap[] = Object.freeze([
  { name: "documentStatus", values: REAL_ESTATE_DOCUMENT_STATUSES, tones: DOCUMENT_STATUS_TONES },
  { name: "alertSeverity", values: REAL_ESTATE_ALERT_SEVERITIES, tones: ALERT_SEVERITY_TONES },
  { name: "tenureStatus", values: REAL_ESTATE_TENURE_STATUSES, tones: TENURE_STATUS_TONES },
  { name: "receiptStatus", values: PROPERTY_TAX_RECEIPT_STATUSES, tones: RECEIPT_STATUS_TONES },
  { name: "journalEntryStatus", values: REAL_ESTATE_JOURNAL_ENTRY_STATUSES, tones: JOURNAL_ENTRY_STATUS_TONES },
  { name: "taxStatus", values: PROPERTY_TAX_STATUSES, tones: TAX_STATUS_TONES },
  { name: "inspectionResult", values: REAL_ESTATE_INSPECTION_RESULTS, tones: INSPECTION_RESULT_TONES },
  { name: "inspectionStatus", values: REAL_ESTATE_INSPECTION_STATUSES, tones: INSPECTION_STATUS_TONES },
  { name: "inspectionDueState", values: REAL_ESTATE_INSPECTION_DUE_STATES, tones: INSPECTION_DUE_STATE_TONES },
  { name: "defectSeverity", values: REAL_ESTATE_DEFECT_SEVERITIES, tones: DEFECT_SEVERITY_TONES },
  { name: "insuranceStatus", values: REAL_ESTATE_INSURANCE_STATUSES, tones: INSURANCE_STATUS_TONES },
  { name: "capexStatus", values: CAPEX_PROJECT_STATUSES, tones: CAPEX_STATUS_TONES },
  { name: "assetStatus", values: REAL_ESTATE_ASSET_STATUSES, tones: ASSET_STATUS_TONES }
]);

function toneOf(tones: Readonly<Record<string, CocoaTone>>, code: string | null | undefined): CocoaTone {
  return (code && Object.hasOwn(tones, code) ? tones[code] : undefined) ?? "neutral";
}

export const documentStatusTone = (status: string | null | undefined): CocoaTone => toneOf(DOCUMENT_STATUS_TONES, status);
export const alertSeverityTone = (severity: string | null | undefined): CocoaTone => toneOf(ALERT_SEVERITY_TONES, severity);
export const tenureStatusTone = (status: string | null | undefined): CocoaTone => toneOf(TENURE_STATUS_TONES, status);
export const journalEntryStatusTone = (status: string | null | undefined): CocoaTone => toneOf(JOURNAL_ENTRY_STATUS_TONES, status);
export const taxStatusTone = (status: string | null | undefined): CocoaTone => toneOf(TAX_STATUS_TONES, status);
export const inspectionResultTone = (result: string | null | undefined): CocoaTone => toneOf(INSPECTION_RESULT_TONES, result);
export const inspectionStatusTone = (status: string | null | undefined): CocoaTone => toneOf(INSPECTION_STATUS_TONES, status);
export const inspectionDueStateTone = (dueState: string | null | undefined): CocoaTone => toneOf(INSPECTION_DUE_STATE_TONES, dueState);
export const defectSeverityTone = (severity: string | null | undefined): CocoaTone => toneOf(DEFECT_SEVERITY_TONES, severity);
export const insuranceStatusTone = (status: string | null | undefined): CocoaTone => toneOf(INSURANCE_STATUS_TONES, status);
export const capexStatusTone = (status: string | null | undefined): CocoaTone => toneOf(CAPEX_STATUS_TONES, status);
export const assetStatusTone = (status: string | null | undefined): CocoaTone => toneOf(ASSET_STATUS_TONES, status);

/** Tono del recibo: rojo si está vencido (derivado `overdue`: sin pagar y `dueTo` pasado), si no el de su estado. */
export function receiptStatusTone(receipt: { status: string | null | undefined; overdue?: boolean | null }): CocoaTone {
  if (receipt.overdue && receipt.status !== "pagado") return "danger";
  return toneOf(RECEIPT_STATUS_TONES, receipt.status);
}

/** Etiqueta del recibo: «Vencido» cuando `overdue` y no está pagado, si no la de su estado. */
export function receiptStatusText(receipt: { status: string | null | undefined; overdue?: boolean | null }): string {
  if (receipt.overdue && receipt.status !== "pagado") return "Vencido";
  return receiptStatusLabel(receipt.status);
}

// ---------------------------------------------------------------------------
// Formateadores (lib/format.ts: es-ES, Europe/Madrid, «—» para vacíos)
// ---------------------------------------------------------------------------

/** "1.234,56 €" · null → «—». Misma función `money` que Inmovilizado (FixedAssetsScreen). */
export function formatMoney(amount: Numeric, currency?: CurrencyInput): string {
  return money(amount, currency);
}

/** "20/09/2026" · null → «—». Misma función `date` que Inmovilizado (FixedAssetsScreen). */
export function formatDay(value: DateInput): string {
  return date(value, "short");
}

/** "6,25 %" (entrada ya en unidades de porcentaje, como viajan `capRatePct`, `ratePct`…) · null → «—». */
export function formatPercent(value: Numeric, maximumFractionDigits = 2): string {
  return percent(value, { maximumFractionDigits });
}

const MONTH_DAY = /^(\d{2})-(\d{2})$/;

/** "10-01" (`MM-DD` de los periodos voluntarios y plazos) → "1 oct"; forma inválida o vacía → «—». */
export function monthDayLabel(value: string | null | undefined, year: number = new Date().getFullYear()): string {
  const match = typeof value === "string" ? MONTH_DAY.exec(value.trim()) : null;
  if (!match) return EMPTY;
  return date(`${year}-${match[1]}-${match[2]}`, "dayMonth");
}

/** "del 1 oct al 30 nov" (ventana voluntaria `MM-DD`); sin ventana → «—». */
export function monthDayRangeLabel(from: string | null | undefined, to: string | null | undefined, year?: number): string {
  const start = monthDayLabel(from, year);
  const end = monthDayLabel(to, year);
  if (start === EMPTY && end === EMPTY) return EMPTY;
  if (start === EMPTY) return `hasta el ${end}`;
  if (end === EMPTY) return `desde el ${start}`;
  return `del ${start} al ${end}`;
}
