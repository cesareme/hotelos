import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Tanda ACT · lote ACT-F2 · Finanzas › Activo inmobiliario › Documentación
// (docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md §8): los helpers puros y las
// piezas de presentación de RealEstateDocumentsScreen.tsx se ejecutan de verdad
// bajo node --test (filtro «Solo vigentes», fila sin fichero, visor, formularios) y
// la subida pasa por el cliente REAL (services/realEstateApi.ts → api-client) con
// `fetch` sustituido para capturar el cuerpo que viaja al API: el fichero va en
// base64 estándar SIN prefijo `data:`. El módulo llega a services/api-client.ts
// (`import.meta.env`, que define Vite): el gancho lo inyecta como
// operations/__tests__/checkin-drawer.test.mts; window / localStorage / FileReader
// se emulan como el smoke de ACT-F0. Las reglas Cocoa 22 (cero `style={`, sin
// elementos crudos, sin literales de color, sin emoji, sin fetch crudo, formato
// solo por lib/format) se anclan sobre el código fuente.

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env = { VITE_API_URL: "http://127.0.0.1:65530", MODE: "test", DEV: false };\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

// ---- Emulación mínima del navegador (antes de importar: activeProperty.ts mira `window` al cargar) ----
const store = new Map<string, string>();
const localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() {
    return store.size;
  }
};
(globalThis as Record<string, unknown>).window = Object.assign(new EventTarget(), { localStorage, location: { reload() {} } });

class FileReaderShim {
  result: string | null = null;
  error: Error | null = null;
  onload: null | (() => void) = null;
  onerror: null | (() => void) = null;
  readAsDataURL(blob: Blob) {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload?.();
      },
      (error: Error) => {
        this.error = error;
        this.onerror?.();
      }
    );
  }
}
(globalThis as Record<string, unknown>).FileReader = FileReaderShim;

type Captured = { url: string; method: string; headers: Record<string, string>; body: unknown };
const captured: Captured[] = [];
let nextResponse: () => Response = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  captured.push({ url: String(input), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
  return nextResponse();
}) as typeof fetch;

const screenModule = await import("../RealEstateDocumentsScreen.tsx");
const { setSession } = await import("../../../services/auth-storage.ts");
const { writeActiveProperty } = await import("../../../services/activeProperty.ts");
const { ApiError } = await import("../../../services/api-client.ts");
const { REAL_ESTATE_ERROR_MESSAGES } = await import("../real-estate-helpers.ts");
const {
  DOCUMENT_COLUMNS,
  DOCUMENT_FILTER_DEFAULTS,
  DocumentFileCell,
  DocumentValidityBadge,
  DocumentViewerPane,
  NO_FILE_LABEL,
  NON_VALID_STATUSES,
  RealEstateDocumentsScreen,
  datesPatchOf,
  documentFailureMessage,
  documentIsValid,
  documentOpensViewer,
  documentRowTone,
  emptyUploadForm,
  fileLabel,
  fileNameFromDisposition,
  filterDocuments,
  linkedLabel,
  submitDocumentUpload,
  titleFromFileName,
  uploadMetaOf,
  validateDatesForm,
  validateUploadForm,
  validityRange,
  viewerKindOf
} = screenModule;

