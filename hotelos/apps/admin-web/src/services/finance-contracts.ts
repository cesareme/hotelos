// Finanzas · Tanda 6 (lote nav-services) — pure helpers shared by the finance
// clients (accountingApi · fiscalApi · payablesApi · assetsApi · treasuryApi ·
// financialStatementsApi · cashClosureApi · payrollApi · commissionsApi):
//
//   · FINANCE_ERROR_MESSAGES — every `details.code` the finance modules answer
//     with (packages/shared/src/*-types.ts: LEDGER_ERROR_CODES,
//     PAYMENT_ERROR_CODES, PosErrorCode, PayablesErrorCode, TreasuryErrorCode,
//     fiscal and gestoría codes; since Tanda T9 · T9-11 also the RBAC gates of
//     the supplier-bill approval (RBAC_SOD_CONFLICT · RBAC_LEVEL_EXCEEDED), the
//     match guard SUPPLIER_BILL_MATCH_REQUIRED and the DOCUMENT_* codes of
//     documents-types.ts, same sentences as screens/documents/documents-helpers.ts
//     DOCUMENT_ERROR_MESSAGES — copied, not imported: that module imports this
//     one, and services never import screens) → the Spanish sentence the screens show;
//   · financeErrorMessage(error) — code first, then the API message, then a
//     fallback (PSP_NOT_CONFIGURED appends `details.psp.message`,
//     PREVIOUS_PERIOD_MISSING lists `details.pendingPeriods`,
//     RBAC_LEVEL_EXCEEDED names the tiers and the pending `requestId`,
//     SUPPLIER_BILL_MATCH_REQUIRED says why: variance or pending receipts);
//   · query builders that mirror the zod query schemas of the routes (drop
//     empty values, booleans as "1"/"0", `envelope=1` on keyset lists);
//   · settlement-period helpers (`2026-Q3` · `2026-09` · `2026`) and the
//     `periods` parameter of the USALI period comparison (`from..to,from..to`);
//   · downloadFilename for Content-Disposition headers.
//
// No network, no React, no import.meta: services/__tests__/finance-contracts.test.mts
// runs this module under `node --test` (api-client.ts cannot load there).

import type { FiscalModelCode, JournalListQuery, PaymentLinkResponse, CapturedPaymentResponse, PayrollCostImportListQuery, PayrollCostReportQuery } from "@hotelos/shared";

/** Query string shape accepted by apiRequest / apiRequestBlob. */
export type FinanceQuery = Record<string, string | number | undefined>;

// ---------------------------------------------------------------------------
// details.code → mensaje
// ---------------------------------------------------------------------------

const UNBALANCED = "El asiento no cuadra: la suma del debe tiene que ser igual a la del haber.";
const SIMPLIFIED_LIMIT = "El importe supera el límite de la factura simplificada: emite una factura completa con el NIF del cliente.";

