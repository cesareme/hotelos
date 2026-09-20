// Tanda CHK · lote W4-C — máquina de estados del asistente de pre-check-in
// (checkin/wizard.ts) y modo kiosco (kiosk/kiosk-mode.ts). Módulos puros:
// node --import ../api/node_modules/tsx/dist/loader.mjs --test "src/**/__tests__/*.test.mts"
// (script `test` de apps/guest-web/package.json). Sin React ni DOM.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COPY,
  MAX_DOCUMENT_BYTES,
  MINOR_AGE,
  WIZARD_STEPS,
  adultsFor,
  ageAt,
  canAddGuest,
  canAdvance,
  dataUrlByteSize,
  describeArrivalError,
  earliestCheckInDay,
  formatDocumentHint,
  guestLabel,
  initialStep,
  isImageDataUrl,
  isMinorAt,
  looksLikeMrz,
  mergeMissing,
  missingFor,
  mrzFormatOf,
  needsOtp,
  nextStep,
  normalizeMrzText,
  otpChannelsFor,
  paymentSettled,
  pendingSigners,
  pickLanguage,
  prevStep,
  progressFor,
  sessionStatusLabel,
  sourceLabel,
  stepLabel,
  t,
  togglePreference,
  type WizardGuest,
  type WizardSession
} from "../wizard.ts";
import {
  GUEST_ARRIVAL_STORAGE_KEY,
  GUEST_SESSION_STORAGE_KEY,
  IDLE_TIMEOUT_MS,
  IDLE_WARNING_MS,
  KIOSK_STORAGE_KEY,
  clearKioskDevice,
  createIdleTimer,
  handoffTicket,
  idleTimeoutMs,
  parseKioskParams,
  readKioskDevice,
  resetSession,
  writeKioskDevice,
  type StorageLike
} from "../../kiosk/kiosk-mode.ts";

// ── Fixtures (nombres ficticios; nunca PII real) ─────────────────────────────

function guest(overrides: Partial<WizardGuest> = {}): WizardGuest {
  return {
    id: "cg_1",
    isPrimary: true,
    ordinal: 0,
    status: "pending",
    guestRegisterRecordId: null,
    ageAtArrival: 36,
    isMinor: false,
    providedByCheckInGuestId: null,
    kinship: null,
    guardianTitle: null,
    identityVerificationMethod: null,
    identityVerifiedAt: null,
    firstName: "Ana",
    surname1: "Prueba",
    surname2: null,
    nationality: "ESP",
    documentType: "DNI",
    documentNumberLast3: "23A",
    hasEmail: true,
    hasPhoneMobile: false,
    ...overrides
  };
}

function session(overrides: Partial<WizardSession> = {}): WizardSession {
  return {
    id: "cis_1",
    reservationId: "res_1",
    propertyId: "prop_chk",
    status: "in_progress",
    paymentStatus: "none",
    etaDeclared: null,
    preferences: [],
    consent: { gdprAt: "2026-09-20T10:00:00.000Z", aiDisclosureAt: null, marketing: false, whatsappOptInAt: null },
    guests: [guest()],
    policy: { selfCheckInEnabled: true, allowedVerificationMethods: ["visual_reception", "mrz_checksum", "otp_email"], requireVisualCheckAtKiosk: false, depositPolicy: "none" },
    balanceDue: 0,
    guestCapacity: 2,
    ...overrides
  };
}

const complete = (): WizardGuest => guest({ status: "data_complete", guestRegisterRecordId: "grr_1" });
const signed = (): WizardGuest => guest({ status: "signed", guestRegisterRecordId: "grr_1" });

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    }
  };
}

// ── Pasos ────────────────────────────────────────────────────────────────────

