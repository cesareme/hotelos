// Assets / CapEx — persisted in Prisma (Asset, FixedAsset, CapexProject,
// CapexItem) so records survive restarts and feed the read-only dashboards
// (see modules/dashboards/assets.service.ts).
//
// Persistence notes:
//  - Writes are DUAL-WRITE: Prisma is the source of truth (written first) and
//    every record is mirrored into the in-memory demo store with the SAME id,
//    because legacy readers (e.g. backoffice snapshots, calculateRoomProfitability)
//    still consume demoStore.assets / demoStore.capexItems directly.
//  - The demo store ships with fixture assets/capex rows that predate DB
//    persistence. They are copied once per process into Prisma
//    (createMany + skipDuplicates, same ids) before the first read so lists
//    do not lose the demo data and fixture ids stay updatable.
//  - Date columns are @db.Date; records keep the legacy "YYYY-MM-DD" string
//    shape. Decimal columns are coerced to plain numbers.
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import {
  demoStore,
  type AssetRecord,
  type CapexItemRecord,
  type CapexProjectRecord,
  type FixedAssetRecord,
  type UserContext
} from "../../lib/demo-store.js";
import { createId } from "../../lib/ids.js";
import { NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";

export type RoomProfitability = {
  roomId: string;
  roomNumber: string;
  revenue: number;
  maintenanceCost: number;
  capexPlanned: number;
  profitContribution: number;
};

export type OwnerDashboardSnapshot = {
  occupancy: number;
  adr: number;
  revpar: number;
  cashCollected: number;
  debtors: number;
  maintenanceCost: number;
  roomsBlocked: number;
  capexProjects: number;
  complianceIssues: number;
  aiOwnerBriefing: string;
};

type AssetRow = NonNullable<Awaited<ReturnType<typeof prisma.asset.findUnique>>>;
type CapexProjectRow = NonNullable<Awaited<ReturnType<typeof prisma.capexProject.findUnique>>>;
type CapexItemRow = NonNullable<Awaited<ReturnType<typeof prisma.capexItem.findUnique>>>;
type FixedAssetRow = NonNullable<Awaited<ReturnType<typeof prisma.fixedAsset.findUnique>>>;

// ---------------------------------------------------------------------------
// Mapping helpers (Prisma row <-> legacy record shape)
// ---------------------------------------------------------------------------

function toDbDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateOnly(value: Date | null): string | undefined {
  return value ? value.toISOString().slice(0, 10) : undefined;
}

function toAssetRecord(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    buildingId: row.buildingId ?? undefined,
    floorId: row.floorId ?? undefined,
    zoneId: row.zoneId ?? undefined,
    spaceId: row.spaceId ?? undefined,
    roomId: row.roomId ?? undefined,
    assetType: row.assetType as AssetRecord["assetType"],
    assetCode: row.assetCode ?? undefined,
    name: row.name,
    serialNumber: row.serialNumber ?? undefined,
    manufacturer: row.manufacturer ?? undefined,
    model: row.model ?? undefined,
    installationDate: toDateOnly(row.installationDate),
    warrantyUntil: toDateOnly(row.warrantyUntil),
    purchaseCost: row.purchaseCost === null ? undefined : Number(row.purchaseCost),
    usefulLifeMonths: row.usefulLifeMonths ?? undefined,
    qrCodeValue: row.qrCodeValue ?? undefined,
    supplierId: row.supplierId ?? undefined,
    status: row.status as AssetRecord["status"]
  };
}

function assetToDbRow(record: AssetRecord) {
  return {
    id: record.id,
    propertyId: record.propertyId,
    buildingId: record.buildingId ?? null,
    floorId: record.floorId ?? null,
    zoneId: record.zoneId ?? null,
    spaceId: record.spaceId ?? null,
    roomId: record.roomId ?? null,
    assetType: record.assetType,
    assetCode: record.assetCode ?? null,
    name: record.name,
    serialNumber: record.serialNumber ?? null,
    manufacturer: record.manufacturer ?? null,
    model: record.model ?? null,
    installationDate: toDbDate(record.installationDate),
    warrantyUntil: toDbDate(record.warrantyUntil),
    purchaseCost: record.purchaseCost ?? null,
    usefulLifeMonths: record.usefulLifeMonths ?? null,
    qrCodeValue: record.qrCodeValue ?? null,
    supplierId: record.supplierId ?? null,
    status: record.status
  };
}

