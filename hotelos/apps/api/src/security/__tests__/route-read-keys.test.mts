// Tanda 5 (L1b · api-side): the GET routes that L1a found gated by WRITE keys
// (folio.charge.post, compliance.ses.submit, compliance.configure) carry read
// keys now — folio.read, pos.read, tourist_tax.read, billing.compliance.view,
// guest_register.read — and every template whose menu token opens the screen
// (pilots/tanda5-nav-tree.md §3) holds them, so the finanzas token
// (accountant + compliance) opens Folios, TPV, Tasa turística, VeriFactu and
// Registro de viajeros without a 403. Run from apps/api with
//   node --import tsx --test src/security/__tests__/route-read-keys.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PERMISSIONS, ROLE_PERMISSION_MAP, ROLE_TEMPLATE_KEYS, assertPermissions, type PermissionKey, type RoleKey } from "@hotelos/shared";
import { findRoutePermission, routePermissionManifest } from "../route-permissions.js";

type Expectation = { path: string; permission: PermissionKey; templates: RoleKey[] };

const FINANZAS_AND_FRONT: RoleKey[] = ["manager", "receptionist", "accountant", "compliance"];

const READ_GATED_GETS: Expectation[] = [
  { path: "/folios/:id/balance", permission: "folio.read", templates: FINANZAS_AND_FRONT },
  { path: "/reservations/:id/folios", permission: "folio.read", templates: FINANZAS_AND_FRONT },
  { path: "/reservations/:id/routing-rules", permission: "folio.read", templates: FINANZAS_AND_FRONT },
  { path: "/tourist-tax/rates", permission: "tourist_tax.read", templates: FINANZAS_AND_FRONT },
  { path: "/properties/:propertyId/tourist-tax/applications", permission: "tourist_tax.read", templates: FINANZAS_AND_FRONT },
  // Tanda 8a (L0): `compliance` no longer holds pos.read (revocation, design §6.5).
  { path: "/properties/:propertyId/pos/outlets", permission: "pos.read", templates: ["fnb", "manager", "receptionist", "accountant"] },
  { path: "/properties/:propertyId/pos/tickets", permission: "pos.read", templates: ["fnb", "manager", "receptionist", "accountant"] },
  { path: "/properties/:propertyId/pos/cash-summary", permission: "pos.read", templates: ["fnb", "manager", "receptionist", "accountant"] },
  { path: "/properties/:propertyId/verifactu/submissions", permission: "billing.compliance.view", templates: FINANZAS_AND_FRONT },
  { path: "/verifactu/submissions/:id", permission: "billing.compliance.view", templates: FINANZAS_AND_FRONT },
  { path: "/invoices/:id/verifactu", permission: "billing.compliance.view", templates: FINANZAS_AND_FRONT },
  { path: "/properties/:propertyId/tbai/submissions", permission: "billing.compliance.view", templates: FINANZAS_AND_FRONT },
  { path: "/tbai/submissions/:id", permission: "billing.compliance.view", templates: FINANZAS_AND_FRONT },
  { path: "/properties/:propertyId/igic/submissions", permission: "billing.compliance.view", templates: FINANZAS_AND_FRONT },
  { path: "/igic/submissions/:id", permission: "billing.compliance.view", templates: FINANZAS_AND_FRONT },
  { path: "/properties/:propertyId/guest-register-records", permission: "guest_register.read", templates: FINANZAS_AND_FRONT },
  { path: "/properties/:propertyId/compliance/inbox", permission: "guest_register.read", templates: FINANZAS_AND_FRONT },
  { path: "/ses/submissions/:id", permission: "guest_register.read", templates: FINANZAS_AND_FRONT },
  // Tanda L2 (L2-01): canonical SES list; the /ses-hospedajes/submissions duplicate is retired by L2-02.
  { path: "/properties/:propertyId/ses/submissions", permission: "guest_register.read", templates: FINANZAS_AND_FRONT }
];

