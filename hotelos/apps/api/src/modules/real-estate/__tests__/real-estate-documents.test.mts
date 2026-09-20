// Unit tests · documentación del activo inmobiliario (Tanda ACT · L3). Sin BD:
// vigencia derivada con los días de aviso por categoría, DTO (hasFile),
// herencia de metadatos en una versión nueva, clave del almacén de T9 con el
// prefijo red_, campos de fichero inline / disk, validación del fichero
// (413 antes de decodificar, 400 MIME / magic bytes), guardas de legalHold y
// versiones y la sincronización con ComplianceItem. Desde apps/api:
//   node --import tsx --test src/modules/real-estate/__tests__/real-estate-documents.test.mts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { RealEstateDocument } from "@prisma/client";
import type { UserContext } from "../../../lib/demo-store.js";
import { HttpError } from "../../../lib/http-error.js";
import { blankPagePdf, htmlDisguisedAsPdf, tinyPng } from "../../documents/__tests__/fixtures.js";
import { utcDay } from "../../payables/money.js";
import {
  assertLegalHoldPermission,
  assertNotOnLegalHold,
  assertValidityOrdered,
  assertVersionable,
  buildRealEstateDocumentStorageKey,
  bytesOfDocument,
  canSeePropertyOnlyDocuments,
  complianceItemSyncData,
  documentStatusOf,
  expiringSoonDaysFor,
  hasDocumentFile,
  inheritVersionFields,
  isDocumentVisibleTo,
  metadataOf,
  prepareDocumentFile,
  REAL_ESTATE_DOCUMENT_AUDIT_ACTIONS,
  storedFileFields,
  toRealEstateDocumentRecord
} from "../documents.service.js";
import { realEstateErrorCodeOf } from "../errors.js";

const TODAY = "2026-09-20";
const CREATED = new Date("2026-09-20T10:00:00.000Z");
const PDF = blankPagePdf();
const PDF_SHA = createHash("sha256").update(PDF).digest("hex");
const ORG = "org_l2_act_unit";
const PROP = "prop_act_unit";

function documentRow(overrides: Partial<RealEstateDocument> = {}): RealEstateDocument {
  return {
    id: "red_0123456789abcdef",
    organizationId: ORG,
    propertyId: PROP,
    assetId: "rea_1",
    category: "legal",
    kind: "escritura",
    title: "Escritura de compraventa",
    issuerName: "Notaría de prueba",
    issueDate: utcDay("2019-03-01"),
    validFrom: null,
    validUntil: null,
    renewalDays: null,
    version: 1,
    supersedesId: null,
    supersededById: null,
    cdeState: "publicado",
    confidentiality: "interno",
    linkedEntityType: null,
    linkedEntityId: null,
    complianceRequirementCode: null,
    fileName: "escritura.pdf",
    mimeType: "application/pdf",
    sizeBytes: PDF.length,
    sha256: PDF_SHA,
    storageKind: "disk",
    storageKey: `org/${ORG}/prop/${PROP}/doc/red_0123456789abcdef/${PDF_SHA}.pdf`,
    inline: null,
    encrypted: true,
    uploadedBy: "usr_act",
    retentionUntil: null,
    legalHold: false,
    deletedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides
  };
}

function context(permissions: UserContext["permissions"]): UserContext {
  return { organizationId: ORG, propertyId: PROP, userId: "usr_act", fullName: "ACT unit", deviceId: "unit", permissions };
}

const codeOf = (error: unknown): string | undefined => (error as { details?: { code?: string } }).details?.code;

