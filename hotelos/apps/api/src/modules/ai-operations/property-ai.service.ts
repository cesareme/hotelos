import { prisma } from "@hotelos/database";
import { createId } from "../../lib/ids.js";
import { recordDomainEvent } from "../audit/audit.service.js";

// Sprint 51 — Property AI settings. Per-property master switch + defaults for
// the whole AI surface. Per-tool overrides live in PropertyAiToolSetting
// (Sprint 47) and are intentionally NOT touched here.

export const AUTOMATION_LEVELS = ["off", "suggest", "suggest_and_confirm", "autonomous"] as const;
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];

// Voice locales we surface in the picker. The stored value is an open string[]
// so callers may extend it, but these are the curated, supported defaults.
export const SUPPORTED_VOICE_LOCALES = [
  "es-ES",
  "en-GB",
  "ca-ES",
  "fr-FR",
  "de-DE",
  "it-IT",
  "pt-PT",
  "nl-NL"
] as const;

const DEFAULT_DISCLOSURE =
  "Parte de la atención de este establecimiento puede estar gestionada por un asistente de inteligencia artificial. " +
  "Puede solicitar hablar con una persona del equipo en cualquier momento.\n" +
  "Some interactions at this property may be handled by an AI assistant. " +
  "You can ask to speak with a member of our team at any time.";

export type PropertyAiSettings = {
  propertyId: string;
  aiEnabled: boolean;
  defaultAutomationLevel: AutomationLevel;
  guestFacingDisclosure: string | null;
  voiceLocales: string[];
  configurationJson: Record<string, unknown>;
  updatedAt: string | null;
  // True when no row exists yet and these are computed fallbacks.
  isDefault: boolean;
};

export type ReadinessCheck = {
  key: string;
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
};

export type AiReadiness = {
  propertyId: string;
  checks: ReadinessCheck[];
  ready: boolean;
};

export type ConfiguredPropertySummary = {
  propertyId: string;
  propertyName: string;
  configured: boolean;
  aiEnabled: boolean;
  defaultAutomationLevel: AutomationLevel;
  disclosureSet: boolean;
  voiceLocaleCount: number;
  updatedAt: string | null;
};

export type UpdatePropertyAiSettingsInput = {
  propertyId: string;
  aiEnabled?: boolean;
  defaultAutomationLevel?: AutomationLevel;
  guestFacingDisclosure?: string | null;
  voiceLocales?: string[];
  configurationJson?: Record<string, unknown>;
  // Optional actor context for the emitted domain event.
  organizationId?: string;
  actorUserId?: string;
};

function isAutomationLevel(value: unknown): value is AutomationLevel {
  return typeof value === "string" && (AUTOMATION_LEVELS as readonly string[]).includes(value);
}

