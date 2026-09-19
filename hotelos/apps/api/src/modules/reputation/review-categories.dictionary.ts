// Reputación · Tanda T8 · lote T8-B — análisis determinista por diccionario
// (apps/api/src/modules/reputation/review-categories.dictionary.ts).
//
// Reglas del fichero:
//   · función pura, sin dependencias: sin Prisma, sin variables de entorno,
//     sin red, sin modelos; es el respaldo SIEMPRE disponible del análisis
//     con IA (etiqueta honesta `source: "dictionary"`);
//   · léxico por categoría (las 12 de REVIEW_CATEGORIES) y polaridad:
//     - es y en: completos (términos de tema + positivos y negativos ligados a
//       la categoría + polaridad general);
//     - de, fr, pt: REDUCIDOS (términos de tema y un puñado de polaridades
//       por categoría; polaridad general corta). Documentado aquí y en el
//       test; ampliar cuando haya reseñas reales en esos idiomas;
//     - it y `und`: sin léxico propio → se aplica la unión es + en;
//   · ventana de negación de 3 tokens antes del término («no estaba limpio»
//     → limpieza −1); intensificador en los 2 tokens previos → +0,1 de
//     confianza; snippet ≤ 160 caracteres = la cláusula donde aparece;
//   · las subpuntuaciones de portal (Booking `scoring.*`) se mapean sin NLP
//     con `source: "portal_subscore"` y confianza 1.
//
// Tests: cd apps/api && node --import tsx --test src/modules/reputation/__tests__/review-categories-dictionary.test.mts

import {
  REVIEW_CATEGORIES,
  SCORE10_NEGATIVE,
  SCORE10_POSITIVE,
  type CategoryMention,
  type ReviewCategory
} from "./reputation-types.js";

export const DICTIONARY_LANGUAGES = Object.freeze(["es", "en", "de", "fr", "pt"] as const);
export type DictionaryLanguage = (typeof DICTIONARY_LANGUAGES)[number];

/** Idiomas con léxico completo; el resto es reducido (ver cabecera). */
export const DICTIONARY_FULL_LANGUAGES: readonly DictionaryLanguage[] = Object.freeze(["es", "en"]);

export const SNIPPET_MAX_LENGTH = 160;
/** Tokens previos revisados en busca de una negación. */
export const NEGATION_WINDOW = 3;
/** Tokens previos revisados en busca de un intensificador. */
export const INTENSIFIER_WINDOW = 2;
const CONFIDENCE_TOPIC_ONLY = 0.4;
const CONFIDENCE_BASE = 0.6;
const CONFIDENCE_PER_EXTRA_HIT = 0.1;
const CONFIDENCE_INTENSIFIER = 0.1;
const CONFIDENCE_MIXED_PENALTY = 0.1;
const CONFIDENCE_MAX = 0.95;

type CategoryLexicon = {
  /** Términos de tema (polaridad neutra). */
  topic: string[];
  /** Términos que implican la categoría y son positivos. */
  positive: string[];
  /** Términos que implican la categoría y son negativos. */
  negative: string[];
};

type LanguageLexicon = {
  categories: Record<ReviewCategory, CategoryLexicon>;
  positive: string[];
  negative: string[];
  negators: string[];
  intensifiers: string[];
};

// Expansión de género/número para español y portugués: «limpi@» → limpio,
// limpia, limpios, limpias; «amable+» → amable, amables.
function inflect(entries: string[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.endsWith("@")) {
      const stem = entry.slice(0, -1);
      out.push(`${stem}o`, `${stem}a`, `${stem}os`, `${stem}as`);
    } else if (entry.endsWith("+")) {
      const stem = entry.slice(0, -1);
      out.push(stem, `${stem}s`);
    } else {
      out.push(entry);
    }
  }
  return out;
}

