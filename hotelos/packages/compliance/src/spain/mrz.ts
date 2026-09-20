// Parser puro de la MRZ (ICAO Doc 9303 Parte 3 §4.9 · formatos TD1, TD2 y TD3)
// y generador sintético para seeds y tests. Sin dependencias: sustituye a la
// librería `mrz` (Tanda CHK · diseño §2.2 y §4a paso 3). Es determinista: los
// dígitos de control usan pesos 7-3-1 repetidos, módulo 10 (`<` = 0, 0-9 = su
// valor, A-Z = 10-35). La autocorrección O→0 / I→1 se aplica SOLO a los campos
// numéricos (fechas) y a los dígitos de control, y queda anotada en `corrections`.
//
// Disposición del DNI/TIE español (fuentes secundarias, marcada [S] en el
// diseño): en un TD1 emitido por ESP el campo 6-14 de la línea 1 lleva el
// NÚMERO DE SOPORTE (`AAA000000` en el DNI, `E00000000` en el TIE) y el número
// de DNI/NIE va en el campo opcional de la línea 1. Se exponen AMBOS candidatos
// (`documentSupportNumber` y `documentNumber`) y recepción/kiosco cotejan con el
// anverso. Un `<` en el dígito de control 15 de TD1 indica número de documento
// ampliado en el campo opcional (P5 §4.2.2) y se resuelve aquí.
//
// Este módulo no persiste ni registra nada: los campos devueltos son PII y el
// llamante decide qué guarda (la imagen muere con la petición, diseño §2.3).

export type MrzFormat = "TD1" | "TD2" | "TD3";
export type MrzDocumentType = "DNI" | "NIE" | "TIE" | "PASSPORT" | "ID_CARD" | "OTHER";
/** Vocabulario SES.Hospedajes (H hombre · M mujer · O otro/no consta) ← ICAO M / F / `<` o X. */
export type MrzSex = "H" | "M" | "O";

export type MrzFields = {
  documentType: MrzDocumentType;
  /** Código bruto de la MRZ (`ID`, `P<`, `I<`…) por si el llamante necesita la letra ICAO. */
  documentCode: string;
  issuingCountry: string;
  documentNumber: string;
  documentSupportNumber?: string;
  surname1: string;
  /** Resto de apellidos del identificador primario, separados por espacio (convención española). */
  surname2?: string;
  firstName: string;
  /** YYYY-MM-DD; siglo: YY > (año actual + 1) → 19YY, si no 20YY. Vacío si la fecha no es válida. */
  dateOfBirth: string;
  sex: MrzSex;
  /** YYYY-MM-DD; siglo siempre 20YY. Vacío si la fecha no es válida. */
  expiryDate: string;
  nationality: string;
  optional1?: string;
  optional2?: string;
};

export type MrzChecks = { document: boolean; birth: boolean; expiry: boolean; composite: boolean; personal?: boolean };

export type MrzParseResult = {
  format: MrzFormat | null;
  valid: boolean;
  fields: MrzFields | null;
  checks: MrzChecks;
  corrections: string[];
  errors: string[];
};

export type MrzParseOptions = { today?: Date };

export const MRZ_MAX_LINE_LENGTH = 44;
export const MRZ_LINE_LENGTH: Readonly<Record<MrzFormat, number>> = Object.freeze({ TD1: 30, TD2: 36, TD3: 44 });
export const MRZ_LINE_COUNT: Readonly<Record<MrzFormat, number>> = Object.freeze({ TD1: 3, TD2: 2, TD3: 2 });

const WEIGHTS = [7, 3, 1] as const;
const VALID_CHARS = /^[A-Z0-9<]*$/;
const EMPTY_CHECKS: MrzChecks = { document: false, birth: false, expiry: false, composite: false };

// ---------------------------------------------------------------------------
// Dígitos de control (P3 §4.9)
// ---------------------------------------------------------------------------

export function mrzCharValue(ch: string): number {
  if (ch === "<") return 0;
  if (ch >= "0" && ch <= "9") return ch.charCodeAt(0) - 48;
  if (ch >= "A" && ch <= "Z") return ch.charCodeAt(0) - 55;
  return Number.NaN;
}

