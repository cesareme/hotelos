// QR encoder cross-check against the reference implementation (Kazuhiko
// Arase's qrcode-generator as vendored by qrcode-terminal, devDependency of
// the API for this test only): every module must match for the same version,
// error-correction level and mask. Pure. Run from apps/api with
//   node --import tsx --test src/modules/invoicing/__tests__/qr-encoder.test.mts
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { encodeQr, encodeQrWithMask, formatInformationBits, penaltyScore, versionInformationBits } from "../pdf/qr-encoder.js";

const require = createRequire(import.meta.url);
type ReferenceQr = { addData(text: string): void; make(): void; makeImpl(test: boolean, mask: number): void; isDark(r: number, c: number): boolean; getModuleCount(): number; typeNumber: number };
const ReferenceQRCode = require("qrcode-terminal/vendor/QRCode") as new (typeNumber: number, level: number) => ReferenceQr;
const ReferenceLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel") as { L: number; M: number; Q: number; H: number };

function referenceMatrix(text: string, version: number, level: "L" | "M", mask: number): boolean[][] {
  const qr = new ReferenceQRCode(version, ReferenceLevel[level]);
  qr.addData(text);
  qr.makeImpl(false, mask);
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (__, c) => qr.isDark(r, c)));
}

function referenceAutoVersion(text: string, level: "L" | "M"): number {
  const qr = new ReferenceQRCode(-1, ReferenceLevel[level]);
  qr.addData(text);
  qr.make();
  return qr.typeNumber;
}

const VERIFACTU_URL = "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=B99999997&numserie=FAC-2026-000016&fecha=15-09-2026&importe=215.50";
const PAYLOADS = ["HOLA", "Anfitorio - factura FAC-2026-000001 (ASCII only: the reference encodes charCodeAt)", VERIFACTU_URL, "x".repeat(300), "https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345674&numserie=SIM-2026-000123&fecha=01-01-2027&importe=9.10"];

describe("format / version information (BCH)", () => {
  it("M · mask 0 → 0x5412 (all-zero data XOR mask), L · mask 0 → 0x77C4", () => {
    assert.equal(formatInformationBits("M", 0), 0x5412);
    assert.equal(formatInformationBits("L", 0), 0x77c4);
    assert.equal(formatInformationBits("H", 7), 0x083b);
  });
  it("version 7 → 0x07C94, version 20 → 0x149A6", () => {
    assert.equal(versionInformationBits(7), 0x07c94);
    assert.equal(versionInformationBits(20), 0x149a6);
  });
});

describe("encodeQrWithMask — module-exact against the reference for every mask", () => {
  for (const level of ["M", "L"] as const) {
    for (const text of PAYLOADS) {
      it(`${level} · ${text.length} chars: same version and identical modules (8 masks)`, () => {
        const version = referenceAutoVersion(text, level);
        assert.equal(encodeQrWithMask(text, 0, level).version, version, "auto-selected version must match the reference");
        for (let mask = 0; mask < 8; mask++) {
          const mine = encodeQrWithMask(text, mask, level, version);
          const ref = referenceMatrix(text, version, level, mask);
          assert.equal(mine.size, ref.length);
          const diffs: string[] = [];
          for (let r = 0; r < mine.size; r++) for (let c = 0; c < mine.size; c++) if (mine.modules[r]![c] !== ref[r]![c]) diffs.push(`${r},${c}`);
          assert.deepEqual(diffs.slice(0, 10), [], `mask ${mask}: ${diffs.length} differing modules`);
        }
      });
    }
  }
});

describe("encodeQr — mask selection and UTF-8 payloads", () => {
  it("picks the mask with the lowest standard penalty and produces a square, finder-patterned matrix", () => {
    const qr = encodeQr(VERIFACTU_URL, "M");
    assert.ok(qr.version >= 6 && qr.version <= 8, `version ${qr.version}`);
    const scores = Array.from({ length: 8 }, (_, mask) => penaltyScore(encodeQrWithMask(VERIFACTU_URL, mask, "M").modules));
    assert.equal(penaltyScore(qr.modules), Math.min(...scores));
    // Top-left finder: dark border, light ring, dark centre.
    assert.equal(qr.modules[0]![0], true);
    assert.equal(qr.modules[1]![1], false);
    assert.equal(qr.modules[3]![3], true);
    // Dark module at (4V+9, 8).
    assert.equal(qr.modules[qr.version * 4 + 9]![8], true);
  });
  it("encodes non-ASCII text by UTF-8 byte length", () => {
    const qr = encodeQr("Factura «Habitación» 120,50 €", "M");
    assert.ok(qr.size >= 25);
  });
  it("refuses payloads beyond version 20", () => {
    assert.throws(() => encodeQr("x".repeat(700), "M"), /supera la capacidad/);
  });
});
