// Ficha del activo inmobiliario (Tanda ACT · lote ACT-F1, diseño
// docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md §8 «Ficha (base)»).
//
// Cocoa 22: CocoaPage → CocoaKpi strip (valor catastral, última tasación,
// valor por habitación, carga fiscal anual, alertas abiertas) → CocoaSplitView:
// `sidebar` = unidades registrales / catastrales con su título (CocoaBadge) y
// sus cargas; `content` = tenencia vigente (CocoaCallout «Propietaria: …» o
// «Arrendataria de … hasta …»), datos del edificio, valoraciones y la lista de
// alertas abiertas; `inspector` = vencimientos de los próximos 90 días
// (GET …/real-estate/calendar). Drawers CocoaDrawer para el alta y la edición
// de la ficha, de una unidad, de una carga, de la tenencia y de una valoración
// (CocoaField + CocoaInput / CocoaSelect / CocoaDatePicker sobre una
// especificación de campos por formulario). Estado vacío CocoaState «Este
// centro aún no tiene activo inmobiliario» con el alta solo con
// `real_estate.manage`; 403 → CocoaState con UI_STATES.forbidden.
//
// Lecturas y escrituras SOLO por services/realEstateApi.ts (nunca fetch crudo);
// etiquetas, tonos y frases de error por ./real-estate-helpers.ts. Permisos con
// `canDo(useNavGate(propertyId), "real_estate.manage")` (las concesiones reales
// del centro, como Cuentas anuales / USALI). Sin estilos en línea (Cocoa 22).
//
// `RealEstateAssetScreen` (contenedor: carga, permisos, toasts) pinta
// `RealEstateAssetView` (presentación con estado explícito), que los tests
// renderizan con react-dom/server sin red; `RealEstateAssetSummary` (KPIs +
// tenencia + alertas) lo reutiliza el cajón de la vista de grupo.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  RealEstateAlert,
  RealEstateAssetDetail,
  RealEstateCalendarEvent,
  RealEstateChargeRecord,
  RealEstateTenureRecord,
  RealEstateUnitWithCharges,
  RealEstateValuationRecord
} from "@hotelos/shared";
import {
  REAL_ESTATE_ASSET_STATUSES,
  REAL_ESTATE_CAPEX_RESPONSIBILITIES,
  REAL_ESTATE_CHARGE_KINDS,
  REAL_ESTATE_COST_PAYERS,
  REAL_ESTATE_ENERGY_RATINGS,
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
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaScrollArea,
  CocoaSection,
  CocoaSelect,
  CocoaSplitView,
  CocoaState,
  CocoaTable,
  type CocoaSelectOption,
  type CocoaTableColumn
} from "../../components/cocoa";
import { useToast } from "../../components/Toast";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, UI_STATES, newLabel } from "../../content/actions";
import { EMPTY, number, plural } from "../../lib/format";
import { useNavGate } from "../../navigation/useEnabledModules";
import { getActiveProperty, loadSwitchableProperties } from "../../services/activeProperty";
import { financeErrorCode, financeErrorStatus } from "../../services/finance-contracts";
import {
  createRealEstateAsset,
  createRealEstateCharge,
  createRealEstateTenure,
  createRealEstateUnit,
  createRealEstateValuation,
  getRealEstateAsset,
  getRealEstateCalendar,
  updateRealEstateAsset,
  updateRealEstateCharge,
  updateRealEstateTenure,
  updateRealEstateUnit
} from "../../services/realEstateApi";
import type {
  RealEstateAssetPatchRequest,
  RealEstateAssetRequest,
  RealEstateChargePatchRequest,
  RealEstateChargeRequest,
  RealEstateTenureAction,
  RealEstateTenurePatchRequest,
  RealEstateTenureRequest,
  RealEstateUnitPatchRequest,
  RealEstateUnitRequest,
  RealEstateValuationRequest
} from "../../services/realEstateApi";
import { canDo, todayIso } from "../accounting/accounting-ui";
import { useTabHost } from "../tabs/TabHost";
import {
  ALERT_SEVERITY_LABELS,
  ASSET_STATUS_LABELS,
  CAPEX_RESPONSIBILITY_LABELS,
  CHARGE_KIND_LABELS,
  COST_PAYER_LABELS,
  PROTECTION_LEVEL_LABELS,
  RENT_KIND_LABELS,
  RENT_REVIEW_INDEX_LABELS,
  RENT_VARIABLE_BASE_LABELS,
  TENURE_KIND_LABELS,
  TENURE_RENEWAL_LABELS,
  TITLE_KIND_LABELS,
  UNIT_KIND_LABELS,
  USE_CODE_LABELS,
  VALUATION_KIND_LABELS,
  VALUATION_PURPOSE_LABELS,
  alertEntityTypeLabel,
  alertKindLabel,
  alertSeverityTone,
  assetStatusLabel,
  assetStatusTone,
  catalogOptions,
  chargeKindLabel,
  formatDay,
  formatMoney,
  formatPercent,
  protectionLevelLabel,
  realEstateErrorMessage,
  rentKindLabel,
  tenureKindLabel,
  tenureRenewalLabel,
  tenureStatusLabel,
  tenureStatusTone,
  titleKindLabel,
  unitKindLabel,
  useCodeLabel,
  valuationKindLabel,
  valuationPurposeLabel
} from "./real-estate-helpers";

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const EMPTY_ASSET_TITLE = "Este centro aún no tiene activo inmobiliario";
export const EMPTY_ASSET_MESSAGE = "Registra la ficha del inmueble para llevar sus unidades registrales, la tenencia, las valoraciones, los tributos y la documentación con vigencia.";
export const CREATE_ASSET_LABEL = "Crear la ficha del activo";
export const UPCOMING_DAYS = 90;
export const MANAGE_PERMISSION = "real_estate.manage";

// ---------------------------------------------------------------------------
// Estado de la vista (puro): qué pinta la ficha con lo que devuelve el API
// ---------------------------------------------------------------------------

export type AssetViewState = "loading" | "ready" | "empty" | "forbidden" | "error";

/** Con ficha → `ready`; 403 → `forbidden`; 404 / ASSET_NOT_FOUND → `empty` (el alta); otro fallo → `error`; sin nada aún → `loading`. */
export function assetViewState(input: { loading: boolean; error: unknown; detail: RealEstateAssetDetail | null }): AssetViewState {
  if (input.detail) return "ready";
  if (input.error !== null && input.error !== undefined) {
    const status = financeErrorStatus(input.error);
    if (status === 403) return "forbidden";
    if (status === 404 || financeErrorCode(input.error) === "ASSET_NOT_FOUND") return "empty";
    return "error";
  }
  return input.loading ? "loading" : "empty";
}

// ---------------------------------------------------------------------------
// Fechas y calendario (puros)
// ---------------------------------------------------------------------------

/** `iso` + `days` en UTC («2026-12-20» + 30 → «2027-01-19»). */
export function addDays(iso: string, days: number): string {
  const base = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return iso;
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Eventos con `dueAt` entre hoy y hoy + `days` (ambos incluidos), por fecha y etiqueta. */
export function upcomingCalendarEvents(events: ReadonlyArray<RealEstateCalendarEvent>, today: string, days: number = UPCOMING_DAYS): RealEstateCalendarEvent[] {
  const end = addDays(today, days);
  return events
    .filter((event) => event.dueAt >= today && event.dueAt <= end)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.label.localeCompare(b.label, "es"));
}

