// Content for the in-app guidance system ("guía intrínseca").
//
// Tanda 5 (chrome): the tours are generated from the navigation tree
// (`navigation/nav-tree.ts`, built from pilots/tanda5-nav-tree.csv) so their
// screen keys, labels, order and roles can never drift from the menu: one
// welcome tour anchored to the shell chrome plus one tour per category (the
// nine domain categories). Every step narrates a `keep` item in plain Spanish;
// a step is skipped for roles that cannot see its item. Only real keyboard
// shortcuts are mentioned (content/help-articles/keyboard-shortcuts.ts).
import { NAV_TREE, type NavCategory, type NavItem } from "../../navigation/nav-tree";
import { canSee, type RoleToken } from "../../navigation/role-tokens";

export type TourStep = {
  /** CSS selector of a real element to spotlight (dims the rest). */
  selector?: string;
  /** Screen key to open (via hotelos-nav) before showing this step. */
  navigateTo?: string;
  /** Render as a centered card with a dimmed backdrop (for intros/summaries). */
  center?: boolean;
  /** Role tokens that can see the step; empty = everyone. */
  roles?: readonly string[];
  /** Module codes (any) the step needs; empty = core. */
  modulesAny?: readonly string[];
  title: string;
  body: string;
};

export type Tour = {
  id: string;
  title: string;
  summary: string;
  /** Short category label shown as a chip. */
  badge?: string;
  /** Role tokens the tour is meant for (union of its items); empty = everyone. */
  roles: readonly string[];
  steps: TourStep[];
};

export const WELCOME_TOUR_ID = "primeros-pasos";

/**
 * The 60-second welcome, anchored to chrome present on every screen of the
 * Cocoa shell (BackOfficeLayout: data-tour="property|search|sidebar|
 * notifications|help"). GuidedTour degrades a missing anchor to a pinned
 * callout, so a hidden control never breaks the tour.
 */
const WELCOME_TOUR: Tour = {
  id: WELCOME_TOUR_ID,
  title: "Primeros pasos",
  summary: "Un minuto para conocer lo esencial de la aplicación.",
  badge: "Bienvenida",
  roles: [],
  steps: [
    {
      center: true,
      title: "Te damos la bienvenida",
      body: "Este recorrido de un minuto te muestra lo esencial para empezar. Puedes salir cuando quieras y repetirlo desde el botón «?» de la barra superior."
    },
    {
      selector: "[data-tour='property']",
      title: "Tu hotel activo",
      body: "Aquí ves en qué hotel estás trabajando y puedes cambiar a otro. Comprueba siempre que es el correcto antes de hacer un check-in o una reserva."
    },
    {
      selector: "[data-tour='search']",
      title: "Encuentra cualquier cosa",
      body: "Escribe aquí (o pulsa ⌘K, Ctrl+K en Windows) para buscar una reserva, un huésped, una factura o una pantalla por su nombre."
    },
    {
      selector: "[data-tour='sidebar']",
      title: "Tu menú, por áreas",
      body: "Toda la aplicación vive en el menú lateral, agrupada por áreas: Hoy, Recepción, Operaciones, Comercial, Revenue, Finanzas, Cumplimiento, Informes y Configuración. Solo ves lo que corresponde a tu puesto."
    },
    {
      selector: "[data-tour='notifications']",
      title: "Avisos",
      body: "La campana reúne los avisos que necesitan tu atención: envíos rechazados, averías, mensajes de huéspedes y cobros."
    },
    {
      selector: "[data-tour='help']",
      title: "Tu guía, siempre a mano",
      body: "Pulsa «?» para repetir este recorrido, abrir el recorrido de tu área, leer la guía de tu puesto o buscar en los artículos de ayuda."
    }
  ]
};

