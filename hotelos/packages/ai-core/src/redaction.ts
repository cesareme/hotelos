// Redacción reversible de PII antes de enviar texto al proveedor.
//
// Cada llamada crea un mapa en memoria marcador → valor original; el mismo
// valor recibe siempre el mismo marcador y `restorePii` deshace la sustitución
// en la respuesta (texto, JSON estructurado o `input` de tool_use). Los
// marcadores viajan entre corchetes ([NOMBRE_1], [TEL_2]…) y se restauran
// aunque el modelo los devuelva sin corchetes o entre comillas latinas.
//
// Un valor ya aprendido (p. ej. el nombre tras «Sra.» en el primer turno) se
// sustituye en los textos siguientes aunque aparezca sin tratamiento ni formato
// reconocible (tool_result, input de tool_use previos, turnos del asistente).
//
// Nunca se aplica sobre bytes: las URL de datos y los bloques base64 largos se
// bloquean antes de pasar los detectores (las imágenes y PDF van íntegros y su
// tratamiento lo decide la política id-scan, nunca este módulo).
//
// Detectores: correo; teléfono (+34 / prefijo internacional / 9 dígitos con
// separadores); NIF, NIE y CIF con carácter de control válido (reutiliza
// @hotelos/compliance); pasaporte ([A-Z]{3}[0-9]{6} y [A-Z]{2}[0-9]{6,7}); PAN
// de 13-19 dígitos válido por Luhn; nombres (≤ 3 tokens capitalizados) tras
// Sr./Sra./Srta./Don/Doña/D./Dña. y tras las fórmulas habituales de
// presentación («soy», «me llamo», «se llama», «mi nombre es», «a nombre de»,
// «mi hija/marido/…», despedidas «atentamente,» / «firmado:»); «habitación 123»
// opcional. Corrección 1 (SEC-07): `knownPii` siembra en el mapa la PII
// estructurada que el llamador ya conoce (nombre, correo, teléfono del huésped
// de la conversación) para que se sustituya aunque aparezca sin tratamiento.

import { classifySpanishTaxId, isValidSpanishTaxId } from "@hotelos/compliance";

import { AiError } from "./errors.js";

export type PiiKind = "email" | "phone" | "document" | "card" | "name" | "room";

/** Marcador → valor original (sin corchetes en la clave). */
export type PiiMap = Record<string, string>;

export type KnownPii = { kind: PiiKind; value: string };

export type RedactPiiOptions = {
  /** Tipos a detectar; por defecto todos salvo `room`. */
  kinds?: readonly PiiKind[];
  /** Atajo para incluir `room` (números de habitación). */
  roomNumbers?: boolean;
  /** PII ya conocida (≥ 3 caracteres): recibe marcador antes de los detectores y se sustituye siempre. */
  knownPii?: ReadonlyArray<KnownPii>;
};

export type RedactionResult = { text: string; map: PiiMap; count: number };

export type PiiRedactor = {
  /** Redacta un texto más, reutilizando el mapa acumulado. */
  redact(text: string): string;
  readonly map: PiiMap;
  readonly count: number;
};

export const PII_MARKER_PREFIX: Readonly<Record<PiiKind, string>> = Object.freeze({
  email: "EMAIL",
  phone: "TEL",
  document: "DOC",
  card: "TARJETA",
  name: "NOMBRE",
  room: "HAB"
});

/** Orden de detección: primero los tipos más largos/específicos para evitar solapes. */
export const DEFAULT_PII_KINDS: readonly PiiKind[] = Object.freeze(["email", "card", "document", "phone", "name"]);

