import { getActivePropertyId } from "../../services/activeProperty";
import { useEffect, useMemo, useState } from "react";
import {
  DataPreview,
  FormDateInput,
  FormField,
  FormMoneyInput,
  FormMultiSelect,
  FormNumberInput,
  FormPage,
  FormPreviewPanel,
  FormSection,
  FormSelect,
  FormSwitch,
  FormTextarea,
  FormValidationSummary
} from "../../components/forms/FormComponents";
import {
  backOfficeEndpoints,
  fetchPropertySetupForm,
  fetchPropertySetupForms,
  savePropertySetupForm,
  type PropertySetupForm,
  type PropertySetupFormField
} from "../../services/backofficeApi";

type FormDefinition = {
  code: string;
  title: string;
  route: string;
  endpoint: string;
  description: string;
  targetTable: string;
  inputCategories: string[];
  fields: PropertySetupFormField[];
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
  fields: PropertySetupFormField[];
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
    route: "/backoffice/property-setup/property-profile",
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
      { key: "phone", label: "Teléfono de contacto", inputType: "text" },
      { key: "email", label: "Correo de contacto", inputType: "text" },
      { key: "website", label: "Sitio web", inputType: "text" },
      { key: "starRating", label: "Categoría / estrellas", inputType: "select", options: ["1*", "2*", "3*", "4*", "5*", "5* GL"] },
      { key: "totalRooms", label: "Total de habitaciones", inputType: "number" },
      { key: "checkInTime", label: "Hora de entrada por defecto", inputType: "text" },
      { key: "checkOutTime", label: "Hora de salida por defecto", inputType: "text" },
      { key: "timezone", label: "Zona horaria", inputType: "select", options: ["Europe/Madrid", "Europe/Lisbon", "Europe/Paris"], required: true },
      { key: "currency", label: "Moneda", inputType: "select", options: ["EUR", "GBP", "USD"], required: true },
      { key: "taxRegion", label: "Región fiscal", inputType: "select", options: ["Mainland Spain", "Canary Islands", "Ceuta", "Melilla"] },
      { key: "tourismTaxRegion", label: "Región de tasa turística", inputType: "select", options: ["None", "Catalonia", "Balearic Islands"] },
      { key: "businessDateRules", label: "Reglas de fecha de negocio", inputType: "textarea" }
    ],
    checks: ["La razón social, el NIF/CIF y la dirección deben estar completos.", "La zona horaria y las reglas de fecha de negocio determinan la hora del cierre nocturno (night audit)."]
  },
  {
    code: "building",
    title: "Edificios",
    route: "/backoffice/property-setup/buildings",
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
    route: "/backoffice/property-setup/floors",
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
    route: "/backoffice/property-setup/zones",
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
    route: "/backoffice/property-setup/room-types",
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
    route: "/backoffice/property-setup/rooms",
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
    route: "/backoffice/property-setup/spaces-resources",
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
    route: "/backoffice/property-setup/departments",
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
    route: "/backoffice/property-setup/operations",
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
    route: "/backoffice/property-setup/maintenance",
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
    route: "/backoffice/property-setup/revenue",
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
    route: "/backoffice/property-setup/finance-compliance",
    endpoint: backOfficeEndpoints.propertySetupForm,
    description: "Configura la región fiscal, la autoridad de destino, las series de facturación, las categorías de método de pago y las reglas de retención.",
    targetTable: "property_compliance_settings + invoice_sequences",
    inputCategories: ["Códigos de impuesto", "Categorías de método de pago", "Series de facturación", "Ajustes de cumplimiento", "Reglas de retención"],
    fields: [
      { key: "taxRegion", label: "Región fiscal", inputType: "text", required: true },
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
    route: "/backoffice/property-setup/ai",
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
    route: "/backoffice/property-setup/custom-fields",
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
    fields: form.fields,
    checks: form.dataQualityChecks,
    status: form.status,
    permission: form.permission,
    existingData: form.existingData,
    submissions: form.submissions,
    dataQuality: form.dataQuality
  };
}