/** Plain-Spanish narration of every menu item, keyed by screen key (CSV keep rows). */
const ITEM_NARRATION: Record<string, string> = {
  // Hoy
  FrontDeskDashboard:
    "Tu punto de partida. Llegadas y salidas de hoy, huéspedes alojados y la cola de acciones del turno. Según tu puesto aterrizas en la pestaña Recepción, Operaciones, Dirección o Propietario.",
  AssistantChat:
    "Pregunta en lenguaje natural sobre tu hotel (ocupación, una reserva, un huésped) y obtén una respuesta con la fuente del dato. Nunca ejecuta cambios sin tu confirmación.",
  ShiftManagerScreen: "El turno de recepción de un vistazo: productividad del equipo, caja del día y bloqueos que impiden avanzar.",
  NightAuditScreen:
    "El cierre del día guiado: comprueba llegadas sin registrar, folios abiertos y salidas pendientes, y cambia la fecha de negocio cuando todo está en verde.",
  ApprovalsInbox:
    "La bandeja de aprobaciones: reembolsos, ajustes, descuentos, tarifas, facturas de proveedor, pedidos, nóminas y anulaciones que puedes decidir con tus claves, y el estado de las solicitudes que has pedido tú. Quien solicita nunca aprueba; por encima de T4 hacen falta dos firmas.",
  AiOwnerSummaryScreen: "Qué ha hecho la inteligencia artificial hoy, qué ha propuesto, cuánto ha costado y con qué controles trabaja. Sin tecnicismos.",
  AiHumanReviewQueueScreen: "Las propuestas de la IA que una persona debe aprobar o rechazar antes de aplicarse (correo → reserva, confirmaciones, acciones de riesgo).",
  // Recepción
  ReservationWorkspace:
    "Todas las reservas del hotel. Pestañas Lista, Cronograma (planificación por días) y Tablero de habitaciones (estado y asignación). Cada reserva abre su detalle y su recorrido.",
  ReservationCreate: "Alta manual de una reserva: fechas, tipo de habitación, tarifa, titular y garantía. En la pestaña «Dictar (IA)» puedes dictarla y revisar el borrador.",
  GuestsList: "El directorio de huéspedes: datos de contacto, documento de identidad, preferencias y la cronología de sus estancias.",
  ConciergeInboxDashboard: "Las conversaciones con los huéspedes por todos los canales en una sola bandeja. La IA propone un borrador y tú decides si lo envías.",
  GroupsEventsDashboard: "Grupos, eventos y bloqueos de habitaciones: calendario, cupos por operador y lista de huéspedes del grupo.",
  // Operaciones
  HousekeepingDashboard: "Estado de cada habitación (limpia, sucia, en inspección) y asignación de tareas al equipo. La pestaña Mi turno es la vista móvil de cada camarera.",
  MaintenanceDashboard: "Partes de avería: abrir, asignar, bloquear la habitación si hace falta y cerrar con evidencia. La pestaña Mis averías es la vista móvil del técnico.",
  PosDashboard: "Restaurante, bar y otros puntos de venta: tickets, cargos a la habitación, cartas y existencias.",
  WorkforceDashboard: "La plantilla del día: turnos, presencias y cargas de trabajo por departamento.",
  SafetyDashboard: "Registro de incidentes de seguridad y su seguimiento hasta la resolución.",
  ProcurementDashboard: "Pedidos a proveedores, recepciones e inventario de almacén.",
  AssetsDashboard: "Inventario de activos y equipamiento del hotel: valor, garantías próximas a vencer y proyectos de inversión.",
  EnergyDashboard: "Consumo de energía y agua por zonas y su evolución, para detectar anomalías.",
  // Comercial
  CrmDashboard: "Tus clientes: segmentos, programa de fidelización y campañas para volver a traerlos.",
  ReputationDashboard: "Reseñas de los portales, encuestas de satisfacción y casos de calidad; responde a cada reseña desde aquí.",
  UpsellsDashboard: "Mejoras de habitación y extras que aumentan el ingreso por estancia, y el portal del huésped donde los compra.",
  SalesPipelineDashboard: "Cuentas de empresa y agencias, oportunidades y negociaciones comerciales.",
  ChannelAggregatorHub: "La conexión con las agencias en línea (Booking, Expedia…): estado, sincronización de tarifas y disponibilidad, y correspondencias de habitaciones y planes.",
  // Revenue
  RevenueHomeDashboard: "Ocupación, ADR y RevPAR de un vistazo, con el pickup de las últimas 24 horas y las señales del día.",
  RateGridEditorScreen: "La parrilla de tarifas por día y tipo de habitación: edita, revisa el impacto y publica en los canales. El historial guarda cada cambio y permite revertirlo.",
  RatePlans: "Los planes de tarifa: la tarifa pública y sus variantes derivadas (no reembolsable, con desayuno…) con sus restricciones.",
  RevenueRules: "Reglas de precio y recomendaciones del motor de revenue: revísalas y decide cuáles aplicar.",
  RevenueHistoryForecastDashboard: "Histórico y previsión de ocupación e ingresos frente al año anterior; informe exportable y explorador por segmentos.",
  RevenueComparisonDashboard: "Compara un periodo con el anterior, con el mismo periodo del año pasado o con un rango a tu elección.",
  RevenueMeeting: "Todo lo que necesita la reunión semanal: pace, pickup, precisión de la previsión, competencia, presupuesto y una calculadora de desplazamiento de grupos.",
  RateShopperSettings: "Las tarifas de tus competidores y las alertas de paridad con tus canales.",
  DemandCalendarAdmin: "Eventos, festivos y periodos de alta demanda que alimentan la previsión y explican los precios.",
  CancellationPolicies: "Ventana de cancelación gratuita y penalizaciones; se aplican al cancelar o en el cierre del día.",
  // Finanzas
  BillingCenter: "Folios, cargos, cobros y facturas. Desde aquí emites facturas y rectificativas y defines a qué folio va cada cargo.",
  FinancePositionDashboard: "Tesorería: lo que te deben, lo que debes y la posición de caja, con los tipos de cambio.",
  BankReconciliationScreen: "Cuadra los movimientos del banco con los apuntes contables; extractos y remesas SEPA.",
  JournalScreen: "Contabilidad del PGC de Pymes: diario de asientos, mayor de cada cuenta, plan de cuentas, ajustes, cierre del ejercicio y exportación a la gestoría.",
  TrialBalanceScreen: "Sumas y saldos, balance de situación, pérdidas y ganancias, flujos de efectivo, cuentas anuales y la presentación USALI para comparar con otros hoteles.",
  SupplierBillsScreen: "Facturas de proveedores por líneas, gastos menores, directorio de proveedores e inmovilizado con su amortización mensual.",
  CommissionsScreen: "Comisiones que cobra cada canal de venta y su devengo automático al facturar.",
  PayrollScreen: "Contratos y periodos de nómina para exportar a la gestoría.",
  // Cumplimiento
  ComplianceInbox: "Tu lista de tareas legales: envíos rechazados, plazos a punto de vencer y certificados que caducan, en un solo sitio.",
  ComplianceCenter: "El estado de todas las obligaciones legales del alojamiento (VeriFactu, partes de viajeros, protección de datos) con un asistente que explica cada una.",
  FiscalDashboard: "VeriFactu: certificado, series y envío de facturas a la AEAT. La pestaña TicketBAI cubre los territorios forales.",
  FiscalSubmissionsCenter: "El historial de cada envío a las autoridades (AEAT, haciendas forales, Canarias, Ministerio del Interior) y sus reintentos.",
  Modelo303Screen: "Los modelos de la AEAT preparados desde tus datos: 303 (IVA), 111, 115, 180 y 390.",
  PropertyTaxesScreen: "Los impuestos de la propiedad (IVA o IGIC por categoría) y la tasa turística.",
  GuestRegisterSettings: "El registro de viajeros: configuración, comunicación a SES.Hospedajes, autoridades y plazos de conservación.",
  GdprRequestsScreen: "Solicitudes de acceso, rectificación o borrado de datos de los huéspedes (RGPD) y su plazo de respuesta.",
  SustainabilityDashboard: "Indicadores de sostenibilidad del alojamiento y el informe ESRS.",
  // Informes
  ReportingCenter: "Genera y exporta informes de reservas, facturación y operaciones; incluye las exportaciones de revenue.",
  AnalyticsCenterDashboard: "Los indicadores clave del hotel reunidos en un panel, con anomalías detectadas automáticamente.",
  RoomProfitabilityDashboard: "Qué tipos de habitación y qué canales dejan más margen.",
  PortfolioDashboard: "Si tienes varios hoteles, aquí los comparas y entras en el detalle de cada uno.",
  ChannelPerformanceDashboard: "Reparto de ventas por canal, rentabilidad de cada uno y alertas de paridad.",
  // Configuración
  SetupCenterScreen: "Todo lo necesario para dejar el hotel listo: comprobaciones de salida en vivo e importación desde documentos con ayuda de la IA.",
  PropertyProfileSetupForm: "Los datos del hotel: perfil legal, edificios, plantas, zonas, departamentos, categorías y campos personalizados.",
  StructureScreen: "Quién factura y dónde se trabaja: la sociedad (NIF, razón social, régimen) y sus centros de trabajo, series e instalaciones VeriFactu.",
  RoomSetupForm: "Tipos de habitación, inventario de habitaciones y espacios (salas, recursos para eventos).",
  UserRoleManager: "Quién puede entrar y con qué rol; invitaciones y desactivación de accesos.",
  NotificationsScreen: "Plantillas y envíos de correo y mensajes, y los buzones de correo entrante que la IA lee para preparar reservas.",
  BillingSettings: "Series de facturación, datos del emisor y proveedores de pago.",
  AccountingSettings: "Plan contable, ajustes fiscales (VeriFactu), perfil inicial y categorías de ingresos.",
  ModuleManager: "Activa o desactiva las funciones que usa tu hotel y consulta qué entradas del menú desbloquea cada módulo; integraciones y salud de los módulos.",
  PropertyAiScreen: "Cómo trabaja la IA en esta propiedad: idioma, tono, nivel de automatización, herramientas permitidas, actividad y gobernanza.",
  AuditLogViewer: "Registro de auditoría, webhooks, aplicaciones conectadas, referencia de la API y organizaciones (administración de la plataforma)."
};

