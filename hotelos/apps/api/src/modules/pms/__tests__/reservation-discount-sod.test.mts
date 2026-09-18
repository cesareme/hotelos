// Tanda 8a (RBAC · L2, design §4.6 / §4.7 «Descuento en reserva»): the
// discount and overbooking gates of pms.service with a fake context and a
// fake Prisma of the rbac tables (no database). Table of the brief (point 2):
//   sin clave → 403 · 8 % con clave y motivo → ok (banda T1) · 20 % sin
//   override → 409 APPROVAL_REQUIRED · 20 % con override (jefatura) → ok ·
//   por encima de T2 % sin PIN · importación → no se evalúa.
// From apps/api:
//   node --import tsx --test src/modules/pms/__tests__/reservation-discount-sod.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashPassword } from "@hotelos/database";
import { ROLE_PERMISSION_MAP, type PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import type { RbacScopeDb } from "../../../lib/rbac-scope.js";
import type { RbacDeps } from "../../rbac/assignments.service.js";
import { audits, fakePrisma, seedRoles, type Tables } from "../../rbac/__tests__/fake-prisma.mts";
import { authorize } from "../../rbac/supervisor.service.js";
import { assertOverbookingAuthorized, assertReservationDiscountAuthorized, DISCOUNT_REASON_CODES, discountPctOf, OVERRIDE_REASON_CODES } from "../pms.service.js";

const ORG = "org_disc";
const A = "prop_disc_a";
const PIN = "1357";
const code = (error: unknown) => (error as { details?: { code?: string } }).details?.code;
const status = (error: unknown) => (error as { statusCode?: number }).statusCode;

function setup() {
  const user = (id: string, email: string, pin: string | null = null) => ({ id, organizationId: ORG, email, fullName: id, status: "active", passwordHash: hashPassword("x"), pinHash: pin ? hashPassword(pin) : null, pinFailedAttempts: 0, pinLockedUntil: null });
  const tables: Partial<Tables> = {
    organization: [{ id: ORG, name: "Descuentos", rbacVersion: 0 }],
    property: [{ id: A, organizationId: ORG, legalEntityId: "le", createdAt: new Date(2026, 0, 1) }],
    user: [user("u_rec", "recepcion@faranda.test"), user("u_fom", "jefatura@faranda.test", PIN), user("u_hk", "pisos@faranda.test"), user("u_dirh", "direccion@faranda.test")],
    userPropertyRole: [],
    userRoleAssignment: [],
    approvalRequest: [],
    roleThreshold: [],
    supervisorAuthorization: []
  };
  const roles = seedRoles(tables, ORG, {
    receptionist: ROLE_PERMISSION_MAP.receptionist,
    front_office_manager: ROLE_PERMISSION_MAP.front_office_manager,
    housekeeper: ROLE_PERMISSION_MAP.housekeeper,
    manager: ROLE_PERMISSION_MAP.manager
  });
  const live = (id: string, userId: string, roleId: string) =>
    tables.userRoleAssignment!.push({ id, userId, roleId, scopeType: "property", propertyId: A, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: new Date() });
  live("ura_rec", "u_rec", roles.receptionist.id);
  live("ura_fom", "u_fom", roles.front_office_manager.id);
  live("ura_hk", "u_hk", roles.housekeeper.id);
  live("ura_dirh", "u_dirh", roles.manager.id);
  const db = fakePrisma(tables);
  const trail = audits();
  const clock = new Date("2026-09-18T10:00:00Z");
  const deps: RbacDeps = { db: db as unknown as RbacScopeDb, audit: trail.audit as unknown as RbacDeps["audit"], now: () => clock };
  const ctx = (userId: string, permissions: readonly PermissionKey[]): UserContext => ({ organizationId: ORG, propertyId: A, userId, fullName: userId, deviceId: "dev", permissions: [...permissions] });
  return {
    db,
    deps,
    trail,
    rec: ctx("u_rec", ROLE_PERMISSION_MAP.receptionist),
    fom: ctx("u_fom", ROLE_PERMISSION_MAP.front_office_manager),
    hk: ctx("u_hk", ROLE_PERMISSION_MAP.housekeeper),
    dirh: ctx("u_dirh", ROLE_PERMISSION_MAP.manager)
  };
}

const entity = { propertyId: A, entityType: "reservation" as const, entityId: "res_1" };

describe("Tanda 8a · L2 · descuento en reserva (pms.service assertReservationDiscountAuthorized)", () => {
  it("discountPctOf: 0 en la cotización o por encima; % con dos decimales por debajo", () => {
    assert.equal(discountPctOf(1000, 1000), 0);
    assert.equal(discountPctOf(1000, 1100), 0);
    assert.equal(discountPctOf(1000, 920), 8);
    assert.equal(discountPctOf(300, 250), 16.67);
    assert.equal(discountPctOf(0, 10), 0);
  });

  it("las plantillas de recepción llevan la clave de descuento y jefatura la de override (catálogo L0)", () => {
    assert.ok(ROLE_PERMISSION_MAP.receptionist.includes("pms.reservation.discount"));
    assert.ok(!ROLE_PERMISSION_MAP.receptionist.includes("pms.reservation.override"));
    assert.ok(ROLE_PERMISSION_MAP.front_office_manager.includes("pms.reservation.override"));
    assert.ok(Object.keys(DISCOUNT_REASON_CODES).length >= 5 && Object.keys(OVERRIDE_REASON_CODES).length >= 4);
  });

  it("sin clave (pisos) → 403 aunque el descuento sea del 8 %", async () => {
    const t = setup();
    await assert.rejects(assertReservationDiscountAuthorized({ context: t.hk, ...entity, quotedTotal: 1000, requestedTotal: 920, discountReasonCode: "loyalty" }, t.deps), (error) => status(error) === 403);
  });

  it("8 % con clave y motivo → ok (banda T1, sin autorización); motivo inválido → 400; sin motivo → «unspecified» anotado como reasonMissing (transitorio: la ruta no lo reenvía)", async () => {
    const t = setup();
    const ok = await assertReservationDiscountAuthorized({ context: t.rec, ...entity, quotedTotal: 1000, requestedTotal: 920, discountReasonCode: "loyalty" }, t.deps);
    assert.equal(ok.band, "T1");
    assert.equal(ok.discountPct, 8);
    assert.equal(ok.discountAmount, 80);
    assert.equal(ok.reasonCode, "loyalty");
    assert.equal(ok.reasonMissing, false);
    assert.equal(ok.authorization, null);
    await assert.rejects(assertReservationDiscountAuthorized({ context: t.rec, ...entity, quotedTotal: 1000, requestedTotal: 920, discountReasonCode: "invented" }, t.deps), (error) => status(error) === 400);
    const missing = await assertReservationDiscountAuthorized({ context: t.rec, ...entity, quotedTotal: 1000, requestedTotal: 920 }, t.deps);
    assert.equal(missing.reasonCode, "unspecified");
    assert.equal(missing.reasonMissing, true);
    assert.equal(missing.band, "T1");
  });

  it("20 % sin override (recepción) → 409 APPROVAL_REQUIRED; con override (jefatura, T2) → ok implícito", async () => {
    const t = setup();
    await assert.rejects(assertReservationDiscountAuthorized({ context: t.rec, ...entity, quotedTotal: 1000, requestedTotal: 800, discountReasonCode: "corporate_agreement" }, t.deps), (error) => status(error) === 409 && code(error) === "APPROVAL_REQUIRED");
    const ok = await assertReservationDiscountAuthorized({ context: t.fom, ...entity, quotedTotal: 1000, requestedTotal: 800, discountReasonCode: "corporate_agreement" }, t.deps);
    assert.equal(ok.band, "T2");
    assert.equal(ok.authorization?.mode, "implicit");
    assert.equal(ok.discountAmount, 200);
  });

  it("20 % por recepción con PIN de jefatura → ok (supervisor); por encima del 25 % el PIN no basta (aprobación explícita)", async () => {
    const t = setup();
    const pin = await authorize({ context: t.rec, authorizerEmail: "jefatura@faranda.test", pin: PIN, permissionKey: "pms.reservation.override", entityType: "reservation", entityId: "res_1", propertyId: A, amount: "200.00", reasonCode: "corporate_agreement" }, t.deps);
    const ok = await assertReservationDiscountAuthorized({ context: t.rec, ...entity, quotedTotal: 1000, requestedTotal: 800, discountReasonCode: "corporate_agreement", supervisorAuthorizationId: pin.id }, t.deps);
    assert.equal(ok.authorization?.mode, "supervisor");
    const pin2 = await authorize({ context: t.rec, authorizerEmail: "jefatura@faranda.test", pin: PIN, permissionKey: "pms.reservation.override", entityType: "reservation", entityId: "res_1", propertyId: A, amount: "300.00", reasonCode: "corporate_agreement" }, t.deps);
    await assert.rejects(assertReservationDiscountAuthorized({ context: t.rec, ...entity, quotedTotal: 1000, requestedTotal: 700, discountReasonCode: "corporate_agreement", supervisorAuthorizationId: pin2.id }, t.deps), (error) => code(error) === "APPROVAL_REQUIRED");
    // Above the supervisor band the hotel director (override, T3) approves 300 € implicitly.
    const above = await assertReservationDiscountAuthorized({ context: t.dirh, ...entity, quotedTotal: 1000, requestedTotal: 700, discountReasonCode: "corporate_agreement" }, t.deps);
    assert.equal(above.band, "above");
    assert.equal(above.authorization?.mode, "implicit");
  });

  it("no se evalúa: importación masiva, sin totalAmount o sin tarifa publicada (queda anotado)", async () => {
    const t = setup();
    const imported = await assertReservationDiscountAuthorized({ context: t.hk, ...entity, quotedTotal: 1000, requestedTotal: 10, importFlow: true }, t.deps);
    assert.equal(imported.skipped, "import");
    const noTotal = await assertReservationDiscountAuthorized({ context: t.hk, ...entity, quotedTotal: 1000, requestedTotal: undefined }, t.deps);
    assert.equal(noTotal.skipped, "no_total");
    const noRate = await assertReservationDiscountAuthorized({ context: t.hk, ...entity, quotedTotal: null, requestedTotal: 10 }, t.deps);
    assert.equal(noRate.skipped, "no_published_rate");
    const atPrice = await assertReservationDiscountAuthorized({ context: t.hk, ...entity, quotedTotal: 1000, requestedTotal: 1000 }, t.deps);
    assert.equal(atPrice.band, "none");
    assert.equal(atPrice.skipped, null);
  });
});

describe("Tanda 8a · L2 · overbooking consentido (pms.service assertOverbookingAuthorized)", () => {
  it("sin override ni PIN → 403; con override → override_key; con PIN de jefatura → supervisor (un solo uso); importación → import", async () => {
    const t = setup();
    const target = { entityType: "reservation_create", entityId: `${A}:rt_dbl:2026-10-01:2026-10-03` };
    await assert.rejects(assertOverbookingAuthorized({ context: t.rec, ...target }, t.deps), (error) => status(error) === 403);
    assert.equal((await assertOverbookingAuthorized({ context: t.fom, ...target }, t.deps)).mode, "override_key");
    const pin = await authorize({ context: t.rec, authorizerEmail: "jefatura@faranda.test", pin: PIN, permissionKey: "pms.reservation.override", entityType: target.entityType, entityId: target.entityId, propertyId: A, reasonCode: "overbooking_authorized" }, t.deps);
    const viaPin = await assertOverbookingAuthorized({ context: t.rec, ...target, supervisorAuthorizationId: pin.id }, t.deps);
    assert.equal(viaPin.mode, "supervisor");
    assert.equal(viaPin.authorizerUserId, "u_fom");
    await assert.rejects(assertOverbookingAuthorized({ context: t.rec, ...target, supervisorAuthorizationId: pin.id }, t.deps), (error) => status(error) === 403);
    assert.equal((await assertOverbookingAuthorized({ context: t.hk, ...target, importFlow: true }, t.deps)).mode, "import");
  });
});