function toCapexProjectRecord(row: CapexProjectRow): CapexProjectRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    name: row.name,
    description: row.description ?? undefined,
    budget: Number(row.budget),
    status: row.status as CapexProjectRecord["status"],
    startDate: toDateOnly(row.startDate),
    targetEndDate: toDateOnly(row.targetEndDate),
    ownerApprovedBy: row.ownerApprovedBy ?? undefined
  };
}

function capexProjectToDbRow(record: CapexProjectRecord) {
  return {
    id: record.id,
    propertyId: record.propertyId,
    name: record.name,
    description: record.description ?? null,
    budget: record.budget,
    status: record.status,
    startDate: toDbDate(record.startDate),
    targetEndDate: toDbDate(record.targetEndDate),
    ownerApprovedBy: record.ownerApprovedBy ?? null
  };
}

function toCapexItemRecord(row: CapexItemRow): CapexItemRecord {
  return {
    id: row.id,
    capexProjectId: row.capexProjectId,
    roomId: row.roomId ?? undefined,
    assetId: row.assetId ?? undefined,
    description: row.description,
    estimatedCost: Number(row.estimatedCost),
    actualCost: Number(row.actualCost),
    status: row.status as CapexItemRecord["status"]
  };
}

function capexItemToDbRow(record: CapexItemRecord) {
  return {
    id: record.id,
    capexProjectId: record.capexProjectId,
    roomId: record.roomId ?? null,
    assetId: record.assetId ?? null,
    description: record.description,
    estimatedCost: record.estimatedCost,
    actualCost: record.actualCost,
    status: record.status
  };
}

function toFixedAssetRecord(row: FixedAssetRow): FixedAssetRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    assetId: row.assetId ?? undefined,
    name: row.name,
    acquisitionDate: toDateOnly(row.acquisitionDate),
    acquisitionCost: Number(row.acquisitionCost),
    depreciationMethod: (row.depreciationMethod ?? undefined) as FixedAssetRecord["depreciationMethod"],
    usefulLifeMonths: row.usefulLifeMonths ?? undefined,
    accumulatedDepreciation: Number(row.accumulatedDepreciation)
  };
}

function fixedAssetToDbRow(record: FixedAssetRecord) {
  return {
    id: record.id,
    propertyId: record.propertyId,
    assetId: record.assetId ?? null,
    name: record.name,
    acquisitionDate: toDbDate(record.acquisitionDate),
    acquisitionCost: record.acquisitionCost,
    depreciationMethod: record.depreciationMethod ?? null,
    usefulLifeMonths: record.usefulLifeMonths ?? null,
    accumulatedDepreciation: record.accumulatedDepreciation
  };
}

/** Insert-or-replace a record in a demo-store collection (mirror cache). */
function upsertMirror<T extends { id: string }>(collection: T[], record: T): void {
  const index = collection.findIndex((candidate) => candidate.id === record.id);
  if (index >= 0) {
    collection[index] = record;
  } else {
    collection.push(record);
  }
}

// ---------------------------------------------------------------------------
// One-shot sync of legacy demo fixtures into Prisma (same ids, idempotent)
// ---------------------------------------------------------------------------

let fixtureSyncPromise: Promise<void> | null = null;

function ensureLegacyFixturesPersisted(): Promise<void> {
  if (!fixtureSyncPromise) {
    fixtureSyncPromise = persistLegacyFixtures().catch((error) => {
      fixtureSyncPromise = null; // allow a retry on the next call
      throw error;
    });
  }
  return fixtureSyncPromise;
}

