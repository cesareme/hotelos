// Tanda CHK · W2-B: captura de identidad con dependencias inyectadas (sin
// Prisma, sin modelo, sin red). MRZ sintética con buildMrz (nombre ficticio
// PRUEBA / ANNA). From apps/api:
//   node --import tsx --test src/modules/checkin/__tests__/identity-capture.test.mts
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildMrz } from "@hotelos/compliance";
import type { RunnerContext } from "@hotelos/ai-core/runner";
import type { UserContext } from "../../../lib/demo-store.js";
import { BadRequestError, HttpError, NotFoundError } from "../../../lib/http-error.js";
import type { runAiTool } from "../../ai-operations/tool-runner.service.js";
import {
  captureDocument,
  EXPIRED_DOCUMENT_WARNING,
  IDENTITY_MISMATCH_WARNING,
  IDENTITY_RECORD_AS,
  IDENTITY_TOOL_NAME,
  identityNameMatches,
  mergeIdentityFields,
  normalizeVisionOutput,
  purgeExpiredCaptures,
  purgeUpdateArgs,
  resetIdentityCaptureForTests,
  type CheckInGuestRow,
  type IdentityCaptureDeps,
  type ReservationGuestName
} from "../identity-capture.service.js";

globalThis.fetch = (() => {
  throw new Error("red prohibida en los tests de captura de identidad");
}) as typeof fetch;

const NOW = new Date("2026-09-19T10:00:00.000Z");
const IMAGE_PAYLOAD = Buffer.from(`FAKE-JPEG-BYTES-${"x".repeat(200)}`).toString("base64");
const IMAGE = `data:image/jpeg;base64,${IMAGE_PAYLOAD}`;

const VALID_TD1 = buildMrz({ format: "TD1", documentType: "DNI", issuingCountry: "ESP", documentNumber: "12345678Z", supportNumber: "AAA123456", surname: "PRUEBA", givenNames: "ANNA", dateOfBirth: "1990-01-15", sex: "M", expiryDate: "2031-01-15", nationality: "ESP" });
const EXPIRED_TD3 = buildMrz({ format: "TD3", documentType: "PASSPORT", issuingCountry: "ESP", documentNumber: "XDA123456", surname: "PRUEBA", givenNames: "ANNA", dateOfBirth: "1990-01-15", sex: "M", expiryDate: "2020-01-15", nationality: "ESP" });

function user(overrides: Partial<UserContext> = {}): UserContext {
  return { organizationId: "org_t", propertyId: "prop_t", userId: "usr_t", fullName: "Recepción", deviceId: "dev_t", permissions: ["guest_register.create"], ...overrides };
}

function guestRow(overrides: Partial<CheckInGuestRow> = {}): CheckInGuestRow {
  return {
    id: "cig_1",
    sessionId: "cis_1",
    propertyId: "prop_t",
    guestId: "gst_1",
    guestRegisterRecordId: null,
    status: "pending",
    firstName: null,
    surname1: null,
    surname2: null,
    session: { id: "cis_1", organizationId: "org_t", propertyId: "prop_t", reservationId: "res_1" },
    ...overrides
  };
}

type FakeState = {
  llmConfigured: boolean;
  documentMaxBytes: number;
  visionData: Record<string, unknown> | null;
  guest: CheckInGuestRow | null;
  names: ReservationGuestName[];
  runnerInputs: unknown[];
  runnerRecords: unknown[];
  captures: Array<Record<string, unknown>>;
  guestUpdates: Array<{ id: string; data: Record<string, unknown> }>;
  discardEvents: unknown[];
  audits: Array<Record<string, unknown>>;
  purgeArgs: unknown[];
};

