// Reputación · Tanda T8 · lote T8-B — parser de CSV de reseñas
// (apps/api/src/modules/reputation/review-csv.parser.ts).
//
// Reglas del fichero:
//   · función pura: sin Prisma, sin variables de entorno, sin red, sin
//     dependencias (parser CSV propio: separador `,` o `;` autodetectado en
//     la cabecera, comillas dobles con `""` escapado, BOM y CRLF tolerados);
//   · cabeceras canónicas: external_id, date, rating, scale_max, title, body,
//     language, author, country, url (alias del diseño §4.2 admitidos:
//     external_reference, received_at, rating_scale_max, author_display_name,
//     portal_url, source ignorada);
//   · ≤ 5.000 filas de datos; por encima, ReviewCsvParseError TOO_MANY_ROWS;
//   · las filas inválidas se devuelven con motivo en español; las duplicadas
//     dentro del fichero (mismo external_id o mismo contenido) no entran en
//     `rows` y se listan en `duplicates`.
//
// Tests: cd apps/api && node --import tsx --test src/modules/reputation/__tests__/review-csv-parser.test.mts

import type { NormalizedReview } from "./collectors/types.js";
import { normalizeLanguageCode } from "./review-language.js";
import { RatingNormalizationError, contentHash, minimizeAuthorName, normalizeRating, scaleFor } from "./review-normalize.js";

export const CSV_MAX_ROWS = 5000;
export const CSV_MAX_TITLE = 200;
export const CSV_MAX_BODY = 8000;

export const CSV_CANONICAL_HEADERS = Object.freeze(["external_id", "date", "rating", "scale_max", "title", "body", "language", "author", "country", "url"] as const);
export type CsvCanonicalHeader = (typeof CSV_CANONICAL_HEADERS)[number];

const HEADER_ALIASES: Readonly<Record<string, CsvCanonicalHeader>> = Object.freeze({
  external_id: "external_id",
  externalid: "external_id",
  external_reference: "external_id",
  externalreference: "external_id",
  id: "external_id",
  review_id: "external_id",
  date: "date",
  received_at: "date",
  receivedat: "date",
  fecha: "date",
  rating: "rating",
  nota: "rating",
  score: "rating",
  puntuacion: "rating",
  scale_max: "scale_max",
  scalemax: "scale_max",
  rating_scale_max: "scale_max",
  ratingscalemax: "scale_max",
  escala: "scale_max",
  title: "title",
  titulo: "title",
  body: "body",
  text: "body",
  texto: "body",
  comment: "body",
  comentario: "body",
  language: "language",
  idioma: "language",
  lang: "language",
  author: "author",
  author_display_name: "author",
  authordisplayname: "author",
  autor: "author",
  reviewer: "author",
  country: "country",
  pais: "country",
  author_country: "country",
  url: "url",
  portal_url: "url",
  portalurl: "url",
  link: "url"
});

export type ReviewCsvErrorCode = "EMPTY_FILE" | "MISSING_HEADER" | "TOO_MANY_ROWS" | "UNTERMINATED_QUOTE";

/** Error tipado a nivel de fichero (la ruta lo mapea a REVIEW_IMPORT_INVALID). */
export class ReviewCsvParseError extends Error {
  readonly code: ReviewCsvErrorCode;
  constructor(code: ReviewCsvErrorCode, message: string) {
    super(message);
    this.name = "ReviewCsvParseError";
    this.code = code;
  }
}

export type ReviewCsvInvalidRow = { row: number; reason: string };
export type ReviewCsvDuplicateRow = { row: number; of: number; reason: string };

export type ReviewCsvParseOptions = {
  /** Proveedor de la fuente (`csv`, `google`…); fija la escala si el portal la publica. */
  source: string;
  /** Escala por defecto cuando la fila no trae `scale_max` y el proveedor no la fija. */
  scaleMax?: number;
  /** Fecha de respaldo para validar (no se usa para rellenar fechas ausentes). */
  now?: Date;
};

