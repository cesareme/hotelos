// Content for the in-app guidance system ("guía intrínseca").
// Kept separate from components so the plain-Spanish copy is easy to evolve.
// Apple principle: the interface is the manual — every step is explained where
// the action happens, in the user's own language, with no jargon.
import { PERSONA_ROLES, type Role } from "../../navigation/roles";

export type TourStep = {
  /** CSS selector of a real element to spotlight (dims the rest). */
  selector?: string;
  /** Screen key to open (via hotelos-nav) before showing this step. */
  navigateTo?: string;
  /** Render as a centered card with a dimmed backdrop (for intros/summaries). */
  center?: boolean;
  title: string;
  body: string;
};

export type Tour = {
  id: string;
  title: string;
  summary: string;
  /** Short category label shown as a chip. */
  badge?: string;
  steps: TourStep[];
};

export const WELCOME_TOUR_ID = "primeros-pasos";

/**
 * The catalog of guided tours — one per app area. The first tour ("primeros
 * pasos") is the 60-second welcome, anchored to chrome present on every screen.
 * Every other tour drives the user through the real screens of its area and
 * narrates each one, step by step.
 */
export const tours: Tour[] = [
  {
    id: WELCOME_TOUR_ID,
    title: "Primeros pasos",
    summary: "Un minuto para conocer lo esencial de la app.",
    badge: "Bienvenida",
    steps: [
      {
        center: true,
        title: "Te damos la bienvenida",
        body: "Este recorrido de un minuto te muestra lo esencial para empezar. Puedes salir cuando quieras y repetirlo desde el botón «?»."
      },
      {
        selector: "[data-tour='property']",
        title: "Tu hotel activo",
        body: "Aquí ves en qué hotel estás trabajando y puedes cambiar a otro. Comprueba siempre que es el correcto antes de hacer un check-in o una reserva."
      },
      {
        selector: "[data-tour='search']",
        title: "Encuentra cualquier cosa",
        body: "Busca una reserva o un huésped por nombre, número de habitación o localizador. Atajo de teclado: ⌘K (o Ctrl+K)."
      },
      {
        selector: "[data-tour='sidebar']",
        title: "Tu menú",
        body: "Toda la app vive aquí, organizada por áreas. Tus tareas del día están en «Ops»; la configuración, en «Back Office»."
      },
      {
        selector: "[data-tour='notifications']",
        title: "Avisos en tiempo real",
        body: "Te avisamos de llegadas, tareas pendientes y alertas que necesitan tu atención."
      },
      {
        selector: "[data-tour='help']",
        title: "Tu guía, siempre a mano",
        body: "Pulsa el «?» cuando quieras para repetir este recorrido, abrir un recorrido por área o ver los pasos de cada tarea."
      }
    ]
  },

  {
    id: "recepcion",
    title: "Recepción (día a día)",
    summary: "Tu copiloto y el día a día del mostrador.",
    badge: "Ops",
    steps: [
      {
        center: true,
        title: "Recepción, paso a paso",
        body: "El Copiloto de recepción es tu centro de mando: el pulso del día, accesos directos y un asistente de IA. Te enseñamos cada parte."
      },
      {
        navigateTo: "ReceptionCopilotScreen",
        selector: "[data-tour='cop-pulse']",
        title: "El pulso de tu día",
        body: "De un vistazo: llegadas y salidas de hoy, quién está en el hotel, habitaciones sin asignar y saldos por cobrar. Toca una tarjeta para ir a «Mi día»."
      },
      {
        selector: "[data-tour='cop-actions']",
        title: "Acciones rápidas",
        body: "Lo más frecuente a un toque: crear una reserva, buscar un huésped (⌘K), reservar con IA, ir a las llegadas o al Live Timeline."
      },
      {
        selector: "[data-tour='cop-input']",
        title: "Mensaje del huésped",
        body: "Pega el texto del huésped o elige una de sus conversaciones (WhatsApp, email, chat…) para responder en contexto."
      },
      {
        selector: "[data-tour='cop-intents']",
        title: "Preguntas frecuentes",
        body: "Un clic rellena las dudas típicas (parking, check-out, mascotas, cómo llegar…) para que no escribas de cero."
      },
      {
        selector: "[data-tour='cop-options']",
        title: "Idioma y tono",
        body: "Elige en qué idioma responde la IA (o que use el del huésped) y con qué tono: cordial, formal, cercano o breve."
      },
      {
        selector: "[data-tour='cop-draft']",
        title: "Borrador con IA",
        body: "La IA redacta la respuesta; tú la revisas, la editas y la envías o la copias. La IA nunca envía nada sola."
      },
      {
        navigateTo: "LiveTimelineWorkspace",
        title: "Live Timeline",
        body: "El planning de habitaciones por día. Arrastra una reserva para moverla, ajusta fechas y detecta solapes al instante."
      },
      {
        navigateTo: "GuestsList",
        title: "Huéspedes",
        body: "Busca fichas de huéspedes, su historial de estancias y sus documentos de identidad."
      }
    ]
  },

  {
    id: "reservas",
    title: "Reservas y huéspedes",
    summary: "Gestionar reservas, folios y fichas de cliente.",
    badge: "Ops",
    steps: [
      {
        center: true,
        title: "Reservas y huéspedes",
        body: "Todo el ciclo de una reserva: buscarla, abrirla, cobrar el folio y consultar al huésped."
      },
      {
        navigateTo: "ReservationWorkspace",
        title: "Espacio de reservas",
        body: "Busca y filtra todas las reservas. Desde aquí abres cualquiera para trabajar con ella."
      },
      {
        navigateTo: "ReservationDetailWorkspace",
        title: "Ficha de la reserva",
        body: "El folio con todos los cargos, la asignación de habitación y los botones de check-in y check-out."
      },
      {
        navigateTo: "GuestsList",
        title: "Lista de huéspedes",
        body: "El directorio de clientes con sus datos de contacto, identidad y preferencias."
      },
      {
        navigateTo: "GuestJourneyWorkspace",
        title: "Recorrido del huésped",
        body: "La actividad del huésped en un solo hilo: mensajes, peticiones, incidencias y servicios."
      }
    ]
  },

  {
    id: "operaciones",
    title: "Tableros operativos",
    summary: "Limpieza, mantenimiento, personal y más.",
    badge: "Ops",
    steps: [
      {
        center: true,
        title: "Operaciones del hotel",
        body: "Los tableros con los que trabajan los equipos de piso, mantenimiento y servicios."
      },
      {
        navigateTo: "HousekeepingDashboard",
        title: "Limpieza (housekeeping)",
        body: "Estado de cada habitación (limpia, sucia, en proceso) y asignación de tareas al equipo de piso."
      },
      {
        navigateTo: "MaintenanceDashboard",
        title: "Mantenimiento",
        body: "Incidencias y órdenes de trabajo: crear, asignar y cerrar averías."
      },
      {
        navigateTo: "WorkforceDashboard",
        title: "Personal y turnos",
        body: "La plantilla del día: turnos, presencias y cargas de trabajo por equipo."
      },
      {
        navigateTo: "SafetyDashboard",
        title: "Seguridad e incidentes",
        body: "Registro de incidentes de seguridad y su seguimiento hasta la resolución."
      },
      {
        navigateTo: "PosDashboard",
        title: "Puntos de venta (TPV)",
        body: "Restaurante, bar y otros consumos que se cargan a la habitación del huésped."
      }
    ]
  },

  {
    id: "comercial",
    title: "Comercial y revenue",
    summary: "Precios, previsión, canales y ventas.",
    badge: "Comercial",
    steps: [
      {
        center: true,
        title: "Comercial y revenue",
        body: "Las herramientas para maximizar ingresos: tarifas, previsión, competencia, canales y grupos."
      },
      {
        navigateTo: "RevenueHomeDashboard",
        title: "Panel de revenue",
        body: "Ocupación, ADR y RevPAR de un vistazo, con las señales clave del día."
      },
      {
        navigateTo: "RevenueHistoryForecastDashboard",
        title: "Histórico y previsión",
        body: "Compara el rendimiento pasado con la previsión y revísalo en la tabla en vivo."
      },
      {
        navigateTo: "RevenueMeeting",
        title: "Reunión de revenue",
        body: "El resumen para la reunión semanal: pace, pickup, presupuesto y recomendaciones de precio."
      },
      {
        navigateTo: "RateShopperSettings",
        title: "Rate shopper (comp-set)",
        body: "Vigila las tarifas de tus competidores y detecta diferencias de paridad."
      },
      {
        navigateTo: "ChannelAggregatorHub",
        title: "Channel Manager",
        body: "Conexión con las OTAs (Booking, Expedia…): disponibilidad, precios y sincronización."
      },
      {
        navigateTo: "SalesPipelineDashboard",
        title: "Pipeline de ventas",
        body: "Cuentas, oportunidades y negociaciones comerciales (corporate, agencias…)."
      },
      {
        navigateTo: "GroupsEventsDashboard",
        title: "Grupos y eventos",
        body: "Bloqueos de habitaciones, salas y eventos, con su impacto en la disponibilidad."
      }
    ]
  },

  {
    id: "experiencia",
    title: "Experiencia del huésped",
    summary: "Mensajería, reputación, fidelización y CRM.",
    badge: "Ops",
    steps: [
      {
        center: true,
        title: "Experiencia del huésped",
        body: "Todo lo que mejora la relación con el cliente, antes, durante y después de la estancia."
      },
      {
        navigateTo: "ReceptionCopilotScreen",
        title: "Copiloto de recepción",
        body: "Asistente con IA que te sugiere respuestas y resuelve dudas del huésped al instante."
      },
      {
        navigateTo: "ConciergeInboxDashboard",
        title: "Conserjería y mensajería",
        body: "Conversaciones con los huéspedes por todos los canales, en una sola bandeja."
      },
      {
        navigateTo: "ReputationDashboard",
        title: "Reputación y reseñas",
        body: "Reseñas de OTAs y portales, su puntuación y la respuesta a cada una."
      },
      {
        navigateTo: "UpsellsDashboard",
        title: "Ventas adicionales",
        body: "Mejoras de habitación y extras que aumentan el ingreso por estancia."
      },
      {
        navigateTo: "SurveysDashboard",
        title: "Encuestas / NPS",
        body: "Satisfacción del huésped y NPS para detectar qué mejorar."
      },
      {
        navigateTo: "CrmDashboard",
        title: "CRM y fidelización",
        body: "Segmentos de clientes, campañas y el programa de fidelización."
      }
    ]
  },

  {
    id: "finanzas",
    title: "Finanzas y fiscalidad",
    summary: "Contabilidad, tesorería e impuestos (España).",
    badge: "Finanzas",
    steps: [
      {
        center: true,
        title: "Finanzas y fiscalidad",
        body: "El control económico del hotel: cobros, contabilidad, nóminas e impuestos."
      },
      {
        navigateTo: "FiscalDashboard",
        title: "Centro fiscal",
        body: "VeriFactu y los modelos de la AEAT (303, 111, 115, 180, 390) en un solo sitio."
      },
      {
        navigateTo: "FinancePositionDashboard",
        title: "Tesorería (AR · AP · caja)",
        body: "Lo que te deben, lo que debes y la posición de caja actual."
      },
      {
        navigateTo: "BankReconciliationScreen",
        title: "Conciliación bancaria",
        body: "Cuadra los movimientos del banco con los apuntes contables."
      },
      {
        navigateTo: "TrialBalanceScreen",
        title: "Estados financieros",
        body: "Balance de sumas y saldos, balance de situación y estado de flujos de caja."
      },
      {
        navigateTo: "CommissionsScreen",
        title: "Comisiones de OTA",
        body: "Comisiones que cobran los canales y su conciliación."
      },
      {
        navigateTo: "PayrollScreen",
        title: "Nóminas",
        body: "Cálculo y exportación de nóminas del personal."
      },
      {
        navigateTo: "FiscalSubmissionsCenter",
        title: "Envíos a la AEAT",
        body: "Historial y estado de las presentaciones fiscales realizadas."
      }
    ]
  },

  {
    id: "cumplimiento",
    title: "Cumplimiento (España)",
    summary: "Registro de viajeros, SES.HOSPEDAJES y RGPD.",
    badge: "Compliance",
    steps: [
      {
        center: true,
        title: "Cumplimiento legal en España",
        body: "Las obligaciones legales de un alojamiento: registro de viajeros, comunicación a autoridades y protección de datos."
      },
      {
        navigateTo: "ComplianceInbox",
        title: "Bandeja de cumplimiento",
        body: "Tu lista de tareas legales pendientes y su estado, todo en un sitio."
      },
      {
        navigateTo: "GuestRegisterSettings",
        title: "Registro de viajeros",
        body: "Los datos obligatorios de cada huésped (parte de viajeros) y su configuración."
      },
      {
        navigateTo: "SesHospedajesSettings",
        title: "SES.HOSPEDAJES",
        body: "Credenciales y envío automático del registro de hospedaje al Ministerio del Interior."
      },
      {
        navigateTo: "AuthorityRoutingSettings",
        title: "Envío a autoridades",
        body: "A qué organismo se envía cada comunicación y con qué reglas."
      },
      {
        navigateTo: "GdprRequestsScreen",
        title: "Solicitudes RGPD",
        body: "Peticiones de acceso o borrado de datos de los huéspedes (derechos RGPD)."
      }
    ]
  },

  {
    id: "ia",
    title: "Operaciones de IA",
    summary: "Configurar, supervisar y gobernar la IA.",
    badge: "IA",
    steps: [
      {
        center: true,
        title: "Operaciones de IA",
        body: "Cómo la IA trabaja para tu hotel y cómo la mantienes bajo control. Toda acción importante pasa por revisión humana."
      },
      {
        navigateTo: "AiOwnerSummaryScreen",
        title: "Resumen de IA (dirección)",
        body: "Para gerencia: qué ha hecho la IA, qué ha ahorrado y dónde ha ayudado."
      },
      {
        navigateTo: "AiPipelineStatusScreen",
        title: "Actividad de la IA",
        body: "Registro en vivo de cada acción de la IA y su resultado."
      },
      {
        navigateTo: "PropertyAiScreen",
        title: "Configuración de IA",
        body: "Ajusta el comportamiento de la IA para esta propiedad (idioma, tono, límites)."
      },
      {
        navigateTo: "EmailConnectors",
        title: "Correo → reservas (IA)",
        body: "Conecta buzones para que la IA lea correos y prepare reservas. Cada borrador pasa por revisión humana."
      },
      {
        navigateTo: "AiToolRegistryScreen",
        title: "Catálogo de herramientas",
        body: "Qué herramientas puede usar la IA y cuáles están activas por propiedad."
      },
      {
        navigateTo: "AiHumanReviewQueueScreen",
        title: "Revisión humana (HITL)",
        body: "La cola donde una persona aprueba o rechaza lo que propone la IA antes de aplicarlo."
      }
    ]
  },

  {
    id: "alta",
    title: "Alta y migración",
    summary: "Poner en marcha un hotel nuevo con IA.",
    badge: "Onboarding",
    steps: [
      {
        center: true,
        title: "Alta y migración con IA",
        body: "El proceso para dar de alta un alojamiento nuevo importando sus datos con ayuda de la IA."
      },
      {
        navigateTo: "PropertyMapper",
        title: "Mapear desde documentos",
        body: "Sube documentos del hotel y la IA propone su estructura (edificios, plantas, habitaciones)."
      },
      {
        navigateTo: "SourceConnections",
        title: "Conexiones de origen",
        body: "Conecta el PMS o las hojas de cálculo de donde vienen los datos a migrar."
      },
      {
        navigateTo: "FileUploadAndClassification",
        title: "Subir y clasificar ficheros",
        body: "Carga los exports y la IA los clasifica por tipo (reservas, huéspedes, tarifas…)."
      },
      {
        navigateTo: "AIExtractionReview",
        title: "Revisión de extracción",
        body: "Comprueba y corrige lo que la IA ha extraído antes de importarlo."
      },
      {
        navigateTo: "OnboardingGoLiveReadiness",
        title: "Preparación para go-live",
        body: "La lista de comprobaciones que deben superarse antes de pasar a producción."
      }
    ]
  },

  {
    id: "configuracion",
    title: "Configuración (Back Office)",
    summary: "Estructura, módulos, usuarios e integraciones.",
    badge: "Back Office",
    steps: [
      {
        center: true,
        title: "Configuración del sistema",
        body: "Donde se define cómo funciona tu hotel en la app: estructura, módulos, usuarios e integraciones."
      },
      {
        navigateTo: "SetupCenterScreen",
        title: "Centro de configuración",
        body: "El punto de partida con todo lo necesario para dejar el hotel listo."
      },
      {
        navigateTo: "ConfigurationCenterScreen",
        title: "Configuración de la propiedad",
        body: "Datos del hotel, edificios, plantas y zonas."
      },
      {
        navigateTo: "RoomSetupForm",
        title: "Habitaciones y tipos",
        body: "Crea los tipos de habitación y el inventario de habitaciones reales."
      },
      {
        navigateTo: "CategoryManagerScreen",
        title: "Categorías y campos",
        body: "Listas y campos personalizados para adaptar la app a tu operativa."
      },
      {
        navigateTo: "ModuleManager",
        title: "Módulos",
        body: "Activa o desactiva las funcionalidades que usa tu hotel."
      },
      {
        navigateTo: "UserRoleManager",
        title: "Usuarios y roles",
        body: "Quién puede entrar y qué puede ver o hacer cada persona."
      },
      {
        navigateTo: "IntegrationManager",
        title: "Integraciones",
        body: "Conexiones con pasarelas de pago, mensajería y otros sistemas externos."
      }
    ]
  },

  {
    id: "analitica",
    title: "Analítica e informes",
    summary: "Métricas, rentabilidad y sostenibilidad.",
    badge: "Datos",
    steps: [
      {
        center: true,
        title: "Analítica e informes",
        body: "Para entender el negocio: métricas, informes a medida, rentabilidad y consumo de recursos."
      },
      {
        navigateTo: "AnalyticsCenterDashboard",
        title: "Centro de analítica",
        body: "Los indicadores clave del hotel reunidos en un panel."
      },
      {
        navigateTo: "ReportingCenter",
        title: "Informes",
        body: "Genera y exporta informes de reservas, facturación y operaciones."
      },
      {
        navigateTo: "RoomProfitabilityDashboard",
        title: "Rentabilidad por habitación",
        body: "Qué habitaciones y tipos aportan más margen."
      },
      {
        navigateTo: "EnergyDashboard",
        title: "Energía",
        body: "Consumo energético por zonas y su evolución."
      },
      {
        navigateTo: "SustainabilityDashboard",
        title: "Sostenibilidad",
        body: "Huella e indicadores ESG del alojamiento."
      },
      {
        navigateTo: "AssetsDashboard",
        title: "Activos",
        body: "Inventario de activos y equipamiento del hotel."
      }
    ]
  }
];