export const FINANCE_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  // --- diario y plan (LEDGER_ERROR_CODES) ---
  JOURNAL_TOO_FEW_LINES: "Un asiento necesita al menos dos líneas.",
  JOURNAL_NEGATIVE_LINE: "Las líneas del asiento no admiten importes negativos: anota el importe en la columna contraria.",
  JOURNAL_LINE_SIDE: "Cada línea lleva importe en el debe o en el haber, no en ambos.",
  JOURNAL_UNBALANCED: UNBALANCED,
  ACCOUNT_CODE_INVALID: "El código de cuenta no es válido.",
  ACCOUNT_NOT_FOUND: "La cuenta no existe en el plan contable de la organización.",
  ACCOUNT_NOT_POSTABLE: "La cuenta es una cabecera del plan: elige una subcuenta imputable.",
  ACCOUNT_CODE_EXISTS: "Ya existe una cuenta con ese código.",
  JOURNAL_SOURCE_REQUIRED: "El asiento necesita el documento de origen.",
  JOURNAL_DESCRIPTION_REQUIRED: "El concepto del asiento es obligatorio.",
  FISCAL_PERIOD_CLOSED: "El periodo contable de esa fecha está cerrado: reábrelo o cambia la fecha del asiento.",
  FISCAL_YEAR_CLOSED: "El ejercicio de esa fecha está cerrado: reábrelo en Contabilidad › Cierre de ejercicio antes de asentar.",
  JOURNAL_DRAFT_NOT_REVERSIBLE: "Un borrador no se anula: se descarta.",
  JOURNAL_REVERSAL_OF_REVERSAL: "Un asiento de anulación no se puede anular de nuevo.",
  JOURNAL_REVERSAL_REASON_REQUIRED: "Indica el motivo de la anulación.",
  CHART_NOT_PROVISIONED: "La organización no tiene plan de cuentas: provisiona la plantilla PGC Pymes hotelero antes de contabilizar.",
  INVOICE_CASH_SALE_NOT_SIMPLIFIED: "Una venta al contado del punto de venta se documenta con factura simplificada.",
  // --- IVA y modelos AEAT ---
  UNKNOWN_MODEL: "Modelo no admitido: usa 303, 390, 347, 111, 115 o 180.",
  INVALID_PERIOD: "Periodo no válido: usa un trimestre (2026-Q3), un mes (2026-09) o un año (2026).",
  // --- cobros (PAYMENT_ERROR_CODES) ---
  PSP_NOT_CONFIGURED: "No hay pasarela de pago configurada: el cobro con tarjeta en línea o enlace de pago no se puede registrar.",
  PAYMENT_REQUIRES_PSP: "Este método de cobro necesita la confirmación de la pasarela de pago.",
  IDEMPOTENCY_CONFLICT: "Ya existe un cobro con la misma clave de reintento y datos distintos.",
  PAN_NOT_ACCEPTED: "No se admite el número de tarjeta en claro: usa el token de la pasarela de pago.",
  PSP_TOKEN_REQUIRED: "Falta el token de la pasarela de pago.",
  FOLIO_CHANGED_SINCE_DRAFT: "El folio ha cambiado desde que se preparó el borrador: revisa la factura antes de emitirla.",
  ISSUER_TAX_ID_SERIES_MISMATCH: "La serie ya emitió facturas con el NIF anterior de la sociedad y no puede seguir numerando con el nuevo: cierra la serie y abre otra con distinto prefijo, o restablece el NIF anterior en Datos fiscales. Nunca se renumera.",
  SIMPLIFIED_LIMIT_EXCEEDED: SIMPLIFIED_LIMIT,
  INVOICE_NOT_ISSUED: "La factura aún no está emitida.",
  EMAIL_DELIVERY_FAILED: "El proveedor de correo no pudo entregar el mensaje.",
  PSP_WEBHOOK_REJECTED: "La notificación de la pasarela de pago no superó la verificación de firma.",
  // --- TPV, arqueo y cierre del día (PosErrorCode) ---
  POS_TICKET_CLOSED: "La comanda ya está cerrada.",
  POS_OUTLET_NOT_FOUND: "El punto de venta no existe.",
  POS_ROOM_NOT_OCCUPIED: "La habitación no está ocupada: la comanda no se puede cargar al folio.",
  CASH_CLOSURE_CLOSED: "La caja de ese punto de venta y día ya está cerrada: no admite más ventas al contado.",
  CASH_CLOSURE_EXISTS: "Ya hay un cierre de caja para ese punto de venta y día.",
  CASH_CLOSURE_NOT_OPEN: "El cierre de caja no está abierto.",
  CASH_CLOSURE_NOT_CLOSED: "Cierra la caja antes de aprobarla.",
  CASH_COUNT_MISMATCH: "El recuento por denominaciones no coincide con el efectivo contado.",
  SIMPLIFIED_INVOICE_LIMIT: SIMPLIFIED_LIMIT,
  ACCOUNT_MISSING: "Falta una cuenta del plan necesaria para asentar la venta.",
  INVALID_DATE: "La fecha no es válida.",
  WINDOW_PARAMS_CONFLICT: "Indica una fecha o un intervalo, no ambos.",
  NIGHT_AUDIT_ALREADY_COMPLETED: "El cierre del día de esa fecha ya se ha ejecutado.",
  NIGHT_AUDIT_IN_PROGRESS: "Hay un cierre del día en curso: espera a que termine.",
  // --- proveedores, gastos e inmovilizado (PayablesErrorCode) ---
  VALIDATION_ERROR: "Revisa los datos del formulario.",
  SUPPLIER_NIF_INVALID: "El NIF o CIF del proveedor no es válido.",
  SUPPLIER_NIF_DUPLICATE: "Ya existe un proveedor con ese NIF.",
  SUPPLIER_IBAN_INVALID: "El IBAN no es válido.",
  SUPPLIER_REQUIRED: "Indica el proveedor o su nombre.",
  SUPPLIER_NIF_REQUIRED: "El NIF del proveedor es obligatorio para deducir el IVA.",
  EXPENSE_ACCOUNT_INVALID: "La cuenta de gasto debe ser una subcuenta del grupo 6 (o 20x/21x para bienes de inversión).",
  UNSUPPORTED_TAX_RATE: "Tipo de IVA no admitido: usa 21, 10, 4, 7, 3, 2 o 0.",
  LINE_QUOTA_MISMATCH: "La cuota de IVA de la línea no coincide con la base por el tipo.",
  LINE_RETENTION_MISMATCH: "La retención de la línea no coincide con la base por el porcentaje.",
  TOTAL_MISMATCH: "El total impreso no coincide con la suma de las líneas.",
  DUE_DATE_BEFORE_ISSUE: "La fecha de vencimiento no puede ser anterior a la de emisión.",
  ISSUE_DATE_REQUIRED: "Indica la fecha de emisión.",
  PAYMENT_BEFORE_ISSUE: "La fecha de pago no puede ser anterior a la de emisión.",
  COUNTER_ACCOUNT_INVALID: "La cuenta de contrapartida no es válida: usa 572, 570 o una subcuenta de 572.",
  SUPPLIER_BILL_DUPLICATE: "Ya existe una factura de ese proveedor con el mismo número.",
  INVALID_STATUS_TRANSITION: "El estado actual del documento no admite esa acción.",
  BILL_HAS_FIXED_ASSETS: "La factura tiene elementos de inmovilizado asociados: da de baja los elementos antes de anularla.",
  ATTACHMENT_INVALID: "El adjunto debe ser un PDF, JPEG o PNG.",
  ATTACHMENT_TOO_LARGE: "El adjunto supera los 512 KiB.",
  EXPENSE_VAT_NOT_DEDUCTIBLE_WITHOUT_NIF: "Sin NIF del proveedor el IVA del gasto no es deducible.",
  ASSET_CATEGORY_REQUIRED: "Indica la categoría o la cuenta del elemento.",
  ASSET_ACCOUNT_INVALID: "La cuenta del inmovilizado debe ser 20x o 21x.",
  COEFFICIENT_REQUIRED: "Indica el coeficiente de amortización.",
  COEFFICIENT_ABOVE_MAX: "El coeficiente supera el máximo de las tablas del artículo 12 de la Ley del Impuesto sobre Sociedades.",
  RESIDUAL_ABOVE_COST: "El valor residual no puede superar el coste de adquisición.",
  RESIDUAL_ABOVE_NBV: "El valor residual no puede superar el valor neto contable.",
  START_BEFORE_ACQUISITION: "La amortización no puede empezar antes de la adquisición.",
  DISPOSAL_BEFORE_ACQUISITION: "La baja no puede ser anterior a la adquisición.",
  ASSET_DISPOSED: "El elemento ya está dado de baja.",
  ASSET_NOT_CONFIGURED: "El elemento no tiene categoría, coeficiente o cuentas: complétalo antes de amortizar.",
  ASSET_HAS_DEPRECIATION: "El elemento ya tiene amortización contabilizada.",
  PERIOD_INVALID: "El periodo debe tener el formato AAAA-MM.",
  PERIOD_IN_FUTURE: "No se puede amortizar un mes futuro.",
  LATER_RUN_EXISTS: "Hay una corrida posterior contabilizada: revierte primero la más reciente.",
  PREVIOUS_PERIOD_MISSING: "Faltan meses anteriores por contabilizar: las corridas van mes a mes, sin huecos.",
  UNBALANCED_ENTRY: UNBALANCED,
  INVALID_LEDGER_LINE: "Una línea del asiento no es válida.",
  ACCOUNT_NOT_IN_CHART: "La cuenta no está en el plan contable.",
  ENTRY_ALREADY_REVERSED: "El asiento ya está anulado.",
  ENTRY_NOT_FOUND: "El asiento no existe.",
  // --- tesorería, banca, comisiones y nóminas (TreasuryErrorCode) ---
  STATEMENT_ALREADY_IMPORTED: "Ese extracto ya se había importado: no se han creado movimientos duplicados.",
  LINE_ALREADY_MATCHED: "El movimiento bancario ya está conciliado.",
  DIRECTION_MISMATCH: "El signo del movimiento bancario no coincide con el del documento.",
  AMOUNT_MISMATCH: "El importe del movimiento bancario no coincide con el del documento.",
  PAYMENT_NOT_CAPTURED: "El cobro no está capturado: no se puede conciliar.",
  SUPPLIER_BILL_NOT_POSTED: "La factura recibida no está contabilizada.",
  SUPPLIER_BILL_AMOUNT_MISMATCH: "El importe de la factura recibida no coincide con el movimiento bancario.",
  REMITTANCE_STATUS_TRANSITION: "El estado de la remesa no admite ese cambio.",
  REMITTANCE_EMPTY: "La remesa no tiene operaciones.",
  COMMISSION_NOT_ACCRUED: "La comisión no está devengada.",
  COMMISSION_SETTLED: "La comisión ya está liquidada.",
  PAYROLL_PERIOD_EXISTS: "Ya existe un periodo de nómina con ese código.",
  PAYROLL_PERIOD_CLOSED: "El periodo de nómina está cerrado.",
  PAYROLL_PERIOD_PAID: "El periodo de nómina ya está pagado.",
  PAYROLL_PERIOD_NOT_CALCULATED: "Calcula el periodo de nómina antes de exportarlo o pagarlo.",
  PAYROLL_NOTHING_TO_PAY: "El periodo de nómina no tiene importe neto que pagar.",
  // --- estados y gestoría ---
  EXPORT_FORMAT_NOT_IMPLEMENTED: "Ese formato de exportación aún no está disponible: usa el CSV universal de asientos.",
  USALI_LINE_NOT_ADMITTED: "La línea no se admite en ese departamento USALI.",
  SNAPSHOT_NOT_FOUND: "No existe esa instantánea de los estados contables.",
  // --- estructura societaria (Tanda 6b: LegalStructureErrorCode, lib/finance-scope.ts, fiscal y estados) ---
  MULTI_ENTITY_NOT_ENABLED: "La organización ya tiene su sociedad: en esta versión solo hay una sociedad por organización.",
  SERIES_PREFIX_CLASH: "Otro centro de la misma sociedad ya usa ese prefijo de serie este año: elige otro prefijo (por ejemplo con el código del centro).",
  INVOICE_NUMBER_DUPLICATE: "Otro centro de la misma sociedad ya emitió una factura con ese número: la numeración es única por NIF. Revisa los prefijos de las series.",
  WORK_CENTER_CODE_REQUIRED: "La sociedad factura desde varios centros y este no tiene código: asigna un código al centro en Configuración › Estructura societaria antes de emitir.",
  SERIES_CLOSED: "La serie está cerrada y no vuelve a numerar: abre otra serie con distinto prefijo. Nunca se renumera.",
  WORK_CENTER_REQUIRED: "Indica el hotel o la oficina central: los gastos, ingresos, retenciones y nóminas llevan siempre un centro de trabajo.",
  FISCAL_YEAR_IS_ENTITY_SCOPED: "Los ejercicios contables son de la sociedad, no de un centro: quita el filtro por centro.",
  ENTITY_SCOPE_REQUIRED: "Tu perfil solo ve las finanzas de sus centros: elige un centro en «Ámbito» o pide a dirección el permiso «Finanzas de toda la sociedad».",
  PROPERTY_NOT_FOUND: "Ese centro de trabajo no existe en tu organización.",
  JOURNAL_ENTRY_NOT_FOUND: "El asiento no existe o no pertenece a tu organización.",
  PERIODICITY_FORCED_BY_REGIME: "La periodicidad la fija el régimen de la sociedad (SII o gran empresa): los modelos son mensuales mientras esté marcado.",
  ALLOCATION_WEIGHTS_REQUIRED: "El reparto por porcentajes necesita un peso por hotel.",
  ALLOCATION_DUPLICATE_PROPERTY: "Un hotel aparece dos veces en el reparto.",
  ALLOCATION_UNKNOWN_PROPERTY: "Uno de los centros del reparto no pertenece a la sociedad.",
  ALLOCATION_TARGET_NOT_HOTEL: "El reparto solo se distribuye entre hoteles, no entre oficinas u otros centros.",
  ALLOCATION_WEIGHT_INVALID: "Cada peso del reparto debe ser un número entre 0 y 100.",
  ALLOCATION_WEIGHTS_SUM: "Los pesos del reparto deben sumar 100.",
  ALLOCATION_WEIGHTS_NOT_ALLOWED: "Solo el reparto por porcentajes admite pesos; las otras claves los calculan solas.",
  HIGH_RISK_CONFIRMATION_REQUIRED: "Este cambio afecta a todas las facturas y modelos futuros de la sociedad: confírmalo expresamente para aplicarlo.",
  VERIFACTU_SUBMISSIONS_PENDING: "Hay registros VeriFactu reales sin respuesta de la AEAT: espera a que se resuelvan antes de cambiar el régimen de la sociedad.",
  VERIFACTU_EXCLUDED_BY_SII: "La sociedad está en el SII: la factura se expide sin registro VeriFactu (sin huella ni QR), como establece el RD 1007/2023.",
  LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY: "El NIF y la razón social se editan en Configuración › Estructura societaria › Datos fiscales, no en el perfil del establecimiento.",
  CODE_IN_USE: "Ese código ya está en uso: elige otro de 2 a 6 letras o números.",
  PROPERTY_KIND_CHANGE_BLOCKED: "Un hotel con habitaciones no puede pasar a oficina u otro centro.",
  PROPERTY_NAME_IN_USE: "Ya existe un centro con ese nombre en la organización.",
  WORK_CENTER_NOT_OPERATIONAL: "La oficina central no tiene operación hotelera: esa acción solo aplica a un hotel.",
  STRUCTURE_DISABLED: "La estructura societaria no está activada en este entorno.",
  TAX_ID_INVALID: "El NIF no supera el dígito de control: revísalo.",
  TAX_ID_IN_USE: "Ese NIF ya pertenece a otra sociedad.",
  CHAIN_ALREADY_STARTED: "La cadena VeriFactu ya tiene registros reales enviados: la política de cadena no se puede cambiar.",
  LEGAL_ENTITY_REQUIRED: "La organización tiene varias sociedades: elige la sociedad activa antes de continuar.",
  LEGAL_ENTITY_NOT_FOUND: "La sociedad no existe en tu organización.",
  ISSUER_TAX_ID_MISSING: "La sociedad no tiene NIF válido: complétalo en Configuración › Estructura societaria › Datos fiscales antes de emitir.",
  INSTALLATION_NOT_DECLARED: "El centro no tiene una instalación VeriFactu declarada: el envío queda en espera hasta que exista.",
  // --- coste de personal importado (Tanda 6c: PAYROLL_COST_ERROR_CODES de payroll-cost-types.ts; diseño §5.1) ---
  PAYROLL_IMPORT_INVALID: "El fichero tiene filas que no se pueden leer: revisa la cabecera, los meses (AAAA-MM) y los importes, que no admiten valores negativos.",
  PAYROLL_IMPORT_EMPTY: "El fichero no tiene líneas de coste con importe: no hay nada que contabilizar.",
  PAYROLL_IMPORT_GROUP_INVALID: "Hay grupos de coste que el ERP no reconoce: usa operaciones, extras, estructura, mantenimiento_obra o familia, o indica su equivalencia en el fichero.",
  PAYROLL_IMPORT_ORGANIZATION_MISMATCH: "El fichero pertenece a otra organización: comprueba que el informe sea el de esta sociedad.",
  PAYROLL_IMPORT_CENTRE_UNMAPPED: "Hay centros del informe sin equivalencia en el ERP: asigna cada etiqueta a un centro de trabajo antes de contabilizar.",
  PAYROLL_IMPORT_DEPARTMENT_UNMAPPED: "Hay departamentos del informe sin equivalencia USALI: asigna cada etiqueta a un departamento antes de contabilizar.",
  PAYROLL_IMPORT_NOT_FOUND: "La importación de coste de personal no existe o no pertenece a tu organización.",
  PAYROLL_IMPORT_DUPLICATE: "Ese informe ya está importado con el mismo contenido: revierte el lote anterior o marca «Sustituir los lotes anteriores» para reemplazarlo.",
  PAYROLL_IMPORT_OVERLAP: "Algún centro y mes del informe ya está contabilizado por otro lote: marca «Sustituir los lotes anteriores» para revertirlos enteros y volver a importar el rango completo.",
  PAYROLL_MODE_CONFLICT: "Ese centro y mes ya tiene nómina calculada aprobada por dirección (modo calculado): el lote importado no se contabiliza; revisa qué nómina es la buena antes de seguir.",
  PAYROLL_IMPORT_ALREADY_POSTED: "La importación ya está contabilizada: no se contabiliza dos veces.",
  PAYROLL_IMPORT_REVERSED: "La importación está revertida: vuelve a importar el informe para contabilizarlo de nuevo.",
  PAYROLL_IMPORT_ENTRY_EXISTS: "Ya existe un asiento con el mismo origen para ese centro y mes: no se ha contabilizado nada.",
  // --- aprobación de facturas recibidas (Tanda 8a · RBAC por departamento; T9-11): quién y hasta qué tramo ---
  RBAC_SOD_CONFLICT: "Quien registró la factura no puede aprobarla ni pagarla: otra persona con la clave de aprobación debe hacerlo.",
  RBAC_LEVEL_EXCEEDED: "El importe supera tu tramo de aprobación: pide autorización a un supervisor presente o abre la solicitud en Hoy › Pendientes de aprobación.",
  // --- documentos y digitalización (Tanda T9: DOCUMENT_ERROR_CODES de documents-types.ts; los códigos ya presentes arriba conservan su frase) ---
  DOCUMENT_MIME_NOT_ALLOWED: "Tipo de fichero no admitido: sube un PDF, una imagen (JPEG, PNG, WebP) o una factura electrónica XML.",
  DOCUMENT_CONTENT_MISMATCH: "El contenido del fichero no corresponde con su tipo: vuelve a exportarlo o escanéalo de nuevo.",
  DOCUMENT_ACTION_INVALID_FOR_KIND: "Esa acción no vale para este tipo de documento: corrige el tipo o elige otra acción.",
  DOCUMENT_NOT_FOUND: "El documento no existe o no pertenece a este centro.",
  DOCUMENT_DUPLICATE_FILE: "Este fichero ya está capturado (mismo contenido): abre el documento existente o marca la copia como permitida.",
  DOCUMENT_STATUS_TRANSITION: "El documento no admite esa acción en su estado actual.",
  DOCUMENT_BLOCKED: "El documento está bloqueado por retención: solo un administrador de documentos puede consultarlo.",
  DOCUMENT_LEGAL_HOLD: "El documento tiene bloqueo legal: no se puede purgar ni desbloquear sin retirarlo.",
  DOCUMENT_CHECKS_FAILED: "Hay comprobaciones en rojo: corrígelas o aprueba con un motivo explícito.",
  GOODS_RECEIPT_DUPLICATE: "Ya existe una recepción con ese número de albarán para el proveedor.",
  SUPPLIER_BILL_MATCH_REQUIRED: "La factura necesita cotejarse con sus albaranes antes de aprobarse.",
  DOCUMENT_TOO_LARGE: "El fichero supera el tamaño máximo admitido: comprímelo o divide el documento.",
  AI_PROVIDER_UNAVAILABLE: "El proveedor de IA no está disponible: los campos se rellenan a mano o con el extractor de texto.",
  DOCUMENT_PAGE_IMAGE_UNAVAILABLE: "Esta página no tiene imagen: el original no está rasterizado, ábrelo con «Ver original».",
  // --- recepciones de mercancía (T9-09: códigos 400 de goods-receipts.service.ts) ---
  INVENTORY_ITEM_INVALID: "El artículo de inventario de la línea no existe en este centro.",
  STOCK_LOCATION_INVALID: "La ubicación de almacén no existe en este centro.",
  STOCK_QUANTITY_TOO_SMALL: "La cantidad recibida es demasiado pequeña para anotar un movimiento de almacén: redondea a dos decimales."
});

