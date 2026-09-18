// Tanda 8a (RBAC · L2): separation of duties of the money services with a
// fake context and a fake Prisma of the rbac tables (no database). The lot's
// exclusive test files are this one and pms/__tests__/reservation-discount-
// sod.test.mts, so the gates of every service of the lot are exercised here:
// refund (payments.service), folio adjustment, supplier bill approve / pay
// (payables), payroll pay (payroll), rate band (rate-manager), capex approve
// (assets), purchase orders (advanced), night-audit day maths and the shared
// dynamic-SoD helper (treasury/permissions). From apps/api:
//   node --import tsx --test src/modules/payments/__tests__/refund-sod.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashPassword } from "@hotelos/database";
import { ROLE_PERMISSION_MAP, type PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import type { RbacScopeDb } from "../../../lib/rbac-scope.js";
import { assertCapexApprovalAuthorized } from "../../assets/assets.service.js";
import { assertPurchaseOrderTransitionAuthorized, purchaseOrderAmountOf } from "../../advanced/advanced-modules.service.js";
import { daysSinceBusinessDate, NIGHT_AUDIT_REOPEN_WINDOW_DAYS } from "../../night-audit/night-audit.service.js";
import { assertSupplierBillApprovalAuthorized, assertSupplierBillPaymentAuthorized } from "../../payables/supplier-bills.service.js";
import { assertPayrollPaymentAuthorized } from "../../payroll/periods.service.js";
import { evaluateRateBand, priceChangePct, rateChangeEntityId } from "../../rate-manager/rate-changes.service.js";
import { decideApproval, requestApproval } from "../../rbac/approvals.service.js";
import type { RbacDeps } from "../../rbac/assignments.service.js";
import { audits, fakePrisma, seedRoles, type Tables } from "../../rbac/__tests__/fake-prisma.mts";
import { assertSeparationOfDuties, PAYROLL_EXPORT_KEYS, PAYROLL_READ_KEYS, PAYROLL_WRITE_KEYS } from "../../treasury/permissions.js";
import { assertFolioAdjustmentAuthorized, assertRefundAuthorized } from "../payments.service.js";

const ORG = "org_sod";
const A = "prop_sod_a";
const code = (error: unknown) => (error as { details?: { code?: string } }).details?.code;
const status = (error: unknown) => (error as { statusCode?: number }).statusCode;
const rule = (error: unknown) => (error as { details?: { rule?: string } }).details?.rule;

function setup() {
  const user = (id: string, email: string) => ({ id, organizationId: ORG, email, fullName: id, status: "active", passwordHash: hashPassword("x"), pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null });
  const tables: Partial<Tables> = {
    organization: [{ id: ORG, name: "SoD", rbacVersion: 0 }],
    property: [{ id: A, organizationId: ORG, legalEntityId: "le", createdAt: new Date(2026, 0, 1) }],
    user: [
      user("u_rec", "recepcion@faranda.test"),
      user("u_fom", "jefatura@faranda.test"),
      user("u_clerk", "administracion@faranda.test"),
      user("u_clerk2", "administracion2@faranda.test"),
      user("u_dirh", "direccion@faranda.test"),
      user("u_ctrl", "controller@faranda.test"),
      user("u_dg", "dg@faranda.test"),
      user("u_owner", "propiedad@faranda.test"),
      user("u_rev", "revenue@faranda.test"),
      user("u_hr", "rrhh@faranda.test")
    ],
    userPropertyRole: [],
    userRoleAssignment: [],
    approvalRequest: [],
    roleThreshold: [],
    supervisorAuthorization: []
  };
  const roles = seedRoles(tables, ORG, {
    receptionist: ROLE_PERMISSION_MAP.receptionist,
    front_office_manager: ROLE_PERMISSION_MAP.front_office_manager,
    admin_clerk: ROLE_PERMISSION_MAP.admin_clerk,
    // A clerk that may also REQUEST refunds (custom role: T1 by level null) — requester = executor case.
    clerk_requester: [...ROLE_PERMISSION_MAP.admin_clerk, "payments.refund_request"],
    manager: ROLE_PERMISSION_MAP.manager,
    controller: ROLE_PERMISSION_MAP.controller,
    general_manager: ROLE_PERMISSION_MAP.general_manager,
    owner: ROLE_PERMISSION_MAP.owner,
    revenue: ROLE_PERMISSION_MAP.revenue,
    payroll_hr: ROLE_PERMISSION_MAP.payroll_hr
  });
  const live = (id: string, userId: string, roleId: string, scope: { scopeType: string; propertyId?: string }) =>
    tables.userRoleAssignment!.push({ id, userId, roleId, scopeType: scope.scopeType, propertyId: scope.propertyId ?? null, propertyGroupId: null, legalEntityId: null, organizationId: ORG, validFrom: new Date(Date.now() - 1000), validTo: null, revokedAt: null, createdAt: new Date() });
  live("ura_rec", "u_rec", roles.receptionist.id, { scopeType: "property", propertyId: A });
  live("ura_fom", "u_fom", roles.front_office_manager.id, { scopeType: "property", propertyId: A });
  live("ura_clerk", "u_clerk", roles.admin_clerk.id, { scopeType: "property", propertyId: A });
  live("ura_clerk2", "u_clerk2", roles.clerk_requester.id, { scopeType: "property", propertyId: A });
  live("ura_dirh", "u_dirh", roles.manager.id, { scopeType: "property", propertyId: A });
  live("ura_ctrl", "u_ctrl", roles.controller.id, { scopeType: "organization" });
  live("ura_dg", "u_dg", roles.general_manager.id, { scopeType: "organization" });
  live("ura_owner", "u_owner", roles.owner.id, { scopeType: "organization" });
  live("ura_rev", "u_rev", roles.revenue.id, { scopeType: "organization" });
  live("ura_hr", "u_hr", roles.payroll_hr.id, { scopeType: "organization" });
  const db = fakePrisma(tables);
  const trail = audits();
  const clock = new Date("2026-09-18T10:00:00Z");
  const deps: RbacDeps = { db: db as unknown as RbacScopeDb, audit: trail.audit as unknown as RbacDeps["audit"], now: () => clock };
  const ctx = (userId: string, permissions: readonly PermissionKey[], extra: Partial<UserContext> = {}): UserContext => ({ organizationId: ORG, propertyId: A, userId, fullName: userId, deviceId: "dev", permissions: [...permissions], ...extra });
  return {
    db,
    deps,
    trail,
    roles,
    rec: ctx("u_rec", ROLE_PERMISSION_MAP.receptionist),
    fom: ctx("u_fom", ROLE_PERMISSION_MAP.front_office_manager),
    clerk: ctx("u_clerk", ROLE_PERMISSION_MAP.admin_clerk),
    clerk2: ctx("u_clerk2", [...ROLE_PERMISSION_MAP.admin_clerk, "payments.refund_request"]),
    dirh: ctx("u_dirh", ROLE_PERMISSION_MAP.manager),
    ctrl: ctx("u_ctrl", ROLE_PERMISSION_MAP.controller, { orgScope: true }),
    dg: ctx("u_dg", ROLE_PERMISSION_MAP.general_manager, { orgScope: true }),
    owner: ctx("u_owner", ROLE_PERMISSION_MAP.owner, { orgScope: true }),
    rev: ctx("u_rev", ROLE_PERMISSION_MAP.revenue, { orgScope: true }),
    hr: ctx("u_hr", ROLE_PERMISSION_MAP.payroll_hr, { orgScope: true }),
    platform: ctx("u_platform", ["payment.refund", "payables.approve", "payables.pay", "asset.capex.approve"], { isPlatformAdmin: true, orgScope: true }),
    ctx
  };
}

const payment = (capturedByUserId: string | null = "u_rec") => ({ id: "pay_1", propertyId: A, capturedByUserId });

describe("Tanda 8a · L2 · reembolso: clave propia + aprobación del motor (payments.service assertRefundAuthorized)", () => {
  it("sin payment.refund → 403 (fail-secure) aunque exista una solicitud aprobada", async () => {
    const t = setup();
    await assert.rejects(assertRefundAuthorized({ context: t.rec, payment: payment(), amount: 20 }, t.deps), (error) => status(error) === 403);
  });

  it("con payment.refund pero sin solicitud ni clave de aprobación → 409 APPROVAL_REQUIRED", async () => {
    const t = setup();
    await assert.rejects(assertRefundAuthorized({ context: t.clerk, payment: payment(), amount: 20 }, t.deps), (error) => status(error) === 409 && code(error) === "APPROVAL_REQUIRED");
  });

  it("solicitud de 400 € (> T2) por recepción: jefatura (T2) → 403 RBAC_LEVEL_EXCEEDED, dirección de hotel (T3) aprueba, administración ejecuta → approved, approvedBy = decisor", async () => {
    const t = setup();
    const request = await requestApproval({ context: t.rec, kind: "refund", entityType: "payment", entityId: "pay_1", propertyId: A, amount: "400.00", reasonCode: "guest_complaint" }, t.deps);
    assert.equal(request.status, "pending");
    assert.equal(request.thresholdTier, "T3");
    // 400 € exceeds T2 (300 €): the front-office manager cannot approve it; the hotel director (T3) can.
    await assert.rejects(decideApproval({ context: t.fom, id: request.id, decision: "approve" }, t.deps), (error) => code(error) === "RBAC_LEVEL_EXCEEDED");
    const decided = await decideApproval({ context: t.dirh, id: request.id, decision: "approve" }, t.deps);
    assert.equal(decided.status, "approved");
    const gate = await assertRefundAuthorized({ context: t.clerk, payment: payment(), amount: 400 }, t.deps);
    assert.equal(gate.outcome.mode, "approved");
    assert.equal(gate.outcome.requestId, request.id);
    assert.equal(gate.approvedBy, "u_dirh");
    assert.equal(gate.baseAuthorUserId, "u_rec");
    const consumed = await t.db.approvalRequest.findFirst({ where: { id: request.id } });
    assert.equal(consumed?.consumedByUserId, "u_clerk");
    assert.ok(t.trail.events.some((event) => event.action === "APPROVAL_CONSUMED"));
  });

  it("solicitante = ejecutor → 409 APPROVAL_MISMATCH (nadie ejecuta lo que solicitó)", async () => {
    const t = setup();
    const request = await requestApproval({ context: t.clerk2, kind: "refund", entityType: "payment", entityId: "pay_1", propertyId: A, amount: "100.00", reasonCode: "duplicate_charge" }, t.deps);
    await decideApproval({ context: t.dirh, id: request.id, decision: "approve" }, t.deps);
    await assert.rejects(assertRefundAuthorized({ context: t.clerk2, payment: payment(), amount: 100 }, t.deps), (error) => status(error) === 409 && code(error) === "APPROVAL_MISMATCH");
  });

  it("importe mayor que el aprobado → 409 APPROVAL_MISMATCH; igual o menor → ok", async () => {
    const t = setup();
    const request = await requestApproval({ context: t.rec, kind: "refund", entityType: "payment", entityId: "pay_1", propertyId: A, amount: "100.00", reasonCode: "cancellation" }, t.deps);
    await decideApproval({ context: t.dirh, id: request.id, decision: "approve" }, t.deps);
    await assert.rejects(assertRefundAuthorized({ context: t.clerk, payment: payment(), amount: 150 }, t.deps), (error) => code(error) === "APPROVAL_MISMATCH");
    const gate = await assertRefundAuthorized({ context: t.clerk, payment: payment(), amount: 80 }, t.deps);
    assert.equal(gate.outcome.mode, "approved");
  });

  it("aprobación implícita: jefatura (payments.refund_approve, T2) reembolsa 100 € de un cobro ajeno; nunca de un cobro que capturó (cajero ≠ aprobador); autor null = desconocido, no bloquea", async () => {
    const t = setup();
    const fomWithRefund = t.ctx("u_fom", [...ROLE_PERMISSION_MAP.front_office_manager, "payment.refund"]);
    const own = await assertRefundAuthorized({ context: fomWithRefund, payment: payment("u_rec"), amount: 100 }, t.deps);
    assert.equal(own.outcome.mode, "implicit");
    assert.equal(own.approvedBy, "u_fom");
    await assert.rejects(assertRefundAuthorized({ context: fomWithRefund, payment: payment("u_fom"), amount: 100 }, t.deps), (error) => code(error) === "APPROVAL_REQUIRED");
    const legacy = await assertRefundAuthorized({ context: fomWithRefund, payment: payment(null), amount: 100 }, t.deps);
    assert.equal(legacy.outcome.mode, "implicit");
    assert.equal(legacy.baseAuthorUserId, null);
    // Above its tier (T2 = 300 €) the supervisor cannot self-approve.
    await assert.rejects(assertRefundAuthorized({ context: fomWithRefund, payment: payment("u_rec"), amount: 900 }, t.deps), (error) => code(error) === "APPROVAL_REQUIRED");
  });

  it("administrador de plataforma: reembolsa directamente (privileged) y queda auditado", async () => {
    const t = setup();
    const gate = await assertRefundAuthorized({ context: t.platform, payment: payment("u_platform"), amount: 5000 }, t.deps);
    assert.equal(gate.outcome.mode, "privileged");
    assert.equal(gate.approvedBy, "u_platform");
    const audited = t.trail.events.find((event) => event.action === "APPROVAL_DECIDED");
    assert.equal((audited?.afterJson as { privileged?: string }).privileged, "platform_admin");
  });
});

describe("Tanda 8a · L2 · ajuste de folio (folio.adjust): ≤ T1 con motivo, por encima aprobación", () => {
  it("40 € (≤ T1) por recepción pasa sin autorización; 200 € exige aprobación (409); jefatura lo aprueba implícitamente", async () => {
    const t = setup();
    const small = await assertFolioAdjustmentAuthorized({ context: t.rec, folioId: "fol_1", propertyId: A, amount: -40 }, t.deps);
    assert.equal(small.tier, "T1");
    assert.equal(small.authorization, null);
    await assert.rejects(assertFolioAdjustmentAuthorized({ context: t.rec, folioId: "fol_1", propertyId: A, amount: -200 }, t.deps), (error) => code(error) === "APPROVAL_REQUIRED");
    const fomAdjust = t.ctx("u_fom", [...ROLE_PERMISSION_MAP.front_office_manager, "folio.adjust"]);
    const big = await assertFolioAdjustmentAuthorized({ context: fomAdjust, folioId: "fol_1", propertyId: A, amount: -200 }, t.deps);
    assert.equal(big.tier, "T2");
    assert.equal(big.authorization?.mode, "implicit");
    await assert.rejects(assertFolioAdjustmentAuthorized({ context: t.clerk, folioId: "fol_1", propertyId: A, amount: -10 }, t.deps), (error) => status(error) === 403);
  });
});

describe("Tanda 8a · L2 · factura de proveedor: registrar ≠ aprobar (por importe) ≠ pagar (payables)", () => {
  const bill = (createdByUserId: string | null, total: number) => ({ id: "bill_1", propertyId: A, createdByUserId, total });

  it("aprobador = creador → 409 RBAC_SOD_CONFLICT creator_ne_approver; sin payables.approve → 403", async () => {
    const t = setup();
    await assert.rejects(assertSupplierBillApprovalAuthorized({ context: t.dirh, bill: bill("u_dirh", 500) }, t.deps), (error) => status(error) === 409 && code(error) === "RBAC_SOD_CONFLICT" && rule(error) === "creator_ne_approver");
    await assert.rejects(assertSupplierBillApprovalAuthorized({ context: t.clerk, bill: bill("u_rec", 500) }, t.deps), (error) => status(error) === 403);
  });

  it("5.000 € por dirección de hotel (T3) → 403 RBAC_LEVEL_EXCEEDED; por controller (T4) → ok; 500 € por dirección de hotel → ok", async () => {
    const t = setup();
    await assert.rejects(assertSupplierBillApprovalAuthorized({ context: t.dirh, bill: bill("u_clerk", 5000) }, t.deps), (error) => status(error) === 403 && code(error) === "RBAC_LEVEL_EXCEEDED");
    const ok = await assertSupplierBillApprovalAuthorized({ context: t.ctrl, bill: bill("u_clerk", 5000) }, t.deps);
    assert.equal(ok.tier, "T4");
    assert.equal(ok.authorization, null);
    const small = await assertSupplierBillApprovalAuthorized({ context: t.dirh, bill: bill("u_clerk", 500) }, t.deps);
    assert.equal(small.tier, "T3");
  });

  it("pagar: creador → 409 creator_ne_payer; aprobador → 409 approver_ne_payer; controller paga lo que aprobó (excepción auditada); autor desconocido no bloquea", async () => {
    const t = setup();
    const paid = (createdByUserId: string | null, approvedBy: string | null) => ({ id: "bill_1", propertyId: A, createdByUserId, approvedBy });
    await assert.rejects(assertSupplierBillPaymentAuthorized({ context: t.ctrl, bill: paid("u_ctrl", "u_dirh") }, t.deps), (error) => rule(error) === "creator_ne_payer");
    const dirhPay = t.ctx("u_dirh", [...ROLE_PERMISSION_MAP.manager, "payables.pay"]);
    await assert.rejects(assertSupplierBillPaymentAuthorized({ context: dirhPay, bill: paid("u_clerk", "u_dirh") }, t.deps), (error) => rule(error) === "approver_ne_payer");
    const controller = await assertSupplierBillPaymentAuthorized({ context: t.ctrl, bill: paid("u_clerk", "u_ctrl") }, t.deps);
    assert.equal(controller.controllerException, true);
    const legacy = await assertSupplierBillPaymentAuthorized({ context: t.ctrl, bill: paid(null, null) }, t.deps);
    assert.equal(legacy.creator.authorUnknown, true);
  });
});

describe("Tanda 8a · L2 · nómina: pagar exige registro aprobado y pagador ≠ aprobador (payroll)", () => {
  it("pay sin approve → 409 PAYROLL_NOT_APPROVED; aprobador que paga → 409; otro con payables.pay → ok; sin clave → 403", () => {
    const t = setup();
    assert.throws(() => assertPayrollPaymentAuthorized(t.ctrl, { id: "per_1", periodCode: "2026-08", approvedByUserId: null }), (error) => status(error) === 409 && code(error) === "PAYROLL_NOT_APPROVED");
    assert.throws(() => assertPayrollPaymentAuthorized(t.ctrl, { id: "per_1", periodCode: "2026-08", approvedByUserId: "u_ctrl" }), (error) => rule(error) === "approver_ne_payer");
    const ok = assertPayrollPaymentAuthorized(t.ctrl, { id: "per_1", periodCode: "2026-08", approvedByUserId: "u_dg" });
    assert.equal(ok.authorUserId, "u_dg");
    assert.equal(ok.approvalBypassed, null);
    assert.throws(() => assertPayrollPaymentAuthorized(t.hr, { id: "per_1", periodCode: "2026-08", approvedByUserId: "u_dg" }), (error) => status(error) === 403);
    // Platform admin: pays an unapproved register as the audited exception (engine mode 3), never silently.
    const privileged = assertPayrollPaymentAuthorized(t.platform, { id: "per_1", periodCode: "2026-08", approvedByUserId: null });
    assert.equal(privileged.approvalBypassed, "platform_admin");
    assert.equal(privileged.privileged, "platform_admin");
  });

  it("las claves de nómina salen de contabilidad: payroll.manage prepara, workforce.payroll_export exporta, payroll.read lee", () => {
    assert.deepEqual(PAYROLL_WRITE_KEYS, ["payroll.manage"]);
    assert.deepEqual(PAYROLL_EXPORT_KEYS, ["payroll.manage", "workforce.payroll_export"]);
    assert.deepEqual(PAYROLL_READ_KEYS, ["payroll.read", "payroll.manage"]);
  });
});

describe("Tanda 8a · L2 · tarifas: banda ± rateBandPct y lotes > 50 celdas (rate-manager)", () => {
  const patch = (date: string, price: number) => ({ ratePlanId: "rp_bar", roomTypeId: "rt_dbl", date, price });

  it("evaluateRateBand: dentro de banda pasa, fuera de banda o > 50 celdas exige aprobación; sin referencia no cuenta", () => {
    const current = new Map<string, number | null>([["rp_bar|rt_dbl|2026-10-01", 100], ["rp_bar|rt_dbl|2026-10-02", 100], ["rp_bar|rt_dbl|2026-10-03", null]]);
    const within = evaluateRateBand([patch("2026-10-01", 110), patch("2026-10-03", 500)], current, { bandPct: 15, maxCellsWithoutApproval: 50 });
    assert.equal(within.needsApproval, false);
    assert.equal(within.withoutReference, 1);
    const out = evaluateRateBand([patch("2026-10-01", 110), patch("2026-10-02", 130)], current, { bandPct: 15, maxCellsWithoutApproval: 50 });
    assert.equal(out.needsApproval, true);
    assert.deepEqual(out.outOfBand, [{ key: "rp_bar|rt_dbl|2026-10-02", current: 100, next: 130, pct: 30 }]);
    const bulk = evaluateRateBand(Array.from({ length: 51 }, (_, i) => patch(`2026-11-${String((i % 28) + 1).padStart(2, "0")}`, 100)), new Map(), { bandPct: 15, maxCellsWithoutApproval: 50 });
    assert.equal(bulk.bulk, true);
    assert.equal(bulk.needsApproval, true);
    assert.equal(priceChangePct(100, 115), 15);
    assert.equal(priceChangePct(null, 115), null);
  });

  it("rateChangeEntityId es determinista e independiente del orden de las celdas", () => {
    const a = rateChangeEntityId(A, [patch("2026-10-01", 110), patch("2026-10-02", 130)]);
    const b = rateChangeEntityId(A, [patch("2026-10-02", 130), patch("2026-10-01", 110)]);
    const c = rateChangeEntityId(A, [patch("2026-10-02", 131), patch("2026-10-01", 110)]);
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^rc_[0-9a-f]{32}$/);
  });

  it("fuera de banda sin revenue.rates.approve → 409 APPROVAL_REQUIRED; revenue corporativo (approve) lo autoriza implícitamente", async () => {
    const t = setup();
    const { assertRateChangeAuthorized } = await import("../../rate-manager/rate-changes.service.js");
    const current = new Map<string, number | null>([["rp_bar|rt_dbl|2026-10-01", 100]]);
    await assert.rejects(assertRateChangeAuthorized({ context: t.dirh, propertyId: A, patches: [patch("2026-10-01", 140)], currentPrices: current }, t.deps), (error) => code(error) === "APPROVAL_REQUIRED");
    const ok = await assertRateChangeAuthorized({ context: t.rev, propertyId: A, patches: [patch("2026-10-01", 140)], currentPrices: current }, t.deps);
    assert.equal(ok.authorization?.mode, "implicit");
    const within = await assertRateChangeAuthorized({ context: t.dirh, propertyId: A, patches: [patch("2026-10-01", 110)], currentPrices: current }, t.deps);
    assert.equal(within.authorization, null);
    assert.ok(t.trail.events.some((event) => event.action === "RATE_CHANGE_AUTHORIZED"));
  });
});

