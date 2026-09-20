// Unit tests · Tanda CHK · lote W5-A — pago o garantía del pre-check-in
// (modules/checkin/checkin-payment.service.ts): importes por depositPolicy
// (balance / first_night / fixed / none), modo por PSP (sin PSP →
// at_reception; PSP sin extensión → link; PSP con authorize configurado →
// authorize solo si la política exige depósito), estados ya cumplidos y los
// helpers puros de la evidencia (identificador enmascarado, titular, guardia
// anti-PAN). Sin base de datos: resolveGuestPayment recibe el adaptador
// (null | sin extensión | sandbox). Desde apps/api:
//   node --import tsx --test src/modules/checkin/__tests__/checkin-payment.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PspAdapter } from "../../payments/psp/psp.types.js";
import { createRedsysSandbox } from "../../payments/psp/redsys.adapter.js";
import { createStripeSandbox } from "../../payments/psp/stripe.adapter.js";
import {
  assertCardTokenSafe,
  captureWindowDaysFor,
  GUEST_PAYMENT_SETTLED_STATUSES,
  guestPaymentAmount,
  paymentHolderName,
  paymentMethodIdentifier,
  reservationNights,
  resolveGuestPayment
} from "../checkin-payment.service.js";

const RESERVATION = { code: "CHK-W5A", totalAmount: "300.00", arrivalDate: new Date("2026-10-02T00:00:00.000Z"), departureDate: new Date("2026-10-05T00:00:00.000Z"), currency: "EUR" };
const FOLIO = { folio: { id: "folio_w5a", currency: "EUR" }, balanceDue: 300, paymentsTotal: 0, reservationBalanceDue: 300 };
const SESSION = { propertyId: "prop_w5a", paymentStatus: "none" };

const linkOnly: PspAdapter = {
  provider: "stripe",
  status: () => ({ configured: true, provider: "stripe", mode: "test", webhookSecretConfigured: true, message: "fake sin preautorización" }),
  async createPaymentLink() {
    return { providerReference: "cs_1", redirect: { method: "GET", url: "https://x" }, expiresAt: null };
  },
  async capture(ref) {
    return { status: "pending", providerReference: ref, capturedAt: null, error: null };
  },
  async refund(input) {
    return { status: "refunded", providerReference: input.idempotencyKey, error: null };
  },
  verifyWebhook() {
    return { ok: false, reason: "fake" };
  }
};