export const FINANCE_ERROR_FALLBACK = "No se pudo completar la operación. Inténtalo de nuevo.";

type ErrorLike = { message?: unknown; details?: unknown; status?: unknown };

function asErrorLike(error: unknown): ErrorLike | null {
  return typeof error === "object" && error !== null ? (error as ErrorLike) : null;
}

/** `details.code` of a typed 4xx (ApiError or any `{ details: { code } }`), or null. */
export function financeErrorCode(error: unknown): string | null {
  const details = financeErrorDetails(error);
  const code = details?.code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** `details` object of a typed 4xx, or null. */
export function financeErrorDetails(error: unknown): Record<string, unknown> | null {
  const details = asErrorLike(error)?.details;
  return typeof details === "object" && details !== null ? (details as Record<string, unknown>) : null;
}

/** HTTP status of an ApiError-like error, or null. */
export function financeErrorStatus(error: unknown): number | null {
  const status = asErrorLike(error)?.status;
  return typeof status === "number" ? status : null;
}

export function hasFinanceErrorCode(error: unknown, code: string): boolean {
  return financeErrorCode(error) === code;
}

/**
 * Spanish message for a finance error: the dictionary sentence of
 * `details.code` (with the PSP note or the pending months when the API sends
 * them), otherwise the API message, otherwise `fallback`.
 */
export function financeErrorMessage(error: unknown, fallback: string = FINANCE_ERROR_FALLBACK): string {
  const code = financeErrorCode(error);
  const details = financeErrorDetails(error);
  if (code && FINANCE_ERROR_MESSAGES[code]) {
    const base = FINANCE_ERROR_MESSAGES[code];
    if (code === "PSP_NOT_CONFIGURED") {
      const psp = details?.psp;
      const note = typeof psp === "object" && psp !== null ? (psp as { message?: unknown }).message : undefined;
      return typeof note === "string" && note.trim() ? `${base} ${note.trim()}` : base;
    }
    if (code === "PREVIOUS_PERIOD_MISSING") {
      const pending = details?.pendingPeriods;
      return Array.isArray(pending) && pending.length > 0 ? `${base} Contabiliza antes: ${pending.map(String).join(", ")}.` : base;
    }
    if (code === "RBAC_LEVEL_EXCEEDED" || code === "SUPPLIER_BILL_MATCH_REQUIRED") return withApprovalDetails(code, base, details);
    return withStructureDetails(code, base, details);
  }
  const message = asErrorLike(error)?.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
}

function detailString(details: Record<string, unknown> | null, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Tanda T9 (T9-11): the approval gates of a supplier bill carry what the
 * approver needs to act — RBAC_LEVEL_EXCEEDED names the tier of the amount and
 * the caller's maximum (`tier` · `maxTier`) and, when the engine already holds a
 * pending request, its `requestId` (Hoy › Pendientes de aprobación);
 * SUPPLIER_BILL_MATCH_REQUIRED says why (`reason` variance · pending_receipts,
 * `pendingReceipts`). Pure; unit-tested with payables-helpers.
 */
export function withApprovalDetails(code: string, base: string, details: Record<string, unknown> | null): string {
  switch (code) {
    case "RBAC_LEVEL_EXCEEDED": {
      const tier = detailString(details, "tier");
      const maxTier = detailString(details, "maxTier");
      const requestId = detailString(details, "requestId");
      const parts = [tier && maxTier ? `Tramo del importe: ${tier}; tu tramo máximo: ${maxTier}.` : null, requestId ? `Solicitud pendiente: ${requestId}.` : null].filter(Boolean);
      return parts.length > 0 ? `${base} ${parts.join(" ")}` : base;
    }
    case "SUPPLIER_BILL_MATCH_REQUIRED": {
      const reason = detailString(details, "reason");
      if (reason === "variance") return `${base} El cotejo tiene diferencias fuera de tolerancia: resuélvelas con el albarán antes de aprobar.`;
      if (reason === "pending_receipts") {
        const pending = details?.pendingReceipts;
        const count = typeof pending === "number" && Number.isFinite(pending) ? pending : null;
        return count !== null ? `${base} El proveedor tiene ${count} ${count === 1 ? "albarán pendiente" : "albaranes pendientes"} de cotejar y la factura lleva líneas de compra.` : `${base} El proveedor tiene albaranes pendientes de cotejar.`;
      }
      return base;
    }
    default:
      return base;
  }
}

/**
 * Tanda 6b: the structure codes carry the datum the sentence needs — the
 * clashing `prefix` (SERIES_PREFIX_CLASH · INVOICE_NUMBER_DUPLICATE ·
 * ISSUER_TAX_ID_SERIES_MISMATCH), the `screen` / `legalIdentityScreen` /
 * `seriesScreen` the API names, the high-risk `fields`, the VeriFactu
 * exclusion `motivo`. Pure; unit-tested.
 */
export function withStructureDetails(code: string, base: string, details: Record<string, unknown> | null): string {
  switch (code) {
    case "SERIES_PREFIX_CLASH":
    case "INVOICE_NUMBER_DUPLICATE": {
      const prefix = detailString(details, "prefix");
      return prefix ? `${base} Prefijo en conflicto: ${prefix}.` : base;
    }
    case "ISSUER_TAX_ID_SERIES_MISMATCH": {
      const prefix = detailString(details, "prefix");
      const legalIdentityScreen = detailString(details, "legalIdentityScreen");
      const seriesScreen = detailString(details, "seriesScreen");
      const parts = [prefix ? `Serie afectada: ${prefix}.` : null, seriesScreen ? `Series: ${seriesScreen}.` : null, legalIdentityScreen ? `Datos fiscales: ${legalIdentityScreen}.` : null].filter(Boolean);
      return parts.length > 0 ? `${base} ${parts.join(" ")}` : base;
    }
    case "WORK_CENTER_CODE_REQUIRED": {
      const screen = detailString(details, "screen");
      return screen ? `${base} Pantalla: ${screen}.` : base;
    }
    case "LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY": {
      const route = detailString(details, "route");
      return route ? `${base} Ruta: ${route}.` : base;
    }
    case "HIGH_RISK_CONFIRMATION_REQUIRED": {
      const fields = details?.fields;
      return Array.isArray(fields) && fields.length > 0 ? `${base} Campos: ${fields.map(String).join(", ")}.` : base;
    }
    case "VERIFACTU_EXCLUDED_BY_SII": {
      const motivo = detailString(details, "motivo");
      return motivo ? `${base} ${motivo}` : base;
    }
    case "ENTITY_SCOPE_REQUIRED": {
      const permission = detailString(details, "requiredPermission");
      return permission ? `${base} Permiso: ${permission}.` : base;
    }
    default:
      return base;
  }
}

/** The opaque 404 the finance readers answer when the sociedad scope is outside the caller's grants (R11). */
export function isEntityScopeRequired(error: unknown): boolean {
  return financeErrorCode(error) === "ENTITY_SCOPE_REQUIRED";
}

/** Prefix the API puts on the invoice warning when the sociedad is in the SII (fix t6b#2). */
export const VERIFACTU_EXCLUDED_WARNING_PREFIX = "VERIFACTU_EXCLUDED_BY_SII:";

/** The SII exclusion sentence of an issued document's warnings, or null (also accepts the `issuer.verifactuExclusion` block). */
export function verifactuExclusionText(input: { warnings?: readonly string[] | null; verifactuExclusion?: { motivo?: string | null } | null } | null | undefined): string | null {
  const direct = input?.verifactuExclusion?.motivo;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const warning = (input?.warnings ?? []).find((row) => typeof row === "string" && row.startsWith(VERIFACTU_EXCLUDED_WARNING_PREFIX));
  if (!warning) return null;
  const text = warning.slice(VERIFACTU_EXCLUDED_WARNING_PREFIX.length).trim();
  return text || FINANCE_ERROR_MESSAGES.VERIFACTU_EXCLUDED_BY_SII;
}

// ---------------------------------------------------------------------------
// Query builders (mirror the zod query schemas: unknown keys are 400)
// ---------------------------------------------------------------------------

/** Drop undefined / null / "" values; booleans travel as "1" / "0" (accepted by every flag schema of the finance routes). */
export function compactQuery(input: Record<string, string | number | boolean | null | undefined>): FinanceQuery {
  const out: FinanceQuery = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = typeof value === "boolean" ? (value ? "1" : "0") : value;
  }
  return out;
}

/** GET /accounting/journal — always `envelope=1` so the answer is `{ items, nextCursor, total }`. */
export function journalQuery(query: JournalListQuery = {}): FinanceQuery {
  return compactQuery({
    from: query.from,
    to: query.to,
    propertyId: query.propertyId,
    sourceType: query.sourceType,
    status: query.status,
    accountCode: query.accountCode,
    q: query.q,
    limit: query.limit,
    cursor: query.cursor ?? undefined,
    envelope: "1"
  });
}

export type LedgerQueryInput = { from?: string; to?: string; propertyId?: string };

/** GET /accounting/ledger/:accountCode (`format=csv` only through downloadLedgerCsv). */
export function ledgerQuery(query: LedgerQueryInput = {}, format?: "json" | "csv"): FinanceQuery {
  return compactQuery({ from: query.from, to: query.to, propertyId: query.propertyId, format });
}

/** GET /accounting/chart — `postableOnly` for account pickers (headers excluded). */
export function chartQuery(options: { postableOnly?: boolean } = {}): FinanceQuery {
  return compactQuery({ postableOnly: options.postableOnly });
}

// ---- fiscal -----------------------------------------------------------------

/** Annual models take `year=AAAA`; the rest take a settlement `period`. */
export const ANNUAL_FISCAL_MODELS: readonly FiscalModelCode[] = ["390", "347", "180"];

export function isAnnualFiscalModel(modelo: FiscalModelCode | string): boolean {
  return (ANNUAL_FISCAL_MODELS as readonly string[]).includes(modelo);
}

export type FiscalModelParams = {
  /** `2026-Q3` · `2026-09` (periodic models) or `2026` (annual models). */
  period?: string;
  year?: number | string;
  propertyId?: string;
  fromDate?: string;
  toDate?: string;
  periodType?: "monthly" | "quarterly";
};

/** GET /fiscal/models/:modelo — annual models get `year` (derived from `period` when only that is given). */
export function fiscalModelQuery(modelo: FiscalModelCode | string, params: FiscalModelParams = {}): FinanceQuery {
  if (isAnnualFiscalModel(modelo)) {
    const year = params.year ?? (params.period && /^\d{4}/.test(params.period) ? params.period.slice(0, 4) : undefined);
    return compactQuery({ year: year === undefined ? undefined : String(year), propertyId: params.propertyId });
  }
  return compactQuery({ period: params.period, propertyId: params.propertyId, fromDate: params.fromDate, toDate: params.toDate, periodType: params.periodType });
}

export type VatBookQueryInput = { book: "emitidas" | "recibidas" | "bienes_inversion"; period?: string; from?: string; to?: string; propertyId?: string };

/** GET /fiscal/vat-books */
export function vatBookQuery(input: VatBookQueryInput): FinanceQuery {
  return compactQuery({ book: input.book, period: input.period, from: input.from, to: input.to, propertyId: input.propertyId });
}

// ---- periods ----------------------------------------------------------------

function toUtcDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  return new Date(day);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `2026-Q3` of a calendar day (UTC). */
export function quarterPeriod(value: Date | string): string {
  const date = toUtcDate(value);
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

/** `2026-09` of a calendar day (UTC). */
export function monthPeriod(value: Date | string): string {
  const date = toUtcDate(value);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

/** `2026` of a calendar day (UTC). */
export function yearPeriod(value: Date | string): string {
  return String(toUtcDate(value).getUTCFullYear());
}

export type PeriodBounds = { code: string; type: "quarterly" | "monthly" | "annual"; from: string; to: string };

/** Inclusive calendar bounds of a settlement period code, or null when the code is not `AAAA-Qn` · `AAAA-MM` · `AAAA`. */
export function periodBounds(code: string): PeriodBounds | null {
  const trimmed = code.trim();
  const quarter = /^(\d{4})-Q([1-4])$/.exec(trimmed);
  if (quarter) {
    const year = Number(quarter[1]);
    const q = Number(quarter[2]);
    const firstMonth = (q - 1) * 3 + 1;
    const lastDay = new Date(Date.UTC(year, firstMonth + 2, 0)).getUTCDate();
    return { code: trimmed, type: "quarterly", from: `${year}-${pad2(firstMonth)}-01`, to: `${year}-${pad2(firstMonth + 2)}-${pad2(lastDay)}` };
  }
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(trimmed);
  if (month) {
    const year = Number(month[1]);
    const m = Number(month[2]);
    const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
    return { code: trimmed, type: "monthly", from: `${year}-${pad2(m)}-01`, to: `${year}-${pad2(m)}-${pad2(lastDay)}` };
  }
  const year = /^(\d{4})$/.exec(trimmed);
  if (year) return { code: trimmed, type: "annual", from: `${year[1]}-01-01`, to: `${year[1]}-12-31` };
  return null;
}

/** Previous settlement period of the same type (`2026-Q1` → `2025-Q4`, `2026-01` → `2025-12`, `2026` → `2025`). */
export function previousPeriod(code: string): string | null {
  const bounds = periodBounds(code);
  if (!bounds) return null;
  const from = toUtcDate(bounds.from);
  if (bounds.type === "quarterly") return quarterPeriod(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 3, 1)));
  if (bounds.type === "monthly") return monthPeriod(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1)));
  return String(from.getUTCFullYear() - 1);
}