/** Apéndice A de P3: `520727` → 3, `AB2134<<<` → 5. Los caracteres no válidos cuentan 0. */
export function mrzCheckDigit(value: string): number {
  let sum = 0;
  for (let i = 0; i < value.length; i += 1) {
    const v = mrzCharValue(value.charAt(i));
    sum += (Number.isNaN(v) ? 0 : v) * WEIGHTS[i % 3]!;
  }
  return sum % 10;
}

function checkDigitMatches(value: string, cd: string): boolean {
  // `<` como dígito de control solo es admisible sobre un campo vacío (número personal de TD3).
  if (cd === "<") return /^<*$/.test(value);
  if (cd < "0" || cd > "9") return false;
  return mrzCheckDigit(value) === Number(cd);
}

// ---------------------------------------------------------------------------
// Normalización y detección de formato
// ---------------------------------------------------------------------------

/** Mayúsculas, sin espacios, `«»‹›` → `<`; una sola línea de 90/72/88 caracteres (lector en modo teclado) se parte. */
export function normalizeMrzLines(input: string[] | string): string[] {
  const raw = Array.isArray(input) ? input.join("\n") : String(input ?? "");
  let lines = raw
    .replace(/[«»‹›]/g, "<")
    .toUpperCase()
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/\s+/g, ""))
    .filter((line) => line.length > 0);
  if (lines.length === 1) {
    const line = lines[0]!;
    if (line.length === 90) lines = [line.slice(0, 30), line.slice(30, 60), line.slice(60)];
    else if (line.length === 72) lines = [line.slice(0, 36), line.slice(36)];
    else if (line.length === 88) lines = [line.slice(0, 44), line.slice(44)];
  }
  return lines;
}

function detectFormat(lines: string[], errors: string[]): MrzFormat | null {
  const lengths = lines.map((line) => line.length).join("/");
  if (lines.length === 3) {
    if (lines.every((line) => line.length === 30)) return "TD1";
    errors.push(`TD1 requiere 3 líneas de 30 caracteres; longitudes recibidas ${lengths}`);
    return null;
  }
  if (lines.length === 2) {
    if (lines.every((line) => line.length === 44)) return "TD3";
    if (lines.every((line) => line.length === 36)) return "TD2";
    errors.push(`TD2/TD3 requieren 2 líneas de 36 o 44 caracteres; longitudes recibidas ${lengths}`);
    return null;
  }
  errors.push(`Se esperaban 2 o 3 líneas de MRZ; recibidas ${lines.length}`);
  return null;
}

// ---------------------------------------------------------------------------
// Campos
// ---------------------------------------------------------------------------

const trimFiller = (value: string): string => value.replace(/^<+|<+$/g, "");
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** YYMMDD → YYYY-MM-DD. Nacimiento: YY > (año actual + 1) → 19YY; caducidad: siempre 20YY. */
function parseMrzDate(raw: string, kind: "nacimiento" | "caducidad", today: Date, errors: string[]): string {
  if (!/^\d{6}$/.test(raw)) {
    errors.push(`Fecha de ${kind} no numérica: '${raw}'`);
    return "";
  }
  const yy = Number(raw.slice(0, 2));
  const mm = Number(raw.slice(2, 4));
  const dd = Number(raw.slice(4, 6));
  const pivot = (today.getUTCFullYear() + 1) % 100;
  const year = kind === "nacimiento" ? (yy > pivot ? 1900 + yy : 2000 + yy) : 2000 + yy;
  const probe = new Date(Date.UTC(year, mm - 1, dd));
  if (mm < 1 || mm > 12 || dd < 1 || probe.getUTCMonth() !== mm - 1 || probe.getUTCDate() !== dd) {
    errors.push(`Fecha de ${kind} imposible: '${raw}'`);
    return "";
  }
  return `${year}-${pad2(mm)}-${pad2(dd)}`;
}

function parseSex(raw: string, errors: string[]): MrzSex {
  if (raw === "M") return "H";
  if (raw === "F") return "M";
  if (raw === "<" || raw === "X") return "O";
  errors.push(`Código de sexo desconocido: '${raw}'`);
  return "O";
}

