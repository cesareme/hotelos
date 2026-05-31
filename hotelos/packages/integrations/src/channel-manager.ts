export type ChannelConnectionTestResult = {
  providerCode: string;
  status: "ok" | "warning" | "error";
  message: string;
  checkedAt: string;
};

export type ChannelSyncResult = {
  status: "synced" | "queued" | "failed";
  exportedAvailability: number;
  exportedRates: number;
  exportedRestrictions: number;
  importedReservations: number;
  warnings: string[];
  idempotencyKey?: string;
};

export type ChannelSyncRequest = {
  propertyId: string;
  channel: string;
  from: string;
  to: string;
};

export type PushAvailabilityInput = {
  connectionId: string;
  propertyId: string;
  dateRange: { start: string; end: string };
  inventoryDays: Array<{
    roomTypeId: string;
    date: string;
    availableCount: number;
    stopSell?: boolean;
  }>;
  idempotencyKey: string;
};

export type PushRatesInput = {
  connectionId: string;
  propertyId: string;
  dateRange: { start: string; end: string };
  rateDays: Array<{
    roomTypeId: string;
    ratePlanId: string;
    date: string;
    price: number;
    currency: string;
  }>;
  idempotencyKey: string;
};

export type PushRestrictionsInput = {
  connectionId: string;
  propertyId: string;
  dateRange: { start: string; end: string };
  restrictionDays: Array<{
    roomTypeId: string;
    ratePlanId?: string;
    date: string;
    minStay?: number;
    maxStay?: number;
    closedToArrival?: boolean;
    closedToDeparture?: boolean;
    stopSell?: boolean;
  }>;
  idempotencyKey: string;
};

export type PullReservationsInput = {
  connectionId: string;
  propertyId: string;
  since?: string;
};

export type ExternalReservation = {
  externalReservationId: string;
  channelCode: string;
  status: "new" | "modified" | "cancelled";
  guestName: string;
  arrivalDate: string;
  departureDate: string;
  roomTypeCode: string;
  ratePlanCode: string;
  grossAmount: number;
  currency: string;
  payload: Record<string, unknown>;
};

export type AcknowledgeReservationInput = {
  connectionId: string;
  externalReservationId: string;
};

export type ChannelWebhookResult = {
  status: "accepted" | "ignored" | "failed";
  externalReservationIds: string[];
  warnings: string[];
};

export interface ChannelManagerAdapter {
  providerCode: string;
  testConnection(connectionId: string): Promise<ChannelConnectionTestResult>;
  pushAvailability(input: PushAvailabilityInput): Promise<ChannelSyncResult>;
  pushRates(input: PushRatesInput): Promise<ChannelSyncResult>;
  pushRestrictions(input: PushRestrictionsInput): Promise<ChannelSyncResult>;
  pullReservations(input: PullReservationsInput): Promise<ExternalReservation[]>;
  acknowledgeReservation?(input: AcknowledgeReservationInput): Promise<void>;
  handleWebhook?(
    connectionId: string,
    payload: unknown,
    headers: Record<string, string>
  ): Promise<ChannelWebhookResult>;
}

function createMockChannelAdapter(providerCode: string): ChannelManagerAdapter {
  const warnings =
    providerCode === "direct_booking_engine" || providerCode === "manual_channel"
      ? []
      : ["Mock adapter: provider credentials and OTA-specific payload mapping are not configured."];

  return {
    providerCode,
    async testConnection(connectionId) {
      return {
        providerCode,
        status: warnings.length ? "warning" : "ok",
        message: `${providerCode} connection ${connectionId} is reachable in mock mode.`,
        checkedAt: new Date().toISOString()
      };
    },
    async pushAvailability(input) {
      return {
        status: "synced",
        exportedAvailability: input.inventoryDays.length,
        exportedRates: 0,
        exportedRestrictions: 0,
        importedReservations: 0,
        warnings,
        idempotencyKey: input.idempotencyKey
      };
    },
    async pushRates(input) {
      return {
        status: "synced",
        exportedAvailability: 0,
        exportedRates: input.rateDays.length,
        exportedRestrictions: 0,
        importedReservations: 0,
        warnings,
        idempotencyKey: input.idempotencyKey
      };
    },
    async pushRestrictions(input) {
      return {
        status: "synced",
        exportedAvailability: 0,
        exportedRates: 0,
        exportedRestrictions: input.restrictionDays.length,
        importedReservations: 0,
        warnings,
        idempotencyKey: input.idempotencyKey
      };
    },
    async pullReservations(input) {
      return [
        {
          externalReservationId: `${providerCode}_demo_18392`,
          channelCode: providerCode,
          status: "new",
          guestName: "Maria Lopez Garcia",
          arrivalDate: "2026-06-12",
          departureDate: "2026-06-14",
          roomTypeCode: "EXT_DBL_STD",
          ratePlanCode: "EXT_BAR_FLEX",
          grossAmount: 308,
          currency: "EUR",
          payload: {
            connectionId: input.connectionId,
            importedBy: "mock_channel_adapter"
          }
        }
      ];
    },
    async acknowledgeReservation() {
      return undefined;
    },
    async handleWebhook() {
      return {
        status: "accepted",
        externalReservationIds: [`${providerCode}_webhook_demo`],
        warnings
      };
    }
  };
}

export const CHANNEL_MANAGER_ADAPTERS: Record<string, ChannelManagerAdapter> = {
  booking_com_mock: createMockChannelAdapter("booking_com_mock"),
  expedia_mock: createMockChannelAdapter("expedia_mock"),
  google_hotels_mock: createMockChannelAdapter("google_hotels_mock"),
  direct_booking_engine: createMockChannelAdapter("direct_booking_engine"),
  manual_channel: createMockChannelAdapter("manual_channel")
};

export function getChannelManagerAdapter(providerCode: string): ChannelManagerAdapter {
  return CHANNEL_MANAGER_ADAPTERS[providerCode] ?? CHANNEL_MANAGER_ADAPTERS.manual_channel;
}

export async function syncOtaChannelAvailability(request: ChannelSyncRequest): Promise<ChannelSyncResult> {
  const adapter = getChannelManagerAdapter(request.channel);

  return adapter.pushAvailability({
    connectionId: request.channel,
    propertyId: request.propertyId,
    dateRange: { start: request.from, end: request.to },
    inventoryDays: [],
    idempotencyKey: `${request.propertyId}:${request.channel}:${request.from}:${request.to}`
  });
}