describe("wizard · pasos y progreso", () => {
  it("son exactamente los 6 pasos del diseño §8 en orden", () => {
    assert.deepEqual([...WIZARD_STEPS], ["travellers", "document", "details", "signature", "payment", "arrival"]);
  });

  it("nextStep/prevStep recorren la secuencia y devuelven null en los extremos", () => {
    assert.equal(nextStep("travellers"), "document");
    assert.equal(nextStep("document"), "details");
    assert.equal(nextStep("details"), "signature");
    assert.equal(nextStep("signature"), "payment");
    assert.equal(nextStep("payment"), "arrival");
    assert.equal(nextStep("arrival"), null);
    assert.equal(prevStep("travellers"), null);
    assert.equal(prevStep("arrival"), "payment");
  });

  it("una sesión ya alojada salta a la llegada desde cualquier paso", () => {
    assert.equal(nextStep("travellers", { status: "checked_in" }), "arrival");
    assert.equal(nextStep("payment", { status: "arrived" }), "arrival");
    assert.equal(nextStep("arrival", { status: "checked_in" }), null);
  });

  it("progressFor da índice 1-based, total 6 y porcentaje redondeado", () => {
    assert.deepEqual(progressFor("travellers"), { index: 1, total: 6, percent: 17 });
    assert.deepEqual(progressFor("signature"), { index: 4, total: 6, percent: 67 });
    assert.deepEqual(progressFor("arrival"), { index: 6, total: 6, percent: 100 });
  });
});

describe("wizard · canAdvance por paso (solo con lo visible en el DTO)", () => {
  it("viajeros: todos con nombre y primer apellido", () => {
    assert.equal(canAdvance(session(), "travellers"), true);
    assert.equal(canAdvance(session({ guests: [guest(), guest({ id: "cg_2", isPrimary: false, ordinal: 1, firstName: null })] }), "travellers"), false);
    assert.equal(canAdvance(session({ guests: [] }), "travellers"), false);
  });

  it("documento: todos con tipo y últimos 3 caracteres", () => {
    assert.equal(canAdvance(session(), "document"), true);
    assert.equal(canAdvance(session({ guests: [guest({ documentNumberLast3: null })] }), "document"), false);
  });

  it("datos: todos data_complete/signed/verified y consentimiento RGPD fechado", () => {
    assert.equal(canAdvance(session({ guests: [complete()] }), "details"), true);
    assert.equal(canAdvance(session(), "details"), false, "pending no basta");
    assert.equal(canAdvance(session({ guests: [complete()], consent: { gdprAt: null, aiDisclosureAt: null, marketing: false, whatsappOptInAt: null } }), "details"), false, "sin RGPD no");
  });

  it("firma: todos con parte y ningún firmante pendiente; los menores de 14 no firman", () => {
    assert.equal(canAdvance(session({ guests: [signed()] }), "signature"), true);
    assert.equal(canAdvance(session({ guests: [complete()] }), "signature"), false);
    const minor = guest({ id: "cg_m", isPrimary: false, ordinal: 1, status: "data_complete", guestRegisterRecordId: "grr_2", isMinor: true, ageAtArrival: 9, providedByCheckInGuestId: "cg_1", kinship: "hijo" });
    assert.equal(canAdvance(session({ guests: [signed(), minor] }), "signature"), true, "el menor no bloquea la firma");
    assert.equal(pendingSigners(session({ guests: [signed(), minor] })).length, 0);
    assert.equal(canAdvance(session({ guests: [signed(), guest({ id: "cg_3", status: "data_complete", guestRegisterRecordId: null })] }), "signature"), false, "sin parte no se firma");
  });

  it("pago: estados liquidados o saldo cero; link_sent sin confirmar no avanza", () => {
    assert.equal(canAdvance(session({ paymentStatus: "paid", balanceDue: 120 }), "payment"), true);
    assert.equal(canAdvance(session({ paymentStatus: "at_reception", balanceDue: 120 }), "payment"), true);
    assert.equal(canAdvance(session({ paymentStatus: "authorized", balanceDue: 120 }), "payment"), true);
    assert.equal(canAdvance(session({ paymentStatus: "none", balanceDue: 0 }), "payment"), true);
    assert.equal(canAdvance(session({ paymentStatus: "link_sent", balanceDue: 120 }), "payment"), false);
    assert.equal(canAdvance(session({ paymentStatus: "none", balanceDue: 120 }), "payment"), false);
    assert.equal(paymentSettled({ paymentStatus: "none" }), false, "sin saldo conocido no se da por pagado");
  });

  it("llegada: solo checked_in", () => {
    assert.equal(canAdvance(session({ status: "ready_for_arrival" }), "arrival"), false);
    assert.equal(canAdvance(session({ status: "checked_in" }), "arrival"), true);
  });

  it("initialStep reanuda por el primer paso incompleto y salta a la llegada cuando la sesión ya llegó", () => {
    assert.equal(initialStep(session({ guests: [guest({ firstName: null })] })), "travellers");
    assert.equal(initialStep(session({ guests: [guest({ documentNumberLast3: null })] })), "document");
    assert.equal(initialStep(session()), "details");
    assert.equal(initialStep(session({ guests: [complete()] })), "signature");
    assert.equal(initialStep(session({ guests: [signed()], paymentStatus: "none", balanceDue: 80 })), "payment");
    assert.equal(initialStep(session({ guests: [signed()], paymentStatus: "at_reception", balanceDue: 80 })), "arrival");
    assert.equal(initialStep(session({ status: "arrived", guests: [guest({ firstName: null })] })), "arrival");
  });
});

