// Unit tests of the user_property_roles → user_role_assignments backfill CLI
// (Tanda 8a · L3). No database: flag parsing (dry-run by default, --apply
// requires --confirm equal to --org, --general-manager takes a user id), the
// pure planner (property rows → property assignments; the same role in EVERY
// property → ONE organization assignment; custom role → organization;
// foreign / emergency rows blocked; users without rows reported) and the
// runner over the fake Prisma of the rbac module: a dry-run writes nothing,
// --apply writes inside the transaction, audits ROLE_ASSIGNED as system with
// the rbac_backfill_<run> correlation id, bumps rbac_version once, never
// touches user_property_roles, and a second pass creates +0. Run from apps/api:
//   node --import tsx --test src/scripts/__tests__/rbac-migrate-assignments.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROLE_PERMISSION_MAP } from "@hotelos/shared";
import type { RbacDb } from "../../lib/rbac-catalog.js";
import { audits, fakePrisma, seedRoles, type Tables } from "../../modules/rbac/__tests__/fake-prisma.mts";
import {
  BACKFILL_REASON,
  CORRELATION_PREFIX,
  USAGE,
  assertConfirmMatches,
  formatHuman,
  parseFlags,
  planIsBlocked,
  planMigration,
  runMigration,
  type LegacyRow,
  type MigrateDeps,
  type MigrateFlags,
  type PlanInput
} from "../rbac-migrate-assignments.js";

const ORG = "cmrhw9jy30002fyvb6tsdiugt";
const OTHER_ORG = "org_other";
const LT = "cmu1mifcp0000fyo1wzvq7txo";
const RA = "cmrhw9jy40003fyvbuu2ec2w7";
const PROPERTY_IDS = ["prop_oc", "prop_fn", "prop_as", LT, "prop_pg", "prop_ll", "prop_mc", RA];
const CARMEN = "usr_carmen";
const TILOS = "usr_tilos";
const NOW = new Date("2026-09-18T10:00:00.000Z");

const flagsFor = (argv: string[]): MigrateFlags => parseFlags(argv);

type Fixture = ReturnType<typeof farandaTables>;

/** Faranda as the local DB held it on 2026-09-18: 8 centres, Carmen Owner ×8, recepcion.tilos Recepción in LT. */
function farandaTables(options: { generalManagerRole?: boolean } = {}) {
  const tables: Partial<Tables> = {
    organization: [
      { id: ORG, name: "Faranda Hotels & Resorts", rbacVersion: 0 },
      { id: OTHER_ORG, name: "Otra organización", rbacVersion: 0 }
    ],
    property: [
      ...PROPERTY_IDS.map((id, index) => ({ id, organizationId: ORG, name: `Centro ${index + 1} (${id})`, legalEntityId: "le_celuisma", createdAt: new Date(2026, 0, index + 1) })),
      { id: "prop_foreign", organizationId: OTHER_ORG, name: "Hotel ajeno", legalEntityId: null, createdAt: new Date(2026, 0, 20) }
    ],
    user: [
      { id: CARMEN, organizationId: ORG, email: "direccion@farandariasaltas.es", fullName: "Carmen Vázquez Rey", status: "active" },
      { id: TILOS, organizationId: ORG, email: "recepcion.tilos@faranda.test", fullName: "Recepción Los Tilos", status: "active" },
      { id: "usr_sin_rol", organizationId: ORG, email: "sin.rol@faranda.test", fullName: "Sin rol", status: "invited" },
      { id: "usr_emergencia", organizationId: ORG, email: "emergencia-1@faranda.test", fullName: "Emergencia 1", status: "emergency" },
      { id: "usr_foreign", organizationId: OTHER_ORG, email: "otra@example.com", fullName: "Otra", status: "active" }
    ],
    userPropertyRole: [],
    userRoleAssignment: []
  };
  const roles = seedRoles(tables, ORG, {
    owner: ROLE_PERMISSION_MAP.owner,
    receptionist: ROLE_PERMISSION_MAP.receptionist,
    ...(options.generalManagerRole ? { general_manager: ROLE_PERMISSION_MAP.general_manager } : {})
  });
  const legacy: LegacyRow[] = [
    ...PROPERTY_IDS.map((propertyId, index) => ({ id: `upr_carmen_${index + 1}`, userId: CARMEN, propertyId, roleId: roles.owner.id })),
    { id: "upr_tilos", userId: TILOS, propertyId: LT, roleId: roles.receptionist.id }
  ];
  tables.userPropertyRole!.push(...legacy);
  return { tables, roles, legacy };
}