// Tanda 5 (L1c · api): the GETs that L1b left behind — invoices (were
// invoice.issue), the SES settings (guest_register.configure), and the
// finance GETs that analytics.read opened to every template (payroll, bank
// accounts, commissions, fiscal calendar, exchange rates) — plus the read
// keys of the secondary GETs of visible screens (incidents, workforce, event
// spaces, rate plans for sales, AI incidents for manager, rooms for
// maintenance). Templates = the ones whose menu token sees the screen.
const L1C_READ_GATED_GETS: Expectation[] = [
  { path: "/properties/:propertyId/invoices", permission: "invoice.read", templates: FINANZAS_AND_FRONT },
  { path: "/invoices/:id", permission: "invoice.read", templates: FINANZAS_AND_FRONT },
  { path: "/invoices/:id/rectifications", permission: "invoice.read", templates: FINANZAS_AND_FRONT },
  { path: "/compliance/spain/properties/:propertyId/guest-register/settings", permission: "guest_register.read", templates: FINANZAS_AND_FRONT },
  { path: "/payroll/contracts", permission: "payroll.read", templates: ["manager", "accountant"] },
  { path: "/payroll/periods", permission: "payroll.read", templates: ["manager", "accountant"] },
  { path: "/payroll/periods/:id/slips", permission: "payroll.read", templates: ["manager", "accountant"] },
  { path: "/payroll/periods/:id/export", permission: "payroll.read", templates: ["manager", "accountant"] },
  { path: "/banking/accounts", permission: "banking.read", templates: ["manager", "accountant"] },
  { path: "/banking/accounts/:id/balance", permission: "banking.read", templates: ["manager", "accountant"] },
  { path: "/banking/accounts/:id/statements", permission: "banking.read", templates: ["manager", "accountant"] },
  { path: "/banking/accounts/:id/reconciliation-status", permission: "banking.read", templates: ["manager", "accountant"] },
  { path: "/banking/statements/:id", permission: "banking.read", templates: ["manager", "accountant"] },
  // Tanda 8a (L0): accountant and compliance lost commissions.read (revocations, design §6.5).
  { path: "/commissions/rules", permission: "commissions.read", templates: ["manager", "sales"] },
  { path: "/commissions/accruals", permission: "commissions.read", templates: ["manager", "sales"] },
  { path: "/commissions/summary", permission: "commissions.read", templates: ["manager", "sales"] },
  { path: "/finance/exchange-rates", permission: "accounting.read", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/accounting/fiscal-years", permission: "accounting.read", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/accounting/fiscal-years/:id/status", permission: "accounting.read", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/accounting/fiscal-periods", permission: "accounting.read", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/safety/properties/:propertyId/incidents", permission: "incidents.read", templates: ["manager", "receptionist", "maintenance"] },
  { path: "/safety/properties/:propertyId/checks", permission: "safety_checks.read", templates: ["manager", "receptionist", "maintenance"] },
  { path: "/workforce/properties/:propertyId/time-clock", permission: "workforce.read", templates: ["manager", "housekeeper", "maintenance", "fnb"] },
  { path: "/properties/:propertyId/event-spaces", permission: "events.read", templates: ["manager", "receptionist", "sales"] },
  { path: "/properties/:propertyId/rate-plans", permission: "revenue.read", templates: ["manager", "receptionist", "revenue", "sales"] },
  { path: "/ai-operations/governance/incidents", permission: "ai_incidents.read", templates: ["manager"] },
  { path: "/properties/:propertyId/rooms", permission: "pms.reservation.read", templates: ["manager", "receptionist", "housekeeper", "maintenance"] }
];

/** Every template of every token: GET /backoffice/properties/:id/modules feeds the menu (modulesAny). */
const MODULE_LIST_GETS = ["/backoffice/properties/:propertyId/modules", "/properties/:propertyId/modules", "/modules/catalog"];

