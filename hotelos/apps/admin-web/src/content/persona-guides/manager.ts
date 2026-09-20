// Guía de persona de dirección (Tanda UX-2 · lote D8 · docs/design/
// UX-DIRECCION-FEEL.md §2): el día escrito sobre las seis tareas medidas
// —revisar el día, decidir pendientes, leer un hotel de la cartera, comparar
// hoteles, exportar un informe y revisar el cierre— con los comandos ⌘K que
// cada pantalla registra. Dirección REVISA el cierre (D-1: `night_audit.review`),
// nunca lo ejecuta: «cerrar el día» no es una acción del director. La clave de
// revisión la lleva la plantilla «Dirección de hotel» (`manager`); «Dirección
// general» (`general_manager`) solo lee el informe del cierre (corrector
// UX2-REV-03: la guía lo dice en vez de prometer un botón que no aparece). Los
// atajos salen del registro (content/shortcuts-registry.ts), nunca escritos a mano.
import type { PersonaGuide } from "./types";
import { shortcutKeys } from "../shortcuts-registry";

const PALETTE = shortcutKeys("global.palette");
const ALT = shortcutKeys("access.reveal").replace(" (mantener)", "");

export const MANAGER_GUIDE: PersonaGuide = {
  id: "direccion",
  roleTokens: ["direccion", "admin"],
  title: "Dirección: el hotel de un vistazo",
  summary: "Las seis tareas del día —revisar, decidir, leer cada hotel, comparar, exportar y revisar el cierre— con una acción por fila y un comando por tarea.",
  dailyFlow: [
    "Empieza en Hoy › Mi día › Dirección: ocupación, ADR, RevPAR, llegadas y salidas de la fecha de negocio (el subtítulo la dice) y el bloque «Riesgos de hoy» con una acción por fila: «Revisar el cierre», «Ir a aprobaciones», «Revisar la cola», «Revisar reservas».",
    `Decide en Hoy › Pendientes de aprobación: «Aprobar» o «Rechazar» en la propia fila, con el importe en el diálogo (${PALETTE} «Ir a los pendientes de aprobación» desde el panel; en la bandeja, «Aprobar la solicitud seleccionada» o mantén ${ALT} y pulsa A). Las propuestas de la IA se revisan en Hoy › Pendientes de la IA.`,
    `Lee cada hotel en Informes › Cartera de propiedades: una fila abre el detalle y «PyG del hotel» abre Pérdidas y ganancias con ese hotel como ámbito (${PALETTE} «Abrir la cartera de hoteles» desde el panel y «PyG del hotel» en el detalle).`,
    `Compara hoteles en la vista «Comparar» de la Cartera: cada cifra lleva su delta frente a la media simple de la cartera y se ordena por columna (${PALETTE} «Comparar hoteles», «Ordenar por ocupación», «Ordenar por ingresos»).`,
    `Exporta un informe en Informes › Centro de informes: tipo, formato que dice lo que entrega y periodo real, «Generar exportación» (${PALETTE} «Exportar un informe» desde el panel y «Generar exportación de informe» en el centro; o mantén ${ALT} y pulsa E).`,
    `Revisa el cierre en Hoy › Cierre del día: abre el informe del último cierre y «Marcar como revisado» (${PALETTE} «Revisar el cierre del día»). El cierre lo ejecuta recepción o la auditoría nocturna, no dirección; «Marcar como revisado» lo ve la dirección de hotel (clave de revisión del cierre): la dirección general solo consulta el informe.`
  ],
  tips: [
    `${PALETTE} busca cualquier pantalla y ejecuta los comandos de la que tienes abierta; mantén ${ALT} para ver la letra de cada acción visible.`,
    "Un «—» en el panel significa que ese dato no se ha podido calcular; nunca es un cero. Los deltas frente a ayer o a la semana pasada solo aparecen cuando hay base con la que comparar.",
    "El rol de cada persona decide qué ve en el menú: un recepcionista no ve Finanzas ni Configuración. Si una entrada aparece atenuada, su módulo está desactivado: actívalo en Configuración › Módulos e integraciones.",
    "Quien solicita nunca aprueba: tus propias solicitudes aparecen marcadas «Propia» sin botones, y por encima de T4 hacen falta dos firmas."
  ],
  relatedScreens: [
    "FrontDeskDashboard",
    "ApprovalsInbox",
    "AiHumanReviewQueueScreen",
    "PortfolioDashboard",
    "ReportingCenter",
    "NightAuditScreen",
    "ModuleManager"
  ]
};

export default MANAGER_GUIDE;