function planInputOf(fixture: Fixture, overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    organizationId: ORG,
    properties: fixture.tables.property as PlanInput["properties"],
    users: fixture.tables.user as PlanInput["users"],
    roles: fixture.tables.role as PlanInput["roles"],
    legacyRows: fixture.tables.userPropertyRole as PlanInput["legacyRows"],
    liveAssignments: [],
    now: NOW,
    ...overrides
  };
}

/** Cadena de auditoría espía (integrador 8a): registra hydrate/flush con cuántos eventos había en la cola en ese momento. */
function chainSpy(trail: ReturnType<typeof audits>): { chain: NonNullable<MigrateDeps["auditChain"]>; calls: Array<{ step: "hydrate" | "flush"; events: number }> } {
  const calls: Array<{ step: "hydrate" | "flush"; events: number }> = [];
  return {
    calls,
    chain: {
      hydrate: async () => {
        calls.push({ step: "hydrate", events: trail.events.length });
        return { auditTail: "tip" };
      },
      flush: async () => {
        calls.push({ step: "flush", events: trail.events.length });
      }
    }
  };
}

function depsOf(fixture: Fixture): { deps: MigrateDeps; db: ReturnType<typeof fakePrisma>; trail: ReturnType<typeof audits>; chain: ReturnType<typeof chainSpy> } {
  const db = fakePrisma(fixture.tables);
  const trail = audits();
  const chain = chainSpy(trail);
  return { deps: { db: db as unknown as RbacDb, audit: trail.audit as unknown as MigrateDeps["audit"], auditChain: chain.chain, now: () => NOW, runId: "test" }, db, trail, chain };
}

// ── Flags ─────────────────────────────────────────────────────────────────────

describe("parseFlags", () => {
  it("defaults to dry-run without --general-manager; --json and -- are accepted", () => {
    assert.deepEqual(parseFlags(["--org", ORG]), { org: ORG, apply: false, confirm: null, generalManager: null, json: false, help: false });
    assert.deepEqual(parseFlags(["--", "--org", ORG, "--dry-run", "--json"]).json, true);
    assert.equal(parseFlags(["--org", ORG, "--general-manager", CARMEN]).generalManager, CARMEN);
  });
  it("--help short-circuits and USAGE names every flag", () => {
    assert.equal(parseFlags(["--help"]).help, true);
    assert.equal(parseFlags(["-h", "--apply"]).help, true);
    for (const flag of ["--org", "--dry-run", "--apply", "--confirm", "--general-manager", "--json", "--help"]) assert.ok(USAGE.includes(flag), `USAGE mentions ${flag}`);
  });
  it("requires --org, rejects unknown flags, duplicated or valueless options", () => {
    assert.throws(() => parseFlags([]), /--org/);
    assert.throws(() => parseFlags(["--org", ORG, "--bogus"]), /Unknown flag "--bogus"/);
    assert.throws(() => parseFlags(["--org", ORG, "--org", "x"]), /only once/);
    assert.throws(() => parseFlags(["--org"]), /requires a value/);
    assert.throws(() => parseFlags(["--org", ORG, "--general-manager"]), /requires a value/);
    assert.throws(() => parseFlags(["--org", ORG, "--general-manager", "--json"]), /requires a value/);
  });
  it("--apply requires --confirm equal to --org (exit 2 path), --dry-run excludes --apply, --confirm alone is refused", () => {
    assert.throws(() => parseFlags(["--org", ORG, "--apply"]), /--apply requires --confirm/);
    assert.throws(() => parseFlags(["--org", ORG, "--confirm", ORG]), /only makes sense with --apply/);
    assert.throws(() => parseFlags(["--org", ORG, "--dry-run", "--apply", "--confirm", ORG]), /mutually exclusive/);
    const ok = parseFlags(["--org", ORG, "--apply", "--confirm", ORG]);
    assert.equal(ok.apply, true);
    assert.doesNotThrow(() => assertConfirmMatches(ok));
    assert.throws(() => assertConfirmMatches({ org: ORG, apply: true, confirm: "org_123" }), /does not match/);
    assert.doesNotThrow(() => assertConfirmMatches({ org: ORG, apply: false, confirm: null }));
  });
});

