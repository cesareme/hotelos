// Property Mapper — turn uploaded documents into a property structure.
//
// A hotel uploads exports (room-list CSV/XLSX-as-text, floor plans, PDFs, plain
// text). We produce a reviewable PROPOSAL of the property map (buildings →
// floors → zones → room types → rooms → spaces) and, on confirmation, create
// the real entities.
//
// Honesty: extraction has a clearly-labelled source —
//   - "rules": deterministic parse of structured text (CSV/TSV). Works offline.
//   - "ai":    LLM extraction of unstructured text (only when a provider is set).
//   - "none":  nothing parseable + no AI configured → we say so, no fake data.

import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError } from "../../lib/http-error.js";
import { isLlmConfigured, llmComplete } from "../../lib/llm.js";

export type MapperFile = { name: string; mimeType?: string; text?: string };

export type ProposedRoomType = { name: string; code?: string; baseOccupancy?: number; maxOccupancy?: number };
export type ProposedRoom = {
  number: string;
  floor?: string;
  building?: string;
  zone?: string;
  roomTypeName?: string;
  beds?: string;
  features?: string[];
  sellable?: boolean;
};

export type PropertyMapProposal = {
  source: "rules" | "ai" | "none";
  modelVersion: string;
  message?: string;
  buildings: string[];
  floors: string[];
  zones: string[];
  roomTypes: ProposedRoomType[];
  rooms: ProposedRoom[];
  spaces: string[];
  counts: { buildings: number; floors: number; zones: number; roomTypes: number; rooms: number; spaces: number };
};

// ---------------------------------------------------------------------------
// Delimited-text (CSV/TSV/semicolon) parsing — deterministic, offline.
// ---------------------------------------------------------------------------

function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function detectDelimiter(headerLine: string): string {
  const counts: Record<string, number> = {
    ",": (headerLine.match(/,/g) ?? []).length,
    ";": (headerLine.match(/;/g) ?? []).length,
    "\t": (headerLine.match(/\t/g) ?? []).length
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0];
}

function findCol(header: string[], names: string[]): number {
  for (let i = 0; i < header.length; i++) {
    const h = header[i]!.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (names.some((n) => h === n || h.includes(n))) return i;
  }
  return -1;
}

function parseDelimited(text: string): ProposedRoom[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const delimiter = detectDelimiter(lines[0]!);
  const header = splitLine(lines[0]!, delimiter);
  const roomCol = findCol(header, ["roomnumber", "room", "number", "habitacion", "habitación", "nhab", "no"]);
  if (roomCol < 0) return [];
  const floorCol = findCol(header, ["floor", "planta", "piso", "nivel"]);
  const buildingCol = findCol(header, ["building", "edificio", "block", "bloque"]);
  const zoneCol = findCol(header, ["zone", "wing", "zona", "ala", "area", "área"]);
  const typeCol = findCol(header, ["roomtype", "type", "tipo", "category", "categoria", "categoría"]);
  const bedsCol = findCol(header, ["beds", "bed", "camas", "cama"]);
  const featuresCol = findCol(header, ["features", "amenities", "caracteristicas", "características", "extras"]);
  const sellableCol = findCol(header, ["sellable", "vendible", "active", "activa"]);

  const rooms: ProposedRoom[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]!, delimiter);
    const number = (cells[roomCol] ?? "").trim();
    if (!number) continue;
    const featuresRaw = featuresCol >= 0 ? (cells[featuresCol] ?? "") : "";
    const sellableRaw = sellableCol >= 0 ? (cells[sellableCol] ?? "").toLowerCase() : "";
    rooms.push({
      number,
      floor: floorCol >= 0 ? (cells[floorCol] ?? "").trim() || undefined : undefined,
      building: buildingCol >= 0 ? (cells[buildingCol] ?? "").trim() || undefined : undefined,
      zone: zoneCol >= 0 ? (cells[zoneCol] ?? "").trim() || undefined : undefined,
      roomTypeName: typeCol >= 0 ? (cells[typeCol] ?? "").trim() || undefined : undefined,
      beds: bedsCol >= 0 ? (cells[bedsCol] ?? "").trim() || undefined : undefined,
      features: featuresRaw ? featuresRaw.split(/[|;,]/).map((f) => f.trim()).filter(Boolean) : undefined,
      sellable: sellableCol >= 0 ? !["no", "false", "0", "n", ""].includes(sellableRaw) : undefined
    });
  }
  return rooms;
}