// ---- estados financieros ----------------------------------------------------

export type StatementWindow = { from?: string; to?: string; propertyId?: string };
export type StatementDownloadFormat = "json" | "pdf" | "xlsx" | "csv";

/** GET /accounting/usali/pnl · /mappings · /coverage */
export function statementWindowQuery(window: StatementWindow = {}, format?: StatementDownloadFormat): FinanceQuery {
  return compactQuery({ from: window.from, to: window.to, propertyId: window.propertyId, format });
}

/** `periods=2026-01-01..2026-03-31,2026-04-01..2026-06-30` of GET /accounting/usali/periods (the first one is the base). */
export function usaliPeriodsParam(periods: ReadonlyArray<{ from: string; to: string }>): string {
  return periods.map((period) => `${period.from}..${period.to}`).join(",");
}

export type AnnualAccountsQueryInput = StatementWindow & { fiscalYearId?: string; comparative?: boolean };

/** GET /accounting/annual-accounts[/balance|/pyg|/ecpn|/memoria] */
export function annualAccountsQuery(input: AnnualAccountsQueryInput = {}, format?: StatementDownloadFormat): FinanceQuery {
  return compactQuery({ fiscalYearId: input.fiscalYearId, from: input.from, to: input.to, propertyId: input.propertyId, comparative: input.comparative, format });
}