// ── Planner ───────────────────────────────────────────────────────────────────

describe("planMigration · Faranda (8 centres, Carmen Owner ×8, recepcion.tilos ×1)", () => {
  it("9 legacy rows → 2 assignments: owner / organization (8 rows folded) + receptionist / property LT", () => {
    const fixture = farandaTables();
    const plan = planMigration(planInputOf(fixture));
    assert.equal(plan.legacyRows, 9);
    assert.equal(plan.properties, 8);
    assert.equal(plan.planned.length, 2);
    const owner = plan.planned.find((row) => row.templateKey === "owner")!;
    assert.equal(owner.scopeType, "organization");
    assert.equal(owner.origin, "consolidated");
    assert.equal(owner.userId, CARMEN);
    assert.equal(owner.propertyId, null);
    assert.equal(owner.legacyRowIds.length, 8);
    const receptionist = plan.planned.find((row) => row.templateKey === "receptionist")!;
    assert.equal(receptionist.scopeType, "property");
    assert.equal(receptionist.propertyId, LT);
    assert.equal(receptionist.origin, "property");
    assert.deepEqual(receptionist.legacyRowIds, ["upr_tilos"]);
    assert.deepEqual(plan.counts, { organization: 1, property: 1, toCreate: 2, skipped: 0, blocked: 0, usersWithoutAssignment: 1 });
    assert.deepEqual(plan.usersWithoutAssignment.map((user) => user.email), ["sin.rol@faranda.test"], "emergency accounts are never listed as «sin asignación»");
    assert.equal(planIsBlocked(plan), false);
  });

  it("--general-manager adds general_manager / organization when the template role exists; without it the plan is BLOCKED with the reseed hint", () => {
    const withRole = farandaTables({ generalManagerRole: true });
    const plan = planMigration(planInputOf(withRole, { generalManagerUserId: CARMEN }));
    assert.equal(plan.planned.length, 3);
    const gm = plan.planned.find((row) => row.origin === "general-manager")!;
    assert.deepEqual([gm.userId, gm.templateKey, gm.scopeType, gm.legacyRowIds], [CARMEN, "general_manager", "organization", []]);
    assert.equal(plan.counts.organization, 2);

    const withoutRole = farandaTables();
    const blocked = planMigration(planInputOf(withoutRole, { generalManagerUserId: CARMEN }));
    assert.equal(blocked.planned.length, 2);
    assert.equal(blocked.blocked.length, 1);
    assert.match(blocked.blocked[0]!.reason, /general_manager/);
    assert.match(blocked.blocked[0]!.reason, /reseed-property-roles/);
    assert.equal(planIsBlocked(blocked), true);

    assert.throws(() => planMigration(planInputOf(withRole, { generalManagerUserId: "usr_foreign" })), /no es un usuario de la organización/);
    assert.throws(() => planMigration(planInputOf(withRole, { generalManagerUserId: "usr_missing" })), /no es un usuario de la organización/);
  });

  it("the same role in only SOME properties is not consolidated: one property assignment per row", () => {
    const fixture = farandaTables();
    const sevenOfEight = fixture.legacy.filter((row) => !(row.userId === CARMEN && row.propertyId === RA));
    const plan = planMigration(planInputOf(fixture, { legacyRows: sevenOfEight }));
    const carmen = plan.planned.filter((row) => row.userId === CARMEN);
    assert.equal(carmen.length, 7);
    assert.ok(carmen.every((row) => row.scopeType === "property" && row.origin === "property"));
    assert.equal(plan.counts.property, 8, "7 of Carmen + recepcion.tilos");
  });

  it("a custom role (template_key NULL, e.g. «Local Super Admin») becomes ONE organization assignment even with a single property row", () => {
    const tables: Partial<Tables> = {
      organization: [{ id: "org_123", name: "Grupo Hotelero Demo", rbacVersion: 0 }],
      property: [
        { id: "prop_123", organizationId: "org_123", name: "Hotel Demo Madrid Centro" },
        { id: "prop_canary", organizationId: "org_123", name: "Hotel Demo Tenerife Sur" }
      ],
      user: [{ id: "usr_123", organizationId: "org_123", email: "reception@example.com", fullName: "Reception", status: "active" }],
      role: [{ id: "role_local_super_admin", organizationId: "org_123", name: "Local Super Admin", templateKey: null, level: null, department: null, managed: true, templateVersion: 0 }],
      userPropertyRole: [{ id: "upr_123", userId: "usr_123", propertyId: "prop_123", roleId: "role_local_super_admin" }]
    };
    const plan = planMigration({ organizationId: "org_123", properties: tables.property as PlanInput["properties"], users: tables.user as PlanInput["users"], roles: tables.role as PlanInput["roles"], legacyRows: tables.userPropertyRole as PlanInput["legacyRows"], liveAssignments: [], now: NOW });
    assert.equal(plan.planned.length, 1);
    assert.deepEqual([plan.planned[0]!.scopeType, plan.planned[0]!.origin, plan.planned[0]!.templateKey, plan.planned[0]!.roleName], ["organization", "custom-role", null, "Local Super Admin"]);
    assert.deepEqual(plan.counts, { organization: 1, property: 0, toCreate: 1, skipped: 0, blocked: 0, usersWithoutAssignment: 0 });
  });

  it("rows of a foreign user / role / property, of the emergency template or of an emergency account are BLOCKED, never migrated", () => {
    const fixture = farandaTables();
    fixture.tables.role!.push({ id: "role_foreign", organizationId: OTHER_ORG, name: "Ajeno", templateKey: "manager", level: null, department: null, managed: true, templateVersion: 2 });
    fixture.tables.role!.push({ id: "role_bg", organizationId: ORG, name: "Emergencia", templateKey: "break_glass", level: null, department: null, managed: true, templateVersion: 2 });
    const rows: LegacyRow[] = [
      ...fixture.legacy,
      { id: "upr_foreign_role", userId: TILOS, propertyId: LT, roleId: "role_foreign" },
      { id: "upr_foreign_property", userId: TILOS, propertyId: "prop_foreign", roleId: fixture.roles.receptionist.id },
      { id: "upr_foreign_user", userId: "usr_foreign", propertyId: LT, roleId: fixture.roles.receptionist.id },
      { id: "upr_break_glass", userId: CARMEN, propertyId: LT, roleId: "role_bg" },
      { id: "upr_emergency", userId: "usr_emergencia", propertyId: LT, roleId: fixture.roles.receptionist.id }
    ];
    const plan = planMigration(planInputOf(fixture, { legacyRows: rows }));
    assert.equal(plan.planned.length, 2, "the valid rows still plan");
    assert.deepEqual(plan.blocked.map((row) => row.legacyRowId).sort(), ["upr_break_glass", "upr_emergency", "upr_foreign_property", "upr_foreign_role", "upr_foreign_user"]);
    assert.equal(planIsBlocked(plan), true);
  });

  it("is idempotent on the plan: a live assignment of the same tuple is reported «ya existe» (skipped), a revoked or expired one is not", () => {
    const fixture = farandaTables();
    const live = (id: string, extra: Partial<PlanInput["liveAssignments"][number]>) => ({ id, userId: CARMEN, roleId: fixture.roles.owner.id, scopeType: "organization" as const, propertyId: null, organizationId: ORG, revokedAt: null, validTo: null, ...extra });
    const skipped = planMigration(planInputOf(fixture, { liveAssignments: [live("ura_owner", {})] }));
    assert.equal(skipped.planned.find((row) => row.templateKey === "owner")!.existingAssignmentId, "ura_owner");
    assert.deepEqual([skipped.counts.toCreate, skipped.counts.skipped], [1, 1]);
    const revoked = planMigration(planInputOf(fixture, { liveAssignments: [live("ura_revoked", { revokedAt: NOW })] }));
    assert.equal(revoked.planned.find((row) => row.templateKey === "owner")!.existingAssignmentId, null);
    const expired = planMigration(planInputOf(fixture, { liveAssignments: [live("ura_expired", { validTo: new Date(NOW.getTime() - 1) })] }));
    assert.equal(expired.planned.find((row) => row.templateKey === "owner")!.existingAssignmentId, null);
  });
});

