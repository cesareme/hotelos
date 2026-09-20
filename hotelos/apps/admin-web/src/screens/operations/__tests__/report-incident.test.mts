import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HK_INSTRUCTIONS } from "../../../content/screen-instructions/housekeeping.ts";
import { PISOS_ACTIONS, PISOS_TOASTS } from "../../../content/pisos-actions.ts";
import {
  OTHER_REASON,
  QUICK_REASONS,
  REPORT_MAX_PHOTOS,
  REPORT_PHOTO_ACCEPT,
  REPORT_PHOTO_MAX_BYTES,
  REPORT_TITLE_MAX_LENGTH,
  admitPhotos,
  buildWorkOrderPayload,
  canSubmitReport,
  droppedPhotosMessage,
  formatMiB,
  reportTitle
} from "../report-incident.ts";

// Tanda UX-3 · P4 (docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md §4.2, §4.4, §4.6,
// §6; fricción F4): «Reportar» con motivo rápido y foto. La parte pura
// (report-incident.ts) se ejecuta; el cajón, las dos pantallas táctiles y el
// cliente del API no se importan (React + import.meta.env) y se fijan por
// contrato de fuente sin comentarios.
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));
const drawer = read("../ReportIncidentDrawer.tsx");
const miTurno = read("../HousekeepingMobileScreen.tsx");
const misAverias = read("../MaintenanceMobileScreen.tsx");
const api = read("../../../services/maintenanceApi.ts");
const count = (source: string, needle: string) => source.split(needle).length - 1;

const file = (name: string, size: number, type: string) => ({ name, size, type });
const MiB = 1024 * 1024;

describe("report-incident · motivos rápidos y título del parte (§4.2)", () => {
  it("los seis chips en el orden del diseño, «Otro» el último", () => {
    assert.deepEqual([...QUICK_REASONS], ["Fuga de agua", "Bombilla", "Aire acondicionado", "TV/Wi-Fi", "Cerradura", "Otro"]);
    assert.equal(QUICK_REASONS[QUICK_REASONS.length - 1], OTHER_REASON);
  });

  it("un chip basta: «Hab. 203: Fuga de agua»; el detalle no cambia el título", () => {
    assert.equal(reportTitle("203", "Fuga de agua", ""), "Hab. 203: Fuga de agua");
    assert.equal(reportTitle("203", "Fuga de agua", "  gotea el lavabo "), "Hab. 203: Fuga de agua");
  });

  it("con «Otro» (o sin chip) el detalle escrito es el motivo, recortado a 80 como antes; sin nada, «Hab. 203: Otro»", () => {
    assert.equal(reportTitle("203", "Otro", " enchufe suelto "), "Hab. 203: enchufe suelto");
    assert.equal(reportTitle("203", null, "enchufe suelto"), "Hab. 203: enchufe suelto");
    assert.equal(reportTitle("203", "Otro", ""), "Hab. 203: Otro");
    const long = "x".repeat(120);
    assert.equal(reportTitle("203", null, long), `Hab. 203: ${"x".repeat(REPORT_TITLE_MAX_LENGTH)}`);
    assert.equal(REPORT_TITLE_MAX_LENGTH, 80);
  });

  it("se puede enviar con chip o con detalle; las fotos solas no dicen qué pasa", () => {
    assert.equal(canSubmitReport({ reason: "Bombilla", details: "" }), true);
    assert.equal(canSubmitReport({ reason: null, details: "  parpadea " }), true);
    assert.equal(canSubmitReport({ reason: null, details: "   " }), false);
  });
});

