// Spanish labels for record keys the back-office paints from raw API objects
// (Tanda 5 · L1c). `DataPreview` (components/cocoa-extras/CocoaDataPreview) used to humanise the key
// («HAS BAR», «TAX REGION RAW», «SORT ORDER») and print booleans as «Yes/No»
// (browser-roles#9); every read-only dump now goes through this dictionary,
// with the form's own field labels taking precedence when the screen has them.

import { FIELD_LABELS, STATUS_LABELS } from "./actions";

export const DATA_KEY_LABELS: Record<string, string> = {
  ...FIELD_LABELS,
  id: "Identificador",
  code: "Código",
  number: "Número",
  label: "Etiqueta",
  category: "Categoría",
  active: "Activo",
  enabled: "Activado",
  sortOrder: "Orden",
  displayOrder: "Orden de visualización",
  displayName: "Nombre visible",
  legalName: "Razón social",
  taxId: "NIF / CIF",
  address: "Dirección",
  city: "Localidad",
  municipality: "Municipio",
  province: "Provincia",
  postalCode: "Código postal",
  country: "País",
  region: "Región",
  timezone: "Zona horaria",
  website: "Sitio web",
  organization: "Organización",
  organizationId: "Organización",
  propertyId: "Propiedad",
  compliance: "Cumplimiento",
  configurationJson: "Configuración",
  pilotProfile: "Ficha del piloto",
  built: "Año de construcción",
  renovated: "Última reforma",
  hasBar: "Tiene bar",
  plazas: "Plazas",
  starRating: "Estrellas",
  coordinates: "Coordenadas",
  lat: "Latitud",
  lon: "Longitud",
  lng: "Longitud",
  tourismRegistry: "Registro turístico",
  registry: "Registro",
  source: "Fuente",
  verifiedAt: "Verificado",
  brandAffiliation: "Marca o cadena",
  provisioned: "Aprovisionado",
  taxRegion: "Región fiscal",
  taxRegionRaw: "Región fiscal (código)",
  fiscalTerritory: "Territorio fiscal",
  tourismTaxRegion: "Región de tasa turística",
  ineMunicipalityCode: "Código INE del municipio",
  sesHospedajesEnabled: "SES.Hospedajes activo",
  verifactuEnabled: "VeriFactu activo",
  ticketbaiEnabled: "TicketBAI activo",
  siiEnabled: "SII activo",
  b2bEinvoiceEnabled: "Factura electrónica B2B activa",
  checkInTime: "Hora de entrada",
  checkOutTime: "Hora de salida",
  totalRooms: "Total de habitaciones",
  businessDateRules: "Reglas de fecha de negocio",
  roomTypeId: "Tipo de habitación",
  buildingId: "Edificio",
  floorId: "Planta",
  zoneId: "Zona",
  floor: "Planta",
  floorNumber: "Número de planta",
  roomCode: "Código de habitación",
  roomNumber: "Número de habitación",
  maxOccupancy: "Ocupación máxima",
  standardOccupancy: "Ocupación estándar",
  baseOccupancy: "Ocupación base",
  maxAdults: "Adultos máximo",
  maxChildren: "Niños máximo",
  extraBedCapacity: "Camas supletorias",
  bedConfigurationJson: "Configuración de camas",
  bedConfig: "Configuración de camas",
  defaultBedSetup: "Camas por defecto",
  featuresJson: "Características",
  features: "Características",
  defaultFeatures: "Características por defecto",
  accessibilityJson: "Accesibilidad",
  housekeepingStatus: "Estado de limpieza",
  maintenanceStatus: "Estado de mantenimiento",
  defaultCleaningCategory: "Categoría de limpieza",
  smokingPolicy: "Política de fumadores",
  sellable: "Vendible",
  baseRate: "Tarifa base",
  viewType: "Tipo de vista",
  squareMeters: "Metros cuadrados",
  resourceType: "Tipo de recurso",
  zoneType: "Tipo de zona",
  capacity: "Aforo",
  targetTable: "Tabla de destino"
};

/** Split camelCase / snake_case and capitalise (last resort for keys outside the dictionary). */
function humanizeKey(key: string): string {
  return key
    .replace(/Json$/, "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

/** Label of a record key: the screen's own field label, then the dictionary, then a humanised key. */
export function dataKeyLabel(key: string, overrides?: Record<string, string>): string {
  const own = overrides?.[key];
  if (own) return own;
  return DATA_KEY_LABELS[key] ?? humanizeKey(key);
}

/** «Sí» / «No». */
export function booleanLabel(value: boolean): string {
  return value ? STATUS_LABELS.yes : STATUS_LABELS.no;
}

// Folio labels (qa#6). The API opens every primary folio with the technical
// label "guest" (GET /reservations/:id/folios returns it verbatim) and
// documents «company» / «travel_agent» as the canonical secondary labels; the
// operator may type anything else («Empresa», «Agencia»). Screens paint the
// Spanish word for the system values and pass free text through. The API
// keeps the same dictionary in modules/folio/folio-labels.ts for the
// references it composes itself (Tesorería › cuentas a cobrar).
export const FOLIO_LABELS: Readonly<Record<string, string>> = {
  guest: "Huésped",
  company: "Empresa",
  travel_agent: "Agencia de viajes"
};

/** Spanish text of a folio label: system values translated, free text untouched, empty → `fallback`. */
export function folioLabelText(label: string | null | undefined, fallback = "—"): string {
  const raw = label?.trim() ?? "";
  if (!raw) return fallback;
  return FOLIO_LABELS[raw] ?? raw;
}

/** Folio name with its role for pickers and cross-references: «Huésped (principal)», «Empresa». */
export function folioDisplayName(folio: { label: string | null | undefined; isPrimary?: boolean }, fallback = "—"): string {
  return `${folioLabelText(folio.label, fallback)}${folio.isPrimary ? " (principal)" : ""}`;
}
