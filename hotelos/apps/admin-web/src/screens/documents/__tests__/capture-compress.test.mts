// Unit tests of the pure part of the capture compression (Tanda T9 · lote
// T9-04): the plan a photo follows before it travels as base64, the JPEG
// renaming and the chunked base64 encoder. Run with the front unit command:
//   corepack pnpm --filter @hotelos/admin-web test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPTURE_JPEG_QUALITY, CAPTURE_MAX_SIDE_PX, CAPTURE_SKIP_BELOW_BYTES, compressImageFile, fileToBase64, jpegFileName, planCompression } from "../capture-compress";

const MB = 1024 * 1024;

describe("capture-compress · planCompression (pure)", () => {
  it("pins the design constants: 1.600 px long side, quality 0,82", () => {
    assert.equal(CAPTURE_MAX_SIDE_PX, 1600);
    assert.equal(CAPTURE_JPEG_QUALITY, 0.82);
    assert.equal(CAPTURE_SKIP_BELOW_BYTES, 512 * 1024);
  });

  it("never touches a PDF, an XML e-invoice or an unknown type", () => {
    for (const mimeType of ["application/pdf", "application/xml", "text/xml", "image/svg+xml", "", "application/octet-stream"]) {
      const plan = planCompression({ width: 4000, height: 3000, sizeBytes: 8 * MB, mimeType });
      assert.equal(plan.skip, true, mimeType);
      assert.equal(plan.reason, "not_image", mimeType);
      assert.equal(plan.outputMimeType, null);
      assert.equal(plan.targetWidth, 4000);
      assert.equal(plan.targetHeight, 3000);
    }
  });

  it("scales a phone photo to 1.600 px on its long side keeping the aspect ratio, JPEG at 0,82", () => {
    const landscape = planCompression({ width: 4032, height: 3024, sizeBytes: 3.2 * MB, mimeType: "image/jpeg" });
    assert.deepEqual(landscape, { skip: false, reason: null, targetWidth: 1600, targetHeight: 1200, quality: 0.82, outputMimeType: "image/jpeg" });
    const portrait = planCompression({ width: 3024, height: 4032, sizeBytes: 3.2 * MB, mimeType: "image/heic" });
    assert.equal(portrait.targetWidth, 1200);
    assert.equal(portrait.targetHeight, 1600);
    const odd = planCompression({ width: 3000, height: 1000, sizeBytes: 3.2 * MB, mimeType: "image/png" });
    assert.equal(odd.targetWidth, 1600);
    assert.equal(odd.targetHeight, 533);
  });

  it("re-encodes without scaling a heavy image that already fits, and skips a small one that fits", () => {
    const heavy = planCompression({ width: 1500, height: 1000, sizeBytes: 2 * MB, mimeType: "image/png" });
    assert.equal(heavy.skip, false);
    assert.equal(heavy.targetWidth, 1500);
    assert.equal(heavy.targetHeight, 1000);
    assert.equal(heavy.outputMimeType, "image/jpeg");
    const small = planCompression({ width: 1600, height: 1200, sizeBytes: 300 * 1024, mimeType: "image/jpeg" });
    assert.equal(small.skip, true);
    assert.equal(small.reason, "small_enough");
    // A small image over the long side still scales (the API stores what the reviewer sees).
    const wide = planCompression({ width: 2000, height: 200, sizeBytes: 100 * 1024, mimeType: "image/jpeg" });
    assert.equal(wide.skip, false);
    assert.equal(wide.targetWidth, 1600);
    assert.equal(wide.targetHeight, 160);
  });

  it("skips when the dimensions are unknown and is case-insensitive on the MIME type", () => {
    assert.equal(planCompression({ width: 0, height: 0, sizeBytes: 5 * MB, mimeType: "image/jpeg" }).reason, "no_dimensions");
    assert.equal(planCompression({ width: Number.NaN, height: 10, sizeBytes: 5 * MB, mimeType: "image/jpeg" }).reason, "no_dimensions");
    assert.equal(planCompression({ width: 4000, height: 3000, sizeBytes: 5 * MB, mimeType: "IMAGE/JPEG" }).skip, false);
  });
});

describe("capture-compress · jpegFileName", () => {
  it("swaps the extension for .jpg and names an extensionless capture", () => {
    assert.equal(jpegFileName("foto.png"), "foto.jpg");
    assert.equal(jpegFileName("IMG_0001.HEIC"), "IMG_0001.jpg");
    assert.equal(jpegFileName("factura.agosto.jpeg"), "factura.agosto.jpg");
    assert.equal(jpegFileName("captura"), "captura.jpg");
    assert.equal(jpegFileName(".hidden"), ".hidden.jpg");
    assert.equal(jpegFileName("   "), "captura.jpg");
  });
});

describe("capture-compress · outside a browser", () => {
  it("compressImageFile hands the file back untouched when there is no window", async () => {
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "foto.jpg", { type: "image/jpeg" });
    const result = await compressImageFile(file);
    assert.equal(result.file, file);
    assert.equal(result.compressed, false);
    assert.equal(result.originalBytes, 4);
    assert.equal(result.width, null);
  });

  it("fileToBase64 encodes a blob without the data: prefix, also past one chunk", async () => {
    assert.equal(await fileToBase64(new Blob(["hola"])), "aG9sYQ==");
    assert.equal(await fileToBase64(new Blob([])), "");
    const big = new Uint8Array(100_000);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
    const encoded = await fileToBase64(new Blob([big]));
    assert.equal(encoded, Buffer.from(big).toString("base64"));
  });
});