const ES: LanguageLexicon = {
  categories: {
    limpieza: {
      topic: inflect(["limpieza", "higiene", "sabana+", "toalla+", "polvo", "servicio de limpieza", "camarera de piso", "camareras de piso"]),
      positive: inflect(["limpi@", "impecable+", "reluciente+", "inmaculad@", "pulcr@", "olia bien", "olía bien"]),
      negative: inflect([
        "suci@", "mugre", "mugrient@", "manchad@", "mancha+", "pelo+", "cucaracha+", "chinche+", "insecto+", "mal olor", "olia mal",
        "olía mal", "apestaba", "moho", "humedad", "sin limpiar", "no limpiaron", "no limpiaban", "asquerós@", "asqueros@"
      ])
    },
    habitacion: {
      topic: inflect([
        "habitacion", "habitación", "habitaciones", "cuarto+", "cama+", "colchon", "colchón", "colchones", "almohada+", "baño+", "bano+",
        "ducha+", "aire acondicionado", "calefaccion", "calefacción", "vistas", "balcon", "balcón", "terraza de la habitacion", "suite"
      ]),
      positive: inflect(["acogedor@", "confortable+", "comod@", "cómod@", "espacios@", "ampli@", "luminos@"]),
      negative: inflect(["diminut@", "estrech@", "incomod@", "incómod@", "oscur@", "cochambros@", "claustrofobic@", "claustrofóbic@"])
    },
    personal: {
      topic: inflect([
        "personal", "empleado+", "empleada+", "staff", "camarer@", "recepcionista+", "trato", "atencion", "atención", "equipo", "gente del hotel",
        "trabajadores", "trabajadoras", "chic@"
      ]),
      positive: inflect([
        "amable+", "amabilidad", "atent@", "simpatic@", "simpátic@", "servicial+", "profesional+", "encantador@", "educad@", "cordial+",
        "atentísim@", "amabilísim@", "cercan@", "majísim@", "maj@", "resolutiv@", "eficiente+"
      ]),
      negative: inflect([
        "maleducad@", "groser@", "antipatic@", "antipátic@", "desagradable+", "borde+", "descortes", "descortés", "desatent@", "ignoraron",
        "nos ignoraron", "mal trato", "prepotente+", "arrogante+", "poco profesional", "nada profesional"
      ])
    },
    desayuno: {
      topic: inflect(["desayuno+", "buffet", "bufet", "bufé", "bollería", "bolleria", "zumo+", "cafe del desayuno", "café del desayuno"]),
      positive: inflect(["abundante+", "variad@", "complet@", "surtid@", "generos@"]),
      negative: inflect(["escas@", "pobre+", "repetitiv@", "rancio", "rancia", "poca variedad", "sin variedad", "justit@"])
    },
    restauracion: {
      topic: inflect(["restaurante+", "cena+", "comida+", "cocina", "bar", "carta", "menu+", "menú+", "plato+", "cocinero+", "almuerzo+", "tapa+", "cafeteria", "cafetería"]),
      positive: inflect(["delicios@", "exquisit@", "sabros@", "ric@", "riquísim@", "buenisim@ comida", "cocina excelente"]),
      negative: inflect(["insipid@", "insípid@", "incomible+", "intragable+", "sos@", "recalentad@", "congelad@"])
    },
    ubicacion: {
      topic: inflect(["ubicacion", "ubicación", "situad@", "localizacion", "localización", "zona", "centro", "playa", "barrio", "entorno", "emplazamiento", "a pie", "andando"]),
      positive: inflect(["centric@", "céntric@", "inmejorable+", "bien situad@", "bien comunicad@", "bien ubicad@", "cerca", "cerca de todo", "a dos pasos", "muy cerca"]),
      negative: inflect(["lejos", "lejísimos", "alejad@", "mal comunicad@", "mal situad@", "mal ubicad@", "aislad@", "peligros@", "en medio de la nada", "apartad@"])
    },
    precio_valor: {
      topic: inflect(["precio+", "tarifa+", "relacion calidad precio", "relación calidad precio", "calidad precio", "coste", "dinero", "pagamos", "pagar", "cobran", "cobraron", "suplemento+"]),
      positive: inflect(["barat@", "economic@", "económic@", "asequible+", "merece la pena", "vale la pena", "buena relacion", "buena relación", "ajustad@", "buen precio", "precio razonable"]),
      negative: inflect(["car@", "carisim@", "carísim@", "abusiv@", "sobrevalorad@", "timo", "estafa", "no vale", "excesiv@", "desorbitad@", "no merece la pena", "no vale la pena", "un robo"])
    },
    instalaciones: {
      topic: inflect([
        "instalaciones", "piscina+", "gimnasio", "spa", "parking", "aparcamiento", "garaje", "ascensor", "ascensores", "terraza", "jardin", "jardín",
        "jardines", "zonas comunes", "salon", "salón", "sauna", "jacuzzi", "solarium", "hamaca+", "tumbona+"
      ]),
      positive: inflect(["modern@", "renovad@", "nuev@", "cuidad@", "bien mantenid@", "de lujo"]),
      negative: inflect(["anticuad@", "viej@", "deteriorad@", "descuidad@", "cerrad@", "en obras", "obras", "destartalad@", "cutre+"])
    },
    ruido: {
      topic: inflect(["insonorizacion", "insonorización", "silencio", "se oia", "se oía", "se oye", "se escuchaba", "se escucha", "descansar", "dormir"]),
      positive: inflect(["silencios@", "tranquil@", "bien insonorizad@", "sin ruido", "sin ruidos", "se descansa", "descansamos bien", "dormimos bien"]),
      negative: inflect([
        "ruido+", "ruidos@", "mal insonorizad@", "se oia todo", "se oía todo", "se oye todo", "escandalo", "escándalo", "jaleo", "no pudimos dormir",
        "no pude dormir", "no se puede dormir", "obras al lado", "musica alta", "música alta", "paredes de papel", "estruendo"
      ])
    },
    wifi: {
      topic: inflect(["wifi", "wi fi", "internet", "conexion", "conexión", "red", "señal", "senal", "cobertura"]),
      positive: inflect(["rapid@", "rápid@", "estable", "gratis", "gratuit@", "funciona bien", "funcionaba bien", "iba bien", "buena conexion", "buena conexión"]),
      negative: inflect([
        "lent@", "lentisim@", "lentísim@", "se caia", "se caía", "se cae", "se corta", "se cortaba", "inestable", "sin wifi", "no habia wifi", "no había wifi",
        "de pago", "no funcionaba", "no funciona", "no iba", "mala conexion", "mala conexión"
      ])
    },
    recepcion_checkin: {
      topic: inflect(["recepcion", "recepción", "check in", "checkin", "entrada", "llegada", "check out", "checkout", "salida", "registro", "mostrador", "llaves", "llave"]),
      positive: inflect(["agil", "ágil", "sin esperas", "sin espera", "sencill@", "facil", "fácil", "fluid@", "rapidísim@", "en un minuto"]),
      negative: inflect(["espera+", "cola+", "tardaron", "tardo", "tardó", "caos", "caotic@", "caótic@", "confusion", "confusión", "error+", "equivocaron", "se equivocaron", "perdieron la reserva", "no encontraban la reserva", "una hora esperando"])
    },
    mantenimiento: {
      topic: inflect(["mantenimiento", "averia+", "avería+", "grifo+", "cisterna", "bombilla+", "enchufe+", "persiana+", "cerradura+", "puerta+", "ventana+", "fontaneria", "fontanería", "tuberia+", "tubería+"]),
      positive: inflect(["en buen estado", "bien mantenid@", "todo funcionaba", "todo funciona", "todo en orden", "reparado enseguida", "lo arreglaron"]),
      negative: inflect([
        "rot@", "estropead@", "averiad@", "gotea", "goteaba", "gotera+", "atascad@", "no funcionaba", "no funciona", "no funcionaban", "descuidad@", "mal estado",
        "desconchad@", "oxidad@", "fuera de servicio", "no cerraba", "no abria", "no abría", "sin arreglar", "no arreglaron", "chapuza+"
      ])
    }
  },
  positive: inflect([
    "buen@", "buen", "buenisim@", "buenísim@", "excelente+", "genial+", "estupend@", "fantastic@", "fantástic@", "maravillos@", "perfect@", "increible+", "increíble+",
    "magnific@", "magnífic@", "agradable+", "correct@", "recomendable+", "encantad@", "ideal+", "fenomenal+", "espectacular+", "top", "de diez", "de 10",
    "repetiremos", "volveremos", "volveria", "volvería", "volveríamos", "volveriamos", "recomiendo", "recomendamos", "me encanto", "me encantó", "nos encanto", "nos encantó",
    "bien", "muy bien", "de lujo", "sin problemas", "sin ningun problema", "sin ningún problema", "funciona", "funcionaba", "funcionan", "funcionaban", "grande+", "cuidad@", "detalle+", "gusto"
  ]),
  negative: inflect([
    "mal@", "mal", "malisim@", "malísim@", "horrible+", "pesim@", "pésim@", "terrible+", "fatal", "decepcionante+", "decepcion", "decepción", "decepcionad@", "lamentable+",
    "desastre", "desastros@", "vergonzos@", "verguenza", "vergüenza", "inaceptable+", "deficiente+", "penos@", "nefast@", "no recomiendo", "no lo recomiendo",
    "no volveremos", "no volveria", "no volvería", "no volveríamos", "regular", "mejorable+", "mediocre+", "insuficiente+", "peor", "problema+", "queja+", "frio", "frío", "fria", "fría",
    "pequeñ@", "pequen@", "roto", "rota", "flojo", "floja", "escas@", "justo", "justa", "poco", "poca", "nada", "olor"
  ]),
  negators: ["no", "nunca", "jamas", "jamás", "nada", "ni", "sin", "tampoco", "poco", "nadie", "ningun", "ningún", "ninguna"],
  intensifiers: ["muy", "mucho", "mucha", "muchisimo", "muchísimo", "demasiado", "super", "súper", "extremadamente", "realmente", "totalmente", "bastante", "increiblemente", "increíblemente", "absolutamente", "tan", "verdaderamente", "sumamente"]
};