// ── Datos que faltan ─────────────────────────────────────────────────────────

describe("wizard · missingFor y mergeMissing", () => {
  it("un viajero completo no tiene faltas visibles; uno vacío las tiene todas menos las de menor", () => {
    assert.deepEqual(missingFor(guest()), []);
    const empty = guest({ firstName: null, surname1: null, nationality: null, ageAtArrival: null, documentType: null, documentNumberLast3: null, hasEmail: false, hasPhoneMobile: false });
    assert.deepEqual(missingFor(empty), ["firstName", "surname1", "nationality", "dateOfBirth", "documentType", "documentNumber", "contact"]);
  });

  it("un menor sin adulto ni parentesco los echa en falta; el contacto vale con correo o móvil", () => {
    const minor = guest({ isMinor: true, ageAtArrival: 9, hasEmail: false, hasPhoneMobile: true });
    assert.deepEqual(missingFor(minor), ["providedByCheckInGuestId", "kinship"]);
    assert.deepEqual(missingFor(guest({ hasEmail: false, hasPhoneMobile: true })), []);
  });

  it("mergeMissing une local + servidor sin duplicados ni vacíos y conserva el orden", () => {
    assert.deepEqual(mergeMissing(["firstName", "contact"], ["contact", "residenceFullAddress", "", "firstName"]), ["firstName", "contact", "residenceFullAddress"]);
    assert.deepEqual(mergeMissing([], null), []);
  });

  it("adultsFor excluye al propio menor y a quien no tenga 18 años; canAddGuest respeta adults+children", () => {
    const adult = guest({ id: "a", ageAtArrival: 40 });
    const teen = guest({ id: "t", ageAtArrival: 16, isPrimary: false, ordinal: 1 });
    const minor = guest({ id: "m", ageAtArrival: 8, isMinor: true, isPrimary: false, ordinal: 2 });
    assert.deepEqual(adultsFor({ guests: [adult, teen, minor] }, "m").map((g) => g.id), ["a"]);
    assert.equal(canAddGuest({ guests: [adult], guestCapacity: 2 }), true);
    assert.equal(canAddGuest({ guests: [adult, teen], guestCapacity: 2 }), false);
    assert.equal(canAddGuest({ guests: [adult, teen] }), true, "sin capacidad conocida el servidor decide (409 CHECKIN_GUEST_LIMIT)");
  });
});

// ── Edad y menores ───────────────────────────────────────────────────────────

describe("wizard · ageAt / isMinorAt (RD 933/2021: < 14 no firma)", () => {
  it("calcula años cumplidos en la fecha de llegada, cumpleaños incluido", () => {
    assert.equal(ageAt("2012-09-21", "2026-09-20"), 13);
    assert.equal(ageAt("2012-09-20", "2026-09-20"), 14);
    assert.equal(ageAt("2012-09-19", "2026-09-20"), 14);
    assert.equal(ageAt("1990-02-29", "2026-02-28"), 35);
  });

  it("isMinorAt: 13 años sí, 14 no; sin fecha o fecha inválida → false", () => {
    assert.equal(MINOR_AGE, 14);
    assert.equal(isMinorAt("2012-09-21", "2026-09-20"), true);
    assert.equal(isMinorAt("2012-09-20", "2026-09-20"), false);
    assert.equal(isMinorAt(null, "2026-09-20"), false);
    assert.equal(isMinorAt("no-es-fecha", "2026-09-20"), false);
    assert.equal(ageAt("2030-01-01", "2026-09-20"), null, "nacido después de la llegada → null");
  });
});

