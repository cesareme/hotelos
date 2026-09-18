// Contextual help copy for the «Facturación y cobros» screen (BillingCenterScreen).
//
// Exposes `BILLING_INSTRUCTIONS`, typed as `CocoaHelpContent`, consumed by the
// `CocoaScreenInstructionsCard` at the top of /finanzas/facturacion (title
// «Centro de facturación» lives in the screen). The card renders `whatIsThis`
// as the description, `howToUse` as the numbered steps and `tips[0]` as the
// tip callout; `shortcuts` and `relatedScreens` feed the `CocoaHelpButton`
// sheet when a screen mounts it.
//
// Every claim below describes what the screen really does today (Tanda L3 ·
// lote F1): reservation search by code, holder or primary guest with «Más
// resultados»; folio of the reservation (charges with their fiscal category,
// collections, «Registrar pago» / «Devolver»); «Añadir cargo» with type and
// fiscal category; invoice drafts with fiscal categories, issuance with
// VeriFactu hash and QR, PDF, email, cancellation (with supervisor PIN when the
// separation of duties asks for it) and rectification. Cancellation and
// no-show penalties are previewed and posted from the reservation, not here.
// Routing rules live in the «Enrutamiento de folios» tab. Visible text is
// Spanish with full orthography (qa#8).

import type { CocoaHelpContent } from "../../components/cocoa-guidance/CocoaHelpButton";

export const BILLING_INSTRUCTIONS: CocoaHelpContent = {
  whatIsThis:
    "Pantalla central de facturación: folios, cobros y devoluciones de las reservas, y borradores, emisión, envío y anulación de facturas con VeriFactu. Aquí se centraliza el ciclo financiero del huésped, desde los cargos del folio hasta la factura definitiva con huella VeriFactu y código QR, conforme a la normativa de facturación electrónica.",
  howToUse: [
    "Busca la reserva escribiendo su código, el titular o el huésped principal: el buscador consulta al servidor (25 resultados por página, las llegadas más recientes primero) y «Más resultados» amplía la lista. Al elegirla verás sus cargos con su categoría fiscal, sus cobros y el saldo pendiente.",
    "Añade cargos al folio abierto con «Añadir cargo»: elige el tipo (alojamiento, desayuno, minibar, aparcamiento, ajuste…), el concepto, la cantidad y el precio bruto; la categoría fiscal se preselecciona según el tipo y puedes cambiarla. Las penalizaciones por cancelación o no-show las asienta la propia reserva al cancelarla, con la previsión visible antes de confirmar.",
    "Registra los cobros con «Registrar pago» indicando método (efectivo, tarjeta en datáfono, transferencia, enlace de pago), importe y referencia; los cobros en línea solo constan como cobrados cuando el proveedor de pagos los confirma. «Devolver» registra una devolución sobre un cobro; por encima de tu tramo pide el PIN de un supervisor.",
    "Reparte los cargos cuando lo necesites desde la pestaña «Enrutamiento de folios»: las reglas envían cada nuevo cargo al folio de la empresa pagadora o de la agencia.",
    "Emite la factura desde el borrador: la emisión asigna número de serie, congela las líneas del folio, calcula la huella VeriFactu y contabiliza el asiento. El PDF incorpora el código QR y puede enviarse por correo desde el detalle. Para anular, indica el motivo; si la separación de funciones lo exige, un supervisor presente puede autorizar la anulación con su PIN.",
  ],
  tips: [
    "Configura reglas de enrutamiento por servicio (restauración, aparcamiento, minibar) para que los cargos se dirijan al folio correcto sin intervención manual.",
    "Antes de emitir, verifica que los datos fiscales del huésped o de la empresa pagadora están completos: NIF/CIF, razón social y dirección son obligatorios para VeriFactu.",
    "Una factura emitida es inmutable: si necesitas corregirla, usa «Rectificar» desde el detalle o la pestaña «Rectificativas»; nunca edites una factura ya emitida.",
  ],
  shortcuts: [{ keys: "⌘K", action: "Buscar reservas, huéspedes y pantallas; «Registrar pago en el folio seleccionado»" }, { keys: "Esc", action: "Cerrar el panel o diálogo abierto" }],
  relatedScreens: [
    {
      screenId: "FiscalDashboard",
      label: "Cumplimiento › VeriFactu",
      href: "/cumplimiento/verifactu",
      description:
        "Estado de los envíos a VeriFactu, errores de validación y auditoría fiscal.",
    },
    {
      screenId: "FinancePositionDashboard",
      label: "Tesorería",
      href: "/finanzas/tesoreria",
      description:
        "Cobros, pagos y posición de caja; la conciliación bancaria tiene su propia pantalla.",
    },
  ],
};

export default BILLING_INSTRUCTIONS;