const EN: LanguageLexicon = {
  categories: {
    limpieza: {
      topic: inflect(["cleanliness", "cleaning", "housekeeping", "sheet+", "towel+", "linen", "dust", "hygiene", "cleaner+", "maid+"]),
      positive: inflect(["clean", "spotless", "immaculate", "pristine", "tidy", "sparkling", "fresh linen", "fresh sheets", "well cleaned"]),
      negative: inflect([
        "dirty", "filthy", "stained", "stain+", "dusty", "mold", "mould", "mouldy", "moldy", "smelly", "smell", "smelled", "smelt", "stink", "stank",
        "cockroach", "cockroaches", "bug+", "bed bug+", "bedbug+", "hair+", "grimy", "unclean", "not cleaned", "never cleaned", "gross", "disgusting"
      ])
    },
    habitacion: {
      topic: inflect([
        "room+", "bedroom+", "bed+", "mattress", "mattresses", "pillow+", "bathroom+", "shower+", "view+", "air conditioning", "air con", "aircon", "ac", "heating",
        "balcony", "suite", "bathtub", "tub"
      ]),
      positive: inflect(["spacious", "roomy", "comfortable", "comfy", "cozy", "cosy", "bright", "airy", "well appointed", "well equipped", "generous size"]),
      negative: inflect(["tiny", "cramped", "uncomfortable", "dated", "outdated", "dark", "damp", "musty", "worn", "shabby", "claustrophobic", "poky"])
    },
    personal: {
      topic: inflect(["staff", "employee+", "receptionist+", "waiter+", "waitress", "waitresses", "service", "team", "manager+", "people", "concierge", "porter+", "crew"]),
      positive: inflect([
        "friendly", "helpful", "kind", "attentive", "welcoming", "polite", "professional", "lovely staff", "courteous", "accommodating", "warm", "caring",
        "went above and beyond", "above and beyond", "efficient", "gracious", "hospitable"
      ]),
      negative: inflect(["rude", "unfriendly", "unhelpful", "impolite", "dismissive", "arrogant", "unprofessional", "ignored", "indifferent", "condescending", "cold staff", "grumpy", "uninterested"])
    },
    desayuno: {
      topic: inflect(["breakfast+", "buffet", "coffee", "pastries", "pastry", "juice+", "morning meal", "brunch"]),
      positive: inflect(["plentiful", "varied", "generous", "abundant", "lavish", "great spread", "good selection", "wide selection"]),
      negative: inflect(["limited", "repetitive", "sparse", "stale", "meager", "meagre", "poor selection", "little choice", "no choice", "lukewarm"])
    },
    restauracion: {
      topic: inflect(["restaurant+", "dinner+", "lunch", "food", "meal+", "menu+", "dish", "dishes", "bar", "kitchen", "chef+", "cuisine", "dining", "tapas", "cafe"]),
      positive: inflect(["delicious", "tasty", "flavourful", "flavorful", "exquisite", "mouth watering", "superb food", "excellent food"]),
      negative: inflect(["bland", "tasteless", "inedible", "overcooked", "undercooked", "greasy", "soggy", "reheated", "frozen"])
    },
    ubicacion: {
      topic: inflect(["location", "located", "situated", "area", "neighborhood", "neighbourhood", "centre", "center", "beach", "downtown", "distance", "walk", "walking", "surroundings", "setting"]),
      positive: inflect([
        "central", "convenient", "perfect location", "great location", "excellent location", "ideal location", "close", "near", "nearby", "walking distance", "well located",
        "steps away", "minutes away", "right in the centre", "right in the center", "well connected"
      ]),
      negative: inflect(["far", "remote", "isolated", "inconvenient", "sketchy", "unsafe", "nowhere near", "middle of nowhere", "far from", "poorly located", "badly located", "dodgy"])
    },
    precio_valor: {
      topic: inflect(["price+", "rate+", "value", "money", "cost+", "paid", "pay", "worth", "charge+", "charged", "fee+", "bill", "budget"]),
      positive: inflect(["affordable", "reasonable", "cheap", "bargain", "good value", "great value", "excellent value", "worth it", "worth every", "value for money", "fair price", "fairly priced", "reasonably priced"]),
      negative: inflect(["expensive", "overpriced", "pricey", "rip off", "ripoff", "rip-off", "not worth", "too much", "scam", "costly", "extortionate", "hidden charges", "hidden fees", "poor value", "bad value"])
    },
    instalaciones: {
      topic: inflect([
        "facilities", "facility", "pool+", "gym", "spa", "parking", "garage", "elevator+", "lift+", "terrace", "garden+", "lobby", "amenities", "sauna", "jacuzzi",
        "hot tub", "sun bed+", "sunbed+", "lounger+", "rooftop", "fitness"
      ]),
      positive: inflect(["modern", "new", "renovated", "refurbished", "well maintained", "well kept", "great facilities", "lovely pool", "beautiful pool", "state of the art"]),
      negative: inflect(["run down", "rundown", "closed", "neglected", "shabby", "no pool", "out of order", "under construction", "construction", "building work", "tired"])
    },
    ruido: {
      topic: inflect(["noise", "soundproofing", "sound proofing", "insulation", "hear", "heard", "sleep", "slept", "walls"]),
      positive: inflect(["quiet", "silent", "peaceful", "well insulated", "soundproof", "sound proof", "slept well", "slept like", "no noise", "not noisy", "calm"]),
      negative: inflect([
        "noisy", "loud", "thin walls", "paper thin", "could hear", "couldn t sleep", "could not sleep", "traffic noise", "street noise", "noise from", "kept us awake", "kept me awake",
        "woke us up", "woke me up", "banging", "shouting", "loud music", "party", "construction noise", "not soundproofed"
      ])
    },
    wifi: {
      topic: inflect(["wifi", "wi fi", "wi-fi", "internet", "connection", "signal", "network", "broadband"]),
      positive: inflect(["fast", "free", "reliable", "strong", "worked well", "works well", "good wifi", "great wifi", "excellent wifi", "stable", "speedy"]),
      negative: inflect([
        "slow", "weak", "unreliable", "kept dropping", "keeps dropping", "dropped", "didn t work", "did not work", "doesn t work", "does not work", "no wifi", "paid wifi", "not free",
        "patchy", "spotty", "intermittent", "barely worked", "never worked", "no signal", "poor signal"
      ])
    },
    recepcion_checkin: {
      topic: inflect(["reception", "check in", "checkin", "check-in", "check out", "checkout", "check-out", "arrival", "front desk", "desk", "key+", "keycard+", "booking", "reservation"]),
      positive: inflect(["quick", "smooth", "easy", "efficient", "seamless", "no wait", "hassle free", "straightforward", "prompt", "speedy", "early check in", "late check out"]),
      negative: inflect([
        "long wait", "waited", "waiting", "queue", "queued", "line", "chaotic", "confusing", "mistake+", "mix up", "mixed up", "lost booking", "lost our booking", "lost reservation",
        "took forever", "took ages", "nobody at", "no one at", "unattended", "double booked", "wrong room", "not ready"
      ])
    },
    mantenimiento: {
      topic: inflect(["maintenance", "repair+", "leak+", "faucet+", "tap+", "toilet+", "light bulb+", "bulb+", "plumbing", "door+", "window+", "lock+", "socket+", "outlet+", "blind+", "curtain+", "pipe+", "drain+"]),
      positive: inflect(["well maintained", "everything worked", "everything works", "good condition", "great condition", "fixed quickly", "fixed immediately", "promptly fixed", "in working order"]),
      negative: inflect([
        "broken", "broke", "leaking", "leaked", "dripping", "not working", "didn t work", "did not work", "doesn t work", "does not work", "out of order", "faulty", "rusty", "peeling",
        "cracked", "poor condition", "disrepair", "clogged", "blocked", "stuck", "jammed", "flickering", "no hot water", "cold water only", "wouldn t close", "wouldn t open", "never fixed", "not fixed"
      ])
    }
  },
  positive: inflect([
    "good", "great", "excellent", "amazing", "wonderful", "fantastic", "perfect", "awesome", "lovely", "nice", "superb", "outstanding", "brilliant", "pleasant", "recommend", "recommended",
    "loved", "love", "enjoyed", "happy", "best", "fabulous", "incredible", "exceptional", "top notch", "five stars", "5 stars", "spot on", "faultless", "flawless", "impressed", "impressive",
    "delightful", "charming", "beautiful", "gorgeous", "stunning", "well", "fine", "decent", "solid", "no complaints", "no issues", "no problems", "would return", "will return", "will be back",
    "come back", "coming back", "again", "worked", "works", "large", "big", "huge", "generous"
  ]),
  negative: inflect([
    "bad", "terrible", "horrible", "awful", "poor", "disappointing", "disappointed", "disappointment", "worst", "unacceptable", "dreadful", "mediocre", "disgusting", "appalling",
    "never again", "avoid", "not recommend", "wouldn t recommend", "would not recommend", "subpar", "lousy", "pathetic", "abysmal", "shocking", "horrendous", "atrocious", "nightmare",
    "problem+", "issue+", "complaint+", "cold", "small", "old", "hard", "meh", "average", "underwhelming", "let down", "letdown", "rubbish", "useless", "nasty", "lacking", "lack of", "no", "none"
  ]),
  negators: ["not", "no", "never", "nothing", "none", "nobody", "hardly", "barely", "without", "neither", "nor", "lack", "lacked", "lacking", "cannot", "cant", "couldnt", "wasnt", "werent", "isnt", "arent", "didnt", "doesnt", "dont", "wont"],
  intensifiers: ["very", "really", "extremely", "so", "too", "incredibly", "absolutely", "totally", "super", "quite", "highly", "truly", "exceptionally", "utterly", "seriously", "particularly", "especially", "insanely", "ridiculously"]
};