export function getTourById(id: string): Tour {
  return tours.find((t) => t.id === id) ?? tours[0];
}

// Which personas each tour is relevant for (keyed by tour id so we don't have to
// thread the Role type through every tour object). The welcome tour is universal.
const TOUR_ROLES: Record<string, Role[]> = {
  "primeros-pasos": ["reception", "operations", "asset", "owner"],
  recepcion: ["reception", "operations"],
  reservas: ["reception", "operations"],
  operaciones: ["operations"],
  comercial: ["operations", "asset", "owner"],
  experiencia: ["reception", "operations", "asset"],
  finanzas: ["asset", "owner"],
  cumplimiento: ["reception", "operations", "asset"],
  ia: ["operations", "asset"],
  alta: ["operations", "asset"],
  configuracion: ["operations", "asset"],
  analitica: ["operations", "asset", "owner"]
};

export function tourRoles(id: string): Role[] {
  return TOUR_ROLES[id] ?? PERSONA_ROLES;
}

/** The recommended starter tour for each persona. */
export const ROLE_STARTER_TOUR: Record<string, string> = {
  reception: "recepcion",
  operations: "operaciones",
  asset: "comercial",
  owner: "comercial"
};

/** Area tours relevant to a role (excludes the universal welcome tour). */
export function toursForRole(role: Role): Tour[] {
  return tours.filter((t) => t.id !== WELCOME_TOUR_ID && (role === "all" || tourRoles(t.id).includes(role)));
}