async function persistLegacyFixtures(): Promise<void> {
  if (demoStore.assets.length > 0) {
    await prisma.asset.createMany({ data: demoStore.assets.map(assetToDbRow), skipDuplicates: true });
  }
  if (demoStore.fixedAssets.length > 0) {
    await prisma.fixedAsset.createMany({ data: demoStore.fixedAssets.map(fixedAssetToDbRow), skipDuplicates: true });
  }
  if (demoStore.capexProjects.length > 0) {
    await prisma.capexProject.createMany({ data: demoStore.capexProjects.map(capexProjectToDbRow), skipDuplicates: true });
  }
  if (demoStore.capexItems.length > 0) {
    await prisma.capexItem.createMany({ data: demoStore.capexItems.map(capexItemToDbRow), skipDuplicates: true });
  }
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export async function listAssets(propertyId: string): Promise<AssetRecord[]> {
  await ensureLegacyFixturesPersisted();
  const rows = await prisma.asset.findMany({ where: { propertyId }, orderBy: { name: "asc" } });
  const records = rows.map(toAssetRecord);
  for (const record of records) {
    upsertMirror(demoStore.assets, record);
  }
  return records;
}

export async function createAsset(input: {
  context: UserContext;
  propertyId: string;
  roomId?: string;
  assetType: AssetRecord["assetType"];
  name: string;
  serialNumber?: string;
  warrantyUntil?: string;
  supplierId?: string;
  correlationId: string;
}): Promise<AssetRecord> {
  const asset: AssetRecord = {
    id: createId("asset"),
    propertyId: input.propertyId,
    roomId: input.roomId,
    assetType: input.assetType,
    name: input.name,
    serialNumber: input.serialNumber,
    warrantyUntil: input.warrantyUntil,
    supplierId: input.supplierId,
    status: "active"
  };

  await prisma.asset.create({ data: assetToDbRow(asset) });
  upsertMirror(demoStore.assets, asset);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ASSET_CREATED",
    entityType: "asset",
    entityId: asset.id,
    afterJson: asset,
    correlationId: input.correlationId
  });

  return asset;
}

export async function updateAsset(input: {
  context: UserContext;
  assetId: string;
  patch: Partial<Pick<AssetRecord, "name" | "serialNumber" | "warrantyUntil" | "supplierId" | "status" | "roomId">>;
  correlationId: string;
}): Promise<AssetRecord> {
  const before = await findAsset(input.assetId);

  const data: Prisma.AssetUncheckedUpdateInput = {};
  if (input.patch.name !== undefined) data.name = input.patch.name;
  if (input.patch.serialNumber !== undefined) data.serialNumber = input.patch.serialNumber;
  if (input.patch.warrantyUntil !== undefined) data.warrantyUntil = toDbDate(input.patch.warrantyUntil);
  if (input.patch.supplierId !== undefined) data.supplierId = input.patch.supplierId;
  if (input.patch.status !== undefined) data.status = input.patch.status;
  if (input.patch.roomId !== undefined) data.roomId = input.patch.roomId;

  const asset = toAssetRecord(await prisma.asset.update({ where: { id: before.id }, data }));
  upsertMirror(demoStore.assets, asset);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: asset.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ASSET_UPDATED",
    entityType: "asset",
    entityId: asset.id,
    beforeJson: before,
    afterJson: asset,
    correlationId: input.correlationId
  });

  return asset;
}