function toConfig(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function defaultSettings(propertyId: string): PropertyAiSettings {
  return {
    propertyId,
    aiEnabled: true,
    defaultAutomationLevel: "suggest_and_confirm",
    guestFacingDisclosure: DEFAULT_DISCLOSURE,
    voiceLocales: ["es-ES", "en-GB"],
    configurationJson: {},
    updatedAt: null,
    isDefault: true
  };
}

type PropertyAiSettingRow = {
  propertyId: string;
  aiEnabled: boolean;
  defaultAutomationLevel: string;
  guestFacingDisclosure: string | null;
  voiceLocales: string[];
  configurationJson: unknown;
  updatedAt: Date;
};

function mapRow(row: PropertyAiSettingRow): PropertyAiSettings {
  return {
    propertyId: row.propertyId,
    aiEnabled: row.aiEnabled,
    defaultAutomationLevel: isAutomationLevel(row.defaultAutomationLevel)
      ? row.defaultAutomationLevel
      : "suggest_and_confirm",
    guestFacingDisclosure: row.guestFacingDisclosure,
    voiceLocales: Array.isArray(row.voiceLocales) ? row.voiceLocales : [],
    configurationJson: toConfig(row.configurationJson),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    isDefault: false
  };
}

/**
 * Returns the property's AI setting row, or sensible defaults when none has
 * been saved yet. Defaults intentionally leave AI enabled with a safe
 * suggest_and_confirm level so the surface is usable but never autonomous
 * without an explicit decision.
 */
export async function getPropertyAiSettings(propertyId: string): Promise<PropertyAiSettings> {
  if (!propertyId) return defaultSettings("");
  const row = (await prisma.propertyAiSetting.findUnique({
    where: { propertyId }
  })) as PropertyAiSettingRow | null;
  if (!row) return defaultSettings(propertyId);
  return mapRow(row);
}

/**
 * Upsert the per-property AI settings by propertyId and emit a
 * PropertyAiSettingsUpdated domain event.
 *
 * GUARDRAIL: switching defaultAutomationLevel to "autonomous" requires
 * configurationJson.autonomousApprovedBy to be set. Running autonomous AI for
 * the whole property is a deliberate decision and must carry an approver of
 * record. We evaluate against the *effective* configuration (incoming patch
 * merged over the persisted config) so the approver can be supplied in the
 * same request that flips the level.
 */
export async function updatePropertyAiSettings(
  input: UpdatePropertyAiSettingsInput
): Promise<PropertyAiSettings> {
  const { propertyId } = input;
  if (!propertyId) {
    throw new Error("propertyId is required.");
  }

  if (input.defaultAutomationLevel !== undefined && !isAutomationLevel(input.defaultAutomationLevel)) {
    throw new Error(
      `Invalid automation level. Expected one of: ${AUTOMATION_LEVELS.join(", ")}.`
    );
  }

  const existing = (await prisma.propertyAiSetting.findUnique({
    where: { propertyId }
  })) as PropertyAiSettingRow | null;

  // Effective values after applying the patch over what exists (or defaults).
  const base = existing ? mapRow(existing) : defaultSettings(propertyId);
  const effectiveLevel = input.defaultAutomationLevel ?? base.defaultAutomationLevel;
  const effectiveConfig =
    input.configurationJson !== undefined
      ? toConfig(input.configurationJson)
      : base.configurationJson;

  // Guardrail: autonomous requires an explicit approver of record.
  if (effectiveLevel === "autonomous") {
    const approvedBy = effectiveConfig.autonomousApprovedBy;
    if (!approvedBy || (typeof approvedBy === "string" && approvedBy.trim() === "")) {
      throw new Error(
        "Autonomous automation requires configurationJson.autonomousApprovedBy to be set. " +
          "Running fully autonomous AI for the property is a deliberate decision and must record who approved it."
      );
    }
  }

  const updateData: Record<string, unknown> = {};
  if (input.aiEnabled !== undefined) updateData.aiEnabled = input.aiEnabled;
  if (input.defaultAutomationLevel !== undefined) updateData.defaultAutomationLevel = input.defaultAutomationLevel;
  if (input.guestFacingDisclosure !== undefined) updateData.guestFacingDisclosure = input.guestFacingDisclosure;
  if (input.voiceLocales !== undefined) updateData.voiceLocales = input.voiceLocales;
  if (input.configurationJson !== undefined) updateData.configurationJson = effectiveConfig as object;

  const row = (await prisma.propertyAiSetting.upsert({
    where: { propertyId },
    update: updateData,
    create: {
      propertyId,
      aiEnabled: input.aiEnabled ?? base.aiEnabled,
      defaultAutomationLevel: input.defaultAutomationLevel ?? base.defaultAutomationLevel,
      guestFacingDisclosure:
        input.guestFacingDisclosure !== undefined ? input.guestFacingDisclosure : base.guestFacingDisclosure,
      voiceLocales: input.voiceLocales ?? base.voiceLocales,
      configurationJson: (input.configurationJson !== undefined ? effectiveConfig : base.configurationJson) as object
    }
  })) as PropertyAiSettingRow;

  const settings = mapRow(row);

  // Resolve the owning organization for the event envelope.
  let organizationId = input.organizationId;
  if (!organizationId) {
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { organizationId: true }
    });
    organizationId = property?.organizationId ?? "";
  }

  recordDomainEvent({
    organizationId,
    propertyId,
    entityType: "property_ai_setting",
    entityId: propertyId,
    eventType: "PropertyAiSettingsUpdated",
    payload: {
      aiEnabled: settings.aiEnabled,
      defaultAutomationLevel: settings.defaultAutomationLevel,
      disclosureSet: Boolean(settings.guestFacingDisclosure && settings.guestFacingDisclosure.trim()),
      voiceLocales: settings.voiceLocales
    },
    actorType: input.actorUserId ? "user" : "system",
    actorUserId: input.actorUserId,
    correlationId: createId("corr")
  });

  return settings;
}

/**
 * Surface whether the property's AI is safely configured. These are the
 * minimum bars before AI should be relied on in front of guests.
 */
