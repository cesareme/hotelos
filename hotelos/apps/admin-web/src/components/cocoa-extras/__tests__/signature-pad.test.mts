import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SIGNATURE_MIN_POINTS,
  SIGNATURE_TOO_SHORT_MESSAGE,
  SignaturePad,
  canvasPointOf,
  countPoints,
  hasEnoughPoints,
  pngBase64Of,
  serializeStrokes,
  signatureOutputOf,
  signaturePadHint,
  strokeMetaOf,
  svgOf
} from "../SignaturePad.tsx";

// Tanda CHK · lote W4-A · SignaturePad (docs/design/CHECKIN-AUTOMATIZADO-IA.md
// §4 «firma», §8): la lógica pura del pad — trazos {t,x,y} sin presión,
// metadatos (puntos, duración, caja), SVG en currentColor, mínimo de 8 puntos
// del API (signature.service.ts) y geometría del control — más el marcado
// estático del componente (0 `style=`, lienzo Cocoa, «Borrar» / «Aceptar»).

const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Un trazo diagonal de `n` puntos, 10 ms entre puntos, desde (10,20). */
function stroke(n: number, t0 = 1000): Array<{ t: number; x: number; y: number }> {
  return Array.from({ length: n }, (_, index) => ({ t: t0 + index * 10, x: 10 + index * 5.04, y: 20 + index * 2.5 }));
}

describe("SignaturePad · lógica pura", () => {
  it("strokeMeta y svg de un trazo", () => {
    const strokes = [stroke(10)];
    const meta = strokeMetaOf(strokes);
    assert.equal(meta.points, 10);
    assert.equal(meta.durationMs, 90);
    assert.deepEqual(meta.bbox, { x: 10, y: 20, width: 45.4, height: 22.5 });
    const svg = svgOf(strokes, { width: 480, height: 160 });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 480 160" width="480" height="160">/);
    assert.match(svg, /<path d="M10 20 L15 22\.5 L20\.1 25 /);
    assert.match(svg, /stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"\/><\/svg>$/);
    assert.equal((svg.match(/<path /g) ?? []).length, 1);
    // Salida completa: base64 puro (sin prefijo) + svg + strokeMeta.
    const output = signatureOutputOf(strokes, PNG_1PX);
    assert.equal(output.pngBase64, PNG_1PX.slice("data:image/png;base64,".length));
    assert.deepEqual(output.strokeMeta, meta);
    assert.equal(output.svg, svg);
  });
  it("rechaza menos de 8 puntos", () => {
    const short = [stroke(3), stroke(4, 2000)];
    assert.equal(countPoints(short), 7);
    assert.equal(hasEnoughPoints(short), false);
    assert.throws(() => signatureOutputOf(short, PNG_1PX), new Error(SIGNATURE_TOO_SHORT_MESSAGE));
    assert.equal(SIGNATURE_MIN_POINTS, 8);
    assert.equal(hasEnoughPoints([stroke(8)]), true);
    assert.equal(hasEnoughPoints([]), false);
    assert.deepEqual(strokeMetaOf([]), { points: 0, durationMs: 0, bbox: { x: 0, y: 0, width: 0, height: 0 } });
  });
  it("serializeStrokes: sin trazos vacíos, coordenadas a 0,1 px y `t` relativo al primer punto de la firma", () => {
    const serialized = serializeStrokes([[], [{ t: 1500.4, x: 10.04, y: 20.06 }], [{ t: 1000, x: 1.11, y: 2.22 }, { t: 1010.6, x: 3.33, y: 4.44 }]]);
    assert.deepEqual(serialized, [
      [{ t: 500, x: 10, y: 20.1 }],
      [
        { t: 0, x: 1.1, y: 2.2 },
        { t: 11, x: 3.3, y: 4.4 }
      ]
    ]);
    // Un trazo de un solo punto se pinta como segmento nulo (el redondeo del trazo lo hace visible).
    assert.match(svgOf([[{ t: 0, x: 5, y: 6 }]]), /d="M5 6 L5 6"/);
  });
  it("canvasPointOf descuenta borde y padding del control y escala al bitmap; nunca sale del lienzo", () => {
    const box = { left: 100, top: 50, width: 254, height: 94, borderLeft: 1, borderTop: 1, borderRight: 1, borderBottom: 1, paddingLeft: 12, paddingTop: 6, paddingRight: 12, paddingBottom: 6 };
    const bitmap = { width: 480, height: 160 };
    // Contenido 228 × 80 → escala 480/228 en x y ×2 en y.
    assert.deepEqual(canvasPointOf(box, bitmap, 113, 57), { x: 0, y: 0 });
    assert.deepEqual(canvasPointOf(box, bitmap, 170, 97), { x: 120, y: 80 });
    assert.deepEqual(canvasPointOf(box, bitmap, 341, 137), { x: 480, y: 160 });
    assert.deepEqual(canvasPointOf(box, bitmap, 0, 0), { x: 0, y: 0 });
    assert.deepEqual(canvasPointOf(box, bitmap, 999, 999), { x: 480, y: 160 });
  });
  it("pngBase64Of: quita el prefijo PNG, deja pasar el base64 puro y rechaza otros tipos", () => {
    assert.equal(pngBase64Of("data:image/png;base64,QUJD"), "QUJD");
    assert.equal(pngBase64Of("QUJD"), "QUJD");
    assert.throws(() => pngBase64Of("data:image/jpeg;base64,QUJD"), /image\/png/);
  });
  it("signaturePadHint: cómo firmar, cuántos faltan y lista para aceptar", () => {
    assert.match(signaturePadHint(0), /Retroceso borra; Intro acepta \(mínimo 8 puntos\)/);
    assert.equal(signaturePadHint(1), "1 punto · faltan 7 para aceptar.");
    assert.equal(signaturePadHint(5), "5 puntos · faltan 3 para aceptar.");
    assert.equal(signaturePadHint(12), "12 puntos · lista para aceptar.");
  });
});

describe("SignaturePad · marcado (Cocoa 22)", () => {
  it("lienzo Cocoa focusable con nombre accesible, nota role=status, «Borrar» y «Aceptar» sin `style=`", () => {
    const html = renderToStaticMarkup(createElement(SignaturePad, { onAccept: () => undefined, "aria-label": "Área de firma del parte" }));
    assert.match(html, /<canvas [^>]*width="480"[^>]*height="160"/);
    assert.match(html, /class="c22-control"/);
    assert.match(html, /tabindex="0"/);
    assert.match(html, /aria-label="Área de firma del parte"/);
    assert.match(html, /role="status"/);
    assert.match(html, /<span>Borrar<\/span><\/button>/);
    assert.match(html, /<span>Aceptar<\/span><\/button>/);
    assert.equal((html.match(/<button/g) ?? []).length, 2);
    assert.equal((html.match(/data-size="large"/g) ?? []).length, 2);
    // Ambos deshabilitados sin trazo; el canvas no lleva estilo inline.
    assert.equal((html.match(/<button[^>]*disabled=""/g) ?? []).length, 2);
    assert.doesNotMatch(html, /<canvas [^>]*style=/);
  });
});
