// Frontend client for F&B inventory + menu + recipes + stock balances.
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

export type InventoryItem = {
  id: string; propertyId: string; sku: string | null; name: string;
  category: string | null; unit: string; minLevel: number | null; maxLevel: number | null;
  unitCost: number | null; active: boolean; createdAt: string;
};
export type StockLocation = {
  id: string; propertyId: string; name: string; locationType: string;
  roomId: string | null; spaceId: string | null; active: boolean;
};
export type StockBalance = {
  inventoryItemId: string; name: string; sku: string | null; category: string | null;
  unit: string; minLevel: number | null; maxLevel: number | null;
  onHand: number; lowStock: boolean;
};
export type MenuItem = {
  id: string; propertyId: string; outletId: string;
  sku: string | null; name: string; category: string | null;
  price: number; taxRate: number | null; active: boolean;
  createdAt: string; updatedAt: string;
};
export type MenuRecipe = {
  id: string; menuItemId: string; inventoryItemId: string;
  quantity: number; notes: string | null; createdAt: string;
};

export async function fetchStockBalances(propertyId = getActivePropertyId()): Promise<StockBalance[]> {
  const res = await apiRequest<{ items: StockBalance[] }>(`/properties/${propertyId}/stock-balances`);
  return res.items;
}
export function fetchLowStock(propertyId = getActivePropertyId()) {
  return apiRequest<{ count: number; items: StockBalance[] }>(`/properties/${propertyId}/stock-balances/low-stock`);
}
export async function fetchInventoryItems(propertyId = getActivePropertyId()): Promise<InventoryItem[]> {
  const res = await apiRequest<{ items: InventoryItem[] }>(`/properties/${propertyId}/inventory-items`);
  return res.items;
}
export async function fetchStockLocations(propertyId = getActivePropertyId()): Promise<StockLocation[]> {
  const res = await apiRequest<{ items: StockLocation[] }>(`/properties/${propertyId}/stock-locations`);
  return res.items;
}
export async function fetchMenuItems(outletId?: string, propertyId = getActivePropertyId()): Promise<MenuItem[]> {
  const qs = outletId ? `?outletId=${encodeURIComponent(outletId)}` : "";
  const res = await apiRequest<{ items: MenuItem[] }>(`/properties/${propertyId}/menu-items${qs}`);
  return res.items;
}
export function fetchMenuItemDetail(id: string) {
  return apiRequest<MenuItem & { recipes: MenuRecipe[] }>(`/menu-items/${id}`);
}
export function createInventoryItem(payload: { sku?: string; name: string; category?: string; unit: string; minLevel?: number; unitCost?: number }, propertyId = getActivePropertyId()) {
  return apiRequest<InventoryItem>(`/properties/${propertyId}/inventory-items`, { method: "POST", body: payload });
}
export function createMenuItem(payload: { outletId: string; sku?: string; name: string; category?: string; price: number; taxRate?: number }, propertyId = getActivePropertyId()) {
  return apiRequest<MenuItem>(`/properties/${propertyId}/menu-items`, { method: "POST", body: payload });
}
export function addMenuRecipe(menuItemId: string, payload: { inventoryItemId: string; quantity: number; notes?: string }) {
  return apiRequest<MenuRecipe>(`/menu-items/${menuItemId}/recipes`, { method: "POST", body: payload });
}
export function recordStockMovement(payload: { inventoryItemId: string; stockLocationId: string; movementType: "receipt" | "waste" | "adjustment"; quantity: number; unitCost?: number; sourceType?: string; sourceId?: string }, propertyId = getActivePropertyId()) {
  return apiRequest<{ id: string }>(`/properties/${propertyId}/stock-movements`, { method: "POST", body: payload });
}
