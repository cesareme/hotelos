// Tanda CHK (lote W1-C) · Motor PURO de asignación explicable — diseño §4b
// (docs/design/CHECKIN-AUTOMATIZADO-IA.md).
//
// `suggestRooms(input)` no toca Prisma. El lector `room-assignment.service.ts`
// (lote posterior) carga habitaciones, reservas solapadas, órdenes de trabajo,
// bloqueos de fechas, habitaciones comunicadas, estancias previas, preferencias y
// demanda por tipo, y persiste `AssignmentSuggestion`. Dos fases:
//   A · filtros duros → `rejected[{ roomId, number, reason }]` (motivo en español);
//   B · puntuación con pesos por defecto (`DEFAULT_ASSIGNMENT_WEIGHTS`)
//       sobrescribibles por `policy.weights` → `candidates` (top-3) con
//       `reasons[{ rule, weight, detail }]` y `warnings`.
// Invariantes: `score === Σ reasons.weight`; ningún motivo se inventa sobre datos
// ausentes (van a `dataNotes`); salida determinista (empates por número de
// habitación). La ETA (`etaHHMM`) se interpreta en UTC sobre `arrivalDate`, como el
// badge `hk_urgent` del rack (dashboards/room-rack.service.ts · getUTCHours).
// El motor NO notifica a pisos: las sucias descartadas por llegada ≤ 2 h salen en
// `housekeepingAlerts` para que el servicio cree la tarea / el aviso.
//
// Vocabulario de preferencias y DTOs de candidata: `@hotelos/shared`
// (packages/shared/src/checkin-types.ts, lote W1-A); aquí solo se estrechan
// `rule` (unión cerrada) y `source` ("rules": este motor no llama a la IA).

import {
  PREFERENCE_VOCABULARY,
  type AssignmentCandidate as SharedAssignmentCandidate,
  type AssignmentReason as SharedAssignmentReason,
  type AssignmentSource,
  type GuestPreferenceCode
} from "@hotelos/shared";
import { roomStateOf } from "../housekeeping/room-state.service.js";

// ---------------------------------------------------------------------------
// Vocabulario y pesos
// ---------------------------------------------------------------------------

export { PREFERENCE_VOCABULARY };
export type PreferenceKey = GuestPreferenceCode;

export const ASSIGNMENT_RULES = [
  "hk_inspected",
  "hk_clean",
  "preference",
  "vip",
  "returning",
  "group",
  "inventory_protection",
  "rotation",
  "free_upgrade",
  "special_request"
] as const;
export type AssignmentRule = (typeof ASSIGNMENT_RULES)[number];
/** Claves de peso: cada regla más el tope acumulado de preferencias. */
export type AssignmentWeightKey = AssignmentRule | "preference_cap";

export const DEFAULT_ASSIGNMENT_WEIGHTS: Readonly<Record<AssignmentWeightKey, number>> = Object.freeze({
  hk_inspected: 30,
  hk_clean: 20,
  preference: 15,
  preference_cap: 45,
  vip: 25,
  returning: 20,
  group: 15,
  inventory_protection: -20,
  rotation: 5,
  free_upgrade: -10,
  special_request: 0
});

export const ASSIGNMENT_RULES_VERSION = "chk-rules-1" as const;

/** Sucia con llegada a ≤ N h → descartada (aviso a pisos). */
export const DIRTY_DISCARD_HOURS = 2;
/** Sucia con llegada a ≤ N h (y > DIRTY_DISCARD_HOURS) → se mantiene con aviso fuerte. */
export const DIRTY_WARN_HOURS = 4;

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export type AssignmentReservationInput = {
  id: string;
  roomTypeId: string | null;
  /** `YYYY-MM-DD` (o Date; se usa solo el día). */
  arrivalDate: string | Date;
  departureDate: string | Date;
  adults: number;
  children: number;
  vipFlag: boolean;
  accessibilityNeeds?: string | null;
  groupCode?: string | null;
  groupBookingId?: string | null;
  specialRequests?: string | null;
  /** Hora prevista de llegada `HH:MM` (UTC sobre `arrivalDate`). */
  etaHHMM?: string | null;
};

