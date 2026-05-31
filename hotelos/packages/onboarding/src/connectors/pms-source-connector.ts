export type PmsSourceProviderCode =
  | "mews"
  | "oracle_ohip"
  | "cloudbeds"
  | "apaleo"
  | "generic_openapi"
  | "generic_csv"
  | "generic_xlsx"
  | "generic_pdf_report"
  | "manual";

export type TestSourceConnectionInput = {
  connectionId: string;
  credentialsSecretRef?: string;
  config: Record<string, unknown>;
};

export type TestSourceConnectionResult = {
  ok: boolean;
  providerCode: PmsSourceProviderCode;
  status: "connected" | "stub" | "error";
  message: string;
};

export type PullSourceInput = {
  connectionId: string;
  since?: string;
  until?: string;
};

export type SourcePropertyProfile = Record<string, unknown>;
export type SourceRoom = Record<string, unknown>;
export type SourceRoomType = Record<string, unknown>;
export type SourceRatePlan = Record<string, unknown>;
export type SourceReservation = Record<string, unknown>;
export type SourceGuest = Record<string, unknown>;
export type SourceCompany = Record<string, unknown>;
export type SourceChannel = Record<string, unknown>;
export type SourceChannelMapping = Record<string, unknown>;
export type SourceRevenueSnapshot = Record<string, unknown>;

export interface PmsSourceConnector {
  providerCode: PmsSourceProviderCode;
  testConnection(input: TestSourceConnectionInput): Promise<TestSourceConnectionResult>;
  pullPropertyProfile(input: PullSourceInput): Promise<SourcePropertyProfile>;
  pullRooms(input: PullSourceInput): Promise<SourceRoom[]>;
  pullRoomTypes(input: PullSourceInput): Promise<SourceRoomType[]>;
  pullRatePlans(input: PullSourceInput): Promise<SourceRatePlan[]>;
  pullReservations(input: PullSourceInput): Promise<SourceReservation[]>;
  pullGuests(input: PullSourceInput): Promise<SourceGuest[]>;
  pullCompanies(input: PullSourceInput): Promise<SourceCompany[]>;
  pullChannels(input: PullSourceInput): Promise<SourceChannel[]>;
  pullChannelMappings(input: PullSourceInput): Promise<SourceChannelMapping[]>;
  pullRevenueHistory(input: PullSourceInput): Promise<SourceRevenueSnapshot[]>;
}

function createStubPmsSourceConnector(providerCode: PmsSourceProviderCode): PmsSourceConnector {
  return {
    providerCode,
    async testConnection() {
      return {
        ok: providerCode === "manual" || providerCode.startsWith("generic"),
        providerCode,
        status: providerCode === "manual" || providerCode.startsWith("generic") ? "connected" : "stub",
        message: `${providerCode} adapter is scaffolded. Real API credentials stay in the secret manager before production sync.`
      };
    },
    async pullPropertyProfile() {
      return { sourceSystem: providerCode, status: "stub", requiresReview: true };
    },
    async pullRooms() {
      return [];
    },
    async pullRoomTypes() {
      return [];
    },
    async pullRatePlans() {
      return [];
    },
    async pullReservations() {
      return [];
    },
    async pullGuests() {
      return [];
    },
    async pullCompanies() {
      return [];
    },
    async pullChannels() {
      return [];
    },
    async pullChannelMappings() {
      return [];
    },
    async pullRevenueHistory() {
      return [];
    }
  };
}

export const PMS_SOURCE_CONNECTORS: Record<string, PmsSourceConnector> = {
  mews_connector_adapter: createStubPmsSourceConnector("mews"),
  oracle_ohip_adapter: createStubPmsSourceConnector("oracle_ohip"),
  cloudbeds_adapter: createStubPmsSourceConnector("cloudbeds"),
  apaleo_adapter: createStubPmsSourceConnector("apaleo"),
  generic_csv_adapter: createStubPmsSourceConnector("generic_csv"),
  generic_xlsx_adapter: createStubPmsSourceConnector("generic_xlsx"),
  generic_pdf_report_adapter: createStubPmsSourceConnector("generic_pdf_report"),
  manual_setup_adapter: createStubPmsSourceConnector("manual")
};