// Léxicos REDUCIDOS (de, fr, pt): tema + pocas polaridades por categoría.
const DE: LanguageLexicon = {
  categories: {
    limpieza: { topic: ["sauberkeit", "reinigung", "bettwäsche", "handtücher", "staub"], positive: ["sauber", "blitzsauber", "makellos", "gepflegt"], negative: ["schmutzig", "dreckig", "unsauber", "verschmutzt", "schimmel", "haare", "gestank", "stinkt", "stank", "fleckig", "flecken"] },
    habitacion: { topic: ["zimmer", "bett", "betten", "matratze", "kissen", "bad", "badezimmer", "dusche", "aussicht", "klimaanlage", "heizung", "balkon"], positive: ["geräumig", "gemütlich", "bequem", "komfortabel", "hell", "grosszügig", "großzügig"], negative: ["winzig", "eng", "unbequem", "dunkel", "feucht", "muffig", "abgewohnt", "veraltet"] },
    personal: { topic: ["personal", "mitarbeiter", "mitarbeiterin", "rezeptionist", "rezeptionistin", "kellner", "kellnerin", "service", "team"], positive: ["freundlich", "hilfsbereit", "zuvorkommend", "aufmerksam", "nett", "herzlich", "professionell", "kompetent"], negative: ["unfreundlich", "unhöflich", "unhoflich", "arrogant", "desinteressiert", "inkompetent", "ignoriert", "ruppig"] },
    desayuno: { topic: ["frühstück", "fruhstuck", "frühstücksbuffet", "buffet", "kaffee", "brötchen"], positive: ["reichhaltig", "vielfältig", "abwechslungsreich", "üppig", "frisch"], negative: ["dürftig", "durftig", "mager", "eintönig", "einseitig", "kalt", "spärlich"] },
    restauracion: { topic: ["restaurant", "essen", "abendessen", "mittagessen", "küche", "kuche", "bar", "speisekarte", "gerichte"], positive: ["lecker", "köstlich", "kostlich", "vorzüglich", "schmackhaft"], negative: ["fade", "geschmacklos", "ungenießbar", "ungeniessbar", "versalzen", "aufgewärmt"] },
    ubicacion: { topic: ["lage", "gelegen", "umgebung", "zentrum", "strand", "innenstadt", "gegend"], positive: ["zentral", "perfekte lage", "tolle lage", "super lage", "nah", "in der nähe", "gut gelegen", "gut angebunden"], negative: ["abgelegen", "weit weg", "weit entfernt", "ungünstig", "ungunstig", "unsicher", "schlecht gelegen"] },
    precio_valor: { topic: ["preis", "preise", "preis leistung", "preis-leistung", "preis leistungs verhältnis", "kosten", "geld", "bezahlt"], positive: ["günstig", "gunstig", "preiswert", "fair", "angemessen", "lohnt sich", "sein geld wert"], negative: ["teuer", "überteuert", "uberteuert", "zu teuer", "abzocke", "wucher", "nicht wert", "überzogen"] },
    instalaciones: { topic: ["pool", "schwimmbad", "fitness", "fitnessraum", "spa", "wellness", "parkplatz", "tiefgarage", "aufzug", "fahrstuhl", "terrasse", "garten", "anlage", "einrichtungen", "sauna"], positive: ["modern", "neu", "renoviert", "gepflegt", "top ausgestattet"], negative: ["veraltet", "alt", "heruntergekommen", "geschlossen", "ungepflegt", "baustelle", "bauarbeiten"] },
    ruido: { topic: ["lärm", "larm", "geräusche", "gerausche", "schallisolierung", "schlafen", "geschlafen", "wände", "wande"], positive: ["ruhig", "leise", "still", "gut isoliert", "gut geschlafen"], negative: ["laut", "hellhörig", "hellhorig", "lärmig", "schlecht isoliert", "nicht schlafen", "wach gehalten", "straßenlärm", "strassenlarm", "baulärm"] },
    wifi: { topic: ["wlan", "wifi", "internet", "verbindung", "netz", "empfang"], positive: ["schnell", "stabil", "kostenlos", "gratis", "funktionierte gut", "funktioniert gut"], negative: ["langsam", "instabil", "funktionierte nicht", "funktioniert nicht", "kein wlan", "kein internet", "kostenpflichtig", "bricht ab", "abgebrochen"] },
    recepcion_checkin: { topic: ["rezeption", "empfang", "check in", "checkin", "check-in", "anreise", "abreise", "check out", "checkout", "schlüssel", "schlussel"], positive: ["schnell", "unkompliziert", "reibungslos", "problemlos", "ohne wartezeit", "zügig"], negative: ["wartezeit", "warten", "gewartet", "schlange", "chaotisch", "chaos", "fehler", "verwechselt", "reservierung nicht gefunden", "niemand da"] },
    mantenimiento: { topic: ["wartung", "reparatur", "wasserhahn", "toilette", "tür", "tur", "fenster", "steckdose", "leitung", "abfluss"], positive: ["gut gewartet", "alles funktionierte", "alles funktioniert", "guter zustand", "sofort repariert"], negative: ["kaputt", "defekt", "funktionierte nicht", "funktioniert nicht", "tropft", "tropfte", "undicht", "verstopft", "klemmt", "rostig", "schlechter zustand", "nicht repariert", "außer betrieb", "ausser betrieb"] }
  },
  positive: ["gut", "sehr gut", "toll", "super", "ausgezeichnet", "hervorragend", "perfekt", "wunderbar", "schön", "schon", "empfehlenswert", "angenehm", "top", "klasse", "prima", "genial", "fantastisch", "großartig", "grossartig", "zufrieden", "gerne wieder", "empfehlen", "einwandfrei", "tadellos", "gross", "groß", "funktionierte", "funktioniert"],
  negative: ["schlecht", "schrecklich", "furchtbar", "enttäuschend", "enttauschend", "enttäuscht", "enttauscht", "mangelhaft", "katastrophal", "katastrophe", "miserabel", "inakzeptabel", "nie wieder", "unzumutbar", "mies", "grauenhaft", "problem", "probleme", "klein", "alt", "kalt", "leider", "unmöglich", "unmoglich", "frechheit", "zumutung"],
  negators: ["nicht", "kein", "keine", "keinen", "keinem", "keiner", "keines", "nie", "niemals", "nichts", "ohne", "kaum", "weder", "niemand"],
  intensifiers: ["sehr", "extrem", "wirklich", "total", "absolut", "äußerst", "ausserst", "ziemlich", "zu", "viel", "besonders", "richtig", "echt", "unglaublich", "super"]
};