function fieldControl(
  field: PropertySetupFormField,
  value: unknown,
  setValue: (key: string, value: unknown) => void
) {
  if (field.inputType === "select") {
    return (
      <FormSelect
        key={field.key}
        label={field.label}
        options={field.options ?? ["Demo option"]}
        required={field.required}
        value={typeof value === "string" ? value : ""}
        onChange={(nextValue) => setValue(field.key, nextValue)}
      />
    );
  }
  if (field.inputType === "multi_select") {
    return (
      <FormMultiSelect
        key={field.key}
        label={field.label}
        options={field.options ?? ["Demo option"]}
        value={Array.isArray(value) ? value.map(String) : typeof value === "string" && value ? value.split(",").map((item) => item.trim()).filter(Boolean) : []}
        onChange={(nextValue) => setValue(field.key, nextValue)}
      />
    );
  }
  if (field.inputType === "boolean") {
    return <FormSwitch key={field.key} label={field.label} value={Boolean(value)} onChange={(nextValue) => setValue(field.key, nextValue)} />;
  }
  if (field.inputType === "number") {
    return <FormNumberInput key={field.key} label={field.label} value={typeof value === "string" || typeof value === "number" ? value : ""} onChange={(nextValue) => setValue(field.key, nextValue)} />;
  }
  if (field.inputType === "money") {
    return <FormMoneyInput key={field.key} label={field.label} value={typeof value === "string" || typeof value === "number" ? value : ""} onChange={(nextValue) => setValue(field.key, nextValue)} />;
  }
  if (field.inputType === "date") {
    return <FormDateInput key={field.key} label={field.label} value={typeof value === "string" ? value : ""} onChange={(nextValue) => setValue(field.key, nextValue)} />;
  }
  if (field.inputType === "textarea" || field.inputType === "json") {
    return <FormTextarea key={field.key} label={field.label} value={typeof value === "string" ? value : ""} onChange={(nextValue) => setValue(field.key, nextValue)} />;
  }
  return (
    <FormField key={field.key} label={field.label} required={field.required}>
      <input
        aria-label={field.label}
        value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
        onChange={(event) => setValue(field.key, event.currentTarget.value)}
        placeholder={field.label}
      />
    </FormField>
  );
}

function humanizeKey(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function PropertySetupFormScreen({ formCode }: { formCode: string }) {
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
          status: apiView.status,
          permission: apiView.permission,
          existingData: apiView.existingData,
          submissions: apiView.submissions,
          dataQuality: apiView.dataQuality
        });
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
      const response = await savePropertySetupForm(getActivePropertyId(), form.code, values);
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

  const statusLabel = form.status === "saved" || form.status === "completed" ? "Guardado" : form.status === "in_progress" ? "En progreso" : "Sin iniciar";
  const statusClass = form.status === "saved" || form.status === "completed" ? "ok" : form.status === "in_progress" ? "warn" : "info";
  const saveStateLabel = saveState === "saved" ? "Guardado" : saveState === "error" ? "Error" : saveState === "saving" ? "Guardando" : "Pendiente";

  return (
    <FormPage eyebrow="Back Office / Configuración de la propiedad" title={form.title} summary={form.description}>
      <section className="bo-grid two">
        <FormPreviewPanel>
          <h3>Sobre este formulario</h3>
          <p style={{ color: "var(--ink-soft)", marginBottom: 12 }}>
            Los cambios se guardan en los registros de configuración de la propiedad a través de la API.
          </p>
          <p style={{ marginBottom: 8, fontSize: 13, color: "var(--ink-muted)" }}>Este formulario cubre:</p>
          <div className="bo-pill-row">
            {form.inputCategories.map((category) => <span className="bo-chip" key={category}>{humanizeKey(category)}</span>)}
          </div>
        </FormPreviewPanel>
        <FormPreviewPanel>
          <h3>Estado actual</h3>
          <div className="bo-pill-row" style={{ marginBottom: 12 }}>
            <span className={`bo-status ${statusClass}`}>{statusLabel}</span>
            <span className="bo-chip">{form.submissions?.length ?? 0} envíos anteriores</span>
          </div>
          {form.checks.length > 0 ? (
            <p style={{ fontSize: 13, color: "var(--ink-muted)" }}>{form.checks.length} comprobación{form.checks.length === 1 ? "" : "es"} de validación más abajo.</p>
          ) : (
            <p style={{ fontSize: 13, color: "var(--ink-muted)" }}>No hay incidencias de validación pendientes.</p>
          )}
          {saveMessage ? (
            <p style={{ marginTop: 10, fontSize: 13 }}>
              <span className={`bo-status ${saveState === "saved" ? "ok" : saveState === "error" ? "error" : "warn"}`}>{saveStateLabel}</span>{" "}
              <span style={{ color: "var(--ink-soft)" }}>{saveMessage}</span>
            </p>
          ) : null}
        </FormPreviewPanel>
      </section>
      <FormSection title="Datos de configuración requeridos">
        {form.fields.map((field) => fieldControl(field, values[field.key], setFieldValue))}
      </FormSection>
      <FormValidationSummary issues={form.checks} />
      {form.dataQuality?.length ? (
        <FormValidationSummary issues={form.dataQuality.map((issue) => `${issue.severity}: ${issue.message}`)} />
      ) : null}
      {form.existingData && Object.keys(form.existingData).length > 0 ? (
        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Valores actuales</h3>
            <span className="bo-chip">Solo lectura · guardado en la base de datos</span>
          </div>
          <DataPreview data={form.existingData as Record<string, unknown> | undefined} emptyMessage="Aún no hay datos guardados." />
        </section>
      ) : null}
      <div className="bo-actions">
        <button className="primary" disabled={saveState === "saving"} onClick={() => handleSave(false)} type="button">
          {saveState === "saving" ? "Guardando..." : "Guardar"}
        </button>
        <button disabled={saveState === "saving"} onClick={() => handleSave(true)} type="button">Guardar y añadir otro</button>
        <a className="bo-button-link" href="/backoffice/property-setup">Cancelar</a>
        <button type="button" disabled style={{ opacity: 0.55, cursor: "not-allowed" }} title="Pendiente de implementación">Desactivar</button>
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "AuditLogViewer" }))}>Historial de auditoría</button>
      </div>
    </FormPage>
  );
}

