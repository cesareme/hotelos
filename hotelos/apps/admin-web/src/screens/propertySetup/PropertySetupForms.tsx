// Property setup forms — the 14 configuration forms of Configuración ›
// Propiedad / Habitaciones y espacios / Contabilidad y fiscal / Inteligencia
// artificial and Operaciones › Pisos / Mantenimiento (Tanda 5 · L1c: each
// one is a tab of its container).
//
// Cocoa 22 pilot of the «formulario / ajustes» archetype (docs/design/
// COCOA-22.md §4): CocoaPage (hosted: the container paints eyebrow and
// title, the page its description and status) → two CocoaSection panels
// (about · current state) on the 12-column grid → CocoaFormSection with the
// dynamic CocoaField controls (input / select / switch / date / textarea /
// option chips; «Guardar y añadir otro» + «Historial» in its footer) →
// validation lists → read-only DataPreview → CocoaActionBar (Cancelar · Guardar; ⌘/Ctrl+Enter saves).
// Definitions, pre-fill and save logic are untouched: only the rendering
// moved from the legacy FormComponents to the primitives.

import { getActivePropertyId } from "../../services/activeProperty";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { DataPreview } from "../../components/forms/FormComponents";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaField,
  CocoaFormSection,
  CocoaGrid,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSpan,
  CocoaSwitch,
  openTabPath,
  type CocoaTone
} from "../../components/cocoa";
import {
  backOfficeEndpoints,
  fetchPropertySetupForm,
  savePropertySetupForm,
  type PropertySetupForm,
  type PropertySetupFormField
} from "../../services/backofficeApi";
import { FISCAL_TERRITORY_OPTIONS, TAX_REGION_OPTIONS, TOURISM_TAX_REGION_OPTIONS, normalizeTaxRegionClient } from "../../services/taxesApi";
import { urlForScreen } from "../../navigation/nav-tree";
import { navigateTo } from "../../lib/navigate";
import { ACTIONS } from "../../content/actions";
import { plural } from "../../lib/format";

// «Cancelar» returns to the single configuration hub without a full reload.
const SETUP_CENTER_PATH = urlForScreen("SetupCenterScreen") ?? "/configuracion/puesta-en-marcha";

// Tanda 3: select options are canonical {value, label} pairs (the API
// definition serves them for taxRegion / tourismTaxRegion / fiscalTerritory;
// legacy fields still send plain strings). Both shapes are accepted.
type FieldOption = string | { value: string; label: string };
type SetupField = Omit<PropertySetupFormField, "options"> & { options?: FieldOption[] };

function optionsOf(field: SetupField): Array<{ value: string; label: string }> {
  return (field.options ?? []).map((option) => (typeof option === "string" ? { value: option, label: option } : option));
}

const TAX_REGION_FIELD_OPTIONS: FieldOption[] = TAX_REGION_OPTIONS.map((option) => ({ value: option.value, label: option.label }));
const TOURISM_TAX_FIELD_OPTIONS: FieldOption[] = TOURISM_TAX_REGION_OPTIONS.filter((option) => option.value !== "").map((option) => ({ value: option.value, label: option.label }));
const FISCAL_TERRITORY_FIELD_OPTIONS: FieldOption[] = FISCAL_TERRITORY_OPTIONS.map((option) => ({ value: option.value, label: option.label }));

type FormDefinition = {
  code: string;
  title: string;
  route: string;
  endpoint: string;
  description: string;
  targetTable: string;
  inputCategories: string[];
  fields: SetupField[];
  checks: string[];
};

type PropertySetupFormView = {
  code: string;
  title: string;
  route: string;
  endpoint: string;
  description: string;
  targetTable: string;
  inputCategories: string[];
  fields: SetupField[];
  checks: string[];
  status?: string;
  permission?: string;
  existingData?: unknown;
  submissions?: unknown[];
  dataQuality?: Array<{ code: string; severity: string; message: string }>;
};