function parseNames(raw: string): { surname1: string; surname2?: string; firstName: string } {
  const [primary = "", secondary = ""] = raw.split("<<");
  const surnames = primary.split("<").filter(Boolean);
  const given = secondary.split("<").filter(Boolean);
  return { surname1: surnames[0] ?? "", surname2: surnames.length > 1 ? surnames.slice(1).join(" ") : undefined, firstName: given.join(" ") };
}

function classifyDocument(code: string, issuer: string, number: string, optional: string): Pick<MrzFields, "documentType" | "documentNumber" | "documentSupportNumber"> {
  const kind = code.charAt(0);
  if (kind === "P") return { documentType: "PASSPORT", documentNumber: number };
  const idCard = kind === "I" || kind === "A" || kind === "C";
  if (idCard && issuer === "ESP") {
    const candidate = optional || number;
    if (/^E\d{8}$/.test(number)) return { documentType: "TIE", documentNumber: candidate, documentSupportNumber: number };
    if (/^[XYZ]\d{7}[A-Z]$/.test(candidate)) return { documentType: "NIE", documentNumber: candidate, documentSupportNumber: number };
    return { documentType: "DNI", documentNumber: candidate, documentSupportNumber: number };
  }
  return { documentType: idCard ? "ID_CARD" : "OTHER", documentNumber: number };
}

/** Sustituye O→0 e I→1 en las posiciones [from, to] (1-indexadas) de la línea `line` (0-indexada) y lo anota. */
function correctNumeric(chars: string[][], line: number, from: number, to: number, label: string, corrections: string[]): void {
  const row = chars[line]!;
  for (let pos = from; pos <= to; pos += 1) {
    const ch = row[pos - 1]!;
    const fixed = ch === "O" ? "0" : ch === "I" ? "1" : null;
    if (fixed) {
      row[pos - 1] = fixed;
      corrections.push(`${label}: '${ch}' → '${fixed}' (línea ${line + 1}, posición ${pos})`);
    }
  }
}

// ---------------------------------------------------------------------------
// parseMrz
// ---------------------------------------------------------------------------