export type TaskGuide = {
  id: string;
  title: string;
  summary: string;
  /** Optional screen key to deep-link to ("Ir ahora"). Must exist in App.tsx. */
  screen?: string;
  steps: string[];
};

/**
 * Step-by-step guides for the core daily jobs. Short, numbered, plain Spanish.
 * Each can deep-link to the right screen so guidance and action share a place.
 */
export const taskGuides: TaskGuide[] = [
  {
    id: "checkin",
    title: "Hacer un check-in",
    summary: "Registrar la llegada de un huésped.",
    screen: "FrontDeskDashboard",
    steps: [
      "Abre «Mi día (recepción)» en el menú, o busca al huésped con ⌘K.",
      "Localiza la reserva en la tarjeta «Llegadas de hoy».",
      "Comprueba que tiene una habitación asignada. Si pone «sin asignar», asígnala primero.",
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
      "En «Mi día» pulsa «Crear reserva» (o ve a «Ops › Reservations & guests › Create reservation»).",
      "Elige las fechas de entrada y salida y el número de huéspedes.",
      "Selecciona un tipo de habitación disponible y su tarifa.",
      "Introduce los datos del huésped (nombre y, si es posible, documento de identidad).",
      "Revisa el importe y pulsa «Guardar». La reserva aparecerá en el Live Timeline."
    ]
  },
  {
    id: "asignar",
    title: "Asignar una habitación",
    summary: "Dar habitación a una llegada sin asignar.",
    screen: "FrontDeskDashboard",
    steps: [
      "En «Mi día», abre la tarjeta «Llegadas sin habitación».",
      "Pulsa «Asignar habitación» en la reserva.",
      "Elige una habitación libre del tipo reservado.",
      "Guarda. Ya podrás hacer el check-in."
    ]
  },
  {
    id: "checkout",
    title: "Cobrar y hacer el check-out",
    summary: "Cerrar la estancia y saldar el folio.",
    screen: "FrontDeskDashboard",
    steps: [
      "Abre la tarjeta «Salidas de hoy» en «Mi día».",
      "Pulsa «Ver folio» para revisar los cargos del huésped.",
      "Si hay saldo pendiente («pendiente»), registra el cobro antes de cerrar.",
      "Cuando el saldo esté a cero, pulsa «Hacer check-out».",
      "Entrega o envía la factura al huésped."
    ]
  },
  {
    id: "buscar",
    title: "Buscar un huésped o reserva",
    summary: "Encontrar información al instante.",
    steps: [
      "Pulsa la barra de búsqueda de arriba o usa el atajo ⌘K.",
      "Escribe el nombre, el número de habitación o el localizador.",
      "Selecciona el resultado para abrir la ficha completa."
    ]
  }
];