function fakeDeps(overrides: Partial<FakeState> = {}): { deps: Partial<IdentityCaptureDeps>; state: FakeState } {
  const state: FakeState = { llmConfigured: true, documentMaxBytes: 6_291_456, visionData: null, guest: null, names: [], runnerInputs: [], runnerRecords: [], captures: [], guestUpdates: [], discardEvents: [], audits: [], purgeArgs: [], ...overrides };
  let seq = 0;
  const fakeRunAiTool = (async (input: Parameters<typeof runAiTool>[0]) => {
    state.runnerInputs.push({ toolName: input.toolName, recordAs: input.recordAs, input: input.input, source: input.source });
    const ctx: RunnerContext = { organizationId: input.context.organizationId, propertyId: input.context.propertyId, userId: input.context.userId, permissions: [...input.context.permissions], enabledModules: [], correlationId: input.correlationId, source: input.source ?? "text", locale: "es-ES" };
    const executed = await input.execute!(input.input as never, ctx);
    const wrapped = executed as { output?: unknown; record?: unknown; configured?: boolean };
    if (wrapped && typeof wrapped === "object" && "output" in wrapped) {
      state.runnerRecords.push(wrapped.record ?? null);
      return { status: "executed", toolCallId: `call_${++seq}`, output: wrapped.output, configured: true };
    }
    return { status: "executed", toolCallId: `call_${++seq}`, output: executed, configured: false };
  }) as unknown as typeof runAiTool;
  const deps: Partial<IdentityCaptureDeps> = {
    now: () => NOW,
    createId: (prefix) => `${prefix}_${++seq}`,
    limits: () => ({ documentMaxBytes: state.documentMaxBytes, capturePurgeDays: 30 }),
    isLlmConfigured: () => state.llmConfigured,
    runAiTool: fakeRunAiTool,
    extractJson: async () => {
      if (!state.visionData) return { configured: false, reason: "not_configured", message: "Sin modelo configurado" };
      return { configured: true, provider: "anthropic", model: "claude-sonnet-5", tokensInput: 1300, tokensOutput: 250, costEur: 0.0041, costUsd: 0.0045, latencyMs: 900, data: state.visionData, document: { pages: 1, bytes: 216, sha256: "deadbeef" } };
    },
    loadProperty: async (propertyId) => (propertyId === "prop_t" ? { id: "prop_t", organizationId: "org_t" } : null),
    loadCheckInGuest: async (id) => (state.guest && state.guest.id === id ? state.guest : null),
    loadReservationGuestNames: async () => state.names,
    createDocumentCapture: async (data) => {
      state.captures.push(data as unknown as Record<string, unknown>);
      return { id: String(data.id) };
    },
    updateCheckInGuest: async (id, data) => {
      state.guestUpdates.push({ id, data: data as Record<string, unknown> });
    },
    purgeCaptures: async (args) => {
      state.purgeArgs.push(args);
      return { count: 3 };
    },
    recordIdentityDiscardEvent: (async (input: unknown) => {
      state.discardEvents.push(input);
      return { id: "ide_1", propertyId: "prop_t", eventType: "image_discarded", imageStored: false, imageDiscarded: true, createdAt: NOW.toISOString() };
    }) as unknown as IdentityCaptureDeps["recordIdentityDiscardEvent"],
    recordAuditEvent: ((input: Record<string, unknown>) => {
      state.audits.push(input);
      return input;
    }) as unknown as IdentityCaptureDeps["recordAuditEvent"]
  };
  return { deps, state };
}

function visionOf(overrides: Record<string, unknown> = {}, confidence: Record<string, number> = {}): Record<string, unknown> {
  return {
    mrzLines: null,
    documentType: "DNI",
    documentNumber: "12345678Z",
    documentSupportNumber: "AAA123456",
    firstName: "Anna",
    surname1: "Prueba",
    surname2: null,
    dateOfBirth: "1990-01-15",
    expiryDate: "2031-01-15",
    nationality: "ESP",
    sex: "F",
    address: null,
    confidence: { documentType: 0.99, documentNumber: 0.97, documentSupportNumber: 0.9, firstName: 0.96, surname1: 0.96, dateOfBirth: 0.95, expiryDate: 0.95, nationality: 0.99, sex: 0.99, ...confidence },
    ...overrides
  };
}