// ── Runner (fake Prisma) ──────────────────────────────────────────────────────

describe("runMigration · dry-run writes nothing, --apply writes once, second pass +0", () => {
  it("dry-run: plan with the Faranda counts, 0 rows written, 0 audit events, rbac_version untouched", async () => {
    const fixture = farandaTables();
    const { deps, db, trail } = depsOf(fixture);
    const result = await runMigration(flagsFor(["--org", ORG, "--dry-run"]), deps);
    assert.equal(result.mode, "dry-run");
    assert.equal(result.correlationId, `${CORRELATION_PREFIX}test`);
    assert.deepEqual(result.plan.counts, { organization: 1, property: 1, toCreate: 2, skipped: 0, blocked: 0, usersWithoutAssignment: 1 });
    assert.equal(db.$tables.userRoleAssignment.length, 0);
    assert.equal(db.$tables.userPropertyRole.length, 9);
    assert.equal(trail.events.length, 0);
    assert.equal(db.$tables.organization[0]!.rbacVersion, 0);
    const text = formatHuman(result);
    assert.match(text, /dry-run \(sin escrituras\)/);
    assert.match(text, /user_property_roles: 9 fila\(s\) · propiedades: 8 · user_role_assignments planificadas: 2 \(organization 1 · property 1\) · a crear 2 · ya existen 0 · bloqueadas 0/);
    assert.match(text, /direccion@farandariasaltas.es .*owner .*organization .*consolidated ×8 +crear/);
    assert.match(text, /recepcion.tilos@faranda.test .*receptionist .*property .*crear/);
    assert.match(text, /Usuarios sin asignación \(1/);
  });

  it("an unknown organisation fails before any read of the tables", async () => {
    const { deps } = depsOf(farandaTables());
    await assert.rejects(runMigration(flagsFor(["--org", "org_missing", "--dry-run"]), deps), /no existe/);
  });

  it("--apply --confirm: 2 rows created (validFrom now, reason backfill, grantedBy NULL), 2 ROLE_ASSIGNED as system, rbac_version +1, legacy table intact; second apply creates +0 and bumps nothing", async () => {
    const fixture = farandaTables();
    const { deps, db, trail } = depsOf(fixture);
    const result = await runMigration(flagsFor(["--org", ORG, "--apply", "--confirm", ORG]), deps);
    assert.equal(result.mode, "apply");
    assert.equal(result.created.length, 2);
    assert.equal(result.audited, 2);
    assert.deepEqual(result.postCondition, { toCreate: 0, skipped: 2, ok: true });
    const rows = db.$tables.userRoleAssignment;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.organizationId, ORG);
      assert.equal(row.reason, BACKFILL_REASON);
      assert.equal(row.grantedByUserId, null);
      assert.equal(row.revokedAt ?? null, null, "live (Prisma defaults revokedAt to NULL; the fake omits the column)");
      assert.equal((row.validFrom as Date).getTime(), NOW.getTime());
    }
    const owner = rows.find((row) => row.roleId === fixture.roles.owner.id)!;
    assert.deepEqual([owner.userId, owner.scopeType, owner.propertyId], [CARMEN, "organization", null]);
    const receptionist = rows.find((row) => row.roleId === fixture.roles.receptionist.id)!;
    assert.deepEqual([receptionist.userId, receptionist.scopeType, receptionist.propertyId], [TILOS, "property", LT]);
    assert.equal(db.$tables.userPropertyRole.length, 9, "user_property_roles is never deleted (dual-read)");
    assert.equal(db.$tables.organization[0]!.rbacVersion, 1);
    assert.equal(trail.events.length, 2);
    for (const event of trail.events) {
      assert.equal(event.action, "ROLE_ASSIGNED");
      assert.equal(event.actorType, "system");
      assert.equal(event.actorUserId, undefined);
      assert.equal(event.correlationId, `${CORRELATION_PREFIX}test`);
      assert.equal(event.entityType, "user_role_assignment");
    }
    const ownerEvent = trail.events.find((event) => (event.afterJson as { templateKey: string }).templateKey === "owner")!;
    assert.equal((ownerEvent.afterJson as { legacyRowIds: string[] }).legacyRowIds.length, 8);
    assert.match(formatHuman(result), /Creadas: 2 asignación\(es\) · auditoría ROLE_ASSIGNED: 2 · post-condición: ok/);

    const again = await runMigration(flagsFor(["--org", ORG, "--apply", "--confirm", ORG]), deps);
    assert.equal(again.created.length, 0);
    assert.equal(again.audited, 0);
    assert.deepEqual([again.plan.counts.toCreate, again.plan.counts.skipped], [0, 2]);
    assert.equal(db.$tables.userRoleAssignment.length, 2);
    assert.equal(db.$tables.organization[0]!.rbacVersion, 1, "nothing created → no bump");
    assert.equal(trail.events.length, 2);
  });

  it("--apply with --general-manager writes the third (organization) row for Carmen", async () => {
    const fixture = farandaTables({ generalManagerRole: true });
    const { deps, db } = depsOf(fixture);
    const result = await runMigration(flagsFor(["--org", ORG, "--apply", "--confirm", ORG, "--general-manager", CARMEN]), deps);
    assert.equal(result.created.length, 3);
    const gm = db.$tables.userRoleAssignment.find((row) => row.roleId === fixture.roles.general_manager!.id)!;
    assert.deepEqual([gm.userId, gm.scopeType, gm.propertyId], [CARMEN, "organization", null]);
    const again = await runMigration(flagsFor(["--org", ORG, "--dry-run", "--general-manager", CARMEN]), deps);
    assert.deepEqual([again.plan.counts.toCreate, again.plan.counts.skipped], [0, 3]);
  });

  it("--confirm of another organisation and a blocked plan refuse to write anything", async () => {
    const fixture = farandaTables();
    const { deps, db } = depsOf(fixture);
    await assert.rejects(runMigration({ org: ORG, apply: true, confirm: "org_123", generalManager: null, json: false, help: false }, deps), /does not match/);
    await assert.rejects(runMigration(flagsFor(["--org", ORG, "--apply", "--confirm", ORG, "--general-manager", CARMEN]), deps), /bloqueada/);
    assert.equal(db.$tables.userRoleAssignment.length, 0);
    const dry = await runMigration(flagsFor(["--org", ORG, "--dry-run", "--general-manager", CARMEN]), deps);
    assert.equal(planIsBlocked(dry.plan), true, "dry-run reports the blocker (CLI exits 1)");
    assert.match(formatHuman(dry), /Bloqueadas \(no se migran; --apply se detiene con exit 1\)/);
  });
});

