// Reputación · Tanda T8 · lote T8-B — detección determinista de idioma por
// stopwords (apps/api/src/modules/reputation/review-language.ts).
//
// Reglas del fichero:
//   · función pura, sin dependencias: sin Prisma, sin variables de entorno,
//     sin red, sin modelos;
//   · idiomas: es, en, de, fr, pt, it; `und` cuando no hay evidencia
//     suficiente (texto vacío, muy corto o empate);
//   · la confianza es orientativa (0-1): margen entre el mejor y el segundo
//     idioma ponderado por el número de coincidencias.
//
// Tests: cd apps/api && node --import tsx --test src/modules/reputation/__tests__/review-language.test.mts

export const DETECTABLE_LANGUAGES = Object.freeze(["es", "en", "de", "fr", "pt", "it"] as const);
export type DetectableLanguage = (typeof DETECTABLE_LANGUAGES)[number];
export type LanguageCode = DetectableLanguage | "und";

export type LanguageDetection = {
  code: LanguageCode;
  /** 0-1; 0 cuando `und`. */
  confidence: number;
  /** Coincidencias por idioma (diagnóstico). */
  scores: Record<DetectableLanguage, number>;
};

/** Mínimo de coincidencias del mejor idioma para decidir. */
const MIN_HITS = 2;
/** Margen mínimo relativo entre el mejor y el segundo para decidir. */
const MIN_MARGIN = 0.2;

// Stopwords por idioma: se escriben sin diacríticos porque el texto se
// normaliza igual (NFD sin marcas) antes de comparar.
const STOPWORDS: Readonly<Record<DetectableLanguage, readonly string[]>> = Object.freeze({
  es: [
    "el", "la", "los", "las", "un", "una", "unos", "unas", "y", "o", "pero", "muy", "mas", "menos", "con", "sin", "para", "por",
    "que", "como", "cuando", "donde", "es", "era", "fue", "son", "eran", "fueron", "esta", "estaba", "estaban", "estuvo", "estuvimos",
    "hay", "habia", "tiene", "tenia", "nos", "nuestro", "nuestra", "todo", "toda", "todos", "todas", "nada", "bien", "mal", "tambien",
    "aunque", "porque", "desde", "hasta", "sobre", "entre", "este", "esta", "estos", "estas", "ese", "esa", "del", "al", "lo", "le",
    "les", "se", "su", "sus", "mi", "mis", "ya", "si", "no", "ni", "solo", "hotel", "habitacion", "personal", "desayuno", "bueno",
    "buena", "recomendable", "volveremos", "estancia", "limpio", "limpia", "amable", "amables", "precio", "vistas", "noche", "noches"
  ],
  en: [
    "the", "a", "an", "and", "or", "but", "very", "with", "without", "for", "to", "of", "in", "on", "at", "by", "from", "that",
    "this", "these", "those", "it", "its", "is", "was", "were", "are", "be", "been", "has", "had", "have", "we", "our", "us", "they",
    "their", "there", "not", "no", "so", "too", "also", "all", "some", "any", "which", "when", "where", "what", "would", "could",
    "should", "did", "does", "do", "you", "your", "my", "me", "i", "he", "she", "him", "her", "room", "staff", "hotel", "stay", "stayed",
    "breakfast", "clean", "friendly", "nice", "great", "good", "really", "again", "night", "nights", "location", "everything"
  ],
  de: [
    "der", "die", "das", "ein", "eine", "einen", "einem", "einer", "und", "oder", "aber", "sehr", "mit", "ohne", "fur", "zu", "von",
    "im", "am", "auf", "ist", "war", "waren", "sind", "wir", "uns", "unser", "unsere", "nicht", "kein", "keine", "auch", "noch",
    "schon", "wurde", "wurden", "hat", "hatte", "haben", "hatten", "es", "sie", "ich", "er", "man", "dass", "wenn", "als", "wie",
    "bei", "nach", "aus", "uber", "zimmer", "hotel", "personal", "fruhstuck", "sauber", "freundlich", "gut", "sehr", "lage", "wieder",
    "nacht", "nachte", "alles", "leider", "etwas", "ganz", "nur", "sich", "durch", "diese", "dieser", "dieses"
  ],
  fr: [
    "le", "la", "les", "un", "une", "des", "du", "de", "et", "ou", "mais", "tres", "avec", "sans", "pour", "dans", "sur", "en",
    "au", "aux", "ce", "cette", "ces", "est", "etait", "etaient", "sont", "ete", "nous", "notre", "nos", "vous", "votre", "ils",
    "elles", "il", "elle", "on", "je", "ne", "pas", "plus", "aussi", "tout", "toute", "tous", "bien", "tres", "chambre", "hotel",
    "personnel", "petit", "dejeuner", "propre", "accueil", "sejour", "nuit", "nuits", "bon", "bonne", "agreable", "qui", "que",
    "quand", "ou", "comme", "meme", "encore", "rien", "leur", "leurs", "chez"
  ],
  pt: [
    "o", "a", "os", "as", "um", "uma", "uns", "umas", "e", "ou", "mas", "muito", "muita", "com", "sem", "para", "por", "que",
    "como", "quando", "onde", "e", "era", "foi", "sao", "eram", "foram", "esta", "estava", "estavam", "ha", "havia", "tem", "tinha",
    "nos", "nosso", "nossa", "tudo", "todo", "toda", "todos", "todas", "nada", "bem", "mal", "tambem", "embora", "porque", "desde",
    "ate", "sobre", "entre", "este", "esta", "isto", "isso", "do", "da", "dos", "das", "no", "na", "nos", "nas", "ao", "aos",
    "nao", "sim", "so", "hotel", "quarto", "funcionarios", "cafe", "manha", "limpo", "limpa", "simpatico", "simpaticos", "otimo", "otima",
    "recomendo", "voltaremos", "estadia", "noite", "noites", "voce", "voces", "eles", "elas", "ele", "ela", "seu", "sua", "seus", "suas", "pequeno"
  ],
  it: [
    "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "e", "ed", "o", "ma", "molto", "con", "senza", "per", "di", "da",
    "in", "su", "che", "come", "quando", "dove", "e", "era", "erano", "sono", "stato", "stata", "stati", "abbiamo", "hanno", "ha",
    "aveva", "noi", "nostro", "nostra", "tutto", "tutta", "tutti", "tutte", "niente", "bene", "male", "anche", "pero", "perche",
    "del", "della", "dei", "delle", "al", "alla", "nel", "nella", "non", "si", "solo", "hotel", "albergo", "camera", "personale",
    "colazione", "pulita", "pulito", "gentile", "gentili", "ottimo", "ottima", "posizione", "soggiorno", "notte", "notti", "questo",
    "questa", "questi", "queste", "ci", "vi", "mi", "ti", "gia", "ancora", "sempre", "mai", "quindi", "cosi"
  ]
});

