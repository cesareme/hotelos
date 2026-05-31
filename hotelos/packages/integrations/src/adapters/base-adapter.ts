export type IntegrationAuthType = "api_key" | "oauth2" | "basic" | "certificate" | "webhook" | "manual";

export type IntegrationCapability =
  | "pull_reservations"
  | "push_availability"
  | "push_rates"
  | "send_payment_link"
  | "capture_payment"
  | "send_message"
  | "sync_invoice"
  | "sync_accounting"
  | "open_lock"
  | "create_guest_key"
  | "submit_compliance_record";

export type IntegrationTestResult = {
  status: "ok" | "failed";
  checkedAt: string;
  message?: string;
};

export interface IntegrationAdapter {
  providerCode: string;
  authType: IntegrationAuthType;
  capabilities: IntegrationCapability[];
  validateConnection(config: unknown): Promise<boolean>;
  testConnection(connectionId: string): Promise<IntegrationTestResult>;
  handleWebhook?(payload: unknown, headers: Record<string, string>): Promise<void>;
}

export abstract class BaseIntegrationAdapter implements IntegrationAdapter {
  abstract providerCode: string;
  abstract authType: IntegrationAuthType;
  abstract capabilities: IntegrationCapability[];

  async validateConnection(config: unknown): Promise<boolean> {
    return typeof config === "object" && config !== null;
  }

  async testConnection(connectionId: string): Promise<IntegrationTestResult> {
    return {
      status: connectionId ? "ok" : "failed",
      checkedAt: new Date().toISOString(),
      message: connectionId ? "Mock connection accepted." : "Missing connection id."
    };
  }
}