function buildProposalFromRooms(rooms: ProposedRoom[], source: "rules" | "ai", modelVersion: string): PropertyMapProposal {
  const dedupe = (xs: (string | undefined)[]) => Array.from(new Set(xs.filter((x): x is string => Boolean(x))));
  const buildings = dedupe(rooms.map((r) => r.building));
  const floors = dedupe(rooms.map((r) => r.floor));
  const zones = dedupe(rooms.map((r) => r.zone));
  const typeNames = dedupe(rooms.map((r) => r.roomTypeName));
  const roomTypes: ProposedRoomType[] = (typeNames.length ? typeNames : ["Standard"]).map((name) => ({
    name,
    baseOccupancy: 2,
    maxOccupancy: 2
  }));
  return {
    source,
    modelVersion,
    buildings,
    floors,
    zones,
    roomTypes,
    rooms,
    spaces: [],
    counts: {
      buildings: buildings.length,
      floors: floors.length,
      zones: zones.length,
      roomTypes: roomTypes.length,
      rooms: rooms.length,
      spaces: 0
    }
  };
}

const AI_SYSTEM = `You map hotel property data. Given raw text describing a hotel's physical layout, return ONLY JSON:
{"rooms":[{"number":"101","floor":"1","building":"Main","zone":"East","roomTypeName":"Double","beds":"Queen x1","features":["balcony"],"sellable":true}],"spaces":["Reception","Spa"]}
Infer room types from the text. Omit unknown fields. Return strictly valid JSON, no prose.`;

async function extractWithAi(text: string): Promise<PropertyMapProposal | null> {
  const result = await llmComplete({
    system: AI_SYSTEM,
    prompt: text.slice(0, 12000),
    maxTokens: 1500,
    temperature: 0.1
  });
  if (!result.configured) return null;
  try {
    const jsonStart = result.text.indexOf("{");
    const jsonEnd = result.text.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd < 0) return null;
    const parsed = JSON.parse(result.text.slice(jsonStart, jsonEnd + 1)) as {
      rooms?: ProposedRoom[];
      spaces?: string[];
    };
    const rooms = Array.isArray(parsed.rooms) ? parsed.rooms.filter((r) => r && r.number) : [];
    if (!rooms.length && !(parsed.spaces ?? []).length) return null;
    const proposal = buildProposalFromRooms(rooms, "ai", `ai-${result.model}`);
    proposal.spaces = Array.isArray(parsed.spaces) ? parsed.spaces.filter(Boolean) : [];
    proposal.counts.spaces = proposal.spaces.length;
    return proposal;
  } catch {
    return null;
  }
}

export async function extractPropertyMap(input: {
  context: UserContext;
  propertyId: string;
  files: MapperFile[];
}): Promise<PropertyMapProposal> {
  requirePermissions(input.context, ["property.map.read"]);
  const texts = (input.files ?? []).map((f) => f.text ?? "").filter((t) => t.trim().length > 0);
  const combined = texts.join("\n");
  const hasBinaryOnly = (input.files ?? []).length > 0 && texts.length === 0;

  // 1) Deterministic structured parse (best for room-list exports).
  for (const text of texts) {
    const rooms = parseDelimited(text);
    if (rooms.length > 0) {
      return buildProposalFromRooms(rooms, "rules", "mapper-rules-v1");
    }
  }

  // 2) AI extraction for unstructured text (only when a provider is configured).
  if (combined.trim().length > 0 && isLlmConfigured()) {
    const aiProposal = await extractWithAi(combined);
    if (aiProposal && aiProposal.rooms.length > 0) return aiProposal;
  }

  // 3) Nothing usable — be honest.
  const empty: PropertyMapProposal = {
    source: "none",
    modelVersion: "none",
    buildings: [], floors: [], zones: [], roomTypes: [], rooms: [], spaces: [],
    counts: { buildings: 0, floors: 0, zones: 0, roomTypes: 0, rooms: 0, spaces: 0 }
  };
  if (hasBinaryOnly && !isLlmConfigured()) {
    empty.message = "PDFs and images need a configured AI vision provider. For now, upload a room-list spreadsheet/CSV or a text export and the mapper will read it directly.";
  } else if (combined.trim().length > 0 && !isLlmConfigured()) {
    empty.message = "Couldn't find a structured room list. Configure an AI provider to interpret unstructured documents, or upload a CSV with a room/number column.";
  } else {
    empty.message = "No room data found in the uploaded documents.";
  }
  return empty;
}

