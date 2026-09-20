// Unit tests · Tanda T9 · lote T9-05a — esquemas zod de las rutas de documentos.
// Sin base de datos, sin red. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/documents-schemas.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestError } from "../../../lib/http-error.js";
import { parseOr400 } from "../../rate-manager/rate-grid.schemas.js";
import {
  base64DecodedSize,
  decodeBase64,
  DocumentAddFileRequestSchema,
  DocumentFileQuerySchema,
  DocumentListQuerySchema,
  DocumentPageNoSchema,
  DocumentQueueQuerySchema,
  DocumentRecaptureRequestSchema,
  DocumentUploadRequestSchema,
  isBase64
} from "../../../schemas/documents.schemas.js";

const PDF_B64 = Buffer.from("%PDF-1.4\n%%EOF\n", "latin1").toString("base64");
const file = (overrides: Record<string, unknown> = {}) => ({ fileName: "factura.pdf", mimeType: "application/pdf", base64: PDF_B64, ...overrides });

function expect400(fn: () => unknown): BadRequestError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BadRequestError, "BadRequestError esperado");
    assert.equal((error.details as { code?: string }).code, "VALIDATION_ERROR");
    return error;
  }
  assert.fail("se esperaba un 400");
}

describe("base64", () => {
  it("isBase64: alfabeto estándar, múltiplo de 4, sin espacios ni prefijo data:", () => {
    assert.equal(isBase64(PDF_B64), true);
    assert.equal(isBase64(""), false);
    assert.equal(isBase64("abc"), false);
    assert.equal(isBase64("ab$d"), false);
    assert.equal(isBase64("QUJD\n"), false);
    assert.equal(isBase64(`data:application/pdf;base64,${PDF_B64}`), false);
    assert.equal(isBase64("QQ=="), true);
    assert.equal(isBase64("Q==="), false);
  });

  it("base64DecodedSize calcula los bytes sin decodificar", () => {
    assert.equal(base64DecodedSize(""), 0);
    assert.equal(base64DecodedSize("QUJD"), 3);
    assert.equal(base64DecodedSize("QUI="), 2);
    assert.equal(base64DecodedSize("QQ=="), 1);
    const big = Buffer.alloc(30_001, 7).toString("base64");
    assert.equal(base64DecodedSize(big), 30_001);
    assert.equal(decodeBase64(big).length, 30_001);
  });

  it("decodeBase64 devuelve los bytes originales", () => {
    assert.equal(decodeBase64(PDF_B64).toString("latin1"), "%PDF-1.4\n%%EOF\n");
  });
});

describe("DocumentUploadRequestSchema", () => {
  it("acepta el cuerpo mínimo y los opcionales del contrato", () => {
    const parsed = DocumentUploadRequestSchema.parse({ files: [file()], kindHint: "invoice", note: " nota ", allowDuplicate: true, source: "mobile", splitPages: false });
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.kindHint, "invoice");
    assert.equal(parsed.note, "nota");
    assert.equal(parsed.source, "mobile");
  });

  it("21 ficheros → 400 VALIDATION_ERROR", () => {
    const body = { files: Array.from({ length: 21 }, (_, i) => file({ fileName: `f${i}.pdf` })) };
    const error = expect400(() => parseOr400(DocumentUploadRequestSchema, body, "Captura de documentos"));
    assert.match(error.message, /20 ficheros/);
    assert.equal(DocumentUploadRequestSchema.safeParse({ files: Array.from({ length: 20 }, (_, i) => file({ fileName: `f${i}.pdf` })) }).success, true);
  });

  it("0 ficheros o files no lista → 400", () => {
    expect400(() => parseOr400(DocumentUploadRequestSchema, { files: [] }, "Captura de documentos"));
    expect400(() => parseOr400(DocumentUploadRequestSchema, { files: "x" }, "Captura de documentos"));
    expect400(() => parseOr400(DocumentUploadRequestSchema, {}, "Captura de documentos"));
  });

  it("base64 inválido → 400 con el path del fichero", () => {
    const error = expect400(() => parseOr400(DocumentUploadRequestSchema, { files: [file({ base64: "no-es-base64!" })] }, "Captura de documentos"));
    assert.match(error.message, /files\.0\.base64/);
    expect400(() => parseOr400(DocumentUploadRequestSchema, { files: [file({ base64: `data:application/pdf;base64,${PDF_B64}` })] }, "Captura de documentos"));
    expect400(() => parseOr400(DocumentUploadRequestSchema, { files: [file({ base64: "" })] }, "Captura de documentos"));
  });

  it("kindHint fuera del catálogo → 400", () => {
    const error = expect400(() => parseOr400(DocumentUploadRequestSchema, { files: [file()], kindHint: "ticket" }, "Captura de documentos"));
    assert.match(error.message, /kindHint/);
  });

  it("source solo admite los canales declarables por el cliente (email / e_invoice / scanner los fija el servidor)", () => {
    expect400(() => parseOr400(DocumentUploadRequestSchema, { files: [file()], source: "email" }, "Captura de documentos"));
    expect400(() => parseOr400(DocumentUploadRequestSchema, { files: [file()], source: "scanner" }, "Captura de documentos"));
    assert.equal(DocumentUploadRequestSchema.safeParse({ files: [file()], source: "api" }).success, true);
  });

  it(".strict(): clave desconocida → 400; fileName con barras, control o > 200 → 400", () => {
    expect400(() => parseOr400(DocumentUploadRequestSchema, { files: [file()], extra: 1 }, "Captura de documentos"));
    expect400(() => parseOr400(DocumentUploadRequestSchema, { files: [file({ extra: 1 })] }, "Captura de documentos"));
    expect400(() => parseOr400(DocumentUploadRequestSchema, { files: [file({ fileName: "../etc/passwd" })] }, "Captura de documentos"));
    expect400(() => parseOr400(DocumentUploadRequestSchema, { files: [file({ fileName: "a\nb.pdf" })] }, "Captura de documentos"));
    expect400(() => parseOr400(DocumentUploadRequestSchema, { files: [file({ fileName: "x".repeat(201) })] }, "Captura de documentos"));
    assert.equal(DocumentUploadRequestSchema.safeParse({ files: [file({ fileName: "Factura Nº 12 (copia).pdf" })] }).success, true);
  });

  it("note > 2000 → 400; allowDuplicate no booleano → 400", () => {
    expect400(() => parseOr400(DocumentUploadRequestSchema, { files: [file()], note: "n".repeat(2001) }, "Captura de documentos"));
    expect400(() => parseOr400(DocumentUploadRequestSchema, { files: [file()], allowDuplicate: "yes" }, "Captura de documentos"));
  });
});