const CATEGORY_INTRO: Record<string, { summary: string; body: string; badge: string }> = {
  hoy: { badge: "Hoy", summary: "Mi día, el asistente, el turno y el cierre.", body: "Lo que necesitas cada día nada más entrar: tu panel, el asistente, el turno, el cierre del día y lo que la IA espera de ti." },
  recepcion: { badge: "Recepción", summary: "Reservas, huéspedes, mensajes y grupos.", body: "Todo el ciclo de una reserva: crearla, encontrarla, atender al huésped y cerrar la estancia." },
  operaciones: { badge: "Operaciones", summary: "Pisos, mantenimiento, punto de venta y más.", body: "Los tableros con los que trabajan los equipos de pisos, mantenimiento, restauración y servicios." },
  comercial: { badge: "Comercial", summary: "Clientes, reputación, ventas y canales.", body: "Las herramientas para vender más y mejor: clientes, reputación, extras, empresas y canales de venta." },
  revenue: { badge: "Revenue", summary: "Tarifas, previsión, competencia y reglas.", body: "Las herramientas para maximizar ingresos: panel, parrilla de tarifas, reglas, previsión y competencia." },
  finanzas: { badge: "Finanzas", summary: "Facturación, tesorería, contabilidad y nóminas.", body: "El control económico del hotel: cobros, facturas, banco, estados contables, comisiones y nóminas." },
  cumplimiento: { badge: "Cumplimiento", summary: "VeriFactu, viajeros, AEAT y protección de datos.", body: "Las obligaciones legales de un alojamiento en España: facturación verificable, registro de viajeros, modelos de la AEAT y protección de datos." },
  informes: { badge: "Informes", summary: "Informes, analítica, rentabilidad y cartera.", body: "Para entender el negocio: informes, indicadores, rentabilidad por habitación y por canal, y la cartera de hoteles." },
  configuracion: { badge: "Configuración", summary: "Puesta en marcha, propiedad, usuarios, módulos e IA.", body: "Donde se define cómo funciona tu hotel en la aplicación: estructura, usuarios, facturación, módulos, integraciones e inteligencia artificial." }
};