describe("Tanda 8a · L2 · CAPEX: proponente ≠ aprobador y aprobación por importe (assets)", () => {
  it("aprobador = creador → 409; propiedad aprueba un proyecto ajeno de 20.000 € (> T4: aprobación implícita imposible → 409 APPROVAL_REQUIRED); 1.000 € por dirección financiera → ok", async () => {
    const t = setup();
    await assert.rejects(assertCapexApprovalAuthorized({ context: t.owner, project: { id: "capex_1", propertyId: A, budget: 1000, createdByUserId: "u_owner" } }, t.deps), (error) => code(error) === "RBAC_SOD_CONFLICT" && rule(error) === "proposer_ne_approver");
    await assert.rejects(assertCapexApprovalAuthorized({ context: t.owner, project: { id: "capex_1", propertyId: A, budget: 20000, createdByUserId: "u_dirh" } }, t.deps), (error) => code(error) === "APPROVAL_REQUIRED");
    const ok = await assertCapexApprovalAuthorized({ context: t.ctrl, project: { id: "capex_1", propertyId: A, budget: 1000, createdByUserId: "u_dirh" } }, t.deps);
    assert.equal(ok.authorization.mode, "implicit");
    await assert.rejects(assertCapexApprovalAuthorized({ context: t.rec, project: { id: "capex_1", propertyId: A, budget: 10, createdByUserId: "u_dirh" } }, t.deps), (error) => status(error) === 403);
  });
});

