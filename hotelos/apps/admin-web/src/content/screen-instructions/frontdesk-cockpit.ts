// Tarjeta de instrucciones de «Mi día» (/hoy). Copy en español, sin jerga
// interna ni nombres de componentes (fix:2-A qa#11); «walk-in» se conserva
// porque es el término que usa la recepción.
//
// Tanda UX-1 · lote U6 (docs/design/UX-RECEPCION-FEEL.md §4 «Ayuda contextual
// honesta», F32, P7): la tarjeta enumera SOLO lo que existe en la pantalla —la
// acción primaria de cada fila, el cajón de check-in con cobro y parte SES, el
// check-out con factura, el walk-in, el buscador, el inspector y el lote— con
// sus atajos tomados del registro (content/shortcuts-registry.ts), nunca
// escritos a mano. Sin promesas de tiempo («90 segundos») ni de flujos que no
// están cableados. Tanda DOC-2: literales re-verificados en /hoy («Check-in en
// 101», «⋯» = «Más acciones de …», «Cobrar 120,00 € y cerrar», «Check-out de 2
// con saldo 0», «Imprimir 2 fichas»); el check-out deja la factura en borrador
// por defecto («Borrador para Facturación») o la emite con número si se elige.
import { shortcutKeys } from "../shortcuts-registry";

export const FRONTDESK_COCKPIT_INSTRUCTIONS = {
  title: "Mi día en recepción",
  description: "Llegadas, salidas y huéspedes en el hotel, con una acción por fila y la cola de lo que toca ahora.",
  steps: [
    `1. Cada fila lleva su acción: «Hacer check-in» (o «Check-in en 118» si aún no tiene habitación), «Cobrar X € y cerrar» en las salidas con saldo o «Abrir ficha». Lo demás está en «⋯»: ver folio, asignar o cambiar habitación, marcar no-show.`,
    `2. El check-in cobra el saldo o el depósito si lo eliges, asigna la habitación y encola el parte de viajeros; Intro confirma. El check-out cobra, cierra el folio y deja la factura en borrador para Facturación o la emite ya con número (a huésped o a empresa).`,
    `3. ${shortcutKeys("nav.walk-in")} abre el walk-in (llegada sin reserva): fechas, tipo con precio, huésped y «Crear y hacer check-in». ${shortcutKeys("nav.focus-search")} va al buscador por nombre o habitación; ${shortcutKeys("global.palette")} busca cualquier cosa.`,
    `4. Pulsa una fila (o Intro) para ver su detalle al lado sin salir; ↑ y ↓ pasan a la siguiente. Marca varias para hacer «Check-out de N con saldo 0», imprimir fichas o asignar habitación en lote.`
  ],
  // P7: las teclas de acceso viven en el detalle de una fila (C: acción primaria, O: abrir ficha), en la ficha (C/P/M) y en Nueva reserva (D/I/C); la tabla no las tiene.
  tip: `Con una fila abierta al lado, mantén ${shortcutKeys("access.reveal").replace(" (mantener)", "")} para ver la letra de cada acción del detalle (también en la ficha y en Nueva reserva); la cola de acciones recalcula sola cada 30 segundos y la etiqueta roja marca lo urgente.`
};