describe("W5-A · guestPaymentAmount: balance / first_night / fixed calculan el importe", () => {
  it("balance = saldo del folio (cobrable y garantía iguales)", () => {
    const amount = guestPaymentAmount({ policy: { depositPolicy: "balance", depositAmount: null }, folio: FOLIO, reservation: RESERVATION });
    assert.deepEqual(amount, { basis: "balance", required: 300, paid: 0, balanceDue: 300, nights: 3, collectable: 300, guarantee: 300 });
    const partly = guestPaymentAmount({ policy: { depositPolicy: "balance", depositAmount: null }, folio: { ...FOLIO, balanceDue: 120.5, paymentsTotal: 179.5 }, reservation: RESERVATION });
    assert.equal(partly.collectable, 120.5);
    assert.equal(partly.guarantee, 120.5);
  });

  it("first_night = total / noches, descontando lo ya pagado y sin superar el saldo cobrable", () => {
    const amount = guestPaymentAmount({ policy: { depositPolicy: "first_night", depositAmount: null }, folio: FOLIO, reservation: RESERVATION });
    assert.equal(amount.nights, 3);
    assert.equal(amount.required, 100);
    assert.equal(amount.collectable, 100);
    assert.equal(amount.guarantee, 100);
    const paid = guestPaymentAmount({ policy: { depositPolicy: "first_night", depositAmount: null }, folio: { ...FOLIO, balanceDue: 260, paymentsTotal: 40 }, reservation: RESERVATION });
    assert.equal(paid.collectable, 60, "100 − 40 pagados");
    assert.equal(paid.guarantee, 60);
    const noLines = guestPaymentAmount({ policy: { depositPolicy: "first_night", depositAmount: null }, folio: { ...FOLIO, balanceDue: 0 }, reservation: RESERVATION });
    assert.equal(noLines.collectable, 0, "sin cargos no hay nada que cobrar por enlace");
    assert.equal(noLines.guarantee, 100, "pero la garantía de la primera noche sigue siendo 100");
    const oneNight = guestPaymentAmount({ policy: { depositPolicy: "first_night", depositAmount: null }, folio: FOLIO, reservation: { ...RESERVATION, totalAmount: 199.99, departureDate: "2026-10-03" } });
    assert.equal(oneNight.required, 199.99);
    assert.equal(guestPaymentAmount({ policy: { depositPolicy: "first_night", depositAmount: null }, folio: FOLIO, reservation: { ...RESERVATION, totalAmount: "100.00", departureDate: RESERVATION.arrivalDate } }).nights, 1, "misma fecha → 1 noche");
  });

  it("fixed = depositAmount de la política; none no exige nada (el saldo queda como cobro opcional)", () => {
    const fixed = guestPaymentAmount({ policy: { depositPolicy: "fixed", depositAmount: "150.00" }, folio: FOLIO, reservation: RESERVATION });
    assert.equal(fixed.required, 150);
    assert.equal(fixed.collectable, 150);
    assert.equal(fixed.guarantee, 150);
    const capped = guestPaymentAmount({ policy: { depositPolicy: "fixed", depositAmount: "500.00" }, folio: FOLIO, reservation: RESERVATION });
    assert.equal(capped.collectable, 300, "no se cobra por enlace más que el saldo");
    assert.equal(capped.guarantee, 500, "la garantía es el importe fijo");
    const none = guestPaymentAmount({ policy: { depositPolicy: "none", depositAmount: null }, folio: FOLIO, reservation: RESERVATION });
    assert.deepEqual({ required: none.required, collectable: none.collectable, guarantee: none.guarantee }, { required: 0, collectable: 300, guarantee: 0 });
    const noFolio = guestPaymentAmount({ policy: { depositPolicy: "fixed", depositAmount: "50.00" }, folio: null, reservation: null });
    assert.deepEqual({ collectable: noFolio.collectable, guarantee: noFolio.guarantee, nights: noFolio.nights }, { collectable: 0, guarantee: 50, nights: 1 });
    assert.equal(reservationNights({ arrivalDate: "2026-12-31", departureDate: "2027-01-02" }), 2);
  });
});