describe("captureDocument · fusión MRZ ↔ visión", () => {
  afterEach(() => resetIdentityCaptureForTests());

  it("MRZ válida manda sobre la visión y fija confianza 1,0", async () => {
    const { deps, state } = fakeDeps({
      guest: guestRow(),
      names: [{ firstName: "Anna", surname1: "Prueba", surname2: null }],
      // La visión transcribe la MRZ correcta pero lee mal el nombre; aporta lo que la banda no trae (2.º apellido, dirección).
      visionData: visionOf({ mrzLines: VALID_TD1, firstName: "ANA", surname2: "SEGUNDA", address: { street: "Rúa da Proba 1", locality: "A Coruña", postalCode: "15001", country: "ESP" } }, { firstName: 0.93, surname2: 0.91, address: 0.9 })
    });
    resetIdentityCaptureForTests(deps);
    const result = await captureDocument({ context: user(), propertyId: "prop_t", checkInGuestId: "cig_1", imageDataUrl: IMAGE, correlationId: "corr_1" });

    assert.equal(result.source, "mrz_ai");
    assert.equal(result.mrzFormat, "TD1");
    assert.equal(result.fields.firstName, "ANNA");
    assert.equal(result.confidence.firstName, 1);
    assert.equal(result.fields.documentNumber, "12345678Z");
    assert.equal(result.fields.documentSupportNumber, "AAA123456");
    assert.equal(result.confidence.documentNumber, 1);
    assert.equal(result.fields.sex, "M");
    assert.deepEqual(result.checks, { document: true, birth: true, expiry: true, composite: true });
    // La visión solo aporta lo que la MRZ no trae.
    assert.equal(result.fields.surname2, "SEGUNDA");
    assert.equal(result.confidence.surname2, 0.91);
    assert.equal(result.fields.residenceLocality, "A Coruña");
    assert.equal(result.fields.residenceFullAddress, "Rúa da Proba 1, 15001");
    assert.ok(!result.needsReview.includes("firstName"));
    assert.ok(!result.needsReview.includes("identity_mismatch"));
    assert.equal(result.persisted, true);
    assert.deepEqual(result.vision, { model: "claude-sonnet-5", tokensInput: 1300, tokensOutput: 250, costEur: 0.0041 });
    // Fila document_captures: telemetría del modelo, fuente y formato; CheckInGuest recibe la PII y pasa a document_captured.
    assert.equal(state.captures.length, 1);
    assert.equal(state.captures[0]!.source, "mrz_ai");
    assert.equal(state.captures[0]!.model, "claude-sonnet-5");
    assert.equal(state.captures[0]!.tokensInput, 1300);
    assert.equal(state.guestUpdates.length, 1);
    assert.equal(state.guestUpdates[0]!.data.documentNumber, "12345678Z");
    assert.equal(state.guestUpdates[0]!.data.status, "document_captured");
    assert.equal(state.guestUpdates[0]!.data.identityVerificationMethod, "mrz_checksum");
    assert.equal(state.runnerInputs.length, 1);
    assert.deepEqual(state.runnerInputs[0], { toolName: IDENTITY_TOOL_NAME, recordAs: IDENTITY_RECORD_AS, input: { hasImage: true, mediaType: "image/jpeg", bytes: 216 }, source: "image" });
  });

  it("visión < 0,85 va a needsReview", async () => {
    const { deps, state } = fakeDeps({ guest: guestRow(), visionData: visionOf({}, { firstName: 0.6, dateOfBirth: 0.5 }) });
    resetIdentityCaptureForTests(deps);
    const result = await captureDocument({ context: user(), propertyId: "prop_t", checkInGuestId: "cig_1", imageDataUrl: IMAGE, correlationId: "corr_2" });

    assert.equal(result.source, "ai_vision");
    assert.equal(result.fields.documentNumber, "12345678Z");
    assert.equal(result.confidence.documentNumber, 0.97);
    assert.equal(result.fields.firstName, undefined, "un campo por debajo del umbral no entra en los campos");
    assert.equal(result.confidence.firstName, 0.6, "pero conserva su confianza");
    assert.ok(result.needsReview.includes("firstName"));
    assert.ok(result.needsReview.includes("dateOfBirth"));
    assert.ok(!result.needsReview.includes("documentNumber"));
    assert.deepEqual(result.checks, { document: null, birth: null, expiry: null, composite: null });
    // El viajero no recibe el valor dudoso.
    assert.equal(state.guestUpdates[0]!.data.firstName, undefined);
    assert.equal(state.guestUpdates[0]!.data.documentNumber, "12345678Z");
    assert.equal(state.guestUpdates[0]!.data.identityVerificationMethod, undefined);
    assert.deepEqual(state.captures[0]!.needsReviewJson, result.needsReview);
  });

  it("sin clave → source manual y todo en revisión", async () => {
    const { deps, state } = fakeDeps({ llmConfigured: false, guest: guestRow() });
    resetIdentityCaptureForTests(deps);
    const result = await captureDocument({ context: user(), propertyId: "prop_t", checkInGuestId: "cig_1", imageDataUrl: IMAGE, correlationId: "corr_3" });

    assert.equal(result.source, "manual");
    assert.deepEqual(result.fields, {});
    for (const key of ["documentType", "documentNumber", "firstName", "surname1", "dateOfBirth", "nationality", "sex", "documentExpiryDate", "residenceFullAddress"]) {
      assert.ok(result.needsReview.includes(key as never), `${key} en revisión`);
    }
    assert.ok(result.warnings.some((w) => w.includes("sin proveedor de IA")));
    assert.equal(state.runnerInputs.length, 0, "sin clave no se llama al runner (ni fila skipped)");
    assert.equal(result.vision, null);
    assert.deepEqual(state.captures[0]!.fieldsJson, {});
    assert.equal(state.captures[0]!.model, null);
    // La imagen recibida se descarta igualmente: evento + auditoría.
    assert.equal(state.discardEvents.length, 1);
    assert.equal(state.audits.filter((a) => a.action === "ID_IMAGE_DISCARDED").length, 1);
  });

  it("la imagen nunca llega a la telemetría ni a DocumentCapture", async () => {
    const { deps, state } = fakeDeps({ guest: guestRow(), visionData: visionOf({ mrzLines: VALID_TD1 }) });
    resetIdentityCaptureForTests(deps);
    await captureDocument({ context: user(), propertyId: "prop_t", checkInGuestId: "cig_1", imageDataUrl: IMAGE, correlationId: "corr_4" });

    const persisted = JSON.stringify({ runnerInputs: state.runnerInputs, runnerRecords: state.runnerRecords, captures: state.captures, discardEvents: state.discardEvents, audits: state.audits });
    assert.ok(!persisted.includes(IMAGE_PAYLOAD), "el base64 de la imagen no aparece en nada persistido");
    assert.ok(!persisted.includes("base64,"), "ningún data: URL persistido");
    // Telemetría: claves y confianzas, nunca valores del documento.
    assert.deepEqual(Object.keys(state.runnerRecords[0] as object).sort(), ["confidence", "document", "fieldsRead", "mrzLines"]);
    const capture = state.captures[0]!;
    const captureJson = JSON.stringify(capture);
    for (const value of ["12345678Z", "AAA123456", "ANNA", "PRUEBA"]) assert.ok(!captureJson.includes(value), `${value} no va a document_captures`);
    assert.deepEqual(capture.fieldsJson, { documentType: "DNI", mrzFormat: "TD1", issuingCountry: "ESP", nationality: "ESP", sex: "M", dateOfBirth: "1990-01-15", documentExpiryDate: "2031-01-15" });
    assert.equal(capture.imageStored, false);
    assert.equal(capture.imageDiscardedAt, NOW);
    assert.equal((capture.purgeAt as Date).toISOString(), "2026-10-19T10:00:00.000Z");
    const audit = state.audits.find((a) => a.action === "ID_IMAGE_DISCARDED")!;
    assert.equal(audit.entityType, "guest_identity_scan");
    assert.deepEqual((audit.afterJson as { imageStored: boolean; imageDiscarded: boolean }).imageStored, false);
    assert.deepEqual((audit.afterJson as { imageDiscarded: boolean }).imageDiscarded, true);
  });

  it("caducado avisa sin bloquear", async () => {
    const { deps, state } = fakeDeps({ llmConfigured: false, guest: guestRow() });
    resetIdentityCaptureForTests(deps);
    const result = await captureDocument({ context: user(), propertyId: "prop_t", checkInGuestId: "cig_1", hints: { mrzLines: EXPIRED_TD3 }, correlationId: "corr_5" });

    assert.equal(result.source, "mrz_reader");
    assert.equal(result.mrzFormat, "TD3");
    assert.equal(result.fields.documentExpiryDate, "2020-01-15");
    assert.ok(result.warnings.includes(EXPIRED_DOCUMENT_WARNING));
    assert.equal(result.fields.documentNumber, "XDA123456");
    assert.equal(result.confidence.documentNumber, 1);
    assert.equal(state.guestUpdates[0]!.data.status, "document_captured");
    // Sin imagen no hay nada que descartar: ni evento ni auditoría de descarte.
    assert.equal(state.discardEvents.length, 0);
    assert.equal(state.audits.length, 0);
  });

  it("nombre distinto → identity_mismatch", async () => {
    const { deps, state } = fakeDeps({ llmConfigured: false, guest: guestRow(), names: [{ firstName: "Ana", surname1: "Alfa", surname2: null }, { firstName: "Luis", surname1: "Beta", surname2: null }] });
    resetIdentityCaptureForTests(deps);
    const result = await captureDocument({ context: user(), propertyId: "prop_t", checkInGuestId: "cig_1", hints: { mrzLines: VALID_TD1 }, correlationId: "corr_6" });
    assert.ok(result.needsReview.includes("identity_mismatch"));
    assert.ok(result.warnings.includes(IDENTITY_MISMATCH_WARNING));
    assert.equal(result.fields.firstName, "ANNA", "la captura no se bloquea: los campos siguen disponibles");
    assert.equal(result.persisted, true, "la captura queda registrada (métrica y revisión)");
    assert.deepEqual(state.captures[0]!.needsReviewJson, ["identity_mismatch"]);
    assert.equal(state.guestUpdates.length, 0, "§4d «no se vincula»: el viajero no recibe los datos de otra persona");

    // Control: acompañante con el mismo nombre (acentos y minúsculas indiferentes) → sin discrepancia.
    const ok = fakeDeps({ llmConfigured: false, guest: guestRow(), names: [{ firstName: "Ana", surname1: "Alfa", surname2: null }, { firstName: "anna", surname1: "Prúeba", surname2: null }] });
    resetIdentityCaptureForTests(ok.deps);
    const matched = await captureDocument({ context: user(), propertyId: "prop_t", checkInGuestId: "cig_1", hints: { mrzLines: VALID_TD1 }, correlationId: "corr_7" });
    assert.ok(!matched.needsReview.includes("identity_mismatch"));
    assert.ok(!matched.warnings.includes(IDENTITY_MISMATCH_WARNING));
    assert.equal(ok.state.guestUpdates.length, 1, "con coincidencia sí se vincula");
  });

  it("purge vacía campos tras purgeAt", async () => {
    const args = purgeUpdateArgs(NOW);
    assert.deepEqual(args.data, { fieldsJson: {}, confidenceJson: {} });
    assert.deepEqual(args.where.purgeAt, { lte: NOW });
    assert.equal(Array.isArray(args.where.OR), true, "solo toca filas que aún conservan campos o confianzas");
    const { deps, state } = fakeDeps();
    resetIdentityCaptureForTests(deps);
    const result = await purgeExpiredCaptures(NOW);
    assert.deepEqual(result, { purged: 3 });
    assert.deepEqual(state.purgeArgs, [args]);
  });
});

