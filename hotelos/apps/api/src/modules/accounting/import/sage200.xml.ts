// Importación contable desde Sage 200 (Tanda 7c · L1) — XML «Datos contables», PURO.
//
// Sage 200 exporta la contabilidad como ZIP `Temporal.zip` con XML sueltos cuya
// estructura no está publicada (diseño §2.1 B, hueco 2 de §10.3): sin una
// exportación real de la sociedad no se puede escribir el parser. Este módulo
// deja lo que sí se puede hacer sin ella:
//   · `inspectSageXml(bytes)` — acepta un XML suelto o el ZIP (`readZipCentralDirectory`
//     + `inflateZipEntry` de xlsx-lite, cada parte `.xml` inspeccionada) y devuelve
//     los BLOQUES (nombres locales de los hijos del elemento raíz, en orden de
//     aparición y sin repetir), el nº de registros (hijos del raíz), el nº total de
//     elementos y los ficheros leídos; límites EXPLÍCITOS `SAGE_XML_LIMITS`
//     (LEDGER_IMPORT_MAX_BYTES, 2.000.000 nodos, profundidad 64) en vez de los
//     5 MiB / 200.000 por defecto del lector;
//   · `parseSageXml(bytes)` — inspecciona y lanza SIEMPRE
//     LEDGER_IMPORT_XML_UNSUPPORTED { blocks, entries, files } (se cierra con una
//     exportación real: los nodos se leerán por nombre de campo de §2.1 C/D).
//
// Sin Prisma, sin red, sin disco.

import { LEDGER_IMPORT_MAX_BYTES } from "@hotelos/shared";
import { XlsxLiteError, inflateZipEntry, readZipCentralDirectory } from "../../../lib/xlsx-lite.js";
import { XmlLiteError, decodeXmlBytes, localName, parseXml, walkXml, type XmlLimits, type XmlNode } from "../../../lib/xml-lite.js";
import { LedgerImportParseError, hasZipSignature } from "./ledger-import.canonical.js";

/** Límites explícitos del lector XML del lote (por encima de los 5 MiB / 200.000 nodos por defecto de xml-lite). */
export const SAGE_XML_LIMITS: Readonly<Required<XmlLimits>> = Object.freeze({
  maxBytes: LEDGER_IMPORT_MAX_BYTES,
  maxNodes: 2_000_000,
  maxDepth: 64
});

/** Nº máximo de partes .xml de un ZIP que se inspeccionan. */
export const SAGE_XML_MAX_PARTS = 200;

export type SageXmlBlock = {
  /** Nombre local del bloque (hijo del raíz). */
  name: string;
  /** Nº de elementos con ese nombre bajo el raíz. */
  count: number;
  /** Fichero del ZIP (o "<xml>" si el XML llegó suelto). */
  file: string;
};

export type SageXmlInspection = {
  /** Nombres de bloque distintos, en orden de aparición. */
  blocks: string[];
  /** Detalle por bloque y fichero. */
  blockDetails: SageXmlBlock[];
  /** Registros = hijos del elemento raíz (suma de todos los ficheros). */
  entries: number;
  /** Elementos totales del documento (suma). */
  nodes: number;
  /** Ficheros inspeccionados (nombre de la parte del ZIP o "<xml>"). */
  files: string[];
  /** Nombre local del raíz por fichero. */
  roots: string[];
  warnings: string[];
};

function isXmlPart(name: string): boolean {
  return /\.xml$/i.test(name);
}