const FR: LanguageLexicon = {
  categories: {
    limpieza: { topic: ["propreté", "proprete", "nettoyage", "ménage", "menage", "draps", "serviettes", "poussière", "poussiere", "hygiène", "hygiene"], positive: ["propre", "propres", "impeccable", "impeccables", "nickel", "irréprochable"], negative: ["sale", "sales", "saleté", "salete", "crasseux", "crasseuse", "taché", "tache", "taches", "moisi", "moisissure", "cheveux", "poils", "odeur", "puait", "puant", "dégoûtant", "degoutant", "cafards"] },
    habitacion: { topic: ["chambre", "chambres", "lit", "lits", "matelas", "oreiller", "oreillers", "salle de bain", "salle de bains", "douche", "vue", "climatisation", "clim", "chauffage", "balcon"], positive: ["spacieuse", "spacieux", "confortable", "confortables", "cosy", "lumineuse", "lumineux", "douillette"], negative: ["exiguë", "exigue", "minuscule", "étroite", "etroite", "inconfortable", "sombre", "humide", "vétuste", "vetuste", "défraîchie", "defraichie"] },
    personal: { topic: ["personnel", "équipe", "equipe", "réceptionniste", "receptionniste", "serveur", "serveuse", "service", "accueil", "staff"], positive: ["aimable", "aimables", "sympathique", "sympathiques", "serviable", "serviables", "chaleureux", "chaleureuse", "attentionné", "attentionne", "souriant", "souriante", "professionnel", "professionnels", "à l écoute", "aux petits soins"], negative: ["désagréable", "desagreable", "désagréables", "impoli", "impolie", "impolis", "froid", "froids", "hautain", "arrogant", "incompétent", "incompetent", "ignoré", "ignore", "peu aimable", "pas aimable"] },
    desayuno: { topic: ["petit déjeuner", "petit dejeuner", "petit-déjeuner", "petit-dejeuner", "buffet", "café", "cafe", "viennoiseries", "croissants"], positive: ["copieux", "varié", "varie", "variés", "généreux", "genereux", "abondant", "frais"], negative: ["maigre", "pauvre", "limité", "limite", "répétitif", "repetitif", "froid", "insuffisant", "peu de choix", "pas de choix"] },
    restauracion: { topic: ["restaurant", "dîner", "diner", "déjeuner", "dejeuner", "repas", "cuisine", "bar", "carte", "menu", "plats", "plat"], positive: ["délicieux", "delicieux", "délicieuse", "savoureux", "excellente cuisine", "très bonne cuisine"], negative: ["fade", "immangeable", "insipide", "réchauffé", "rechauffe", "trop cuit", "pas bon", "mauvaise cuisine"] },
    ubicacion: { topic: ["emplacement", "situé", "situe", "située", "situation", "quartier", "centre", "plage", "environnement", "à pied", "a pied"], positive: ["central", "centrale", "idéalement situé", "idealement situe", "bien situé", "bien situe", "bien placé", "bien place", "proche", "à proximité", "a proximite", "à deux pas", "a deux pas", "tout près", "tout pres"], negative: ["loin", "éloigné", "eloigne", "isolé", "isole", "excentré", "excentre", "mal situé", "mal situe", "mal placé", "mal place", "dangereux", "au milieu de nulle part"] },
    precio_valor: { topic: ["prix", "tarif", "tarifs", "rapport qualité prix", "rapport qualite prix", "qualité prix", "qualite prix", "coût", "cout", "argent", "payé", "paye"], positive: ["abordable", "raisonnable", "bon marché", "bon marche", "correct", "bon rapport", "excellent rapport", "vaut le coup", "vaut le prix"], negative: ["cher", "chère", "chere", "trop cher", "hors de prix", "excessif", "excessive", "arnaque", "surfacturé", "ne vaut pas", "pas donné", "prohibitif"] },
    instalaciones: { topic: ["piscine", "spa", "parking", "ascenseur", "salle de sport", "équipements", "equipements", "installations", "terrasse", "jardin", "sauna", "jacuzzi", "hammam"], positive: ["moderne", "modernes", "neuf", "neuve", "rénové", "renove", "rénovée", "bien entretenu", "bien entretenue", "magnifique piscine"], negative: ["vétuste", "vetuste", "vieillot", "délabré", "delabre", "fermé", "ferme", "fermée", "en travaux", "travaux", "mal entretenu", "pas de piscine"] },
    ruido: { topic: ["bruit", "bruits", "insonorisation", "isolation phonique", "isolation", "dormir", "dormi", "murs", "cloisons"], positive: ["calme", "silencieux", "silencieuse", "paisible", "bien insonorisé", "bien insonorisee", "bien dormi", "aucun bruit", "pas de bruit"], negative: ["bruyant", "bruyante", "bruyants", "mal insonorisé", "mal insonorisee", "on entend tout", "entend tout", "impossible de dormir", "pas pu dormir", "réveillé", "reveille", "cloisons fines", "murs fins", "bruit de la rue", "travaux à côté"] },
    wifi: { topic: ["wifi", "wi fi", "wi-fi", "internet", "connexion", "réseau", "reseau"], positive: ["rapide", "stable", "gratuit", "gratuite", "fonctionne bien", "fonctionnait bien", "bon wifi", "excellent wifi"], negative: ["lent", "lente", "instable", "ne fonctionne pas", "ne fonctionnait pas", "ne marche pas", "ne marchait pas", "pas de wifi", "payant", "coupures", "coupait", "mauvais wifi", "aucun réseau"] },
    recepcion_checkin: { topic: ["réception", "reception", "arrivée", "arrivee", "enregistrement", "check in", "checkin", "check-in", "départ", "depart", "check out", "checkout", "clés", "cles", "clé", "cle"], positive: ["rapide", "efficace", "sans attente", "simple", "fluide", "sans problème", "sans probleme"], negative: ["attente", "attendu", "attendre", "queue", "file", "lent", "lente", "chaotique", "confus", "erreur", "erreurs", "réservation perdue", "reservation perdue", "personne à la réception", "personne a la reception"] },
    mantenimiento: { topic: ["entretien", "réparation", "reparation", "robinet", "toilettes", "wc", "porte", "fenêtre", "fenetre", "prise", "prises", "volet", "volets", "plomberie", "canalisation"], positive: ["bien entretenu", "bien entretenue", "tout fonctionnait", "tout fonctionne", "bon état", "bon etat", "réparé rapidement", "repare rapidement"], negative: ["cassé", "casse", "cassée", "en panne", "fuite", "fuit", "fuyait", "ne fonctionne pas", "ne fonctionnait pas", "hors service", "bouché", "bouche", "rouillé", "rouille", "mauvais état", "mauvais etat", "délabré", "pas réparé", "pas repare", "ne ferme pas", "ne fermait pas"] }
  },
  positive: ["bon", "bonne", "bons", "bonnes", "bien", "excellent", "excellente", "excellents", "parfait", "parfaite", "super", "génial", "genial", "magnifique", "agréable", "agreable", "formidable", "merveilleux", "merveilleuse", "recommande", "recommandons", "top", "impeccable", "superbe", "très bien", "tres bien", "ravi", "ravis", "ravie", "enchanté", "enchante", "enchantés", "reviendrons", "reviendrai", "sans problème", "sans probleme", "grand", "grande", "fonctionne", "fonctionnait", "adoré", "adore"],
  negative: ["mauvais", "mauvaise", "mauvaises", "horrible", "terrible", "décevant", "decevant", "décevante", "decevante", "déçu", "decu", "déçue", "decue", "déçus", "decus", "nul", "nulle", "nuls", "inacceptable", "lamentable", "catastrophique", "catastrophe", "médiocre", "mediocre", "jamais", "à éviter", "a eviter", "problème", "probleme", "problèmes", "problemes", "petit", "petite", "froid", "froide", "vieux", "vieille", "moyen", "moyenne", "bof", "insuffisant", "honteux", "scandaleux", "pire", "dommage"],
  negators: ["ne", "pas", "jamais", "aucun", "aucune", "sans", "rien", "ni", "non", "guère", "guere", "personne", "nullement", "peu"],
  intensifiers: ["très", "tres", "vraiment", "extrêmement", "extremement", "trop", "tellement", "super", "absolument", "totalement", "hyper", "particulièrement", "particulierement", "franchement", "carrément", "carrement", "fort"]
};

