// Tarjetas de instrucciones de dirección (Tanda UX-2 · lote D8 · docs/design/
// UX-DIRECCION-FEEL.md §1 P7 «Honestidad», §4 «Ayuda contextual honesta» de
// UX-RECEPCION-FEEL.md): cuatro tarjetas —Mi día › Dirección, Pendientes de
// aprobación, Cartera de propiedades y Centro de informes— con el patrón de
// frontdesk-cockpit.ts (description + steps + tip). Cada paso enumera SOLO
// acciones que existen tras los lotes D3-D7: los botones de fila, los comandos
// ⌘K registrados por cada pantalla («Comparar hoteles», «PyG del hotel»…) y las
// teclas de acceso A (Aprobar) y E (Generar exportación). Los atajos salen del
// registro (content/shortcuts-registry.ts), nunca escritos a mano; sin promesas
// de tiempo ni de flujos que no están cableados. El contrato
// content/__tests__/direccion-instructions.test.mts cruza cada «acción» citada
// con los literales de las cuatro pantallas (y del detalle de la cartera) y
// cada comando con los `commands` registrados.
import { shortcutKeys } from "../shortcuts-registry";

/** ⌘K, tal como lo muestra el registro. */
const PALETTE = shortcutKeys("global.palette");
/** «⌥» sin el «(mantener)» del registro: la tecla que revela y ejecuta las letras de acceso. */
const ALT = shortcutKeys("access.reveal").replace(" (mantener)", "");
/** «Intro», tal como lo muestra el registro. */
const ENTER = shortcutKeys("global.enter");

/**
 * Letras de acceso cableadas en las pantallas de dirección (`CocoaButton accessKey`):
 * A = «Aprobar» de la fila seleccionada (ApprovalsScreen) · E = «Generar
 * exportación» (ReportingCenterScreen). Fuera de las reservadas H R N T B F W.
 */
export const DIRECCION_ACCESS_KEYS = {
  aprobar: "A",
  exportar: "E"
} as const;

/** Mi día › Dirección (/hoy/direccion · GeneralManagerScreen). */
export const DIRECCION_PANEL_INSTRUCTIONS = {
  title: "Mi día en dirección",
  description: "Ocupación, ADR, RevPAR, llegadas y salidas de la fecha de negocio del hotel, con los riesgos de hoy y una acción por fila.",
  steps: [
    "El subtítulo dice de qué fecha de negocio son las cifras de «Indicadores de hoy»: la misma ventana que usa el cierre del día. Un «—» significa que ese dato no se ha podido calcular, nunca un cero.",
    "«Riesgos de hoy» reúne el cierre, los pendientes de aprobación y de la IA (si tienes la clave), el riesgo de cancelación y las anomalías; cada fila lleva su botón: «Revisar el cierre», «Ir a aprobaciones», «Revisar la cola», «Revisar reservas» o «Ver ingresos».",
    `${PALETTE} ejecuta las tareas de dirección como comandos: «Ir a los pendientes de aprobación», «Revisar el cierre del día», «Abrir la cartera de hoteles» y «Exportar un informe».`,
    "Los deltas frente a ayer y a la semana pasada solo aparecen cuando hay base con la que comparar; «Actualizar» recarga el panel."
  ],
  tip: "El cierre del día lo ejecuta recepción o la auditoría nocturna: desde aquí lo revisas con «Revisar el cierre», no lo cierras; marcarlo como revisado exige la clave de revisión del cierre (dirección de hotel): la dirección general consulta el informe."
};

/** Hoy › Pendientes de aprobación (/hoy/pendientes · ApprovalsScreen). */
export const DIRECCION_PENDIENTES_INSTRUCTIONS = {
  title: "Pendientes de aprobación",
  description: "Las solicitudes que puedes decidir con tus claves de aprobación y las que has pedido tú, con una decisión por fila.",
  steps: [
    "Cada fila que puedes decidir lleva «Aprobar» y «Rechazar»; pulsar la fila abre su detalle (importe, umbral, solicitante, caducidad y la clave que la decide). ↑ y ↓ cambian de fila sin abrirla.",
    `«Aprobar» abre un diálogo con el nombre de la acción y el importe (por ejemplo «Aprobar reembolso de 60,00 €»); ${ENTER} confirma cuando la nota es opcional y el aviso final lleva el importe y la referencia de la solicitud. «Rechazar» pide siempre el motivo: el solicitante lo verá.`,
    `${PALETTE}: «Aprobar la solicitud seleccionada» o «Rechazar la solicitud seleccionada» (sin fila seleccionada, la primera pendiente). Con la lista a la vista, mantén ${ALT} y pulsa ${DIRECCION_ACCESS_KEYS.aprobar} para aprobar la fila seleccionada.`,
    "Los filtros «Estado» y «Tipo» muestran el histórico; «Propia» marca lo que pediste tú (nadie aprueba lo suyo) y «Doble aprobación» avisa de que por encima de T4 hacen falta dos firmas."
  ],
  tip: "Las aprobaciones con importe esperan la respuesta del servidor antes de cambiar la fila: el botón gira hasta que la decisión queda en el registro de auditoría."
};