describe("route manifest · read keys for the GET routes of folios, POS, tourist tax, VeriFactu and guest register (L1b)", () => {
  it("every read GET requires exactly its read key, and the keys exist in the catalog", () => {
    for (const expected of READ_GATED_GETS) {
      const entry = findRoutePermission("GET", expected.path);
      assert.ok(entry, `GET ${expected.path} has no manifest entry`);
      assert.deepEqual(entry.permissions, [expected.permission], `GET ${expected.path}`);
      assert.ok(expected.permission in PERMISSIONS, `${expected.permission} not in PERMISSIONS`);
    }
  });

  it("no GET is gated by folio.charge.post or compliance.ses.submit any more (write keys stay on mutations)", () => {
    const writeGatedGets = routePermissionManifest.filter(
      (entry) => entry.method === "GET" && entry.permissions.some((key) => key === "folio.charge.post" || key === "compliance.ses.submit")
    );
    assert.deepEqual(writeGatedGets.map((entry) => entry.path), []);
    // The mutations keep their write gates.
    assert.deepEqual(findRoutePermission("POST", "/tourist-tax/apply")?.permissions, ["folio.charge.post"]);
    assert.deepEqual(findRoutePermission("POST", "/guest-register-records/:id/queue-ses")?.permissions, ["compliance.ses.submit"]);
    // Tanda 8a (design §4.6): closing a ticket is the cashier key pos.order.pay; the room-charge settlement still checks folio.charge.post in the service.
    assert.deepEqual(findRoutePermission("POST", "/pos/tickets/:id/close")?.permissions, ["pos.order.pay"]);
  });

  // Tanda 8a (RBAC · L0/L1): `admin` is «Administración de sistema» (no finance / operations keys, token sistemas) and
  // `owner` is «Propiedad» (read + approvals): only owner is still expected to open every read-gated screen.
  it("every template of the tokens that see the screen passes the route gate (assertPermissions), owner included", () => {
    for (const expected of READ_GATED_GETS) {
      const entry = findRoutePermission("GET", expected.path);
      assert.ok(entry);
      for (const template of [...expected.templates, "owner"] as RoleKey[]) {
        assert.doesNotThrow(() => assertPermissions(ROLE_PERMISSION_MAP[template], entry.permissions), `${template} → GET ${expected.path}`);
      }
    }
  });

  it("least privilege: the new read keys stay out of the templates whose token never opens those screens", () => {
    const newKeys: PermissionKey[] = ["folio.read", "pos.read", "tourist_tax.read"];
    for (const template of ["housekeeper", "maintenance", "revenue", "sales"] as RoleKey[]) {
      for (const key of newKeys) assert.equal(ROLE_PERMISSION_MAP[template].includes(key), false, `${template} must not hold ${key}`);
    }
    assert.equal(ROLE_PERMISSION_MAP.fnb.includes("folio.read"), false);
    assert.equal(ROLE_PERMISSION_MAP.fnb.includes("tourist_tax.read"), false);
    assert.ok(ROLE_PERMISSION_MAP.fnb.includes("pos.read"));
    // L1a's rejections still hold (nothing was removed, nothing write-ish was added).
    assert.equal(ROLE_PERMISSION_MAP.compliance.includes("folio.charge.post"), false);
    assert.equal(ROLE_PERMISSION_MAP.accountant.includes("compliance.ses.submit"), false);
    assert.equal(ROLE_PERMISSION_MAP.receptionist.includes("backoffice.access"), false);
    for (const template of ROLE_TEMPLATE_KEYS) {
      for (const key of ROLE_PERMISSION_MAP[template]) assert.ok(key in PERMISSIONS, `${template}: ${key} not in PERMISSIONS`);
    }
  });

  it("GET /developer/keyboard-shortcuts is retired (no consumer since the chrome lot)", () => {
    assert.equal(findRoutePermission("GET", "/developer/keyboard-shortcuts"), undefined);
  });
});