type Hit = { start: number; end: number; value: string; kind: PiiKind };
type Segment = { text: string; locked: boolean };

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const CARD_RE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const TAX_ID_RE = /(?<![A-Za-z0-9])(?:[XYZKLMxyzklm][ -]?\d{7}[ -]?[A-Za-z]|\d{8}[ -]?[A-Za-z]|[A-Za-z][ -]?\d{7}[ -]?[0-9A-Ja-j])(?![A-Za-z0-9])/g;
const PASSPORT_RE = /(?<![A-Za-z0-9])(?:[A-Z]{3}\d{6}|[A-Z]{2}\d{6,7})(?![A-Za-z0-9])/g;
const PHONE_INTL_RE = /(?<![\d+])(?:\+|00)\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,6}(?!\d)/g;
const PHONE_ES_RE = /(?<![\d+])[6-9]\d{2}[ .-]?\d{3}[ .-]?\d{3}(?!\d)/g;
const NAME_TOKENS = "([A-ZÁÉÍÓÚÑÜ][\\p{L}'’-]*(?:\\s+[A-ZÁÉÍÓÚÑÜ][\\p{L}'’-]*){0,2})";
const NAME_RE = new RegExp(`(?<!\\p{L})(Sra\\.|Srta\\.|Sr\\.|Doña|Dña\\.|Don|D\\.)\\s+${NAME_TOKENS}`, "gu");
/** Fórmulas de presentación y despedida (sin bandera `i`: los tokens del nombre deben ir en mayúscula). */
const NAME_INTRO_RE = new RegExp(
  "(?<!\\p{L})(" +
    "[Mm]e llamo|[Nn]os llamamos|[Ss]e llama|[Mm]i nombre es|[Aa] nombre de|[Ss]oy|[Ss]omos|[Ff]irmado:?|[Aa]tentamente,?|[Cc]ordialmente,?|[Uu]n saludo,?|[Ss]aludos,?|" +
    "(?:[Mm]i|[Nn]uestr[ao]|[Ss]u)\\s+(?:hija|hijo|mujer|marido|esposa|esposo|pareja|madre|padre|hermana|hermano|amiga|amigo|compañera|compañero|acompañante)" +
    `)\\s+${NAME_TOKENS}`,
  "gu"
);
const TREATMENT_TOKENS: ReadonlySet<string> = new Set(["Sra", "Srta", "Sr", "Doña", "Dña", "Don", "D"]);
const ROOM_RE = /(?<!\p{L})(habitaci[oó]n|hab\.?|room)\s*(?:n[ºo°]\.?\s*|#\s*)?(\d{1,4}[A-Za-z]?)(?![\p{L}\d])/giu;
const DATA_URL_RE = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/gi;
const LONG_BASE64_RE = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{64,}(?![A-Za-z0-9+/=_-])/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collect(regex: RegExp, text: string, kind: PiiKind, accept: (match: RegExpExecArray) => { start: number; end: number; value: string } | null): Hit[] {
  const hits: Hit[] = [];
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    const accepted = accept(match);
    if (accepted) hits.push({ ...accepted, kind });
  }
  return hits;
}

function whole(match: RegExpExecArray): { start: number; end: number; value: string } {
  return { start: match.index, end: match.index + match[0].length, value: match[0] };
}

const DETECTORS: Record<PiiKind, (text: string) => Hit[]> = {
  email: (text) => collect(EMAIL_RE, text, "email", whole),
  card: (text) =>
    collect(CARD_RE, text, "card", (match) => {
      const digits = match[0].replace(/\D/g, "");
      if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return null;
      return whole(match);
    }),
  document: (text) => {
    const taxIds = collect(TAX_ID_RE, text, "document", (match) => {
      const normalized = match[0].toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!classifySpanishTaxId(normalized) || !isValidSpanishTaxId(normalized)) return null;
      return whole(match);
    });
    const passports = collect(PASSPORT_RE, text, "document", whole);
    return [...taxIds, ...passports];
  },
  phone: (text) => {
    const intl = collect(PHONE_INTL_RE, text, "phone", (match) => {
      const digits = match[0].replace(/\D/g, "");
      if (digits.length < 9 || digits.length > 15) return null;
      return whole(match);
    });
    const national = collect(PHONE_ES_RE, text, "phone", whole);
    return [...intl, ...national];
  },
  name: (text) => {
    const accept = (match: RegExpExecArray): { start: number; end: number; value: string } | null => {
      const name = match[2] ?? "";
      if (!name) return null;
      const start = match.index + match[0].length - name.length;
      return { start, end: start + name.length, value: name };
    };
    // Tras una fórmula de presentación puede venir un tratamiento («Firmado: Sra. X»): lo resuelve NAME_RE.
    const acceptIntro = (match: RegExpExecArray): { start: number; end: number; value: string } | null => {
      const first = (match[2] ?? "").split(/\s+/)[0] ?? "";
      if (TREATMENT_TOKENS.has(first)) return null;
      return accept(match);
    };
    return [...collect(NAME_RE, text, "name", accept), ...collect(NAME_INTRO_RE, text, "name", acceptIntro)];
  },
  room: (text) =>
    collect(ROOM_RE, text, "room", (match) => {
      const number = match[2] ?? "";
      if (!number) return null;
      const start = match.index + match[0].length - number.length;
      return { start, end: start + number.length, value: number };
    })
};

