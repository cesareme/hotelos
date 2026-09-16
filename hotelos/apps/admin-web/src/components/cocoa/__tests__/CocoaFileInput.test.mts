import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileInputRejection, fileMatchesAccept, formatFileSize } from "../CocoaFileInput.tsx";

describe("CocoaFileInput · accept list (pure)", () => {
  it("matches by extension (case-insensitive) or by MIME, and accepts everything without a list", () => {
    assert.equal(fileMatchesAccept({ name: "EXTRACTO.N43", type: "" }, ".n43,.txt,text/plain"), true);
    assert.equal(fileMatchesAccept({ name: "notas", type: "text/plain" }, ".n43,text/plain"), true);
    assert.equal(fileMatchesAccept({ name: "foto.png", type: "image/png" }, "image/*"), true);
    assert.equal(fileMatchesAccept({ name: "factura.pdf", type: "application/pdf" }, ".n43,.txt,text/plain"), false);
    assert.equal(fileMatchesAccept({ name: "sin-tipo", type: "" }, "image/*"), false);
    assert.equal(fileMatchesAccept({ name: "cualquiera.bin", type: "" }, undefined), true);
    assert.equal(fileMatchesAccept({ name: "cualquiera.bin", type: "" }, " , "), true);
  });
});

describe("CocoaFileInput · rejection message (pure, es-ES)", () => {
  it("names the file and the admitted extensions when the type is wrong", () => {
    assert.equal(fileInputRejection({ name: "factura.pdf", size: 10, type: "application/pdf" }, { accept: ".n43,.txt,text/plain" }), "El fichero «factura.pdf» no es de un tipo admitido (.n43, .txt).");
    assert.equal(fileInputRejection({ name: "x.bin", size: 10, type: "" }, { accept: "image/*" }), "El fichero «x.bin» no es de un tipo admitido.");
  });
  it("names both sizes when the file is too heavy, and passes otherwise", () => {
    assert.equal(fileInputRejection({ name: "grande.pdf", size: 2.5 * 1024 * 1024, type: "application/pdf" }, { accept: ".pdf", maxBytes: 512 * 1024 }), "El fichero «grande.pdf» pesa 2,5 MB; el máximo es 512 KB.");
    assert.equal(fileInputRejection({ name: "ok.pdf", size: 512 * 1024, type: "application/pdf" }, { accept: ".pdf", maxBytes: 512 * 1024 }), null);
    assert.equal(fileInputRejection({ name: "ok.pdf", size: 1, type: "application/pdf" }, {}), null);
  });
});

describe("CocoaFileInput · formatFileSize", () => {
  it("B / KB / MB in es-ES, base 1024", () => {
    assert.equal(formatFileSize(812), "812 B");
    assert.equal(formatFileSize(512 * 1024), "512 KB");
    assert.equal(formatFileSize(1536 * 1024), "1,5 MB");
    assert.equal(formatFileSize(-1), "—");
  });
});
