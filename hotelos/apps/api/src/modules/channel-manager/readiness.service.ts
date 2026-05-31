// Go-live readiness checklist for a channel.
//
// Sprint 44: before a hotelier flips a channel to "active" with real OTA
// credentials, they need a single, honest answer to "is this safe to go live?".
// The aggregator's push paths fail at runtime when mappings or credentials are
// missing — this service surfaces those gaps *ahead* of time as a checklist.
//
// Checks:
//   (a) credentials present  — Channel.configurationJson.credentials non-null
//                              AND contains the provider's required keys.
//   (b) room mappings complete  — every active room type is mapped.
//   (c) rate mappings complete  — every active rate plan is mapped.
//   (d) recent successful push  — a ChannelSyncJob with status=success in the
//                                 last 7 days (test_credentials counts too — it
//                                 proves the credential round-trip works).
//   (e) adapter mode  — stub / sandbox / real. `real` is required for go-live;
//                       `sandbox` is "warn" (validated locally but not live);
//                       `stub` is "error" (nothing actually leaves the box).
//
// readyToGoLive = every check is "ok".

import { prisma } from "@hotelos/database";
import { mappingCoverage } from "./mapping.service.js";

export type ReadinessCheckStatus = "ok" | "warn" | "error";

export type ReadinessCheck = {
  key: string;
  label: string;
  status: ReadinessCheckStatus;
  detail: string;
};

export type ChannelReadiness = {
  channelId: string;
  providerCode: string;
  adapterMode: AdapterMode;
  checks: ReadinessCheck[];
  readyToGoLive: boolean;
};

type AdapterMode = "stub" | "sandbox" | "real";

// Per-provider required credential keys. Booking authenticates via OAuth2
// client-credentials; the rest carry an apiKey/secret pair or a listing id.
// `accept` lets us treat snake_case and camelCase as equivalent.
const REQUIRED_CREDENTIAL_KEYS: Record<string, string[][]> = {
  booking: [["client_id", "clientId"], ["client_secret", "clientSecret"]],
  expedia: [["apiKey", "api_key"], ["resortID", "resortId"]],
  airbnb: [["apiKey", "api_key"], ["listingId", "listing_id"]],
  hotelbeds: [["apiKey", "api_key"], ["secret"]],
  vrbo: [["apiKey", "api_key"], ["propertyId", "property_id"]]
};

// Mirrors each adapter's `resolveMode()`: BOOKING_ADAPTER_MODE, EXPEDIA_ADAPTER_MODE, etc.
// Only "real" and "sandbox" are explicit modes; everything else is "stub".
export function resolveAdapterMode(providerCode: string): AdapterMode {
  const envKey = `${providerCode.toUpperCase()}_ADAPTER_MODE`;
  const value = (process.env[envKey] ?? "").toLowerCase();
  if (value === "real") return "real";
  if (value === "sandbox") return "sandbox";
  return "stub";
}

function hasCredentialKey(creds: Record<string, unknown>, aliases: string[]): boolean {
  return aliases.some((alias) => {
    const v = creds[alias];
    return typeof v === "string" ? v.length > 0 : v !== undefined && v !== null;
  });
}

function credentialsCheck(providerCode: string, configurationJson: unknown): ReadinessCheck {
  const config = (configurationJson ?? {}) as Record<string, unknown>;
  const creds = (config.credentials as Record<string, unknown> | undefined) ?? null;
  if (!creds || Object.keys(creds).length === 0) {
    return {
      key: "credentials",
      label: "Credentials configured",
      status: "error",
      detail: "No credentials saved for this channel."
    };
  }
  const required = REQUIRED_CREDENTIAL_KEYS[providerCode.toLowerCase()] ?? [];
  const missing = required.filter((aliases) => !hasCredentialKey(creds, aliases));
  if (missing.length > 0) {
    return {
      key: "credentials",
      label: "Credentials configured",
      status: "error",
      detail: `Missing required credential${missing.length > 1 ? "s" : ""}: ${missing
        .map((aliases) => aliases[0])
        .join(", ")}.`
    };
  }
  return {
    key: "credentials",
    label: "Credentials configured",
    status: "ok",
    detail: "All required credentials are present."
  };
}

function adapterModeCheck(mode: AdapterMode): ReadinessCheck {
  if (mode === "real") {
    return {
      key: "adapter_mode",
      label: "Adapter mode",
      status: "ok",
      detail: "Adapter is in real mode — live OTA traffic."
    };
  }
  if (mode === "sandbox") {
    return {
      key: "adapter_mode",
      label: "Adapter mode",
      status: "warn",
      detail: "Adapter is in sandbox mode — real HTTP round-trip to a local mock, not live OTA."
    };
  }
  return {
    key: "adapter_mode",
    label: "Adapter mode",
    status: "error",
    detail: "Adapter is in stub mode — nothing leaves the server. Switch to real mode for go-live."
  };
}

export async function channelReadiness(channelId: string): Promise<ChannelReadiness> {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) throw new Error(`Channel not found: ${channelId}`);

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [coverage, recentSuccess] = await Promise.all([
    mappingCoverage(channelId),
    prisma.channelSyncJob.findFirst({
      where: { channelId, status: "success", createdAt: { gte: sevenDaysAgo } },
      orderBy: { createdAt: "desc" }
    })
  ]);

  const adapterMode = resolveAdapterMode(channel.providerCode);

  const checks: ReadinessCheck[] = [
    credentialsCheck(channel.providerCode, channel.configurationJson),
    {
      key: "room_mappings",
      label: "Room mappings complete",
      status: coverage.roomTypesTotal === 0 ? "error" : coverage.complete || coverage.roomTypesMapped >= coverage.roomTypesTotal ? "ok" : "error",
      detail:
        coverage.roomTypesTotal === 0
          ? "No active room types to map."
          : `${coverage.roomTypesMapped}/${coverage.roomTypesTotal} room types mapped.`
    },
    {
      key: "rate_mappings",
      label: "Rate mappings complete",
      status: coverage.ratePlansTotal === 0 ? "error" : coverage.ratePlansMapped >= coverage.ratePlansTotal ? "ok" : "error",
      detail:
        coverage.ratePlansTotal === 0
          ? "No active rate plans to map."
          : `${coverage.ratePlansMapped}/${coverage.ratePlansTotal} rate plans mapped.`
    },
    {
      key: "recent_success",
      label: "Recent successful sync",
      status: recentSuccess ? "ok" : "warn",
      detail: recentSuccess
        ? `Last successful ${recentSuccess.syncType} at ${recentSuccess.createdAt.toISOString()}.`
        : "No successful sync in the last 7 days. Run a test push first."
    },
    adapterModeCheck(adapterMode)
  ];

  const readyToGoLive = checks.every((c) => c.status === "ok");

  return {
    channelId,
    providerCode: channel.providerCode,
    adapterMode,
    checks,
    readyToGoLive
  };
}
