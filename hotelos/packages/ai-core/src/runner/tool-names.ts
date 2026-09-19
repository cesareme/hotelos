// Nombres legados de herramienta que ya viven en ai_tool_calls (recon §2.3):
// scan_id_document (server.ts), guest_message_reply (messaging.service.ts; las
// 2 filas de Faranda) y onboarding_mapping_suggest (server.ts). El runner
// resuelve el nombre canónico del registro para evaluar las puertas y acepta
// `recordAs` para persistir el nombre legado (tests/integration/
// l2-modulos-ia.test.mts:144 filtra por scan_id_document).

export const LEGACY_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  scan_id_document: "extractGuestIdentityFieldsTemporary",
  guest_message_reply: "answerGuestQuestion",
  onboarding_mapping_suggest: "suggestRoomTypeMapping"
});

/** Nombre canónico del registro (el propio nombre si no es un alias legado). */
export function canonicalToolName(name: string): string {
  const trimmed = (name ?? "").trim();
  return LEGACY_TOOL_NAME_ALIASES[trimmed] ?? trimmed;
}

export function isLegacyToolName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(LEGACY_TOOL_NAME_ALIASES, (name ?? "").trim());
}

/** Nombre legado que corresponde a un nombre canónico, si existe (para vistas históricas). */
export function legacyToolNameOf(canonicalName: string): string | null {
  for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_NAME_ALIASES)) {
    if (canonical === canonicalName) return legacy;
  }
  return null;
}
