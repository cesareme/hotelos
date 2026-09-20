// Cocoa 22 · ola 11 · lote api-datos: «Desconectar» on an email connection that
// was never authorised deletes the row instead of leaving a «Gmail ·
// desconectado» ghost (QA residue cmu4783rt004wfyztsms5lmme of Rías Altas).
// Tanda 7b · L3: propósito `pms_shadow` del buzón (purposeOf) y filtro puro de
// adjuntos (extensión csv | txt | xml | xlsx y tamaño ≤ 5 MiB), asunto y remitente.
// Tanda T9 · T9-07: propósito `documents` (purposeOf), filtro puro de adjuntos del
// módulo de documentos (isDocumentAttachment: pdf | jpg | jpeg | png | tif | tiff | xml
// ≤ DOCUMENT_MAX_BYTES), consulta de Gmail por propósito (gmailQueryFor) y adjuntos
// de la ingesta manual (normalizeManualAttachments).
// Pure core only: no database. Run from apps/api with
//   node --import tsx --test src/modules/integrations/email/__tests__/email-connections.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PMS_SHADOW_MAX_FILE_BYTES } from "@hotelos/shared";
import { BadRequestError } from "../../../../lib/http-error.js";
import {
  DOCUMENT_ATTACHMENT_EXTENSIONS,
  EMAIL_PURPOSES,
  disconnectOutcome,
  gmailQueryFor,
  isDocumentAttachment,
  isPmsShadowAttachment,
  matchesFromDomain,
  matchesSubjectFilter,
  normalizeManualAttachments,
  purposeOf,
  purposeReadsAttachments
} from "../email-reservation.service.js";
import { DOCUMENT_ATTACHMENT_DEFAULT_MAX_BYTES } from "../email-documents.service.js";
import { EMAIL_CONNECTION_PURPOSES } from "../../../../schemas/email-connections.schemas.js";

describe("disconnectOutcome — delete a never-authorised connection, disconnect the rest", () => {
  it("pending_auth without a refresh token was never authorised: delete", () => {
    assert.equal(disconnectOutcome({ status: "pending_auth", oauthRefreshToken: null }), "delete");
    assert.equal(disconnectOutcome({ status: "pending_auth", oauthRefreshToken: undefined }), "delete");
    assert.equal(disconnectOutcome({ status: "pending_auth", oauthRefreshToken: "" }), "delete");
  });

  it("anything that ever held credentials is kept as disconnected", () => {
    assert.equal(disconnectOutcome({ status: "pending_auth", oauthRefreshToken: "refresh-token" }), "disconnect");
    assert.equal(disconnectOutcome({ status: "connected", oauthRefreshToken: "refresh-token" }), "disconnect");
    assert.equal(disconnectOutcome({ status: "connected", oauthRefreshToken: null }), "disconnect", "IMAP and manual connections have no OAuth token");
    assert.equal(disconnectOutcome({ status: "error", oauthRefreshToken: null }), "disconnect");
    assert.equal(disconnectOutcome({ status: "disconnected", oauthRefreshToken: null }), "disconnect", "disconnecting twice stays idempotent");
  });
});

describe("purposeOf — configJson.purpose ?? reservation_ai (Tanda 7b)", () => {
  it("pms_shadow solo cuando lo dice configJson; cualquier otra cosa es el flujo IA → revisión humana", () => {
    assert.equal(purposeOf({ configJson: { purpose: "pms_shadow" } }), "pms_shadow");
    assert.equal(purposeOf({ configJson: { purpose: "pms_shadow", host: "imap.example.com" } }), "pms_shadow");
    assert.equal(purposeOf({ configJson: { purpose: "reservation_ai" } }), "reservation_ai");
    assert.equal(purposeOf({ configJson: {} }), "reservation_ai", "conexiones anteriores a la Tanda 7b");
    assert.equal(purposeOf({ configJson: { host: "imap.example.com", port: 993 } }), "reservation_ai");
    assert.equal(purposeOf({ configJson: null }), "reservation_ai");
    assert.equal(purposeOf({}), "reservation_ai");
    assert.equal(purposeOf({ configJson: { purpose: "otro" } }), "reservation_ai", "valor desconocido → por defecto");
    assert.equal(purposeOf({ configJson: ["pms_shadow"] }), "reservation_ai", "un array no es configuración");
  });
});

