// Tarjeta de instrucciones de Recepción › Grupos y eventos › Cupos
// (/recepcion/grupos/cupos; la consume AllotmentsScreen: whatIsThis como descripción,
// howToUse como pasos y tips[0] como consejo; el título «Cupos de tour operadores»
// vive en la pantalla). Tanda DOC-2: literales reales («Nuevo cupo», «Nuevo TT.OO.»,
// «Liberar cuotas vencidas», vistas «Pickup y liberación · Cupos contratados · Tour
// operadores»; umbrales del pickup: rojo por debajo del 40 %, ámbar hasta el 70 %).
// Los atajos salen del registro, nunca escritos a mano.
import { shortcutKeys } from "../shortcuts-registry";

export const ALLOTMENTS_INSTRUCTIONS = {
  whatIsThis: "Cupos contratados con tour operadores y bancos de camas: bloques de habitaciones reservados para un operador con su periodo de liberación, su modelo de tarifa y el seguimiento del pickup (habitaciones vendidas frente al cupo).",
  howToUse: [
    "Da de alta el operador con «Nuevo TT.OO.» y pulsa «Nuevo cupo» para crear el bloque: operador, tipo de habitación, vigencia y habitaciones al día.",
    "Define los días de liberación antes de la llegada: vencido el plazo, las habitaciones no vendidas vuelven al cupo general.",
    "Sigue el pickup en la vista «Pickup y liberación» (vendido, disponible y liberado noche a noche): la barra se pone en rojo por debajo del 40 % y en ámbar hasta el 70 %, y un aviso anticipa las liberaciones importantes (la mitad o más del cupo) dentro de su periodo de liberación.",
    "Elige el modelo de tarifa del contrato al crearlo: neta (el operador aplica su margen) o comisionable con su porcentaje.",
    "«Liberar cuotas vencidas» devuelve de una vez al cupo general todas las cuotas caducadas que no se han consumido."
  ],
  tips: [
    "Cupo flexible: con periodo de liberación, lo no vendido vuelve al cupo general. Cupo garantizado: el operador paga aunque no venda, sin liberación. Venta libre: sin inventario reservado, vende contra la disponibilidad general.",
    "Negocia la comisión según la temporada (alta 12-15 %, baja 18-22 %).",
    "Revisa el pickup cada semana para detectar cupos infrautilizados antes de la liberación."
  ],
  shortcuts: [
    { keys: shortcutKeys("global.palette"), description: "Buscar reservas, huéspedes y pantallas" },
    { keys: shortcutKeys("global.escape"), description: "Cerrar el panel o diálogo abierto" }
  ],
  relatedScreens: [
    { label: "Reservas", screenId: "ReservationWorkspace" },
    { label: "Parrilla de tarifas", screenId: "RateGridEditorScreen" },
    { label: "Canales de venta", screenId: "ChannelAggregatorHub" },
    { label: "Contratos B2B", screenId: "B2BContractsScreen" }
  ]
};
