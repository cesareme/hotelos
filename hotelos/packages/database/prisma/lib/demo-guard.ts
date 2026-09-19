// Demo-target guard shared by every parameterisable seed (Tanda 4 · DATA-05).
//
// Before a seed writes (or, worse, deleteMany's) anything for a SEED_ORG_ID /
// SEED_PROPERTY_ID, it calls `assertDemoTarget`. Targets on the demo allowlist
// (org_123 / prop_123 / prop_canary) pass. Any other target — a real hotel, an
// AUDIT fixture org — is refused with exit code 2 unless the operator sets
// BOTH `SEED_ALLOW_REAL=1` and `SEED_CONFIRM=<exact id>` (comma-separated when
// several targets are involved). The planned writes are always printed first
// so the refusal message doubles as the summary of what would have happened.
//
// This module is imported by prisma/seed-*.ts (run through tsx) AND by
// seeds/demo-pre-demo-enrichment.mjs (also through tsx: `corepack pnpm
// --filter @hotelos/database db:seed:enrich`; plain `node` can strip the
// types of this file but cannot resolve `@hotelos/database`, which only
// resolves through the tsconfig paths). Keep it dependency-free and
// restricted to erasable TypeScript syntax: no enums, no parameter
// properties, no namespaces.

// Tanda UX-1 (lote U1): el tenant aislado del «día de prueba» de recepción
// (prisma/seed-ux-day.ts) también es demo: org_uxday / prop_uxday.
export const DEMO_ORG_IDS: readonly string[] = ["org_123", "org_uxday"];
export const DEMO_PROPERTY_IDS: readonly string[] = ["prop_123", "prop_canary", "prop_uxday"];

/** One write the seed intends to perform (printed before the decision). */
export type PlannedWrite = {
  table: string;
  op: "deleteMany" | "createMany" | "upsert" | "update" | "create";
  where?: string;
  count?: number;
};

export type DemoTargetInput = {
  orgId?: string | null;
  propertyId?: string | null;
  /** Human label of the seed / scope, e.g. "seed-commercial-demo (scope full)". */
  action: string;
  planned?: PlannedWrite[];
};

export type DemoGuardEnv = {
  SEED_ALLOW_REAL?: string;
  SEED_CONFIRM?: string;
};

export type DemoGuardDecision =
  | { allowed: true; via: "allowlist" | "confirmed"; targets: string[] }
  | { allowed: false; targets: string[]; missing: string[]; reason: string };

export function isDemoOrg(id: string | null | undefined): boolean {
  return typeof id === "string" && DEMO_ORG_IDS.includes(id);
}

export function isDemoProperty(id: string | null | undefined): boolean {
  return typeof id === "string" && DEMO_PROPERTY_IDS.includes(id);
}

/** Ids explicitly confirmed by the operator (only honoured with SEED_ALLOW_REAL=1). */
export function confirmedTargets(env: DemoGuardEnv): string[] {
  if (env.SEED_ALLOW_REAL !== "1") return [];
  return (env.SEED_CONFIRM ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Pure decision: allowlist → ok; otherwise SEED_ALLOW_REAL=1 + SEED_CONFIRM=<id> per non-demo target. */
export function evaluateDemoTarget(input: DemoTargetInput, env: DemoGuardEnv = process.env): DemoGuardDecision {
  const targets: string[] = [];
  if (typeof input.orgId === "string" && input.orgId.length > 0) targets.push(input.orgId);
  if (typeof input.propertyId === "string" && input.propertyId.length > 0) targets.push(input.propertyId);
  if (targets.length === 0) {
    return { allowed: false, targets, missing: [], reason: "El seed no indicó ninguna organización ni propiedad objetivo." };
  }
  const nonDemo = targets.filter((t) => !isDemoOrg(t) && !isDemoProperty(t));
  if (nonDemo.length === 0) return { allowed: true, via: "allowlist", targets };
  if (env.SEED_ALLOW_REAL !== "1") {
    return {
      allowed: false,
      targets,
      missing: nonDemo,
      reason: `Objetivo fuera de la allowlist demo (${nonDemo.join(", ")}): exporta SEED_ALLOW_REAL=1 y SEED_CONFIRM=${nonDemo.join(",")} para confirmarlo.`
    };
  }
  const confirmed = confirmedTargets(env);
  const missing = nonDemo.filter((t) => !confirmed.includes(t));
  if (missing.length > 0) {
    return {
      allowed: false,
      targets,
      missing,
      reason: `SEED_CONFIRM no coincide con el objetivo: falta ${missing.join(", ")} (SEED_CONFIRM=${confirmed.join(",") || "<vacío>"}).`
    };
  }
  return { allowed: true, via: "confirmed", targets };
}

export function formatPlannedWrites(planned: PlannedWrite[] | undefined): string[] {
  if (!planned || planned.length === 0) return ["  (sin deleteMany previstos)"];
  return planned.map((p) => {
    const count = typeof p.count === "number" ? ` ×${p.count}` : "";
    const where = p.where ? ` — ${p.where}` : "";
    return `  ${p.op.padEnd(10)} ${p.table}${count}${where}`;
  });
}

export type DemoGuardIo = {
  env?: DemoGuardEnv;
  log?: (line: string) => void;
  exit?: (code: number) => void;
};

/**
 * Prints the planned writes, then either returns the decision (allowed) or
 * logs the refusal in Spanish and exits with code 2 without touching the DB.
 * `io` exists for tests; production callers pass nothing.
 */
export function assertDemoTarget(input: DemoTargetInput, io: DemoGuardIo = {}): DemoGuardDecision {
  const log = io.log ?? ((line: string) => console.error(line));
  const exit = io.exit ?? ((code: number) => process.exit(code));
  const decision = evaluateDemoTarget(input, io.env ?? process.env);

  log(`[demo-guard] ${input.action} → objetivo ${decision.targets.join(" / ") || "(ninguno)"}`);
  for (const line of formatPlannedWrites(input.planned)) log(line);

  if (!decision.allowed) {
    log(`[demo-guard] BLOQUEADO: ${decision.reason}`);
    log("[demo-guard] Nada escrito. Allowlist demo: " + [...DEMO_ORG_IDS, ...DEMO_PROPERTY_IDS].join(", ") + ".");
    exit(2);
    // A test-provided `exit` may return; never let the caller continue as if allowed.
    throw new Error(`[demo-guard] objetivo no permitido: ${decision.reason}`);
  }
  log(`[demo-guard] permitido (${decision.via === "allowlist" ? "allowlist demo" : "confirmado con SEED_ALLOW_REAL/SEED_CONFIRM"}).`);
  return decision;
}
