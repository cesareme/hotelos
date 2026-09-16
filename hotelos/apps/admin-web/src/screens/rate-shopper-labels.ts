// Spanish labels of the wire codes of the competitor set (/revenue/competencia;
// Cocoa 22 · ola 5 · lote 5-C · qa#18). The API stores the competitor category
// as typed or seeded («urban»), stamps the rates of the internal survey «demo»
// (rate-shop.service.ts) and their availability «available»; none of it reaches
// the hotelier raw (rule C19). The cell keeps the raw code in `title` when it
// differs from the label, so support can still read the stored value. Pure
// module (no API client) so the regression test renders the cells in node.

import { createElement, type ReactElement } from "react";
import { channelLabel } from "../lib/format";

/** Parity alert types of the API (rate-shop, parity-monitor); an unknown type is painted as it arrives. */
export const ALERT_TYPE_ES: Record<string, string> = {
  ota_cheaper_than_direct: "OTA más barata que el directo",
  direct_missing: "Sin tarifa directa",
  tax_fee_mismatch: "Impuestos o tasas distintos",
  currency_mismatch: "Divisa distinta",
  package_mismatch: "Paquete distinto",
  channel_gap: "Diferencia con el canal",
  channel_sync_failed: "Sincronización del canal fallida"
};

// Where a shopped rate comes from: the internal survey stamps «demo», a rate
// typed by hand «manual»; any other code is a distribution channel.
const SHOP_SOURCE_ES: Record<string, string> = { demo: "Sondeo interno", manual: "Registro manual" };

/** shopSourceLabel("demo") → "Sondeo interno" · "booking_com" → "Booking.com" · null → "—". */
export function shopSourceLabel(code: string | null | undefined): string {
  const key = typeof code === "string" ? code.trim().toLowerCase() : "";
  return SHOP_SOURCE_ES[key] ?? channelLabel(code);
}

/** Head of a parity alert: its channel in Spanish, or the alert type when the alert has no channel. */
export function alertHeadLabel(sourceChannel: string | null | undefined, alertType: string): string {
  return sourceChannel ? channelLabel(sourceChannel) : ALERT_TYPE_ES[alertType] ?? alertType;
}

/** The raw code for `title`, only when the label does not already show it (a typed «4*» gets no tooltip). */
export function codeTitle(code: string | null | undefined, label: string): string | undefined {
  return code && code !== label ? code : undefined;
}

/** A cell that reads a wire code in Spanish and keeps the raw code in `title` when it differs. */
export function CodeCell({ code, label }: { code: string | null | undefined; label: string }): ReactElement {
  return createElement("span", { title: codeTitle(code, label) }, label);
}