const forms: FormDefinition[] = [
  {
    code: "property_profile",
    title: "Perfil de la propiedad",
    route: "/configuracion/propiedad",
    endpoint: backOfficeEndpoints.propertySetupForm,
    description: "Perfil legal, identidad fiscal, dirección, zona horaria, moneda, idioma, región fiscal y reglas de fecha de negocio.",
    targetTable: "properties + property_setup_form_submissions",
    inputCategories: ["Perfil de la propiedad", "Perfil legal", "Reglas de fecha de negocio"],
    fields: [
      { key: "name", label: "Nombre de la propiedad", inputType: "text", required: true },
      { key: "legalName", label: "Razón social", inputType: "text", required: true },
      { key: "taxId", label: "NIF / CIF", inputType: "text", required: true },
      { key: "address", label: "Dirección", inputType: "textarea", required: true },
      { key: "country", label: "País", inputType: "select", options: ["ES", "PT", "FR", "IT"], required: true },
      { key: "province", label: "Provincia", inputType: "text" },
      { key: "city", label: "Localidad", inputType: "text", required: true },
      { key: "postalCode", label: "Código postal", inputType: "text" },
      { key: "ineMunicipalityCode", label: "Código INE del municipio", inputType: "text" },
      { key: "phone", label: "Teléfono de contacto", inputType: "text" },
      { key: "email", label: "Correo de contacto", inputType: "text" },
      { key: "website", label: "Sitio web", inputType: "text" },
      { key: "starRating", label: "Categoría / estrellas", inputType: "select", options: ["1*", "2*", "3*", "4*", "5*", "5* GL"] },
      { key: "totalRooms", label: "Total de habitaciones", inputType: "number" },
      { key: "checkInTime", label: "Hora de entrada por defecto", inputType: "text" },
      { key: "checkOutTime", label: "Hora de salida por defecto", inputType: "text" },
      { key: "timezone", label: "Zona horaria", inputType: "select", options: ["Europe/Madrid", "Europe/Lisbon", "Europe/Paris"], required: true },
      { key: "currency", label: "Moneda", inputType: "select", options: ["EUR", "GBP", "USD"], required: true },
      { key: "taxRegion", label: "Región fiscal", inputType: "select", options: TAX_REGION_FIELD_OPTIONS, required: true },
      { key: "fiscalTerritory", label: "Territorio foral (ruta de envío de facturas)", inputType: "select", options: FISCAL_TERRITORY_FIELD_OPTIONS },
      { key: "tourismTaxRegion", label: "Región de tasa turística", inputType: "select", options: TOURISM_TAX_FIELD_OPTIONS },
      { key: "businessDateRules", label: "Reglas de fecha de negocio", inputType: "textarea" }
    ],
    checks: ["La razón social, el NIF/CIF y la dirección deben estar completos.", "La región fiscal determina la figura del impuesto (IVA, IGIC o IPSI) y provisiona los tipos del catálogo al guardar.", "El código INE y el código postal los exige SES.HOSPEDAJES para dar de alta el establecimiento.", "La zona horaria y las reglas de fecha de negocio determinan la hora del cierre nocturno (night audit)."]
  },
  {
    code: "building",
    title: "Edificios",
    route: "/configuracion/propiedad/edificios",
    endpoint: backOfficeEndpoints.propertySetupForm,
    description: "Crea los edificios físicos a los que se podrán asociar plantas, zonas, habitaciones y espacios.",
    targetTable: "buildings",
    inputCategories: ["Edificios", "Mapeador de propiedad"],
    fields: [
      { key: "name", label: "Nombre del edificio", inputType: "text", required: true },
      { key: "code", label: "Código del edificio", inputType: "text", required: true },
      { key: "description", label: "Descripción", inputType: "textarea" },
      { key: "sortOrder", label: "Orden", inputType: "number" },
      { key: "active", label: "Activo", inputType: "boolean" }
    ],
    checks: ["El código del edificio debe ser único.", "Cada planta activa debe pertenecer a un edificio."]
  },
  {
    code: "floor",
    title: "Plantas",
    route: "/configuracion/propiedad/plantas",
    endpoint: backOfficeEndpoints.propertySetupForm,
    description: "Crea plantas dentro de los edificios para mapear habitaciones y recursos.",
    targetTable: "floors",
    inputCategories: ["Plantas", "Edificios", "Mapeador de propiedad"],
    fields: [
      { key: "buildingId", label: "Edificio", inputType: "select", options: ["Main Building", "Annex"], required: true },
      { key: "name", label: "Nombre de la planta", inputType: "text", required: true },
      { key: "floorNumber", label: "Número de planta", inputType: "number" },
      { key: "code", label: "Código de planta", inputType: "text" },
      { key: "sortOrder", label: "Orden", inputType: "number" },
      { key: "active", label: "Activo", inputType: "boolean" }
    ],
    checks: ["Las plantas deben estar vinculadas a un edificio.", "Las etiquetas de planta deben ser claras para el personal."]
  },
  {
    code: "zone",
    title: "Zonas",
    route: "/configuracion/propiedad/zonas",
    endpoint: backOfficeEndpoints.propertySetupForm,
    description: "Agrupa las plantas en zonas operativas para limpieza, mantenimiento, informes de ingresos y enrutado de recursos.",
    targetTable: "property_zones",
    inputCategories: ["Zonas", "Secciones de limpieza", "Áreas de mantenimiento"],
    fields: [
      { key: "buildingId", label: "Edificio", inputType: "select", options: ["Main Building", "Annex"] },
      { key: "floorId", label: "Planta", inputType: "select", options: ["Floor 1", "Floor 2", "Floor 3", "Floor 4"] },
      { key: "name", label: "Nombre de la zona", inputType: "text", required: true },
      { key: "zoneType", label: "Tipo de zona", inputType: "select", options: ["guest_rooms", "public_area", "back_of_house", "technical", "food_beverage", "wellness", "parking", "events", "outdoor"], required: true },
      { key: "code", label: "Código", inputType: "text" },
      { key: "description", label: "Descripción", inputType: "textarea" },
      { key: "active", label: "Activo", inputType: "boolean" }
    ],
    checks: ["Las zonas vendibles deben contener habitaciones o recursos.", "Las zonas operativas deben tener responsables de limpieza y mantenimiento."]
  },
  {
    code: "room_type",
    title: "Tipos de habitación",
    route: "/configuracion/habitaciones/tipos",
    endpoint: backOfficeEndpoints.propertySetupForm,
    description: "Crea tipos de habitación con ocupación, configuración de camas, características, categoría de limpieza y valores de venta por defecto.",
    targetTable: "room_types",
    inputCategories: ["Tipos de habitación", "Características de la habitación", "Tipos de cama", "Tipos de vista", "Características de accesibilidad"],
    fields: [
      { key: "name", label: "Nombre del tipo de habitación", inputType: "text", required: true },
      { key: "code", label: "Código del tipo de habitación", inputType: "text", required: true },
      { key: "category", label: "Categoría", inputType: "select", options: ["Standard", "Superior", "Suite", "Apartment"], required: true },
      { key: "baseOccupancy", label: "Ocupación base", inputType: "number", required: true },
      { key: "maxOccupancy", label: "Ocupación máxima", inputType: "number", required: true },
      { key: "maxAdults", label: "Adultos máximo", inputType: "number" },
      { key: "maxChildren", label: "Niños máximo", inputType: "number" },
      { key: "extraBedCapacity", label: "Capacidad de camas supletorias", inputType: "number" },
      { key: "defaultBedSetup", label: "Configuración de camas por defecto", inputType: "select", options: ["King bed", "Queen bed", "Twin beds", "Sofa bed"] },
      { key: "defaultFeatures", label: "Características por defecto", inputType: "multi_select", options: ["Balcony", "Sea view", "City view", "Accessible"] },
      { key: "defaultCleaningCategory", label: "Categoría de limpieza por defecto", inputType: "select", options: ["Standard", "Suite", "Apartment", "Deep clean"] },
      { key: "smokingPolicy", label: "Política de fumadores", inputType: "select", options: ["non_smoking", "smoking", "mixed"] },
      { key: "baseRate", label: "Tarifa base (€)", inputType: "money" },
      { key: "sellable", label: "Vendible", inputType: "boolean" },
      { key: "displayOrder", label: "Orden de visualización", inputType: "number" }
    ],
    checks: ["La ocupación del tipo de habitación debe ser válida.", "Los tipos de habitación deben tener habitaciones vinculadas antes de la puesta en marcha."]
  },
  {
    code: "room",
    title: "Habitaciones",
    route: "/configuracion/habitaciones",
    endpoint: backOfficeEndpoints.propertySetupForm,
    description: "Crea habitaciones y vincúlalas a su tipo, edificio, planta, zona, sección de limpieza y área de mantenimiento.",
    targetTable: "rooms",
    inputCategories: ["Habitaciones", "Tipos de habitación", "Edificios", "Plantas", "Zonas", "Secciones de limpieza", "Áreas de mantenimiento"],
    fields: [
      { key: "roomNumber", label: "Número de habitación", inputType: "text", required: true },
      { key: "displayName", label: "Nombre visible", inputType: "text" },
      { key: "roomTypeId", label: "Tipo de habitación", inputType: "select", options: ["Double Standard", "Suite"], required: true },
      { key: "buildingId", label: "Edificio", inputType: "select", options: ["Main Building"], required: true },
      { key: "floorId", label: "Planta", inputType: "select", options: ["Floor 4"], required: true },
      { key: "zoneId", label: "Zona", inputType: "select", options: ["East Wing"], required: true },
      { key: "standardOccupancy", label: "Ocupación estándar", inputType: "number" },
      { key: "maxOccupancy", label: "Ocupación máxima", inputType: "number" },
      { key: "features", label: "Características", inputType: "multi_select", options: ["Balcony", "City view", "Minibar"] },
      { key: "viewType", label: "Tipo de vista", inputType: "select", options: ["City", "Sea", "Courtyard"] },
      { key: "squareMeters", label: "Metros cuadrados", inputType: "number" },
      { key: "sellable", label: "Vendible", inputType: "boolean" },
      { key: "active", label: "Activo", inputType: "boolean" }
    ],
    checks: ["Las habitaciones vendibles requieren tipo, edificio, planta y zona.", "El número de habitación debe ser único."]
  },
  {
    code: "space_resource",
    title: "Espacios y recursos",
    route: "/configuracion/habitaciones/espacios",
    endpoint: backOfficeEndpoints.propertySetupForm,
    description: "Crea aparcamiento, salas de reuniones, coworking, spa, espacios para eventos, espacios de restauración y otros recursos reservables.",
    targetTable: "property_spaces + property_setup_form_submissions",
    inputCategories: ["Espacios", "Recursos reservables", "Tipos de recurso", "Tipos de espacio"],
    fields: [
      { key: "name", label: "Nombre", inputType: "text", required: true },
      { key: "code", label: "Código", inputType: "text", required: true },
      { key: "resourceType", label: "Tipo de recurso", inputType: "select", options: ["parking_space", "meeting_room", "coworking_desk", "spa_room", "restaurant_table", "event_space", "equipment", "other"], required: true },
      { key: "spaceType", label: "Tipo de espacio", inputType: "select", options: ["parking", "meeting_room", "restaurant", "spa", "technical_room", "other"], required: true },
      { key: "capacity", label: "Capacidad", inputType: "number" },
      { key: "hourlyBookable", label: "Reservable por horas", inputType: "boolean" },
      { key: "dailyBookable", label: "Reservable por días", inputType: "boolean" },
      { key: "sellable", label: "Vendible", inputType: "boolean" },
      { key: "taxCode", label: "Código de impuesto", inputType: "select", options: ["IVA 21", "IVA 10", "IGIC", "Exempt"] },
      { key: "defaultRate", label: "Tarifa por defecto", inputType: "money" }
    ],
    checks: ["Los recursos vendibles necesitan código de impuesto y tarifa.", "Los recursos reservables necesitan capacidad y modo de reserva."]
  },
  {
    code: "department",
    title: "Departamentos",
    route: "/configuracion/propiedad/departamentos",
    endpoint: backOfficeEndpoints.propertySetupForm,
    description: "Crea departamentos y asigna responsables/usuarios para la titularidad operativa.",
    targetTable: "departments + user_departments",
    inputCategories: ["Departamentos", "Usuarios", "Roles"],
    fields: [
      { key: "name", label: "Nombre del departamento", inputType: "text", required: true },
      { key: "code", label: "Código del departamento", inputType: "text", required: true },
      { key: "description", label: "Descripción", inputType: "textarea" },
      { key: "managerUserId", label: "Responsable", inputType: "select", options: ["Reception Demo"] },
      { key: "userIds", label: "Usuarios", inputType: "multi_select", options: ["Reception Demo"] },
      { key: "active", label: "Activo", inputType: "boolean" }
    ],
    checks: ["El código de departamento debe ser único.", "Los departamentos críticos deben tener un responsable."]
  },
  {
    code: "housekeeping_setup",
    title: "Configuración de limpieza (housekeeping)",
    route: "/operaciones/pisos/ajustes",
    endpoint: backOfficeEndpoints.propertySetupForm,
    description: "Configura las secciones de limpieza, los tipos de tarea, los esquemas de limpieza, la política de inspección y las reglas de estancias.",
    targetTable: "housekeeping_sections + housekeeping_rules",
    inputCategories: ["Secciones de limpieza", "Tipos de tarea de limpieza", "Esquemas de limpieza"],
    fields: [
      { key: "sectionName", label: "Sección de limpieza", inputType: "text", required: true },
      { key: "taskTypes", label: "Tipos de tarea", inputType: "multi_select", options: ["Departure clean", "Stayover", "Inspection", "Deep clean"] },
      { key: "defaultDurationMinutes", label: "Duración por defecto (min)", inputType: "number" },
      { key: "inspectionRequired", label: "Inspección obligatoria", inputType: "boolean" },
      { key: "stayoverPolicy", label: "Política de estancias", inputType: "select", options: ["daily", "on_request", "every_two_days", "eco_opt_out"] },
      { key: "linenRules", label: "Reglas de lencería", inputType: "textarea" }
    ],
    checks: ["Las secciones de limpieza deben cubrir las habitaciones vendibles.", "La política de inspección debe estar configurada."]
  },
  {
    code: "maintenance_setup",
    title: "Configuración de mantenimiento",
    route: "/operaciones/mantenimiento/ajustes",
    endpoint: backOfficeEndpoints.propertySetupForm,
    description: "Configura las áreas de mantenimiento, los tipos de incidencia, las prioridades, las reglas de SLA y las reglas de bloqueo de habitaciones.",
    targetTable: "maintenance_areas + maintenance_rules",
    inputCategories: ["Áreas de mantenimiento", "Tipos de incidencia de mantenimiento", "Prioridades de órdenes de trabajo", "Categorías de activos"],
    fields: [
      { key: "areaName", label: "Área de mantenimiento", inputType: "text", required: true },
      { key: "issueTypes", label: "Tipos de incidencia", inputType: "multi_select", options: ["HVAC", "Plumbing", "Electric", "Furniture", "Lock"] },
      { key: "priorityLevels", label: "Niveles de prioridad", inputType: "multi_select", options: ["Low", "Normal", "High", "Blocking"] },
      { key: "slaRules", label: "Reglas de SLA", inputType: "textarea" },
      { key: "roomBlockingRules", label: "Reglas de bloqueo de habitaciones", inputType: "textarea" }
    ],
    checks: ["Las áreas de mantenimiento deben cubrir las habitaciones/activos activos.", "Las reglas de bloqueo requieren confirmación."]
  },
  {
    code: "revenue_setup",
    title: "Configuración de ingresos (revenue)",
    route: "/configuracion/contabilidad-fiscal/categorias-ingresos",
    endpoint: backOfficeEndpoints.propertySetupForm,
    description: "Configura los segmentos de mercado, los códigos de origen, los canales, las categorías de tarifa y las categorías de factores de previsión.",
    targetTable: "property_category_options + property_setup_form_submissions",
    inputCategories: ["Segmentos de mercado", "Códigos de origen", "Categorías de canal", "Categorías de tarifa", "Categorías de factores de previsión"],
    fields: [
      { key: "marketSegmentLabel", label: "Segmento de mercado", inputType: "text", required: true },
      { key: "sourceCodeLabel", label: "Código de origen", inputType: "text" },
      { key: "channelCategoryLabel", label: "Categoría de canal", inputType: "text" },
      { key: "rateCategoryLabel", label: "Categoría de tarifa", inputType: "text" },
      { key: "forecastDriverCategory", label: "Categoría de factor de previsión", inputType: "text" }
    ],
    checks: ["Los campos del informe de ingresos deben mapear Histórico, Previsión, OOO, no-shows e ingresos.", "Los canales y planes de tarifa necesitan categorías."]
  },
  {
    code: "finance_compliance_setup",
    title: "Finanzas y cumplimiento",
    route: "/configuracion/contabilidad-fiscal/perfil-inicial",
    endpoint: backOfficeEndpoints.propertySetupForm,
    description: "Configura la región fiscal, la autoridad de destino, las series de facturación, las categorías de método de pago y las reglas de retención.",
    targetTable: "property_compliance_settings + invoice_sequences",
    inputCategories: ["Códigos de impuesto", "Categorías de método de pago", "Series de facturación", "Ajustes de cumplimiento", "Reglas de retención"],
    fields: [
      { key: "taxRegion", label: "Región fiscal", inputType: "select", options: TAX_REGION_FIELD_OPTIONS, required: true },
      { key: "authorityType", label: "Tipo de autoridad", inputType: "select", options: ["ses_hospedajes", "mossos", "ertzaintza", "manual"], required: true },
      { key: "paymentMethodCategory", label: "Categoría de método de pago", inputType: "text" },
      { key: "invoiceSequenceCode", label: "Código de serie de factura", inputType: "text", required: true },
      { key: "invoiceType", label: "Tipo de factura", inputType: "select", options: ["full", "simplified", "rectifying", "credit_note"], required: true },
      { key: "retentionRule", label: "Regla de retención", inputType: "text" },
      { key: "submissionMode", label: "Modo de envío", inputType: "select", options: ["batch_export", "web_service", "manual"] }
    ],
    checks: ["La serie de facturación es un bloqueante para la puesta en marcha.", "El cumplimiento en España requiere enrutado a la autoridad y reglas de retención."]
  },
  {
    code: "ai_setup",
    title: "Configuración de IA",
    route: "/configuracion/ia/alta",
    endpoint: backOfficeEndpoints.propertySetupForm,
    description: "Configura el nivel de automatización de la IA, los idiomas de voz, la minimización de OCR y los valores por defecto de revisión humana.",
    targetTable: "property_ai_settings",
    inputCategories: ["Ajustes de IA", "Gobernanza de IA", "Privacidad de OCR"],
    fields: [
      { key: "aiEnabled", label: "IA activada", inputType: "boolean" },
      { key: "defaultAutomationLevel", label: "Nivel de automatización por defecto", inputType: "select", options: ["off", "draft_only", "suggest_and_confirm", "auto_low_risk"], required: true },
      { key: "guestFacingDisclosure", label: "Aviso visible para el huésped", inputType: "textarea" },
      { key: "voiceLocales", label: "Idiomas de voz", inputType: "multi_select", options: ["es-ES", "en-US", "ca-ES", "fr-FR"] },
      { key: "documentImageRetentionPolicy", label: "Política de retención de imágenes de documentos", inputType: "select", options: ["discard_after_ocr", "manual_exception_only"] }
    ],
    checks: ["Las imágenes de documentos de identidad no pueden almacenarse por defecto.", "Las acciones de IA de alto riesgo requieren confirmación."]
  },
  {
    code: "custom_field",
    title: "Campos personalizados",
    route: "/configuracion/propiedad/campos-personalizados",
    endpoint: backOfficeEndpoints.propertySetupForm,
    description: "Crea campos personalizados para habitaciones, reservas, huéspedes, recursos, activos u órdenes de trabajo.",
    targetTable: "property_custom_field_definitions",
    inputCategories: ["Campos personalizados", "Reglas de validación", "Reglas de visibilidad"],
    fields: [
      { key: "entityType", label: "Tipo de entidad", inputType: "select", options: ["room", "guest", "reservation", "asset", "inventory_resource"], required: true },
      { key: "fieldKey", label: "Clave del campo", inputType: "text", required: true },
      { key: "label", label: "Etiqueta", inputType: "text", required: true },
      { key: "dataType", label: "Tipo de dato", inputType: "select", options: ["text", "number", "boolean", "date", "select", "multi_select", "money", "json"], required: true },
      { key: "required", label: "Obligatorio", inputType: "boolean" },
      { key: "searchable", label: "Buscable", inputType: "boolean" },
      { key: "visibleInList", label: "Visible en listado", inputType: "boolean" },
      { key: "visibleInDetail", label: "Visible en detalle", inputType: "boolean" }
    ],
    checks: ["Las claves de campo personalizado deben ser únicas por entidad.", "Los campos personalizados obligatorios necesitan valores por defecto antes de la puesta en marcha."]
  }
];

