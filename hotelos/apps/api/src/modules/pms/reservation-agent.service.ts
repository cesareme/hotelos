// AI Booking Agent — turn a natural-language (typed or spoken) request into a
// structured reservation draft the receptionist can review and create.
//
// Honesty: the parse has a labelled source —
//   - "ai":    LLM extraction (only when a provider is configured).
//   - "rules": deterministic NL parsing (dates, occupancy, room type, name,
//              board). Works offline so the agent is useful without AI.
//   - "none":  couldn't understand the request — we say so, no guessing.

import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { isLlmConfigured, llmComplete } from "../../lib/llm.js";

export type ReservationDraft = {
  arrivalDate?: string;
  departureDate?: string;
  nights?: number;
  adults?: number;
  children?: number;
  roomTypeId?: string;
  roomTypeName?: string;
  boardType?: string;
  guestName?: string;
  email?: string;
  phone?: string;
  specialRequests?: string;
};

export type ReservationParseResult = {
  source: "ai" | "rules" | "none";
  modelVersion: string;
  confidence: number;
  message?: string;
  draft: ReservationDraft;
};

const ISO = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
function today(): Date {
  return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
}

const MONTHS: Record<string, number> = {
  jan: 0, ene: 0, enero: 0, january: 0,
  feb: 1, febrero: 1, february: 1,
  mar: 2, marzo: 2, march: 2,
  apr: 3, abr: 3, abril: 3, april: 3,
  may: 4, mayo: 4,
  jun: 5, junio: 5, june: 5,
  jul: 6, julio: 6, july: 6,
  aug: 7, ago: 7, agosto: 7, august: 7,
  sep: 8, sept: 8, septiembre: 8, september: 8,
  oct: 9, octubre: 9, october: 9,
  nov: 10, noviembre: 10, november: 10,
  dec: 11, dic: 11, diciembre: 11, december: 11
};
const WEEKDAYS: Record<string, number> = {
  sunday: 0, domingo: 0,
  monday: 1, lunes: 1,
  tuesday: 2, martes: 2,
  wednesday: 3, miercoles: 3, miércoles: 3,
  thursday: 4, jueves: 4,
  friday: 5, viernes: 5,
  saturday: 6, sabado: 6, sábado: 6
};

function yearFor(month: number, day: number, base: Date): number {
  // Choose the next occurrence of month/day (this year or next).
  const candidate = new Date(Date.UTC(base.getUTCFullYear(), month, day));
  return candidate.getTime() < base.getTime() ? base.getUTCFullYear() + 1 : base.getUTCFullYear();
}