function statusLabelEs(status?: string): string {
  if (status === "saved" || status === "completed") return "Guardado";
  if (status === "in_progress") return "En progreso";
  return "Sin iniciar";
}

export function PropertySetupHomeScreen() {
  const [formList, setFormList] = useState<PropertySetupFormView[]>(() => forms.map(formDefinitionToView));

  useEffect(() => {
    let mounted = true;
    fetchPropertySetupForms(getActivePropertyId())
      .then((payload) => {
        if (!mounted) return;
        // Keep Spanish titles/descriptions/categories from the local definitions;
        // overlay only the live completion status reported by the API.
        const statusByCode = new Map(payload.forms.map((apiForm) => [apiForm.code, apiForm.status]));
        setFormList(
          forms.map((definition) => {
            const view = formDefinitionToView(definition);
            const status = statusByCode.get(definition.code);
            return status ? { ...view, status } : view;
          })
        );
      })
      .catch(() => {
        if (!mounted) return;
        setFormList(forms.map(formDefinitionToView));
      });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <FormPage
      eyebrow="Back Office"
      title="Formularios de configuración de la propiedad"
      summary="Abre cada formulario, introduce las categorías de datos requeridas y guárdalas mediante la API de configuración en los registros de la base de datos."
    >
      <div className="bo-actions">
        <span className="bo-chip">{formList.length} formularios</span>
      </div>
      <div className="bo-grid two">
        {formList.map((form) => (
          <article className="bo-card" key={form.code}>
            <div className="bo-card-head">
              <h3>{form.title}</h3>
              <span className={`bo-status ${form.status === "saved" || form.status === "completed" ? "ok" : "warn"}`}>{statusLabelEs(form.status)}</span>
            </div>
            <p>{form.description}</p>
            {form.inputCategories.length ? (
              <div className="bo-actions">
                {form.inputCategories.map((category) => <span className="bo-chip" key={category}>{category}</span>)}
              </div>
            ) : null}
            <div className="bo-actions">
              <a className="bo-button-link" href={form.route}>Abrir formulario</a>
            </div>
          </article>
        ))}
      </div>
    </FormPage>
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
