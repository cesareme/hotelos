// API Reference service — referencia pública auto-generada del manifest.
//
// Directriz HotelOS (Nov 2026):
//   "HotelOS debe diseñarse como plataforma API-first. Marketplace público
//    OAuth2 + Developer Apps."
//
// Lee `routePermissionManifest` (~600 endpoints) y produce una referencia
// navegable agrupada por categoría con:
//   - método + path
//   - permisos requeridos (deny-list deniega si no se tienen)
//   - nivel de riesgo
//   - categoría inferida (PMS, Folio, HK, Maintenance, Revenue, etc.)
//   - descripción auto-generada del path
//
// Esto evita una documentación manual que se desincroniza. El manifest es la
// fuente de verdad: si un endpoint no está en el manifest, no funciona; si
// está, aparece aquí.

import { routePermissionManifest, type ApiRoutePermission } from "../../security/route-permissions.js";

export type ApiCategory =
  | "auth"
  | "pms_reservations"
  | "pms_rooms"
  | "pms_guests"
  | "folio_billing"
  | "fb_pos"
  | "housekeeping"
  | "maintenance"
  | "compliance_es"
  | "revenue"
  | "marketplace"
  | "dashboards"
  | "ai"
  | "channel_manager"
  | "accounting"
  | "communications"
  | "configuration"
  | "webhooks"
  | "search"
  | "other";

export type ApiEndpointRef = {
  method: string;
  path: string;
  category: ApiCategory;
  permissions: string[];
  riskLevel: string;
  description: string;
};

export type ApiCategoryGroup = {
  category: ApiCategory;
  label: string;
  description: string;
  endpoints: ApiEndpointRef[];
};

export type ApiReferenceResult = {
  generatedAt: string;
  manifestVersion: number;
  totalEndpoints: number;
  publicEndpoints: number;          // sin permissions requeridos
  byMethod: { GET: number; POST: number; PATCH: number; DELETE: number };
  byRisk: { public: number; low: number; medium: number; high: number; critical: number };
  categories: ApiCategoryGroup[];
};

const CATEGORY_META: Record<ApiCategory, { label: string; description: string }> = {
  auth: { label: "Autenticación", description: "Login, sesiones, MFA, dispositivos." },
  pms_reservations: { label: "Reservas", description: "CRUD reservas, check-in/out, assign-room, transitions." },
  pms_rooms: { label: "Habitaciones", description: "Inventario de habitaciones, room types, estados HK." },
  pms_guests: { label: "Huéspedes", description: "Perfiles, identidad SES, timeline." },
  folio_billing: { label: "Folios y facturación", description: "Folio lines, pagos, invoices, splits." },
  fb_pos: { label: "F&B / TPV", description: "Outlets, menús, órdenes, escandallos." },
  housekeeping: { label: "Housekeeping", description: "Tareas, eventos, secciones, reglas." },
  maintenance: { label: "Mantenimiento", description: "Work orders, media, bloqueos." },
  compliance_es: { label: "Cumplimiento ES", description: "VeriFactu, SES Hospedajes, TBAI, IGIC, modelos AEAT." },
  revenue: { label: "Revenue Management", description: "BAR, rate plans, pickup, forecast, comp-set." },
  marketplace: { label: "Marketplace + OAuth2", description: "Listings, instalaciones, developer apps, OAuth flow." },
  dashboards: { label: "Dashboards", description: "Endpoints agregados para vistas de rol y operaciones." },
  ai: { label: "AI & Copilot", description: "Assistant, copilot, gateway, telemetry." },
  channel_manager: { label: "Channel Manager", description: "OTAs (Booking, Expedia, Airbnb, etc.), mappings." },
  accounting: { label: "Contabilidad", description: "Journals, accounts, fiscal periods, NORM43/SEPA." },
  communications: { label: "Comunicación", description: "Email connections, WhatsApp, SMS, mensajes." },
  configuration: { label: "Configuración", description: "Property, modules, settings, permisos." },
  webhooks: { label: "Webhooks", description: "Subscriptions, deliveries, event types." },
  search: { label: "Búsqueda", description: "Global search, indexers." },
  other: { label: "Otros", description: "Endpoints no clasificados." }
};

