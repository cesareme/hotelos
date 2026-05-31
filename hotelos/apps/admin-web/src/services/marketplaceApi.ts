// Frontend client for Marketplace + Developer Apps + OAuth2.
import { apiRequest } from "./api-client";

export type MarketplaceListing = {
  id: string;
  appId: string;
  publishedAt: string | null;
  status: string;
  category: string;
  tagline: string;
  description: string;
  iconUrl: string | null;
  pricing: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
  verified: boolean;
  installsCount: number;
  createdAt: string;
};

export type AppInstallation = {
  id: string;
  appId: string;
  organizationId: string;
  propertyId: string | null;
  scopes: string[];
  installedAt: string;
  uninstalledAt: string | null;
};

export type DeveloperApp = {
  id: string;
  organizationId: string;
  name: string;
  appType: string;
  status: string;
  clientId: string;
  scopes: string[];
  createdAt: string;
};

export async function fetchCategories(): Promise<string[]> {
  const r = await apiRequest<{ items: string[] }>("/marketplace/categories");
  return r.items;
}

export async function fetchListings(category?: string): Promise<MarketplaceListing[]> {
  const qs = category ? `?category=${encodeURIComponent(category)}` : "";
  const r = await apiRequest<{ items: MarketplaceListing[] }>(`/marketplace/listings${qs}`);
  return r.items;
}

export function fetchListing(appId: string): Promise<MarketplaceListing> {
  return apiRequest<MarketplaceListing>(`/marketplace/listings/${appId}`);
}

export function installListing(appId: string, payload: { propertyId?: string; grantedScopes: string[] }) {
  return apiRequest<AppInstallation>(`/marketplace/listings/${appId}/install`, { method: "POST", body: payload });
}

export function uninstallListing(appId: string, propertyId?: string) {
  return apiRequest<AppInstallation>(`/marketplace/listings/${appId}/uninstall`, { method: "POST", body: { propertyId } });
}

export async function fetchInstallations(propertyId?: string): Promise<AppInstallation[]> {
  const qs = propertyId ? `?propertyId=${encodeURIComponent(propertyId)}` : "";
  const r = await apiRequest<{ items: AppInstallation[] }>(`/marketplace/installations${qs}`);
  return r.items;
}

export async function fetchDeveloperApps(): Promise<DeveloperApp[]> {
  const r = await apiRequest<{ items: DeveloperApp[] }>("/developer/apps");
  return r.items;
}

export function createDeveloperApp(payload: { name: string; appType: string; scopes: string[] }): Promise<{ id: string; clientId: string; clientSecret: string }> {
  return apiRequest("/developer/apps", { method: "POST", body: payload });
}

export function rotateAppSecret(appId: string): Promise<{ clientSecret: string }> {
  return apiRequest(`/developer/apps/${appId}/rotate-secret`, { method: "POST" });
}

export async function fetchOAuthScopes(): Promise<string[]> {
  const r = await apiRequest<{ items: string[] }>("/oauth/scopes");
  return r.items;
}

export function publishListing(payload: {
  appId: string;
  category: string;
  tagline: string;
  description: string;
  iconUrl?: string;
  pricing?: string;
}) {
  return apiRequest<MarketplaceListing>("/marketplace/listings", { method: "POST", body: payload });
}
