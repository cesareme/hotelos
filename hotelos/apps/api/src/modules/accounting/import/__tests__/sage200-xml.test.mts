// Unit tests · Tanda 7c · L1 — inspector del XML «Datos contables» de Sage 200 (hueco 2 del
// diseño §10.3): bloques informados, ZIP Temporal.zip, límites explícitos y el error
// LEDGER_IMPORT_XML_UNSUPPORTED. Puros, sin base de datos. Desde apps/api:
//   node --import tsx --test src/modules/accounting/import/__tests__/sage200-xml.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LEDGER_IMPORT_MAX_BYTES } from "@hotelos/shared";
import { XML_LITE_MAX_BYTES, XML_LITE_MAX_NODES } from "../../../../lib/xml-lite.js";
import { LedgerImportParseError } from "../ledger-import.canonical.js";
import { SAGE_XML_LIMITS, inspectSageXml, parseSageXml } from "../sage200.xml.js";
import { parseLedgerImportFile } from "../sage200.parser.js";
import { SAGE_XML_SAMPLE, sageXmlZip } from "./fixtures/sage200-fixtures.mjs";

function errorOf(fn: () => unknown): LedgerImportParseError {
  try {
    fn();
  } catch (error) {
    if (error instanceof LedgerImportParseError) return error;
    throw error;
  }
  throw new Error("no lanzó");
}

describe("inspectSageXml", () => {
  it("XML suelto: bloques = hijos del raíz en orden y sin repetir, registros y nodos", () => {
    const inspection = inspectSageXml(Buffer.from(SAGE_XML_SAMPLE, "utf8"));
    assert.deepEqual(inspection.blocks, ["PlanCuentas", "Movimientos", "MovimientosAnalitica", "BloqueDesconocido"]);
    assert.deepEqual(inspection.roots, ["DatosContables"]);
    assert.deepEqual(inspection.files, ["<xml>"]);
    assert.equal(inspection.entries, 4);
    assert.equal(inspection.nodes, 11);
    assert.deepEqual(inspection.blockDetails.map((b) => [b.name, b.count]), [["PlanCuentas", 1], ["Movimientos", 1], ["MovimientosAnalitica", 1], ["BloqueDesconocido", 1]]);
  });

  it("ZIP Temporal.zip: inspecciona cada .xml (los demás ficheros se ignoran) y acumula bloques", () => {
    const inspection = inspectSageXml(sageXmlZip());
    assert.deepEqual(inspection.files, ["DatosContables.xml", "ClientesProveedores.xml"]);
    assert.deepEqual(inspection.roots, ["DatosContables", "ClientesProveedores"]);
    assert.deepEqual(inspection.blocks, ["PlanCuentas", "Movimientos", "MovimientosAnalitica", "BloqueDesconocido", "Cliente", "Proveedor"]);
    assert.equal(inspection.entries, 6);
    assert.equal(inspection.blockDetails.find((b) => b.name === "Cliente")?.file, "ClientesProveedores.xml");
  });

  it("prefijos de espacio de nombres: los bloques se informan por nombre local", () => {
    const xml = `<?xml version="1.0"?><s:Datos xmlns:s="urn:sage"><s:PlanCuentas/><s:Movimientos><s:M/></s:Movimientos></s:Datos>`;
    const inspection = inspectSageXml(Buffer.from(xml, "utf8"));
    assert.deepEqual(inspection.blocks, ["PlanCuentas", "Movimientos"]);
    assert.deepEqual(inspection.roots, ["Datos"]);
  });

  it("límites EXPLÍCITOS: 20 MiB, 2.000.000 nodos y profundidad 64 (por encima de los 5 MiB / 200.000 del lector)", () => {
    assert.deepEqual(SAGE_XML_LIMITS, { maxBytes: LEDGER_IMPORT_MAX_BYTES, maxNodes: 2_000_000, maxDepth: 64 });
    assert.ok(SAGE_XML_LIMITS.maxBytes > XML_LITE_MAX_BYTES);
    assert.ok(SAGE_XML_LIMITS.maxNodes > XML_LITE_MAX_NODES);
    // Un documento con más nodos que el límite por defecto del lector se inspecciona sin error.
    const count = XML_LITE_MAX_NODES + 1_000;
    const xml = `<Datos><Movimientos>${"<m/>".repeat(count)}</Movimientos></Datos>`;
    const inspection = inspectSageXml(Buffer.from(xml, "utf8"));
    assert.equal(inspection.nodes, count + 2);
    assert.deepEqual(inspection.blocks, ["Movimientos"]);
  });

  it("errores tipados: no XML, DOCTYPE, ZIP sin .xml y fichero mayor que el límite", () => {
    const notXml = errorOf(() => inspectSageXml(Buffer.from("hola;mundo\n1;2\n", "utf8")));
    assert.equal(notXml.code, "LEDGER_IMPORT_INVALID");
    const doctype = errorOf(() => inspectSageXml(Buffer.from(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><Datos/>`, "utf8")));
    assert.equal(doctype.code, "LEDGER_IMPORT_INVALID");
    assert.equal(doctype.details?.reason, "XML_LITE_DOCTYPE_REJECTED");
    const tooLarge = errorOf(() => inspectSageXml(new Uint8Array(LEDGER_IMPORT_MAX_BYTES + 1)));
    assert.equal(tooLarge.code, "LEDGER_IMPORT_TOO_LARGE");
    assert.equal(tooLarge.details?.max, LEDGER_IMPORT_MAX_BYTES);
  });
});

describe("parseSageXml · LEDGER_IMPORT_XML_UNSUPPORTED (hueco 2)", () => {
  it("lanza siempre con la lista de bloques encontrados", () => {
    const error = errorOf(() => parseSageXml(Buffer.from(SAGE_XML_SAMPLE, "utf8")));
    assert.equal(error.code, "LEDGER_IMPORT_XML_UNSUPPORTED");
    assert.deepEqual(error.details?.blocks, ["PlanCuentas", "Movimientos", "MovimientosAnalitica", "BloqueDesconocido"]);
    assert.equal(error.details?.entries, 4);
    assert.match(error.message, /BloqueDesconocido/);
  });

  it("parseLedgerImportFile enruta .xml y .zip al inspector y devuelve el mismo error", () => {
    const fromXml = errorOf(() => parseLedgerImportFile({ kind: "journal", bytes: Buffer.from(SAGE_XML_SAMPLE, "utf8"), fileName: "DatosContables.xml" }));
    assert.equal(fromXml.code, "LEDGER_IMPORT_XML_UNSUPPORTED");
    const fromZip = errorOf(() => parseLedgerImportFile({ kind: "plan", bytes: sageXmlZip(), fileName: "Temporal.zip" }));
    assert.equal(fromZip.code, "LEDGER_IMPORT_XML_UNSUPPORTED");
    assert.deepEqual(fromZip.details?.files, ["DatosContables.xml", "ClientesProveedores.xml"]);
    // Sin extensión: la firma «<» basta.
    const byContent = errorOf(() => parseLedgerImportFile({ kind: "journal", bytes: Buffer.from(SAGE_XML_SAMPLE, "utf8") }));
    assert.equal(byContent.code, "LEDGER_IMPORT_XML_UNSUPPORTED");
  });
});