function categorize(path: string): ApiCategory {
  const p = path.toLowerCase();
  // Orden importa — más específico antes que genérico.
  if (p.startsWith("/auth") || p.includes("/sessions") || p.includes("/mfa")) return "auth";
  // Cumplimiento ES (alta prioridad, captura subpaths)
  if (p.includes("/verifactu") || p.includes("/ses/") || p.includes("/tbai") || p.includes("/igic") || p.includes("/compliance") || p.includes("/modelo") || p.includes("/aeat") || p.includes("/esrs") || p.includes("/sostenibilidad") || p.includes("/gdpr")) return "compliance_es";
  // Channel manager
  if (p.includes("/channel") || p.includes("/booking-com") || p.includes("/expedia") || p.includes("/hotelbeds") || p.includes("/airbnb") || p.includes("/vrbo") || p.includes("/ota") || p.includes("/rate-shop")) return "channel_manager";
  // PMS principales (reserva primero porque suele contener mucho)
  if (p.startsWith("/reservations") || p.includes("/reservations/")) return "pms_reservations";
  if (p.startsWith("/rooms") || p.includes("/rooms/")) return "pms_rooms";
  if (p.startsWith("/guests") || p.includes("/guests/") || p.includes("/loyalty") || p.includes("/crm")) return "pms_guests";
  // Folio/billing
  if (p.includes("/folio") || p.includes("/invoice") || p.includes("/payment") || p.includes("/refund") || p.includes("/charge") || p.includes("/tourist-tax")) return "folio_billing";
  // F&B + POS
  if (p.includes("/menu") || p.includes("/pos") || p.includes("/outlet") || p.includes("/recipe") || p.includes("/inventory") || p.includes("/stock") || p.includes("/procurement")) return "fb_pos";
  // HK
  if (p.includes("/housekeeping") || p.includes("/hk")) return "housekeeping";
  // Maintenance
  if (p.includes("/work-order") || p.includes("/maintenance") || p.includes("/safety") || p.includes("/incident")) return "maintenance";
  // Revenue
  if (p.includes("/rate-plan") || p.includes("/bar") || p.includes("/pickup") || p.includes("/forecast") || p.includes("/revenue") || p.includes("/pricing") || p.includes("/budget") || p.includes("/pace") || p.includes("/segment") || p.includes("/competitor") || p.includes("/displacement") || p.includes("/sales") || p.includes("/groups-events")) return "revenue";
  // Marketplace + developer
  if (p.includes("/marketplace") || p.includes("/oauth") || p.includes("/developer")) return "marketplace";
  // Dashboards
  if (p.includes("/dashboards") || p.includes("/reports") || p.includes("/analytics")) return "dashboards";
  // AI / Copilot
  if (p.includes("/ai/") || p.startsWith("/ai") || p.includes("/copilot") || p.includes("/assistant") || p.includes("/signals") || p.includes("/predict") || p.includes("/workflow")) return "ai";
  // Accounting + banking
  if (p.includes("/accounting") || p.includes("/journal") || p.includes("/account") || p.includes("/banking") || p.includes("/sepa") || p.includes("/csb") || p.includes("/fiscal") || p.includes("/exchange") || p.includes("/year-end") || p.includes("/cost")) return "accounting";
  // Comunicación
  if (p.includes("/email") || p.includes("/whatsapp") || p.includes("/sms") || p.includes("/message") || p.includes("/conversation") || p.includes("/notification") || p.includes("/magic-link")) return "communications";
  // Configuración
  if (p.includes("/configuration") || p.includes("/settings") || p.includes("/setup") || p.includes("/department") || p.includes("/property") || p.includes("/staff") || p.includes("/role") || p.includes("/integration") || p.includes("/module") || p.includes("/asset") || p.includes("/space") || p.includes("/template") || p.includes("/onboarding")) return "configuration";
  if (p.includes("/webhook") || p.includes("/event-type")) return "webhooks";
  if (p.includes("/search") || p.includes("/index")) return "search";
  return "other";
}

function describe(method: string, path: string): string {
  // Reglas heurísticas para describir un endpoint en lenguaje natural.
  const parts = path.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? path;
  const verb = method.toUpperCase();

  // Acciones específicas
  if (last === "check-in") return "Hacer check-in de la reserva.";
  if (last === "check-out") return "Hacer check-out de la reserva (cierra folio + crea HK departure task).";
  if (last === "assign-room") return "Asignar o reasignar habitación a la reserva.";
  if (last === "cancel") return "Cancelar la reserva (aplica política de cancelación).";
  if (last === "no-show") return "Marcar la reserva como no-show.";
  if (last === "resolve") return "Marcar como resuelto y cerrar.";
  if (last === "transition") return "Cambiar estado siguiendo el flujo permitido.";
  if (last === "preflight") return "Pre-chequeo de bloqueos antes del cierre del día.";
  if (last === "run") return "Ejecutar el proceso.";
  if (last === "preview") return "Vista previa sin persistir.";
  if (last === "rotate-secret") return "Rotar el secreto OAuth2 del developer app.";
  if (last === "install") return "Instalar app del marketplace en una propiedad.";
  if (last === "uninstall") return "Desinstalar app del marketplace.";

  // Generic CRUD por método + último segmento
  if (verb === "GET" && !path.match(/:[^/]+$/)) return `Listar ${last.replace(/-/g, " ")}.`;
  if (verb === "GET") return `Obtener detalle de ${last.replace(/-/g, " ")}.`;
  if (verb === "POST") return `Crear o registrar ${last.replace(/-/g, " ")}.`;
  if (verb === "PATCH") return `Actualizar parcialmente ${last.replace(/-/g, " ")}.`;
  if (verb === "DELETE") return `Eliminar ${last.replace(/-/g, " ")}.`;
  return `${verb} ${path}`;
}

export function buildApiReference(): ApiReferenceResult {
  const endpoints: ApiEndpointRef[] = (routePermissionManifest as ApiRoutePermission[]).map((r) => ({
    method: r.method,
    path: r.path,
    category: categorize(r.path),
    permissions: [...r.permissions],
    riskLevel: r.riskLevel,
    description: describe(r.method, r.path)
  }));

  // Agrupa por categoría preservando orden CATEGORY_META.
  const groups: ApiCategoryGroup[] = (Object.keys(CATEGORY_META) as ApiCategory[]).map((category) => {
    const list = endpoints.filter((e) => e.category === category);
    list.sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.method.localeCompare(b.method);
    });
    return {
      category,
      label: CATEGORY_META[category].label,
      description: CATEGORY_META[category].description,
      endpoints: list
    };
  }).filter((g) => g.endpoints.length > 0);

  const byMethod = { GET: 0, POST: 0, PATCH: 0, DELETE: 0 };
  const byRisk = { public: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const e of endpoints) {
    if (e.method in byMethod) (byMethod as Record<string, number>)[e.method]++;
    if (e.riskLevel in byRisk) (byRisk as Record<string, number>)[e.riskLevel]++;
  }
  const publicEndpoints = endpoints.filter((e) => e.permissions.length === 0).length;

  return {
    generatedAt: new Date().toISOString(),
    manifestVersion: 1,
    totalEndpoints: endpoints.length,
    publicEndpoints,
    byMethod,
    byRisk,
    categories: groups
  };
}
