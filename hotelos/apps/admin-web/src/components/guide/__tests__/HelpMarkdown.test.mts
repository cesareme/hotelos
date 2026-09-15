import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMarkdownBlocks } from "../HelpMarkdown.tsx";

describe("HelpMarkdown · block parser", () => {
  it("parses headings, paragraphs, lists and tables", () => {
    const blocks = parseMarkdownBlocks([
      "# Título",
      "",
      "Un párrafo que",
      "sigue en la línea siguiente.",
      "",
      "## Pasos",
      "",
      "1. Primero",
      "2. Segundo",
      "   - detalle indentado",
      "",
      "- viñeta",
      "* otra viñeta",
      "",
      "| Atajo | Acción |",
      "| --- | --- |",
      "| `⌘K` | Buscar |"
    ].join("\n"));
    assert.deepEqual(blocks[0], { kind: "heading", level: 1, text: "Título" });
    assert.deepEqual(blocks[1], { kind: "paragraph", text: "Un párrafo que sigue en la línea siguiente." });
    assert.deepEqual(blocks[2], { kind: "heading", level: 2, text: "Pasos" });
    assert.deepEqual(blocks[3], { kind: "list", ordered: true, items: ["Primero", "Segundo - detalle indentado"] });
    assert.deepEqual(blocks[4], { kind: "list", ordered: false, items: ["viñeta", "otra viñeta"] });
    assert.deepEqual(blocks[5], { kind: "table", rows: [["Atajo", "Acción"], ["`⌘K`", "Buscar"]] });
  });

  it("never throws on odd input", () => {
    assert.deepEqual(parseMarkdownBlocks(""), []);
    assert.equal(parseMarkdownBlocks("|||\n| --- |\n").length, 1);
    assert.equal(parseMarkdownBlocks("#\n##\ntexto").length, 1);
  });
});