export const propertySetupForms = forms;

function formDefinitionToView(form: FormDefinition): PropertySetupFormView {
  return {
    ...form,
    checks: form.checks
  };
}

function apiFormToView(form: PropertySetupForm): PropertySetupFormView {
  return {
    code: form.code,
    title: form.title,
    route: form.route,
    endpoint: form.apiRoute,
    description: form.description,
    targetTable: form.targetEntityType,
    inputCategories: form.inputCategories,
    fields: form.fields as SetupField[],
    checks: form.dataQualityChecks,
    status: form.status,
    permission: form.permission,
    existingData: form.existingData,
    submissions: form.submissions,
    dataQuality: form.dataQuality
  };
}

/**
 * Keeps the Spanish local labels but lets the API definition win whenever it
 * serves canonical {value, label} options for a select (single source of
 * truth for tax region / tourism tax region / fiscal territory).
 */
function mergeFieldOptions(local: SetupField[], api: SetupField[] | undefined): SetupField[] {
  if (!api?.length) return local;
  const byKey = new Map(api.map((field) => [field.key, field] as const));
  const merged = local.map((field) => {
    const remote = byKey.get(field.key);
    const remoteObjects = remote?.options?.some((option) => typeof option === "object") ?? false;
    return remoteObjects ? { ...field, options: remote!.options } : field;
  });
  // Fields the API knows and the local catalog does not (new columns) are appended.
  for (const field of api) {
    if (!merged.some((candidate) => candidate.key === field.key) && field.inputType !== "json") merged.push(field);
  }
  return merged;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function pickText(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

/**
 * Pre-fills the form from GET …/forms/:code `existingData` (Tanda 3). Only the
 * property-level forms are edit forms; the structural ones (buildings, rooms…)
 * return a LIST of existing records and stay create forms.
 */
function initialValuesFor(formCode: string, existingData: unknown): Record<string, unknown> {
  const data = asRecord(existingData);
  if (formCode === "property_profile") {
    const property = asRecord(data.property);
    const organization = asRecord(data.organization);
    const compliance = asRecord(data.compliance);
    const complianceCfg = asRecord(compliance.configurationJson);
    const values: Record<string, unknown> = {
      name: pickText(property, "name"),
      legalName: pickText(property, "legalName") || pickText(organization, "legalName"),
      taxId: pickText(organization, "taxId"),
      address: pickText(property, "address"),
      country: pickText(property, "country") || "ES",
      province: pickText(property, "province"),
      city: pickText(property, "municipality", "city"),
      postalCode: pickText(property, "postalCode") || pickText(complianceCfg, "postalCode"),
      ineMunicipalityCode: pickText(property, "ineMunicipalityCode") || pickText(complianceCfg, "ineMunicipalityCode"),
      timezone: pickText(property, "timezone"),
      taxRegion: normalizeTaxRegionClient(pickText(property, "taxRegion") || pickText(compliance, "taxRegion"), pickText(property, "province")) ?? "",
      fiscalTerritory: pickText(property, "fiscalTerritory") || pickText(compliance, "fiscalTerritory") || "common",
      tourismTaxRegion: pickText(compliance, "tourismTaxRegion")
    };
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
  }
  if (formCode === "finance_compliance_setup") {
    const compliance = asRecord(data.compliance);
    const complianceCfg = asRecord(compliance.configurationJson);
    const billing = asRecord(data.billing);
    const sequences = Array.isArray(billing.invoiceSequences) ? (billing.invoiceSequences as Array<Record<string, unknown>>) : [];
    const active = sequences.find((sequence) => sequence.active === true) ?? sequences[0];
    const values: Record<string, unknown> = {
      taxRegion: normalizeTaxRegionClient(pickText(compliance, "taxRegion")) ?? "",
      authorityType: pickText(complianceCfg, "authorityType"),
      invoiceSequenceCode: active ? pickText(active, "sequenceCode") : "",
      invoiceType: active ? pickText(active, "invoiceType") : "",
      retentionRule: pickText(complianceCfg, "retentionRule"),
      submissionMode: pickText(complianceCfg, "submissionMode")
    };
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
  }
  if (formCode === "ai_setup") {
    const settings = asRecord(data.settings);
    const cfg = asRecord(settings.configurationJson);
    const values: Record<string, unknown> = {
      aiEnabled: typeof settings.aiEnabled === "boolean" ? settings.aiEnabled : undefined,
      defaultAutomationLevel: pickText(settings, "defaultAutomationLevel"),
      guestFacingDisclosure: pickText(settings, "guestFacingDisclosure"),
      voiceLocales: Array.isArray(settings.voiceLocales) ? settings.voiceLocales : undefined,
      documentImageRetentionPolicy: pickText(cfg, "documentImageRetentionPolicy")
    };
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "" && value !== undefined));
  }
  return {};
}

