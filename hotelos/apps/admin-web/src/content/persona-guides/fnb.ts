import type { PersonaGuide } from "./types";

export const FNB_GUIDE: PersonaGuide = {
  id: "fnb",
  roleTokens: ["fnb"],
  title: "Restauración: punto de venta y existencias",
  summary: "Tickets, cargos a habitación, cartas y existencias del restaurante y el bar.",
  dailyFlow: [
    "Empieza en Hoy › Mi día › Operaciones para ver las llegadas, los grupos y los eventos del día.",
    "Abre Operaciones › Punto de venta para los tickets del turno: cobro directo o cargo a la habitación del huésped.",
    "Mantén las cartas y los precios en Operaciones › Punto de venta › Cartas.",
    "Registra las existencias y los consumos en Operaciones › Punto de venta › Existencias.",
    "Haz los pedidos a proveedores desde Operaciones › Compras e inventario.",
    "Al cerrar el turno, cierra la caja del punto de venta antes del Cierre del día de recepción."
  ],
  tips: [
    "Un cargo a habitación solo es posible si el huésped está alojado: recepción ve el cargo en su folio al instante.",
    "Los turnos del equipo de sala se planifican en Operaciones › Personal y turnos."
  ],
  relatedScreens: ["PosDashboard", "ProcurementDashboard", "WorkforceDashboard"]
};

export default FNB_GUIDE;