const PT: LanguageLexicon = {
  categories: {
    limpieza: { topic: inflect(["limpeza", "higiene", "lençóis", "lencois", "lençol", "toalha+", "poeira", "pó", "arrumação", "arrumacao", "camareira+"]), positive: inflect(["limp@", "impecável", "impecavel", "impecáveis", "imaculad@", "cheiroso", "cheirosa"]), negative: inflect(["suj@", "sujeira", "imund@", "manchad@", "mancha+", "mofo", "bolor", "cabelo+", "barata+", "percevejo+", "cheiro ruim", "mau cheiro", "cheirava mal", "fedor", "nojent@", "sem limpar", "não limparam", "nao limparam"]) },
    habitacion: { topic: inflect(["quarto+", "cama+", "colchão", "colchao", "colchões", "travesseiro+", "almofada+", "banheiro+", "casa de banho", "chuveiro", "ducha", "vista+", "ar condicionado", "aquecimento", "varanda"]), positive: inflect(["espaços@", "espacos@", "confortável", "confortavel", "confortáveis", "aconchegante+", "ampl@", "clar@", "arejad@"]), negative: inflect(["minúscul@", "minuscul@", "apertad@", "desconfortável", "desconfortavel", "escur@", "úmid@", "umid@", "húmid@", "humid@", "abafad@", "velh@", "antiquad@"]) },
    personal: { topic: inflect(["funcionário+", "funcionario+", "funcionária+", "funcionaria+", "equipe", "equipa", "staff", "atendimento", "recepcionista+", "garçom", "garcom", "empregad@", "pessoal"]), positive: inflect(["simpátic@", "simpatic@", "atencios@", "prestativ@", "educad@", "gentil", "gentis", "cordial", "cordiais", "profissional", "profissionais", "solícit@", "solicit@", "acolhedor+", "carinhos@"]), negative: inflect(["mal educad@", "mal-educad@", "grosseir@", "antipátic@", "antipatic@", "rude+", "arrogante+", "indiferente+", "despreparad@", "ignoraram", "nos ignoraram", "desatencios@", "pouco profissional"]) },
    desayuno: { topic: inflect(["café da manhã", "cafe da manha", "pequeno almoço", "pequeno almoco", "pequeno-almoço", "pequeno-almoco", "buffet", "bufê", "bufe", "pães", "paes", "sumo+", "suco+"]), positive: inflect(["fart@", "variad@", "complet@", "abundante+", "reforçad@", "reforcad@", "generos@", "fresc@"]), negative: inflect(["fraco", "fraca", "escass@", "pobre+", "repetitiv@", "limitad@", "pouca variedade", "sem variedade", "requentad@"]) },
    restauracion: { topic: inflect(["restaurante+", "jantar", "almoço", "almoco", "comida+", "refeição", "refeicao", "refeições", "refeicoes", "cozinha", "bar", "cardápio", "cardapio", "menu", "prato+"]), positive: inflect(["delicios@", "sabores@", "saboros@", "gostos@", "excelente comida", "comida ótima", "comida otima"]), negative: inflect(["sem sabor", "insoss@", "intragável", "intragavel", "fria", "frio", "requentad@", "mal feit@", "comida ruim"]) },
    ubicacion: { topic: inflect(["localização", "localizacao", "localizad@", "situad@", "zona", "bairro", "centro", "praia", "região", "regiao", "a pé", "a pe"]), positive: inflect(["central", "centrais", "bem localizad@", "ótima localização", "otima localizacao", "excelente localização", "perto", "pertinho", "próxim@", "proxim@", "bem situad@", "de tudo"]), negative: inflect(["longe", "afastad@", "isolad@", "mal localizad@", "distante+", "perigos@", "no meio do nada", "longe de tudo"]) },
    precio_valor: { topic: inflect(["preço+", "preco+", "tarifa+", "custo benefício", "custo beneficio", "custo-benefício", "custo-beneficio", "valor+", "dinheiro", "pagamos", "pagar", "cobraram", "taxa+"]), positive: inflect(["barat@", "econômic@", "economic@", "acessível", "acessivel", "justo", "justa", "vale a pena", "valeu a pena", "bom custo", "ótimo custo", "otimo custo", "preço justo", "preco justo"]), negative: inflect(["car@", "caríssim@", "carissim@", "abusiv@", "não vale", "nao vale", "não valeu", "nao valeu", "roubo", "absurd@", "exorbitante+", "superfaturad@", "não compensa", "nao compensa"]) },
    instalaciones: { topic: inflect(["piscina+", "academia", "ginásio", "ginasio", "spa", "estacionamento", "garagem", "elevador+", "terraço", "terraco", "jardim", "jardins", "instalações", "instalacoes", "áreas comuns", "areas comuns", "sauna", "jacuzzi", "espreguiçadeira+", "espreguicadeira+"]), positive: inflect(["modern@", "nov@", "renovad@", "reformad@", "bem cuidad@", "bem conservad@", "ótima estrutura", "otima estrutura"]), negative: inflect(["antig@", "velh@", "deteriorad@", "mal cuidad@", "fechad@", "em obras", "obras", "abandonad@", "sem piscina", "acabad@"]) },
    ruido: { topic: inflect(["barulho+", "ruído+", "ruido+", "isolamento acústico", "isolamento acustico", "isolamento", "silêncio", "silencio", "dormir", "dormimos", "parede+"]), positive: inflect(["silencios@", "tranquil@", "sossegad@", "bem isolad@", "sem barulho", "dormimos bem", "dormi bem"]), negative: inflect(["barulhent@", "mal isolad@", "ouve tudo", "ouvia tudo", "escuta tudo", "não conseguimos dormir", "nao conseguimos dormir", "não consegui dormir", "nao consegui dormir", "impossível dormir", "impossivel dormir", "paredes finas", "música alta", "musica alta", "barulho da rua", "obras ao lado"]) },
    wifi: { topic: inflect(["wifi", "wi fi", "wi-fi", "internet", "conexão", "conexao", "ligação", "ligacao", "sinal", "rede"]), positive: inflect(["rápid@", "rapid@", "estável", "estavel", "grátis", "gratis", "gratuit@", "funcionava bem", "funciona bem", "bom wifi", "ótimo wifi", "otimo wifi"]), negative: inflect(["lent@", "instável", "instavel", "caía", "caia", "cai", "caindo", "não funcionava", "nao funcionava", "não funciona", "nao funciona", "sem wifi", "sem internet", "pag@", "fraco", "fraca", "péssimo wifi", "pessimo wifi", "não pegava", "nao pegava"]) },
    recepcion_checkin: { topic: inflect(["recepção", "recepcao", "receção", "rececao", "check in", "checkin", "check-in", "chegada", "check out", "checkout", "check-out", "saída", "saida", "registro", "registo", "chave+", "cartão+", "cartao+"]), positive: inflect(["rápid@", "rapid@", "ágil", "agil", "sem espera", "sem fila", "fácil", "facil", "simples", "tranquil@", "eficiente+"]), negative: inflect(["espera", "esperamos", "esperar", "fila+", "demorad@", "demorou", "demoraram", "caótic@", "caotic@", "confus@", "confusão", "confusao", "erro+", "erraram", "perderam a reserva", "não encontraram a reserva", "nao encontraram a reserva", "uma hora esperando", "ninguém na recepção", "ninguem na recepcao"]) },
    mantenimiento: { topic: inflect(["manutenção", "manutencao", "reparo+", "conserto+", "torneira+", "descarga", "vaso sanitário", "sanita", "lâmpada+", "lampada+", "tomada+", "porta+", "janela+", "fechadura+", "cano+", "encanamento", "ralo"]), positive: inflect(["bem conservad@", "bem cuidad@", "tudo funcionava", "tudo funciona", "bom estado", "consertaram rápido", "consertaram rapido", "resolveram logo"]), negative: inflect(["quebrad@", "estragad@", "avariad@", "danificad@", "vazamento", "vazando", "pingando", "goteira+", "entupid@", "não funcionava", "nao funcionava", "não funciona", "nao funciona", "não funcionavam", "nao funcionavam", "enferrujad@", "descascad@", "mau estado", "sem consertar", "não consertaram", "nao consertaram", "não fechava", "nao fechava", "não abria", "nao abria", "sem água quente", "sem agua quente"]) }
  },
  positive: inflect(["bom", "boa", "bons", "boas", "ótim@", "otim@", "excelente+", "maravilhos@", "perfeit@", "incrível", "incrivel", "incríveis", "agradável", "agradavel", "agradáveis", "recomendo", "recomendamos", "adoramos", "adorei", "adoramos", "amei", "amamos", "fantástic@", "fantastic@", "espetacular", "espetaculares", "sensacional", "nota 10", "nota dez", "top", "show", "voltaremos", "voltarei", "voltaria", "voltaríamos", "voltariamos", "sem problemas", "sem problema", "tudo certo", "funciona", "funcionava", "funcionam", "funcionavam", "grande+", "bem", "muito bem", "satisfeit@", "encantad@", "lind@", "surpreendente+", "impecável"]),
  negative: inflect(["ruim", "ruins", "mau", "má", "ma", "maus", "más", "mas", "péssim@", "pessim@", "horrível", "horrivel", "horríveis", "terrível", "terrivel", "terríveis", "decepcionante+", "decepção", "decepcao", "decepcionad@", "inaceitável", "inaceitavel", "lamentável", "lamentavel", "fraco", "fraca", "fracos", "fracas", "medíocre+", "mediocre+", "nunca mais", "não recomendo", "nao recomendo", "não voltaremos", "nao voltaremos", "não voltaria", "nao voltaria", "vergonh@", "vergonhos@", "absurd@", "desastre", "problema+", "reclamação", "reclamacao", "pequen@", "velh@", "fri@", "regular", "mais ou menos", "deixa a desejar", "deixou a desejar", "pior", "falta", "faltou", "faltava"]),
  negators: ["não", "nao", "nunca", "jamais", "nada", "nem", "sem", "nenhum", "nenhuma", "pouco", "pouca", "ninguém", "ninguem", "tampouco"],
  intensifiers: ["muito", "muita", "muitos", "muitas", "demais", "extremamente", "super", "realmente", "bastante", "bem", "totalmente", "absolutamente", "incrivelmente", "tão", "tao", "mega", "hiper", "verdadeiramente", "completamente"]
};