export function parseMrz(input: string[] | string, options: MrzParseOptions = {}): MrzParseResult {
  const today = options.today ?? new Date();
  const errors: string[] = [];
  const corrections: string[] = [];
  const lines = normalizeMrzLines(input);
  const format = detectFormat(lines, errors);
  if (!format) return { format: null, valid: false, fields: null, checks: { ...EMPTY_CHECKS }, corrections, errors };

  lines.forEach((line, index) => {
    if (!VALID_CHARS.test(line)) errors.push(`Línea ${index + 1}: caracteres fuera de [A-Z0-9<]: '${line.replace(/[A-Z0-9<]/g, "")}'`);
  });

  const chars = lines.map((line) => line.split(""));
  // Posiciones 1-indexadas e inclusivas, como en el Doc 9303.
  const field = (line: number, from: number, to: number): string => chars[line]!.slice(from - 1, to).join("");

  let fields: MrzFields;
  let checks: MrzChecks;

  if (format === "TD1") {
    correctNumeric(chars, 0, 15, 15, "dígito de control del documento", corrections);
    correctNumeric(chars, 1, 1, 7, "fecha de nacimiento", corrections);
    correctNumeric(chars, 1, 9, 15, "fecha de caducidad", corrections);
    correctNumeric(chars, 1, 30, 30, "dígito de control compuesto", corrections);
    let numberRaw = field(0, 6, 14);
    let documentCd = field(0, 15, 15);
    let optional1 = field(0, 16, 30);
    if (documentCd === "<" && optional1.charAt(0) !== "<") {
      // Número de documento ampliado: continúa en el opcional hasta el primer `<`, seguido de su dígito de control.
      const extended = optional1.split("<")[0]!;
      numberRaw += extended.slice(0, -1);
      documentCd = extended.slice(-1);
      optional1 = optional1.slice(extended.length);
    }
    const number = trimFiller(numberRaw);
    const birth = field(1, 1, 6);
    const expiry = field(1, 9, 14);
    const composite = field(0, 6, 30) + field(1, 1, 7) + field(1, 9, 15) + field(1, 19, 29);
    checks = {
      document: checkDigitMatches(numberRaw, documentCd),
      birth: checkDigitMatches(birth, field(1, 7, 7)),
      expiry: checkDigitMatches(expiry, field(1, 15, 15)),
      composite: checkDigitMatches(composite, field(1, 30, 30))
    };
    const code = field(0, 1, 2);
    const issuer = trimFiller(field(0, 3, 5));
    fields = {
      ...classifyDocument(code, issuer, number, trimFiller(optional1)),
      documentCode: code,
      issuingCountry: issuer,
      ...parseNames(lines[2]!),
      dateOfBirth: parseMrzDate(birth, "nacimiento", today, errors),
      sex: parseSex(field(1, 8, 8), errors),
      expiryDate: parseMrzDate(expiry, "caducidad", today, errors),
      nationality: trimFiller(field(1, 16, 18)),
      optional1: trimFiller(optional1) || undefined,
      optional2: trimFiller(field(1, 19, 29)) || undefined
    };
  } else {
    // TD2 (2×36) y TD3 (2×44) comparten la línea 2 hasta la posición 28.
    const td3 = format === "TD3";
    correctNumeric(chars, 1, 10, 10, "dígito de control del documento", corrections);
    correctNumeric(chars, 1, 14, 20, "fecha de nacimiento", corrections);
    correctNumeric(chars, 1, 22, 28, "fecha de caducidad", corrections);
    if (td3) correctNumeric(chars, 1, 43, 43, "dígito de control del número personal", corrections);
    correctNumeric(chars, 1, td3 ? 44 : 36, td3 ? 44 : 36, "dígito de control compuesto", corrections);
    const number = field(1, 1, 9);
    const birth = field(1, 14, 19);
    const expiry = field(1, 22, 27);
    const optionalEnd = td3 ? 42 : 35;
    const optional = field(1, 29, optionalEnd);
    const composite = field(1, 1, 10) + field(1, 14, 20) + field(1, 22, td3 ? 43 : 35);
    checks = {
      document: checkDigitMatches(number, field(1, 10, 10)),
      birth: checkDigitMatches(birth, field(1, 20, 20)),
      expiry: checkDigitMatches(expiry, field(1, 28, 28)),
      composite: checkDigitMatches(composite, field(1, td3 ? 44 : 36, td3 ? 44 : 36)),
      ...(td3 ? { personal: checkDigitMatches(optional, field(1, 43, 43)) } : {})
    };
    const code = field(0, 1, 2);
    const issuer = trimFiller(field(0, 3, 5));
    fields = {
      ...classifyDocument(code, issuer, trimFiller(number), ""),
      documentCode: code,
      issuingCountry: issuer,
      ...parseNames(field(0, 6, td3 ? 44 : 36)),
      dateOfBirth: parseMrzDate(birth, "nacimiento", today, errors),
      sex: parseSex(field(1, 21, 21), errors),
      expiryDate: parseMrzDate(expiry, "caducidad", today, errors),
      nationality: trimFiller(field(1, 11, 13)),
      optional1: trimFiller(optional) || undefined
    };
  }

  const valid = errors.length === 0 && Object.values(checks).every((ok) => ok);
  const failed = (Object.keys(checks) as (keyof MrzChecks)[]).filter((key) => checks[key] === false);
  if (failed.length > 0) errors.push(`Dígitos de control incorrectos: ${failed.join(", ")}`);
  return { format, valid, fields, checks, corrections, errors };
}

// ---------------------------------------------------------------------------
// buildMrz · generador sintético (seed CHK y tests). Nunca para documentos reales.
// ---------------------------------------------------------------------------

export type MrzBuildInput = {
  format: MrzFormat;
  /** `DNI` · `NIE` · `TIE` · `ID_CARD` → código `ID`; `PASSPORT` → `P<`; o un código ICAO bruto de 1-2 letras. */
  documentType: string;
  issuingCountry: string;
  documentNumber: string;
  /** Solo TD1 con emisor ESP: ocupa 6-14 y `documentNumber` pasa al opcional de la línea 1. */
  supportNumber?: string;
  surname: string;
  givenNames: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  sex: MrzSex;
  /** YYYY-MM-DD */
  expiryDate: string;
  nationality: string;
};