/** Ejercicios que cubre la ventana de `days` días desde `today` (uno o dos). */
export function calendarYearsFor(today: string, days: number = UPCOMING_DAYS): number[] {
  const first = Number(today.slice(0, 4));
  const last = Number(addDays(today, days).slice(0, 4));
  return Number.isFinite(last) && last !== first ? [first, last] : [first];
}

// ---------------------------------------------------------------------------
// Tenencia vigente (puro)
// ---------------------------------------------------------------------------

export const NO_TENURE_TITLE = "Sin tenencia vigente";

/** «Propietaria: <sociedad>» · «Arrendataria de <arrendador> hasta el <fecha>» · «Contrato de gestión con …» … */
export function tenureCalloutTitle(tenure: RealEstateTenureRecord | null, legalEntityName: string | null): string {
  if (!tenure) return NO_TENURE_TITLE;
  const counterparty = tenure.counterpartyName?.trim() || "";
  const society = counterparty || legalEntityName?.trim() || "la sociedad";
  const other = counterparty || "contraparte sin identificar";
  const until = tenure.endDate ? ` hasta el ${formatDay(tenure.endDate)}` : " sin fecha de fin";
  switch (tenure.kind) {
    case "propiedad":
      return `Propietaria: ${society}`;
    case "arrendamiento_local":
    case "arrendamiento_industria":
      return `Arrendataria de ${other}${until}`;
    case "gestion":
      return `Contrato de gestión con ${other}${until}`;
    case "franquicia":
      return `Franquicia${tenure.brandName ? ` ${tenure.brandName.trim()}` : ""} de ${other}${until}`;
    case "usufructo":
      return `Usufructo de ${other}${until}`;
    case "concesion":
      return `Concesión de ${other}${until}`;
    default:
      return `${tenureKindLabel(tenure.kind)}${until}`;
  }
}