// ---- proveedores, gastos e inmovilizado -------------------------------------

export type SupplierListInput = { q?: string; active?: boolean; limit?: number };
export function supplierListQuery(input: SupplierListInput = {}): FinanceQuery {
  // The route's boolQuery accepts "true" | "false" | "1" | "0".
  return compactQuery({ q: input.q, active: input.active === undefined ? undefined : input.active ? "true" : "false", limit: input.limit });
}

export type SupplierBillListInput = { status?: "draft" | "approved" | "posted" | "paid" | "cancelled"; supplierId?: string; from?: string; to?: string; dueBefore?: string; q?: string; limit?: number };
export function supplierBillListQuery(input: SupplierBillListInput = {}): FinanceQuery {
  return compactQuery({ status: input.status, supplierId: input.supplierId, from: input.from, to: input.to, dueBefore: input.dueBefore, q: input.q, limit: input.limit });
}

export type ExpenseListInput = { from?: string; to?: string; paidWith?: "cash" | "card" | "bank"; includeCancelled?: boolean; q?: string; limit?: number };
export function expenseListQuery(input: ExpenseListInput = {}): FinanceQuery {
  return compactQuery({ from: input.from, to: input.to, paidWith: input.paidWith, includeCancelled: input.includeCancelled, q: input.q, limit: input.limit });
}