describe("cadena de auditoría del CLI (integrador 8a)", () => {
  it("--apply: hidrata la punta de la cadena ANTES de escribir y vacía la cola DESPUÉS de los ROLE_ASSIGNED (nunca desconecta con eventos encolados)", async () => {
    const { deps, chain, trail } = depsOf(farandaTables());
    const result = await runMigration(flagsFor(["--org", ORG, "--apply", "--confirm", ORG]), deps);
    assert.equal(result.audited, 2);
    assert.deepEqual(chain.calls, [
      { step: "hydrate", events: 0 },
      { step: "flush", events: 2 }
    ]);
    assert.equal(trail.events.length, 2);
  });

  it("dry-run: no hidrata (no escribe) y vacía la cola vacía", async () => {
    const { deps, chain } = depsOf(farandaTables());
    await runMigration(flagsFor(["--org", ORG, "--dry-run"]), deps);
    assert.deepEqual(chain.calls, [{ step: "flush", events: 0 }]);
  });

  it("si la migración falla (org inexistente) la cola se vacía igualmente y el error original se propaga", async () => {
    const { deps, chain } = depsOf(farandaTables());
    await assert.rejects(runMigration(flagsFor(["--org", "org_missing", "--apply", "--confirm", "org_missing"]), deps), /no existe/);
    assert.deepEqual(chain.calls, [
      { step: "hydrate", events: 0 },
      { step: "flush", events: 0 }
    ]);
  });
});