/** Líneas secundarias del callout: renta, revisión, preaviso y quién paga IBI / seguro / obras. */
export function tenureCalloutLines(tenure: RealEstateTenureRecord): string[] {
  const lines: string[] = [];
  if (tenure.kind !== "propiedad") {
    const rent: string[] = [];
    if (tenure.rentKind) rent.push(rentKindLabel(tenure.rentKind));
    if (tenure.rentMonthly) rent.push(`${formatMoney(tenure.rentMonthly)} al mes`);
    if (tenure.rentVariablePct) rent.push(`${formatPercent(tenure.rentVariablePct)} ${tenure.rentVariableBase ? RENT_VARIABLE_BASE_LABELS[tenure.rentVariableBase].toLowerCase() : "variable"}`);
    if (rent.length > 0) lines.push(`Renta: ${rent.join(" · ")}`);
    if (tenure.rentReviewIndex && tenure.rentReviewIndex !== "ninguno") lines.push(`Revisión de renta: ${RENT_REVIEW_INDEX_LABELS[tenure.rentReviewIndex]}${tenure.rentReviewMonth ? ` (mes ${tenure.rentReviewMonth})` : ""}`);
    if (tenure.noticeMonths) lines.push(`Preaviso: ${plural(tenure.noticeMonths, "mes", "meses")} · renovación ${tenureRenewalLabel(tenure.renewal).toLowerCase()}`);
  }
  lines.push(`IBI: ${COST_PAYER_LABELS[tenure.ibiPayer].toLowerCase()} · seguro: ${COST_PAYER_LABELS[tenure.insurancePayer].toLowerCase()} · obras: ${CAPEX_RESPONSIBILITY_LABELS[tenure.capexResponsibility].toLowerCase()}`);
  if (tenure.ffeReservePct) lines.push(`Reserva FF&E: ${formatPercent(tenure.ffeReservePct)}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Formularios por especificación (CocoaField + CocoaInput / CocoaSelect / CocoaDatePicker)
// ---------------------------------------------------------------------------

export type FieldKind = "text" | "decimal" | "integer" | "date" | "select" | "multiline" | "bool";

export type FieldSpec = {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  options?: ReadonlyArray<CocoaSelectOption>;
  help?: string;
  placeholder?: string;
  fullWidth?: boolean;
  maxLength?: number;
  /** Validación propia («20 caracteres alfanuméricos»); devuelve la frase del error. */
  validate?: (value: string) => string | undefined;
};

export type FormValues = Record<string, string>;
export type FormErrors = Record<string, string>;

const DECIMAL = /^-?\d+(\.\d+)?$/;
const INTEGER = /^-?\d+$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** «1.234,56» · «1234,56» · «1234.56» → «1234.56»; forma inválida → null. */
export function decimalString(text: string): string | null {
  let raw = text.replace(/\s/g, "").trim();
  if (!raw) return null;
  if (raw.includes(",") && raw.includes(".")) raw = raw.replace(/\./g, "").replace(",", ".");
  else if (raw.includes(",")) raw = raw.replace(",", ".");
  return DECIMAL.test(raw) ? raw : null;
}

/** Valores del formulario a partir de un registro (null → "", booleanos → "1"/"0", números → texto). */
export function valuesOf(spec: ReadonlyArray<FieldSpec>, record: Record<string, unknown> | null | undefined): FormValues {
  const values: FormValues = {};
  for (const field of spec) {
    const raw = record?.[field.key];
    if (raw === null || raw === undefined) values[field.key] = "";
    else if (typeof raw === "boolean") values[field.key] = raw ? "1" : "0";
    else values[field.key] = String(raw);
  }
  return values;
}

export function validateForm(spec: ReadonlyArray<FieldSpec>, values: FormValues): FormErrors {
  const errors: FormErrors = {};
  for (const field of spec) {
    const value = (values[field.key] ?? "").trim();
    if (!value) {
      if (field.required) errors[field.key] = "Este campo es obligatorio.";
      continue;
    }
    if (field.kind === "decimal" && decimalString(value) === null) errors[field.key] = "Indica un número (coma o punto decimal).";
    else if (field.kind === "integer" && !INTEGER.test(value)) errors[field.key] = "Indica un número entero.";
    else if (field.kind === "date" && !ISO_DAY.test(value)) errors[field.key] = "Indica una fecha válida.";
    else if (field.validate) {
      const own = field.validate(value);
      if (own) errors[field.key] = own;
    }
  }
  return errors;
}

function wireValue(field: FieldSpec, value: string): unknown {
  const trimmed = value.trim();
  switch (field.kind) {
    case "decimal":
      return decimalString(trimmed) ?? trimmed;
    case "integer":
      return Number(trimmed);
    case "bool":
      return trimmed === "1";
    default:
      return trimmed;
  }
}

/**
 * Cuerpo para el API: en el alta (`initial` ausente) los campos vacíos se
 * omiten; en la edición solo viajan los campos que cambian y un vacío borra
 * (`null`), como documentan los PATCH del cliente.
 */
export function formBody(spec: ReadonlyArray<FieldSpec>, values: FormValues, initial?: FormValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of spec) {
    const value = (values[field.key] ?? "").trim();
    if (initial) {
      if (value === (initial[field.key] ?? "").trim()) continue;
      body[field.key] = value ? wireValue(field, value) : null;
    } else if (value) {
      body[field.key] = wireValue(field, value);
    }
  }
  return body;
}

const YES_NO: ReadonlyArray<CocoaSelectOption> = [
  { value: "", label: "Sin indicar" },
  { value: "1", label: STATUS_LABELS.yes },
  { value: "0", label: STATUS_LABELS.no }
];

function FieldControl({ field, value, onChange, disabled, error }: { field: FieldSpec; value: string; onChange: (value: string) => void; disabled: boolean; error: boolean }) {
  switch (field.kind) {
    case "select": {
      const options = field.required ? [...(field.options ?? [])] : [{ value: "", label: "Sin indicar" }, ...(field.options ?? [])];
      return <CocoaSelect value={value} onChange={onChange} options={options} placeholder={field.required ? "Elige una opción" : undefined} disabled={disabled} error={error} required={field.required} />;
    }
    case "bool":
      return <CocoaSelect value={value} onChange={onChange} options={[...YES_NO]} disabled={disabled} error={error} />;
    case "date":
      return <CocoaDatePicker value={value} onChange={onChange} disabled={disabled} error={error} required={field.required} />;
    case "multiline":
      return <CocoaInput value={value} onChange={onChange} multiline rows={3} placeholder={field.placeholder} maxLength={field.maxLength ?? 2000} disabled={disabled} error={error} />;
    case "decimal":
      return <CocoaInput value={value} onChange={onChange} inputMode="decimal" placeholder={field.placeholder ?? "0,00"} disabled={disabled} error={error} required={field.required} />;
    case "integer":
      return <CocoaInput value={value} onChange={onChange} inputMode="numeric" placeholder={field.placeholder} disabled={disabled} error={error} required={field.required} />;
    default:
      return <CocoaInput value={value} onChange={onChange} placeholder={field.placeholder} maxLength={field.maxLength ?? 200} disabled={disabled} error={error} required={field.required} />;
  }
}

type SpecFormProps = {
  spec: ReadonlyArray<FieldSpec>;
  values: FormValues;
  errors: FormErrors;
  disabled: boolean;
  onChange: (key: string, value: string) => void;
};

function SpecForm({ spec, values, errors, disabled, onChange }: SpecFormProps) {
  return (
    <CocoaFormRow columns={2} min={200}>
      {spec.map((field) => (
        <CocoaField key={field.key} label={field.label} required={field.required} error={errors[field.key]} help={field.help} hint={field.required ? undefined : STATUS_LABELS.optional.toLowerCase()} fullWidth={field.fullWidth}>
          <FieldControl field={field} value={values[field.key] ?? ""} onChange={(value) => onChange(field.key, value)} disabled={disabled} error={Boolean(errors[field.key])} />
        </CocoaField>
      ))}
    </CocoaFormRow>
  );
}

// ---------------------------------------------------------------------------
// Especificaciones de los cinco formularios
// ---------------------------------------------------------------------------

const CADASTRAL_REFERENCE = /^[0-9A-Za-z]{20}$/;

export const ASSET_FIELDS: ReadonlyArray<FieldSpec> = [
  { key: "name", label: FIELD_LABELS.name, kind: "text", required: true, placeholder: "Edificio del hotel", fullWidth: true },
  { key: "yearBuilt", label: "Año de construcción", kind: "integer", placeholder: "1978" },
  { key: "yearLastRefurbished", label: "Última reforma integral", kind: "integer", placeholder: "2019" },
  { key: "builtSurfaceM2", label: "Superficie construida (m²)", kind: "decimal" },
  { key: "plotSurfaceM2", label: "Superficie de parcela (m²)", kind: "decimal" },
  { key: "floorsAbove", label: "Plantas sobre rasante", kind: "integer" },
  { key: "floorsBelow", label: "Plantas bajo rasante", kind: "integer" },
  { key: "roomsCount", label: "Habitaciones", kind: "integer", help: "Base del valor por habitación." },
  { key: "protectionLevel", label: "Protección patrimonial", kind: "select", options: catalogOptions(REAL_ESTATE_PROTECTION_LEVELS, PROTECTION_LEVEL_LABELS) },
  { key: "energyRating", label: "Calificación energética", kind: "select", options: REAL_ESTATE_ENERGY_RATINGS.map((value) => ({ value, label: value })) },
  { key: "energyCertValidUntil", label: "Certificado energético válido hasta", kind: "date" },
  { key: "cadastralValueTotal", label: "Valor catastral total", kind: "decimal" },
  { key: "cadastralValueYear", label: "Ejercicio del valor catastral", kind: "integer", placeholder: "2026" },
  { key: "referenceValue", label: "Valor de referencia (Catastro)", kind: "decimal" },
  { key: "notes", label: FIELD_LABELS.notes, kind: "multiline", fullWidth: true }
];

export const ASSET_STATUS_FIELD: FieldSpec = { key: "status", label: FIELD_LABELS.status, kind: "select", required: true, options: catalogOptions(REAL_ESTATE_ASSET_STATUSES, ASSET_STATUS_LABELS) };

export const UNIT_FIELDS: ReadonlyArray<FieldSpec> = [
  { key: "kind", label: "Tipo de unidad", kind: "select", required: true, options: catalogOptions(REAL_ESTATE_UNIT_KINDS, UNIT_KIND_LABELS) },
  { key: "titleKind", label: "Título", kind: "select", required: true, options: catalogOptions(REAL_ESTATE_TITLE_KINDS, TITLE_KIND_LABELS) },
  { key: "registryOffice", label: "Registro de la Propiedad", kind: "text", placeholder: "Registro nº 2 de …" },
  { key: "registryFincaNumber", label: "Finca registral", kind: "text" },
  { key: "registryTomo", label: "Tomo", kind: "text" },
  { key: "registryLibro", label: "Libro", kind: "text" },
  { key: "registryFolio", label: "Folio", kind: "text" },
  { key: "cru", label: "CRU / IDUFIR", kind: "text" },
  { key: "cadastralReference", label: "Referencia catastral", kind: "text", help: "20 caracteres alfanuméricos, sin guiones ni espacios.", validate: (value) => (CADASTRAL_REFERENCE.test(value.replace(/\s/g, "")) ? undefined : "La referencia catastral debe tener 20 caracteres alfanuméricos.") },
  { key: "useCode", label: "Uso catastral", kind: "select", options: catalogOptions(REAL_ESTATE_USE_CODES, USE_CODE_LABELS) },
  { key: "surfaceM2", label: "Superficie (m²)", kind: "decimal" },
  { key: "cadastralValueLand", label: "Valor catastral del suelo", kind: "decimal" },
  { key: "cadastralValueBuilding", label: "Valor catastral de la construcción", kind: "decimal" },
  { key: "titleHolderName", label: "Titular", kind: "text" },
  { key: "titleHolderTaxId", label: "NIF del titular", kind: "text", maxLength: 20 },
  { key: "titleDeedDate", label: "Fecha de la escritura", kind: "date" },
  { key: "notary", label: "Notaría", kind: "text" }
];

export const CHARGE_FIELDS: ReadonlyArray<FieldSpec> = [
  { key: "kind", label: "Tipo de carga", kind: "select", required: true, options: catalogOptions(REAL_ESTATE_CHARGE_KINDS, CHARGE_KIND_LABELS) },
  { key: "holderName", label: "Titular de la carga", kind: "text", placeholder: "Entidad financiera, Hacienda…" },
  { key: "holderTaxId", label: "NIF del titular", kind: "text", maxLength: 20 },
  { key: "amount", label: "Importe garantizado", kind: "decimal" },
  { key: "outstandingAmount", label: "Importe pendiente", kind: "decimal" },
  { key: "registeredAt", label: "Fecha de inscripción", kind: "date" },
  { key: "expiresAt", label: "Vencimiento", kind: "date" },
  { key: "cancelledAt", label: "Cancelación registral", kind: "date" },
  { key: "note", label: FIELD_LABELS.notes, kind: "multiline", fullWidth: true }
];

export const TENURE_FIELDS: ReadonlyArray<FieldSpec> = [
  { key: "kind", label: "Tipo de tenencia", kind: "select", required: true, options: catalogOptions(REAL_ESTATE_TENURE_KINDS, TENURE_KIND_LABELS) },
  { key: "startDate", label: "Inicio", kind: "date", required: true },
  { key: "endDate", label: "Fin", kind: "date" },
  { key: "counterpartyName", label: "Contraparte", kind: "text", help: "Arrendador, gestor o franquiciador; en propiedad, la sociedad titular." },
  { key: "counterpartyTaxId", label: "NIF de la contraparte", kind: "text", maxLength: 20 },
  { key: "counterpartyNonResident", label: "Contraparte no residente", kind: "bool" },
  { key: "brandName", label: "Marca", kind: "text" },
  { key: "renewal", label: "Renovación", kind: "select", options: catalogOptions(REAL_ESTATE_TENURE_RENEWALS, TENURE_RENEWAL_LABELS) },
  { key: "noticeMonths", label: "Preaviso (meses)", kind: "integer" },
  { key: "rentKind", label: "Tipo de renta", kind: "select", options: catalogOptions(REAL_ESTATE_RENT_KINDS, RENT_KIND_LABELS) },
  { key: "rentMonthly", label: "Renta mensual", kind: "decimal" },
  { key: "rentVariablePct", label: "Renta variable (%)", kind: "decimal" },
  { key: "rentVariableBase", label: "Base de la renta variable", kind: "select", options: catalogOptions(REAL_ESTATE_RENT_VARIABLE_BASES, RENT_VARIABLE_BASE_LABELS) },
  { key: "rentReviewIndex", label: "Índice de revisión", kind: "select", options: catalogOptions(REAL_ESTATE_RENT_REVIEW_INDEXES, RENT_REVIEW_INDEX_LABELS) },
  { key: "rentReviewMonth", label: "Mes de revisión (1-12)", kind: "integer", validate: (value) => (Number(value) >= 1 && Number(value) <= 12 ? undefined : "Indica un mes entre 1 y 12.") },
  { key: "depositAmount", label: "Fianza", kind: "decimal" },
  { key: "vatApplies", label: "Sujeta a IVA", kind: "bool" },
  { key: "withholdingApplies", label: "Con retención", kind: "bool" },
  { key: "withholdingRatePct", label: "Retención (%)", kind: "decimal" },
  { key: "ibiPayer", label: "Paga el IBI", kind: "select", options: catalogOptions(REAL_ESTATE_COST_PAYERS, COST_PAYER_LABELS) },
  { key: "insurancePayer", label: "Paga el seguro", kind: "select", options: catalogOptions(REAL_ESTATE_COST_PAYERS, COST_PAYER_LABELS) },
  { key: "capexResponsibility", label: "Responsable de las obras", kind: "select", options: catalogOptions(REAL_ESTATE_CAPEX_RESPONSIBILITIES, CAPEX_RESPONSIBILITY_LABELS) },
  { key: "ffeReservePct", label: "Reserva FF&E (%)", kind: "decimal" },
  { key: "notes", label: FIELD_LABELS.notes, kind: "multiline", fullWidth: true }
];

export const VALUATION_FIELDS: ReadonlyArray<FieldSpec> = [
  { key: "kind", label: "Tipo de valoración", kind: "select", required: true, options: catalogOptions(REAL_ESTATE_VALUATION_KINDS, VALUATION_KIND_LABELS) },
  { key: "purpose", label: "Finalidad", kind: "select", options: catalogOptions(REAL_ESTATE_VALUATION_PURPOSES, VALUATION_PURPOSE_LABELS) },
  { key: "valuedAt", label: "Fecha de la valoración", kind: "date", required: true },
  { key: "value", label: "Valor", kind: "decimal", required: true },
  { key: "valuePerRoom", label: "Valor por habitación", kind: "decimal", help: "Vacío = el API lo deriva de las habitaciones de la ficha." },
  { key: "capRatePct", label: "Tasa de capitalización (%)", kind: "decimal" },
  { key: "method", label: "Método", kind: "text", placeholder: "Descuento de flujos, comparación…" },
  { key: "appraiser", label: "Tasadora", kind: "text" }
];

// ---------------------------------------------------------------------------
// Recurso asíncrono con el error crudo (403 / 404 tipados deciden la vista)
// ---------------------------------------------------------------------------

export type Resource<T> = { data: T | null; loading: boolean; error: unknown; refresh: () => void };

/** Carga `load()` cuando cambia `key` (conserva los datos anteriores mientras llega la nueva) y en cada `refresh()`. */
export function useResource<T>(load: () => Promise<T>, key: string): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const current = ++seq.current;
    setLoading(true);
    setError(null);
    loadRef
      .current()
      .then((value) => {
        if (current !== seq.current) return;
        setData(value);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (current !== seq.current) return;
        setData(null);
        setError(err ?? new Error("Fallo desconocido."));
        setLoading(false);
      });
  }, [key, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, refresh };
}

/** Vencimientos de los próximos `UPCOMING_DAYS` días del centro (uno o dos ejercicios del calendario); sin ficha → []. */
export async function loadUpcomingEvents(propertyId: string, today: string): Promise<RealEstateCalendarEvent[]> {
  const years = await Promise.all(calendarYearsFor(today).map((year) => getRealEstateCalendar({ year }, propertyId)));
  return upcomingCalendarEvents(
    years.flatMap((calendar) => calendar.months.flatMap((month) => month.events)),
    today
  );
}

// ---------------------------------------------------------------------------
// Presentación
// ---------------------------------------------------------------------------

export type RealEstateAssetViewProps = {
  propertyId: string;
  propertyName: string;
  legalEntityName: string | null;
  detail: RealEstateAssetDetail | null;
  loading: boolean;
  error: unknown;
  /** Vencimientos de los próximos 90 días; null mientras cargan o sin ficha. */
  upcoming: RealEstateCalendarEvent[] | null;
  upcomingError: unknown;
  canManage: boolean;
  today: string;
  onRefresh: () => void;
  onNotify: (message: string, variant: "success" | "error") => void;
};

type DrawerState =
  | { kind: "asset"; mode: "new" | "edit" }
  | { kind: "unit"; unit: RealEstateUnitWithCharges | null }
  | { kind: "charge"; unitId: string; charge: RealEstateChargeRecord | null }
  | { kind: "tenure"; tenure: RealEstateTenureRecord | null }
  | { kind: "valuation" };

function specOf(drawer: DrawerState): ReadonlyArray<FieldSpec> {
  switch (drawer.kind) {
    case "asset":
      return drawer.mode === "edit" ? [...ASSET_FIELDS, ASSET_STATUS_FIELD] : ASSET_FIELDS;
    case "unit":
      return UNIT_FIELDS;
    case "charge":
      return CHARGE_FIELDS;
    case "tenure":
      return TENURE_FIELDS;
    case "valuation":
      return VALUATION_FIELDS;
  }
}

function drawerTitle(drawer: DrawerState): string {
  switch (drawer.kind) {
    case "asset":
      return drawer.mode === "edit" ? "Editar la ficha del activo" : CREATE_ASSET_LABEL;
    case "unit":
      return drawer.unit ? "Editar unidad" : newLabel("f", "unidad registral");
    case "charge":
      return drawer.charge ? "Editar carga" : newLabel("f", "carga");
    case "tenure":
      return drawer.tenure ? "Editar tenencia" : newLabel("f", "tenencia");
    case "valuation":
      return newLabel("f", "valoración");
  }
}

function initialRecordOf(drawer: DrawerState, detail: RealEstateAssetDetail | null): Record<string, unknown> | null {
  switch (drawer.kind) {
    case "asset":
      return drawer.mode === "edit" ? (detail?.asset ?? null) : null;
    case "unit":
      return drawer.unit;
    case "charge":
      return drawer.charge;
    case "tenure":
      return drawer.tenure;
    case "valuation":
      return null;
  }
}

const VALUATION_COLUMNS: CocoaTableColumn<RealEstateValuationRecord>[] = [
  { key: "kind", label: "Tipo de valoración", render: (v) => valuationKindLabel(v.kind) },
  { key: "purpose", label: "Finalidad", hideOnNarrow: true, render: (v) => valuationPurposeLabel(v.purpose) },
  { key: "valuedAt", label: FIELD_LABELS.date, render: (v) => formatDay(v.valuedAt) },
  { key: "value", label: "Valor", align: "right", render: (v) => <strong>{formatMoney(v.value)}</strong> },
  { key: "valuePerRoom", label: "Por habitación", align: "right", hideOnNarrow: true, render: (v) => formatMoney(v.valuePerRoom) },
  { key: "capRatePct", label: "Tasa de capitalización", align: "right", hideOnNarrow: true, render: (v) => formatPercent(v.capRatePct) },
  { key: "appraiser", label: "Tasadora", hideOnNarrow: true, render: (v) => v.appraiser ?? EMPTY }
];

function surface(value: string | null): string {
  return value === null ? EMPTY : `${number(value)} m²`;
}

/** KPI strip de la ficha (diseño §8): valor catastral, última tasación, valor por habitación, carga fiscal anual y alertas abiertas. */
export function AssetKpiStrip({ detail }: { detail: RealEstateAssetDetail }) {
  const { asset, kpis, alerts } = detail;
  const highAlerts = alerts.filter((alert) => alert.severity === "alta").length;
  return (
    <CocoaKpiStrip min={200} aria-label="Resumen del activo inmobiliario">
      <CocoaKpi label="Valor catastral" value={formatMoney(kpis.cadastralValueTotal)} caption={asset.cadastralValueYear ? `Ejercicio ${asset.cadastralValueYear}` : "Sin valor catastral"} />
      <CocoaKpi label="Última tasación" value={formatMoney(kpis.lastValuationValue)} caption={asset.lastValuationAt ? formatDay(asset.lastValuationAt) : "Sin tasación registrada"} />
      <CocoaKpi label="Valor por habitación" value={formatMoney(kpis.valuePerRoom)} caption={asset.roomsCount ? plural(asset.roomsCount, "habitación", "habitaciones") : "Sin habitaciones en la ficha"} />
      <CocoaKpi label="Carga fiscal anual" value={formatMoney(kpis.annualTaxBurden)} caption="IBI, IAE y tasas previstos" />
      <CocoaKpi label="Alertas abiertas" value={kpis.openAlerts} status={kpis.openAlerts === 0 ? "ok" : highAlerts > 0 ? "critical" : "warning"} caption={highAlerts > 0 ? plural(highAlerts, "alerta alta", "alertas altas") : "Ninguna alta"} />
    </CocoaKpiStrip>
  );
}

/** Tenencia vigente: «Propietaria: …» o «Arrendataria de … hasta …», con renta, preaviso y reparto de costes. */
export function TenureCallout({ tenure, legalEntityName, actions }: { tenure: RealEstateTenureRecord | null; legalEntityName: string | null; actions?: ReactNode }) {
  if (!tenure) {
    return (
      <CocoaCallout tone="warning" title={NO_TENURE_TITLE} actions={actions}>
        Registra la propiedad, el arrendamiento, la gestión o la franquicia del inmueble y actívala para que la ficha sepa quién paga IBI, seguro y obras.
      </CocoaCallout>
    );
  }
  const lines = tenureCalloutLines(tenure);
  return (
    <CocoaCallout tone="info" title={tenureCalloutTitle(tenure, legalEntityName)} actions={actions}>
      <div className="cocoa-stack" data-gap="1">
        <span className="cocoa-cluster">
          <CocoaBadge tone={tenureStatusTone(tenure.status)} size="small">
            {tenureStatusLabel(tenure.status)}
          </CocoaBadge>
          <span>{tenureKindLabel(tenure.kind)} · desde el {formatDay(tenure.startDate)}</span>
        </span>
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
    </CocoaCallout>
  );
}

/** Alertas abiertas del centro ordenadas por el motor; el tipo de entidad indica la pestaña donde se resuelve. */
export function AlertsList({ alerts }: { alerts: ReadonlyArray<RealEstateAlert> }) {
  if (alerts.length === 0) return <CocoaState kind="empty" inline title="Sin alertas abiertas." />;
  return (
    <ul className="c22-section__list" aria-label="Alertas abiertas">
      {alerts.map((alert) => (
        <li key={`${alert.kind}:${alert.entityId}:${alert.dueAt}`}>
          <span className="cocoa-cluster">
            <CocoaBadge tone={alertSeverityTone(alert.severity)} size="small" title={`Gravedad ${ALERT_SEVERITY_LABELS[alert.severity].toLowerCase()}`}>
              {alertKindLabel(alert.kind)}
            </CocoaBadge>
            <span>{alert.message}</span>
          </span>
          <span className="cocoa-cluster">
            <CocoaBadge tone="neutral" variant="outline" size="small" title={alert.entityId}>
              {alertEntityTypeLabel(alert.entityType)}
            </CocoaBadge>
            <strong>{formatDay(alert.dueAt)}</strong>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Resumen reutilizable (KPIs + tenencia + alertas): la Ficha lo compone y el cajón de la vista de grupo lo pinta entero. */
export function RealEstateAssetSummary({ detail, legalEntityName }: { detail: RealEstateAssetDetail; legalEntityName: string | null }) {
  return (
    <div className="cocoa-stack" data-gap="4">
      <AssetKpiStrip detail={detail} />
      <TenureCallout tenure={detail.currentTenure} legalEntityName={legalEntityName} />
      <CocoaSection title="Alertas abiertas" meta={plural(detail.alerts.length, "alerta", "alertas")} headingLevel={3}>
        <AlertsList alerts={detail.alerts} />
      </CocoaSection>
    </div>
  );
}

function UnitCard({ unit, canManage, onEdit, onNewCharge, onEditCharge }: { unit: RealEstateUnitWithCharges; canManage: boolean; onEdit: () => void; onNewCharge: () => void; onEditCharge: (charge: RealEstateChargeRecord) => void }) {
  const identifier = unit.registryFincaNumber ? `Finca ${unit.registryFincaNumber}` : unit.cadastralReference ?? "Sin identificar";
  const cadastralValue = unit.cadastralValueLand || unit.cadastralValueBuilding ? `${formatMoney(unit.cadastralValueLand)} suelo · ${formatMoney(unit.cadastralValueBuilding)} construcción` : null;
  return (
    <CocoaSection
      title={identifier}
      meta={
        <CocoaBadge tone="info" size="small">
          {titleKindLabel(unit.titleKind)}
        </CocoaBadge>
      }
      headingLevel={3}
      action={
        canManage ? (
          <CocoaButton variant="plain" size="small" onClick={onEdit}>
            {ACTIONS.edit}
          </CocoaButton>
        ) : undefined
      }
      aria-label={`Unidad ${identifier}`}
    >
      <ul className="c22-section__list" aria-label={`Datos de la unidad ${identifier}`}>
        <li>
          <span>Tipo de unidad</span>
          <strong>{unitKindLabel(unit.kind)}</strong>
        </li>
        {unit.cadastralReference ? (
          <li>
            <span>Referencia catastral</span>
            <strong>{unit.cadastralReference}</strong>
          </li>
        ) : null}
        {unit.registryOffice ? (
          <li>
            <span>Registro</span>
            <strong>
              {unit.registryOffice}
              {unit.registryTomo ? ` · tomo ${unit.registryTomo}` : ""}
              {unit.registryLibro ? ` · libro ${unit.registryLibro}` : ""}
              {unit.registryFolio ? ` · folio ${unit.registryFolio}` : ""}
            </strong>
          </li>
        ) : null}
        {unit.cru ? (
          <li>
            <span>CRU</span>
            <strong>{unit.cru}</strong>
          </li>
        ) : null}
        <li>
          <span>Uso · superficie</span>
          <strong>
            {useCodeLabel(unit.useCode)} · {surface(unit.surfaceM2)}
          </strong>
        </li>
        {cadastralValue ? (
          <li>
            <span>Valor catastral</span>
            <strong>{cadastralValue}</strong>
          </li>
        ) : null}
        {unit.titleHolderName ? (
          <li>
            <span>Titular</span>
            <strong>{unit.titleHolderName}</strong>
          </li>
        ) : null}
        {unit.titleDeedDate ? (
          <li>
            <span>Escritura</span>
            <strong>
              {formatDay(unit.titleDeedDate)}
              {unit.notary ? ` · ${unit.notary}` : ""}
            </strong>
          </li>
        ) : null}
      </ul>
      <CocoaSection title="Cargas" meta={plural(unit.charges.length, "carga", "cargas")} headingLevel={3} variant="plain" padding="none" action={canManage ? <CocoaButton variant="plain" size="small" onClick={onNewCharge}>{ACTIONS.add}</CocoaButton> : undefined}>
        {unit.charges.length === 0 ? (
          <CocoaState kind="empty" inline title="Libre de cargas registradas." />
        ) : (
          <ul className="c22-section__list" aria-label={`Cargas de ${identifier}`}>
            {unit.charges.map((charge) => (
              <li key={charge.id}>
                <span className="cocoa-cluster">
                  <CocoaBadge tone={charge.cancelledAt ? "neutral" : "warning"} size="small">
                    {chargeKindLabel(charge.kind)}
                  </CocoaBadge>
                  <span>
                    {charge.holderName ?? "Sin titular"}
                    {charge.cancelledAt ? ` · cancelada el ${formatDay(charge.cancelledAt)}` : charge.expiresAt ? ` · vence el ${formatDay(charge.expiresAt)}` : ""}
                  </span>
                </span>
                <span className="cocoa-cluster">
                  <strong>{formatMoney(charge.outstandingAmount ?? charge.amount)}</strong>
                  {canManage ? (
                    <CocoaButton variant="plain" size="small" onClick={() => onEditCharge(charge)}>
                      {ACTIONS.edit}
                    </CocoaButton>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CocoaSection>
    </CocoaSection>
  );
}

function BuildingData({ detail }: { detail: RealEstateAssetDetail }) {
  const { asset } = detail;
  return (
    <ul className="c22-section__list" aria-label="Datos del edificio">
      <li>
        <span>{FIELD_LABELS.status}</span>
        <strong>
          <CocoaBadge tone={assetStatusTone(asset.status)} size="small">
            {assetStatusLabel(asset.status)}
          </CocoaBadge>
        </strong>
      </li>
      <li>
        <span>Construcción · última reforma</span>
        <strong>
          {asset.yearBuilt ?? EMPTY} · {asset.yearLastRefurbished ?? EMPTY}
        </strong>
      </li>
      <li>
        <span>Superficie construida · parcela</span>
        <strong>
          {surface(asset.builtSurfaceM2)} · {surface(asset.plotSurfaceM2)}
        </strong>
      </li>
      <li>
        <span>Plantas sobre · bajo rasante</span>
        <strong>
          {asset.floorsAbove ?? EMPTY} · {asset.floorsBelow ?? EMPTY}
        </strong>
      </li>
      <li>
        <span>Habitaciones</span>
        <strong>{asset.roomsCount ?? EMPTY}</strong>
      </li>
      <li>
        <span>Protección patrimonial</span>
        <strong>{protectionLevelLabel(asset.protectionLevel)}</strong>
      </li>
      <li>
        <span>Calificación energética</span>
        <strong>
          {asset.energyRating ?? EMPTY}
          {asset.energyCertValidUntil ? ` · válida hasta el ${formatDay(asset.energyCertValidUntil)}` : ""}
        </strong>
      </li>
      <li>
        <span>Valor de referencia (Catastro)</span>
        <strong>{formatMoney(asset.referenceValue)}</strong>
      </li>
      {asset.notes ? (
        <li>
          <span>{FIELD_LABELS.notes}</span>
          <strong>{asset.notes}</strong>
        </li>
      ) : null}
    </ul>
  );
}

function UpcomingInspector({ upcoming, error, today }: { upcoming: RealEstateCalendarEvent[] | null; error: unknown; today: string }) {
  let body: ReactNode;
  if (error) body = <CocoaState kind="error" inline title="No se pudo cargar el calendario" message={realEstateErrorMessage(error)} />;
  else if (upcoming === null) body = <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />;
  else if (upcoming.length === 0) body = <CocoaState kind="empty" inline title={`Sin vencimientos hasta el ${formatDay(addDays(today, UPCOMING_DAYS))}.`} />;
  else
    body = (
      <ul className="c22-section__list" aria-label={`Vencimientos de los próximos ${UPCOMING_DAYS} días`}>
        {upcoming.map((event) => (
          <li key={`${event.kind}:${event.entityId}:${event.dueAt}`}>
            <span className="cocoa-cluster">
              <CocoaBadge tone="neutral" variant="outline" size="small">
                {alertEntityTypeLabel(event.entityType)}
              </CocoaBadge>
              <span>{event.label}</span>
            </span>
            <strong>{formatDay(event.dueAt)}</strong>
          </li>
        ))}
      </ul>
    );
  return (
    <CocoaSection title={`Próximos ${UPCOMING_DAYS} días`} meta={upcoming ? plural(upcoming.length, "vencimiento", "vencimientos") : undefined} headingLevel={3} aria-label="Calendario próximo">
      {body}
    </CocoaSection>
  );
}

/** Presentación de la Ficha: todo el estado llega por props (los tests la pintan con react-dom/server). */
export function RealEstateAssetView({ propertyId, propertyName, legalEntityName, detail, loading, error, upcoming, upcomingError, canManage, today, onRefresh, onNotify }: RealEstateAssetViewProps) {
  const hosted = useTabHost() !== null;
  const state = assetViewState({ loading, error, detail });

  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [initial, setInitial] = useState<FormValues | null>(null);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [tenureBusy, setTenureBusy] = useState<RealEstateTenureAction | null>(null);

  const spec = useMemo(() => (drawer ? specOf(drawer) : []), [drawer]);
  const errors = useMemo(() => validateForm(spec, values), [spec, values]);
  const valid = Object.keys(errors).length === 0;
  const shownErrors = touched ? errors : {};

  function openDrawer(next: DrawerState) {
    const record = initialRecordOf(next, detail);
    const start = valuesOf(specOf(next), record);
    if (next.kind === "valuation" && !start.valuedAt) start.valuedAt = today;
    if (next.kind === "tenure" && !next.tenure && !start.startDate) start.startDate = today;
    if (next.kind === "asset" && next.mode === "new" && !start.name) start.name = propertyName;
    setValues(start);
    setInitial(record ? start : null);
    setTouched(false);
    setFailure(null);
    setDrawer(next);
  }

  function closeDrawer() {
    if (saving) return;
    setDrawer(null);
  }

  function setValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    if (!drawer || saving) return;
    setTouched(true);
    if (!valid) return;
    const body = formBody(spec, values, initial ?? undefined);
    if (initial && Object.keys(body).length === 0) {
      setDrawer(null);
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      let message = "Cambios guardados.";
      switch (drawer.kind) {
        case "asset":
          if (drawer.mode === "new") {
            await createRealEstateAsset(body as unknown as RealEstateAssetRequest, propertyId);
            message = "Ficha del activo creada con la unidad del censo y la tenencia en borrador.";
          } else {
            await updateRealEstateAsset(body as RealEstateAssetPatchRequest, propertyId);
            message = "Ficha del activo actualizada.";
          }
          break;
        case "unit":
          if (drawer.unit) await updateRealEstateUnit(drawer.unit.id, body as RealEstateUnitPatchRequest, propertyId);
          else await createRealEstateUnit(body as RealEstateUnitRequest, propertyId);
          message = drawer.unit ? "Unidad actualizada." : "Unidad registrada.";
          break;
        case "charge":
          if (drawer.charge) await updateRealEstateCharge(drawer.charge.id, body as RealEstateChargePatchRequest, propertyId);
          else await createRealEstateCharge(drawer.unitId, body as unknown as RealEstateChargeRequest, propertyId);
          message = drawer.charge ? "Carga actualizada." : "Carga registrada.";
          break;
        case "tenure":
          if (drawer.tenure) await updateRealEstateTenure(drawer.tenure.id, body as RealEstateTenurePatchRequest, propertyId);
          else await createRealEstateTenure(body as unknown as RealEstateTenureRequest, propertyId);
          message = drawer.tenure ? "Tenencia actualizada." : "Tenencia registrada en borrador: actívala cuando el contrato esté en vigor.";
          break;
        case "valuation":
          await createRealEstateValuation(body as unknown as RealEstateValuationRequest, propertyId);
          message = "Valoración registrada.";
          break;
      }
      onNotify(message, "success");
      setDrawer(null);
      onRefresh();
    } catch (err: unknown) {
      setFailure(realEstateErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function tenureAction(tenure: RealEstateTenureRecord, action: RealEstateTenureAction) {
    if (tenureBusy) return;
    setTenureBusy(action);
    try {
      await updateRealEstateTenure(tenure.id, { action }, propertyId);
      onNotify(action === "activar" ? "Tenencia activada." : "Tenencia resuelta.", "success");
      onRefresh();
    } catch (err: unknown) {
      onNotify(realEstateErrorMessage(err), "error");
    } finally {
      setTenureBusy(null);
    }
  }

  const newValuationLabel = newLabel("f", "valoración");
  const editAssetLabel = "Editar ficha";

  let body: ReactNode;
  if (state === "loading") {
    body = <CocoaState kind="loading" title={STATUS_LABELS.loading} />;
  } else if (state === "forbidden") {
    body = <CocoaState kind="error" illustration="error" title={UI_STATES.forbidden.title} message={UI_STATES.forbidden.message} role="alert" />;
  } else if (state === "error") {
    body = <CocoaState kind="error" title="No se pudo cargar el activo inmobiliario" message={realEstateErrorMessage(error)} onRetry={onRefresh} />;
  } else if (state === "empty" || !detail) {
    body = (
      <CocoaState
        kind="empty"
        illustration="box"
        title={EMPTY_ASSET_TITLE}
        message={canManage ? EMPTY_ASSET_MESSAGE : `${EMPTY_ASSET_MESSAGE} El alta la hace quien gestiona el activo inmobiliario.`}
        primaryAction={canManage ? { label: CREATE_ASSET_LABEL, onClick: () => openDrawer({ kind: "asset", mode: "new" }) } : undefined}
      />
    );
  } else {
    const tenure = detail.currentTenure;
    const tenureActions = canManage ? (
      <span className="cocoa-cluster">
        {tenure && tenure.status === "borrador" ? (
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void tenureAction(tenure, "activar")} loading={tenureBusy === "activar"} disabled={tenureBusy !== null}>
            {ACTIONS.activate}
          </CocoaButton>
        ) : null}
        {tenure && (tenure.status === "vigente" || tenure.status === "borrador") ? (
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openDrawer({ kind: "tenure", tenure })} disabled={tenureBusy !== null}>
            {ACTIONS.edit}
          </CocoaButton>
        ) : null}
        {tenure && tenure.status === "vigente" ? (
          <CocoaButton variant="bordered" tone="destructive" size="small" onClick={() => void tenureAction(tenure, "resolver")} loading={tenureBusy === "resolver"} disabled={tenureBusy !== null}>
            Resolver
          </CocoaButton>
        ) : null}
        {!tenure ? (
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => openDrawer({ kind: "tenure", tenure: null })}>
            Registrar tenencia
          </CocoaButton>
        ) : null}
      </span>
    ) : undefined;

    const sidebar = (
      <div className="cocoa-stack" data-gap="3" aria-label="Unidades registrales y catastrales">
        {detail.units.length === 0 ? <CocoaState kind="empty" inline title="Sin unidades registrales." /> : null}
        {detail.units.map((unit) => (
          <UnitCard key={unit.id} unit={unit} canManage={canManage} onEdit={() => openDrawer({ kind: "unit", unit })} onNewCharge={() => openDrawer({ kind: "charge", unitId: unit.id, charge: null })} onEditCharge={(charge) => openDrawer({ kind: "charge", unitId: unit.id, charge })} />
        ))}
        {canManage ? (
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openDrawer({ kind: "unit", unit: null })}>
            {newLabel("f", "unidad registral")}
          </CocoaButton>
        ) : null}
      </div>
    );

    const content = (
      <div className="cocoa-stack" data-gap="4">
        <TenureCallout tenure={tenure} legalEntityName={legalEntityName} actions={tenureActions} />
        <CocoaSection title="Datos del edificio" meta={detail.asset.name} headingLevel={3} action={canManage ? <CocoaButton variant="plain" size="small" onClick={() => openDrawer({ kind: "asset", mode: "edit" })}>{ACTIONS.edit}</CocoaButton> : undefined}>
          <BuildingData detail={detail} />
        </CocoaSection>
        <CocoaSection title="Valoraciones" meta={plural(detail.valuations.length, "valoración", "valoraciones")} headingLevel={3} padding={detail.valuations.length > 0 ? "none" : "md"} action={canManage ? <CocoaButton variant="plain" size="small" onClick={() => openDrawer({ kind: "valuation" })}>{newValuationLabel}</CocoaButton> : undefined}>
          {detail.valuations.length === 0 ? (
            <CocoaState kind="empty" inline title="Sin valoraciones registradas." />
          ) : (
            <CocoaScrollArea aria-label="Valoraciones del activo">
              <CocoaTable columns={VALUATION_COLUMNS} rows={detail.valuations} rowKey="id" caption="Valoraciones del activo" aria-label="Valoraciones del activo" />
            </CocoaScrollArea>
          )}
        </CocoaSection>
        <CocoaSection title="Alertas abiertas" meta={plural(detail.alerts.length, "alerta", "alertas")} headingLevel={3}>
          <AlertsList alerts={detail.alerts} />
        </CocoaSection>
      </div>
    );

    body = (
      <>
        <AssetKpiStrip detail={detail} />
        <CocoaSplitView sidebar={sidebar} content={content} inspector={<UpcomingInspector upcoming={upcoming} error={upcomingError} today={today} />} sidebarWidth={300} inspectorWidth={320} collapsibleSidebar={false} />
      </>
    );
  }

  return (
    <CocoaPage
      eyebrow="Finanzas · Activo inmobiliario"
      title="Ficha del activo"
      subtitle={hosted ? undefined : `Inmueble de ${propertyName}: unidades registrales, tenencia, valoraciones y alertas.`}
      actions={
        detail && canManage ? (
          <CocoaButton variant="filled" tone="accent" size={hosted ? "small" : "regular"} onClick={() => openDrawer({ kind: "asset", mode: "edit" })}>
            {editAssetLabel}
          </CocoaButton>
        ) : undefined
      }
      commands={[{ id: "real-estate-refresh", label: "Actualizar la ficha del activo", run: onRefresh }]}
    >
      {body}

      <CocoaDrawer
        open={drawer !== null}
        onClose={closeDrawer}
        title={drawer ? drawerTitle(drawer) : "Formulario"}
        subtitle={propertyName}
        side="right"
        size="lg"
        dismissible={!saving}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={closeDrawer} disabled={saving}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void save()} loading={saving} disabled={saving || (touched && !valid)}>
              {initial ? ACTIONS.saveChanges : ACTIONS.save}
            </CocoaButton>
          </>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          {failure ? (
            <CocoaCallout tone="danger" role="alert" title={STATUS_LABELS.saveError}>
              {failure}
            </CocoaCallout>
          ) : null}
          {drawer?.kind === "asset" && drawer.mode === "new" ? <CocoaCallout tone="info">La ficha nace con la unidad prellenada del censo del centro y una tenencia en propiedad en borrador; completa después las unidades, la tenencia y las valoraciones.</CocoaCallout> : null}
          {drawer?.kind === "tenure" && !drawer.tenure ? <CocoaCallout tone="info">La tenencia se guarda en borrador; al activarla pasa a vigente (solo puede haber una vigente por centro).</CocoaCallout> : null}
          {drawer ? <SpecForm spec={spec} values={values} errors={shownErrors} disabled={saving} onChange={setValue} /> : null}
        </div>
      </CocoaDrawer>
    </CocoaPage>
  );
}

// ---------------------------------------------------------------------------
// Contenedor: centro, permisos, carga y toasts
// ---------------------------------------------------------------------------

/** Ficha del activo del centro activo (o del `propertyId` que le pase un contenedor: la vista de grupo nunca cambia la propiedad activa). */
export function RealEstateAssetScreen({ propertyId: propertyIdProp }: { propertyId?: string } = {}) {
  const active = getActiveProperty();
  const propertyId = propertyIdProp ?? active.propertyId;
  const gate = useNavGate(propertyId);
  const canManage = canDo(gate, MANAGE_PERMISSION);
  const { showToast } = useToast();
  const today = todayIso();

  const detail = useResource<RealEstateAssetDetail>(() => getRealEstateAsset(propertyId), propertyId);
  const hasAsset = detail.data !== null;
  const upcoming = useResource<RealEstateCalendarEvent[] | null>(() => (hasAsset ? loadUpcomingEvents(propertyId, today) : Promise.resolve(null)), `${propertyId}|${hasAsset ? "1" : "0"}|${today}`);

  const [names, setNames] = useState<{ propertyName: string; legalEntityName: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    loadSwitchableProperties()
      .then((list) => {
        if (!alive) return;
        const property = list.find((candidate) => candidate.id === propertyId);
        setNames(property ? { propertyName: property.name, legalEntityName: property.legalEntityName ?? null } : null);
      })
      .catch(() => {
        /* el nombre del centro activo sigue disponible en la sesión */
      });
    return () => {
      alive = false;
    };
  }, [propertyId]);

  const refreshDetail = detail.refresh;
  const refreshUpcoming = upcoming.refresh;
  const onRefresh = useCallback(() => {
    refreshDetail();
    refreshUpcoming();
  }, [refreshDetail, refreshUpcoming]);
  const onNotify = useCallback((message: string, variant: "success" | "error") => showToast(message, { variant }), [showToast]);

  const propertyName = names?.propertyName ?? (propertyId === active.propertyId ? active.propertyName : propertyId);

  return (
    <RealEstateAssetView
      propertyId={propertyId}
      propertyName={propertyName}
      legalEntityName={names?.legalEntityName ?? null}
      detail={detail.data}
      loading={detail.loading}
      error={detail.error}
      upcoming={hasAsset ? (upcoming.data ?? null) : null}
      upcomingError={upcoming.error}
      canManage={canManage}
      today={today}
      onRefresh={onRefresh}
      onNotify={onNotify}
    />
  );
}

export default RealEstateAssetScreen;