describe("captureDocument · validación y ámbito", () => {
  afterEach(() => resetIdentityCaptureForTests());

  it("rechaza imágenes que no son data: URL, tipos no image/* y tamaños por encima del límite", async () => {
    const { deps } = fakeDeps({ guest: guestRow() });
    resetIdentityCaptureForTests(deps);
    await assert.rejects(captureDocument({ context: user(), propertyId: "prop_t", imageDataUrl: "https://example.test/dni.jpg" }), BadRequestError);
    await assert.rejects(captureDocument({ context: user(), propertyId: "prop_t", imageDataUrl: "data:application/pdf;base64,QUJD" }), BadRequestError);
    const small = fakeDeps({ guest: guestRow(), documentMaxBytes: 100 });
    resetIdentityCaptureForTests(small.deps);
    await assert.rejects(captureDocument({ context: user(), propertyId: "prop_t", imageDataUrl: IMAGE }), (error: unknown) => error instanceof HttpError && error.statusCode === 413);
    resetIdentityCaptureForTests(deps);
    await assert.rejects(captureDocument({ context: user(), propertyId: "prop_t" }), /imagen del documento o las líneas de la MRZ/);
  });

  it("404 opaco fuera de la organización (propiedad y viajero) y captura sin viajero no persiste", async () => {
    const { deps, state } = fakeDeps({ llmConfigured: false, guest: guestRow({ session: { id: "cis_1", organizationId: "org_other", propertyId: "prop_t", reservationId: "res_1" } }) });
    resetIdentityCaptureForTests(deps);
    await assert.rejects(captureDocument({ context: user(), propertyId: "prop_x", hints: { mrzLines: VALID_TD1 } }), NotFoundError);
    await assert.rejects(captureDocument({ context: user(), propertyId: "prop_t", checkInGuestId: "cig_1", hints: { mrzLines: VALID_TD1 } }), NotFoundError);
    const result = await captureDocument({ context: user(), propertyId: "prop_t", hints: { mrzLines: VALID_TD1 } });
    assert.equal(result.persisted, false);
    assert.match(result.captureId, /^dcap_/);
    assert.equal(state.captures.length, 0);
    assert.equal(state.guestUpdates.length, 0);
  });

  it("exige guest_register.create", async () => {
    const { deps } = fakeDeps();
    resetIdentityCaptureForTests(deps);
    await assert.rejects(captureDocument({ context: user({ permissions: [] }), propertyId: "prop_t", hints: { mrzLines: VALID_TD1 } }), (error: unknown) => (error as { statusCode?: number }).statusCode === 403 && /guest_register\.create/.test(String((error as Error).message)));
  });
});

