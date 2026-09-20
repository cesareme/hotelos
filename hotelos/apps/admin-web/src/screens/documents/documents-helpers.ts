// Documentos y digitalización · PURE helpers of the front (Tanda T9 · lote
// T9-04, docs/design/DOCUMENTOS-DIGITALIZACION.md §6.1, §6.4, §9 y §10
// «Bandeja y revisión»): Spanish labels of the wire enums, tones of status and
// confidence, byte and registry formatting, the Spanish sentence of every
// `details.code` the documents module answers with, the grouping by centre of
// the office queue and the SLA badge. No React, no api-client:
// screens/documents/__tests__/documents-helpers.test.mts runs this file under
// `node --test`.
//
// The wire enums come from `@hotelos/shared` (documents-types.ts, lote T9-02):
// every label record is typed against them, so a value the API adds later
// fails the typecheck here instead of leaking a code to the hotelier.

import type {
  DocumentCheckKey,
  CheckStatus,
  DocumentErrorCode,
  DocumentPhysicalStatus,
  DocumentProposedAction,
  DocumentRejectReason,
  IncomingDocumentKind,
  IncomingDocumentSource,
  IncomingDocumentStatus
} from "@hotelos/shared";
import type { CocoaTone } from "../../components/cocoa/cocoa-tones";
import { STATUS_LABELS } from "../../content/actions";
import { isoDate, number, percent, plural, toNumber, type DateInput } from "../../lib/format";
import { FINANCE_ERROR_MESSAGES, financeErrorCode } from "../../services/finance-contracts";

// ---------------------------------------------------------------------------
// Labels (Spanish; every label ≤ 28 characters so it fits a tab or a segment)
// ---------------------------------------------------------------------------

export const DOCUMENT_KIND_LABELS: Record<IncomingDocumentKind, string> = {
  invoice: "Factura",
  delivery_note: "Albarán",
  receipt: "Tique",
  letter: "Carta",
  administrative_notice: "Notificación administrativa",
  contract: "Contrato",
  e_invoice_status: "Estado de e-factura",
  other: "Otro documento",
  unknown: "Sin clasificar"
};

export const DOCUMENT_STATUS_LABELS: Record<IncomingDocumentStatus, string> = {
  captured: "Capturado",
  sent_to_office: "Enviado a la oficina",
  in_review: "En revisión",
  approved: STATUS_LABELS.approved,
  posted: "Contabilizado",
  archived: STATUS_LABELS.archived,
  returned_to_centre: "Devuelto al centro",
  rejected: STATUS_LABELS.rejected
};

export const DOCUMENT_SOURCE_LABELS: Record<IncomingDocumentSource, string> = {
  upload: "Subida manual",
  mobile: "Foto desde el móvil",
  email: "Correo electrónico",
  scanner: "Escáner",
  e_invoice: "Factura electrónica",
  api: "Integración"
};

export const PHYSICAL_STATUS_LABELS: Record<DocumentPhysicalStatus, string> = {
  at_centre: "Papel en el centro",
  in_transit: "En valija",
  at_office: "Papel en la oficina",
  filed: "Archivado en papel",
  not_applicable: "Sin papel"
};

export const PROPOSED_ACTION_LABELS: Record<DocumentProposedAction, string> = {
  create_supplier_bill: "Crear factura recibida",
  create_expense: "Registrar gasto menor",
  create_goods_receipt: "Crear recepción",
  create_task: "Crear tarea con plazo",
  archive: "Archivar"
};

export const REJECT_REASON_LABELS: Record<DocumentRejectReason, string> = {
  illegible: "Ilegible",
  missing_pages: "Faltan páginas",
  duplicate: "Duplicado",
  not_ours: "No es de esta sociedad",
  other: "Otro motivo"
};

export const CHECK_LABELS: Record<DocumentCheckKey, string> = {
  nif: "NIF del proveedor",
  supplier: "Proveedor conocido",
  totals: "Totales",
  vat: "Tipo de IVA",
  duplicate: "Duplicado",
  retention: "Retención IRPF",
  match: "Cotejo con albarán"
};

/** Longest label a tab or a segment may carry (scripts/build-nav-tree.mjs:60). */
export const MAX_TAB_LABEL_LENGTH = 28;

// ---------------------------------------------------------------------------
// Tones
// ---------------------------------------------------------------------------

const STATUS_TONES: Record<IncomingDocumentStatus, CocoaTone> = {
  captured: "neutral",
  sent_to_office: "info",
  in_review: "accent",
  approved: "success",
  posted: "success",
  archived: "neutral",
  returned_to_centre: "warning",
  rejected: "danger"
};

/** Badge tone of a document status; neutral for a value the front does not know. */
export function statusTone(status: string | null | undefined): CocoaTone {
  return (status && STATUS_TONES[status as IncomingDocumentStatus]) || "neutral";
}

const CHECK_TONES: Record<CheckStatus, CocoaTone> = { ok: "success", warn: "warning", fail: "danger" };

