// Unit tests · Tanda 7b · L2 — lector XML mínimo (apps/api/src/lib/xml-lite.ts).
// Sin base de datos. Desde apps/api:
//   node --import tsx --test src/lib/__tests__/xml-lite.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  XML_LITE_MAX_BYTES,
  XML_LITE_MAX_DEPTH,
  XML_LITE_MAX_NODES,
  XmlLiteError,
  childText,
  childrenNamed,
  decodeXmlBytes,
  findAll,
  findFirst,
  localName,
  parseAttrs,
  parseXml,
  walkXml
} from "../xml-lite.js";

function expectError(fn: () => unknown, code: string): XmlLiteError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof XmlLiteError, `esperaba XmlLiteError, llegó ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`esperaba ${code}`);
}

const VALID = `<?xml version="1.0" encoding="UTF-8"?>
<!-- export sintético -->
<ns:revenue xmlns:ns="urn:opera" hotel_code="RIAS" date="2026-09-15">
  <transaction_total transaction_type="REVENUE">
    <transaction_code>1000</transaction_code>
    <description><![CDATA[Alojamiento <habitaciones> & desayuno]]></description>
    <total_amount>1234.50</total_amount>
    <note>caf&#233; &amp; t&#xE9; &lt;ok&gt; &quot;x&quot; &apos;y&apos;</note>
    <empty/>
    <transaction_details>
      <transaction market_code='FIT' room_class="STD"><trx_amount>1000.00</trx_amount></transaction>
      <transaction market_code="CORP" room_class="STD"><trx_amount>234.50</trx_amount></transaction>
    </transaction_details>
  </transaction_total>
  <transaction_total transaction_type="PAYMENT">
    <transaction_code>9000</transaction_code>
    <description>Cash</description>
    <total_amount>-900.00</total_amount>
  </transaction_total>