describe("vigencia derivada con los días de aviso por categoría", () => {
  it("expiringSoonDaysFor: 90 en inspecciones y seguros; el perfil del centro (30 por defecto) en el resto", () => {
    assert.equal(expiringSoonDaysFor("inspecciones"), 90);
    assert.equal(expiringSoonDaysFor("seguros", 15), 90);
    assert.equal(expiringSoonDaysFor("legal"), 30);
    assert.equal(expiringSoonDaysFor("licencias", 45), 45);
  });

  it("documentStatusOf: la misma fecha es vigente en legal y caduca_pronto en seguros; sin_fecha, caducado y sustituido", () => {
    const in60 = utcDay("2026-11-19");
    assert.equal(documentStatusOf(documentRow({ category: "legal", validUntil: in60 }), TODAY), "vigente");
    assert.equal(documentStatusOf(documentRow({ category: "seguros", validUntil: in60 }), TODAY), "caduca_pronto");
    assert.equal(documentStatusOf(documentRow({ category: "legal", validUntil: in60 }), TODAY, 60), "caduca_pronto", "perfil con 60 días de aviso");
    assert.equal(documentStatusOf(documentRow({ validUntil: null }), TODAY), "sin_fecha");
    assert.equal(documentStatusOf(documentRow({ validUntil: utcDay("2026-09-19") }), TODAY), "caducado");
    assert.equal(documentStatusOf(documentRow({ validUntil: in60, supersededById: "red_next" }), TODAY), "sustituido", "una versión posterior manda sobre la fecha");
  });

  it("toRealEstateDocumentRecord: días ISO, status derivado, hasFile y sin bytes ni clave del almacén", () => {
    const record = toRealEstateDocumentRecord(documentRow({ validUntil: utcDay("2027-01-31") }), TODAY);
    assert.equal(record.issueDate, "2019-03-01");
    assert.equal(record.validUntil, "2027-01-31");
    assert.equal(record.status, "vigente");
    assert.equal(record.hasFile, true);
    assert.equal(record.sha256, PDF_SHA);
    assert.equal(record.deletedAt, null);
    assert.equal("storageKey" in record, false);
    assert.equal("inline" in record, false);
    const bare = toRealEstateDocumentRecord(documentRow({ sha256: null, storageKey: null, fileName: null, mimeType: null, sizeBytes: null }), TODAY);
    assert.equal(bare.hasFile, false, "«Sin fichero»");
    assert.equal(hasDocumentFile(documentRow({ storageKind: "inline", storageKey: null, inline: PDF.toString("base64") })), true);
    assert.equal(hasDocumentFile(documentRow({ storageKind: "inline", storageKey: null, inline: null })), false);
  });
});

describe("versiones: herencia de metadatos y guardas", () => {
  it("inheritVersionFields: hereda lo no enviado, el cuerpo manda, null borra; legalHold y file no forman parte", () => {
    const previous = documentRow({ category: "seguros", kind: "poliza", title: "Póliza multirriesgo", issuerName: "Aseguradora de prueba SA", validFrom: utcDay("2025-10-01"), validUntil: utcDay("2026-09-30"), complianceRequirementCode: "SEG-RC", renewalDays: 30, legalHold: true });
    const fields = inheritVersionFields(previous, { validFrom: utcDay("2026-10-01"), validUntil: utcDay("2027-09-30"), issuerName: null });
    assert.equal(fields.category, "seguros");
    assert.equal(fields.kind, "poliza");
    assert.equal(fields.title, "Póliza multirriesgo");
    assert.equal(fields.issuerName, null, "null borra el valor heredado");
    assert.equal(fields.validFrom?.toISOString().slice(0, 10), "2026-10-01");
    assert.equal(fields.validUntil?.toISOString().slice(0, 10), "2027-09-30");
    assert.equal(fields.complianceRequirementCode, "SEG-RC");
    assert.equal(fields.renewalDays, 30);
    assert.equal("legalHold" in fields, false);
    assert.equal("file" in fields, false);
    assert.equal("supersedesId" in fields, false);
    assert.deepEqual(metadataOf({ title: "x", issueDate: undefined, file: { fileName: "a.pdf", mimeType: "application/pdf", base64: "AAAA" } } as never), { title: "x" });
  });

  it("assertVersionable → 409 DOCUMENT_SUPERSEDED cuando ya hay una versión posterior", () => {
    assert.doesNotThrow(() => assertVersionable(documentRow()));
    try {
      assertVersionable(documentRow({ supersededById: "red_next", version: 2 }));
      assert.fail("debía lanzar");
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      assert.equal(realEstateErrorCodeOf(error), "DOCUMENT_SUPERSEDED");
    }
  });

  it("assertValidityOrdered → 400 VALIDATION_ERROR si validUntil es anterior a validFrom (también con fechas heredadas)", () => {
    assert.doesNotThrow(() => assertValidityOrdered({ validFrom: utcDay("2026-01-01"), validUntil: utcDay("2026-12-31") }));
    assert.doesNotThrow(() => assertValidityOrdered({ validFrom: null, validUntil: utcDay("2026-12-31") }));
    assert.throws(() => assertValidityOrdered({ validFrom: utcDay("2027-01-01"), validUntil: utcDay("2026-12-31") }), (error: unknown) => error instanceof HttpError && error.statusCode === 400 && codeOf(error) === "VALIDATION_ERROR");
  });
});