function normalizeValue(kind: PiiKind, value: string): string {
  switch (kind) {
    case "email":
      return value.trim().toLowerCase();
    case "phone": {
      const compact = value.replace(/[^\d+]/g, "");
      const intl = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
      // Un número español con y sin prefijo (+34 612 345 678 / 612 345 678) es el mismo dato → mismo marcador.
      return intl.startsWith("+34") && intl.length === 12 ? intl.slice(3) : intl;
    }
    case "document":
      return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    case "card":
      return value.replace(/\D/g, "");
    case "name":
      return value.trim().replace(/\s+/g, " ").toLowerCase();
    case "room":
      return value.trim().toUpperCase();
    default:
      return value;
  }
}

function kindOfMarker(marker: string): PiiKind | null {
  const prefix = marker.replace(/_\d+$/, "");
  for (const [kind, value] of Object.entries(PII_MARKER_PREFIX) as Array<[PiiKind, string]>) {
    if (value === prefix) return kind;
  }
  return null;
}

/** Valores ya presentes en el mapa: se sustituyen aunque aparezcan sin tratamiento ni formato reconocible. */
function knownValueHits(text: string, map: PiiMap): Hit[] {
  const hits: Hit[] = [];
  const entries = Object.entries(map)
    .filter(([, value]) => value.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [marker, value] of entries) {
    const kind = kindOfMarker(marker);
    if (!kind) continue;
    const flags = kind === "name" || kind === "email" ? "giu" : "gu";
    const regex = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      hits.push({ start: match.index, end: match.index + match[0].length, value: match[0], kind });
    }
  }
  return hits;
}

function splitByRanges(text: string, ranges: Array<{ start: number; end: number }>, lockedSegment: (range: { start: number; end: number }) => Segment): Segment[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Segment[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.start < cursor) continue; // solapado con uno anterior
    if (range.start > cursor) out.push({ text: text.slice(cursor, range.start), locked: false });
    out.push(lockedSegment(range));
    cursor = range.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), locked: false });
  return out;
}

function lockBytes(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const segment of segments) {
    if (segment.locked) {
      out.push(segment);
      continue;
    }
    const locks: Array<{ start: number; end: number }> = [];
    for (const regex of [DATA_URL_RE, LONG_BASE64_RE]) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(segment.text)) !== null) {
        if (match[0].length === 0) {
          regex.lastIndex += 1;
          continue;
        }
        locks.push({ start: match.index, end: match.index + match[0].length });
      }
    }
    out.push(...splitByRanges(segment.text, locks, (range) => ({ text: segment.text.slice(range.start, range.end), locked: true })));
  }
  return out;
}

export function formatMarker(marker: string): string {
  return `[${marker}]`;
}