</ns:revenue>
`;

describe("xml-lite · documento válido", () => {
  it("prólogo, comentario, prefijo de namespace, atributos, CDATA, entidades y self-closing", () => {
    const root = parseXml(VALID);
    assert.equal(root.name, "revenue", "el prefijo ns: se elimina del nombre");
    assert.equal(root.attrs.hotel_code, "RIAS");
    assert.equal(root.attrs.date, "2026-09-15");
    assert.equal(root.attrs["xmlns:ns"], "urn:opera", "los atributos conservan su nombre tal cual");
    assert.equal(root.text, "", "el texto directo (solo espacios) se recorta a vacío");
    const totals = childrenNamed(root, "transaction_total");
    assert.equal(totals.length, 2);
    const first = totals[0]!;
    assert.equal(first.attrs.transaction_type, "REVENUE");
    assert.equal(childText(first, "transaction_code"), "1000");
    assert.equal(childText(first, "description"), "Alojamiento <habitaciones> & desayuno", "CDATA literal");
    assert.equal(childText(first, "total_amount"), "1234.50");
    assert.equal(childText(first, "note"), "café & té <ok> \"x\" 'y'", "entidades decimales, hex y con nombre");
    assert.equal(childText(first, "empty"), "", "elemento vacío → texto vacío");
    assert.equal(childText(first, "nope"), null);
    const details = findFirst(first, "transaction_details")!;
    assert.equal(details.children.length, 2);
    assert.equal(details.children[0]!.attrs.market_code, "FIT", "comillas simples admitidas");
    assert.equal(childText(details.children[1]!, "trx_amount"), "234.50");
    assert.equal(findAll(root, "transaction").length, 2);
    assert.equal(childText(totals[1]!, "total_amount"), "-900.00");
    let count = 0;
    walkXml(root, () => count++);
    assert.equal(count, 16, "16 elementos en el documento");
  });

  it("bytes UTF-8 con BOM y texto mixto", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from("<a x=\"1\">hola <b>mundo</b> adiós</a>", "utf8")]);
    const root = parseXml(bytes);
    assert.equal(root.name, "a");
    assert.equal(root.attrs.x, "1");
    assert.equal(root.text, "hola  adiós", "el texto directo no incluye el de los hijos");
    assert.equal(childText(root, "b"), "mundo");
    const decoded = decodeXmlBytes(bytes);
    assert.equal(decoded.encoding, "utf-8");
    assert.equal(decoded.bom, true);
  });

  it("localName y parseAttrs", () => {
    assert.equal(localName("ns:revenue"), "revenue");
    assert.equal(localName("revenue"), "revenue");
    assert.deepEqual(parseAttrs(` a="1" b='dos' c="&amp;&lt;" `), { a: "1", b: "dos", c: "&<" });
  });
});

describe("xml-lite · Windows-1252", () => {
  it("bytes no UTF-8 se leen como windows-1252 (0xE9 → é, 0x80 → €)", () => {
    const bytes = Buffer.concat([Buffer.from("<r><d>caf", "latin1"), Buffer.from([0xe9, 0x20, 0x80]), Buffer.from("</d></r>", "latin1")]);
    const decoded = decodeXmlBytes(bytes);
    assert.equal(decoded.encoding, "windows-1252");
    const root = parseXml(bytes);
    assert.equal(childText(root, "d"), "café €");
  });
});

describe("xml-lite · malformado", () => {
  it("cierre que no coincide", () => {
    expectError(() => parseXml("<a><b></a></b>"), "XML_LITE_MALFORMED");
  });
  it("elemento sin cerrar al final", () => {
    expectError(() => parseXml("<a><b>x</b>"), "XML_LITE_MALFORMED");
  });
  it("etiqueta sin «>»", () => {
    expectError(() => parseXml("<a><b x=\"1\"</a>"), "XML_LITE_MALFORMED");
  });
  it("dos raíces", () => {
    expectError(() => parseXml("<a/><b/>"), "XML_LITE_MALFORMED");
  });
  it("texto fuera de la raíz y documento vacío", () => {
    expectError(() => parseXml("hola<a/>"), "XML_LITE_MALFORMED");
    expectError(() => parseXml("   "), "XML_LITE_MALFORMED");
  });
  it("comentario y CDATA sin cerrar", () => {
    expectError(() => parseXml("<a><!-- x </a>"), "XML_LITE_MALFORMED");
    expectError(() => parseXml("<a><![CDATA[ x </a>"), "XML_LITE_MALFORMED");
  });
  it("nombre de elemento no válido", () => {
    expectError(() => parseXml("<1a/>"), "XML_LITE_MALFORMED");
  });
});

describe("xml-lite · seguridad y límites", () => {
  it("SEC-01 · el segmento de atributos se escanea en tiempo lineal (sin `=`, 1 MiB en bien menos de 2 s; antes ~13 min)", () => {
    const sizes = [20_000, 200_000, 1_000_000];
    const timings = sizes.map((n) => {
      const started = performance.now();
      const node = parseXml(`<revenue ${"b".repeat(n)}></revenue>`);
      assert.equal(node.name, "revenue");
      assert.deepEqual(node.attrs, {});
      return performance.now() - started;
    });
    for (const [index, ms] of timings.entries()) assert.ok(ms < 2_000, `${sizes[index]} chars → ${Math.round(ms)} ms`);
    // Segmento con muchos nombres sin valor, valores sin comillas y una comilla sin cerrar: tolerante y lineal.
    const started = performance.now();
    const attrs = parseAttrs(`${"n ".repeat(100_000)} a=b c="1" d='2' e="sin cerrar`);
    assert.ok(performance.now() - started < 2_000);
    assert.deepEqual(attrs, { c: "1", d: "2" });
  });

  it("parseAttrs tolera nombres sin «=», valores sin comillas, «=» con espacios y comillas dentro del otro tipo", () => {
    assert.deepEqual(parseAttrs(`x y=z w="1" k="a b=" q='it"s' r = "3"/`), { w: "1", k: "a b=", q: 'it"s', r: "3" });
    assert.deepEqual(parseAttrs(""), {});
    assert.deepEqual(parseAttrs("   /"), {});
  });

  it("DOCTYPE y ENTITY se rechazan (anti-XXE / billion laughs)", () => {
    expectError(() => parseXml('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "y">]><r>&x;</r>'), "XML_LITE_DOCTYPE_REJECTED");
    expectError(() => parseXml('<!DOCTYPE r SYSTEM "file:///etc/passwd"><r/>'), "XML_LITE_DOCTYPE_REJECTED");
    expectError(() => parseXml("<r><!ENTITY x 'y'></r>"), "XML_LITE_DOCTYPE_REJECTED");
    expectError(() => parseXml("<!doctype r><r/>"), "XML_LITE_DOCTYPE_REJECTED");
  });

  it("límite de bytes", () => {
    const error = expectError(() => parseXml("<r>" + "x".repeat(200) + "</r>", { maxBytes: 100 }), "XML_LITE_TOO_LARGE");
    assert.equal(error.details?.max, 100);
    const big = new Uint8Array(XML_LITE_MAX_BYTES + 1);
    expectError(() => parseXml(big), "XML_LITE_TOO_LARGE");
  });

  it("límite de profundidad", () => {
    const nested = "<a>".repeat(10) + "</a>".repeat(10);
    expectError(() => parseXml(nested, { maxDepth: 5 }), "XML_LITE_TOO_DEEP");
    assert.equal(parseXml(nested, { maxDepth: 10 }).name, "a");
    assert.equal(XML_LITE_MAX_DEPTH, 64);
  });

  it("límite de nodos", () => {
    const many = "<r>" + "<x/>".repeat(20) + "</r>";
    expectError(() => parseXml(many, { maxNodes: 10 }), "XML_LITE_TOO_MANY_NODES");
    assert.equal(parseXml(many, { maxNodes: 21 }).children.length, 20);
    assert.equal(XML_LITE_MAX_NODES, 200_000);
  });
});