describe("almacén de T9: clave con prefijo red_, campos de fichero y validación", () => {
  it("buildRealEstateDocumentStorageKey → org/<org>/prop/<prop>/doc/red_<id>/<sha>.<ext>; rechaza ids sin red_", () => {
    const key = buildRealEstateDocumentStorageKey({ organizationId: ORG, propertyId: PROP, documentId: "red_0123456789abcdef", sha256: PDF_SHA.toUpperCase(), ext: "pdf" });
    assert.equal(key, `org/${ORG}/prop/${PROP}/doc/red_0123456789abcdef/${PDF_SHA}.pdf`);
    assert.throws(() => buildRealEstateDocumentStorageKey({ organizationId: ORG, propertyId: PROP, documentId: "doc_0123456789abcdef", sha256: PDF_SHA, ext: "pdf" }), RangeError);
  });

  it("storedFileFields: inline guarda el base64 en la fila y storageKey null; disk cifrado guarda la clave y encrypted", () => {
    const prepared = prepareDocumentFile({ fileName: "escritura.pdf", mimeType: "application/pdf", base64: PDF.toString("base64") }, 1024 * 1024);
    const key = `org/${ORG}/prop/${PROP}/doc/red_0123456789abcdef/${PDF_SHA}.pdf`;
    const inline = storedFileFields({ kind: "inline" }, prepared, key, "usr_act");
    assert.equal(inline.storageKind, "inline");
    assert.equal(inline.storageKey, null);
    assert.equal(inline.inline, PDF.toString("base64"));
    assert.equal(inline.encrypted, false);
    assert.equal(inline.sha256, PDF_SHA);
    assert.equal(inline.sizeBytes, PDF.length);
    assert.equal(inline.uploadedBy, "usr_act");
    const disk = storedFileFields({ kind: "disk", encrypts: true }, prepared, key, null);
    assert.equal(disk.storageKey, key);
    assert.equal(disk.inline, null);
    assert.equal(disk.encrypted, true);
    const plain = storedFileFields({ kind: "disk", encrypts: false }, prepared, key, null);
    assert.equal(plain.encrypted, false);
  });

  it("prepareDocumentFile: 413 DOCUMENT_TOO_LARGE antes de decodificar, 400 DOCUMENT_MIME_NOT_ALLOWED y DOCUMENT_CONTENT_MISMATCH", () => {
    // Base64 que ni siquiera es un PDF: si el 413 no fuera previo a la decodificación saldría el 400 de magic bytes.
    const big = Buffer.alloc(70_000, 0x41).toString("base64");
    assert.throws(() => prepareDocumentFile({ fileName: "grande.pdf", mimeType: "application/pdf", base64: big }, 65_536), (error: unknown) => error instanceof HttpError && error.statusCode === 413 && codeOf(error) === "DOCUMENT_TOO_LARGE" && (error.details as { maxBytes: number }).maxBytes === 65_536);
    assert.throws(() => prepareDocumentFile({ fileName: "x.html", mimeType: "text/html", base64: Buffer.from("<html></html>").toString("base64") }, 65_536), (error: unknown) => error instanceof HttpError && error.statusCode === 400 && codeOf(error) === "DOCUMENT_MIME_NOT_ALLOWED");
    assert.throws(() => prepareDocumentFile({ fileName: "x.pdf", mimeType: "application/pdf", base64: htmlDisguisedAsPdf().toString("base64") }, 65_536), (error: unknown) => error instanceof HttpError && error.statusCode === 400 && codeOf(error) === "DOCUMENT_CONTENT_MISMATCH");
    const png = prepareDocumentFile({ fileName: "plano.png", mimeType: "image/png", base64: tinyPng().toString("base64") }, 65_536);
    assert.equal(png.mime, "image/png");
    assert.equal(png.ext, "png");
    assert.equal(png.sha256, createHash("sha256").update(tinyPng()).digest("hex"));
  });

  it("bytesOfDocument: inline decodifica la fila, disk pide al almacén, sin fichero → 404 DOCUMENT_NO_FILE", async () => {
    const storage = { get: async (key: string) => (key.endsWith(".pdf") ? { bytes: PDF, mimeType: "application/pdf" } : null) };
    const fromInline = await bytesOfDocument(storage, documentRow({ storageKind: "inline", storageKey: null, inline: PDF.toString("base64") }));
    assert.ok(fromInline.equals(PDF));
    const fromDisk = await bytesOfDocument(storage, documentRow());
    assert.ok(fromDisk.equals(PDF));
    await assert.rejects(bytesOfDocument(storage, documentRow({ sha256: null, storageKey: null })), (error: unknown) => error instanceof HttpError && error.statusCode === 404 && realEstateErrorCodeOf(error) === "DOCUMENT_NO_FILE");
    await assert.rejects(bytesOfDocument(storage, documentRow({ storageKey: `org/${ORG}/prop/${PROP}/doc/red_0123456789abcdef/${PDF_SHA}.png` })), (error: unknown) => realEstateErrorCodeOf(error) === "DOCUMENT_NO_FILE", "clave sin bytes en el almacén");
  });
});

