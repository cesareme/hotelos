// Tarjetas de instrucciones de Recepción › Reservas (lista) y › Nueva reserva.
//
// Tanda UX-1 · lote U9a (docs/design/UX-RECEPCION-FEEL.md §4 «Ayuda contextual
// honesta», §5.10, P7): cada tarjeta enumera SOLO lo que existe en la pantalla
// —las vistas operativas de la lista, el buscador por nombre, código o
// habitación, el inspector, el lote y las columnas (U8); los dos modos de Nueva
// reserva (rápida en una pantalla con precio en vivo y «Crear y…», completa con
// los seis pasos) y su conmutador— con los atajos tomados del registro
// (content/shortcuts-registry.ts), nunca escritos a mano. Sin vistas de
// calendario ni arrastres al rack que la lista no tiene.
import { shortcutKeys } from "../shortcuts-registry";

export const RESERVATIONS_INSTRUCTIONS = {
  whatIsThis:
    "Todas las reservas del hotel en una lista con vistas operativas (Todas · Llegan hoy · En el hotel · Salen hoy · Futuras · Canceladas), buscador por nombre, código o habitación, inspector lateral y acciones en lote.",
  howToUse: [
    "1. Elige la vista operativa en la barra: los contadores de arriba abren la suya. Las canceladas solo se ven en su vista.",
    `2. Busca por nombre, código de reserva o número de habitación (${shortcutKeys("nav.focus-search")} va al buscador): la tabla no se vacía mientras carga.`,
    "3. Pulsa una fila (o Intro) para ver su detalle al lado sin salir; ↑ y ↓ pasan a la siguiente reserva. «Abrir ficha completa» lleva a la ficha con folio, documentos y acciones.",
    "4. Marca varias filas para imprimir fichas, asignar habitación o hacer «Check-out de N con saldo 0» en lote; «Columnas ▾» guarda las columnas que quieres ver.",
    `5. «Nueva reserva» (${shortcutKeys("nav.reservation-create")}) abre el modo rápido: estancia, tipo con precio en vivo y huésped en una pantalla; «Completa» tiene los seis pasos para grupos, acompañantes, identidad, pagos y solicitudes.`
  ],
  tips: [
    "El color de cada estado es el mismo en toda la recepción: Llega hoy, En el hotel, Sale hoy, Salida hecha, Confirmada, No-show y Cancelada (la leyenda del Live Timeline de Hoy es la referencia).",
    `${shortcutKeys("global.palette")} busca reservas, huéspedes y habitaciones desde cualquier pantalla.`
  ],
  shortcuts: [
    { keys: shortcutKeys("global.palette"), description: "Buscar reservas, huéspedes y pantallas" },
    { keys: shortcutKeys("nav.focus-search"), description: "Ir al buscador de la lista" },
    { keys: shortcutKeys("nav.reservation-create"), description: "Abrir Nueva reserva (modo rápido)" },
    { keys: shortcutKeys("global.escape"), description: "Cerrar el inspector, panel o diálogo abierto" }
  ],
  relatedScreens: [
    { name: "Nueva reserva", path: "/recepcion/reservas/nueva" },
    { name: "Mi día", path: "/hoy" },
    { name: "Live Timeline", path: "/hoy/live-timeline" },
    { name: "Huéspedes", path: "/recepcion/huespedes" }
  ]
} as const;

/** Tarjeta de Nueva reserva (los dos modos; `?modo=rapida|completa`, rápida por defecto). */
export const RESERVATION_CREATE_INSTRUCTIONS = {
  title: "Nueva reserva",
  description:
    "Modo rápido por defecto: una pantalla con lo mínimo (estancia, tipo y huésped) y el precio en vivo. «Completa» conserva los seis pasos para grupos, acompañantes, identidad (SES), pagos y solicitudes.",
  steps: [
    "1. Rápida: fechas (admiten «+7», «hoy», «mañana» y «+1 noche»), adultos y tipo; cada tipo muestra su precio por noche y las habitaciones libres según la tarifa publicada.",
    "2. Nombre y apellido son lo único obligatorio del huésped; si ya tiene ficha, la pantalla la sugiere y «Usar sus datos» rellena contacto y documento sin volver a teclearlos.",
    "3. Con razón social, la factura irá a la empresa y el NIF queda recordado para emitirla desde la ficha. El total sale de la tarifa; escribe un importe solo si es manual.",
    `4. Intro (o ${shortcutKeys("global.enter")} en cualquier campo) crea la reserva y abre su ficha; «Crear y cobrar depósito» abre el cobro y «Crear y hacer check-in» aloja al huésped en la primera habitación limpia y libre del tipo (solo llegadas de hoy).`,
    "5. «Completa» (conmutador de la cabecera) tiene los seis pasos de siempre con «Consultar disponibilidad» y «Confirmar y crear reserva» en el último; lo tecleado se conserva al cambiar de modo."
  ],
  tip: `${shortcutKeys("nav.reservation-create")} abre esta pantalla desde cualquier sitio; mantén ${shortcutKeys("access.reveal").replace(" (mantener)", "")} para ver la letra de cada botón (D depósito · I check-in · C crear).`
} as const;