describe("report-incident · buildWorkOrderPayload (POST /work-orders de M1, §4.6)", () => {
  const photo = (n: number) => ({ contentBase64: `b64-${n}`, mimeType: "image/jpeg" });

  it("prioridad normal, título del chip, sin descripción ni photos cuando no hay", () => {
    assert.deepEqual(buildWorkOrderPayload({ roomNumber: "203", reason: "Cerradura", details: "", photos: [] }), {
      roomNumber: "203",
      title: "Hab. 203: Cerradura",
      priority: "normal"
    });
  });

  it("el detalle acompaña a un chip como descripción; con «Otro» ya es el título y no se repite salvo que se haya recortado", () => {
    assert.equal(buildWorkOrderPayload({ roomNumber: "203", reason: "Fuga de agua", details: " en el lavabo ", photos: [] }).description, "en el lavabo");
    assert.equal(buildWorkOrderPayload({ roomNumber: "203", reason: "Otro", details: "enchufe suelto", photos: [] }).description, undefined);
    const long = "y".repeat(100);
    assert.equal(buildWorkOrderPayload({ roomNumber: "203", reason: null, details: long, photos: [] }).description, long);
  });

  it("photos[] viaja solo con fotos, con contentBase64 + mimeType y nunca más de 3 (el 400 WORK_ORDER_PHOTOS_TOO_MANY no se alcanza)", () => {
    const one = buildWorkOrderPayload({ roomNumber: "203", reason: "Bombilla", details: "", photos: [photo(1)] });
    assert.deepEqual(one.photos, [{ contentBase64: "b64-1", mimeType: "image/jpeg" }]);
    const four = buildWorkOrderPayload({ roomNumber: "203", reason: "Bombilla", details: "", photos: [photo(1), photo(2), photo(3), photo(4)] });
    assert.equal(four.photos?.length, REPORT_MAX_PHOTOS);
    assert.equal(REPORT_MAX_PHOTOS, 3);
    assert.ok(!("propertyId" in one), "la propiedad la fija la cabecera de propiedad activa, no el cuerpo");
  });
});

describe("report-incident · admisión de fotos (≤ 3, ≤ 1,5 MiB, jpeg|png|webp)", () => {
  it("los topes coinciden con el API (M1: WORK_ORDER_PHOTO_TOO_LARGE a 1,5 MiB decodificados) y el selector solo acepta imágenes", () => {
    assert.equal(REPORT_PHOTO_MAX_BYTES, 1.5 * MiB);
    assert.equal(REPORT_PHOTO_ACCEPT, "image/*");
  });

  it("admite hasta completar 3 contando las ya elegidas y cuenta las descartadas por el tope", () => {
    const files = [file("a.jpg", 100, "image/jpeg"), file("b.png", 100, "image/png"), file("c.webp", 100, "image/webp")];
    const fresh = admitPhotos(0, files);
    assert.deepEqual(fresh.accepted.map((f) => f.name), ["a.jpg", "b.png", "c.webp"]);
    assert.equal(fresh.droppedByLimit, 0);
    const withTwo = admitPhotos(2, files);
    assert.deepEqual(withTwo.accepted.map((f) => f.name), ["a.jpg"]);
    assert.equal(withTwo.droppedByLimit, 2);
    assert.equal(droppedPhotosMessage(withTwo.droppedByLimit), "Máximo 3 fotos por parte: 2 fotos descartadas.");
    assert.equal(droppedPhotosMessage(1), "Máximo 3 fotos por parte: 1 foto descartada.");
    assert.equal(droppedPhotosMessage(0), null);
  });

  it("rechaza con mensaje en español lo que el API rechazaría por tipo o peso (tras comprimir) y no lo cuenta contra el tope", () => {
    const admission = admitPhotos(0, [file("plano.pdf", 100, "application/pdf"), file("grande.jpg", 2 * MiB, "image/jpeg"), file("ok.jpg", 100, "image/jpeg")]);
    assert.deepEqual(admission.accepted.map((f) => f.name), ["ok.jpg"]);
    assert.deepEqual(admission.rejected, ["«plano.pdf» no es una foto JPEG, PNG o WebP.", "«grande.jpg» pesa 2,0 MB tras comprimirla; el máximo es 1,5 MB."]);
    assert.equal(formatMiB(1.5 * MiB), "1,5");
  });
});