describe("visibilidad por documento (diseño §5.1 wip · solo_propiedad; ACT-REV-11 / ACT-REV-03)", () => {
  const reader = { userId: "usr_reader", permissions: ["real_estate.read"] as UserContext["permissions"] };
  const manager = { userId: "usr_manager", permissions: ["real_estate.read", "real_estate.manage"] as UserContext["permissions"] };
  const owner = { userId: "usr_owner", permissions: ["real_estate.read"] as UserContext["permissions"], assignments: [{ templateKey: "owner" }] };
  const uploader = { userId: "usr_uploader", permissions: ["real_estate.read", "real_estate.documents.manage"] as UserContext["permissions"] };

  it("wip: solo quien lo subió o real_estate.manage; publicado / compartido / archivado: todos", () => {
    const wip = documentRow({ cdeState: "wip", confidentiality: "interno", uploadedBy: "usr_uploader" });
    assert.equal(isDocumentVisibleTo(wip, uploader), true);
    assert.equal(isDocumentVisibleTo(wip, manager), true);
    assert.equal(isDocumentVisibleTo(wip, reader), false);
    assert.equal(isDocumentVisibleTo(wip, owner), false, "owner sin real_estate.manage no ve el trabajo en curso de otro");
    assert.equal(isDocumentVisibleTo(documentRow({ cdeState: "wip", uploadedBy: null }), reader), false, "sin uploadedBy solo real_estate.manage");
    for (const cdeState of ["publicado", "compartido", "archivado"]) assert.equal(isDocumentVisibleTo(documentRow({ cdeState, confidentiality: "interno", uploadedBy: "otro" }), reader), true, cdeState);
  });

  it("solo_propiedad: real_estate.manage o plantilla owner; el resto ni lo lista", () => {
    const restricted = documentRow({ cdeState: "publicado", confidentiality: "solo_propiedad", uploadedBy: "usr_uploader" });
    assert.equal(canSeePropertyOnlyDocuments(reader), false);
    assert.equal(canSeePropertyOnlyDocuments(manager), true);
    assert.equal(canSeePropertyOnlyDocuments(owner), true);
    assert.equal(isDocumentVisibleTo(restricted, reader), false);
    assert.equal(isDocumentVisibleTo(restricted, uploader), false, "subirlo no da derecho a verlo después si no es de la propiedad");
    assert.equal(isDocumentVisibleTo(restricted, manager), true);
    assert.equal(isDocumentVisibleTo(restricted, owner), true);
  });
});