export function createPiiRedactor(options: RedactPiiOptions = {}): PiiRedactor {
  const kinds = new Set<PiiKind>(options.kinds ?? DEFAULT_PII_KINDS);
  if (options.roomNumbers) kinds.add("room");
  const orderedKinds = [...DEFAULT_PII_KINDS, "room" as PiiKind].filter((kind) => kinds.has(kind));
  const map: PiiMap = {};
  const markerByValue = new Map<string, string>();
  const counters: Partial<Record<PiiKind, number>> = {};

  function markerFor(kind: PiiKind, value: string): string {
    const key = `${kind}:${normalizeValue(kind, value)}`;
    const existing = markerByValue.get(key);
    if (existing) return existing;
    const next = (counters[kind] ?? 0) + 1;
    counters[kind] = next;
    const marker = `${PII_MARKER_PREFIX[kind]}_${next}`;
    markerByValue.set(key, marker);
    map[marker] = value;
    return marker;
  }

  // SEC-07: la PII conocida del llamador entra en el mapa antes de redactar nada; knownValueHits la
  // sustituye en cada texto aunque aparezca sin tratamiento ni formato reconocible.
  for (const known of options.knownPii ?? []) {
    const value = typeof known?.value === "string" ? known.value.trim().replace(/\s+/g, " ") : "";
    if (value.length < 3 || !kinds.has(known.kind)) continue;
    markerFor(known.kind, value);
  }

  function apply(segments: Segment[], detector: (text: string) => Hit[]): Segment[] {
    const next: Segment[] = [];
    for (const segment of segments) {
      if (segment.locked) {
        next.push(segment);
        continue;
      }
      const hits = detector(segment.text);
      if (hits.length === 0) {
        next.push(segment);
        continue;
      }
      next.push(
        ...splitByRanges(segment.text, hits, (range) => {
          const hit = range as Hit;
          return { text: formatMarker(markerFor(hit.kind, hit.value)), locked: true };
        })
      );
    }
    return next;
  }

  function redact(text: string): string {
    if (typeof text !== "string" || text.length === 0) return text;
    try {
      let segments = lockBytes([{ text, locked: false }]);
      if (Object.keys(map).length > 0) segments = apply(segments, (chunk) => knownValueHits(chunk, map));
      for (const kind of orderedKinds) segments = apply(segments, DETECTORS[kind]);
      return segments.map((segment) => segment.text).join("");
    } catch (error) {
      throw new AiError("pii_redaction_failed", "No se pudo anonimizar el texto antes de enviarlo al proveedor de IA.", { retryable: false, cause: error });
    }
  }

  return {
    redact,
    get map() {
      return map;
    },
    get count() {
      return Object.keys(map).length;
    }
  };
}

export function redactPii(text: string, options: RedactPiiOptions = {}): RedactionResult {
  const redactor = createPiiRedactor(options);
  const redacted = redactor.redact(text);
  return { text: redacted, map: redactor.map, count: redactor.count };
}

export function restorePii(text: string, map: PiiMap): string {
  if (typeof text !== "string" || !map || Object.keys(map).length === 0) return text;
  let out = text;
  for (const [marker, value] of Object.entries(map)) {
    const pattern = new RegExp(`[\\[«]?(?<![A-Za-z0-9_])${escapeRegExp(marker)}(?![A-Za-z0-9_])[\\]»]?`, "g");
    out = out.replace(pattern, () => value);
  }
  return out;
}

/** Restaura marcadores en cualquier estructura JSON (cadenas anidadas en objetos y arrays). */
export function restorePiiDeep<T>(value: T, map: PiiMap): T {
  if (!map || Object.keys(map).length === 0) return value;
  if (typeof value === "string") return restorePii(value, map) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => restorePiiDeep(item, map)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = restorePiiDeep(item, map);
    return out as T;
  }
  return value;
}

/** Redacta cadenas en cualquier estructura JSON con el mismo redactor (tool_use.input previos). */
export function redactDeep<T>(value: T, redactor: PiiRedactor): T {
  if (typeof value === "string") return redactor.redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redactor)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redactDeep(item, redactor);
    return out as T;
  }
  return value;
}