describe("Tanda 8a · L2 · pedidos de compra: solicita ≠ aprueba ≠ recepciona (advanced)", () => {
  it("aprobador = solicitante → 409; recepción por el solicitante → 409; importe sobre el tramo → 403 RBAC_LEVEL_EXCEEDED; registro legado sin autor no bloquea", async () => {
    const t = setup();
    const po = (createdByUserId: string | null, total: number) => ({ createdByUserId, total });
    await assert.rejects(assertPurchaseOrderTransitionAuthorized({ context: t.dirh, propertyId: A, entityId: "po_1", status: "approved", existingPayload: po("u_dirh", 100), payload: {} }, t.deps), (error) => rule(error) === "creator_ne_approver");
    await assert.rejects(assertPurchaseOrderTransitionAuthorized({ context: t.rec, propertyId: A, entityId: "po_1", status: "received", existingPayload: po("u_rec", 100), payload: {} }, t.deps), (error) => rule(error) === "requester_ne_receiver");
    await assert.rejects(assertPurchaseOrderTransitionAuthorized({ context: t.fom, propertyId: A, entityId: "po_1", status: "approved", existingPayload: po("u_rec", 900), payload: {} }, t.deps), (error) => code(error) === "RBAC_LEVEL_EXCEEDED");
    const ok = await assertPurchaseOrderTransitionAuthorized({ context: t.fom, propertyId: A, entityId: "po_1", status: "approved", existingPayload: po("u_rec", 200), payload: {} }, t.deps);
    assert.equal(ok?.tier, "T2");
    const legacy = await assertPurchaseOrderTransitionAuthorized({ context: t.fom, propertyId: A, entityId: "po_1", status: "received", existingPayload: undefined, payload: {} }, t.deps);
    assert.equal(legacy?.authorUnknown, true);
    assert.equal(purchaseOrderAmountOf({ totalAmount: "1234.50" }), 1234.5);
    assert.equal(purchaseOrderAmountOf({ amount: 99.999 }), 100);
    assert.equal(purchaseOrderAmountOf({ note: "x" }), null);
  });
});

