// Contabilidad · who recorded an entry (`JournalEntryView.createdBy` and the
// `createdBy` of gestoría exports, VAT settlements and payables).
//
// The API stores the id of the session that posted (`context.userId`) or the
// SYSTEM_USER_ID of the CLI that wrote the rows (`usr_system_*`, one per
// script in apps/api/src/scripts/*.ts: replay, chart provision, relabel…).
// Neither string is meant for a person, so the screens never paint a raw id
// (qa#10): a system actor is named by its process in Spanish, the current
// session by its own name, and anybody else as «otro usuario» until the API
// resolves names (the audit trail keeps the exact id).
//
// Pure module on purpose — no React, no services — so it runs under
// `node --test` without `import.meta.env`; accounting-ui.ts re-exports it.

export const SYSTEM_ACTOR_PREFIX = "usr_system_";

/**
 * Spanish name of each system process that writes accounting rows. Keys are
 * the `SYSTEM_USER_ID` constants of apps/api/src/scripts/*.ts (the unit test
 * of this module cross-checks the two lists).
 */
export const SYSTEM_ACTOR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  usr_system_accounting_replay: "re-proyección contable",
  usr_system_accounting_provision: "provisión del plan de cuentas",
  usr_system_accounting_relabel: "reetiquetado de la cuenta de clientes",
  usr_system_demo_refresh: "refresco de los datos de demostración",
  usr_system_pilot_provision: "alta de la propiedad piloto",
  usr_system_pms_import: "importación del histórico del PMS",
  usr_system_channels_seed: "carga de canales de prueba",
  // Tanda 6b: backfill of the sociedad, centre codes and VeriFactu installations, and the Faranda → CELUISMA migration CLI (L8).
  usr_system_legal_structure: "alta de la estructura societaria",
  usr_system_faranda_celuisma: "migración de Faranda a CELUISMA"
});

export const SYSTEM_ACTOR_FALLBACK_LABEL = "Sistema";

/** Minimal shape of the stored session (services/auth-storage `AuthUser`). */
export type ActorSession = { userId: string; fullName?: string | null } | null | undefined;

export type ActorKind = "system" | "self" | "user";

export type ActorLabel = { kind: ActorKind; label: string };

export function isSystemActor(actorId: string): boolean {
  return actorId.startsWith(SYSTEM_ACTOR_PREFIX);
}

/**
 * Human label of an actor id, or null when nothing was recorded.
 * · `usr_system_*` → «Sistema · <proceso>» (or «Sistema» for an unknown process)
 * · the session's own id → its full name (or «ti» when the session has none)
 * · another user → the name found in `names` (id → full name) or «otro usuario»
 */
export function actorLabel(actorId: string | null | undefined, session?: ActorSession, names?: Readonly<Record<string, string>>): ActorLabel | null {
  const id = actorId?.trim() ?? "";
  if (id === "") return null;
  if (isSystemActor(id)) {
    const process = SYSTEM_ACTOR_LABELS[id];
    return { kind: "system", label: process ? `${SYSTEM_ACTOR_FALLBACK_LABEL} · ${process}` : SYSTEM_ACTOR_FALLBACK_LABEL };
  }
  if (session && session.userId === id) {
    const name = session.fullName?.trim();
    return { kind: "self", label: name || "ti" };
  }
  const known = names?.[id]?.trim();
  return { kind: "user", label: known || "otro usuario" };
}

/**
 * Caption under a «Contabilizado» / «Generado» stat: «por Carmen Ferreiro»,
 * «por ti», «por otro usuario» or, for a system actor, the process itself
 * («Sistema · re-proyección contable»). Undefined when nothing was recorded.
 */
export function actorHint(actorId: string | null | undefined, session?: ActorSession, names?: Readonly<Record<string, string>>): string | undefined {
  const actor = actorLabel(actorId, session, names);
  if (!actor) return undefined;
  return actor.kind === "system" ? actor.label : `por ${actor.label}`;
}