const STOPWORD_SETS: Readonly<Record<DetectableLanguage, ReadonlySet<string>>> = Object.freeze({
  es: new Set(STOPWORDS.es),
  en: new Set(STOPWORDS.en),
  de: new Set(STOPWORDS.de),
  fr: new Set(STOPWORDS.fr),
  pt: new Set(STOPWORDS.pt),
  it: new Set(STOPWORDS.it)
});

/** Caracteres que solo aparecen (o casi) en un idioma: bonificación por aparición. */
const CHAR_HINTS: ReadonlyArray<{ pattern: RegExp; language: DetectableLanguage; weight: number }> = Object.freeze([
  { pattern: /ñ/g, language: "es", weight: 2 },
  { pattern: /¿|¡/g, language: "es", weight: 2 },
  { pattern: /ß/g, language: "de", weight: 2 },
  { pattern: /[äöü]/g, language: "de", weight: 1 },
  { pattern: /[ãõ]/g, language: "pt", weight: 2 },
  { pattern: /[êô]/g, language: "pt", weight: 0.5 },
  { pattern: /[èàù]/g, language: "it", weight: 0.5 },
  { pattern: /[êâûîœ]/g, language: "fr", weight: 1 },
  { pattern: /ç/g, language: "fr", weight: 0.5 }
]);

/** Minúsculas, NFD sin diacríticos, solo letras. */
export function tokenizeForLanguage(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/n't\b/g, " not")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return normalized.split(/[^a-z]+/).filter((token) => token.length > 0);
}

function emptyScores(): Record<DetectableLanguage, number> {
  return { es: 0, en: 0, de: 0, fr: 0, pt: 0, it: 0 };
}

/** Detecta el idioma de un texto por stopwords y caracteres propios. */
export function detectLanguage(text: string | null | undefined): LanguageDetection {
  const scores = emptyScores();
  if (typeof text !== "string" || !text.trim()) return { code: "und", confidence: 0, scores };

  const tokens = tokenizeForLanguage(text);
  for (const token of tokens) {
    for (const language of DETECTABLE_LANGUAGES) {
      if (STOPWORD_SETS[language].has(token)) scores[language] += 1;
    }
  }
  const lower = text.toLowerCase();
  for (const hint of CHAR_HINTS) {
    const matches = lower.match(hint.pattern);
    if (matches) scores[hint.language] += matches.length * hint.weight;
  }

  const ranked = [...DETECTABLE_LANGUAGES].sort((a, b) => scores[b] - scores[a]);
  const best = ranked[0] as DetectableLanguage;
  const second = ranked[1] as DetectableLanguage;
  const bestScore = scores[best];
  const secondScore = scores[second];
  if (bestScore < MIN_HITS) return { code: "und", confidence: 0, scores };
  const margin = (bestScore - secondScore) / bestScore;
  if (margin < MIN_MARGIN) return { code: "und", confidence: 0, scores };

  const volume = Math.min(1, bestScore / 6);
  const confidence = Math.round(Math.min(1, margin * 0.7 + 0.3) * volume * 100) / 100;
  return { code: best, confidence, scores };
}

export function isDetectableLanguage(value: unknown): value is DetectableLanguage {
  return typeof value === "string" && (DETECTABLE_LANGUAGES as readonly string[]).includes(value);
}

/** Normaliza un código de idioma del portal (`en-GB`, `ES`) a los 6 admitidos o `und`. */
export function normalizeLanguageCode(value: string | null | undefined): LanguageCode {
  if (typeof value !== "string") return "und";
  const code = value.trim().toLowerCase().slice(0, 2);
  return isDetectableLanguage(code) ? code : "und";
}