// ---------------------------------------------------------------------------
// Apply — create real room types + rooms from a confirmed proposal.
// ---------------------------------------------------------------------------

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "type";
}

export async function applyPropertyMap(input: {
  context: UserContext;
  propertyId: string;
  proposal: PropertyMapProposal;
  correlationId: string;
}): Promise<{ roomTypesCreated: number; roomsCreated: number; roomsSkipped: number; notes: string[] }> {
  requirePermissions(input.context, ["rooms.manage"]);
  const { proposal, propertyId } = input;
  if (!proposal || !Array.isArray(proposal.rooms)) throw new BadRequestError("A proposal with rooms is required.");

  const notes: string[] = [];
  const existingTypes = await prisma.roomType.findMany({ where: { propertyId } });
  const typeIdByName = new Map<string, string>();
  const usedCodes = new Set(existingTypes.map((t) => t.code.toLowerCase()));
  for (const t of existingTypes) typeIdByName.set(t.name.toLowerCase(), t.id);

  let roomTypesCreated = 0;
  let displayOrder = existingTypes.length;
  const proposedTypes = proposal.roomTypes.length ? proposal.roomTypes : [{ name: "Standard" }];
  for (const pt of proposedTypes) {
    const key = pt.name.toLowerCase();
    if (typeIdByName.has(key)) continue;
    let code = slug(pt.code || pt.name);
    let suffix = 1;
    while (usedCodes.has(code.toLowerCase())) code = `${slug(pt.code || pt.name)}_${suffix++}`;
    usedCodes.add(code.toLowerCase());
    const created = await prisma.roomType.create({
      data: {
        propertyId,
        name: pt.name,
        code,
        maxOccupancy: pt.maxOccupancy ?? 2,
        baseCapacity: pt.baseOccupancy ?? 2,
        sellable: true,
        active: true,
        displayOrder: displayOrder++
      }
    });
    typeIdByName.set(key, created.id);
    roomTypesCreated++;
  }
  const fallbackTypeId = typeIdByName.values().next().value as string | undefined;

  const existingRooms = await prisma.room.findMany({ where: { propertyId }, select: { number: true } });
  const existingNumbers = new Set(existingRooms.map((r) => r.number));

  let roomsCreated = 0;
  let roomsSkipped = 0;
  for (const r of proposal.rooms) {
    const number = (r.number ?? "").trim();
    if (!number) { roomsSkipped++; continue; }
    if (existingNumbers.has(number)) { roomsSkipped++; continue; }
    const typeId = (r.roomTypeName && typeIdByName.get(r.roomTypeName.toLowerCase())) || fallbackTypeId;
    if (!typeId) { roomsSkipped++; continue; }
    await prisma.room.create({
      data: {
        propertyId,
        roomTypeId: typeId,
        number,
        floor: r.floor ?? "",
        status: "clean",
        housekeepingStatus: "clean",
        maintenanceStatus: "ok",
        sellable: r.sellable ?? true
      }
    });
    existingNumbers.add(number);
    roomsCreated++;
  }

  if (proposal.buildings.length || proposal.zones.length) {
    notes.push(`Buildings (${proposal.buildings.length}) and zones (${proposal.zones.length}) were captured in the proposal; floors are stored on each room. Create building/zone entities in Property Setup if you need them as separate records.`);
  }

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PROPERTY_MAP_APPLIED",
    entityType: "property",
    entityId: propertyId,
    afterJson: { source: proposal.source, roomTypesCreated, roomsCreated, roomsSkipped },
    correlationId: input.correlationId
  });

  return { roomTypesCreated, roomsCreated, roomsSkipped, notes };
}
