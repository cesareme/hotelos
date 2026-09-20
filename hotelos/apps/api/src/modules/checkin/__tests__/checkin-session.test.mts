// Unit tests · Tanda CHK · lote W2-A — funciones puras de la sesión de
// pre-llegada (checkin-session.service.ts): recuento de viajeros hasta
// adults+children, edad/menor, filtrado de preferencias, cálculo de `missing`,
// estado del viajero, consentimientos fechados, canal de invitación y pasos.
// Sin base de datos, sin red; datos ficticios. Desde apps/api:
//   node --import tsx --test src/modules/checkin/__tests__/checkin-session.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ageAtArrival,
  applyConsent,
  buildSteps,
  deriveGuestStatus,
  filterPreferences,
  handoffReasonFor,
  handoffTicketFor,
  isMinorAge,
  maskRecipient,
  mergeConsentJson,
  missingTravellerFields,
  paymentTypeForSession,
  pickInvitationChannel,
  planTravellerSlots,
  spainInputFromTraveller,
  toAlpha3,
  travellerCapacity,
  type TravellerFields
} from "../checkin-session.service.js";

const ARRIVAL = "2026-09-20";

const ADULT: TravellerFields = {
  firstName: "Ana",
  surname1: "Gamma",
  sex: "M",
  nationality: "ESP",
  dateOfBirth: "1990-04-12",
  documentType: "DNI",
  documentNumber: "CHK000001",
  documentSupportNumber: "AAA000001",
  residenceFullAddress: "Rúa da Proba 1",
  residenceLocality: "A Coruña",
  residenceCountry: "ESP",
  phoneMobile: "+34600000001",
  email: "huesped.01@chk.test",
  isMinor: false,
  ageAtArrival: 36
};

describe("viajeros hasta adults + children", () => {
  it("travellerCapacity = adultos + niños, mínimo 1 (los bebés no cuentan)", () => {
    assert.equal(travellerCapacity({ adults: 2, children: 1 }), 3);
    assert.equal(travellerCapacity({ adults: 0, children: 0 }), 1);
  });

  it("planTravellerSlots: titular primero + huecos pending hasta la capacidad", () => {
    const slots = planTravellerSlots({
      adults: 2,
      children: 1,
      linked: [
        { guestId: "g_acomp", isPrimary: false, relationshipType: "hijo" },
        { guestId: "g_titular", isPrimary: true, relationshipType: null }
      ]
    });
    assert.equal(slots.length, 3);
    assert.deepEqual(slots[0], { guestId: "g_titular", isPrimary: true, relationshipType: null });
    assert.deepEqual(slots[1], { guestId: "g_acomp", isPrimary: false, relationshipType: "hijo" });
    assert.deepEqual(slots[2], { guestId: null, isPrimary: false, relationshipType: null });
  });

  it("sin ningún enlace marcado, el primero actúa de titular; sin enlaces el hueco 0 es titular", () => {
    const slots = planTravellerSlots({ adults: 1, children: 0, linked: [{ guestId: "g_a", isPrimary: false, relationshipType: null }, { guestId: "g_b", isPrimary: false, relationshipType: null }] });
    assert.equal(slots.length, 2, "nunca recorta un enlace real aunque supere adults+children");
    assert.equal(slots[0]!.isPrimary, true);
    assert.equal(slots[1]!.isPrimary, false);
    const empty = planTravellerSlots({ adults: 2, children: 0, linked: [] });
    assert.deepEqual(empty.map((slot) => slot.isPrimary), [true, false]);
  });
});

describe("edad a la llegada y menor de 14", () => {
  it("cuenta años cumplidos a la fecha de llegada (UTC)", () => {
    assert.equal(ageAtArrival("2017-05-01", ARRIVAL), 9);
    assert.equal(ageAtArrival("2012-09-21", ARRIVAL), 13);
    assert.equal(ageAtArrival("2012-09-20", ARRIVAL), 14);
    assert.equal(ageAtArrival(new Date("1990-04-12T00:00:00.000Z"), new Date(`${ARRIVAL}T00:00:00.000Z`)), 36);
    assert.equal(ageAtArrival(null, ARRIVAL), null);
    assert.equal(ageAtArrival("no-es-fecha", ARRIVAL), null);
  });

  it("isMinorAge: < 14 es menor; sin edad no se asume menor", () => {
    assert.equal(isMinorAge(13), true);
    assert.equal(isMinorAge(14), false);
    assert.equal(isMinorAge(null), false);
    assert.equal(isMinorAge(undefined), false);
  });
});