// Input constraints for free-text fields the API validates strictly. The
// field catalog (PropertySetupFormField) carries no pattern/hint, so they are
// keyed here by field key. FISC-03: the issuer NIF/CIF/NIE feeds VeriFactu
// hash/QR, so it is normalized (uppercase, no spaces/dashes) and checked
// against the Spanish tax-id shape client-side; the checksum is validated
// server-side (isValidSpanishTaxId) and answers 400 with the reason.
const SPANISH_TAX_ID_PATTERN = "^(?:[0-9]{8}[A-Za-z]|[XYZxyz][0-9]{7}[A-Za-z]|[A-HJNPQRSUVWa-hjnpqrsuvw][0-9]{7}[0-9A-Ja-j])$";

const TEXT_FIELD_CONSTRAINTS: Record<
  string,
  { pattern?: string; hint?: string; placeholder?: string; normalize?: (value: string) => string }
> = {
  taxId: {
    pattern: SPANISH_TAX_ID_PATTERN,
    hint: "NIF/CIF/NIE español: 8 dígitos + letra (12345678Z), letra + 7 dígitos + control (B12345678) o NIE (X1234567L). El dígito de control se valida al guardar; sin NIF válido no se puede emitir factura en modo fiscal.",
    placeholder: "B12345678",
    normalize: (value) => value.toUpperCase().replace(/[\s-]/g, "")
  }
};