const LEXICONS: Readonly<Record<DictionaryLanguage, LanguageLexicon>> = Object.freeze({ es: ES, en: EN, de: DE, fr: FR, pt: PT });

// ---------------------------------------------------------------------------
// Compilación del léxico: tokens normalizados, indexados por primer token
// ---------------------------------------------------------------------------

type Polarity = -1 | 0 | 1;

type CompiledEntry = {
  tokens: string[];
  /** Categoría implicada; `null` = polaridad general. */
  category: ReviewCategory | null;
  polarity: Polarity;
};

type CompiledLexicon = {
  byFirstToken: Map<string, CompiledEntry[]>;
  negators: Set<string>;
  intensifiers: Set<string>;
};

const NORMALIZE_CACHE = new Map<string, string>();

/** Minúsculas, NFD sin diacríticos, contracciones inglesas expandidas, apóstrofos separados. */
export function normalizeForDictionary(text: string): string {
  const cached = NORMALIZE_CACHE.get(text);
  if (cached !== undefined) return cached;
  const normalized = text
    .toLowerCase()
    .replace(/(\w)n['’]t\b/g, "$1 not")
    .replace(/['’]/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss");
  if (text.length <= 64) NORMALIZE_CACHE.set(text, normalized);
  return normalized;
}

export function tokenizeForDictionary(text: string): string[] {
  return normalizeForDictionary(text)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function addEntries(target: Map<string, CompiledEntry[]>, terms: readonly string[], category: ReviewCategory | null, polarity: Polarity): void {
  for (const term of terms) {
    const tokens = tokenizeForDictionary(term);
    const first = tokens[0];
    if (!first) continue;
    const list = target.get(first) ?? [];
    if (list.some((entry) => entry.category === category && entry.polarity === polarity && entry.tokens.join(" ") === tokens.join(" "))) continue;
    list.push({ tokens, category, polarity });
    target.set(first, list);
  }
}

function compile(lexicons: readonly LanguageLexicon[]): CompiledLexicon {
  const byFirstToken = new Map<string, CompiledEntry[]>();
  const negators = new Set<string>();
  const intensifiers = new Set<string>();
  for (const lexicon of lexicons) {
    for (const category of REVIEW_CATEGORIES) {
      const entry = lexicon.categories[category];
      addEntries(byFirstToken, entry.topic, category, 0);
      addEntries(byFirstToken, entry.positive, category, 1);
      addEntries(byFirstToken, entry.negative, category, -1);
    }
    for (const negator of lexicon.negators) negators.add(normalizeForDictionary(negator).trim());
    for (const intensifier of lexicon.intensifiers) intensifiers.add(normalizeForDictionary(intensifier).trim());
  }
  // Un negador («nada», «poco», «no», «lack»…) nunca cuenta también como
  // polaridad general: solo invierte el término que le sigue.
  const isNegator = (term: string): boolean => {
    const tokens = tokenizeForDictionary(term);
    return tokens.length === 1 && negators.has(tokens[0] as string);
  };
  for (const lexicon of lexicons) {
    addEntries(byFirstToken, lexicon.positive.filter((term) => !isNegator(term)), null, 1);
    addEntries(byFirstToken, lexicon.negative.filter((term) => !isNegator(term)), null, -1);
  }
  // Coincidencia más larga primero.
  for (const list of byFirstToken.values()) list.sort((a, b) => b.tokens.length - a.tokens.length);
  return { byFirstToken, negators, intensifiers };
}

const COMPILED = new Map<string, CompiledLexicon>();

/** `es`, `en`, `de`, `fr`, `pt` → su léxico; cualquier otro código → unión es + en. */
export function resolveDictionaryLanguage(language: string | null | undefined): DictionaryLanguage | "es+en" {
  const code = typeof language === "string" ? language.trim().toLowerCase().slice(0, 2) : "";
  return (DICTIONARY_LANGUAGES as readonly string[]).includes(code) ? (code as DictionaryLanguage) : "es+en";
}

function compiledFor(language: string | null | undefined): CompiledLexicon {
  const key = resolveDictionaryLanguage(language);
  const cached = COMPILED.get(key);
  if (cached) return cached;
  const compiled = key === "es+en" ? compile([ES, EN]) : compile([LEXICONS[key]]);
  COMPILED.set(key, compiled);
  return compiled;
}

// ---------------------------------------------------------------------------
// Análisis
// ---------------------------------------------------------------------------

type Hit = {
  category: ReviewCategory | null;
  polarity: Polarity;
  /** Polaridad tras aplicar la negación. */
  effective: Polarity;
  negated: boolean;
  intensified: boolean;
  position: number;
};

type ClauseMention = {
  category: ReviewCategory;
  sentiment: Polarity;
  confidence: number;
  snippet: string;
  strength: number;
};

const CONTRAST_WORDS = "pero|aunque|sin embargo|but|however|although|aber|jedoch|mais|cependant|mas|porém|porem|però";
const CONTRAST_SPLIT = new RegExp(`\\s+(?:${CONTRAST_WORDS})\\s+`, "i");
const LEADING_CONTRAST = new RegExp(`^(?:${CONTRAST_WORDS})\\s+`, "i");
/** Fin de oración (se conserva la puntuación en la cláusula), salto de línea, coma o punto y coma. */
const CLAUSE_BOUNDARY = /(?<=[.!?])\s+|\n+|,\s+|;\s*/;

/** Divide el texto en cláusulas (puntuación, comas y conjunciones adversativas); conserva el texto original. */
export function splitClauses(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(CLAUSE_BOUNDARY)) {
    for (const clause of sentence.split(CONTRAST_SPLIT)) {
      const trimmed = clause.trim().replace(LEADING_CONTRAST, "").trim();
      if (trimmed.length > 0 && /[\p{L}\p{N}]/u.test(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

function scanClause(tokens: string[], lexicon: CompiledLexicon): Hit[] {
  const hits: Hit[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] as string;
    const candidates = lexicon.byFirstToken.get(token);
    let matched: CompiledEntry | null = null;
    if (candidates) {
      for (const candidate of candidates) {
        let ok = true;
        for (let offset = 0; offset < candidate.tokens.length; offset += 1) {
          if (tokens[index + offset] !== candidate.tokens[offset]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          matched = candidate;
          break;
        }
      }
    }
    if (!matched) {
      index += 1;
      continue;
    }
    // Registrar TODAS las entradas de la misma longitud (una palabra puede ser
    // tema de una categoría y polaridad de otra).
    const sameLength = (candidates ?? []).filter((candidate) => candidate.tokens.length === matched?.tokens.length && candidate.tokens.every((entryToken, offset) => tokens[index + offset] === entryToken));
    let negated = false;
    for (let back = 1; back <= NEGATION_WINDOW; back += 1) {
      const previous = tokens[index - back];
      if (previous !== undefined && lexicon.negators.has(previous)) {
        negated = true;
        break;
      }
    }
    let intensified = false;
    for (let back = 1; back <= INTENSIFIER_WINDOW; back += 1) {
      const previous = tokens[index - back];
      if (previous !== undefined && lexicon.intensifiers.has(previous)) {
        intensified = true;
        break;
      }
    }
    for (const entry of sameLength) {
      const effective: Polarity = entry.polarity === 0 ? 0 : negated ? ((-entry.polarity) as Polarity) : entry.polarity;
      hits.push({ category: entry.category, polarity: entry.polarity, effective, negated, intensified, position: index });
    }
    index += matched.tokens.length;
  }
  return hits;
}

function confidenceFor(hitCount: number, intensified: boolean, mixed: boolean): number {
  let confidence = CONFIDENCE_BASE + CONFIDENCE_PER_EXTRA_HIT * Math.max(0, hitCount - 1);
  if (intensified) confidence += CONFIDENCE_INTENSIFIER;
  if (mixed) confidence -= CONFIDENCE_MIXED_PENALTY;
  return Math.min(CONFIDENCE_MAX, Math.round(confidence * 100) / 100);
}

function analyzeClause(clause: string, lexicon: CompiledLexicon): ClauseMention[] {
  const tokens = tokenizeForDictionary(clause);
  if (tokens.length === 0) return [];
  const hits = scanClause(tokens, lexicon);
  if (hits.length === 0) return [];
  const snippet = clause.length > SNIPPET_MAX_LENGTH ? `${clause.slice(0, SNIPPET_MAX_LENGTH - 1).trimEnd()}…` : clause;

  const generalHits = hits.filter((hit) => hit.category === null && hit.effective !== 0);
  const categories = new Set<ReviewCategory>();
  for (const hit of hits) if (hit.category) categories.add(hit.category);

  const out: ClauseMention[] = [];
  for (const category of categories) {
    const bound = hits.filter((hit) => hit.category === category && hit.effective !== 0);
    const polarHits = bound.length > 0 ? [...bound, ...generalHits] : generalHits;
    if (polarHits.length === 0) {
      out.push({ category, sentiment: 0, confidence: CONFIDENCE_TOPIC_ONLY, snippet, strength: 0 });
      continue;
    }
    const sum = polarHits.reduce((total, hit) => total + hit.effective, 0);
    const sentiment: Polarity = sum > 0 ? 1 : sum < 0 ? -1 : 0;
    const mixed = polarHits.some((hit) => hit.effective > 0) && polarHits.some((hit) => hit.effective < 0);
    const confidence = confidenceFor(polarHits.length, polarHits.some((hit) => hit.intensified), mixed);
    out.push({ category, sentiment, confidence, snippet, strength: Math.abs(sum) * confidence });
  }
  return out;
}

/**
 * Menciones por categoría con polaridad, confianza y snippet, fusionando las
 * cláusulas del texto (misma categoría → signo de la suma ponderada, confianza
 * máxima, snippet de la cláusula más fuerte). Orden: el de REVIEW_CATEGORIES.
 */
export function analyzeReviewDeterministic(text: string | null | undefined, language?: string | null): CategoryMention[] {
  if (typeof text !== "string" || !text.trim()) return [];
  const lexicon = compiledFor(language);
  const merged = new Map<ReviewCategory, { weighted: number; confidence: number; snippet: string; strength: number; hits: number }>();
  for (const clause of splitClauses(text)) {
    for (const mention of analyzeClause(clause, lexicon)) {
      const current = merged.get(mention.category);
      if (!current) {
        merged.set(mention.category, {
          weighted: mention.sentiment * mention.confidence,
          confidence: mention.confidence,
          snippet: mention.snippet,
          strength: mention.strength,
          hits: 1
        });
        continue;
      }
      current.weighted += mention.sentiment * mention.confidence;
      current.confidence = Math.max(current.confidence, mention.confidence);
      current.hits += 1;
      if (mention.strength > current.strength) {
        current.strength = mention.strength;
        current.snippet = mention.snippet;
      }
    }
  }
  const out: CategoryMention[] = [];
  for (const category of REVIEW_CATEGORIES) {
    const entry = merged.get(category);
    if (!entry) continue;
    const sentiment: Polarity = entry.weighted > 0.001 ? 1 : entry.weighted < -0.001 ? -1 : 0;
    out.push({
      category,
      sentiment,
      confidence: Math.round(entry.confidence * 100) / 100,
      snippet: entry.snippet,
      source: "dictionary"
    });
  }
  return out;
}

/**
 * Polaridad global a partir de las menciones: signo de Σ(sentimiento ×
 * confianza); `null` sin menciones; 0 en empate o cuando solo hay temas.
 */
export function polarityFromMentions(mentions: ReadonlyArray<Pick<CategoryMention, "sentiment" | "confidence">>): -1 | 0 | 1 | null {
  if (mentions.length === 0) return null;
  const sum = mentions.reduce((total, mention) => total + mention.sentiment * mention.confidence, 0);
  if (sum > 0.001) return 1;
  if (sum < -0.001) return -1;
  return 0;
}

// ---------------------------------------------------------------------------
// Subpuntuaciones de portal (Booking `scoring.*`): sin NLP, confianza 1
// ---------------------------------------------------------------------------

export type PortalSubscoreInput = {
  clean?: number | null;
  staff?: number | null;
  location?: number | null;
  value?: number | null;
  facilities?: number | null;
  comfort?: number | null;
  wifi?: number | null;
};

const SUBSCORE_CATEGORY: Readonly<Record<keyof PortalSubscoreInput, ReviewCategory>> = Object.freeze({
  clean: "limpieza",
  staff: "personal",
  location: "ubicacion",
  value: "precio_valor",
  facilities: "instalaciones",
  comfort: "habitacion",
  wifi: "wifi"
});

const SUBSCORE_ORDER: readonly (keyof PortalSubscoreInput)[] = Object.freeze(["clean", "staff", "location", "value", "facilities", "comfort", "wifi"]);

/**
 * Mapea subpuntuaciones del portal a menciones `portal_subscore` (confianza 1):
 * ≥ 8,5 sobre 10 → +1 · < 6,0 → −1 · entre ambos → 0. `scaleMax` por defecto 10.
 */
export function mapPortalSubscores(subscores: PortalSubscoreInput | null | undefined, scaleMax = 10): CategoryMention[] {
  if (!subscores || !Number.isFinite(scaleMax) || scaleMax <= 0) return [];
  const out: CategoryMention[] = [];
  for (const key of SUBSCORE_ORDER) {
    const raw = subscores[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const score10 = (Math.min(scaleMax, Math.max(0, raw)) / scaleMax) * 10;
    const sentiment: Polarity = score10 >= SCORE10_POSITIVE ? 1 : score10 < SCORE10_NEGATIVE ? -1 : 0;
    out.push({ category: SUBSCORE_CATEGORY[key], sentiment, confidence: 1, source: "portal_subscore" });
  }
  return out;
}

/** Fusiona menciones de varias fuentes: la de mayor confianza por categoría manda. */
export function mergeMentions(...groups: ReadonlyArray<ReadonlyArray<CategoryMention>>): CategoryMention[] {
  const best = new Map<ReviewCategory, CategoryMention>();
  for (const group of groups) {
    for (const mention of group) {
      const current = best.get(mention.category);
      if (!current || mention.confidence > current.confidence) best.set(mention.category, mention);
    }
  }
  return REVIEW_CATEGORIES.filter((category) => best.has(category)).map((category) => best.get(category) as CategoryMention);
}