export type FixedAssetListInput = { status?: "active" | "fully_depreciated" | "disposed"; q?: string; limit?: number };
export function fixedAssetListQuery(input: FixedAssetListInput = {}): FinanceQuery {
  return compactQuery({ status: input.status, q: input.q, limit: input.limit });
}

// ---- tesorería ----------------------------------------------------------------

/** A centre (`propertyId`) or the whole sociedad (`scope: "entity"`, Tanda 6b: `GET /treasury/*?scope=entity`). */
export type TreasuryScope = { propertyId?: string; asOf?: string; scope?: "entity" | "property" };
export function treasuryScopeQuery(scope: TreasuryScope = {}): FinanceQuery {
  // The sociedad scope never sends a propertyId (the route would read the centre first).
  if (scope.scope === "entity") return compactQuery({ scope: "entity", asOf: scope.asOf });
  return compactQuery({ propertyId: scope.propertyId, asOf: scope.asOf });
}

// ---- nóminas · coste de personal importado (Tanda 6c) ------------------------

/** GET /payroll/cost-report — `from` / `to` are «AAAA-MM» (≤ 24 meses); sin `propertyId` = toda la sociedad; `group` filtra solo las líneas de coste. */
export function payrollCostReportQuery(query: PayrollCostReportQuery): FinanceQuery {
  return compactQuery({ from: query.from, to: query.to, propertyId: query.propertyId, group: query.group });
}

