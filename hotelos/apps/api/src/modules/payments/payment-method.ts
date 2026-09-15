// Payment method normalisation (finanzas · lote facturación-cobros). Pure,
// shared by payments.service and folio.service (mark-paid) without creating
// an import cycle between them.

import { BadRequestError } from "../../lib/http-error.js";
import { LEGACY_PAYMENT_METHOD_ALIASES, PAYMENT_METHODS, PSP_PAYMENT_METHODS, type PaymentMethodCode } from "../../../../../packages/shared/src/payments-types.js";

/** Legacy `Payment.method` label written next to methodCode for the existing readers. Pure. */
export function legacyMethodLabel(methodCode: PaymentMethodCode, raw?: string): string {
  if (raw === "ota_virtual_card") return raw;
  switch (methodCode) {
    case "card_terminal":
    case "card_online":
      return "card";
    default:
      return methodCode;
  }
}

/**
 * Wire method → PaymentMethod enum. Accepts the canonical values and the
 * legacy aliases ("card" → card_terminal, "ota_virtual_card" → card_terminal…);
 * anything else is a 400 with the admitted list. Pure.
 */
export function normalizePaymentMethod(raw: string | undefined | null): { methodCode: PaymentMethodCode; legacyMethod: string } {
  const value = (raw ?? "").trim().toLowerCase();
  if ((PAYMENT_METHODS as readonly string[]).includes(value)) {
    const methodCode = value as PaymentMethodCode;
    return { methodCode, legacyMethod: legacyMethodLabel(methodCode) };
  }
  const alias = LEGACY_PAYMENT_METHOD_ALIASES[value];
  if (alias) return { methodCode: alias, legacyMethod: legacyMethodLabel(alias, value) };
  throw new BadRequestError(
    `Método de cobro no válido: «${raw ?? ""}». Valores admitidos: ${PAYMENT_METHODS.join(", ")} (alias heredados: ${Object.keys(LEGACY_PAYMENT_METHOD_ALIASES).join(", ")}).`
  );
}

export function methodRequiresPsp(methodCode: PaymentMethodCode): boolean {
  return PSP_PAYMENT_METHODS.includes(methodCode);
}

/** Canonical PaymentMethod of a row: methodCode, else derived from the legacy label. Pure. */
export function methodCodeOfRow(row: { methodCode: PaymentMethodCode | null; method: string }): PaymentMethodCode {
  if (row.methodCode) return row.methodCode;
  try {
    return normalizePaymentMethod(row.method).methodCode;
  } catch {
    return "other";
  }
}