export type ReviewCsvParseResult = {
  rows: NormalizedReview[];
  invalid: ReviewCsvInvalidRow[];
  duplicates: ReviewCsvDuplicateRow[];
  /** Filas de datos leídas (válidas + inválidas + duplicadas). */
  total: number;
  separator: "," | ";";
  headers: CsvCanonicalHeader[];
};

// ---------------------------------------------------------------------------
// Lector CSV (RFC 4180 tolerante)
// ---------------------------------------------------------------------------

export function detectSeparator(headerLine: string): "," | ";" {
  const commas = (headerLine.match(/,/g) ?? []).length;
  const semicolons = (headerLine.match(/;/g) ?? []).length;
  return semicolons > commas ? ";" : ",";
}

/** Divide el texto en registros y campos respetando comillas (saltos de línea dentro de comillas incluidos). */
export function readCsvRecords(text: string, separator: "," | ";"): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === separator) {
      fields.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    if (char === "\n") {
      fields.push(field);
      records.push(fields);
      fields = [];
      field = "";
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (inQuotes) throw new ReviewCsvParseError("UNTERMINATED_QUOTE", "Comillas sin cerrar al final del fichero.");
  if (field.length > 0 || fields.length > 0) {
    fields.push(field);
    records.push(fields);
  }
  return records.filter((record) => record.some((value) => value.trim().length > 0));
}

function normalizeHeader(raw: string): CsvCanonicalHeader | null {
  const key = raw
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s-]+/g, "_");
  return HEADER_ALIASES[key] ?? null;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const EU_DATE_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/;

/** ISO 8601 o dd/mm/yyyy [HH:MM] → ISO; `null` si no es una fecha. */
export function parseCsvDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (ISO_DATE_RE.test(trimmed)) {
    const parsed = Date.parse(trimmed.length === 10 ? `${trimmed}T00:00:00Z` : trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const eu = trimmed.match(EU_DATE_RE);
  if (eu) {
    const day = Number(eu[1]);
    const month = Number(eu[2]);
    const year = Number(eu[3]);
    const hour = eu[4] ? Number(eu[4]) : 0;
    const minute = eu[5] ? Number(eu[5]) : 0;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date.toISOString();
  }
  return null;
}

function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function clean(value: string | undefined, max: number): string | undefined {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
}

// ---------------------------------------------------------------------------
// Parser principal
// ---------------------------------------------------------------------------

/**
 * Convierte un CSV en reseñas normalizadas. Lanza ReviewCsvParseError para
 * problemas de fichero (vacío, sin cabecera reconocible, > 5.000 filas,
 * comillas sin cerrar); los problemas de fila van en `invalid`.
 */
/** Nombres de país habituales en las exportaciones de portales (es/en/de/fr/pt/it, sin acentos) → ISO 3166-1 alpha-2. */
const COUNTRY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  espana: "ES", spain: "ES", spanien: "ES", espagne: "ES", espanha: "ES", spagna: "ES",
  alemania: "DE", germany: "DE", deutschland: "DE", allemagne: "DE", alemanha: "DE", germania: "DE",
  portugal: "PT",
  francia: "FR", france: "FR", frankreich: "FR", franca: "FR",
  "reino unido": "GB", "united kingdom": "GB", uk: "GB", "great britain": "GB", "gran bretana": "GB", england: "GB", inglaterra: "GB", grossbritannien: "GB", "royaume-uni": "GB",
  italia: "IT", italy: "IT", italien: "IT", italie: "IT",
  "paises bajos": "NL", netherlands: "NL", "the netherlands": "NL", holanda: "NL", holland: "NL", niederlande: "NL", "pays-bas": "NL",
  "estados unidos": "US", "united states": "US", "united states of america": "US", usa: "US", "eeuu": "US", "ee.uu.": "US",
  irlanda: "IE", ireland: "IE", irland: "IE", irlande: "IE",
  belgica: "BE", belgium: "BE", belgien: "BE", belgique: "BE", belgio: "BE",
  suiza: "CH", switzerland: "CH", schweiz: "CH", suisse: "CH", svizzera: "CH",
  austria: "AT", osterreich: "AT", autriche: "AT",
  polonia: "PL", poland: "PL", polen: "PL", pologne: "PL",
  suecia: "SE", sweden: "SE", schweden: "SE", suede: "SE",
  noruega: "NO", norway: "NO", norwegen: "NO", norvege: "NO",
  dinamarca: "DK", denmark: "DK", danemark: "DK", danemark_: "DK",
  finlandia: "FI", finland: "FI", finnland: "FI", finlande: "FI",
  brasil: "BR", brazil: "BR", brasilien: "BR", bresil: "BR",
  argentina: "AR", argentinien: "AR", argentine: "AR",
  mexico: "MX", mexiko: "MX", mexique: "MX",
  canada: "CA", kanada: "CA",
  china: "CN", chine: "CN",
  japon: "JP", japan: "JP",
  "corea del sur": "KR", "south korea": "KR",
  australia: "AU", australien: "AU", australie: "AU",
  marruecos: "MA", morocco: "MA", marokko: "MA", maroc: "MA",
  andorra: "AD", luxemburgo: "LU", luxembourg: "LU", luxemburg: "LU",
  grecia: "GR", greece: "GR", griechenland: "GR", grece: "GR",
  turquia: "TR", turkey: "TR", turkiye: "TR", turkei: "TR", turquie: "TR",
  rumania: "RO", romania: "RO", rumanien: "RO", roumanie: "RO",
  chequia: "CZ", "republica checa": "CZ", czechia: "CZ", "czech republic": "CZ", tschechien: "CZ",
  hungria: "HU", hungary: "HU", ungarn: "HU", hongrie: "HU",
  israel: "IL", india: "IN", indien: "IN", inde: "IN",
  chile: "CL", colombia: "CO", kolumbien: "CO", colombie: "CO", peru: "PE", uruguay: "UY", venezuela: "VE",
  rusia: "RU", russia: "RU", russland: "RU", russie: "RU", ucrania: "UA", ukraine: "UA",
  "emiratos arabes unidos": "AE", "united arab emirates": "AE", uae: "AE",
  "nueva zelanda": "NZ", "new zealand": "NZ", sudafrica: "ZA", "south africa": "ZA"
});