// ── MRZ ──────────────────────────────────────────────────────────────────────

describe("wizard · normalizeMrzText / mrzFormatOf", () => {
  const td3 = ["P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<", "L898902C36UTO7408122F1204159ZE184226B<<<<<10"];

  it("mayúsculas, espacios y guiones bajos → «<», caracteres ajenos fuera, líneas vacías fuera", () => {
    const lines = normalizeMrzText(`  ${td3[0]!.toLowerCase().replace(/<<</, "   ")}\n\n${td3[1]}\r\n`);
    assert.equal(lines.length, 2);
    assert.equal(lines[0], td3[0]);
    assert.equal(lines[1], td3[1]);
    assert.equal(mrzFormatOf(lines), "TD3");
    assert.equal(looksLikeMrz(lines), true);
  });

  it("un bloque sin saltos se parte por la longitud del formato (88 → TD3, 90 → TD1, 72 → TD2)", () => {
    assert.deepEqual(normalizeMrzText(td3.join("")), td3);
    const td1 = ["IDESP".padEnd(30, "<"), "7408122F1204159ESP".padEnd(30, "<"), "ERIKSSON<<ANNA<MARIA".padEnd(30, "<")];
    assert.deepEqual(normalizeMrzText(td1.join("")), td1);
    assert.equal(mrzFormatOf(td1), "TD1");
    const td2 = ["IDUTO".padEnd(36, "<"), "L898902C36UTO7408122F1204159".padEnd(36, "<")];
    assert.deepEqual(normalizeMrzText(td2.join("")), td2);
    assert.equal(mrzFormatOf(td2), "TD2");
  });

  it("texto que no cuadra no es MRZ (el servidor responde MRZ_CHECKSUM_FAILED / DOCUMENT_UNREADABLE)", () => {
    assert.equal(mrzFormatOf(["HOLA", "MUNDO"]), null);
    assert.equal(looksLikeMrz(normalizeMrzText("una frase cualquiera")), false);
    assert.deepEqual(normalizeMrzText(""), []);
  });

  it("dataUrlByteSize e isImageDataUrl acotan la imagen a 6 MiB", () => {
    assert.equal(MAX_DOCUMENT_BYTES, 6 * 1024 * 1024);
    assert.equal(dataUrlByteSize("data:image/png;base64,AAAA"), 3);
    assert.equal(dataUrlByteSize("data:image/png;base64,AAA="), 2);
    assert.equal(dataUrlByteSize("sin coma"), 0);
    assert.equal(isImageDataUrl("data:image/jpeg;base64,/9j/"), true);
    assert.equal(isImageDataUrl("data:text/plain;base64,QQ=="), false);
  });
});

// ── Copy es/en ───────────────────────────────────────────────────────────────