describe("isPmsShadowAttachment — extensión csv | txt | xml | xlsx y tamaño ≤ 5 MiB", () => {
  it("acepta los formatos de OPERA sin distinguir mayúsculas y hasta el límite exacto", () => {
    assert.equal(isPmsShadowAttachment({ fileName: "RESPONSYS_RESV_AUTO.csv", size: 1024 }), true);
    assert.equal(isPmsShadowAttachment({ fileName: "departure_all.TXT", size: 10 }), true);
    assert.equal(isPmsShadowAttachment({ fileName: "GEN_XMLBO_REVENUE.xml", size: PMS_SHADOW_MAX_FILE_BYTES }), true, "límite exacto incluido");
    assert.equal(isPmsShadowAttachment({ fileName: "manager_report.Xlsx", size: 0 }), true, "tamaño desconocido (0) pasa y se acota al descargar");
  });

  it("rechaza PDF, sin extensión, extensiones parecidas y ficheros por encima del límite", () => {
    assert.equal(isPmsShadowAttachment({ fileName: "manager_report.pdf", size: 10 }), false);
    assert.equal(isPmsShadowAttachment({ fileName: "informe", size: 10 }), false);
    assert.equal(isPmsShadowAttachment({ fileName: "datos.xls", size: 10 }), false);
    assert.equal(isPmsShadowAttachment({ fileName: "datos.csv.zip", size: 10 }), false);
    assert.equal(isPmsShadowAttachment({ fileName: "grande.csv", size: PMS_SHADOW_MAX_FILE_BYTES + 1 }), false);
    assert.equal(isPmsShadowAttachment({ fileName: "", size: 10 }), false);
  });
});

describe("matchesSubjectFilter / matchesFromDomain — filtros del buzón (sin filtro todo pasa)", () => {
  it("asunto: sin mayúsculas ni espacios sobrantes", () => {
    assert.equal(matchesSubjectFilter("Scheduled report: Departures", null), true);
    assert.equal(matchesSubjectFilter("Scheduled report: Departures", "  "), true);
    assert.equal(matchesSubjectFilter("Scheduled report: Departures", "departures"), true);
    assert.equal(matchesSubjectFilter("Scheduled report: Departures", " DEPARTURES "), true);
    assert.equal(matchesSubjectFilter("Scheduled report: Departures", "arrivals"), false);
    assert.equal(matchesSubjectFilter(null, "arrivals"), false);
  });

  it("remitente: dominio o subdominio del From, con o sin nombre para mostrar", () => {
    assert.equal(matchesFromDomain("scheduler@oracle.com", null), true);
    assert.equal(matchesFromDomain("OPERA Cloud <no-reply@mail.oracle.com>", "oracle.com"), true);
    assert.equal(matchesFromDomain("no-reply@oracle.com", "@oracle.com"), true, "arroba inicial tolerada");
    assert.equal(matchesFromDomain("no-reply@ORACLE.COM", "oracle.com"), true);
    assert.equal(matchesFromDomain("alguien@notoracle.com", "oracle.com"), false, "sufijo parecido no cuenta");
    assert.equal(matchesFromDomain("alguien@example.com", "oracle.com"), false);
    assert.equal(matchesFromDomain(null, "oracle.com"), false);
  });
});

// ---------------------------------------------------------------------------
// Tanda T9 · T9-07 — propósito `documents`
// ---------------------------------------------------------------------------

describe("purposeOf — documents (Tanda T9 · T9-07) y catálogo compartido con el esquema", () => {
  it("documents solo cuando lo dice configJson; el esquema zod y el servicio comparten los tres propósitos", () => {
    assert.equal(purposeOf({ configJson: { purpose: "documents" } }), "documents");
    assert.equal(purposeOf({ configJson: { purpose: "documents", fromDomain: "proveedor.example" } }), "documents");
    assert.equal(purposeOf({ configJson: { purpose: "Documents" } }), "reservation_ai", "sin normalizar mayúsculas: valor desconocido → por defecto");
    assert.deepEqual([...EMAIL_PURPOSES], ["reservation_ai", "pms_shadow", "documents"]);
    assert.deepEqual([...EMAIL_CONNECTION_PURPOSES], [...EMAIL_PURPOSES], "schemas/email-connections.schemas.ts ↔ email-reservation.service.ts");
    assert.equal(purposeReadsAttachments("documents"), true);
    assert.equal(purposeReadsAttachments("pms_shadow"), true);
    assert.equal(purposeReadsAttachments("reservation_ai"), false);
  });
});