export async function listFixedAssets(propertyId: string): Promise<FixedAssetRecord[]> {
  await ensureLegacyFixturesPersisted();
  const rows = await prisma.fixedAsset.findMany({ where: { propertyId }, orderBy: { name: "asc" } });
  const records = rows.map(toFixedAssetRecord);
  for (const record of records) {
    upsertMirror(demoStore.fixedAssets, record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// CapEx projects & items
// ---------------------------------------------------------------------------

export async function listCapexProjects(propertyId: string): Promise<CapexProjectRecord[]> {
  await ensureLegacyFixturesPersisted();
  const rows = await prisma.capexProject.findMany({ where: { propertyId }, orderBy: { name: "asc" } });
  const records = rows.map(toCapexProjectRecord);
  for (const record of records) {
    upsertMirror(demoStore.capexProjects, record);
  }
  return records;
}

export async function createCapexProject(input: {
  context: UserContext;
  propertyId: string;
  name: string;
  description?: string;
  budget: number;
  startDate?: string;
  targetEndDate?: string;
  correlationId: string;
}): Promise<CapexProjectRecord> {
  const project: CapexProjectRecord = {
    id: createId("capex"),
    propertyId: input.propertyId,
    name: input.name,
    description: input.description,
    budget: input.budget,
    status: "proposed",
    startDate: input.startDate,
    targetEndDate: input.targetEndDate
  };

  await prisma.capexProject.create({ data: capexProjectToDbRow(project) });
  upsertMirror(demoStore.capexProjects, project);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "CAPEX_PROJECT_CREATED",
    entityType: "capex_project",
    entityId: project.id,
    afterJson: project,
    correlationId: input.correlationId
  });

  return project;
}

export async function updateCapexProject(input: {
  context: UserContext;
  capexProjectId: string;
  patch: Partial<Pick<CapexProjectRecord, "name" | "description" | "budget" | "status" | "startDate" | "targetEndDate">>;
  correlationId: string;
}): Promise<CapexProjectRecord> {
  const before = await findCapexProject(input.capexProjectId);

  if (input.patch.status === "approved") {
    requirePermissions(input.context, ["asset.capex.approve"]);
  }

  const data: Prisma.CapexProjectUncheckedUpdateInput = {};
  if (input.patch.name !== undefined) data.name = input.patch.name;
  if (input.patch.description !== undefined) data.description = input.patch.description;
  if (input.patch.budget !== undefined) data.budget = input.patch.budget;
  if (input.patch.status !== undefined) data.status = input.patch.status;
  if (input.patch.startDate !== undefined) data.startDate = toDbDate(input.patch.startDate);
  if (input.patch.targetEndDate !== undefined) data.targetEndDate = toDbDate(input.patch.targetEndDate);
  if (input.patch.status === "approved") {
    data.ownerApprovedBy = input.context.userId;
  }

  const project = toCapexProjectRecord(await prisma.capexProject.update({ where: { id: before.id }, data }));
  upsertMirror(demoStore.capexProjects, project);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: project.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "CAPEX_PROJECT_UPDATED",
    entityType: "capex_project",
    entityId: project.id,
    beforeJson: before,
    afterJson: project,
    correlationId: input.correlationId
  });

  if (input.patch.status === "approved") {
    recordDomainEvent({
      organizationId: input.context.organizationId,
      propertyId: project.propertyId,
      entityType: "capex_project",
      entityId: project.id,
      eventType: "CapexProjectApproved",
      payload: { budget: project.budget, ownerApprovedBy: project.ownerApprovedBy },
      actorType: "user",
      actorUserId: input.context.userId,
      correlationId: input.correlationId
    });
  }

  return project;
}

export async function createCapexItem(input: {
  context: UserContext;
  capexProjectId: string;
  roomId?: string;
  assetId?: string;
  description: string;
  estimatedCost: number;
  actualCost?: number;
  correlationId: string;
}): Promise<CapexItemRecord> {
  const project = await findCapexProject(input.capexProjectId);
  const item: CapexItemRecord = {
    id: createId("capex_item"),
    capexProjectId: project.id,
    roomId: input.roomId,
    assetId: input.assetId,
    description: input.description,
    estimatedCost: input.estimatedCost,
    actualCost: input.actualCost ?? 0,
    status: "proposed"
  };

  await prisma.capexItem.create({ data: capexItemToDbRow(item) });
  upsertMirror(demoStore.capexItems, item);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: project.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "CAPEX_ITEM_CREATED",
    entityType: "capex_item",
    entityId: item.id,
    afterJson: item,
    correlationId: input.correlationId
  });

  return item;
}

// ---------------------------------------------------------------------------
// Analytics (legacy demo-store aggregations)
// ---------------------------------------------------------------------------

