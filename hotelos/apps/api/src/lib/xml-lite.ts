// XML-lite (Tanda 7b · L2) — lector mínimo de documentos XML SIN dependencias.
//
// Hermano del XLSX-lite: no hay librería XML en node_modules y la regla del
// runbook prohíbe añadir paquetes, así que el fichero se lee aquí con un
// autómata de una pasada sobre el texto. Cubre lo que traen los exports
// Generic XML Back Office de OPERA Cloud (`GEN_XMLBO_REVENUE`) y los modelos
// de datos de BI Publisher (`findeptcodes` en XML): prólogo `<?xml …?>`,
// instrucciones de proceso, comentarios, CDATA, elementos con atributos,
// elementos vacíos `<a/>`, entidades (`decodeXmlText` del XLSX-lite) y
// prefijos de espacio de nombres (`<ns:revenue>` → `revenue`).
//
// Qué devuelve: un árbol de `XmlNode { name, attrs, children, text }` donde
// `text` es la concatenación (recortada) de los nodos de texto DIRECTOS del
// elemento —los hijos no aportan— con entidades decodificadas y CDATA literal.
//
// Seguridad (anti-XXE y «billion laughs»): cualquier `<!DOCTYPE` o `<!ENTITY`
// se rechaza con XML_LITE_DOCTYPE_REJECTED antes de tokenizar; no se resuelven
// entidades externas ni definidas por el documento; límites por defecto de
// 5 MiB, profundidad 64 y 200.000 nodos (XML_LITE_TOO_LARGE / _TOO_DEEP /
// _TOO_MANY_NODES). Codificación: UTF-8 estricto (BOM eliminado) y, si los
// bytes no son UTF-8 válido, Windows-1252 (override `EXPORT CHARACTER SET`
// de OPERA). Sin acceso a red ni a disco: entrada `string | Uint8Array`,
// salida estructura pura; determinista y testeable.

import { decodeXmlText } from "./xlsx-lite.js";

// ---------------------------------------------------------------------------
// Límites y errores
// ---------------------------------------------------------------------------

/** Tamaño máximo del documento en bytes (5 MiB), igual que PMS_SHADOW_MAX_FILE_BYTES. */
export const XML_LITE_MAX_BYTES = 5 * 1024 * 1024;
/** Profundidad máxima de anidamiento de elementos. */
export const XML_LITE_MAX_DEPTH = 64;
/** Nº máximo de elementos del documento. */
export const XML_LITE_MAX_NODES = 200_000;

export type XmlLiteErrorCode = "XML_LITE_TOO_LARGE" | "XML_LITE_MALFORMED" | "XML_LITE_TOO_DEEP" | "XML_LITE_TOO_MANY_NODES" | "XML_LITE_DOCTYPE_REJECTED";

/** Error tipado del lector: el parser de ingresos lo traduce a PMS_SHADOW_FILE_UNREADABLE / _TOO_LARGE. */
export class XmlLiteError extends Error {
  readonly code: XmlLiteErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: XmlLiteErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "XmlLiteError";
    this.code = code;
    this.details = details;
  }
}

export type XmlLimits = {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
};

export type XmlNode = {
  /** Nombre local del elemento, sin prefijo de espacio de nombres (`<ns:revenue>` → "revenue"). */
  name: string;
  /** Atributos tal como se escriben (nombre con su prefijo si lo lleva), valores con entidades decodificadas. */
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Texto directo del elemento (entidades decodificadas, CDATA literal), recortado. */
  text: string;
};

// ---------------------------------------------------------------------------
// Codificación
// ---------------------------------------------------------------------------

export type XmlDecoded = { text: string; encoding: "utf-8" | "windows-1252"; bom: boolean };

/** Bytes → texto: BOM `EF BB BF` eliminado; UTF-8 estricto y, si no es válido, Windows-1252. */
export function decodeXmlBytes(bytes: Uint8Array): XmlDecoded {
  let bom = false;
  let view = bytes;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = true;
    view = bytes.subarray(3);
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(view), encoding: "utf-8", bom };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(view), encoding: "windows-1252", bom };
  }
}

// ---------------------------------------------------------------------------
// Atributos
// ---------------------------------------------------------------------------

/** Carácter que NO puede formar parte de un nombre de atributo: espacio, `=`, `/`, `>`, comillas. */
function isAttrNameStop(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x3d /* = */ || code === 0x2f /* / */ || code === 0x3e /* > */ || code === 0x22 /* " */ || code === 0x27 /* ' */;
}

function isXmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Atributos de una etiqueta (`name="v"` o `name='v'`), con entidades decodificadas.
 *
 * Escáner LINEAL de una pasada (SEC-01, Tanda 7b): cada carácter se visita una
 * sola vez, sin reintentos por posición. La versión anterior era una regex global
 * `([^\s=/>"']+)\s*=\s*(?:"…"|'…')` que, sobre un segmento sin `=` (p. ej.
 * `<revenue bbbb…>`), reintentaba la clase de nombre desde cada posición: coste
 * O(n²) y un adjunto de 1 MiB bloqueaba el event loop del API varios minutos.
 * Tolerante como antes: un nombre sin `=` o un valor sin comillas se ignora y
 * el escaneo sigue; un valor con comilla sin cerrar termina el escaneo.
 */
export function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const length = tag.length;
  let i = 0;
  while (i < length) {
    // Saltar todo lo que no puede empezar un nombre (espacios, `/`, `>`, `=` suelto, comillas huérfanas).
    while (i < length && isAttrNameStop(tag.charCodeAt(i))) i++;
    if (i >= length) break;
    const nameStart = i;
    while (i < length && !isAttrNameStop(tag.charCodeAt(i))) i++;
    const name = tag.slice(nameStart, i);
    // `\s*=\s*`
    let j = i;
    while (j < length && isXmlSpace(tag.charCodeAt(j))) j++;
    if (j >= length || tag.charCodeAt(j) !== 0x3d) continue; // nombre sin «=»: se ignora, seguimos tras el nombre
    j++;
    while (j < length && isXmlSpace(tag.charCodeAt(j))) j++;
    if (j >= length) break;
    const quote = tag.charCodeAt(j);
    if (quote !== 0x22 && quote !== 0x27) {
      // valor sin comillas: no se admite; seguimos tras el «=»
      i = j;
      continue;
    }
    const close = tag.indexOf(String.fromCharCode(quote), j + 1);
    if (close < 0) break; // comilla sin cerrar: nada más puede casar
    out[name] = decodeXmlText(tag.slice(j + 1, close));
    i = close + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tokenizador
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z_][\w.:-]*$/;

/** `ns:revenue` → `revenue`. */
export function localName(qualified: string): string {
  const colon = qualified.lastIndexOf(":");
  return colon >= 0 ? qualified.slice(colon + 1) : qualified;
}

function malformed(message: string, offset: number): XmlLiteError {
  return new XmlLiteError("XML_LITE_MALFORMED", message, { offset });
}