export type AssignmentGuestInput = {
  id: string;
  vipCode?: string | null;
  loyaltyTier?: string | null;
  /** Vocabulario `PREFERENCE_VOCABULARY` (los valores fuera de él se anotan y no puntúan). */
  preferences: string[];
  lastStayRoomId?: string | null;
  /** Estancias por habitación en los últimos 30 días (rotación). */
  stays30dByRoomId?: Record<string, number>;
};

export type AssignmentRoomInput = {
  id: string;
  number: string;
  roomTypeId: string;
  floor?: string | null;
  floorId?: string | null;
  viewType?: string | null;
  maxOccupancy?: number | null;
  bedConfigurationJson: unknown;
  featuresJson: unknown;
  accessibilityJson: unknown;
  status: string;
  housekeepingStatus: string | null | undefined;
  maintenanceStatus: string | null | undefined;
  sellable: boolean;
  active: boolean;
};

export type AssignmentRoomTypeInput = { id: string; displayOrder?: number | null; maxOccupancy?: number | null };
export type AssignmentOverlappingReservation = { id: string; assignedRoomId: string | null; status: string };
export type AssignmentRoomBlock = { roomId: string; fromDate: string | Date; toDate: string | Date };
export type AssignmentRoomConnection = { roomAId: string; roomBId: string; kind: string };
export type AssignmentGroupRoom = { roomId: string; floor?: string | null };
export type AssignmentDemandByType = Record<string, { available: number; pendingArrivals: number }>;

export type AssignmentPolicy = {
  allowUpgrade: boolean;
  requireInspectedRoom: boolean;
  weights: Partial<Record<AssignmentWeightKey, number>>;
};

export type AssignmentSuggestionInput = {
  reservation: AssignmentReservationInput;
  guest?: AssignmentGuestInput | null;
  rooms: AssignmentRoomInput[];
  roomTypes: AssignmentRoomTypeInput[];
  /** Reservas que solapan [arrival, departure) de la reserva (ya filtradas por el lector). */
  overlappingReservations: AssignmentOverlappingReservation[];
  openWorkOrderRoomIds: string[];
  roomBlocks: AssignmentRoomBlock[];
  roomConnections: AssignmentRoomConnection[];
  /** Habitaciones ya asignadas al mismo grupo (`groupCode` / `groupBookingId`). */
  groupAssignedRooms: AssignmentGroupRoom[];
  demandByRoomType?: AssignmentDemandByType;
  policy: AssignmentPolicy;
  now: Date;
};

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

/** `@hotelos/shared` AssignmentReason con `rule` cerrada a las reglas del motor. */
export type AssignmentReason = SharedAssignmentReason & { rule: AssignmentRule };
/** `@hotelos/shared` AssignmentCandidate con motivos tipados. */
export type AssignmentCandidate = Omit<SharedAssignmentCandidate, "reasons"> & { reasons: AssignmentReason[] };
export type AssignmentRejection = { roomId: string; number: string; reason: string };
export type AssignmentHousekeepingAlert = { roomId: string; number: string; etaHHMM: string };

export type AssignmentSuggestionResult = {
  /** Top-3 por puntuación (desempate por número de habitación). */
  candidates: AssignmentCandidate[];
  rejected: AssignmentRejection[];
  /** clamp((score₁ − score₂) / max(score₁, 1), 0, 1); 0 con empate o una sola candidata. */
  confidence: number;
  rulesVersion: typeof ASSIGNMENT_RULES_VERSION;
  source: Extract<AssignmentSource, "rules">;
  /** Datos ausentes que impidieron evaluar reglas (nunca se inventan motivos). */
  dataNotes: string[];
  /** Sucias descartadas por llegada ≤ 2 h: el servicio avisa a pisos. */
  housekeepingAlerts: AssignmentHousekeepingAlert[];
};