describe("filtrado de preferencias por el vocabulario cerrado", () => {
  it("acepta solo PREFERENCE_VOCABULARY, sin duplicados ni mayúsculas; separa el texto libre", () => {
    assert.deepEqual(filterPreferences(["quiet", "QUIET", "vista_mar", "floor_high", 42]), { codes: ["quiet", "floor_high"], freeText: null });
    assert.deepEqual(filterPreferences({ codes: ["crib", "crib", "bed_twin"], freeText: "  almohada extra  " }), { codes: ["crib", "bed_twin"], freeText: "almohada extra" });
    assert.deepEqual(filterPreferences({ freeText: "" }), { codes: [], freeText: null });
    assert.deepEqual(filterPreferences("quiet"), { codes: [], freeText: null });
    assert.deepEqual(filterPreferences(null), { codes: [], freeText: null });
  });
});

describe("cálculo de `missing` (validador SES sin la firma)", () => {
  it("un adulto con todos los datos no tiene faltas", () => {
    assert.deepEqual(missingTravellerFields(ADULT), []);
  });

  it("DNI/TIE exigen soporte; sin teléfono falta el contacto; nunca pide la firma", () => {
    assert.deepEqual(missingTravellerFields({ ...ADULT, documentSupportNumber: null }), ["documentSupportNumber"]);
    assert.deepEqual(missingTravellerFields({ ...ADULT, documentType: "PASSPORT", documentSupportNumber: null }), []);
    assert.deepEqual(missingTravellerFields({ ...ADULT, phoneMobile: null }), ["phoneMobile"]);
    const empty = missingTravellerFields({});
    assert.ok(empty.includes("firstName") && empty.includes("surname1") && empty.includes("documentNumber") && empty.includes("residenceFullAddress"));
    assert.ok(!empty.includes("signedAt") && !empty.includes("signature_required"), "la firma es del paso 5, no de la completitud");
    assert.ok(!empty.includes("contractReference") && !empty.includes("checkinAt"), "el contrato y el check-in los pone el servicio");
  });

  it("un menor de 14 exige el adulto que aporta los datos y el parentesco, sin firma", () => {
    const minor: TravellerFields = { ...ADULT, dateOfBirth: "2017-05-01", ageAtArrival: 9, isMinor: true, documentType: "PASSPORT", documentSupportNumber: null, providedByAdultGuestId: null, kinship: null };
    const missing = missingTravellerFields(minor);
    assert.deepEqual(missing, ["providedByAdultGuestId", "kinshipRelationIfMinor"]);
    assert.deepEqual(missingTravellerFields({ ...minor, providedByAdultGuestId: "g_titular", kinship: "hijo" }), []);
    const input = spainInputFromTraveller({ ...minor, providedByAdultGuestId: "g_titular", kinship: "hijo" });
    assert.equal(input.signatureRequired, false);
    assert.equal(input.isMinor, true);
    assert.equal(input.idImageDiscarded, true, "la imagen nunca se guarda");
  });

  it("spainInputFromTraveller convierte fechas a YYYY-MM-DD y omite vacíos", () => {
    const input = spainInputFromTraveller({ ...ADULT, dateOfBirth: new Date("1990-04-12T00:00:00.000Z"), surname2: "" });
    assert.equal(input.dateOfBirth, "1990-04-12");
    assert.equal(input.surname2, undefined);
    assert.equal(input.travellerCount, 1);
    assert.equal(input.signatureRequired, true);
  });
});

describe("estado del viajero", () => {
  it("signed/verified nunca retroceden; sin faltas data_complete; con documento document_captured; si no pending", () => {
    assert.equal(deriveGuestStatus("signed", ["phoneMobile"], true), "signed");
    assert.equal(deriveGuestStatus("verified", [], false), "verified");
    assert.equal(deriveGuestStatus("pending", [], false), "data_complete");
    assert.equal(deriveGuestStatus("pending", ["phoneMobile"], true), "document_captured");
    assert.equal(deriveGuestStatus("data_complete", ["phoneMobile"], false), "pending");
  });
});