/** GET /payroll/cost-imports — `from` / `to` solapan con el periodo del lote; `limit` 1..200. */
export function payrollCostImportListQuery(query: PayrollCostImportListQuery = {}): FinanceQuery {
  return compactQuery({ organizationId: query.organizationId, status: query.status, from: query.from, to: query.to, limit: query.limit });
}

// ---- TPV y arqueo -----------------------------------------------------------

export type PosTicketsInput = { status?: "open" | "closed" | "all"; closedFrom?: string; limit?: number };
export function posTicketsQuery(input: PosTicketsInput = {}): FinanceQuery {
  return compactQuery({ status: input.status, closedFrom: input.closedFrom, limit: input.limit });
}

export type CashClosureListInput = { status?: "open" | "closed" | "approved"; outletId?: string; from?: string; to?: string; limit?: number };
export function cashClosureListQuery(input: CashClosureListInput = {}): FinanceQuery {
  return compactQuery({ status: input.status, outletId: input.outletId, from: input.from, to: input.to, limit: input.limit });
}

// ---------------------------------------------------------------------------
// Cobros: resultado de POST /folios/:id/payments
// ---------------------------------------------------------------------------

export type FolioPaymentResult = CapturedPaymentResponse | PaymentLinkResponse;

/** 202: the PSP must confirm; open `redirect` (GET url or POST form) — nothing is «cobrado» yet. */
export function isPaymentIntent(result: FolioPaymentResult): result is PaymentLinkResponse {
  return result.kind === "payment_intent";
}

/** 201 / 200: a captured payment (cash · card_terminal · bank_transfer · other). */
export function isCapturedPayment(result: FolioPaymentResult): result is CapturedPaymentResponse {
  return result.kind === "payment";
}

/** Idempotency key of a payment attempt (reused on retries of the same attempt). */
export function newClientRequestId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Descargas
// ---------------------------------------------------------------------------

/** File name of a `Content-Disposition` header (`filename*=UTF-8''…` wins over `filename="…"`), or `fallback`. */
export function downloadFilename(contentDisposition: string | null | undefined, fallback: string): string {
  if (!contentDisposition) return fallback;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(contentDisposition);
  if (extended) {
    try {
      const decoded = decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ""));
      if (decoded) return decoded;
    } catch {
      /* fall through to the plain parameter */
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\s]+)/.exec(contentDisposition);
  const name = (plain?.[1] ?? plain?.[2] ?? "").trim();
  return name || fallback;
}