/** Informes › Cartera de propiedades (/informes/cartera · PortfolioDashboard y su detalle). */
export const DIRECCION_CARTERA_INSTRUCTIONS = {
  title: "Cartera de propiedades",
  description: "Todos los hoteles del grupo en una tabla: cifras consolidadas, detalle por hotel y comparación frente a la media de la cartera.",
  steps: [
    "«Tabla» ordena por cualquier columna (ocupación, ADR, RevPAR, ingresos del mes, fiscal pendiente, saldo pendiente o salud); pulsar una fila abre el detalle del hotel.",
    "«Comparar» añade a cada cifra su delta frente a la media simple de la cartera y ordena por ocupación; con un solo hotel avisa de que la comparación aparece con dos o más.",
    "En el detalle, «PyG del hotel» abre Pérdidas y ganancias con ese hotel como ámbito; «Cierre del día» y «Exportar informe» solo se ofrecen para el hotel activo, y «Volver a la cartera» regresa a la tabla.",
    `${PALETTE}: «Comparar hoteles», «Ordenar por ocupación» y «Ordenar por ingresos»; en el detalle, «PyG del hotel», «Abrir el cierre del día», «Exportar un informe del hotel» y «Volver a la cartera de propiedades».`
  ],
  tip: "Las cifras de cartera van ponderadas por habitaciones e «Ingresos del mes» es el mes natural; «Alertas críticas» lista los hoteles fuera de umbral con «Abrir propiedad»."
};

/** Informes › Centro de informes (/informes · ReportingCenterScreen). */
export const DIRECCION_INFORMES_INSTRUCTIONS = {
  title: "Centro de informes",
  description: "El catálogo de informes del hotel y la exportación con un periodo real y un formato que dice lo que entrega.",
  steps: [
    "Elige «Tipo de informe» (Reservas · Facturación · Revenue · Propietario) y «Formato»: la lista dice lo que se entrega de verdad («PDF (HTML imprimible)», «XLSX (se entrega CSV)»).",
    "«Periodo»: «Este mes», «Mes anterior», «Últimos 30 días» o «Personalizado» con «Desde» y «Hasta»; cambiar una fecha pasa el periodo a «Personalizado».",
    `«Generar exportación» descarga el fichero y deja «Exportación lista» con «Descargar exportación» para bajarlo otra vez; ${ENTER} en cualquier campo del formulario también exporta, y mantener ${ALT} y pulsar ${DIRECCION_ACCESS_KEYS.exportar} pulsa el botón.`,
    `${PALETTE}: «Generar exportación de informe», «Exportar informe de reservas» y «Exportar informe de facturación».`
  ],
  tip: "«Abrir histórico y previsión» lleva al informe de revenue del hotel; los informes de reservas y facturación de abajo son los mismos datos que exportas."
};

/** Las cuatro tarjetas de dirección con la pantalla que las monta y su `persistKey`. */
export const DIRECCION_INSTRUCTIONS = [
  { screen: "GeneralManagerScreen", persistKey: "direccion-panel", card: DIRECCION_PANEL_INSTRUCTIONS },
  { screen: "ApprovalsScreen", persistKey: "direccion-pendientes", card: DIRECCION_PENDIENTES_INSTRUCTIONS },
  { screen: "PortfolioDashboard", persistKey: "direccion-cartera", card: DIRECCION_CARTERA_INSTRUCTIONS },
  { screen: "ReportingCenterScreen", persistKey: "direccion-informes", card: DIRECCION_INFORMES_INSTRUCTIONS }
] as const;