describe("Tanda 8a · L2 · cierre del día y helper de SoD", () => {
  it("daysSinceBusinessDate: ventana de 7 días", () => {
    assert.equal(daysSinceBusinessDate("2026-09-10", "2026-09-17"), 7);
    assert.equal(daysSinceBusinessDate("2026-09-10", "2026-09-18"), 8);
    assert.equal(daysSinceBusinessDate("2026-09-20", "2026-09-18"), 0);
    assert.equal(NIGHT_AUDIT_REOPEN_WINDOW_DAYS, 7);
  });

  it("assertSeparationOfDuties: mismo usuario → 409 con regla; autor null → desconocido; plataforma y break glass → privileged", () => {
    const t = setup();
    assert.throws(() => assertSeparationOfDuties(t.rec, "u_rec", "runner_ne_reviewer"), (error) => status(error) === 409 && code(error) === "RBAC_SOD_CONFLICT" && rule(error) === "runner_ne_reviewer");
    assert.deepEqual(assertSeparationOfDuties(t.rec, null, "runner_ne_reviewer"), { rule: "runner_ne_reviewer", authorUserId: null, authorUnknown: true, privileged: null });
    assert.equal(assertSeparationOfDuties(t.rec, "u_fom", "runner_ne_reviewer").privileged, null);
    assert.equal(assertSeparationOfDuties(t.platform, "u_platform", "creator_ne_approver").privileged, "platform_admin");
    assert.equal(assertSeparationOfDuties({ ...t.rec, breakGlassSessionId: "bg_1" }, "u_rec", "creator_ne_approver").privileged, "break_glass");
  });
});