describe("wizard · copy en español e inglés (sin i18n nueva)", () => {
  it("las dos tablas tienen exactamente las mismas claves y ninguna vacía", () => {
    assert.deepEqual(Object.keys(COPY.en).sort(), Object.keys(COPY.es).sort());
    for (const lang of ["es", "en"] as const) {
      for (const [key, value] of Object.entries(COPY[lang])) assert.ok(value.trim().length > 0, `${lang}.${key} vacío`);
    }
  });

  it("pickLanguage: español por defecto (es/gl/ca/eu), inglés para el resto", () => {
    assert.equal(pickLanguage("es-ES"), "es");
    assert.equal(pickLanguage("gl"), "es");
    assert.equal(pickLanguage("en-GB"), "en");
    assert.equal(pickLanguage("de"), "en");
    assert.equal(pickLanguage(undefined), "es");
  });

  it("t sustituye {parámetros}; stepLabel y sessionStatusLabel traducen; el aviso de retención cita el RD 933/2021", () => {
    assert.equal(t("es", "stepOf", { index: 2, total: 6 }), "Paso 2 de 6");
    assert.equal(t("en", "stepOf", { index: 2, total: 6 }), "Step 2 of 6");
    assert.equal(stepLabel("payment", "es"), "Pago y extras");
    assert.equal(stepLabel("payment", "en"), "Payment & extras");
    assert.equal(sessionStatusLabel("ready_for_arrival", "en"), "Ready for arrival");
    assert.equal(sessionStatusLabel("desconocido", "es"), "desconocido");
    assert.match(t("es", "retention"), /RD 933\/2021/);
    assert.match(t("en", "retention"), /RD 933\/2021/);
  });

  it("guestLabel usa el nombre o el rol; sourceLabel etiqueta origen y confianza; formatDocumentHint sitúa la MRZ", () => {
    assert.equal(guestLabel(guest(), "es"), "Ana Prueba");
    assert.equal(guestLabel(guest({ firstName: null, surname1: null }), "es"), "Titular");
    assert.equal(guestLabel(guest({ firstName: null, surname1: null, isPrimary: false, ordinal: 2 }), "en"), "Companion 2");
    assert.equal(sourceLabel("mrz_reader", 1, "es"), "leído de la MRZ · confianza 100 %");
    assert.equal(sourceLabel("ai_vision", 0.874, "en"), "read by vision · confidence 87%");
    assert.equal(sourceLabel("manual", 1, "es"), "introducido por el huésped");
    assert.equal(sourceLabel(null, null, "en"), "entered by the guest");
    assert.match(formatDocumentHint("PASSPORT", "es"), /dos líneas .*44/);
    assert.match(formatDocumentHint("DNI", "en"), /three code lines/);
    assert.match(formatDocumentHint(null, "es"), /MRZ/);
  });

  it("togglePreference añade y quita códigos sin duplicar", () => {
    assert.deepEqual(togglePreference([], "quiet"), ["quiet"]);
    assert.deepEqual(togglePreference(["quiet", "crib"], "quiet"), ["crib"]);
  });
});

// ── OTP y errores de llegada ─────────────────────────────────────────────────

describe("wizard · OTP y describeArrivalError", () => {
  it("otpChannelsFor sigue la política; needsOtp solo cuando el titular no está verificado por un método admitido", () => {
    assert.deepEqual(otpChannelsFor({ allowedVerificationMethods: ["otp_email", "otp_phone"] }), ["email", "phone"]);
    assert.deepEqual(otpChannelsFor({ allowedVerificationMethods: ["visual_reception"] }), []);
    assert.equal(needsOtp(session()), true, "sin método → OTP");
    assert.equal(needsOtp(session({ guests: [guest({ identityVerificationMethod: "mrz_checksum" })] })), false, "mrz_checksum admitido basta");
    const restrictive = session({ policy: { selfCheckInEnabled: true, allowedVerificationMethods: ["visual_reception", "otp_email"], requireVisualCheckAtKiosk: false, depositPolicy: "none" }, guests: [guest({ identityVerificationMethod: "mrz_checksum" })] });
    assert.equal(needsOtp(restrictive), true, "mrz_checksum no admitido → OTP");
    assert.equal(needsOtp(session({ guests: [guest({ identityVerificationMethod: "otp_email", identityVerifiedAt: "2026-09-20T10:00:00.000Z" })] })), false);
    assert.equal(needsOtp(session({ policy: { selfCheckInEnabled: true, allowedVerificationMethods: ["visual_reception"], requireVisualCheckAtKiosk: false, depositPolicy: "none" } })), false, "sin otp_* la política no ofrece OTP");
  });

  it("ROOM_NOT_READY → «lista a las HH:MM» (zona de la propiedad) y handoff; sin ETA → mensaje genérico", () => {
    const view = describeArrivalError({ code: "ROOM_NOT_READY", etaReady: "2026-09-20T13:30:00.000Z" }, "x", "es", "Europe/Madrid");
    assert.equal(view.message, "Tu habitación estará lista a las 15:30. Te avisamos en cuanto esté.");
    assert.equal(view.handoff, true);
    assert.equal(view.step, null);
    assert.equal(describeArrivalError({ code: "ROOM_NOT_READY", etaReady: null }, "x", "en").message, "Your room isn't ready yet. Reception will let you know as soon as it is.");
  });

  it("CHECK_IN_DATE_OUT_OF_RANGE → fecha desde la que se admite (llegada − 1 día), sin handoff", () => {
    assert.equal(earliestCheckInDay("2026-09-21"), "2026-09-20");
    assert.equal(earliestCheckInDay("2026-03-01"), "2026-02-28");
    const view = describeArrivalError({ code: "CHECK_IN_DATE_OUT_OF_RANGE", arrivalDate: "2026-09-21", businessDate: "2026-09-19" }, "x", "es");
    assert.equal(view.message, "Podrás hacer el check-in el 20 de septiembre. Te esperamos.");
    assert.equal(view.handoff, false);
    assert.equal(describeArrivalError({ code: "CHECK_IN_DATE_OUT_OF_RANGE", arrivalDate: "2026-09-21" }, "x", "en").message, "You'll be able to check in on 20 September. See you soon.");
  });

  it("el resto de códigos devuelve el paso al que volver y si recepción interviene", () => {
    assert.deepEqual(describeArrivalError({ code: "IDENTITY_NOT_VERIFIED" }, "x", "es"), { message: t("es", "identityNotVerified"), step: "arrival", handoff: true, done: false });
    assert.deepEqual(describeArrivalError({ code: "BALANCE_DUE" }, "x", "es"), { message: t("es", "balanceDueError"), step: "payment", handoff: true, done: false });
    assert.deepEqual(describeArrivalError({ code: "GUEST_REGISTER_INCOMPLETE" }, "x", "en"), { message: t("en", "signatureMissing"), step: "signature", handoff: false, done: false });
    assert.deepEqual(describeArrivalError({ code: "CHECKIN_INCOMPLETE" }, "x", "en"), { message: t("en", "signatureNeedsData"), step: "details", handoff: false, done: false });
    assert.deepEqual(describeArrivalError({ code: "CHECKIN_ALREADY_DONE" }, "x", "es"), { message: t("es", "alreadyCheckedIn"), step: null, handoff: false, done: true });
    assert.deepEqual(describeArrivalError(null, "Fallo del servidor", "es"), { message: "Fallo del servidor", step: null, handoff: true, done: false });
    assert.equal(describeArrivalError({ code: "OTRO" }, "", "en").message, t("en", "genericError"));
  });
});

