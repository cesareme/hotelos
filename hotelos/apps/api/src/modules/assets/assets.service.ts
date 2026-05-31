import {
  demoStore,
  type AssetRecord,
  type CapexItemRecord,
  type CapexProjectRecord,
  type FixedAssetRecord,
  type UserContext
} from "../../lib/demo-store.js";
import { createId } from "../../lib/ids.js";
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

export function listAssets(propertyId: string): AssetRecord[] {
  return demoStore.assets.filter((asset) => asset.propertyId === propertyId);
}

export function createAsset(input: {
  context: UserContext;
  propertyId: string;
  roomId?: string;
  assetType: AssetRecord["assetType"];
  name: string;
  serialNumber?: string;
  warrantyUntil?: string;
  supplierId?: string;
  correlationId: string;
}): AssetRecord {
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

  demoStore.assets.push(asset);

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

export function updateAsset(input: {
  context: UserContext;
  assetId: string;
  patch: Partial<Pick<AssetRecord, "name" | "serialNumber" | "warrantyUntil" | "supplierId" | "status" | "roomId">>;
  correlationId: string;
}): AssetRecord {
  const asset = findAsset(input.assetId);
  const before = { ...asset };
  Object.assign(asset, input.patch, { id: asset.id, propertyId: asset.propertyId });

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

export function listFixedAssets(propertyId: string): FixedAssetRecord[] {
  return demoStore.fixedAssets.filter((asset) => asset.propertyId === propertyId);
}

export function listCapexProjects(propertyId: string): CapexProjectRecord[] {
  return demoStore.capexProjects.filter((project) => project.propertyId === propertyId);
}

export function createCapexProject(input: {
  context: UserContext;
  propertyId: string;
  name: string;
  description?: string;
  budget: number;
  startDate?: string;
  targetEndDate?: string;
  correlationId: string;
}): CapexProjectRecord {
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

  demoStore.capexProjects.push(project);

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

export function updateCapexProject(input: {
  context: UserContext;
  capexProjectId: string;
  patch: Partial<Pick<CapexProjectRecord, "name" | "description" | "budget" | "status" | "startDate" | "targetEndDate">>;
  correlationId: string;
}): CapexProjectRecord {
  const project = findCapexProject(input.capexProjectId);

  if (input.patch.status === "approved") {
    requirePermissions(input.context, ["asset.capex.approve"]);
  }

  const before = { ...project };
  Object.assign(project, input.patch, { id: project.id, propertyId: project.propertyId });
  if (input.patch.status === "approved") {
    project.ownerApprovedBy = input.context.userId;
  }

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

export function createCapexItem(input: {
  context: UserContext;
  capexProjectId: string;
  roomId?: string;
  assetId?: string;
  description: string;
  estimatedCost: number;
  actualCost?: number;
  correlationId: string;
}): CapexItemRecord {
  const project = findCapexProject(input.capexProjectId);
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

  demoStore.capexItems.push(item);

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

export function getOwnerDashboard(propertyId: string): OwnerDashboardSnapshot {
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

  return {
    occupancy,
    adr,
    revpar,
    cashCollected: capturedPayments.reduce((sum, payment) => sum + payment.amount, 0),
    debtors: Math.max(0, roomRevenue - capturedPayments.reduce((sum, payment) => sum + payment.amount, 0)),
    maintenanceCost,
    roomsBlocked,
    capexProjects: listCapexProjects(propertyId).length,
    complianceIssues,
    aiOwnerBriefing:
      room432Cost > 0
        ? `Room 432 has ${room432Cost} EUR in maintenance signals. Review HVAC before approving fourth floor capex.`
        : "Operations are stable. Review capex items before the next owner approval cycle."
  };
}

function findAsset(assetId: string): AssetRecord {
  const asset = demoStore.assets.find((candidate) => candidate.id === assetId);
  if (!asset) {
    throw new Error("Asset was not found.");
  }

  return asset;
}

function findCapexProject(capexProjectId: string): CapexProjectRecord {
  const project = demoStore.capexProjects.find((candidate) => candidate.id === capexProjectId);
  if (!project) {
    throw new Error("Capex project was not found.");
  }

  return project;
}