/** Parse a single date token into a UTC date, or null. `base` = today. */
function parseDateToken(raw: string, base: Date): Date | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  if (/(^|\b)(today|tonight|hoy|esta noche)\b/.test(t)) return base;
  if (/(^|\b)(tomorrow|mañana|manana)\b/.test(t)) return addDays(base, 1);
  // next <weekday>
  const wd = t.match(/(?:next|el|este|el proximo|el próximo|próximo|proximo)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday|domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)/);
  if (wd) {
    const target = WEEKDAYS[wd[1]!.replace("é", "e").replace("á", "a")];
    if (target !== undefined) {
      let d = addDays(base, 1);
      for (let i = 0; i < 7 && d.getUTCDay() !== target; i++) d = addDays(d, 1);
      return d;
    }
  }
  // ISO YYYY-MM-DD
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`);
  // DD/MM or DD/MM/YYYY (also dot/dash separators)
  const dmy = t.match(/\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?\b/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]) - 1;
    const year = dmy[3] ? Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]) : yearFor(month, day, base);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) return new Date(Date.UTC(year, month, day));
  }
  // "june 10" or "10 june" / "10 de junio"
  const monthWord = t.match(/\b([a-záéíóú]+)\s*(?:de\s+)?(\d{1,2})\b/) || t.match(/\b(\d{1,2})\s*(?:de\s+|of\s+)?([a-záéíóú]+)\b/);
  if (monthWord) {
    const a = monthWord[1]!;
    const b = monthWord[2]!;
    const monthName = isNaN(Number(a)) ? a : b;
    const dayStr = isNaN(Number(a)) ? b : a;
    const month = MONTHS[monthName.slice(0, 4)] ?? MONTHS[monthName];
    const day = Number(dayStr);
    if (month !== undefined && day >= 1 && day <= 31) return new Date(Date.UTC(yearFor(month, day, base), month, day));
  }
  return null;
}

function parseDates(text: string, base: Date): { arrival?: Date; departure?: Date; nights?: number } {
  const nightsMatch = text.match(/(\d+)\s*(nights?|noches?|días?|days?)/i);
  const nights = nightsMatch ? Number(nightsMatch[1]) : undefined;

  // Range patterns first. Spanish requires the literal contraction "al" (not a
  // bare "a") so we don't capture "de María … a nombre".
  const range =
    text.match(/from\s+(.+?)\s+(?:to|until|till|through)\s+(.+?)(?:[.,;]|$)/i) ||
    text.match(/\b(?:del|de)\s+(.+?)\s+al\s+(.+?)(?:[.,;]|$)/i) ||
    text.match(/between\s+(.+?)\s+and\s+(.+?)(?:[.,;]|$)/i) ||
    text.match(/\bentre\s+(.+?)\s+y\s+(.+?)(?:[.,;]|$)/i);
  if (range) {
    let a = parseDateToken(range[1]!, base);
    const b = parseDateToken(range[2]!, base);
    // "del 10 al 14 de julio" — month/year only on the second date.
    if (!a && b) {
      const bareDay = range[1]!.trim().match(/^(\d{1,2})$/);
      if (bareDay) a = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), Number(bareDay[1])));
    }
    if (a && b && b.getTime() > a.getTime()) {
      return { arrival: a, departure: b, nights: Math.round((b.getTime() - a.getTime()) / 86_400_000) };
    }
    if (a) return { arrival: a, departure: nights ? addDays(a, nights) : undefined, nights };
  }

  // Single anchor date ("from X", "on X", "arriving X", "el X") + nights.
  const anchor =
    text.match(/(?:from|on|arriving|arrive|check[- ]?in|llegada|el|desde)\s+(.+?)(?:\s+for\s+|\s+por\s+|[.,;]|$)/i);
  let arrival: Date | undefined;
  if (anchor) arrival = parseDateToken(anchor[1]!, base) ?? undefined;
  if (!arrival) {
    // Fall back to the first parseable date-ish chunk in the text.
    for (const chunk of text.split(/[\s,;]+/)) {
      const d = parseDateToken(chunk, base);
      if (d) { arrival = d; break; }
    }
    // Multi-word relative ("next friday", "10 june") needs a windowed scan.
    if (!arrival) {
      const words = text.split(/\s+/);
      for (let i = 0; i < words.length - 1; i++) {
        const d = parseDateToken(`${words[i]} ${words[i + 1]}`, base);
        if (d) { arrival = d; break; }
      }
    }
  }

  if (arrival && nights) return { arrival, departure: addDays(arrival, nights), nights };
  if (arrival) return { arrival, departure: addDays(arrival, 1), nights: 1 };
  if (nights) return { arrival: base, departure: addDays(base, nights), nights };
  return {};
}

function parseOccupancy(text: string): { adults?: number; children?: number } {
  const t = text.toLowerCase();
  let adults: number | undefined;
  let children: number | undefined;
  const adultsM = t.match(/(\d+)\s*(adults?|adultos?|pax|persons?|personas?|gu?ests?|hu[eé]spedes?)/);
  if (adultsM) adults = Number(adultsM[1]);
  const childrenM = t.match(/(\d+)\s*(child(?:ren)?|kids?|ni[ñn]os?|menores?)/);
  if (childrenM) children = Number(childrenM[1]);
  if (adults === undefined) {
    if (/\b(couple|pareja|two people|dos personas)\b/.test(t)) adults = 2;
    else if (/\b(solo|single guest|una persona|individual)\b/.test(t)) adults = 1;
    else {
      const forN = t.match(/\bfor\s+(\d+)\b/) || t.match(/\bpara\s+(\d+)\b/);
      if (forN) adults = Number(forN[1]);
    }
  }
  return { adults, children };
}

function parseBoard(text: string): string | undefined {
  const t = text.toLowerCase();
  if (/\b(all[- ]?inclusive|todo incluido)\b/.test(t)) return "AI";
  if (/\b(full board|pensi[oó]n completa)\b/.test(t)) return "FB";
  if (/\b(half board|media pensi[oó]n)\b/.test(t)) return "HB";
  if (/\b(breakfast|desayuno|bed and breakfast|b&b|bb)\b/.test(t)) return "BB";
  if (/\b(room only|solo alojamiento|sin desayuno)\b/.test(t)) return "RO";
  return undefined;
}

function parseGuestName(text: string): string | undefined {
  const m =
    text.match(/(?:under|for|name(?:d)?(?: is)?|guest(?: is)?)\s+(?:the name of\s+|mr\.?\s+|ms\.?\s+|mrs\.?\s+)?([A-ZÁÉÍÓÚÑ][\p{L}'-]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}'-]+){0,2})/u) ||
    text.match(/(?:a nombre de|para|reserva de|cliente)\s+([A-ZÁÉÍÓÚÑ][\p{L}'-]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}'-]+){0,2})/u);
  if (!m) return undefined;
  const name = m[1]!.trim();
  // Reject obvious non-names (room/board keywords captured by accident).
  if (/^(a|the|double|single|suite|adults?|nights?|room)$/i.test(name)) return undefined;
  return name;
}

function parseContact(text: string): { email?: string; phone?: string } {
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
  const phone = text.match(/(\+?\d[\d\s().-]{7,}\d)/)?.[0]?.replace(/[^\d+]/g, "");
  return { email, phone };
}

// Cross-language synonym groups so e.g. Spanish "Doble" matches an English
// "Double" room type (and vice versa).
const ROOM_TYPE_SYNONYMS: string[][] = [
  ["double", "doble"],
  ["single", "individual", "sencilla"],
  ["twin"],
  ["triple"],
  ["suite"],
  ["junior"],
  ["family", "familiar"],
  ["apartment", "apartamento", "studio", "estudio"],
  ["deluxe"],
  ["superior"],
  ["standard", "estandar", "estándar"]
];

function matchRoomType(text: string, roomTypes: Array<{ id: string; name: string }>): { id?: string; name?: string } {
  const t = text.toLowerCase();
  // Exact-ish name match first.
  for (const rt of roomTypes) {
    if (t.includes(rt.name.toLowerCase())) return { id: rt.id, name: rt.name };
  }
  // Synonym group match — a term in the request and any synonym in a type name.
  for (const group of ROOM_TYPE_SYNONYMS) {
    if (group.some((term) => t.includes(term))) {
      const hit = roomTypes.find((rt) => group.some((term) => rt.name.toLowerCase().includes(term)));
      if (hit) return { id: hit.id, name: hit.name };
    }
  }
  return {};
}

const AI_SYSTEM = `You are a hotel booking assistant. Extract a reservation from the user's request and return ONLY JSON:
{"arrivalDate":"YYYY-MM-DD","departureDate":"YYYY-MM-DD","adults":2,"children":0,"roomTypeName":"Double","boardType":"BB","guestName":"Jane Doe","email":"","phone":"","specialRequests":""}
boardType is one of RO,BB,HB,FB,AI. Omit unknown fields. Today is ${ISO(today())}. Return strictly valid JSON, no prose.`;

async function parseWithAi(text: string, roomTypes: Array<{ id: string; name: string }>): Promise<ReservationParseResult | null> {
  const result = await llmComplete({ system: AI_SYSTEM, prompt: text.slice(0, 2000), maxTokens: 400, temperature: 0.1 });
  if (!result.configured) return null;
  try {
    const s = result.text.indexOf("{");
    const e = result.text.lastIndexOf("}");
    if (s < 0 || e < 0) return null;
    const j = JSON.parse(result.text.slice(s, e + 1)) as ReservationDraft;
    const rt = j.roomTypeName ? matchRoomType(j.roomTypeName, roomTypes) : {};
    const draft: ReservationDraft = {
      ...j,
      roomTypeId: rt.id,
      roomTypeName: rt.name ?? j.roomTypeName,
      nights: j.arrivalDate && j.departureDate
        ? Math.max(1, Math.round((Date.parse(j.departureDate) - Date.parse(j.arrivalDate)) / 86_400_000))
        : j.nights
    };
    if (!draft.arrivalDate && !draft.adults && !draft.guestName) return null;
    return { source: "ai", modelVersion: `ai-${result.model}`, confidence: 0.85, draft };
  } catch {
    return null;
  }
}

export async function parseReservationRequest(input: {
  context: UserContext;
  propertyId: string;
  text: string;
}): Promise<ReservationParseResult> {
  requirePermissions(input.context, ["pms.reservation.read"]);
  const text = (input.text ?? "").trim();
  const roomTypes = await prisma.roomType.findMany({
    where: { propertyId: input.propertyId, active: true },
    select: { id: true, name: true }
  });

  if (!text) {
    return { source: "none", modelVersion: "none", confidence: 0, message: "Say or type a request, e.g. \"double room for 2 adults, 3 nights from next Friday, under María García\".", draft: {} };
  }

  // 1) AI when configured.
  if (isLlmConfigured()) {
    const ai = await parseWithAi(text, roomTypes);
    if (ai) return ai;
  }

  // 2) Deterministic NL parse.
  const base = today();
  const { arrival, departure, nights } = parseDates(text, base);
  const { adults, children } = parseOccupancy(text);
  const board = parseBoard(text);
  const name = parseGuestName(text);
  const { email, phone } = parseContact(text);
  const rt = matchRoomType(text, roomTypes);

  const draft: ReservationDraft = {
    arrivalDate: arrival ? ISO(arrival) : undefined,
    departureDate: departure ? ISO(departure) : undefined,
    nights,
    adults,
    children,
    roomTypeId: rt.id,
    roomTypeName: rt.name,
    boardType: board,
    guestName: name,
    email,
    phone
  };

  const found = [draft.arrivalDate, draft.adults, draft.roomTypeId, draft.guestName].filter(Boolean).length;
  if (found === 0) {
    return {
      source: "none",
      modelVersion: "agent-rules-v1",
      confidence: 0,
      message: "Couldn't understand the request. Try including dates, number of guests and room type — e.g. \"suite for 2, 2 nights from 12/06\".",
      draft
    };
  }
  return { source: "rules", modelVersion: "agent-rules-v1", confidence: Math.min(0.5 + found * 0.12, 0.9), draft };
}