// ---------------------------------------------------------------------------
// Helpers puros (exportados para tests y para el lector)
// ---------------------------------------------------------------------------

export function dateKey(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** Número de planta a partir de `Room.floor` («3», «Planta 3», «-1», «PB»/«Baja» → 0); null si no se puede leer. */
export function parseFloorNumber(floor: string | null | undefined): number | null {
  if (floor === null || floor === undefined) return null;
  const text = String(floor).trim();
  if (text === "") return null;
  if (/^(pb|baja|planta baja|bajo)$/i.test(text)) return 0;
  const match = text.match(/-?\d+/);
  if (!match) return null;
  const n = Number.parseInt(match[0], 10);
  return Number.isFinite(n) ? n : null;
}

/** `featuresJson` como conjunto de claves: objeto `{clave: true}`, array de strings o string separada por comas. */
export function featureKeys(featuresJson: unknown): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(featuresJson)) {
    for (const item of featuresJson) if (typeof item === "string" && item.trim()) out.add(item.trim().toLowerCase());
    return out;
  }
  if (typeof featuresJson === "string") {
    for (const item of featuresJson.split(",")) if (item.trim()) out.add(item.trim().toLowerCase());
    return out;
  }
  if (featuresJson && typeof featuresJson === "object") {
    for (const [key, value] of Object.entries(featuresJson as Record<string, unknown>)) {
      if (value === true || value === 1 || value === "true" || value === "yes" || value === "si" || value === "sí") out.add(key.trim().toLowerCase());
    }
  }
  return out;
}

export function isAccessibleRoom(room: Pick<AssignmentRoomInput, "accessibilityJson" | "featuresJson">): boolean {
  const acc = room.accessibilityJson;
  if (acc && typeof acc === "object" && !Array.isArray(acc) && (acc as Record<string, unknown>).accessible === true) return true;
  return featureKeys(room.featuresJson).has("accessible");
}

/** Misma regla que el rack (dashboards/room-rack.service.ts · `vip`), más `Reservation.vipFlag`. */
export function isVipForAssignment(reservation: Pick<AssignmentReservationInput, "vipFlag">, guest?: AssignmentGuestInput | null): boolean {
  if (reservation.vipFlag) return true;
  if (!guest) return false;
  return Boolean(guest.vipCode || (guest.loyaltyTier && /platinum|gold|diamond/i.test(guest.loyaltyTier)));
}

type ViewKind = "sea" | "city" | "other" | "none";

export function viewKindOf(viewType: string | null | undefined): ViewKind {
  if (!viewType || !String(viewType).trim()) return "none";
  const text = String(viewType);
  if (/\b(sea|mar|ocean|oc[eé]ano|playa|beach)\b/i.test(text)) return "sea";
  if (/\b(city|ciudad|urban[ao]?|calle|street)\b/i.test(text)) return "city";
  return "other";
}

function jsonText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.toLowerCase();
  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return "";
  }
}

export function bedMatches(bedConfigurationJson: unknown, kind: "twin" | "king"): boolean {
  const text = jsonText(bedConfigurationJson);
  if (!text || text === "{}" || text === "[]") return false;
  return kind === "twin" ? /twin|separad|dos camas|2 camas/.test(text) : /king/.test(text);
}

function hasBedData(bedConfigurationJson: unknown): boolean {
  const text = jsonText(bedConfigurationJson);
  return text !== "" && text !== "{}" && text !== "[]" && text !== "null";
}