describe("route manifest · L1c read keys (invoices, SES settings, finance, secondary GETs of visible screens)", () => {
  it("every GET requires exactly its read key, the key exists, and every template of the token that sees the screen passes the gate", () => {
    for (const expected of L1C_READ_GATED_GETS) {
      const entry = findRoutePermission("GET", expected.path);
      assert.ok(entry, `GET ${expected.path} has no manifest entry`);
      assert.deepEqual(entry.permissions, [expected.permission], `GET ${expected.path}`);
      assert.ok(expected.permission in PERMISSIONS, `${expected.permission} not in PERMISSIONS`);
      // Tanda 8a: admin (Administración de sistema) no longer opens finance / operations screens; owner still reads everything.
      for (const template of [...expected.templates, "owner"] as RoleKey[]) {
        assert.doesNotThrow(() => assertPermissions(ROLE_PERMISSION_MAP[template], entry.permissions), `${template} → GET ${expected.path}`);
      }
    }
  });

  it("no invoice GET is gated by invoice.issue any more; issue/cancel/rectify keep their write keys", () => {
    const issueGatedGets = routePermissionManifest.filter((entry) => entry.method === "GET" && entry.permissions.includes("invoice.issue"));
    assert.deepEqual(issueGatedGets.map((entry) => entry.path), []);
    assert.deepEqual(findRoutePermission("POST", "/invoices/:id/issue")?.permissions, ["invoice.issue"]);
    assert.deepEqual(findRoutePermission("POST", "/invoices/:id/cancel")?.permissions, ["invoice.cancel"]);
    assert.deepEqual(findRoutePermission("POST", "/invoices/:id/rectify")?.permissions, ["invoice.issue"]);
    assert.deepEqual(findRoutePermission("PATCH", "/compliance/spain/properties/:propertyId/guest-register/settings")?.permissions, [
      "guest_register.configure",
      "compliance.ses.configure"
    ]);
  });

  it("payroll, banking, commissions and the fiscal calendar are no longer open to every template through analytics.read", () => {
    const analyticsGatedFinance = routePermissionManifest.filter(
      (entry) =>
        entry.method === "GET" &&
        entry.permissions.includes("analytics.read") &&
        /^\/(payroll|banking|commissions|finance\/exchange-rates|accounting\/fiscal-(years|periods))/.test(entry.path)
    );
    assert.deepEqual(analyticsGatedFinance.map((entry) => entry.path), []);
    // Least privilege: the finance read keys stay out of the operational templates
    // (receptionist keeps accounting.read only: the compliance inbox reads the
    // fiscal periods to warn about a closing period — reference data, no amounts).
    for (const template of ["receptionist", "housekeeper", "maintenance", "revenue", "fnb"] as RoleKey[]) {
      for (const key of ["payroll.read", "banking.read", "commissions.read"] as PermissionKey[]) {
        assert.equal(ROLE_PERMISSION_MAP[template].includes(key), false, `${template} must not hold ${key}`);
      }
    }
    for (const template of ["housekeeper", "maintenance", "revenue", "fnb", "sales"] as RoleKey[]) {
      assert.equal(ROLE_PERMISSION_MAP[template].includes("accounting.read"), false, `${template} must not hold accounting.read`);
    }
    // Employee data and bank statements stay with accountant (sister of compliance in the finanzas token).
    assert.equal(ROLE_PERMISSION_MAP.compliance.includes("payroll.read"), false);
    assert.equal(ROLE_PERMISSION_MAP.compliance.includes("banking.read"), false);
    assert.equal(ROLE_PERMISSION_MAP.sales.includes("invoice.read"), false, "sales handles no money");
    assert.equal(ROLE_PERMISSION_MAP.sales.includes("payroll.read"), false);
    // Dashboards keep analytics.read on purpose (documented L2: granularity of /dashboards/*).
    assert.deepEqual(findRoutePermission("GET", "/dashboards/finance-position")?.permissions, ["analytics.read"]);
  });

  it("modules.read is in every template: the module list feeds the menu, a 403 there hid every module-gated entry", () => {
    for (const path of MODULE_LIST_GETS) {
      const entry = findRoutePermission("GET", path);
      assert.ok(entry, `GET ${path}`);
      assert.deepEqual(entry.permissions, ["modules.read"]);
    }
    for (const template of ROLE_TEMPLATE_KEYS) {
      assert.ok(ROLE_PERMISSION_MAP[template].includes("modules.read"), `${template} lacks modules.read`);
    }
    // Enabling/disabling/configuring modules stays with owner, manager and admin.
    for (const template of ["receptionist", "housekeeper", "maintenance", "accountant", "compliance", "revenue", "sales", "fnb"] as RoleKey[]) {
      for (const key of ["modules.enable", "modules.disable", "modules.configure"] as PermissionKey[]) {
        assert.equal(ROLE_PERMISSION_MAP[template].includes(key), false, `${template} must not hold ${key}`);
      }
    }
  });
});