describe("isDocumentAttachment — extensión pdf | jpg | jpeg | png | tif | tiff | xml y tamaño ≤ DOCUMENT_MAX_BYTES", () => {
  it("acepta los formatos del módulo de documentos sin distinguir mayúsculas y hasta el límite exacto", () => {
    assert.deepEqual([...DOCUMENT_ATTACHMENT_EXTENSIONS], ["pdf", "jpg", "jpeg", "png", "tif", "tiff", "xml"]);
    assert.equal(isDocumentAttachment({ fileName: "Factura_2026-0917.PDF", size: 1024 }), true);
    assert.equal(isDocumentAttachment({ fileName: "IMG_0042.jpg", size: 10 }), true);
    assert.equal(isDocumentAttachment({ fileName: "albaran.jpeg", size: 10 }), true);
    assert.equal(isDocumentAttachment({ fileName: "ticket.png", size: 10 }), true);
    assert.equal(isDocumentAttachment({ fileName: "scan.tif", size: 10 }), true);
    assert.equal(isDocumentAttachment({ fileName: "scan.tiff", size: 10 }), true);
    assert.equal(isDocumentAttachment({ fileName: "facturae.xml", size: DOCUMENT_ATTACHMENT_DEFAULT_MAX_BYTES }), true, "límite exacto incluido (25 MiB del contrato)");
    assert.equal(isDocumentAttachment({ fileName: "sin-tamano.pdf", size: 0 }), true, "tamaño desconocido (0) pasa y lo acota la captura (413)");
    assert.equal(isDocumentAttachment({ fileName: "x.pdf", size: 65_536 }, 65_536), true);
    assert.equal(isDocumentAttachment({ fileName: "x.pdf", size: 65_537 }, 65_536), false, "tope explícito = DOCUMENT_MAX_BYTES en vigor");
  });

  it("rechaza los formatos de OPERA (csv, txt, xlsx), ofimáticos, comprimidos, sin extensión y por encima del límite", () => {
    assert.equal(isDocumentAttachment({ fileName: "RESPONSYS_RESV_AUTO.csv", size: 10 }), false);
    assert.equal(isDocumentAttachment({ fileName: "departure_all.txt", size: 10 }), false);
    assert.equal(isDocumentAttachment({ fileName: "manager_report.xlsx", size: 10 }), false);
    assert.equal(isDocumentAttachment({ fileName: "contrato.docx", size: 10 }), false);
    assert.equal(isDocumentAttachment({ fileName: "facturas.zip", size: 10 }), false);
    assert.equal(isDocumentAttachment({ fileName: "factura.pdf.zip", size: 10 }), false);
    assert.equal(isDocumentAttachment({ fileName: "informe", size: 10 }), false);
    assert.equal(isDocumentAttachment({ fileName: "", size: 10 }), false);
    assert.equal(isDocumentAttachment({ fileName: "grande.pdf", size: DOCUMENT_ATTACHMENT_DEFAULT_MAX_BYTES + 1 }), false);
    // Los dos filtros son disjuntos salvo xml (OPERA revenue XML vs Facturae): cada buzón lo enruta por su propósito.
    assert.equal(isPmsShadowAttachment({ fileName: "GEN_XMLBO_REVENUE.xml", size: 10 }) && isDocumentAttachment({ fileName: "GEN_XMLBO_REVENUE.xml", size: 10 }), true);
    assert.equal(isPmsShadowAttachment({ fileName: "factura.pdf", size: 10 }), false);
  });
});

describe("gmailQueryFor — consulta de Gmail según el propósito", () => {
  it("documents y pms_shadow listan solo correos con adjunto de 3 días (+ from: con filtro); reservation_ai lee 30 días", () => {
    assert.equal(gmailQueryFor({ purpose: "documents" }), "has:attachment newer_than:3d");
    assert.equal(gmailQueryFor({ purpose: "documents", fromDomain: null }), "has:attachment newer_than:3d");
    assert.equal(gmailQueryFor({ purpose: "documents", fromDomain: "@proveedor.example" }), "has:attachment newer_than:3d from:proveedor.example", "arroba inicial tolerada");
    assert.equal(gmailQueryFor({ purpose: "pms_shadow", fromDomain: "oracle.com" }), "has:attachment newer_than:3d from:oracle.com");
    assert.equal(gmailQueryFor({ purpose: "pms_shadow" }), "has:attachment newer_than:3d");
    assert.equal(gmailQueryFor({ purpose: "reservation_ai", fromDomain: "booking.com" }), "newer_than:30d", "el flujo de reservas no filtra por remitente");
  });
});

describe("normalizeManualAttachments — adjuntos pegados en la ingesta manual", () => {
  it("base64 estándar → descarga en memoria, tamaño decodificado, attachmentId manual-<n>; sin adjuntos → lista vacía", async () => {
    const pdf = Buffer.from("%PDF-1.4\n%prueba\n", "latin1");
    const [first, second] = normalizeManualAttachments([
      { fileName: "factura.pdf", mimeType: "application/pdf", base64: pdf.toString("base64") },
      { fileName: "foto.jpg", base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64") }
    ]);
    assert.equal(first!.attachmentId, "manual-1");
    assert.equal(first!.size, pdf.length);
    assert.equal(first!.mimeType, "application/pdf");
    assert.ok((await first!.download()).equals(pdf));
    assert.equal(second!.attachmentId, "manual-2");
    assert.equal(second!.mimeType, "application/octet-stream", "sin MIME declarado la captura lo deduce por extensión (mimeTypeForAttachment)");
    assert.equal(second!.size, 4);
    assert.deepEqual(normalizeManualAttachments(undefined), []);
    assert.deepEqual(normalizeManualAttachments([]), []);
  });

  it("base64 no válido (prefijo data:, espacios, longitud) → 400 antes de tocar nada", () => {
    assert.throws(() => normalizeManualAttachments([{ fileName: "x.pdf", base64: "data:application/pdf;base64,JVBERi0=" }]), BadRequestError);
    assert.throws(() => normalizeManualAttachments([{ fileName: "x.pdf", base64: "JVBE Ri0=" }]), BadRequestError);
    assert.throws(() => normalizeManualAttachments([{ fileName: "x.pdf", base64: "JVBERi0" }]), BadRequestError);
  });
});