describe("ReportIncidentDrawer.tsx · contrato de fuente (§4.2, §6)", () => {
  it("chips de motivo con aria-pressed y tamaño grande; el primer chip recibe el foco (0 tecleo: nada abre el teclado al entrar)", () => {
    assert.match(drawer, /\{QUICK_REASONS\.map\(\(candidate, index\) => \{/);
    assert.match(drawer, /aria-pressed=\{active\}/);
    assert.match(drawer, /role="group" aria-label="Motivo"/);
    assert.match(drawer, /initialFocus=\{\(\) => document\.getElementById\(`\$\{REASON_ID_PREFIX\}0`\)\}/);
  });

  it("foto con la cámara trasera (CocoaFileInput accept image/* capture=environment), ≤ 3, miniaturas con «Quitar» y compresión de capture-compress.ts (solo importada)", () => {
    assert.match(drawer, /<CocoaFileInput\s+accept=\{REPORT_PHOTO_ACCEPT\}\s+capture="environment"\s+multiple/);
    assert.match(drawer, /disabled=\{submitting \|\| preparing \|\| photos\.length >= REPORT_MAX_PHOTOS\}/);
    assert.match(drawer, /import \{ compressImageFile, fileToBase64 \} from "\.\.\/documents\/capture-compress";/);
    assert.match(drawer, /await Promise\.all\(incoming\.map\(\(file\) => compressImageFile\(file, \{ force: true \}\)\)\)/, "force: recodifica también las pequeñas (sin EXIF, REV-L01)");
    assert.match(drawer, /<img src=\{item\.previewUrl\} alt=\{`Foto \$\{index \+ 1\}`\} width=\{THUMB_WIDTH\} \/>/);
    assert.match(drawer, /aria-label=\{`Quitar foto \$\{index \+ 1\}`\}/);
    assert.match(drawer, /URL\.revokeObjectURL\(item\.previewUrl\)/);
  });

  it("«Enviar a mantenimiento» ≥ 44 px (size large), Enter envía (submitOnEnter) y el parte viaja por maintenanceApi.createWorkOrder con photos[] en base64", () => {
    assert.match(drawer, /submitOnEnter/);
    assert.match(drawer, /<CocoaButton size="large" onClick=\{\(\) => void submit\(\)\} loading=\{submitting\} disabled=\{!canSubmit\}>\s*\{PISOS_ACTIONS\.sendToMaintenance\}/);
    assert.match(drawer, /contentBase64: await fileToBase64\(item\.file\), mimeType: item\.file\.type/);
    assert.match(drawer, /const payload = buildWorkOrderPayload\(\{ roomNumber: room\.roomNumber, reason, details, photos: encoded \}\);/);
    assert.match(drawer, /const workOrder = await createWorkOrder\(payload\);/);
    assert.match(drawer, /onReported\(\{ room, workOrder, photos: payload\.photos\?\.length \?\? 0 \}\);/);
    assert.equal(PISOS_ACTIONS.sendToMaintenance, "Enviar a mantenimiento");
    assert.equal(PISOS_ACTIONS.photo, "Foto");
  });

  it("mismo título y campo que el cajón anterior para las specs (dialog «Reportar incidencia», #housekeeping-report) y 0 style= inline", () => {
    assert.match(drawer, /title="Reportar incidencia"/);
    assert.match(drawer, /export const REPORT_DETAILS_INPUT_ID = "housekeeping-report";/);
    assert.equal(count(drawer, "style={"), 0);
    assert.doesNotMatch(drawer, /<(?:input|select|textarea)\b/, "el único input crudo lo encapsula CocoaFileInput");
  });
});

describe("HousekeepingMobileScreen.tsx · «Reportar» abre el cajón de P4 y avisa con número y fotos", () => {
  it("importa ReportIncidentDrawer, ya no tiene el cajón inline ni postAction, y el aviso es PISOS_TOASTS.incidentReported", () => {
    assert.match(miTurno, /import \{ ReportIncidentDrawer, type ReportIncidentResult \} from "\.\/ReportIncidentDrawer";/);
    assert.match(miTurno, /<ReportIncidentDrawer room=\{reportFor \? \{ roomId: reportFor\.roomId, roomNumber: reportFor\.roomNumber \} : null\} onClose=\{\(\) => setReportFor\(null\)\} onReported=\{reportSent\} \/>/);
    assert.doesNotMatch(miTurno, /postAction\(|<CocoaDrawer|multiline rows=\{4\}/);
    assert.match(miTurno, /const message = PISOS_TOASTS\.incidentReported\(n, result\.photos\);/);
    assert.equal(PISOS_TOASTS.incidentReported("203", 1), "Avería de la 203 enviada a mantenimiento · 1 foto");
    assert.equal(PISOS_TOASTS.incidentReported("203", 0), "Avería de la 203 enviada a mantenimiento.");
  });

  it("la tarjeta suma la incidencia al instante (mutate optimista) en vez de un refresh() completo (F1)", () => {
    const reportSent = miTurno.slice(miTurno.indexOf("function reportSent("), miTurno.indexOf("const countLabel"));
    assert.match(reportSent, /openIncidents: \(toArray<HkRoom>\(prev\.rooms\)\.find\(\(r\) => r\.roomId === result\.room\.roomId\)\?\.openIncidents \?\? 0\) \+ 1/);
    assert.doesNotMatch(reportSent, /\brefresh\(\)/);
    assert.equal(count(miTurno, "style={{"), 0);
  });
});

describe("MaintenanceMobileScreen.tsx · galería «N fotos» (§4.4)", () => {
  it("«N fotos» es un botón de la tarjeta que abre WorkOrderPhotosSheet (CocoaSheet)", () => {
    assert.match(misAverias, /onClick=\{onPhotos\}>\s*\{MANT_ACTIONS\.photos\(item\.mediaCount\)\}/);
    assert.match(misAverias, /onPhotos=\{\(\) => setGalleryFor\(item\)\}/);
    assert.match(misAverias, /<WorkOrderPhotosSheet item=\{galleryFor\} onClose=\{\(\) => setGalleryFor\(null\)\} \/>/);
    assert.match(misAverias, /<CocoaSheet\s+open=\{item !== null\}/);
  });

  it("los metadatos llegan de listWorkOrderMedia y los bytes de fetchWorkOrderMediaBlob (con sesión), en object URLs que se revocan", () => {
    assert.match(misAverias, /const metas = await listWorkOrderMedia\(workOrderId\);/);
    assert.match(misAverias, /const \{ blob \} = await fetchWorkOrderMediaBlob\(meta\.id, \{ signal: controller\.signal \}\);/);
    assert.match(misAverias, /const url = URL\.createObjectURL\(blob\);/);
    assert.match(misAverias, /for \(const url of urlsRef\.current\) URL\.revokeObjectURL\(url\);/);
    assert.match(misAverias, /if \(!meta\.inline\) return \{ meta, url: null, error: /, "una fila legacy sin bytes se explica, no falla");
    assert.doesNotMatch(misAverias, /src=\{`\$\{[^}]*\}\/work-orders\/media/, "nunca un <img src> directo al API sin Authorization");
    assert.equal(count(misAverias, "style={{"), 0);
    assert.ok(count(misAverias, "style={") <= 8, `Mis averías: ${count(misAverias, "style={")} style={ (sin nuevos)`);
  });
});

describe("maintenanceApi.ts · fotos del parte (M1)", () => {
  it("createWorkOrder admite photos[] tipado, listWorkOrderMedia y fetchWorkOrderMediaBlob usan las rutas de M1 con apiRequestBlob", () => {
    assert.match(api, /export type WorkOrderPhotoInput = \{ contentBase64: string; mimeType: string \};/);
    assert.match(api, /photos\?: WorkOrderPhotoInput\[\];/);
    assert.match(api, /export function createWorkOrder\(payload: CreateWorkOrderPayload\)/);
    assert.match(api, /apiRequest<WorkOrderMediaMeta\[\]>\(`\/work-orders\/\$\{enc\(id\)\}\/media`\)/);
    assert.match(api, /return apiRequestBlob\(`\/work-orders\/media\/\$\{enc\(mediaId\)\}`, \{ signal: options\.signal \}\);/);
    assert.match(api, /import \{ apiRequest, apiRequestBlob, type BlobResponse \} from "\.\/api-client";/);
  });
});

describe("Ayuda de Mi turno · «Reportar» con motivo y foto", () => {
  it("explica los chips de motivo, la foto (hasta 3, cámara trasera) y que Intro envía; sin promesas falsas", () => {
    const step = HK_INSTRUCTIONS.howToUse.find((text) => text.includes("«Reportar»"));
    assert.ok(step, "hay un paso sobre «Reportar»");
    assert.match(step, /«Fuga de agua»/);
    assert.match(step, /«Foto»/);
    assert.match(step, /hasta 3/);
    assert.match(step, /«Enviar a mantenimiento»/);
  });
});