// ── Kiosco ───────────────────────────────────────────────────────────────────

describe("kiosk-mode · parseKioskParams y credencial del dispositivo", () => {
  it("?kiosk=1&device=<id> activa el modo; sin kiosk=1 el device se ignora", () => {
    assert.deepEqual(parseKioskParams("?kiosk=1&device=kd_1&property=prop_chk"), { enabled: true, deviceId: "kd_1", propertyId: "prop_chk" });
    assert.deepEqual(parseKioskParams({ search: "?kiosk=true" }), { enabled: true, deviceId: null, propertyId: null });
    assert.deepEqual(parseKioskParams({ search: "?device=kd_1" }), { enabled: false, deviceId: null, propertyId: null });
    assert.deepEqual(parseKioskParams(null), { enabled: false, deviceId: null, propertyId: null });
    assert.deepEqual(parseKioskParams("?kiosk=0&token=abc"), { enabled: false, deviceId: null, propertyId: null });
  });

  it("la credencial del kiosco se guarda en localStorage (no la sesión del huésped) y se lee de forma tolerante", () => {
    const storage = memoryStorage();
    assert.equal(readKioskDevice(storage), null);
    assert.equal(writeKioskDevice(storage, { deviceId: "kd_1", token: "a".repeat(64), name: "Tablet", propertyId: "prop_chk", capabilities: { mrzReader: true, cardEncoder: false, paymentTerminal: false, printer: false }, pairedAt: "2026-09-20T10:00:00.000Z" }), true);
    assert.equal(storage.data.has(KIOSK_STORAGE_KEY), true);
    assert.equal(readKioskDevice(storage)?.capabilities.mrzReader, true);
    storage.setItem(KIOSK_STORAGE_KEY, "{no es json");
    assert.equal(readKioskDevice(storage), null);
    storage.setItem(KIOSK_STORAGE_KEY, JSON.stringify({ deviceId: "kd_1" }));
    assert.equal(readKioskDevice(storage), null, "sin token no vale");
    clearKioskDevice(storage);
    assert.equal(storage.data.has(KIOSK_STORAGE_KEY), false);
    assert.equal(writeKioskDevice(null, { deviceId: "x", token: "y", name: null, propertyId: null, capabilities: { mrzReader: false, cardEncoder: false, paymentTerminal: false, printer: false }, pairedAt: "" }), false);
  });

  it("resetSession borra la sesión y la llegada del huésped y deja la credencial del kiosco", () => {
    const storage = memoryStorage({ [GUEST_SESSION_STORAGE_KEY]: "{}", [GUEST_ARRIVAL_STORAGE_KEY]: "{}", [KIOSK_STORAGE_KEY]: "{}" });
    let tokenCleared = false;
    let signedOut = false;
    const result = resetSession({ sessionStorage: storage, clearGuestToken: () => (tokenCleared = true), signOut: () => (signedOut = true) });
    assert.deepEqual(result, { clearedKeys: [GUEST_SESSION_STORAGE_KEY, GUEST_ARRIVAL_STORAGE_KEY], tokenCleared: true, signedOut: true });
    assert.equal(storage.data.has(KIOSK_STORAGE_KEY), true);
    assert.equal(tokenCleared && signedOut, true);
    assert.deepEqual(resetSession(), { clearedKeys: [], tokenCleared: false, signedOut: false });
  });
});