export async function aiReadiness(propertyId: string): Promise<AiReadiness> {
  const settings = await getPropertyAiSettings(propertyId);
  const checks: ReadinessCheck[] = [];

  // 1. Master switch.
  checks.push(
    settings.aiEnabled
      ? { key: "enabled", label: "AI enabled", status: "ok", detail: "AI is enabled for this property." }
      : {
          key: "enabled",
          label: "AI enabled",
          status: "warn",
          detail: "AI is currently disabled. No AI features will run for this property."
        }
  );

  // 2. Guest-facing disclosure (legal requirement for guest-facing AI).
  const hasDisclosure = Boolean(settings.guestFacingDisclosure && settings.guestFacingDisclosure.trim());
  checks.push(
    hasDisclosure
      ? {
          key: "disclosure",
          label: "Guest-facing disclosure",
          status: "ok",
          detail: "A guest-facing AI disclosure is configured."
        }
      : {
          key: "disclosure",
          label: "Guest-facing disclosure",
          status: "error",
          detail:
            "No guest-facing disclosure set. Disclosing AI involvement to guests is a legal requirement."
        }
  );

  // 3. At least one voice locale.
  checks.push(
    settings.voiceLocales.length > 0
      ? {
          key: "voice_locales",
          label: "Voice locales",
          status: "ok",
          detail: `${settings.voiceLocales.length} locale(s) configured: ${settings.voiceLocales.join(", ")}.`
        }
      : {
          key: "voice_locales",
          label: "Voice locales",
          status: "warn",
          detail: "No voice locales configured. Voice AI will have no language to respond in."
        }
  );

  // 4. Automation level sane (a valid level; autonomous must carry approval).
  let automationCheck: ReadinessCheck;
  if (!isAutomationLevel(settings.defaultAutomationLevel)) {
    automationCheck = {
      key: "automation_level",
      label: "Automation level",
      status: "error",
      detail: "Automation level is not recognized."
    };
  } else if (settings.defaultAutomationLevel === "autonomous") {
    const approvedBy = settings.configurationJson.autonomousApprovedBy;
    automationCheck =
      approvedBy && (typeof approvedBy !== "string" || approvedBy.trim() !== "")
        ? {
            key: "automation_level",
            label: "Automation level",
            status: "ok",
            detail: `Autonomous, approved by ${String(approvedBy)}.`
          }
        : {
            key: "automation_level",
            label: "Automation level",
            status: "error",
            detail: "Autonomous automation is set without an approver of record."
          };
  } else {
    automationCheck = {
      key: "automation_level",
      label: "Automation level",
      status: "ok",
      detail: `Default automation level is "${settings.defaultAutomationLevel}".`
    };
  }
  checks.push(automationCheck);

  const ready = checks.every((check) => check.status === "ok");
  return { propertyId, checks, ready };
}

/**
 * Org-wide quick view: every property of the organization with its AI setting
 * summary. Properties without a saved row are reported as not configured but
 * still surfaced so gaps are visible.
 */
export async function listConfiguredProperties(
  organizationId: string
): Promise<ConfiguredPropertySummary[]> {
  if (!organizationId) return [];

  const properties = await prisma.property.findMany({
    where: { organizationId },
    select: { id: true, name: true },
    orderBy: { name: "asc" }
  });
  if (properties.length === 0) return [];

  const settings = (await prisma.propertyAiSetting.findMany({
    where: { propertyId: { in: properties.map((p) => p.id) } }
  })) as PropertyAiSettingRow[];
  const byProperty = new Map(settings.map((row) => [row.propertyId, mapRow(row)]));

  return properties.map((property) => {
    const setting = byProperty.get(property.id);
    if (!setting) {
      const fallback = defaultSettings(property.id);
      return {
        propertyId: property.id,
        propertyName: property.name,
        configured: false,
        aiEnabled: fallback.aiEnabled,
        defaultAutomationLevel: fallback.defaultAutomationLevel,
        disclosureSet: Boolean(fallback.guestFacingDisclosure && fallback.guestFacingDisclosure.trim()),
        voiceLocaleCount: fallback.voiceLocales.length,
        updatedAt: null
      };
    }
    return {
      propertyId: property.id,
      propertyName: property.name,
      configured: true,
      aiEnabled: setting.aiEnabled,
      defaultAutomationLevel: setting.defaultAutomationLevel,
      disclosureSet: Boolean(setting.guestFacingDisclosure && setting.guestFacingDisclosure.trim()),
      voiceLocaleCount: setting.voiceLocales.length,
      updatedAt: setting.updatedAt
    };
  });
}