const SEX_TO_ICAO: Readonly<Record<MrzSex, string>> = Object.freeze({ H: "M", M: "F", O: "<" });

/** Transliteración mínima a A-Z (P3 §6): sin diacríticos, ligaduras habituales, todo lo demás → `<`. */
export function mrzTransliterate(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ÆæŒœ]/g, "AE")
    .replace(/[Øø]/g, "OE")
    .replace(/[Ðð]/g, "D")
    .replace(/[Þþ]/g, "TH")
    .replace(/ß/g, "SS")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "<")
    .replace(/^<+|<+$/g, "");
}

function fit(value: string, length: number, label: string, truncate = false): string {
  if (!/^[A-Z0-9<]*$/.test(value)) throw new Error(`buildMrz: ${label} contiene caracteres fuera de [A-Z0-9<]`);
  if (value.length > length) {
    if (!truncate) throw new Error(`buildMrz: ${label} supera ${length} caracteres`);
    return value.slice(0, length);
  }
  return value.padEnd(length, "<");
}

function toYymmdd(iso: string, label: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`buildMrz: ${label} debe ser YYYY-MM-DD`);
  return `${match[1]!.slice(2)}${match[2]}${match[3]}`;
}

function documentCodeFor(documentType: string): string {
  const upper = documentType.toUpperCase();
  if (upper === "PASSPORT") return "P<";
  if (upper === "DNI" || upper === "NIE" || upper === "TIE" || upper === "ID_CARD") return "ID";
  if (/^[A-Z]{1,2}$/.test(upper)) return upper.padEnd(2, "<");
  throw new Error(`buildMrz: tipo de documento desconocido '${documentType}'`);
}

export function buildMrz(input: MrzBuildInput): string[] {
  const code = documentCodeFor(input.documentType);
  const issuer = fit(mrzTransliterate(input.issuingCountry), 3, "emisor");
  const nationality = fit(mrzTransliterate(input.nationality), 3, "nacionalidad");
  const sex = SEX_TO_ICAO[input.sex];
  if (!sex) throw new Error(`buildMrz: sexo '${String(input.sex)}' fuera de H|M|O`);
  const birth = toYymmdd(input.dateOfBirth, "fecha de nacimiento");
  const expiry = toYymmdd(input.expiryDate, "fecha de caducidad");
  const names = `${mrzTransliterate(input.surname)}<<${mrzTransliterate(input.givenNames)}`;
  const documentNumber = mrzTransliterate(input.documentNumber);
  const support = input.supportNumber ? mrzTransliterate(input.supportNumber) : "";
  if (support && input.format !== "TD1") throw new Error("buildMrz: supportNumber solo aplica a TD1");
  const cd = (value: string): string => String(mrzCheckDigit(value));

  if (input.format === "TD1") {
    const number = fit(support || documentNumber, 9, "número de documento");
    const optional1 = fit(support ? documentNumber : "", 15, "opcional 1");
    const line1 = `${code}${issuer}${number}${cd(number)}${optional1}`;
    const line2Body = `${birth}${cd(birth)}${sex}${expiry}${cd(expiry)}${nationality}${fit("", 11, "opcional 2")}`;
    const composite = cd(line1.slice(5, 30) + line2Body.slice(0, 7) + line2Body.slice(8, 15) + line2Body.slice(18, 29));
    return [line1, `${line2Body}${composite}`, fit(names, 30, "nombres", true)];
  }

  const td3 = input.format === "TD3";
  const number = fit(documentNumber, 9, "número de documento");
  const line1 = `${code}${issuer}${fit(names, td3 ? 39 : 31, "nombres", true)}`;
  const optional = fit("", td3 ? 14 : 7, "opcional");
  const line2Body = `${number}${cd(number)}${nationality}${birth}${cd(birth)}${sex}${expiry}${cd(expiry)}${optional}${td3 ? cd(optional) : ""}`;
  const composite = cd(line2Body.slice(0, 10) + line2Body.slice(13, 20) + line2Body.slice(21));
  return [line1, `${line2Body}${composite}`];
}