function tabsSentence(item: NavItem): string {
  const labels = item.tabs.filter((tab) => !tab.detail).map((tab) => tab.label);
  if (labels.length === 0) return "";
  const base = item.baseTab ? [item.baseTab, ...labels] : labels;
  return ` Pestañas: ${base.join(" · ")}.`;
}

/** One narrated step per menu item; roles and modules come from the tree. */
export function buildCategoryTour(category: NavCategory): Tour {
  const intro = CATEGORY_INTRO[category.key] ?? { badge: category.label, summary: category.label, body: category.label };
  const roles = Array.from(new Set(category.items.flatMap((item) => item.roles)));
  const steps: TourStep[] = [
    { center: true, title: category.label, body: intro.body },
    ...category.items.map((item) => ({
      navigateTo: item.screenKey,
      roles: item.roles,
      modulesAny: item.modulesAny,
      title: item.label,
      body: `${ITEM_NARRATION[item.screenKey] ?? `${item.label}.`}${tabsSentence(item)}`
    }))
  ];
  return { id: category.key, title: category.label, summary: intro.summary, badge: intro.badge, roles, steps };
}

/**
 * The catalog: the welcome tour plus one tour per category of the tree, in
 * menu order.
 */
export const tours: Tour[] = [WELCOME_TOUR, ...NAV_TREE.categories.map(buildCategoryTour)];