/** Keyboard/type of a free-text field by its label (phones and emails get the right keyboard). */
function textInputKind(label: string): { type: string; inputMode?: "tel" | "email" } {
  if (/tel[eé]fono|phone|\btel\b/i.test(label)) return { type: "tel", inputMode: "tel" };
  if (/email|correo/i.test(label)) return { type: "email", inputMode: "email" };
  return { type: "text" };
}

function textValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function listValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value) return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function fieldControl(field: SetupField, value: unknown, setValue: (key: string, value: unknown) => void): ReactNode {
  if (field.inputType === "select") {
    const options = optionsOf(field);
    const current = typeof value === "string" ? value : "";
    // An unrecognised stored value is kept as an extra option so the form
    // never silently blanks it (canonical value/label selects: the stored
    // value is the code, the user sees the label).
    const known = options.some((option) => option.value === current);
    const selectOptions = current && !known ? [...options, { value: current, label: `Valor actual: ${current}` }] : options;
    return (
      <CocoaField key={field.key} label={field.label} required={field.required}>
        <CocoaSelect value={current} onChange={(nextValue) => setValue(field.key, nextValue)} options={selectOptions} placeholder="Seleccionar..." aria-label={field.label} />
      </CocoaField>
    );
  }
  if (field.inputType === "multi_select") {
    const options = optionsOf(field);
    const selected = listValue(value);
    const toggle = (option: string) => setValue(field.key, selected.includes(option) ? selected.filter((item) => item !== option) : [...selected, option]);
    return (
      <CocoaField key={field.key} label={field.label} help="Pulsa una opción para activarla o desactivarla." fullWidth>
        <div role="group" aria-label={field.label} className="cocoa-cluster">
          {options.map((option) => {
            const active = selected.includes(option.value);
            return (
              <CocoaButton key={option.value} size="small" variant={active ? "tinted" : "bordered"} tone={active ? "accent" : "neutral"} aria-pressed={active} onClick={() => toggle(option.value)}>
                {option.label}
              </CocoaButton>
            );
          })}
        </div>
      </CocoaField>
    );
  }
  if (field.inputType === "boolean") {
    return (
      <CocoaField key={field.key} label={field.label} inline>
        <CocoaSwitch checked={Boolean(value)} onChange={(nextValue) => setValue(field.key, nextValue)} size="small" aria-label={field.label} />
      </CocoaField>
    );
  }
  if (field.inputType === "number") {
    return (
      <CocoaField key={field.key} label={field.label} required={field.required}>
        <CocoaInput type="number" inputMode="decimal" value={textValue(value)} onChange={(nextValue) => setValue(field.key, nextValue)} aria-label={field.label} />
      </CocoaField>
    );
  }
  if (field.inputType === "money") {
    return (
      <CocoaField key={field.key} label={field.label} required={field.required}>
        <CocoaInput inputMode="decimal" value={textValue(value)} onChange={(nextValue) => setValue(field.key, nextValue)} placeholder="0,00" rightSlot={<span aria-hidden="true">€</span>} aria-label={field.label} />
      </CocoaField>
    );
  }
  if (field.inputType === "date") {
    return (
      <CocoaField key={field.key} label={field.label} required={field.required}>
        <CocoaDatePicker value={typeof value === "string" ? value : ""} onChange={(nextValue) => setValue(field.key, nextValue)} aria-label={field.label} />
      </CocoaField>
    );
  }
  if (field.inputType === "textarea" || field.inputType === "json") {
    return (
      <CocoaField key={field.key} label={field.label} required={field.required} fullWidth>
        <CocoaInput multiline rows={3} value={typeof value === "string" ? value : ""} onChange={(nextValue) => setValue(field.key, nextValue)} aria-label={field.label} />
      </CocoaField>
    );
  }
  const constraints = TEXT_FIELD_CONSTRAINTS[field.key];
  const kind = textInputKind(field.label);
  return (
    <CocoaField key={field.key} label={field.label} required={field.required} help={constraints?.hint}>
      <CocoaInput
        type={kind.type}
        inputMode={kind.inputMode}
        value={textValue(value)}
        onChange={(raw) => setValue(field.key, constraints?.normalize ? constraints.normalize(raw) : raw)}
        placeholder={constraints?.placeholder ?? field.label}
        pattern={constraints?.pattern}
        aria-label={field.label}
      />
    </CocoaField>
  );
}