describe("legalHold", () => {
  it("assertNotOnLegalHold → 409 LEGAL_HOLD con documentId", () => {
    assert.doesNotThrow(() => assertNotOnLegalHold(documentRow()));
    assert.throws(() => assertNotOnLegalHold(documentRow({ legalHold: true })), (error: unknown) => error instanceof HttpError && error.statusCode === 409 && realEstateErrorCodeOf(error) === "LEGAL_HOLD" && (error.details as { documentId: string }).documentId === "red_0123456789abcdef");
  });

  it("assertLegalHoldPermission: legalHold en el cuerpo exige real_estate.manage; sin legalHold no exige nada", () => {
    assert.doesNotThrow(() => assertLegalHoldPermission(context(["real_estate.documents.manage"]), { title: "x" } as never));
    assert.doesNotThrow(() => assertLegalHoldPermission(context(["real_estate.documents.manage", "real_estate.manage"]), { legalHold: true }));
    assert.throws(() => assertLegalHoldPermission(context(["real_estate.documents.manage"]), { legalHold: true }), (error: unknown) => (error as { statusCode?: number }).statusCode === 403);
    assert.throws(() => assertLegalHoldPermission(context(["real_estate.documents.manage"]), { legalHold: false }), (error: unknown) => (error as { statusCode?: number }).statusCode === 403, "también para quitar la retención");
  });
});

describe("sincronización con ComplianceItem (como createComplianceDocument)", () => {
  const dates = { issueDate: utcDay("2026-01-15"), validUntil: utcDay("2027-01-14") };

  it("sin control previo: COMPLIANT con las fechas del documento y applies del catálogo", () => {
    const sync = complianceItemSyncData(null, { defaultApplies: false }, dates);
    assert.deepEqual(sync.update, { issueDate: dates.issueDate, expiryDate: dates.validUntil, status: "COMPLIANT" });
    assert.deepEqual(sync.create, { applies: false, status: "COMPLIANT", issueDate: dates.issueDate, expiryDate: dates.validUntil });
  });

  it("NON_COMPLIANT y UNDER_REVIEW conservan el estado; PENDING pasa a COMPLIANT; sin fechas no se pisan", () => {
    assert.equal("status" in complianceItemSyncData({ status: "NON_COMPLIANT", applies: true }, { defaultApplies: true }, dates).update, false);
    assert.equal("status" in complianceItemSyncData({ status: "UNDER_REVIEW", applies: true }, { defaultApplies: true }, dates).update, false);
    assert.equal(complianceItemSyncData({ status: "PENDING", applies: true }, { defaultApplies: true }, dates).update.status, "COMPLIANT");
    const noDates = complianceItemSyncData({ status: "PENDING", applies: false }, { defaultApplies: true }, { issueDate: null, validUntil: null });
    assert.deepEqual(noDates.update, { status: "COMPLIANT" });
    assert.equal(noDates.create.applies, false, "applies del control existente manda sobre el catálogo");
  });

  it("las acciones de auditoría del módulo llevan el prefijo REAL_ESTATE_DOCUMENT_", () => {
    for (const action of Object.values(REAL_ESTATE_DOCUMENT_AUDIT_ACTIONS)) assert.match(action, /^REAL_ESTATE_DOCUMENT_[A-Z_]+$/);
    assert.equal(REAL_ESTATE_DOCUMENT_AUDIT_ACTIONS.downloaded, "REAL_ESTATE_DOCUMENT_DOWNLOADED");
  });
});