export function calculateRoomProfitability(propertyId: string): RoomProfitability[] {
  return demoStore.rooms
    .filter((room) => room.propertyId === propertyId)
    .map((room) => {
      const reservationRevenue = demoStore.reservations
        .filter((reservation) => reservation.assignedRoomId === room.id)
        .reduce((sum, reservation) => sum + reservation.totalAmount, 0);
      const maintenanceCost = demoStore.workOrders
        .filter((order) => order.roomId === room.id)
        .reduce((sum, order) => sum + (order.priority === "urgent" ? 480 : 180), 0);
      const capexPlanned = demoStore.capexItems
        .filter((item) => item.roomId === room.id)
        .reduce((sum, item) => sum + item.estimatedCost, 0);

      return {
        roomId: room.id,
        roomNumber: room.number,
        revenue: reservationRevenue,
        maintenanceCost,
        capexPlanned,
        profitContribution: reservationRevenue - maintenanceCost
      };
    });
}

export async function getOwnerDashboard(propertyId: string): Promise<OwnerDashboardSnapshot> {
  const rooms = demoStore.rooms.filter((room) => room.propertyId === propertyId);
  const reservations = demoStore.reservations.filter((reservation) => reservation.propertyId === propertyId);
  const capturedPayments = demoStore.payments.filter((payment) => payment.propertyId === propertyId && payment.status === "captured");
  const roomRevenue = reservations.reduce((sum, reservation) => sum + reservation.totalAmount, 0);
  const roomsBlocked = rooms.filter((room) => room.maintenanceStatus === "blocked" || !room.sellable).length;
  const maintenanceCost = demoStore.workOrders
    .filter((order) => order.propertyId === propertyId)
    .reduce((sum, order) => sum + (order.priority === "urgent" ? 480 : 180), 0);
  const complianceIssues =
    demoStore.guestRegisterRecords.filter((record) => record.propertyId === propertyId && ["draft", "failed"].includes(record.status)).length +
    demoStore.sesSubmissions.filter((submission) => submission.propertyId === propertyId && ["failed", "rejected"].includes(submission.status)).length;
  const occupancy = rooms.length === 0 ? 0 : Math.round((reservations.filter((reservation) => reservation.status === "checked_in").length / rooms.length) * 100);
  const adr = reservations.length === 0 ? 0 : Math.round(roomRevenue / reservations.length);
  const revpar = rooms.length === 0 ? 0 : Math.round(roomRevenue / rooms.length);
  const room432Cost = calculateRoomProfitability(propertyId).find((room) => room.roomNumber === "432")?.maintenanceCost ?? 0;
  const capexProjects = await listCapexProjects(propertyId);

  return {
    occupancy,
    adr,
    revpar,
    cashCollected: capturedPayments.reduce((sum, payment) => sum + payment.amount, 0),
    debtors: Math.max(0, roomRevenue - capturedPayments.reduce((sum, payment) => sum + payment.amount, 0)),
    maintenanceCost,
    roomsBlocked,
    capexProjects: capexProjects.length,
    complianceIssues,
    aiOwnerBriefing:
      room432Cost > 0
        ? `Room 432 has ${room432Cost} EUR in maintenance signals. Review HVAC before approving fourth floor capex.`
        : "Operations are stable. Review capex items before the next owner approval cycle."
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

async function findAsset(assetId: string): Promise<AssetRecord> {
  await ensureLegacyFixturesPersisted();
  const row = await prisma.asset.findUnique({ where: { id: assetId } });
  if (row) {
    return toAssetRecord(row);
  }

  // Safety net for records another module pushed straight into the demo store
  // after the one-shot fixture sync: materialise them, then serve as usual.
  const legacy = demoStore.assets.find((candidate) => candidate.id === assetId);
  if (legacy) {
    await prisma.asset.createMany({ data: [assetToDbRow(legacy)], skipDuplicates: true });
    return { ...legacy };
  }

  throw new NotFoundError("Asset was not found.");
}

async function findCapexProject(capexProjectId: string): Promise<CapexProjectRecord> {
  await ensureLegacyFixturesPersisted();
  const row = await prisma.capexProject.findUnique({ where: { id: capexProjectId } });
  if (row) {
    return toCapexProjectRecord(row);
  }

  const legacy = demoStore.capexProjects.find((candidate) => candidate.id === capexProjectId);
  if (legacy) {
    await prisma.capexProject.createMany({ data: [capexProjectToDbRow(legacy)], skipDuplicates: true });
    return { ...legacy };
  }

  throw new NotFoundError("Capex project was not found.");
}