function humanizeKey(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

// Turn snake_case / kebab-case check codes into readable text; leave real
// sentences untouched (just ensure the first letter is capitalised).
function humanizeIssue(value: string): string {
  const trimmed = value.trim();
  const looksLikeCode = /^[a-z0-9]+([_-][a-z0-9]+)+$/.test(trimmed);
  const text = looksLikeCode ? trimmed.replace(/[_-]/g, " ") : trimmed;
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

const mutedStyle: CSSProperties = { margin: 0, fontSize: "var(--cocoa-fs-callout)", color: "var(--cocoa-label-secondary)" };

/** Validation checks / data-quality issues as a section list with a «revisar» badge per row. */
function ValidationSummary({ title, issues }: { title: string; issues: string[] }) {
  if (issues.length === 0) return null;
  return (
    <CocoaSection title={title} meta={plural(issues.length, "comprobación", "comprobaciones")}>
      <ul className="c22-section__list">
        {issues.map((issue) => (
          <li key={issue}>
            <span>{humanizeIssue(issue)}</span>
            <CocoaBadge tone="warning">revisar</CocoaBadge>
          </li>
        ))}
      </ul>
    </CocoaSection>
  );
}

function PropertySetupFormScreen({ formCode }: { formCode: string }) {
  // Hosted in its container CocoaPage drops the eyebrow and the H1 and keeps
  // the description as subtitle plus the status badge (HostedHead).
  const fallbackForm = useMemo(() => formDefinitionToView(forms.find((candidate) => candidate.code === formCode) ?? forms[0]), [formCode]);
  const [form, setForm] = useState<PropertySetupFormView>(fallbackForm);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("Aún no se ha guardado ningún envío.");

  useEffect(() => {
    let mounted = true;
    setForm(fallbackForm);
    setValues({});
    fetchPropertySetupForm(getActivePropertyId(), formCode)
      .then((payload) => {
        if (!mounted) return;
        // Spanish labels/titles/descriptions come from the local definition;
        // only live state (status, saved data, submissions, checks) comes from the API.
        const apiView = apiFormToView(payload);
        setForm({
          ...fallbackForm,
          fields: mergeFieldOptions(fallbackForm.fields, apiView.fields),
          status: apiView.status,
          permission: apiView.permission,
          existingData: apiView.existingData,
          submissions: apiView.submissions,
          dataQuality: apiView.dataQuality
        });
        // Tanda 3: pre-fill the edit forms from the persisted data so saving a
        // single field no longer overwrites the rest with "" (the wizard used
        // to send taxRegion "" and wipe the property's fiscal region).
        setValues(initialValuesFor(formCode, apiView.existingData));
      })
      .catch(() => {
        if (!mounted) return;
        setForm(fallbackForm);
      });
    return () => {
      mounted = false;
    };
  }, [fallbackForm, formCode]);

  function setFieldValue(key: string, nextValue: unknown) {
    setValues((current) => ({ ...current, [key]: nextValue }));
  }

  async function handleSave(addAnother = false) {
    const missing = form.fields
      .filter((field) => field.required)
      .filter((field) => { const v = values[field.key]; return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0); })
      .map((field) => field.label);
    if (missing.length > 0) {
      setSaveState("error");
      setSaveMessage(`Faltan campos obligatorios: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? "..." : ""}`);
      return;
    }
    setSaveState("saving");
    try {
      // Never send "" for untouched fields: the API keeps the current value
      // when a key is absent, but persists an empty string when it is present.
      const payload = Object.fromEntries(Object.entries(values).filter(([, v]) => !(typeof v === "string" && v.trim() === "")));
      const response = await savePropertySetupForm(getActivePropertyId(), form.code, payload);
      setSaveState("saved");
      void response;
      setSaveMessage(`${form.title}: guardado correctamente.`);
      if (addAnother) {
        setValues({});
      }
    } catch (error) {
      setSaveState("error");
      setSaveMessage(error instanceof Error ? error.message : "No se pudo guardar el formulario de configuración.");
    }
  }

  const saved = form.status === "saved" || form.status === "completed";
  const statusLabel = saved ? "Guardado" : form.status === "in_progress" ? "En progreso" : "Sin iniciar";
  const statusTone: CocoaTone = saved ? "success" : form.status === "in_progress" ? "warning" : "info";
  const saving = saveState === "saving";
  const saveStateLabel = saveState === "saved" ? "Guardado" : saveState === "error" ? "Error" : saving ? "Guardando" : "Pendiente";
  const saveTone: CocoaTone = saveState === "saved" ? "success" : saveState === "error" ? "danger" : saveState === "saving" ? "info" : "neutral";
  const requiredCount = form.fields.filter((field) => field.required).length;
  const submissions = form.submissions?.length ?? 0;
  const existingEntries = form.existingData && typeof form.existingData === "object" ? Object.keys(form.existingData as Record<string, unknown>).length : 0;

  return (
    <CocoaPage
      eyebrow="Configuración de la propiedad"
      title={form.title}
      subtitle={form.description}
      actions={<CocoaBadge tone={statusTone}>{statusLabel}</CocoaBadge>}
      commands={[{ id: `setup-save-${form.code}`, label: `${ACTIONS.save}: ${form.title}`, run: () => { void handleSave(false); }, shortcut: "⌘ Enter" }]}
      id={`setup-form-${form.code}`}
    >
      <CocoaGrid aria-label="Sobre este formulario y su estado">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Sobre este formulario">
            <p style={mutedStyle}>Los cambios se guardan en los registros de configuración de la propiedad a través de la API.</p>
            <p style={mutedStyle}>Este formulario cubre:</p>
            <div className="cocoa-cluster">
              {form.inputCategories.map((category) => (
                <CocoaBadge key={category} tone="neutral" uppercase={false}>
                  {humanizeKey(category)}
                </CocoaBadge>
              ))}
            </div>
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Estado actual">
            <div className="cocoa-cluster">
              <CocoaBadge tone={statusTone}>{statusLabel}</CocoaBadge>
              <CocoaBadge tone="neutral">{plural(submissions, "envío anterior", "envíos anteriores")}</CocoaBadge>
            </div>
            <p style={mutedStyle}>
              {form.checks.length > 0 ? `${plural(form.checks.length, "comprobación de validación", "comprobaciones de validación")} más abajo.` : "No hay incidencias de validación pendientes."}
            </p>
            <CocoaCallout tone={saveTone} title={saveStateLabel} role="status">
              {saveMessage}
            </CocoaCallout>
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaFormSection
        title="Datos de configuración requeridos"
        description={`${plural(form.fields.length, "campo", "campos")} · ${plural(requiredCount, "obligatorio", "obligatorios")}`}
        columns={2}
        actions={
          <div className="cocoa-row" data-gap="2" data-justify="end">
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => navigateTo("AuditLogViewer")}>
              Historial de auditoría
            </CocoaButton>
            <CocoaButton variant="bordered" tone="neutral" size="small" disabled={saving} onClick={() => { void handleSave(true); }}>
              Guardar y añadir otro
            </CocoaButton>
          </div>
        }
      >
        {form.fields.map((field) => fieldControl(field, values[field.key], setFieldValue))}
      </CocoaFormSection>

      <ValidationSummary title="Resumen de validación" issues={form.checks} />
      {form.dataQuality?.length ? <ValidationSummary title="Calidad de los datos" issues={form.dataQuality.map((issue) => `${issue.severity}: ${issue.message}`)} /> : null}

      {existingEntries > 0 ? (
        <CocoaSection title="Valores actuales" meta="Solo lectura · guardado en la base de datos">
          <DataPreview
            data={form.existingData as Record<string, unknown> | unknown[] | undefined}
            labels={Object.fromEntries(form.fields.map((field) => [field.key, field.label]))}
            emptyMessage="Aún no hay datos guardados."
          />
        </CocoaSection>
      ) : null}

      {/* Two buttons only: on a 390 px phone the fixed bar squeezes anything
          more to 44 px. The save state lives in the «Estado actual» callout and
          the secondary actions in the form section footer. */}
      <CocoaActionBar
        aria-label={`Acciones de ${form.title}`}
        secondary={{ label: ACTIONS.cancel, onClick: () => openTabPath(SETUP_CENTER_PATH) }}
        primary={{ label: saving ? "Guardando..." : ACTIONS.save, loading: saving, disabled: saving, onClick: () => { void handleSave(false); } }}
        publishToastOffset
      />
    </CocoaPage>
  );
}

