// Contenido de ayuda contextual para la pantalla "Facturación" (Billing).
//
// Este módulo expone `BILLING_INSTRUCTIONS`, un objeto tipado como
// `CocoaHelpContent` que alimenta al `CocoaHelpButton` de la pantalla de
// facturación: gestión de folios, facturas, cargos y pagos.
//
// La pantalla cubre el ciclo completo de cobro: abrir el folio de una
// reserva, anadir cargos manuales, dividir el folio mediante reglas de
// routing (por servicio, por huesped, por empresa), aplicar pagos y emitir
// la factura electronica a traves de VeriFactu para cumplir la normativa
// espanola.

import type { CocoaHelpContent } from "../../components/cocoa-guidance/CocoaHelpButton";

export const BILLING_INSTRUCTIONS: CocoaHelpContent = {
  whatIsThis:
    "Pantalla central de facturacion: gestiona folios, facturas, cargos y pagos asociados a cada reserva. Aqui se centraliza el ciclo financiero del huesped, desde los cargos diarios hasta la emision de la factura definitiva y su envio a VeriFactu para cumplir con la normativa de facturacion electronica.",
  howToUse: [
    "Abre el folio de la reserva desde la lista de estancias activas o buscando por numero de reserva o nombre del huesped.",
    "Anade un cargo manual (extra de minibar, servicio adicional, penalizacion, etc.) seleccionando producto, cantidad y tipo de IVA.",
    "Divide el folio cuando lo necesites: aplica reglas de routing para enviar cargos concretos a un folio secundario (companeros de viaje, empresa pagadora, gastos no reembolsables).",
    "Registra los pagos recibidos (tarjeta, transferencia, efectivo, bono) indicando metodo, importe y referencia de cobro.",
    "Cuando el folio quede a cero, emite la factura definitiva: el sistema la firma y la envia automaticamente a VeriFactu, devolviendo el justificante con el codigo QR de Hacienda.",
  ],
  tips: [
    "Configura reglas de routing por servicio (spa, restaurante, parking) para que los cargos se dirijan al folio correcto sin intervencion manual.",
    "Aplica descuentos a nivel de linea para mantener la trazabilidad del precio original; los descuentos globales sobre el folio se reparten proporcionalmente.",
    "Antes de emitir, verifica que los datos fiscales del huesped o de la empresa pagadora estan completos: NIF/CIF, razon social y direccion son obligatorios para VeriFactu.",
    "Si necesitas una rectificativa, usa la accion 'Rectificar factura' desde el detalle: nunca edites una factura ya emitida.",
  ],
  shortcuts: [
    { keys: "Cmd+B", action: "Abrir la pantalla de facturacion (Billing)." },
    { keys: "Cmd+N", action: "Anadir un nuevo cargo al folio actual." },
    { keys: "Cmd+P", action: "Registrar un pago sobre el folio abierto." },
    { keys: "Cmd+Enter", action: "Emitir la factura y enviarla a VeriFactu." },
  ],
  relatedScreens: [
    {
      screenId: "Compliance",
      label: "Compliance",
      description:
        "Estado de las remesas enviadas a VeriFactu, errores de validacion y auditoria fiscal.",
    },
    {
      screenId: "Pagos",
      label: "Pagos",
      description:
        "Centro de cobros: pasarela, conciliacion bancaria y devoluciones.",
    },
  ],
};

export default BILLING_INSTRUCTIONS;