export function getTourById(id: string): Tour {
  return tours.find((t) => t.id === id) ?? tours[0];
}

/** Screen keys narrated by the tours (test hook: they must all be `keep` items). */
export function narratedScreenKeys(): string[] {
  return Object.keys(ITEM_NARRATION);
}

export type TourAudience = {
  roleTokens: readonly RoleToken[];
  /** Enabled module codes; undefined = unknown (module gates are not applied). */
  enabledModules?: readonly string[];
};

function stepVisible(step: TourStep, audience: TourAudience): boolean {
  const gate = { roles: step.roles ?? [], modulesAny: audience.enabledModules ? (step.modulesAny ?? []) : [] };
  if (audience.roleTokens.length === 0) return gate.modulesAny.length === 0 || canSee(gate, ["admin"], audience.enabledModules ?? []);
  return canSee(gate, audience.roleTokens, audience.enabledModules ?? []);
}

/**
 * Steps a given audience can follow: centered intros always, narrated
 * screens only when the role (and, if known, the module) allows them.
 * Returns [] when no screen remains, so callers can hide the tour.
 */
export function tourStepsFor(tour: Tour, audience: TourAudience): TourStep[] {
  const steps = tour.steps.filter((step) => step.center || step.selector || stepVisible(step, audience));
  const hasContent = steps.some((step) => !step.center);
  return hasContent ? steps : [];
}

/** Area tours relevant to an audience (excludes the universal welcome tour). */
export function toursForAudience(audience: TourAudience): Tour[] {
  return tours.filter((tour) => tour.id !== WELCOME_TOUR_ID && tourStepsFor(tour, audience).length > 0);
}

/** The recommended starter tour for each role token (its landing category). */
export const ROLE_STARTER_TOUR: Record<RoleToken, string> = {
  direccion: "hoy",
  recepcion: "recepcion",
  pisos: "operaciones",
  mantenimiento: "operaciones",
  revenue: "revenue",
  finanzas: "finanzas",
  comercial: "comercial",
  fnb: "operaciones",
  // Tanda 8a (RBAC por departamento, design §4.9): the six new tokens land on
  // the category of their roleHome (role-tokens.ts) — administración de hotel
  // and propiedad on Finanzas, RRHH on Finanzas (Nóminas), gestión del activo
  // on Cumplimiento (Centro), auditoría interna and sistemas on Configuración.
  administracion: "finanzas",
  rrhh: "finanzas",
  propiedad: "finanzas",
  activos: "cumplimiento",
  auditoria: "configuracion",
  sistemas: "configuracion",
  admin: "configuracion",
  publico: WELCOME_TOUR_ID
};