describe("consentimientos fechados", () => {
  it("true fija la fecha una sola vez, false la retira, undefined conserva", () => {
    const now = "2026-09-19T10:00:00.000Z";
    const first = applyConsent({ gdprAt: null, aiDisclosureAt: null, marketing: false, whatsappOptInAt: null }, { gdpr: true, whatsappOptIn: true }, now);
    assert.deepEqual(first, { gdprAt: now, aiDisclosureAt: null, marketing: false, whatsappOptInAt: now });
    const later = applyConsent(first, { gdpr: true, marketing: true, whatsappOptIn: false }, "2026-09-20T10:00:00.000Z");
    assert.equal(later.gdprAt, now, "la fecha original se conserva");
    assert.equal(later.marketing, true);
    assert.equal(later.whatsappOptInAt, null);
  });
});

describe("canal de invitación y enmascarado", () => {
  it("respeta el canal pedido si hay destinatario y consentimiento; si no, email → whatsapp → sms", () => {
    assert.deepEqual(pickInvitationChannel({ requested: "email", email: "a@chk.test", mobile: "+34600000001", whatsappOptIn: false }), { channel: "email", recipient: "a@chk.test" });
    assert.deepEqual(pickInvitationChannel({ requested: "whatsapp", email: "a@chk.test", mobile: "+34600000001", whatsappOptIn: false }), { channel: "email", recipient: "a@chk.test" });
    assert.deepEqual(pickInvitationChannel({ requested: "whatsapp", email: null, mobile: "+34600000001", whatsappOptIn: true }), { channel: "whatsapp", recipient: "+34600000001" });
    assert.deepEqual(pickInvitationChannel({ requested: "whatsapp", email: null, mobile: "+34600000001", whatsappOptIn: false }), { channel: "sms", recipient: "+34600000001" });
    assert.equal(pickInvitationChannel({ requested: "sms", email: null, mobile: null, whatsappOptIn: true }), null);
  });

  it("maskRecipient nunca devuelve el correo ni el teléfono completos", () => {
    assert.equal(maskRecipient("huesped.01@chk.test"), "h***@chk.test");
    assert.equal(maskRecipient("+34600000123"), "***123");
    assert.equal(maskRecipient("12"), "***");
  });
});

describe("pasos del portal", () => {
  const guest = (overrides: Record<string, unknown>) =>
    ({ firstName: "Ana", documentNumber: "X", status: "data_complete", isMinor: false, ...overrides }) as never;

  it("marca hecho lo completado, opcional lo no obligatorio y not_required la firma si todos son menores", () => {
    const steps = buildSteps({ status: "ready_for_arrival", etaDeclared: "16:30", preferences: [], paymentStatus: "none" }, [guest({}), guest({ isMinor: true })]);
    const byKey = Object.fromEntries(steps.map((step) => [step.key, step.status]));
    assert.equal(byKey.travellers, "done");
    assert.equal(byKey.identity, "done");
    assert.equal(byKey.details, "done");
    assert.equal(byKey.preferences, "done");
    assert.equal(byKey.signature, "pending", "el adulto aún no ha firmado");
    assert.equal(byKey.payment, "optional");
    assert.equal(byKey.complete, "done");
    const minorsOnly = buildSteps({ status: "invited", etaDeclared: null, preferences: [], paymentStatus: "link_sent" }, [guest({ isMinor: true, firstName: null, documentNumber: null, status: "pending" })]);
    const minorsByKey = Object.fromEntries(minorsOnly.map((step) => [step.key, step.status]));
    assert.equal(minorsByKey.signature, "not_required");
    assert.equal(minorsByKey.travellers, "pending");
    assert.equal(minorsByKey.payment, "pending");
    assert.equal(minorsByKey.complete, "pending");
  });
});

