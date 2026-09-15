import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RITUAL_META, RITUAL_META_MAX_CHARS, RITUAL_ORDER } from "../export-center-rituals.ts";

// qa#2 (Cocoa 22 · ola 9 · lote 9-A): the ritual sentence painted as the
// section `meta` (nowrap, flex-shrink 0) pushed the header 88 px past a
// 390 px viewport. The caption stays short; the sentence is a paragraph.
describe("Exportaciones de revenue · cabeceras de ritual", () => {
  it("covers the three rituals of the export-center contract, in ritual order", () => {
    assert.deepEqual(RITUAL_ORDER, ["diario", "semanal", "mensual"]);
    assert.deepEqual(Object.keys(RITUAL_META).sort(), [...RITUAL_ORDER].sort());
  });

  it("keeps every header caption within the phone budget and the sentence out of it", () => {
    for (const ritual of RITUAL_ORDER) {
      const { title, meta, when } = RITUAL_META[ritual];
      assert.ok(title.length > 0, `${ritual}: title`);
      assert.ok(meta.length > 0 && meta.length <= RITUAL_META_MAX_CHARS, `${ritual}: meta «${meta}» tiene ${meta.length} caracteres (máximo ${RITUAL_META_MAX_CHARS})`);
      assert.doesNotMatch(meta, /[.:]\s/, `${ritual}: meta «${meta}» parece una frase; va en «when»`);
      assert.ok(when.length > meta.length, `${ritual}: when debe ser la frase larga`);
      assert.match(when, /\.$/, `${ritual}: when «${when}» termina en punto`);
    }
  });
});