function inspectDocument(root: XmlNode, file: string, into: SageXmlInspection): void {
  into.roots.push(localName(root.name));
  const counts = new Map<string, number>();
  for (const child of root.children) {
    const name = localName(child.name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const [name, count] of counts) {
    into.blockDetails.push({ name, count, file });
    if (!into.blocks.includes(name)) into.blocks.push(name);
  }
  into.entries += root.children.length;
  let nodes = 0;
  walkXml(root, () => {
    nodes += 1;
  });
  into.nodes += nodes;
  into.files.push(file);
}

function parseOne(bytes: Uint8Array, file: string, into: SageXmlInspection): void {
  try {
    const root = parseXml(bytes, SAGE_XML_LIMITS);
    inspectDocument(root, file, into);
  } catch (error) {
    if (error instanceof XmlLiteError) {
      if (error.code === "XML_LITE_TOO_LARGE") {
        throw new LedgerImportParseError("LEDGER_IMPORT_TOO_LARGE", `El XML ${file === "<xml>" ? "" : `«${file}» `}supera el tamaño admitido (20 MB).`, { file, ...(error.details ?? {}) });
      }
      throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", `El XML ${file === "<xml>" ? "" : `«${file}» `}no se puede leer: ${error.message}`, { errors: [{ line: Number((error.details as { line?: number } | undefined)?.line ?? 0), message: error.message }], reason: error.code, file });
    }
    throw error;
  }
}

/**
 * XML suelto o ZIP `Temporal.zip` → bloques, registros y ficheros. Nunca escribe; los
 * bytes mayores que LEDGER_IMPORT_MAX_BYTES → LEDGER_IMPORT_TOO_LARGE; un ZIP sin partes
 * .xml → LEDGER_IMPORT_INVALID.
 */
export function inspectSageXml(bytes: Uint8Array): SageXmlInspection {
  if (bytes.length > LEDGER_IMPORT_MAX_BYTES) {
    throw new LedgerImportParseError("LEDGER_IMPORT_TOO_LARGE", "El fichero supera el tamaño admitido (20 MB).", { bytes: bytes.length, max: LEDGER_IMPORT_MAX_BYTES });
  }
  const inspection: SageXmlInspection = { blocks: [], blockDetails: [], entries: 0, nodes: 0, files: [], roots: [], warnings: [] };
  if (hasZipSignature(bytes)) {
    let entries;
    try {
      entries = readZipCentralDirectory(bytes);
    } catch (error) {
      if (error instanceof XlsxLiteError) throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", `El ZIP no se puede leer: ${error.message}`, { errors: [{ line: 0, message: error.message }], reason: error.code });
      throw error;
    }
    const xmlParts = entries.filter((entry) => isXmlPart(entry.name));
    if (xmlParts.length === 0) {
      throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", "El ZIP no contiene ningún fichero .xml.", { errors: [{ line: 0, message: "ZIP sin partes .xml" }], files: entries.map((entry) => entry.name).slice(0, 50) });
    }
    if (xmlParts.length > SAGE_XML_MAX_PARTS) inspection.warnings.push(`El ZIP tiene ${xmlParts.length} ficheros .xml: solo se inspeccionan los ${SAGE_XML_MAX_PARTS} primeros.`);
    let total = 0;
    for (const part of xmlParts.slice(0, SAGE_XML_MAX_PARTS)) {
      let data: Uint8Array;
      try {
        data = inflateZipEntry(bytes, part);
      } catch (error) {
        if (error instanceof XlsxLiteError) throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", `La parte «${part.name}» del ZIP no se puede descomprimir: ${error.message}`, { errors: [{ line: 0, message: error.message }], reason: error.code, file: part.name });
        throw error;
      }
      total += data.length;
      if (total > LEDGER_IMPORT_MAX_BYTES) {
        throw new LedgerImportParseError("LEDGER_IMPORT_TOO_LARGE", "Los XML del ZIP descomprimidos superan el tamaño admitido (20 MB).", { bytes: total, max: LEDGER_IMPORT_MAX_BYTES, file: part.name });
      }
      parseOne(data, part.name, inspection);
    }
    return inspection;
  }
  const decoded = decodeXmlBytes(bytes);
  if (!/^\s*<\?xml|^\s*</.test(decoded.text)) {
    throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", "El fichero no es un XML (no empieza por «<»).", { errors: [{ line: 1, message: "no es XML" }] });
  }
  parseOne(bytes, "<xml>", inspection);
  return inspection;
}

/**
 * Punto de entrada del formato `sage_xml`: inspecciona y lanza LEDGER_IMPORT_XML_UNSUPPORTED
 * con la lista de bloques encontrados (hueco 2 del diseño §10.3: se cierra con una
 * exportación real de la sociedad).
 */
export function parseSageXml(bytes: Uint8Array): never {
  const inspection = inspectSageXml(bytes);
  throw new LedgerImportParseError(
    "LEDGER_IMPORT_XML_UNSUPPORTED",
    `El XML «Datos contables» de Sage 200 aún no se puede importar (bloques encontrados: ${inspection.blocks.length > 0 ? inspection.blocks.join(", ") : "ninguno"}): exporta a Excel o CSV.`,
    { blocks: inspection.blocks, entries: inspection.entries, nodes: inspection.nodes, files: inspection.files, roots: inspection.roots, warnings: inspection.warnings }
  );
}