/** Horas desde `now` hasta la ETA (UTC sobre `arrivalDate`); null si la ETA no es `HH:MM`. */
export function hoursUntilEta(now: Date, arrivalDate: string | Date, etaHHMM: string | null | undefined): number | null {
  if (!etaHHMM) return null;
  const eta = String(etaHHMM).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!eta) return null;
  const day = dateKey(arrivalDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!day) return null;
  const hh = Number(eta[1]);
  const mm = Number(eta[2]);
  if (hh > 23 || mm > 59) return null;
  const at = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), hh, mm);
  return (at - now.getTime()) / 3_600_000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function compareRoomNumbers(a: string, b: string): number {
  return a.localeCompare(b, "es", { numeric: true, sensitivity: "base" });
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

const PREFERENCE_LABELS: Record<PreferenceKey, string> = {
  floor_high: "Planta alta como pidió",
  floor_low: "Planta baja como pidió",
  quiet: "Habitación tranquila como pidió",
  near_elevator: "Cerca del ascensor como pidió",
  far_elevator: "Lejos del ascensor como pidió",
  view_sea: "Vista al mar como pidió",
  view_city: "Vista a la ciudad como pidió",
  bed_twin: "Camas separadas como pidió",
  bed_king: "Cama king como pidió",
  accessible: "Accesible como pidió",
  connecting: "Comunicada con una habitación libre como pidió",
  crib: "Cuna disponible como pidió"
};

const FEATURE_PREFERENCES: ReadonlySet<PreferenceKey> = new Set<PreferenceKey>(["quiet", "near_elevator", "far_elevator", "crib"]);

function isPreferenceKey(value: string): value is PreferenceKey {
  return (PREFERENCE_VOCABULARY as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Motor
// ---------------------------------------------------------------------------

type TypeRelation = "same" | "upgrade";

type Eligible = {
  room: AssignmentRoomInput;
  relation: TypeRelation;
  cleanliness: "dirty" | "clean" | "inspected";
  etaHours: number | null;
};

export function suggestRooms(input: AssignmentSuggestionInput): AssignmentSuggestionResult {
  const { reservation, guest, policy } = input;
  const weights: Record<AssignmentWeightKey, number> = { ...DEFAULT_ASSIGNMENT_WEIGHTS, ...stripUndefined(policy.weights) };
  const notes = new Set<string>();
  const rejected: AssignmentRejection[] = [];
  const housekeepingAlerts: AssignmentHousekeepingAlert[] = [];

  const arrival = dateKey(reservation.arrivalDate);
  const departure = dateKey(reservation.departureDate);
  const pax = Math.max(0, Number(reservation.adults) || 0) + Math.max(0, Number(reservation.children) || 0);
  const roomTypeById = new Map(input.roomTypes.map((t) => [t.id, t]));
  const openWorkOrders = new Set(input.openWorkOrderRoomIds);
  const takenRoomIds = new Set<string>();
  for (const other of input.overlappingReservations) {
    if (other.id === reservation.id || !other.assignedRoomId) continue;
    if (other.status === "confirmed" || other.status === "checked_in") takenRoomIds.add(other.assignedRoomId);
  }
  const blocksByRoom = new Map<string, AssignmentRoomBlock[]>();
  for (const block of input.roomBlocks) {
    const list = blocksByRoom.get(block.roomId) ?? [];
    list.push(block);
    blocksByRoom.set(block.roomId, list);
  }
  const etaHours = hoursUntilEta(input.now, reservation.arrivalDate, reservation.etaHHMM);

  // ---- Fase A · disponibilidad (común a la reserva y a la pareja comunicada)
  const availabilityRejection = (room: AssignmentRoomInput): string | null => {
    if (!room.active) return "Habitación inactiva";
    // blocked ⇒ sellable=false (invariante L5): el motivo más informativo primero.
    if (room.maintenanceStatus === "blocked") return "Bloqueada por mantenimiento";
    if (!room.sellable) return "No vendible";
    const state = roomStateOf(room);
    if (state.occupancy === "occupied") return "Ocupada";
    if (state.occupancy === "out_of_order") return "Fuera de orden (out_of_order)";
    if (state.occupancy === "out_of_service") return "Fuera de servicio (out_of_service)";
    if (openWorkOrders.has(room.id)) return "Orden de trabajo abierta";
    const block = (blocksByRoom.get(room.id) ?? []).find((b) => dateKey(b.fromDate) < departure && dateKey(b.toDate) >= arrival);
    if (block) return `Bloqueada del ${dateKey(block.fromDate)} al ${dateKey(block.toDate)}`;
    if (takenRoomIds.has(room.id)) return "Asignada a otra reserva solapada";
    return null;
  };

  const reservationType = reservation.roomTypeId ? roomTypeById.get(reservation.roomTypeId) : undefined;
  if (!reservation.roomTypeId) notes.add("la reserva no tiene tipo de habitación: no se filtra por tipo");

  const typeRelation = (room: AssignmentRoomInput): { relation: TypeRelation } | { reject: string } => {
    if (!reservation.roomTypeId || room.roomTypeId === reservation.roomTypeId) return { relation: "same" };
    const roomType = roomTypeById.get(room.roomTypeId);
    const roomOrder = roomType?.displayOrder;
    const wantedOrder = reservationType?.displayOrder;
    if (roomOrder === null || roomOrder === undefined || wantedOrder === null || wantedOrder === undefined) {
      return { reject: "Tipo distinto sin categoría comparable (displayOrder)" };
    }
    if (roomOrder > wantedOrder) {
      return policy.allowUpgrade ? { relation: "upgrade" } : { reject: "Tipo superior (la política no permite mejora)" };
    }
    return { reject: "Tipo inferior o distinto de la misma categoría" };
  };

  const eligible: Eligible[] = [];
  let dirtyEvaluated = false;
  for (const room of input.rooms) {
    const unavailable = availabilityRejection(room);
    if (unavailable) {
      rejected.push({ roomId: room.id, number: room.number, reason: unavailable });
      continue;
    }
    const typed = typeRelation(room);
    if ("reject" in typed) {
      rejected.push({ roomId: room.id, number: room.number, reason: typed.reject });
      continue;
    }
    const capacity = room.maxOccupancy ?? roomTypeById.get(room.roomTypeId)?.maxOccupancy ?? 2;
    if (capacity < pax) {
      rejected.push({ roomId: room.id, number: room.number, reason: `Capacidad ${capacity} para ${pax} personas` });
      continue;
    }
    if (reservation.accessibilityNeeds && String(reservation.accessibilityNeeds).trim() && !isAccessibleRoom(room)) {
      rejected.push({ roomId: room.id, number: room.number, reason: "No accesible (la reserva lo requiere)" });
      continue;
    }
    const cleanliness = roomStateOf(room).cleanliness;
    if (policy.requireInspectedRoom && cleanliness !== "inspected") {
      rejected.push({ roomId: room.id, number: room.number, reason: `La política exige habitación inspeccionada (estado: ${cleanlinessLabel(cleanliness)})` });
      continue;
    }
    if (cleanliness === "dirty") {
      dirtyEvaluated = true;
      if (etaHours !== null && etaHours <= DIRTY_DISCARD_HOURS) {
        const eta = String(reservation.etaHHMM);
        rejected.push({ roomId: room.id, number: room.number, reason: `Sucia con llegada a las ${eta} (≤ ${DIRTY_DISCARD_HOURS} h): descartada, aviso a pisos` });
        housekeepingAlerts.push({ roomId: room.id, number: room.number, etaHHMM: eta });
        continue;
      }
    }
    eligible.push({ room, relation: typed.relation, cleanliness, etaHours });
  }
  if (dirtyEvaluated && etaHours === null) notes.add("sin hora de llegada (ETA): las sucias no se descartan por urgencia");

  // Mejora solo cuando no queda ninguna del tipo reservado.
  const sameTypeCount = eligible.filter((e) => e.relation === "same").length;
  const pool: Eligible[] = [];
  for (const entry of eligible) {
    if (entry.relation === "upgrade" && sameTypeCount > 0) {
      rejected.push({ roomId: entry.room.id, number: entry.room.number, reason: "Tipo superior: quedan habitaciones del tipo reservado" });
      continue;
    }
    pool.push(entry);
  }

  // ---- Datos transversales de fase B
  const floorsAll = input.rooms.filter((r) => r.active).map((r) => parseFloorNumber(r.floor)).filter((n): n is number => n !== null);
  const floorMedian = median(floorsAll);
  const anyView = input.rooms.some((r) => viewKindOf(r.viewType) !== "none");
  const anyFeatures = input.rooms.some((r) => featureKeys(r.featuresJson).size > 0);
  const anyBeds = input.rooms.some((r) => hasBedData(r.bedConfigurationJson));
  const roomById = new Map(input.rooms.map((r) => [r.id, r]));
  const freeForConnection = (roomId: string): boolean => {
    const room = roomById.get(roomId);
    return Boolean(room && availabilityRejection(room) === null);
  };
  const connectingPartners = (roomId: string): string[] =>
    input.roomConnections
      .filter((c) => c.kind === "connecting" && (c.roomAId === roomId || c.roomBId === roomId))
      .map((c) => (c.roomAId === roomId ? c.roomBId : c.roomAId));

  const preferences: PreferenceKey[] = [];
  if (!guest) {
    notes.add("sin datos del huésped (VIP por código, recurrencia y preferencias no evaluados)");
  } else {
    const seen = new Set<string>();
    for (const raw of guest.preferences ?? []) {
      const key = String(raw).trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (isPreferenceKey(key)) preferences.push(key);
      else notes.add(`preferencia no reconocida: ${key}`);
    }
    if (preferences.length === 0) notes.add("sin preferencias registradas");
  }
  if (preferences.some((p) => p === "view_sea" || p === "view_city") && !anyView) notes.add("sin datos de vista en las habitaciones");
  if (preferences.some((p) => p === "floor_high" || p === "floor_low") && floorMedian === null) notes.add("sin datos de planta en las habitaciones");
  if (preferences.some((p) => FEATURE_PREFERENCES.has(p)) && !anyFeatures) notes.add("sin datos de características en las habitaciones");
  if (preferences.some((p) => p === "bed_twin" || p === "bed_king") && !anyBeds) notes.add("sin datos de camas en las habitaciones");
  if (preferences.includes("connecting") && input.roomConnections.length === 0) notes.add("sin datos de habitaciones comunicadas");

  const satisfies = (room: AssignmentRoomInput, pref: PreferenceKey): boolean => {
    switch (pref) {
      case "floor_high": {
        const n = parseFloorNumber(room.floor);
        return floorMedian !== null && n !== null && n >= floorMedian;
      }
      case "floor_low": {
        const n = parseFloorNumber(room.floor);
        return floorMedian !== null && n !== null && n <= floorMedian;
      }
      case "quiet":
      case "near_elevator":
      case "far_elevator":
      case "crib":
        return featureKeys(room.featuresJson).has(pref);
      case "view_sea":
        return viewKindOf(room.viewType) === "sea";
      case "view_city":
        return viewKindOf(room.viewType) === "city";
      case "bed_twin":
        return bedMatches(room.bedConfigurationJson, "twin");
      case "bed_king":
        return bedMatches(room.bedConfigurationJson, "king");
      case "accessible":
        return isAccessibleRoom(room);
      case "connecting":
        return connectingPartners(room.id).some(freeForConnection);
      default:
        return false;
    }
  };

  // VIP: mejor (vista, planta) entre las del pool; solo si hay diferenciación.
  const vip = isVipForAssignment(reservation, guest);
  const vipBest = new Set<string>();
  if (vip && pool.length > 0) {
    const rank = (room: AssignmentRoomInput): [number, number] => {
      const view = viewKindOf(room.viewType);
      const viewRank = view === "sea" ? 2 : view === "none" ? 0 : 1;
      return [viewRank, parseFloorNumber(room.floor) ?? Number.NEGATIVE_INFINITY];
    };
    const ranks = pool.map((e) => ({ id: e.room.id, rank: rank(e.room) }));
    const hasData = ranks.some((r) => r.rank[0] > 0 || Number.isFinite(r.rank[1]));
    if (!hasData) {
      notes.add("VIP sin datos de vista ni planta: no se puntúa la mejor habitación");
    } else {
      let best: [number, number] = [-1, Number.NEGATIVE_INFINITY];
      for (const r of ranks) if (r.rank[0] > best[0] || (r.rank[0] === best[0] && r.rank[1] > best[1])) best = r.rank;
      const winners = ranks.filter((r) => r.rank[0] === best[0] && r.rank[1] === best[1]);
      if (winners.length === ranks.length && ranks.length > 1) notes.add("VIP: todas las candidatas comparten vista y planta");
      else for (const w of winners) vipBest.add(w.id);
    }
  }

  // Recurrente y rotación
  if (guest && (guest.lastStayRoomId === undefined || guest.lastStayRoomId === null)) notes.add("sin habitación de estancia previa");
  const rotationWinners = new Set<string>();
  if (guest && !guest.stays30dByRoomId) {
    notes.add("sin datos de rotación (estancias en 30 días)");
  } else if (guest?.stays30dByRoomId && pool.length > 1) {
    const counts = pool.map((e) => ({ id: e.room.id, n: guest.stays30dByRoomId?.[e.room.id] ?? 0 }));
    const min = Math.min(...counts.map((c) => c.n));
    const max = Math.max(...counts.map((c) => c.n));
    if (min !== max) for (const c of counts) if (c.n === min) rotationWinners.add(c.id);
  }

  // Grupo
  const isGroup = Boolean((reservation.groupCode && String(reservation.groupCode).trim()) || reservation.groupBookingId);
  const groupFloors = new Set<number>();
  if (isGroup) {
    if (input.groupAssignedRooms.length === 0) notes.add("grupo sin habitaciones asignadas todavía");
    for (const g of input.groupAssignedRooms) {
      const n = parseFloorNumber(g.floor ?? roomById.get(g.roomId)?.floor);
      if (n !== null) groupFloors.add(n);
    }
    if (input.groupAssignedRooms.length > 0 && groupFloors.size === 0) notes.add("sin datos de planta de las habitaciones del grupo");
  }

  // Protección de inventario
  if (!input.demandByRoomType) notes.add("sin datos de demanda por tipo: no se aplica la protección de inventario");

  const specialRequest = reservation.specialRequests ? String(reservation.specialRequests).trim() : "";
  const specialDetail = specialRequest ? `Pidió: ${specialRequest.length > 120 ? `${specialRequest.slice(0, 117)}…` : specialRequest}` : null;

  // ---- Fase B · puntuación
  const candidates: AssignmentCandidate[] = pool.map((entry) => {
    const { room } = entry;
    const reasons: AssignmentReason[] = [];
    const warnings: string[] = [];

    if (entry.cleanliness === "inspected") reasons.push({ rule: "hk_inspected", weight: weights.hk_inspected, detail: "Inspeccionada" });
    else if (entry.cleanliness === "clean") reasons.push({ rule: "hk_clean", weight: weights.hk_clean, detail: "Limpia" });
    else if (entry.etaHours === null) warnings.push("Sucia: sin hora de llegada, avisar a pisos");
    else if (entry.etaHours <= DIRTY_WARN_HOURS) warnings.push(`Sucia: llegada a las ${reservation.etaHHMM} en menos de ${DIRTY_WARN_HOURS} h, avisar a pisos`);
    else warnings.push(`Sucia: llegada a las ${reservation.etaHHMM} (${formatHours(entry.etaHours)} h de margen)`);

    let preferenceBudget = weights.preference_cap;
    for (const pref of preferences) {
      if (!satisfies(room, pref)) continue;
      const weight = Math.max(0, Math.min(weights.preference, preferenceBudget));
      preferenceBudget -= weight;
      reasons.push({
        rule: "preference",
        weight,
        detail: weight === 0 && weights.preference > 0 ? `${PREFERENCE_LABELS[pref]} (tope de preferencias alcanzado)` : PREFERENCE_LABELS[pref]
      });
    }

    if (vipBest.has(room.id)) reasons.push({ rule: "vip", weight: weights.vip, detail: "Cliente VIP: mejor vista/planta disponible" });
    if (guest?.lastStayRoomId && guest.lastStayRoomId === room.id) reasons.push({ rule: "returning", weight: weights.returning, detail: "Se alojó aquí en su última visita" });
    if (isGroup && groupFloors.size > 0) {
      const n = parseFloorNumber(room.floor);
      if (n !== null && groupFloors.has(n)) reasons.push({ rule: "group", weight: weights.group, detail: `Junto al resto del grupo (planta ${n})` });
    }
    const demand = input.demandByRoomType?.[room.roomTypeId];
    if (demand && demand.available <= 1 && demand.pendingArrivals > 0) {
      reasons.push({
        rule: "inventory_protection",
        weight: weights.inventory_protection,
        detail: `Se reserva para otra llegada (última del tipo, ${demand.pendingArrivals} llegada${demand.pendingArrivals === 1 ? "" : "s"} pendiente${demand.pendingArrivals === 1 ? "" : "s"})`
      });
    }
    if (rotationWinners.has(room.id)) {
      const n = guest?.stays30dByRoomId?.[room.id] ?? 0;
      reasons.push({ rule: "rotation", weight: weights.rotation, detail: `Reparte el uso (${n} estancia${n === 1 ? "" : "s"} en 30 días)` });
    }
    if (entry.relation === "upgrade") reasons.push({ rule: "free_upgrade", weight: weights.free_upgrade, detail: "Mejora sin coste: no quedaba del tipo reservado" });
    if (specialDetail) reasons.push({ rule: "special_request", weight: weights.special_request, detail: specialDetail });

    const score = reasons.reduce((sum, r) => sum + r.weight, 0);
    return { roomId: room.id, number: room.number, score, reasons, warnings };
  });

  candidates.sort((a, b) => b.score - a.score || compareRoomNumbers(a.number, b.number));
  const top = candidates.slice(0, 3);

  let confidence = 0;
  if (top.length === 0) {
    notes.add("ninguna habitación cumple los filtros");
  } else if (top.length === 1) {
    notes.add("una sola candidata: confianza 0 por falta de comparación");
  } else if (top[0]!.score === top[1]!.score) {
    const tied = top.filter((c) => c.score === top[0]!.score);
    for (const c of tied) {
      const others = tied.filter((o) => o.roomId !== c.roomId).map((o) => o.number).join(", ");
      c.warnings.push(`Empate con la habitación ${others}: elige a mano`);
    }
  } else {
    confidence = clamp01((top[0]!.score - top[1]!.score) / Math.max(top[0]!.score, 1));
  }

  return {
    candidates: top,
    rejected,
    confidence,
    rulesVersion: ASSIGNMENT_RULES_VERSION,
    source: "rules",
    dataNotes: Array.from(notes),
    housekeepingAlerts
  };
}

function stripUndefined<T extends Record<string, number | undefined>>(value: T | undefined): Partial<Record<keyof T, number>> {
  const out: Partial<Record<keyof T, number>> = {};
  if (!value) return out;
  for (const [key, weight] of Object.entries(value)) {
    if (typeof weight === "number" && Number.isFinite(weight)) out[key as keyof T] = weight;
  }
  return out;
}

function cleanlinessLabel(value: "dirty" | "clean" | "inspected"): string {
  return value === "dirty" ? "sucia" : value === "clean" ? "limpia" : "inspeccionada";
}

function formatHours(hours: number): string {
  return (Math.round(hours * 10) / 10).toString().replace(".", ",");
}