describe("kiosk-mode · temporizador de inactividad de 90 s y ticket de handoff", () => {
  it("idleTimeoutMs es 90 000 y el aviso llega 15 s antes", () => {
    assert.equal(idleTimeoutMs, 90_000);
    assert.equal(IDLE_TIMEOUT_MS, 90_000);
    assert.equal(IDLE_WARNING_MS, 15_000);
  });

  it("touch reprograma; el aviso y el reinicio se disparan en orden; stop cancela", () => {
    const scheduled: Array<{ id: number; handler: () => void; ms: number; cancelled: boolean; fired: boolean }> = [];
    let nextId = 1;
    let clock = 1_000;
    const events: string[] = [];
    const timer = createIdleTimer({
      onIdle: () => events.push("idle"),
      onWarning: (seconds) => events.push(`warning:${seconds}`),
      setTimeout: (handler, ms) => {
        const entry = {
          id: nextId++,
          ms,
          cancelled: false,
          fired: false,
          handler: () => {
            entry.fired = true;
            handler();
          }
        };
        scheduled.push(entry);
        return entry.id;
      },
      clearTimeout: (handle) => {
        const entry = scheduled.find((row) => row.id === handle);
        if (entry) entry.cancelled = true;
      },
      now: () => clock
    });
    assert.equal(timer.isRunning(), false);
    timer.touch();
    assert.equal(timer.isRunning(), true);
    assert.equal(timer.remainingMs(), 90_000);
    const pending = () => scheduled.filter((row) => !row.cancelled && !row.fired);
    const first = pending();
    assert.deepEqual(first.map((row) => row.ms), [75_000, 90_000]);
    // Actividad: los dos anteriores se cancelan y se reprograman.
    clock += 10_000;
    timer.touch();
    assert.equal(first.every((row) => row.cancelled), true);
    const second = pending();
    assert.equal(second.length, 2);
    // Sin actividad: aviso y luego reinicio.
    second[0]!.handler();
    assert.deepEqual(events, ["warning:15"]);
    second[1]!.handler();
    assert.deepEqual(events, ["warning:15", "idle"]);
    assert.equal(timer.isRunning(), false);
    assert.equal(timer.remainingMs(), 0);
    timer.touch();
    timer.stop();
    assert.equal(timer.isRunning(), false);
    assert.equal(pending().length, 0);
  });

  it("acepta timeoutMs propio (mínimo 1 s) y funciona sin onWarning", () => {
    const scheduled: number[] = [];
    const timer = createIdleTimer({ timeoutMs: 5_000, onIdle: () => undefined, setTimeout: (_handler, ms) => scheduled.push(ms), clearTimeout: () => undefined });
    timer.touch();
    assert.deepEqual(scheduled, [5_000]);
  });

  it("handoffTicket: K-dddd determinista por sesión y minuto, distinto entre sesiones", () => {
    const at = new Date("2026-09-20T10:15:30.000Z");
    const a = handoffTicket("cis_1", at);
    assert.match(a, /^K-\d{4}$/);
    assert.equal(handoffTicket("cis_1", new Date("2026-09-20T10:15:59.000Z")), a, "mismo minuto → mismo ticket");
    assert.notEqual(handoffTicket("cis_2", at), a);
  });
});