const SOURCE = readFileSync(new URL("../RealEstateDocumentsScreen.tsx", import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

type Doc = Parameters<typeof filterDocuments>[0][number] & { id: string; hasFile: boolean; validUntil: string | null; validFrom: string | null; issueDate: string | null; renewalDays: number | null; sizeBytes: number | null; mimeType: string | null; complianceRequirementCode: string | null; linkedEntityType: "unit" | "tenure" | "tax_receipt" | "inspection" | "insurance" | "capex_project" | "fixed_asset" | null; linkedEntityId: string | null; version: number };

function doc(id: string, over: Partial<Doc> = {}): Doc {
  return {
    id,
    title: `Documento ${id}`,
    issuerName: null,
    fileName: `${id}.pdf`,
    kind: "escritura",
    category: "legal",
    status: "vigente",
    deletedAt: null,
    hasFile: true,
    validFrom: null,
    validUntil: null,
    issueDate: null,
    renewalDays: null,
    sizeBytes: 1024,
    mimeType: "application/pdf",
    complianceRequirementCode: null,
    linkedEntityType: null,
    linkedEntityId: null,
    version: 1,
    ...over
  };
}

const ROWS: Doc[] = [
  doc("escritura", { title: "Escritura de compraventa", issuerName: "Notaría", status: "sin_fecha" }),
  doc("licencia", { title: "Licencia de actividad", kind: "licencia_actividad", category: "licencias", status: "vigente", validUntil: "2028-03-31" }),
  doc("cee", { title: "Certificado energético", kind: "cee", category: "legal", status: "caduca_pronto", validUntil: "2026-10-15" }),
  doc("oca-2019", { title: "Acta OCA ascensores 2019", kind: "acta_oca", category: "inspecciones", status: "caducado", validUntil: "2021-06-30" }),
  doc("poliza-v1", { title: "Póliza multirriesgo", kind: "poliza", category: "seguros", status: "sustituido", validUntil: "2025-12-31" }),
  doc("poliza-v2", { title: "Póliza multirriesgo", kind: "poliza", category: "seguros", status: "vigente", validUntil: "2026-12-31", version: 2 }),
  doc("plano", { title: "Plano de planta baja", kind: "plano_planta", category: "planos", status: "sin_fecha", hasFile: false, fileName: null, mimeType: null, sizeBytes: null })
];

describe("Documentación · Cocoa 22 y superficie de red (ACT-F2)", () => {
  it("nace sin estilos en línea, sin elementos crudos, sin literales de color, sin emoji y sin fetch crudo; formato solo por lib/format", () => {
    assert.equal(count(SOURCE, /\bstyle=\{/g), 0, "style={ debe ser 0");
    assert.doesNotMatch(SOURCE, /(?<!-)\bbo-[a-z0-9-]+/);
    assert.doesNotMatch(SOURCE, /<button\b/);
    assert.doesNotMatch(SOURCE, /<table\b/);
    assert.doesNotMatch(SOURCE, /<(?:input|select|textarea)\b/);
    assert.doesNotMatch(SOURCE, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/);
    assert.doesNotMatch(SOURCE, /\p{Extended_Pictographic}/u);
    assert.doesNotMatch(SOURCE, /<h1\b|transition:\s*["']all|position:\s*["'(]*fixed|zIndex:\s*["'(]*\d/);
    assert.doesNotMatch(SOURCE, /\b(?:window\.|globalThis\.)?fetch\s*\(/, "nunca fetch crudo: el fichero llega por apiRequestBlob (downloadRealEstateDocument)");
    assert.doesNotMatch(SOURCE, /Intl\.(?:NumberFormat|DateTimeFormat)|toLocale[A-Za-z]*String\(/);
    assert.doesNotMatch(SOURCE, /from "\.\.\/\.\.\/services\/api-client"/, "la pantalla no importa api-client: todo por services/realEstateApi.ts");
  });

  it("exporta la pantalla con nombre (`RealEstateDocumentsScreen`) como primera función exportada, pinta la cabecera Cocoa y gatea con canDo(useNavGate(), …)", () => {
    assert.equal(typeof RealEstateDocumentsScreen, "function");
    assert.equal(screenModule.default, RealEstateDocumentsScreen);
    assert.match(SOURCE, /^export function RealEstateDocumentsScreen\(\)/m);
    assert.equal(/export\s+function\s+([A-Z][a-zA-Z0-9]+)/.exec(SOURCE)?.[1], "RealEstateDocumentsScreen", "scripts/check-sidebar-coverage.mjs toma la primera función exportada como nombre de la pantalla");
    assert.match(SOURCE, /<CocoaPage\b/);
    assert.match(SOURCE, /const canManageDocs = canDo\(gate, "real_estate\.documents\.manage"\);/);
    assert.match(SOURCE, /const canManage = canDo\(gate, "real_estate\.manage"\);/);
    assert.doesNotMatch(SOURCE, /auth-storage|getUser\(|\?\.permissions/);
  });

  it("lleva las piezas del diseño §8: toolbar con búsqueda · categoría · vigencia · «Solo vigentes», tabla, CocoaSheet con visor (iframe / img / texto), CocoaFileInput, Nueva versión, Retirar y Editar fechas", () => {
    assert.match(SOURCE, /<CocoaToolbar\b/);
    assert.match(SOURCE, /<CocoaSearchInput\b/);
    assert.match(SOURCE, /label="Solo vigentes"/);
    assert.match(SOURCE, /<CocoaTable\b/);
    assert.match(SOURCE, /<CocoaSheet\b/);
    assert.match(SOURCE, /<iframe src=\{viewer\.url\}/);
    assert.match(SOURCE, /<img src=\{viewer\.url\}/);
    assert.match(SOURCE, /<pre>\{viewer\.text \?\? ""\}<\/pre>/);
    assert.match(SOURCE, /URL\.createObjectURL\(response\.blob\)/);
    assert.match(SOURCE, /URL\.revokeObjectURL\(objectUrl\)/);
    assert.match(SOURCE, /downloadRealEstateDocument\(docId, \{ inline: true \}, propertyId\)/);
    assert.match(SOURCE, /saveBlob\(viewer\.blob,/, "«Descargar» guarda el mismo blob del visor");
    assert.match(SOURCE, /accept=\{REAL_ESTATE_DOCUMENT_ACCEPT\} maxBytes=\{REAL_ESTATE_DOCUMENT_MAX_BYTES\}/);
    assert.equal(count(SOURCE, /<CocoaFileInput\b/g), 2, "subida y «Nueva versión»");
    assert.match(SOURCE, /label="Nueva versión"/);
    assert.match(SOURCE, /uploadRealEstateDocumentVersion\(selected\.id, file, \{\}, propertyId\)/);
    assert.match(SOURCE, /retireRealEstateDocument\(selected\.id, propertyId\)/);
    assert.match(SOURCE, /updateRealEstateDocument\(selected\.id, patch, propertyId\)/);
    assert.match(SOURCE, /disabled=\{!canManage \|\| busy \|\| selected\.deletedAt !== null\}/, "«Retirar» solo con real_estate.manage");
    assert.match(SOURCE, /errorCode === "ASSET_NOT_FOUND"/, "sin ficha del centro: estado vacío que remite a la pestaña Ficha");
    for (const kind of ['kind="loading"', 'kind="empty"', 'kind="error"']) assert.ok(SOURCE.includes(kind), `CocoaState ${kind}`);
    assert.deepEqual(
      DOCUMENT_COLUMNS.map((column) => column.key),
      ["category", "kind", "title", "issuerName", "issueDate", "status", "version", "linked", "file"]
    );
  });
});

describe("Documentación: filtro «Solo vigentes» oculta caducados", () => {
  it("por defecto «Solo vigentes» está activo y oculta caducados y sustituidos; sin fecha y caduca pronto siguen siendo vigentes", () => {
    assert.equal(DOCUMENT_FILTER_DEFAULTS.onlyValid, true);
    assert.deepEqual([...NON_VALID_STATUSES], ["caducado", "sustituido"]);
    const shown = filterDocuments(ROWS, DOCUMENT_FILTER_DEFAULTS).map((row) => row.id);
    assert.deepEqual(shown, ["escritura", "licencia", "cee", "poliza-v2", "plano"]);
    assert.ok(!shown.includes("oca-2019"), "el acta caducada queda oculta");
    assert.ok(!shown.includes("poliza-v1"), "la versión sustituida queda oculta");
    assert.equal(documentIsValid(doc("x", { status: "caducado" })), false);
    assert.equal(documentIsValid(doc("x", { status: "caduca_pronto" })), true);
    assert.equal(documentIsValid(doc("x", { status: "sin_fecha" })), true);
    assert.equal(documentIsValid(doc("x", { status: "vigente", deletedAt: "2026-09-01T00:00:00.000Z" })), false, "un documento retirado nunca es vigente");
  });

  it("al desactivar «Solo vigentes» vuelven los caducados; categoría, vigencia y búsqueda (sin tildes, sobre título · emisor · fichero · tipo) se combinan", () => {
    const all = filterDocuments(ROWS, { ...DOCUMENT_FILTER_DEFAULTS, onlyValid: false });
    assert.equal(all.length, ROWS.length);
    assert.deepEqual(filterDocuments(ROWS, { ...DOCUMENT_FILTER_DEFAULTS, onlyValid: false, status: "caducado" }).map((row) => row.id), ["oca-2019"]);
    assert.deepEqual(filterDocuments(ROWS, { ...DOCUMENT_FILTER_DEFAULTS, category: "seguros" }).map((row) => row.id), ["poliza-v2"]);
    assert.deepEqual(filterDocuments(ROWS, { ...DOCUMENT_FILTER_DEFAULTS, onlyValid: false, category: "seguros" }).map((row) => row.id), ["poliza-v1", "poliza-v2"]);
    assert.deepEqual(filterDocuments(ROWS, { ...DOCUMENT_FILTER_DEFAULTS, search: "NOTARIA" }).map((row) => row.id), ["escritura"]);
    assert.deepEqual(filterDocuments(ROWS, { ...DOCUMENT_FILTER_DEFAULTS, search: "plano de" }).map((row) => row.id), ["plano"]);
    assert.deepEqual(filterDocuments(ROWS, { ...DOCUMENT_FILTER_DEFAULTS, search: "licencia" }).map((row) => row.id), ["licencia"], "busca también por la etiqueta del tipo");
    assert.deepEqual(filterDocuments(ROWS, { ...DOCUMENT_FILTER_DEFAULTS, search: "nada que coincida" }), []);
  });

  it("vigencia: badge verde / ámbar / rojo / gris y tono de fila", () => {
    const badge = (status: Doc["status"]) => renderToStaticMarkup(createElement(DocumentValidityBadge, { doc: { status, validUntil: "2026-12-31" } }));
    assert.match(badge("vigente"), /data-tone="success"|success/);
    assert.match(badge("caduca_pronto"), /warning/);
    assert.match(badge("caducado"), /danger/);
    assert.match(badge("sustituido"), /neutral/);
    assert.match(badge("vigente"), /Vigente/);
    assert.match(badge("caducado"), /Caducado/);
    assert.equal(documentRowTone(doc("x", { status: "caducado" })), "danger");
    assert.equal(documentRowTone(doc("x", { status: "caduca_pronto" })), "warning");
    assert.equal(documentRowTone(doc("x", { status: "sustituido" })), "neutral");
    assert.equal(documentRowTone(doc("x", { status: "vigente" })), undefined);
    assert.equal(validityRange({ validFrom: "2026-01-01", validUntil: "2026-12-31" }), "01/01/2026 – 31/12/2026");
    assert.equal(validityRange({ validFrom: null, validUntil: "2026-12-31" }), "hasta 31/12/2026");
    assert.equal(validityRange({ validFrom: null, validUntil: null }), "Sin vigencia");
  });
});

describe("Documentación: fila sin fichero muestra «Sin fichero» y no abre visor", () => {
  it("la celda «Fichero» de una ficha sin fichero pinta «Sin fichero»; con fichero, nombre y tamaño", () => {
    assert.equal(NO_FILE_LABEL, "Sin fichero");
    const empty = renderToStaticMarkup(createElement(DocumentFileCell, { doc: { hasFile: false, fileName: null, sizeBytes: null, mimeType: null } }));
    assert.match(empty, /Sin fichero/);
    const withFile = renderToStaticMarkup(createElement(DocumentFileCell, { doc: { hasFile: true, fileName: "escritura.pdf", sizeBytes: 2048, mimeType: "application/pdf" } }));
    assert.match(withFile, /escritura\.pdf/);
    assert.doesNotMatch(withFile, /Sin fichero/);
    assert.equal(fileLabel({ hasFile: false, fileName: null, sizeBytes: null }), "Sin fichero");
    assert.match(fileLabel({ hasFile: true, fileName: "a.pdf", sizeBytes: 2048 }), /^a\.pdf · /);
    const fileColumn = DOCUMENT_COLUMNS.find((column) => column.key === "file");
    assert.ok(fileColumn?.render, "la columna «Fichero» usa DocumentFileCell");
    assert.match(renderToStaticMarkup(createElement("span", null, fileColumn!.render!(doc("plano", { hasFile: false, fileName: null, sizeBytes: null, mimeType: null })))), /Sin fichero/);
  });

  it("documentOpensViewer es falso sin fichero o retirado: el efecto del visor no pide el blob y el panel pinta la nota en vez del iframe", () => {
    assert.equal(documentOpensViewer({ hasFile: false, deletedAt: null }), false);
    assert.equal(documentOpensViewer({ hasFile: true, deletedAt: "2026-09-01T00:00:00.000Z" }), false);
    assert.equal(documentOpensViewer({ hasFile: true, deletedAt: null }), true);
    // El efecto del visor solo descarga cuando `opens` (documentOpensViewer) es verdadero.
    assert.match(SOURCE, /const opens = doc \? documentOpensViewer\(doc\) : false;/);
    assert.match(SOURCE, /if \(!docId \|\| !opens\) \{\s*setState\(VIEWER_IDLE\);\s*return undefined;\s*\}/);
    assert.equal(count(SOURCE, /downloadRealEstateDocument\(/g), 1, "una sola petición del fichero, la del visor");
    const noFile = doc("plano", { hasFile: false, fileName: null, sizeBytes: null, mimeType: null }) as unknown as Parameters<typeof DocumentViewerPane>[0]["doc"];
    const html = renderToStaticMarkup(createElement(DocumentViewerPane, { doc: noFile, viewer: { status: "idle" }, narrow: false }));
    assert.match(html, /Sin fichero/);
    assert.doesNotMatch(html, /<iframe|<img/);
    const withFile = doc("escritura") as unknown as Parameters<typeof DocumentViewerPane>[0]["doc"];
    const pdf = renderToStaticMarkup(createElement(DocumentViewerPane, { doc: withFile, viewer: { status: "ready", kind: "pdf", url: "blob:demo", blob: new Blob(["%PDF-1.4"], { type: "application/pdf" }), text: null, fileName: "escritura.pdf" }, narrow: true }));
    assert.match(pdf, /<iframe src="blob:demo"[^>]*height="360"/, "PDF en iframe; a 400 px el visor mide 360");
    const xml = renderToStaticMarkup(createElement(DocumentViewerPane, { doc: withFile, viewer: { status: "ready", kind: "xml", url: null, blob: new Blob(["<a/>"], { type: "application/xml" }), text: "<factura/>", fileName: "f.xml" }, narrow: false }));
    assert.match(xml, /<pre>&lt;factura\/&gt;<\/pre>/, "XML como texto");
    const loading = renderToStaticMarkup(createElement(DocumentViewerPane, { doc: withFile, viewer: { status: "loading" }, narrow: false }));
    assert.match(loading, /Abriendo el fichero/);
  });

  it("viewerKindOf: PDF → iframe, JPEG / PNG → img, XML → texto, TIFF y el resto solo descarga; nombre del Content-Disposition", () => {
    assert.equal(viewerKindOf("application/pdf"), "pdf");
    assert.equal(viewerKindOf("application/pdf; charset=binary"), "pdf");
    assert.equal(viewerKindOf("image/jpeg"), "image");
    assert.equal(viewerKindOf("image/png"), "image");
    assert.equal(viewerKindOf("application/xml"), "xml");
    assert.equal(viewerKindOf("text/xml"), "xml");
    assert.equal(viewerKindOf("application/octet-stream", "facturae.xml"), "xml");
    assert.equal(viewerKindOf("image/tiff"), "other");
    assert.equal(viewerKindOf(null, null), "other");
    assert.equal(fileNameFromDisposition('inline; filename="escritura.pdf"'), "escritura.pdf");
    assert.equal(fileNameFromDisposition("attachment; filename*=UTF-8''p%C3%B3liza.pdf"), "póliza.pdf");
    assert.equal(fileNameFromDisposition(null), null);
  });
});

describe("Documentación: subir envía base64 sin prefijo data:", () => {
  it("submitDocumentUpload manda al API los metadatos y `file.base64` en alfabeto estándar sin `data:…;base64,`", async () => {
    setSession("token-de-prueba", { userId: "usr_test", organizationId: "org_test", propertyId: "prop_test", fullName: "Prueba ACT F2" });
    // La cabecera x-property-id sale del centro activo (services/activeProperty.ts), como en la app.
    assert.equal(writeActiveProperty({ propertyId: "prop_test", organizationId: "org_test", propertyName: "Hotel de prueba" }), true);
    const bytes = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
    const file = new File([bytes], "escritura compraventa.pdf", { type: "application/pdf" });
    const created = { id: "red_test", title: "Escritura de compraventa", version: 1, hasFile: true };
    nextResponse = () => new Response(JSON.stringify(created), { status: 201, headers: { "content-type": "application/json" } });
    captured.length = 0;

    const form = { ...emptyUploadForm(), title: "  Escritura de compraventa  ", issuerName: "Notaría", issueDate: "2019-05-20", validFrom: "", validUntil: "", renewalDays: "", complianceRequirementCode: "SAN-LEG-01" };
    const result = await submitDocumentUpload(form, file, "prop_test");
    assert.equal(result.id, "red_test");

    const request = captured.find((call) => call.url.endsWith("/properties/prop_test/real-estate/documents"));
    assert.ok(request, "POST …/real-estate/documents");
    assert.equal(request.method, "POST");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["x-property-id"], "prop_test", "cabecera de ámbito del centro");
    const body = request.body as { title: string; issuerName: string; issueDate: string; validFrom: null; renewalDays: null; complianceRequirementCode: string; file: { fileName: string; mimeType: string; base64: string } };
    assert.equal(body.title, "Escritura de compraventa", "título recortado");
    assert.equal(body.issuerName, "Notaría");
    assert.equal(body.issueDate, "2019-05-20");
    assert.equal(body.validFrom, null, "vacío → null");
    assert.equal(body.renewalDays, null);
    assert.equal(body.complianceRequirementCode, "SAN-LEG-01");
    assert.equal(body.file.fileName, "escritura compraventa.pdf");
    assert.equal(body.file.mimeType, "application/pdf");
    assert.ok(!body.file.base64.startsWith("data:"), "sin prefijo data:");
    assert.ok(!body.file.base64.includes(","), "sin la coma del data URI");
    assert.match(body.file.base64, /^[A-Za-z0-9+/]+={0,2}$/, "alfabeto base64 estándar (RFC 4648 §4)");
    assert.equal(body.file.base64, bytes.toString("base64"));
    assert.ok(Buffer.from(body.file.base64, "base64").equals(bytes), "decodifica a los bytes originales");
  });

  it("sin fichero se registra solo la ficha (cuerpo sin `file`): la fila saldrá «Sin fichero»", async () => {
    nextResponse = () => new Response(JSON.stringify({ id: "red_meta", title: "Plano", version: 1, hasFile: false }), { status: 201, headers: { "content-type": "application/json" } });
    captured.length = 0;
    const form = { ...emptyUploadForm(), category: "planos" as const, kind: "plano_planta" as const, title: "Plano de planta baja" };
    const result = await submitDocumentUpload(form, null, "prop_test");
    assert.equal(result.hasFile, false);
    const request = captured.find((call) => call.url.endsWith("/properties/prop_test/real-estate/documents"));
    assert.ok(request);
    assert.equal(Object.hasOwn(request.body as object, "file"), false);
    assert.equal((request.body as { category: string }).category, "planos");
  });

  it("el formulario exige título, días enteros y una vigencia coherente; el título por defecto sale del nombre del fichero", () => {
    assert.deepEqual(validateUploadForm({ ...emptyUploadForm(), title: "" }), { title: "Indica el título del documento." });
    assert.deepEqual(validateUploadForm({ ...emptyUploadForm(), title: "x", renewalDays: "30.5" }), { renewalDays: "Días enteros (0 o más)." });
    assert.deepEqual(validateUploadForm({ ...emptyUploadForm(), title: "x", validFrom: "2026-12-31", validUntil: "2026-01-01" }), { validUntil: "La vigencia termina antes de empezar." });
    assert.deepEqual(validateUploadForm({ ...emptyUploadForm(), title: "x", renewalDays: "60", validFrom: "2026-01-01", validUntil: "2026-12-31" }), {});
    assert.equal(uploadMetaOf({ ...emptyUploadForm(), title: "x", renewalDays: "60" }).renewalDays, 60);
    assert.equal(titleFromFileName("escritura-compraventa_2019.pdf"), "escritura-compraventa_2019");
    assert.equal(titleFromFileName("sin-extension"), "sin-extension");
  });

  it("editar fechas envía solo lo que cambia (vacío → null) y valida como el alta", () => {
    const current = { issueDate: "2019-05-20", validFrom: null, validUntil: "2026-12-31", renewalDays: 30 };
    assert.deepEqual(datesPatchOf({ issueDate: "2019-05-20", validFrom: "", validUntil: "2026-12-31", renewalDays: "30" }, current), {});
    assert.deepEqual(datesPatchOf({ issueDate: "2019-05-20", validFrom: "", validUntil: "", renewalDays: "" }, current), { validUntil: null, renewalDays: null });
    assert.deepEqual(datesPatchOf({ issueDate: "2020-01-01", validFrom: "2020-01-01", validUntil: "2026-12-31", renewalDays: "30" }, current), { issueDate: "2020-01-01", validFrom: "2020-01-01" });
    assert.equal(validateDatesForm({ issueDate: "", validFrom: "2026-12-31", validUntil: "2026-01-01", renewalDays: "" }), "La vigencia termina antes de empezar.");
    assert.equal(validateDatesForm({ issueDate: "", validFrom: "", validUntil: "", renewalDays: "x" }), "Los días de aviso deben ser un entero (0 o más).");
    assert.equal(validateDatesForm({ issueDate: "", validFrom: "", validUntil: "", renewalDays: "" }), null);
  });
});

describe("Documentación: errores y etiquetas", () => {
  it("«Retirar» con bloqueo legal explica el 409 LEGAL_HOLD con la frase del helper; el resto de códigos y el mensaje del API caen por realEstateErrorMessage", () => {
    assert.equal(documentFailureMessage(new ApiError("El documento está bajo retención legal y no puede retirarse.", 409, undefined, { code: "LEGAL_HOLD" })), REAL_ESTATE_ERROR_MESSAGES.LEGAL_HOLD);
    assert.equal(documentFailureMessage(new ApiError("x", 409, undefined, { code: "DOCUMENT_SUPERSEDED" })), REAL_ESTATE_ERROR_MESSAGES.DOCUMENT_SUPERSEDED);
    assert.equal(documentFailureMessage(new ApiError("x", 413, undefined, { code: "DOCUMENT_TOO_LARGE" })), REAL_ESTATE_ERROR_MESSAGES.DOCUMENT_TOO_LARGE);
    assert.equal(documentFailureMessage(new ApiError("x", 404, undefined, { code: "ASSET_NOT_FOUND" })), REAL_ESTATE_ERROR_MESSAGES.ASSET_NOT_FOUND);
    assert.equal(documentFailureMessage(new ApiError("Mensaje del API", 500)), "Mensaje del API");
    assert.equal(documentFailureMessage(null, "fallback propio"), "fallback propio");
    assert.match(SOURCE, /setActionFailure\(documentFailureMessage\(error, "No se pudo retirar el documento\."\)\)/);
  });

  it("columna «Obligación»: el código del requisito de cumplimiento, si no la entidad enlazada, si no «—»", () => {
    assert.equal(linkedLabel({ complianceRequirementCode: "SAN-LEG-01", linkedEntityType: "tenure", linkedEntityId: "t1" }), "SAN-LEG-01");
    assert.equal(linkedLabel({ complianceRequirementCode: null, linkedEntityType: "insurance", linkedEntityId: "i1" }), "Póliza");
    assert.equal(linkedLabel({ complianceRequirementCode: null, linkedEntityType: null, linkedEntityId: null }), "—");
  });
});