describe("DocumentAddFileRequestSchema / DocumentRecaptureRequestSchema", () => {
  it("role solo original | derived; recaptura sin role", () => {
    assert.equal(DocumentAddFileRequestSchema.parse({ ...file(), role: "derived", note: "reverso" }).role, "derived");
    expect400(() => parseOr400(DocumentAddFileRequestSchema, { ...file(), role: "label" }, "Fichero adicional"));
    expect400(() => parseOr400(DocumentAddFileRequestSchema, { ...file(), role: "page_image" }, "Fichero adicional"));
    assert.equal(DocumentRecaptureRequestSchema.safeParse({ ...file(), note: "reescaneado" }).success, true);
    expect400(() => parseOr400(DocumentRecaptureRequestSchema, { ...file(), role: "original" }, "Recaptura"));
  });
});

describe("DocumentListQuerySchema / DocumentQueueQuerySchema", () => {
  it("status admite lista separada por comas o clave repetida, sin repetidos", () => {
    assert.deepEqual(DocumentListQuerySchema.parse({ status: "captured,sent_to_office,captured" }).status, ["captured", "sent_to_office"]);
    assert.deepEqual(DocumentListQuerySchema.parse({ status: ["captured", "in_review"] }).status, ["captured", "in_review"]);
    expect400(() => parseOr400(DocumentListQuerySchema, { status: "captured,open" }, "Filtro"));
    expect400(() => parseOr400(DocumentListQuerySchema, { status: "" }, "Filtro"));
  });

  it("fechas reales, q ≤ 120, booleanos de query y paso de limit / cursor / envelope", () => {
    const parsed = DocumentListQuerySchema.parse({ from: "2026-09-01", to: "2026-09-30", q: "DOC-", slaBreachedOnly: "1", limit: "10", cursor: "abc", envelope: "1", kind: "invoice", physicalStatus: "at_centre" });
    assert.equal(parsed.slaBreachedOnly, true);
    assert.equal(parsed.limit, "10");
    assert.equal(parsed.kind, "invoice");
    expect400(() => parseOr400(DocumentListQuerySchema, { from: "2026-02-30" }, "Filtro"));
    expect400(() => parseOr400(DocumentListQuerySchema, { to: "30/09/2026" }, "Filtro"));
    expect400(() => parseOr400(DocumentListQuerySchema, { q: "q".repeat(121) }, "Filtro"));
    expect400(() => parseOr400(DocumentListQuerySchema, { slaBreachedOnly: "yes" }, "Filtro"));
    expect400(() => parseOr400(DocumentListQuerySchema, { kind: "ticket" }, "Filtro"));
    expect400(() => parseOr400(DocumentListQuerySchema, { physicalStatus: "lost" }, "Filtro"));
    expect400(() => parseOr400(DocumentListQuerySchema, { unknown: "1" }, "Filtro"));
  });

  it("la cola admite propertyId; la bandeja no", () => {
    assert.equal(DocumentQueueQuerySchema.parse({ propertyId: "prop_x" }).propertyId, "prop_x");
    expect400(() => parseOr400(DocumentListQuerySchema, { propertyId: "prop_x" }, "Filtro"));
  });
});

describe("DocumentFileQuerySchema / DocumentPageNoSchema", () => {
  it("?inline=1 → true; clave desconocida → 400", () => {
    assert.equal(DocumentFileQuerySchema.parse({ inline: "1" }).inline, true);
    assert.equal(DocumentFileQuerySchema.parse({ inline: "false" }).inline, false);
    assert.equal(DocumentFileQuerySchema.parse({}).inline, undefined);
    expect400(() => parseOr400(DocumentFileQuerySchema, { download: "1" }, "Filtro"));
  });

  it(":n es un entero ≥ 1", () => {
    assert.equal(DocumentPageNoSchema.parse("3"), 3);
    expect400(() => parseOr400(DocumentPageNoSchema, "0", "Página"));
    expect400(() => parseOr400(DocumentPageNoSchema, "x", "Página"));
    expect400(() => parseOr400(DocumentPageNoSchema, "1.5", "Página"));
  });
});
