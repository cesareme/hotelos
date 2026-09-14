// Unit tests for the invoice recipient snapshot (Tanda 3 cierre):
// Invoice.customerName resolution for folio invoices, the "name required"
// policy for F1 invoices with a NIF and the manual-draft schema field.
// Pure-core only: no database. Run from apps/api with
//   node --import tsx --test src/modules/invoicing/__tests__/recipient.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RECIPIENT_NAME_REQUIRED_CODE,
  RECIPIENT_NAME_REQUIRED_MESSAGE,
  guestFullName,
  recipientNameMissingError,
  recipientNameRequired,
  resolveFolioCustomerName
} from "../invoice.service.js";
import { CreateInvoiceDraftSchema } from "../invoicing.service.js";
import { BadRequestError } from "../../../lib/http-error.js";

describe("guestFullName", () => {
  it("joins first name and surnames, skipping blank parts", () => {
    assert.equal(guestFullName({ firstName: "María", surname1: "Pérez", surname2: "García" }), "María Pérez García");
    assert.equal(guestFullName({ firstName: " John ", surname1: "Smith", surname2: null }), "John Smith");
    assert.equal(guestFullName({ firstName: "Solo", surname1: "  ", surname2: undefined }), "Solo");
  });

  it("is null for a missing guest or a guest without a usable name", () => {
    assert.equal(guestFullName(null), null);
    assert.equal(guestFullName(undefined), null);
    assert.equal(guestFullName({ firstName: "  ", surname1: null, surname2: null }), null);
  });
});

describe("resolveFolioCustomerName — recipient snapshot for a folio invoice", () => {
  const reservation = { companyName: "Acme SL", travelAgentName: "Viajes Sol", bookerName: "Ana Booker" };

  it("an explicit customerName wins for every customer type", () => {
    for (const customerType of ["guest", "company", "agency"] as const) {
      assert.equal(resolveFolioCustomerName({ customerType, explicit: "  Nombre Explícito  ", reservation, guestName: "Huésped" }), "Nombre Explícito");
    }
  });

  it("guest: primary guest's full name, else the booker", () => {
    assert.equal(resolveFolioCustomerName({ customerType: "guest", reservation, guestName: "María Pérez" }), "María Pérez");
    assert.equal(resolveFolioCustomerName({ customerType: "guest", reservation, guestName: null }), "Ana Booker");
    assert.equal(resolveFolioCustomerName({ customerType: "guest", reservation: {}, guestName: null }), null);
  });

  it("company: the reservation's razón social only — never a person's name in its place", () => {
    assert.equal(resolveFolioCustomerName({ customerType: "company", reservation, guestName: "María Pérez" }), "Acme SL");
    assert.equal(resolveFolioCustomerName({ customerType: "company", reservation: { companyName: "  ", bookerName: "Ana Booker" }, guestName: "María Pérez" }), null);
  });

  it("agency: the travel agent, else the booker", () => {
    assert.equal(resolveFolioCustomerName({ customerType: "agency", reservation, guestName: "María Pérez" }), "Viajes Sol");
    assert.equal(resolveFolioCustomerName({ customerType: "agency", reservation: { bookerName: "Ana Booker" }, guestName: "María Pérez" }), "Ana Booker");
    assert.equal(resolveFolioCustomerName({ customerType: "agency", reservation: {}, guestName: "María Pérez" }), null);
  });
});

describe("recipientNameRequired — F1 with a NIF needs the Destinatarios name", () => {
  it("true only for a full invoice (F1/F3) with a NIF and no name", () => {
    assert.equal(recipientNameRequired("F1", "12345678Z", null), true);
    assert.equal(recipientNameRequired("F1", "12345678Z", "   "), true);
    assert.equal(recipientNameRequired("F3", "A58818501", undefined), true);
  });

  it("false with a name, without a NIF, or for simplified / rectifying invoices", () => {
    assert.equal(recipientNameRequired("F1", "12345678Z", "María Pérez"), false);
    assert.equal(recipientNameRequired("F1", null, null), false);
    assert.equal(recipientNameRequired("F1", "  ", null), false);
    assert.equal(recipientNameRequired("F2", "12345678Z", null), false);
    assert.equal(recipientNameRequired("R1", "12345678Z", null), false);
    assert.equal(recipientNameRequired("R4", "12345678Z", null), false);
  });
});

describe("recipientNameMissingError", () => {
  it("is a 400 with the exact message and a machine-readable code", () => {
    const error = recipientNameMissingError();
    assert.ok(error instanceof BadRequestError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.message, RECIPIENT_NAME_REQUIRED_MESSAGE);
    assert.equal(error.message, "Indica el nombre o razón social del destinatario");
    assert.deepEqual((error.details as { code: string }).code, RECIPIENT_NAME_REQUIRED_CODE);
  });
});

describe("CreateInvoiceDraftSchema — customerName", () => {
  const base = { propertyId: "prop_123", total: 110, taxTotal: 10 };

  it("accepts customerName alongside customerTaxId and keeps it as sent", () => {
    const parsed = CreateInvoiceDraftSchema.parse({ ...base, customerTaxId: "12345678Z", customerName: "María Pérez" });
    assert.equal(parsed.customerName, "María Pérez");
    assert.equal(parsed.customerTaxId, "12345678Z");
  });

  it("stays optional (the service enforces it for F1 + NIF) and is capped at 500 characters", () => {
    assert.equal(CreateInvoiceDraftSchema.parse(base).customerName, undefined);
    assert.equal(CreateInvoiceDraftSchema.safeParse({ ...base, customerName: "x".repeat(501) }).success, false);
  });
});