describe("mergeIdentityFields · funciones puras", () => {
  it("MRZ con dígitos de control incorrectos no se fía: la banda va a revisión y la visión decide", () => {
    const bad = [...VALID_TD1];
    bad[0] = `${bad[0]!.slice(0, 5)}9${bad[0]!.slice(6)}`;
    const merged = mergeIdentityFields({ format: "TD1", valid: false, fields: null, checks: { document: false, birth: true, expiry: true, composite: false }, corrections: [], errors: ["Dígitos de control incorrectos: document, composite"] }, normalizeVisionOutput(visionOf({ mrzLines: bad })));
    assert.equal(merged.source, "ai_vision");
    assert.ok(merged.needsReview.includes("mrz"));
    assert.equal(merged.fields.documentNumber, "12345678Z");
    assert.equal(merged.confidence.documentNumber, 0.97);
    assert.deepEqual(merged.checks, { document: false, birth: true, expiry: true, composite: false });
    assert.equal(merged.mrzFormat, null);
  });

  it("DNI sin número de soporte queda en revisión; normalizeVisionOutput sanea sexo ICAO y fechas", () => {
    const vision = normalizeVisionOutput(visionOf({ documentSupportNumber: null, sex: "M", dateOfBirth: "15/01/1990" }));
    assert.equal(vision.fields.sex, "H", "ICAO M → H (hombre, vocabulario SES)");
    assert.equal(vision.fields.dateOfBirth, undefined, "fecha fuera de ISO se descarta");
    const merged = mergeIdentityFields(null, vision);
    assert.ok(merged.needsReview.includes("documentSupportNumber"));
    assert.ok(merged.needsReview.includes("dateOfBirth"));
  });

  it("identityNameMatches compara sin acentos y admite los dos apellidos de la MRZ", () => {
    assert.equal(identityNameMatches({ firstName: "JOSE MARIA", surname1: "GARCIA", surname2: "LOPEZ" }, [{ firstName: "José María", surname1: "García", surname2: null }]), true);
    assert.equal(identityNameMatches({ firstName: "JOSE", surname1: "GARCIA LOPEZ" }, [{ firstName: "José", surname1: "García", surname2: "López" }]), true);
    assert.equal(identityNameMatches({ firstName: "JOSE", surname1: "GARCIA" }, [{ firstName: "Juan", surname1: "García", surname2: null }]), false);
    assert.equal(identityNameMatches({ firstName: "JOSE", surname1: "GARCIA" }, [{ firstName: "José", surname1: "Pérez", surname2: null }]), false);
    assert.equal(identityNameMatches({ firstName: undefined, surname1: "GARCIA" }, []), true, "sin nombre capturado no hay discrepancia que declarar");
    assert.equal(identityNameMatches({ firstName: "JOSE", surname1: "GARCIA" }, []), true, "sin nombres en la reserva no hay con qué comparar");
    assert.equal(identityNameMatches({ firstName: "JOSE", surname1: "GARCIA" }, [{ firstName: "", surname1: null, surname2: null }]), true);
  });
});