export function PropertyProfileSetupForm() { return <PropertySetupFormScreen formCode="property_profile" />; }
export function BuildingSetupForm() { return <PropertySetupFormScreen formCode="building" />; }
export function FloorSetupForm() { return <PropertySetupFormScreen formCode="floor" />; }
export function ZoneSetupForm() { return <PropertySetupFormScreen formCode="zone" />; }
export function RoomTypeSetupForm() { return <PropertySetupFormScreen formCode="room_type" />; }
export function RoomSetupForm() { return <PropertySetupFormScreen formCode="room" />; }
export function SpaceResourceSetupForm() { return <PropertySetupFormScreen formCode="space_resource" />; }
export function DepartmentSetupForm() { return <PropertySetupFormScreen formCode="department" />; }
export function HousekeepingSetupForm() { return <PropertySetupFormScreen formCode="housekeeping_setup" />; }
export function MaintenanceSetupForm() { return <PropertySetupFormScreen formCode="maintenance_setup" />; }
export function RevenueCategorySetupForm() { return <PropertySetupFormScreen formCode="revenue_setup" />; }
export function FinanceComplianceSetupForm() { return <PropertySetupFormScreen formCode="finance_compliance_setup" />; }
export function AiPropertySetupForm() { return <PropertySetupFormScreen formCode="ai_setup" />; }
export function CustomFieldSetupForm() { return <PropertySetupFormScreen formCode="custom_field" />; }