export type TaskGuide = {
  id: string;
  title: string;
  summary: string;
  /** Screen key to deep-link to («Ir ahora»); a `keep` item of the tree. */
  screen?: string;
  steps: string[];
};

/**
 * Step-by-step guides for the core daily jobs. Short, numbered, plain Spanish,
 * using the labels of the nine-category menu.
 */
export const taskGuides: TaskGuide[] = [
  {
    id: "checkin",
    title: "Hacer un check-in",
    summary: "Registrar la llegada de un huésped.",
    screen: "FrontDeskDashboard",
    steps: [
      "Abre Hoy › Mi día, o busca al huésped con ⌘K.",
      "Localiza la reserva en la tarjeta «Llegadas de hoy».",
      "Comprueba que tiene una habitación asignada. Si pone «sin asignar», asígnala primero desde Recepción › Reservas › Tablero de habitaciones.",
      "Verifica el documento de identidad del huésped y complétalo en la ficha si falta (obligatorio en España).",
      "Pulsa «Hacer check-in». El estado cambiará a «Alojado»."
    ]
  },
  {
    id: "reserva",
    title: "Crear una reserva",
    summary: "Dar de alta una reserva nueva.",
    screen: "ReservationCreate",
    steps: [
      "Abre Recepción › Nueva reserva (o dicta la reserva en la pestaña «Dictar (IA)»).",
      "Elige las fechas de entrada y salida y el número de huéspedes.",
      "Selecciona un tipo de habitación disponible y su tarifa.",
      "Introduce los datos del huésped (nombre y, si es posible, documento de identidad).",
      "Revisa el importe y pulsa «Guardar». La reserva aparecerá en Recepción › Reservas › Cronograma."
    ]
  },
  {
    id: "asignar",
    title: "Asignar una habitación",
    summary: "Dar habitación a una llegada sin asignar.",
    screen: "ReservationWorkspace",
    steps: [
      "Abre Recepción › Reservas › Tablero de habitaciones.",
      "Localiza la llegada sin habitación y pulsa «Asignar habitación».",
      "Elige una habitación libre y limpia del tipo reservado.",
      "Guarda. Ya podrás hacer el check-in desde Mi día."
    ]
  },
  {
    id: "checkout",
    title: "Cobrar y hacer el check-out",
    summary: "Cerrar la estancia y saldar el folio.",
    screen: "FrontDeskDashboard",
    steps: [
      "Abre la tarjeta «Salidas de hoy» en Hoy › Mi día.",
      "Pulsa «Ver folio» para revisar los cargos del huésped.",
      "Si hay saldo pendiente, registra el cobro antes de cerrar.",
      "Cuando el saldo esté a cero, pulsa «Hacer check-out».",
      "Entrega o envía la factura al huésped desde Finanzas › Facturación y cobros."
    ]
  },
  {
    id: "cierre",
    title: "Cerrar el día",
    summary: "Ejecutar el cierre del día al final del turno de noche.",
    screen: "NightAuditScreen",
    steps: [
      "Abre Hoy › Cierre del día.",
      "Revisa la lista de comprobaciones: llegadas sin registrar, salidas pendientes y folios abiertos.",
      "Resuelve lo que bloquea desde el enlace de cada comprobación.",
      "Cuando todo esté en verde, pulsa «Ejecutar el cierre». La fecha de negocio avanza."
    ]
  },
  {
    id: "buscar",
    title: "Buscar un huésped o una reserva",
    summary: "Encontrar información al instante.",
    steps: [
      "Escribe en la barra de búsqueda de arriba o pulsa ⌘K (Ctrl+K en Windows).",
      "Escribe el nombre, el número de habitación o el localizador.",
      "Selecciona el resultado para abrir la ficha completa."
    ]
  }
];
