/**
 * Sprint 37a — typed endpoint helpers for the staff mobile MVP.
 *
 * Thin layer over ApiClient. Types are intentionally loose — the API source of
 * truth lives in apps/api; we only declare the fields the screens actually read
 * so the surface is small and easy to migrate.
 */
import type { ApiClient } from "./client";

export type LoginInput = {
  email: string;
  password: string;
  deviceId?: string;
};

export type LoginResponse = {
  accessToken?: string;
  refreshToken?: string;
  token?: string; // legacy /auth/login may return { token }
  user?: { id: string; name?: string; email: string; role?: string };
  property?: { id: string; name: string };
};

export type FrontDeskRow = {
  id: string;
  code?: string;
  guestName?: string;
  roomNumber?: string;
  status?: string;
  balanceDue?: number;
  currency?: string;
  notes?: string;
};

export type FrontDeskBoard = {
  arrivalsCount?: number;
  departuresCount?: number;
  inHouseCount?: number;
  unassignedCount?: number;
  arrivals?: FrontDeskRow[];
  departures?: FrontDeskRow[];
};

export type HousekeepingTask = {
  id: string;
  roomNumber?: string;
  taskType?: string;
  status?: string;
  priority?: string;
  assignedTo?: string;
  notes?: string;
};

export type HousekeepingBoard = {
  tasks?: HousekeepingTask[];
  assignments?: Array<{ staffName?: string; tasks?: HousekeepingTask[] }>;
};

export type MaintenanceBoard = {
  workOrders?: Array<{ id: string; title?: string; status?: string }>;
};

export function createEndpoints(client: ApiClient) {
  return {
    login(input: LoginInput) {
      return client.request<LoginResponse>("/auth/login", {
        method: "POST",
        body: input,
        unauthenticated: true
      });
    },
    getFrontDesk(propertyId: string) {
      return client.request<FrontDeskBoard>(
        `/dashboards/front-desk?propertyId=${encodeURIComponent(propertyId)}`
      );
    },
    getHousekeeping(propertyId: string) {
      return client.request<HousekeepingBoard>(
        `/dashboards/housekeeping?propertyId=${encodeURIComponent(propertyId)}`
      );
    },
    getMaintenance(propertyId: string) {
      return client.request<MaintenanceBoard>(
        `/dashboards/maintenance?propertyId=${encodeURIComponent(propertyId)}`
      );
    },
    checkIn(reservationId: string) {
      return client.request<{ status: string }>(`/reservations/${reservationId}/check-in`, {
        method: "POST",
        body: {}
      });
    },
    checkOut(reservationId: string) {
      return client.request<{ status: string }>(`/reservations/${reservationId}/check-out`, {
        method: "POST",
        body: {}
      });
    }
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