/** «ES» / «es» → `ES`; «Germany» / «Alemania» → `DE`; cualquier otro texto → undefined (nunca se recorta a 2 letras). */
export function countryCodeFor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  const key = trimmed.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").toLowerCase();
  return COUNTRY_NAMES[key];
}

export function parseReviewCsv(text: string, options: ReviewCsvParseOptions): ReviewCsvParseResult {
  const content = (text ?? "").replace(/^\uFEFF/, "");
  if (!content.trim()) throw new ReviewCsvParseError("EMPTY_FILE", "El fichero está vacío.");
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  const separator = detectSeparator(firstLine);
  const records = readCsvRecords(content, separator);
  const headerRow = records[0];
  if (!headerRow) throw new ReviewCsvParseError("MISSING_HEADER", "El fichero no tiene cabecera.");

  const columns = headerRow.map(normalizeHeader);
  const headers = columns.filter((column): column is CsvCanonicalHeader => column !== null);
  const has = (header: CsvCanonicalHeader): boolean => headers.includes(header);
  if (!has("date") || !has("rating")) {
    throw new ReviewCsvParseError("MISSING_HEADER", `Faltan columnas obligatorias: se esperan al menos «date» y «rating» (cabeceras admitidas: ${CSV_CANONICAL_HEADERS.join(", ")}).`);
  }
  const dataRows = records.slice(1);
  if (dataRows.length > CSV_MAX_ROWS) {
    throw new ReviewCsvParseError("TOO_MANY_ROWS", `El fichero tiene ${dataRows.length} filas; el máximo es ${CSV_MAX_ROWS}.`);
  }

  const providerScale = scaleFor(options.source);
  const rows: NormalizedReview[] = [];
  const invalid: ReviewCsvInvalidRow[] = [];
  const duplicates: ReviewCsvDuplicateRow[] = [];
  const seenIds = new Map<string, number>();
  const seenHashes = new Map<string, number>();

  dataRows.forEach((record, offset) => {
    const rowNumber = offset + 2; // 1 = cabecera
    const cell = (header: CsvCanonicalHeader): string => {
      const index = columns.indexOf(header);
      return index >= 0 ? (record[index] ?? "") : "";
    };

    const receivedAt = parseCsvDate(cell("date"));
    if (!receivedAt) {
      invalid.push({ row: rowNumber, reason: `Fecha no válida: «${cell("date").trim()}» (use ISO 8601 o dd/mm/aaaa).` });
      return;
    }

    const ratingText = cell("rating").trim();
    const title = clean(cell("title"), CSV_MAX_TITLE);
    const body = clean(cell("body"), CSV_MAX_BODY);
    if (!ratingText && !title && !body) {
      invalid.push({ row: rowNumber, reason: "Fila sin nota ni texto." });
      return;
    }

    let ratingRaw: number | null = null;
    let ratingScaleMax: number | null = null;
    if (ratingText) {
      const rating = parseNumber(ratingText);
      if (rating === null) {
        invalid.push({ row: rowNumber, reason: `Nota no numérica: «${ratingText}».` });
        return;
      }
      const rowScale = parseNumber(cell("scale_max"));
      const scaleMax = rowScale ?? providerScale ?? options.scaleMax ?? null;
      if (scaleMax === null) {
        invalid.push({ row: rowNumber, reason: "Sin escala de la nota: añade la columna «scale_max» o elige un proveedor con escala fija." });
        return;
      }
      try {
        const normalized = normalizeRating({ rating, scaleMax });
        ratingRaw = normalized.ratingRaw;
        ratingScaleMax = normalized.ratingScaleMax;
      } catch (error) {
        if (error instanceof RatingNormalizationError) {
          invalid.push({ row: rowNumber, reason: error.message });
          return;
        }
        throw error;
      }
    }

    const externalId = clean(cell("external_id"), 200);
    const author = minimizeAuthorName(clean(cell("author"), 120));
    // País: código ISO 3166-1 alpha-2 o nombre conocido (Booking «Reviewer country» trae nombres); lo demás se descarta, nunca se recorta.
    const country = countryCodeFor(clean(cell("country"), 60));
    const url = clean(cell("url"), 2000);
    const languageRaw = clean(cell("language"), 10);
    const language = languageRaw ? normalizeLanguageCode(languageRaw) : undefined;

    if (url && !/^https?:\/\//i.test(url)) {
      invalid.push({ row: rowNumber, reason: `URL no válida: «${url.slice(0, 60)}».` });
      return;
    }

    const hash = contentHash({ source: options.source, externalId, authorDisplayName: author, receivedAt, title, body, ratingRaw });
    if (externalId) {
      const previous = seenIds.get(externalId);
      if (previous !== undefined) {
        duplicates.push({ row: rowNumber, of: previous, reason: `external_id «${externalId}» repetido (fila ${previous}).` });
        return;
      }
      seenIds.set(externalId, rowNumber);
    }
    const previousHash = seenHashes.get(hash);
    if (previousHash !== undefined) {
      duplicates.push({ row: rowNumber, of: previousHash, reason: `Contenido idéntico al de la fila ${previousHash}.` });
      return;
    }
    seenHashes.set(hash, rowNumber);

    rows.push({
      ...(externalId ? { externalId } : {}),
      receivedAt,
      ratingRaw,
      ratingScaleMax,
      ...(title ? { title } : {}),
      ...(body ? { body } : {}),
      bodyComplete: true,
      ...(language && language !== "und" ? { language } : {}),
      ...(author ? { authorDisplayName: author } : {}),
      ...(country ? { authorCountry: country } : {}),
      ...(url ? { portalUrl: url } : {}),
      replyCapability: false
    });
  });

  return { rows, invalid, duplicates, total: dataRows.length, separator, headers };
}
