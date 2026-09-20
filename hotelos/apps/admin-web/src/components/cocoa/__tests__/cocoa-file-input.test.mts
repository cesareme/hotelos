// CocoaFileInput · `multiple` (Tanda T9 · lote T9-04): the pure selection that
// decides which files of a multiple pick reach `onPickMany` and which ones go
// to `onReject`, one reason each. No DOM: plain objects stand in for `File`.
// Run with the front unit command (corepack pnpm --filter @hotelos/admin-web test).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileInputRejection, selectAcceptedFiles } from "../CocoaFileInput.tsx";

const pdf = (name: string, size = 1024) => ({ name, size, type: "application/pdf" });
const jpg = (name: string, size = 1024) => ({ name, size, type: "image/jpeg" });
const txt = (name: string, size = 1024) => ({ name, size, type: "text/plain" });

describe("CocoaFileInput · selectAcceptedFiles (pure)", () => {
  it("keeps the picker's order and admits everything when there are no limits", () => {
    const files = [pdf("a.pdf"), jpg("b.jpg"), txt("c.txt")];
    const selection = selectAcceptedFiles(files, {});
    assert.deepEqual(selection.accepted, files);
    assert.deepEqual(selection.rejected, []);
  });

  it("splits by accept (extension or MIME) and by maxBytes, one Spanish reason per refused file", () => {
    const files = [pdf("factura.pdf"), txt("notas.txt"), jpg("foto.jpg", 3 * 1024 * 1024), jpg("ticket.jpeg", 200 * 1024)];
    const selection = selectAcceptedFiles(files, { accept: "image/*,application/pdf", maxBytes: 2 * 1024 * 1024 });
    assert.deepEqual(
      selection.accepted.map((f) => f.name),
      ["factura.pdf", "ticket.jpeg"]
    );
    assert.deepEqual(
      selection.rejected.map((r) => r.file.name),
      ["notas.txt", "foto.jpg"]
    );
    assert.equal(selection.rejected[0].reason, "El fichero «notas.txt» no es de un tipo admitido.");
    assert.equal(selection.rejected[1].reason, "El fichero «foto.jpg» pesa 3,0 MB; el máximo es 2,0 MB.");
    // Each reason is exactly what the single-file path would have said.
    for (const { file, reason } of selection.rejected) assert.equal(reason, fileInputRejection(file, { accept: "image/*,application/pdf", maxBytes: 2 * 1024 * 1024 }));
  });

  it("returns two empty lists for an empty pick and refuses everything when nothing matches", () => {
    assert.deepEqual(selectAcceptedFiles([], { accept: ".pdf" }), { accepted: [], rejected: [] });
    const selection = selectAcceptedFiles([txt("a.txt"), txt("b.txt")], { accept: ".pdf,.jpg" });
    assert.equal(selection.accepted.length, 0);
    assert.deepEqual(
      selection.rejected.map((r) => r.reason),
      ["El fichero «a.txt» no es de un tipo admitido (.pdf, .jpg).", "El fichero «b.txt» no es de un tipo admitido (.pdf, .jpg)."]
    );
  });

  it("does not mutate the input list", () => {
    const files = [pdf("a.pdf"), txt("b.txt")];
    const copy = [...files];
    selectAcceptedFiles(files, { accept: ".pdf" });
    assert.deepEqual(files, copy);
  });
});
