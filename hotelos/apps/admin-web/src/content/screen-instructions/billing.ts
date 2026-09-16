// Contextual help copy for the «Facturación y cobros» screen (BillingCenterScreen).
//
// Exposes `BILLING_INSTRUCTIONS`, typed as `CocoaHelpContent`, consumed by the
// `CocoaScreenInstructionsCard` at the top of /finanzas/facturacion (title
// «Centro de facturación» lives in the screen). The card renders `whatIsThis`
// as the description, `howToUse` as the numbered steps and `tips[0]` as the
// tip callout; `shortcuts` and `relatedScreens` feed the `CocoaHelpButton`
// sheet when a screen mounts it.
//
// Every claim below describes what the screen really does today: folio of a
// reservation (charges, collections, «Cobrar» / «Devolver»), invoice drafts
// with fiscal categories, issuance with VeriFactu hash and QR, PDF, email,
// cancellation and rectification. Charges are added from the reservation and
// routing rules live in the «Enrutamiento de folios» tab. Visible text is
// Spanish with full orthography (qa#8).

import type { CocoaHelpContent } from "../../components/cocoa-guidance/CocoaHelpButton";

export const BILLING_INSTRUCTIONS: CocoaHelpContent = {
  whatIsThis:
    "Pantalla central de facturación: folios, cobros y devoluciones de las reservas, y borradores, emisión, envío y anulación de facturas con VeriFactu. Aquí se centraliza el ciclo financiero del huésped, desde los cargos del folio hasta la factura definitiva con huella VeriFactu y código QR, conforme a la normativa de facturación electrónica.",
  howToUse: [
    "Abre el folio de la reserva desde la lista de estancias o buscando por número de reserva o nombre del huésped: verás sus cargos, sus cobros y el saldo pendiente.",
    "Los cargos (alojamiento, minibar, restauración, servicios adicionales) llegan desde la reserva y del cierre del día; desde el borrador de factura puedes añadir líneas indicando concepto, cantidad, precio y categoría fiscal (tipo de IVA).",
    "Reparte los cargos cuando lo necesites desde la pestaña «Enrutamiento de folios»: las reglas envían cada nuevo cargo al folio de la empresa pagadora o de la agencia.",
    "Registra los cobros con «Cobrar» indicando método (efectivo, tarjeta en datáfono, transferencia, enlace de pago), importe y referencia; los cobros en línea solo constan como cobrados cuando el proveedor de pagos los confirma.",
    "Emite la factura desde el borrador: la emisión asigna número de serie, congela las líneas del folio, calcula la huella VeriFactu y contabiliza el asiento. El PDF incorpora el código QR y puede enviarse por correo desde el detalle.",
  ],
  tips: [
    "Configura reglas de enrutamiento por servicio (restauración, aparcamiento, minibar) para que los cargos se dirijan al folio correcto sin intervención manual.",
    "Antes de emitir, verifica que los datos fiscales del huésped o de la empresa pagadora están completos: NIF/CIF, razón social y dirección son obligatorios para VeriFactu.",
    "Una factura emitida es inmutable: si necesitas corregirla, usa «Rectificar» desde el detalle o la pestaña «Rectificativas»; nunca edites una factura ya emitida.",
  ],
  shortcuts: [{ keys: "⌘K", action: "Buscar reservas, huéspedes y pantallas" }, { keys: "Esc", action: "Cerrar el panel o diálogo abierto" }],
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