/** Callout tone of a `checksJson` entry (`ok` · `warn` · `fail`); neutral when missing. */
export function checkTone(result: string | null | undefined): CocoaTone {
  return (result && CHECK_TONES[result as CheckStatus]) || "neutral";
}

export type ConfidenceBadge = { tone: CocoaTone; label: string };

/** Confidence thresholds of §10: ≥ 0,85 green · 0,6–0,85 amber · < 0,6 red · none → «Manual» grey. */
export const CONFIDENCE_HIGH = 0.85;
export const CONFIDENCE_LOW = 0.6;

/** Badge of a field confidence (0–1, number or decimal string); `null` is a value typed by the reviewer. */
export function confidenceTone(value: number | string | null | undefined): ConfidenceBadge {
  const parsed = toNumber(value);
  if (parsed === null) return { tone: "neutral", label: "Manual" };
  const clamped = Math.min(1, Math.max(0, parsed));
  const label = percent(clamped, { ratio: true, maximumFractionDigits: 0 });
  if (clamped >= CONFIDENCE_HIGH) return { tone: "success", label };
  if (clamped >= CONFIDENCE_LOW) return { tone: "warning", label };
  return { tone: "danger", label };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const KB = 1024;

/** «812 B» · «512 KB» · «2,5 MB» · «1,2 GB» (es-ES, base 1024); «—» when not a size. */
export function formatBytes(bytes: number | string | null | undefined): string {
  const parsed = toNumber(bytes);
  if (parsed === null || parsed < 0) return "—";
  if (parsed < KB) return `${number(parsed, { maximumFractionDigits: 0 })} B`;
  if (parsed < KB * KB) return `${number(parsed / KB, { maximumFractionDigits: 0 })} KB`;
  if (parsed < KB * KB * KB) return `${number(parsed / (KB * KB), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  return `${number(parsed / (KB * KB * KB), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
}

const REGISTRY = /^DOC-([A-Z0-9]+)-(\d{4})-(\d{6})$/;

export type RegistryParts = { propertyCode: string; year: number; sequence: number };

/** Parts of a registry number «DOC-<centro>-<año>-<nnnnnn>» (§6.4); null when it is not one. */
export function parseRegistry(value: string | null | undefined): RegistryParts | null {
  const m = REGISTRY.exec((value ?? "").trim().toUpperCase());
  if (!m) return null;
  return { propertyCode: m[1], year: Number(m[2]), sequence: Number(m[3]) };
}

/** Registry number as printed on the paper («DOC-FAR-2026-000123»); `short` drops the «DOC-» prefix for dense tables; «—» when empty. */
export function formatRegistry(value: string | null | undefined, options: { short?: boolean } = {}): string {
  const text = (value ?? "").trim().toUpperCase();
  if (!text) return "—";
  return options.short && text.startsWith("DOC-") ? text.slice(4) : text;
}

// ---------------------------------------------------------------------------
// details.code → Spanish sentence (one per DOCUMENT_ERROR_CODES of §9;
// `satisfies` fails the typecheck when the shared catalogue gains a code)
// ---------------------------------------------------------------------------

export const DOCUMENT_ERROR_MESSAGES: Readonly<Record<DocumentErrorCode, string>> = Object.freeze({
  // --- 400 ---
  VALIDATION_ERROR: "Revisa los datos del documento: falta algún campo o tiene un formato no válido.",
  DOCUMENT_MIME_NOT_ALLOWED: "Tipo de fichero no admitido: sube un PDF, una imagen (JPEG, PNG, WebP) o una factura electrónica XML.",
  DOCUMENT_CONTENT_MISMATCH: "El contenido del fichero no corresponde con su tipo: vuelve a exportarlo o escanéalo de nuevo.",
  DOCUMENT_ACTION_INVALID_FOR_KIND: "Esa acción no vale para este tipo de documento: corrige el tipo o elige otra acción.",
  INVENTORY_ITEM_INVALID: "El artículo de inventario de la línea no existe en este centro.",
  STOCK_LOCATION_INVALID: "La ubicación de almacén no existe en este centro.",
  STOCK_QUANTITY_TOO_SMALL: "La cantidad recibida es demasiado pequeña para anotar un movimiento de almacén: redondea a dos decimales.",
  // --- 404 (opacos) ---
  DOCUMENT_NOT_FOUND: "El documento no existe o no pertenece a este centro.",
  PROPERTY_NOT_FOUND: "Ese centro de trabajo no existe en tu organización.",
  ENTITY_SCOPE_REQUIRED: "Tu perfil solo ve los documentos de sus centros: elige un centro en «Ámbito» o pide a dirección el permiso «Finanzas de toda la sociedad».",
  DOCUMENT_PAGE_IMAGE_UNAVAILABLE: "Esta página no tiene imagen: el original no está rasterizado, ábrelo con «Ver original».",
  // --- 409 ---
  DOCUMENT_DUPLICATE_FILE: "Este fichero ya está capturado (mismo contenido): abre el documento existente o marca la copia como permitida.",
  DOCUMENT_STATUS_TRANSITION: "El documento no admite esa acción en su estado actual.",
  DOCUMENT_BLOCKED: "El documento está bloqueado por retención: solo un administrador de documentos puede consultarlo.",
  DOCUMENT_LEGAL_HOLD: "El documento tiene bloqueo legal: no se puede purgar ni desbloquear sin retirarlo.",
  DOCUMENT_CHECKS_FAILED: "Hay comprobaciones en rojo: corrígelas o aprueba con un motivo explícito.",
  GOODS_RECEIPT_DUPLICATE: "Ya existe una recepción con ese número de albarán para el proveedor.",
  SUPPLIER_BILL_MATCH_REQUIRED: "La factura necesita cotejarse con sus albaranes antes de aprobarse.",
  // --- 413 ---
  DOCUMENT_TOO_LARGE: "El fichero supera el tamaño máximo admitido: comprímelo o divide el documento.",
  // --- 503 ---
  AI_PROVIDER_UNAVAILABLE: "El proveedor de IA no está disponible: los campos se rellenan a mano o con el extractor de texto."
} satisfies Record<DocumentErrorCode, string>);

const DOCUMENT_ERROR_FALLBACK = "No se pudo completar la operación con el documento. Inténtalo de nuevo.";

/** Spanish sentence of a documents failure: its `details.code` first (documents, then finance), then the API message, then `fallback`. */
export function documentErrorMessage(error: unknown, fallback: string = DOCUMENT_ERROR_FALLBACK): string {
  const code = financeErrorCode(error);
  if (code && Object.hasOwn(DOCUMENT_ERROR_MESSAGES, code)) return DOCUMENT_ERROR_MESSAGES[code as DocumentErrorCode];
  if (code && FINANCE_ERROR_MESSAGES[code]) return FINANCE_ERROR_MESSAGES[code];
  const message = typeof error === "object" && error !== null ? (error as { message?: unknown }).message : error;
  if (typeof message === "string" && message.trim()) return message.trim();
  return fallback;
}

// ---------------------------------------------------------------------------
// Office queue: grouping by centre
// ---------------------------------------------------------------------------

export type PropertyRow = { propertyId: string; propertyCode?: string | null; propertyName?: string | null };

export type PropertyGroup<T extends PropertyRow> = { propertyId: string; propertyCode: string | null; propertyName: string | null; rows: T[] };

/** Rows of the organisation-wide queue grouped by centre (`Property.code`, then name, then id), rows in their original order inside each group. */
export function groupByProperty<T extends PropertyRow>(rows: readonly T[]): PropertyGroup<T>[] {
  const groups = new Map<string, PropertyGroup<T>>();
  for (const row of rows) {
    let group = groups.get(row.propertyId);
    if (!group) {
      group = { propertyId: row.propertyId, propertyCode: row.propertyCode ?? null, propertyName: row.propertyName ?? null, rows: [] };
      groups.set(row.propertyId, group);
    } else {
      group.propertyCode ??= row.propertyCode ?? null;
      group.propertyName ??= row.propertyName ?? null;
    }
    group.rows.push(row);
  }
  const key = (g: PropertyGroup<T>) => [g.propertyCode ? 0 : 1, g.propertyCode ?? "", g.propertyName ?? "", g.propertyId] as const;
  return [...groups.values()].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// SLA of the office (§6.3: business days from sentAt)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function utcOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function isoOf(utc: number): string {
  const d = new Date(utc);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** `days` business days (Monday–Friday, no holidays) after a calendar day «2026-09-18» → «2026-09-22». */
export function addBusinessDays(day: string, days: number): string {
  let utc = utcOf(day);
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    utc += DAY_MS;
    const weekday = new Date(utc).getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return isoOf(utc);
}

export type SlaBadge = {
  tone: CocoaTone;
  label: string;
  /** Calendar day the office must have decided by; null when not sent yet. */
  dueOn: string | null;
  /** Calendar days left (negative when overdue); null when not sent yet. */
  daysLeft: number | null;
  breached: boolean;
};

/** Badge of the office SLA of a document sent on `sentAt` with `businessDays` to decide (§6.3); `now` for tests. */
export function slaBadge(sentAt: DateInput, businessDays: number, now: DateInput = new Date()): SlaBadge {
  const sentDay = isoDate(sentAt);
  const today = isoDate(now);
  if (!sentDay || !today) return { tone: "neutral", label: "Sin enviar", dueOn: null, daysLeft: null, breached: false };
  const dueOn = addBusinessDays(sentDay, businessDays);
  const daysLeft = Math.round((utcOf(dueOn) - utcOf(today)) / DAY_MS);
  if (daysLeft < 0) return { tone: "danger", label: `Vencido hace ${plural(-daysLeft, "día", "días")}`, dueOn, daysLeft, breached: true };
  if (daysLeft === 0) return { tone: "warning", label: "Vence hoy", dueOn, daysLeft, breached: false };
  if (daysLeft === 1) return { tone: "warning", label: "Vence mañana", dueOn, daysLeft, breached: false };
  return { tone: "success", label: `Vence en ${plural(daysLeft, "día", "días")}`, dueOn, daysLeft, breached: false };
}