describe("W5-A · resolveGuestPayment: modo según PSP y política", () => {
  it("sin PSP → at_reception con el importe cobrable; sin saldo → none", async () => {
    const result = await resolveGuestPayment({ session: SESSION, policy: { depositPolicy: "first_night", depositAmount: null }, folio: FOLIO, reservation: RESERVATION, adapter: null });
    assert.equal(result.mode, "at_reception");
    assert.equal(result.amount, 100);
    assert.equal(result.currency, "EUR");
    assert.equal(result.required, true);
    assert.equal(result.reason, "psp_not_configured");
    assert.equal(result.provider, null);
    const settled = await resolveGuestPayment({ session: SESSION, policy: { depositPolicy: "balance", depositAmount: null }, folio: { ...FOLIO, balanceDue: 0, paymentsTotal: 300 }, reservation: RESERVATION, adapter: null });
    assert.deepEqual({ mode: settled.mode, amount: settled.amount, reason: settled.reason }, { mode: "none", amount: 0, reason: "nothing_due" });
  });

  it("PSP sin la extensión de preautorización → link (aunque la política exija depósito)", async () => {
    const result = await resolveGuestPayment({ session: SESSION, policy: { depositPolicy: "fixed", depositAmount: "80.00" }, folio: FOLIO, reservation: RESERVATION, adapter: linkOnly });
    assert.equal(result.mode, "link");
    assert.equal(result.amount, 80);
    assert.equal(result.provider, "stripe");
    assert.equal(result.reason, "psp_without_authorization");
  });

  it("con authorize configurado → authorize por la garantía; con depositPolicy none → link opcional; sin credenciales → link", async () => {
    const stripe = createStripeSandbox().adapter;
    const authorize = await resolveGuestPayment({ session: SESSION, policy: { depositPolicy: "first_night", depositAmount: null }, folio: { ...FOLIO, balanceDue: 0 }, reservation: RESERVATION, adapter: stripe });
    assert.equal(authorize.mode, "authorize");
    assert.equal(authorize.amount, 100, "la garantía no depende de los cargos ya contabilizados");
    assert.equal(authorize.reason, "deposit_policy");
    assert.equal(authorize.provider, "stripe");
    const redsys = await resolveGuestPayment({ session: SESSION, policy: { depositPolicy: "balance", depositAmount: null }, folio: FOLIO, reservation: RESERVATION, adapter: createRedsysSandbox().adapter });
    assert.deepEqual({ mode: redsys.mode, amount: redsys.amount, provider: redsys.provider }, { mode: "authorize", amount: 300, provider: "redsys" });
    const optional = await resolveGuestPayment({ session: SESSION, policy: { depositPolicy: "none", depositAmount: null }, folio: FOLIO, reservation: RESERVATION, adapter: stripe });
    assert.deepEqual({ mode: optional.mode, amount: optional.amount, required: optional.required, reason: optional.reason }, { mode: "link", amount: 300, required: false, reason: "balance_due" });
    const unconfigured = await resolveGuestPayment({ session: SESSION, policy: { depositPolicy: "balance", depositAmount: null }, folio: FOLIO, reservation: RESERVATION, adapter: { ...stripe, status: () => ({ configured: false, provider: "stripe", mode: null, webhookSecretConfigured: false, message: "sin clave" }) } as PspAdapter });
    assert.equal(unconfigured.mode, "link", "la extensión sin credenciales no cuenta como authorize");
  });

  it("paid / authorized ya cumplidos → none; at_reception y link_sent se recalculan", async () => {
    assert.deepEqual([...GUEST_PAYMENT_SETTLED_STATUSES], ["paid", "authorized"]);
    for (const paymentStatus of GUEST_PAYMENT_SETTLED_STATUSES) {
      const result = await resolveGuestPayment({ session: { ...SESSION, paymentStatus }, policy: { depositPolicy: "balance", depositAmount: null }, folio: FOLIO, reservation: RESERVATION, adapter: createStripeSandbox().adapter });
      assert.deepEqual({ mode: result.mode, amount: result.amount, reason: result.reason }, { mode: "none", amount: 0, reason: "already_settled" });
    }
    const again = await resolveGuestPayment({ session: { ...SESSION, paymentStatus: "at_reception" }, policy: { depositPolicy: "balance", depositAmount: null }, folio: FOLIO, reservation: RESERVATION, adapter: createStripeSandbox().adapter });
    assert.equal(again.mode, "authorize", "si aparece un PSP después, se vuelve a ofrecer la garantía");
  });

  it("captureWindowDaysFor: hasta la salida + 1 acotado a [7, 30]", () => {
    const now = new Date("2026-10-01T12:00:00.000Z");
    assert.equal(captureWindowDaysFor(RESERVATION, now), 7, "salida a 4 días → mínimo 7");
    assert.equal(captureWindowDaysFor({ ...RESERVATION, departureDate: "2026-10-20" }, now), 20);
    assert.equal(captureWindowDaysFor({ ...RESERVATION, departureDate: "2026-12-20" }, now), 30);
    assert.equal(captureWindowDaysFor(null, now), 7);
  });
});

describe("W5-A · evidencia: helpers puros sin PAN", () => {
  it("paymentMethodIdentifier y paymentHolderName", () => {
    assert.equal(paymentMethodIdentifier({ brand: "Visa", last4: "4242" }), "visa ****4242");
    assert.equal(paymentHolderName({ firstName: "Ana", surname1: "Gamma", surname2: null }), "Ana Gamma");
    assert.equal(paymentHolderName({ firstName: " ", surname1: "", surname2: undefined }), null);
  });

  it("assertCardTokenSafe rechaza un PAN como token o últimos 4 y exige exactamente 4 dígitos", () => {
    assert.doesNotThrow(() => assertCardTokenSafe({ tokenRef: "pm_1", last4: "4242", brand: "visa", expiryMonth: 1, expiryYear: 2030 }));
    assert.throws(() => assertCardTokenSafe({ tokenRef: "4242424242424242", last4: "4242", brand: "visa", expiryMonth: 1, expiryYear: 2030 }), /PAN_NOT_ACCEPTED/);
    assert.throws(() => assertCardTokenSafe({ tokenRef: "pm_1", last4: "4242 4242 4242 4242", brand: "visa", expiryMonth: 1, expiryYear: 2030 }), /PAN_NOT_ACCEPTED/);
    assert.throws(() => assertCardTokenSafe({ tokenRef: "pm_1", last4: "42", brand: "visa", expiryMonth: 1, expiryYear: 2030 }), /4 dígitos/);
    assert.throws(() => assertCardTokenSafe({ tokenRef: " ", last4: "4242", brand: "visa", expiryMonth: 1, expiryYear: 2030 }), /vacío/);
  });
});
