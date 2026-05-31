export const OBSERVABILITY_HEADERS = {
  correlationId: "x-correlation-id",
  requestId: "x-request-id",
  serviceName: "x-service-name"
} as const;

export const SERVICE_NAMES = {
  api: "hotelos-api",
  aiGateway: "hotelos-ai-gateway",
  worker: "hotelos-worker",
  mobile: "hotelos-mobile"
} as const;

export const TELEMETRY_EXPORTERS = ["opentelemetry", "sentry", "prometheus"] as const;

export type DependencyStatus = "ok" | "degraded" | "unconfigured";

export type HealthResponse = {
  status: "ok" | "degraded";
  service: string;
  timestamp: string;
  dependencies: Record<string, DependencyStatus>;
  telemetry: {
    traces: "opentelemetry";
    errors: "sentry";
    metrics: "prometheus";
  };
};

export function buildHealthResponse(input: {
  service: string;
  dependencies?: Record<string, DependencyStatus>;
  now?: Date;
}): HealthResponse {
  const dependencies = input.dependencies ?? {};
  const degraded = Object.values(dependencies).some((status) => status !== "ok");

  return {
    status: degraded ? "degraded" : "ok",
    service: input.service,
    timestamp: (input.now ?? new Date()).toISOString(),
    dependencies,
    telemetry: {
      traces: "opentelemetry",
      errors: "sentry",
      metrics: "prometheus"
    }
  };
}
