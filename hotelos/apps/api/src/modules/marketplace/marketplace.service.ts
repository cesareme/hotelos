// Marketplace público de apps — catálogo + instalación.

import { prisma } from "@hotelos/database";
import { createHash, randomBytes } from "node:crypto";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";

export const MARKETPLACE_CATEGORIES = [
  "channel_manager",
  "rate_management",
  "payments",
  "messaging",
  "smart_lock",
  "accounting",
  "compliance",
  "energy",
  "marketing",
  "crm",
  "operations",
  "analytics",
  "ai_assistant"
] as const;

export async function listPublishedListings(input?: { category?: string }) {
  const where: Record<string, unknown> = { status: "published" };
  if (input?.category) where.category = input.category;
  return prisma.marketplaceListing.findMany({
    where,
    orderBy: [{ installsCount: "desc" }, { publishedAt: "desc" }]
  });
}

export async function getListing(appId: string) {
  const listing = await prisma.marketplaceListing.findUnique({ where: { appId } });
  if (!listing) throw new NotFoundError("Listing not found.");
  return listing;
}

export async function publishListing(input: {
  context: UserContext;
  payload: {
    appId: string;
    category: string;
    tagline: string;
    description: string;
    iconUrl?: string;
    pricing?: string;
    privacyUrl?: string;
    termsUrl?: string;
  };
}) {
  requirePermissions(input.context, ["developer.manage_webhooks"]);
  const p = input.payload;
  if (!(MARKETPLACE_CATEGORIES as readonly string[]).includes(p.category)) {
    throw new BadRequestError(`Unknown category: ${p.category}`);
  }
  return prisma.marketplaceListing.upsert({
    where: { appId: p.appId },
    create: {
      appId: p.appId,
      status: "review",
      category: p.category,
      tagline: p.tagline.slice(0, 160),
      description: p.description,
      iconUrl: p.iconUrl,
      pricing: p.pricing ?? "free",
      privacyUrl: p.privacyUrl,
      termsUrl: p.termsUrl
    },
    update: {
      category: p.category,
      tagline: p.tagline.slice(0, 160),
      description: p.description,
      iconUrl: p.iconUrl,
      pricing: p.pricing,
      privacyUrl: p.privacyUrl,
      termsUrl: p.termsUrl
    }
  });
}

/**
 * Install an app on the calling organization's property. Records the
 * installation + scopes granted. The actual token issuance is a separate step
 * via /oauth/authorize.
 */
export async function installApp(input: {
  context: UserContext;
  appId: string;
  propertyId?: string;
  grantedScopes: string[];
}) {
  // No permission gate beyond authenticated session — any property admin can
  // install an app for their property.
  const listing = await prisma.marketplaceListing.findUnique({ where: { appId: input.appId } });
  if (!listing || listing.status !== "published") {
    throw new NotFoundError("App not available.");
  }
  const installation = await prisma.appInstallation.upsert({
    where: {
      appId_organizationId_propertyId: {
        appId: input.appId,
        organizationId: input.context.organizationId,
        propertyId: input.propertyId ?? null
      } as unknown as { appId: string; organizationId: string; propertyId: string }
    },
    create: {
      appId: input.appId,
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      scopes: input.grantedScopes,
      installedByUserId: input.context.userId
    },
    update: {
      scopes: input.grantedScopes,
      uninstalledAt: null
    }
  });
  // Bump install counter (best-effort).
  await prisma.marketplaceListing.update({
    where: { appId: input.appId },
    data: { installsCount: { increment: 1 } }
  }).catch(() => {});
  return installation;
}

export async function uninstallApp(input: {
  context: UserContext;
  appId: string;
  propertyId?: string;
}) {
  const existing = await prisma.appInstallation.findFirst({
    where: {
      appId: input.appId,
      organizationId: input.context.organizationId,
      propertyId: input.propertyId ?? null,
      uninstalledAt: null
    }
  });
  if (!existing) throw new NotFoundError("Installation not found.");
  return prisma.appInstallation.update({
    where: { id: existing.id },
    data: { uninstalledAt: new Date() }
  });
}

export async function listInstallations(input: { context: UserContext; propertyId?: string }) {
  return prisma.appInstallation.findMany({
    where: {
      organizationId: input.context.organizationId,
      propertyId: input.propertyId ?? undefined,
      uninstalledAt: null
    },
    orderBy: { installedAt: "desc" }
  });
}

// ---------------------------------------------------------------------------
// Developer app management (CRUD + client_secret rotation)
// ---------------------------------------------------------------------------

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export async function createDeveloperApp(input: {
  context: UserContext;
  payload: { name: string; appType: string; scopes: string[] };
}): Promise<{ id: string; clientId: string; clientSecret: string }> {
  requirePermissions(input.context, ["developer.manage_webhooks"]);
  const clientId = `cli_${randomBytes(12).toString("base64url")}`;
  const clientSecret = `sec_${randomBytes(32).toString("base64url")}`;
  const app = await prisma.developerApp.create({
    data: {
      organizationId: input.context.organizationId,
      name: input.payload.name,
      appType: input.payload.appType,
      status: "active",
      clientId,
      clientSecretHash: hashSecret(clientSecret),
      scopes: input.payload.scopes,
      createdBy: input.context.userId
    }
  });
  return { id: app.id, clientId: app.clientId, clientSecret };
}

export async function rotateClientSecret(input: { context: UserContext; appId: string }) {
  requirePermissions(input.context, ["developer.manage_webhooks"]);
  const newSecret = `sec_${randomBytes(32).toString("base64url")}`;
  await prisma.developerApp.update({
    where: { id: input.appId },
    data: { clientSecretHash: hashSecret(newSecret) }
  });
  return { clientSecret: newSecret };
}

export async function listDeveloperApps(input: { context: UserContext }) {
  return prisma.developerApp.findMany({
    where: { organizationId: input.context.organizationId },
    orderBy: { createdAt: "desc" }
  });
}