/** Posición (1-based) de la línea de un desplazamiento, para los mensajes de error. */
function lineOf(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

type Frame = { node: XmlNode; qualified: string };

/**
 * Documento → árbol. Acepta texto o bytes (codificación detectada). Rechaza
 * DOCTYPE / ENTITY, aplica los límites y exige exactamente un elemento raíz.
 */
export function parseXml(input: string | Uint8Array, limits: XmlLimits = {}): XmlNode {
  const maxBytes = limits.maxBytes ?? XML_LITE_MAX_BYTES;
  const maxDepth = limits.maxDepth ?? XML_LITE_MAX_DEPTH;
  const maxNodes = limits.maxNodes ?? XML_LITE_MAX_NODES;

  let text: string;
  if (typeof input === "string") {
    const bytes = Buffer.byteLength(input, "utf8");
    if (bytes > maxBytes) throw new XmlLiteError("XML_LITE_TOO_LARGE", "El documento XML supera el tamaño admitido.", { bytes, max: maxBytes });
    text = input.startsWith("\uFEFF") ? input.slice(1) : input;
  } else {
    if (input.length > maxBytes) throw new XmlLiteError("XML_LITE_TOO_LARGE", "El documento XML supera el tamaño admitido.", { bytes: input.length, max: maxBytes });
    text = decodeXmlBytes(input).text;
  }

  // Anti-XXE / billion laughs: sin DTD interna ni externa, nunca.
  const doctype = /<!\s*(DOCTYPE|ENTITY)\b/i.exec(text);
  if (doctype) {
    throw new XmlLiteError("XML_LITE_DOCTYPE_REJECTED", "El documento XML declara un DOCTYPE o una ENTITY: no se admite (seguridad).", { line: lineOf(text, doctype.index) });
  }

  const stack: Frame[] = [];
  let root: XmlNode | null = null;
  let nodes = 0;
  let pos = 0;
  const length = text.length;

  const appendText = (chunk: string, decode: boolean): void => {
    if (chunk === "") return;
    const top = stack[stack.length - 1];
    if (!top) {
      if (chunk.trim() !== "") throw malformed(`Texto fuera del elemento raíz (línea ${lineOf(text, pos)}).`, pos);
      return;
    }
    top.node.text += decode ? decodeXmlText(chunk) : chunk;
  };

  while (pos < length) {
    const lt = text.indexOf("<", pos);
    if (lt < 0) {
      appendText(text.slice(pos), true);
      pos = length;
      break;
    }
    if (lt > pos) appendText(text.slice(pos, lt), true);

    // Comentario
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end < 0) throw malformed(`Comentario sin cerrar (línea ${lineOf(text, lt)}).`, lt);
      pos = end + 3;
      continue;
    }
    // CDATA
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      if (end < 0) throw malformed(`Sección CDATA sin cerrar (línea ${lineOf(text, lt)}).`, lt);
      if (stack.length === 0) throw malformed(`CDATA fuera del elemento raíz (línea ${lineOf(text, lt)}).`, lt);
      appendText(text.slice(lt + 9, end), false);
      pos = end + 3;
      continue;
    }
    // Prólogo e instrucciones de proceso
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      if (end < 0) throw malformed(`Instrucción de proceso sin cerrar (línea ${lineOf(text, lt)}).`, lt);
      pos = end + 2;
      continue;
    }
    // Cualquier otra declaración `<!…>` (ya se rechazaron DOCTYPE / ENTITY)
    if (text.startsWith("<!", lt)) {
      throw malformed(`Declaración no admitida (línea ${lineOf(text, lt)}).`, lt);
    }

    const gt = findTagEnd(text, lt);
    if (gt < 0) throw malformed(`Etiqueta sin cerrar «>» (línea ${lineOf(text, lt)}).`, lt);
    const body = text.slice(lt + 1, gt);

    // Cierre
    if (body.startsWith("/")) {
      const qualified = body.slice(1).trim();
      const top = stack.pop();
      if (!top) throw malformed(`Etiqueta de cierre </${qualified}> sin apertura (línea ${lineOf(text, lt)}).`, lt);
      if (top.qualified !== qualified) {
        throw malformed(`Etiqueta de cierre </${qualified}> no coincide con <${top.qualified}> (línea ${lineOf(text, lt)}).`, lt);
      }
      top.node.text = top.node.text.trim();
      pos = gt + 1;
      continue;
    }

    // Apertura o elemento vacío
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameEnd = inner.search(/[\s/]/);
    const qualified = (nameEnd < 0 ? inner : inner.slice(0, nameEnd)).trim();
    if (!NAME_RE.test(qualified)) throw malformed(`Nombre de elemento no válido (línea ${lineOf(text, lt)}).`, lt);
    if (stack.length === 0 && root) throw malformed(`Más de un elemento raíz (línea ${lineOf(text, lt)}).`, lt);
    nodes++;
    if (nodes > maxNodes) throw new XmlLiteError("XML_LITE_TOO_MANY_NODES", "El documento XML tiene demasiados elementos.", { max: maxNodes });
    if (stack.length + 1 > maxDepth) throw new XmlLiteError("XML_LITE_TOO_DEEP", "El documento XML está anidado más allá de la profundidad admitida.", { max: maxDepth });

    const node: XmlNode = { name: localName(qualified), attrs: nameEnd < 0 ? {} : parseAttrs(inner.slice(nameEnd)), children: [], text: "" };
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else root = node;
    if (!selfClosing) stack.push({ node, qualified });
    pos = gt + 1;
  }

  if (stack.length > 0) {
    const open = stack[stack.length - 1]!;
    throw malformed(`El elemento <${open.qualified}> no se cierra antes del final del documento.`, length);
  }
  if (!root) throw malformed("El documento XML no tiene elemento raíz.", 0);
  return root;
}

/** Índice del «>» que cierra la etiqueta abierta en `start`, respetando comillas en los atributos; −1 si no existe. */
function findTagEnd(text: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
    if (ch === "<") return -1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Helpers de consulta
// ---------------------------------------------------------------------------

/** Hijos DIRECTOS con ese nombre local (exacto). */
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

/** Texto del primer hijo directo con ese nombre; null si no existe. */
export function childText(node: XmlNode, name: string): string | null {
  const child = node.children.find((candidate) => candidate.name === name);
  return child ? child.text : null;
}

/** Primer elemento (el propio nodo o un descendiente, en profundidad) con ese nombre local; null si no existe. */
export function findFirst(node: XmlNode, name: string): XmlNode | null {
  if (node.name === name) return node;
  for (const child of node.children) {
    const found = findFirst(child, name);
    if (found) return found;
  }
  return null;
}

/** Todos los elementos (el propio nodo y descendientes, en profundidad, orden del documento) con ese nombre local. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (current: XmlNode): void => {
    if (current.name === name) out.push(current);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return out;
}

/** Recorrido en profundidad con callback (orden del documento). */
export function walkXml(node: XmlNode, visit: (node: XmlNode, depth: number) => void, depth = 0): void {
  visit(node, depth);
  for (const child of node.children) walkXml(child, visit, depth + 1);
}
