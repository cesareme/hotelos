// Unit tests · Tanda T8 · lote T8-B — enmascarado de PII (mask-pii.ts).
// Sin base de datos, sin red. Todos los datos son FICTICIOS (dominios
// .test, números inventados, nombres inventados).
// Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/mask-pii.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { containsMaskPlaceholder, maskReviewForLlm, restoreMaskedText } from "../mask-pii.js";

describe("maskReviewForLlm · cada tipo de dato", () => {
  it("e-mails", () => {
    const out = maskReviewForLlm("Escríbeme a huesped.ficticio@ejemplo.test si quieres.");
    assert.equal(out.masked, "Escríbeme a [EMAIL_1] si quieres.");
    assert.deepEqual(out.replacements, [{ kind: "email", placeholder: "[EMAIL_1]", original: "huesped.ficticio@ejemplo.test" }]);
  });
  it("teléfonos españoles con y sin prefijo", () => {
    assert.equal(maskReviewForLlm("Mi teléfono es 612 345 678.").masked, "Mi teléfono es [PHONE_1].");
    assert.equal(maskReviewForLlm("Llama al 612345678").masked, "Llama al [PHONE_1]");
    assert.equal(maskReviewForLlm("Tel: +34 612 34 56 78").masked, "Tel: [PHONE_1]");
    assert.equal(maskReviewForLlm("Tel: 0034612345678").masked, "Tel: [PHONE_1]");
    assert.equal(maskReviewForLlm("Fijo 981 12 34 56").masked, "Fijo [PHONE_1]");
  });
  it("teléfonos E.164 internacionales", () => {
    assert.equal(maskReviewForLlm("Call +44 20 7946 0958 please").masked, "Call [PHONE_1] please");
    assert.equal(maskReviewForLlm("+1 (555) 010-9999").masked, "[PHONE_1]");
  });
  it("IBAN (antes que teléfono: no se parte en trozos)", () => {
    const out = maskReviewForLlm("Devolución al ES91 2100 0418 4502 0005 1332 por favor");
    assert.equal(out.masked, "Devolución al [IBAN_1] por favor");
    assert.equal(out.replacements[0]?.kind, "iban");
  });
  it("URLs", () => {
    assert.equal(maskReviewForLlm("Ver https://ejemplo.test/resena?id=1 y www.ejemplo.test/otra").masked, "Ver [URL_1] y [URL_2]");
  });
  it("números de habitación (es/en/de/fr/pt) conservando la palabra", () => {
    assert.equal(maskReviewForLlm("Nos dieron la habitación 432 y estaba sucia").masked, "Nos dieron la habitación [ROOM_1] y estaba sucia");
    assert.equal(maskReviewForLlm("Room 12 was noisy").masked, "Room [ROOM_1] was noisy");
    assert.equal(maskReviewForLlm("room #305").masked, "room [ROOM_1]");
    assert.equal(maskReviewForLlm("Zimmer 7 war laut").masked, "Zimmer [ROOM_1] war laut");
    assert.equal(maskReviewForLlm("Hab. nº 21").masked, "Hab. [ROOM_1]");
  });
  it("nombres tras tratamiento (Sr./Sra./Don/Doña/Mr./Mrs./Herr/Madame)", () => {
    assert.equal(maskReviewForLlm("El Sr. Ficticio nos atendió fatal").masked, "El Sr. [NAME_1] nos atendió fatal");
    assert.equal(maskReviewForLlm("Mrs. Ejemplo Pruebas was kind").masked, "Mrs. [NAME_1] was kind");
    assert.equal(maskReviewForLlm("Gracias a Don Ejemplo de Pruebas").masked, "Gracias a Don [NAME_1]");
    assert.equal(maskReviewForLlm("Doña Ficticia fue amable").masked, "Doña [NAME_1] fue amable");
    assert.equal(maskReviewForLlm("Herr Beispiel war nett").masked, "Herr [NAME_1] war nett");
    const out = maskReviewForLlm("Madame Exemple nous a aidés");
    assert.equal(out.masked, "Madame [NAME_1] nous a aidés");
    assert.equal(out.replacements[0]?.original, "Exemple");
  });
});

describe("maskReviewForLlm · propiedades", () => {
  it("no toca texto sin PII ni años ni notas", () => {
    for (const text of ["Todo perfecto, repetiremos.", "En 2025 estuvimos 3 noches y pagamos 120 euros.", "Nota 9/10, volveremos.", "Nos dieron 2 toallas."]) {
      const out = maskReviewForLlm(text);
      assert.equal(out.masked, text);
      assert.deepEqual(out.replacements, []);
    }
  });
  it("vacío y nulo → vacío", () => {
    assert.deepEqual(maskReviewForLlm(""), { masked: "", replacements: [] });
    assert.deepEqual(maskReviewForLlm(null), { masked: "", replacements: [] });
  });
  it("el mismo dato repetido recibe el mismo marcador", () => {
    const out = maskReviewForLlm("Escribí a a@ejemplo.test y otra vez a a@ejemplo.test.");
    assert.equal(out.masked, "Escribí a [EMAIL_1] y otra vez a [EMAIL_1].");
    assert.equal(out.replacements.length, 1);
  });
  it("mezcla de tipos: numeración independiente por tipo", () => {
    const out = maskReviewForLlm("Sr. Ficticio (612345678, sr@ejemplo.test) en la habitación 101 y la habitación 102.");
    assert.equal(out.masked, "Sr. [NAME_1] ([PHONE_1], [EMAIL_1]) en la habitación [ROOM_1] y la habitación [ROOM_2].");
  });
  it("restoreMaskedText deshace la máscara", () => {
    const original = "Sr. Ficticio llamó al 612 345 678 desde https://ejemplo.test";
    const out = maskReviewForLlm(original);
    assert.notEqual(out.masked, original);
    assert.equal(restoreMaskedText(out.masked, out.replacements), original);
  });
  it("containsMaskPlaceholder detecta marcadores", () => {
    assert.equal(containsMaskPlaceholder("Gracias [NAME_1]"), true);
    assert.equal(containsMaskPlaceholder("Gracias por su visita"), false);
  });
});