// Corrector Tanda CHK (REV3-06, REV3-08, REV3-15): menores sin documento ni teléfono propio,
// consentimientos que no pisan el OTP pendiente y códigos de país en alfa-3.
describe("corrector CHK · menores, consentimientos y códigos de país", () => {
  it("REV3-06: un menor de 14 declarado por un adulto no necesita documento ni teléfono propios (escenario CHK-02); un adulto sí", () => {
    const minor: TravellerFields = { firstName: "Leo", surname1: "Gamma", sex: "H", nationality: "ESP", dateOfBirth: "2017-03-01", residenceFullAddress: "Rúa da Proba 1", residenceLocality: "A Coruña", residenceCountry: "ESP", isMinor: true, ageAtArrival: 9, providedByAdultGuestId: "gst_adult", kinship: "hijo" };
    assert.deepEqual(missingTravellerFields(minor), []);
    assert.deepEqual(missingTravellerFields({ ...minor, providedByAdultGuestId: null }), ["providedByAdultGuestId"]);
    const adult = missingTravellerFields({ ...minor, isMinor: false, ageAtArrival: 40, dateOfBirth: "1986-03-01", providedByAdultGuestId: null, kinship: null });
    assert.deepEqual(adult.sort(), ["documentNumber", "documentType", "phoneMobile"]);
  });

  it("REV3-08: mergeConsentJson conserva las claves ajenas al consentimiento (el OTP pendiente) y sustituye las cuatro del consentimiento", () => {
    const otp = { channel: "email", hash: "abc", requestedAt: "2026-09-20T10:00:00.000Z", expiresAt: "2026-09-20T10:10:00.000Z", attempts: 0, recipient: "h***@chk.test" };
    const merged = mergeConsentJson({ gdprAt: "2026-09-19T00:00:00.000Z", marketing: false, otp }, { gdprAt: "2026-09-19T00:00:00.000Z", aiDisclosureAt: null, marketing: true, whatsappOptInAt: null });
    assert.deepEqual(merged, { gdprAt: "2026-09-19T00:00:00.000Z", aiDisclosureAt: null, marketing: true, whatsappOptInAt: null, otp });
    assert.deepEqual(mergeConsentJson(null, { gdprAt: null, aiDisclosureAt: null, marketing: false, whatsappOptInAt: null }), { gdprAt: null, aiDisclosureAt: null, marketing: false, whatsappOptInAt: null });
    assert.deepEqual(mergeConsentJson([1, 2], { gdprAt: null, aiDisclosureAt: null, marketing: false, whatsappOptInAt: null }).otp, undefined);
  });

  it("REV3-15: toAlpha3 normaliza ES → ESP (y deja alfa-3 o desconocidos en mayúsculas); el parte va en alfa-3 y con paymentType según el pago", () => {
    assert.equal(toAlpha3("ES"), "ESP");
    assert.equal(toAlpha3("es"), "ESP");
    assert.equal(toAlpha3("gb"), "GBR");
    assert.equal(toAlpha3("ESP"), "ESP");
    assert.equal(toAlpha3("XX"), "XX");
    assert.equal(toAlpha3(""), undefined);
    assert.equal(toAlpha3(null), undefined);
    const input = spainInputFromTraveller({ ...ADULT, nationality: "ES", residenceCountry: "fr" });
    assert.equal(input.nationality, "ESP");
    assert.equal(input.residenceCountry, "FRA");
    assert.equal(paymentTypeForSession("paid"), "card");
    assert.equal(paymentTypeForSession("authorized"), "card");
    assert.equal(paymentTypeForSession("link_sent"), "card");
    assert.equal(paymentTypeForSession("at_reception"), undefined);
    assert.equal(paymentTypeForSession("none"), undefined);
  });
});

describe("corrector L7-REV-05 · ticket de derivación del servidor", () => {
  it("handoffTicketFor: K-dddd determinista por sesión (mismo id → mismo ticket; ids distintos → distinto) y sin depender del minuto", () => {
    const a = handoffTicketFor("cis_l7_1");
    assert.match(a, /^K-\d{4}$/);
    assert.equal(handoffTicketFor("cis_l7_1"), a);
    assert.notEqual(handoffTicketFor("cis_l7_2"), a);
    assert.equal(handoffTicketFor("cis_l7_1x").length, 6);
  });

  it("handoffReasonFor: texto que lee recepción con el ticket", () => {
    assert.equal(handoffReasonFor("signature", "K-0042"), "Firma en recepción · ticket K-0042");
  });
});
