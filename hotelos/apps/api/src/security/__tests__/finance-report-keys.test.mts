// Finanzas (2026-09-16, fix t6#9 / t6#10 · integrador): the accounting reads
// that show amounts are gated by `accounting.reports.read` (manager,
// accountant, compliance, owner) and `accounting.read` stays the calendar key
// of Recepción (fiscal years/periods, exchange rates); the Contabilidad
// template can register suppliers, received invoices and fixed assets and
// export to the gestoría. Runs on the RUNTIME manifest (partials remapped at
// the import boundary of security/route-permissions.ts). From apps/api:
//   node --import tsx --test src/security/__tests__/finance-report-keys.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PERMISSIONS, ROLE_PERMISSION_MAP, ROLE_TEMPLATE_KEYS, assertPermissions, type PermissionKey, type RoleKey } from "@hotelos/shared";
import {
  ACCOUNTING_CALENDAR_GET_PATHS,
  ACCOUNTING_CALENDAR_KEY,
  ACCOUNTING_REPORTS_KEY,
  findRoutePermission,
  requireAccountingReportsKey,
  routePermissionManifest,
  type ApiRoutePermission
} from "../route-permissions.js";

/** The reads the security review opened to a real Recepción session (t6#9) plus the payables / assets lists. */
const AMOUNT_GETS = [
  "/accounting/journal",
  "/accounting/journal/export",
  "/accounting/journal/:id",
  "/accounting/ledger/:accountCode",
  "/fiscal/models/:modelo",
  "/fiscal/models/:modelo/pdf",
  "/fiscal/vat-books",
  "/fiscal/vat-settlement",
  "/accounting/annual-accounts",
  "/accounting/annual-accounts/balance",
  "/accounting/annual-accounts/pyg",
  "/accounting/usali/pnl",
  "/accounting/usali/compare",
  "/accounting/reports/modelo-303",
  "/accounting/reports/modelo-390",
  "/accounting/reports/modelo-111",
  "/accounting/reports/modelo-115",
  "/accounting/reports/modelo-180",
  "/accounting/reports/trial-balance",
  "/accounting/reports/balance-sheet",
  "/accounting/reports/cash-flow",
  "/accounting/reports/pnl",
  "/properties/:propertyId/payables/supplier-bills",
  "/properties/:propertyId/payables/aging",
  "/properties/:propertyId/payables/expenses",
  "/organizations/:organizationId/depreciation-runs"
];

// Tanda 8a (RBAC · L0): `admin` is «Administración de sistema» without finance keys; `owner` (Propiedad) still reads amounts.
const FINANCE_READERS: RoleKey[] = ["manager", "accountant", "compliance", "owner"];
const NEVER_FINANCE: RoleKey[] = ["receptionist", "housekeeper", "maintenance", "revenue", "sales", "fnb"];

/** The Contabilidad writes of the ERP (t6#10): suppliers, received invoices, fixed assets, gestoría export. */
const ACCOUNTANT_ERP_ROUTES: Array<{ method: ApiRoutePermission["method"]; path: string }> = [
  { method: "POST", path: "/organizations/:organizationId/payables/suppliers" },
  { method: "POST", path: "/properties/:propertyId/payables/supplier-bills" },
  { method: "POST", path: "/properties/:propertyId/asset-register" },
  { method: "GET", path: "/properties/:propertyId/asset-register" },
  { method: "POST", path: "/accounting/gestoria-exports" },
  { method: "GET", path: "/accounting/gestoria-exports" }
];

describe("accounting.reports.read · the finance reads with amounts leave the calendar key (t6#9)", () => {
  it("the key exists in the catalog and requireAccountingReportsKey only rewrites accounting.read", () => {
    assert.ok(ACCOUNTING_REPORTS_KEY in PERMISSIONS);
    assert.equal(ACCOUNTING_CALENDAR_KEY, "accounting.read");
    const remapped = requireAccountingReportsKey([
      { method: "GET", path: "/x", permissions: ["accounting.read"], riskLevel: "medium" },
      { method: "GET", path: "/y", permissions: ["accounting.read", "analytics.read"], riskLevel: "medium" },
      { method: "POST", path: "/z", permissions: ["accounting.journal.post"], riskLevel: "high" }
    ]);
    assert.deepEqual(
      remapped.map((entry) => entry.permissions),
      [["accounting.reports.read"], ["accounting.reports.read", "analytics.read"], ["accounting.journal.post"]]
    );
  });

  it("every GET still carrying accounting.read is a calendar read (fiscal years, fiscal periods, exchange rates)", () => {
    const calendarGets = routePermissionManifest
      .filter((entry) => entry.method === "GET" && entry.permissions.includes(ACCOUNTING_CALENDAR_KEY))
      .map((entry) => entry.path)
      .sort();
    assert.deepEqual(calendarGets, [...ACCOUNTING_CALENDAR_GET_PATHS].sort());
    for (const path of ACCOUNTING_CALENDAR_GET_PATHS) {
      assert.deepEqual(findRoutePermission("GET", path)?.permissions, ["accounting.read"], `GET ${path}`);
      assert.doesNotThrow(() => assertPermissions(ROLE_PERMISSION_MAP.receptionist, ["accounting.read"]), "reception keeps the calendar");
    }
  });

  /**
   * Tanda 8a (design §4.3): reads that left accounting.reports.read for their
   * module key — the journal EXPORT is the gestoría export (M10 · P,
   * analytics.export: accountant, controller, auditor…) and the supplier
   * bills / aging are M9 · V (payables.read: admin_clerk, manager, accountant,
   * controller…; compliance holds neither).
   */
  const EXPORT_GETS: Record<string, PermissionKey> = {
    "/accounting/journal/export": "analytics.export",
    "/properties/:propertyId/payables/supplier-bills": "payables.read",
    "/properties/:propertyId/payables/aging": "payables.read"
  };

  it("every finance read with amounts requires exactly accounting.reports.read (the journal export, analytics.export); finanzas + direccion pass, reception does not", () => {
    for (const path of AMOUNT_GETS) {
      const entry = findRoutePermission("GET", path);
      assert.ok(entry, `GET ${path} has no manifest entry`);
      const expected = EXPORT_GETS[path] ?? ACCOUNTING_REPORTS_KEY;
      assert.deepEqual(entry.permissions, [expected], `GET ${path}`);
      for (const template of FINANCE_READERS) {
        if (path in EXPORT_GETS && !ROLE_PERMISSION_MAP[template].includes(expected)) continue; // module key of §4.3: not every finance reader holds it (direccion de hotel does not export the books; cumplimiento has no M9)
        assert.doesNotThrow(() => assertPermissions(ROLE_PERMISSION_MAP[template], entry.permissions), `${template} → GET ${path}`);
      }
      assert.throws(() => assertPermissions(ROLE_PERMISSION_MAP.receptionist, entry.permissions), `receptionist must be refused on GET ${path}`);
    }
    assert.ok(ROLE_PERMISSION_MAP.accountant.includes("analytics.export"), "contabilidad exports to the gestoría");
    assert.ok(ROLE_PERMISSION_MAP.accountant.includes("payables.read") && ROLE_PERMISSION_MAP.manager.includes("payables.read"), "contabilidad and dirección read the supplier bills");
  });

  it("no /accounting, /fiscal or payables GET is open through analytics.read or accounting.read any more", () => {
    const loose = routePermissionManifest.filter(
      (entry) =>
        entry.method === "GET" &&
        /^\/(accounting|fiscal)\/|\/payables\/|\/depreciation-runs/.test(entry.path) &&
        !ACCOUNTING_CALENDAR_GET_PATHS.includes(entry.path) &&
        entry.permissions.some((key) => key === "analytics.read" || key === "accounting.read")
    );
    assert.deepEqual(
      loose.map((entry) => `${entry.path} → ${entry.permissions.join(",")}`),
      [],
      "finance reads must carry accounting.reports.read (or a narrower key), not the dashboard / calendar keys"
    );
  });

  it("least privilege: only the templates whose token opens finance screens hold the key; nothing was removed", () => {
    for (const template of NEVER_FINANCE) {
      assert.equal(ROLE_PERMISSION_MAP[template].includes(ACCOUNTING_REPORTS_KEY), false, `${template} must not hold ${ACCOUNTING_REPORTS_KEY}`);
    }
    for (const template of ["manager", "accountant", "compliance"] as RoleKey[]) {
      assert.ok(ROLE_PERMISSION_MAP[template].includes(ACCOUNTING_REPORTS_KEY), `${template} holds ${ACCOUNTING_REPORTS_KEY}`);
      assert.ok(ROLE_PERMISSION_MAP[template].includes("accounting.read"), `${template} keeps the calendar key`);
    }
    // Reception keeps exactly what Tanda 5 gave it for the compliance inbox.
    assert.ok(ROLE_PERMISSION_MAP.receptionist.includes("accounting.read"));
    for (const template of ROLE_TEMPLATE_KEYS) {
      for (const key of ROLE_PERMISSION_MAP[template]) assert.ok(key in PERMISSIONS, `${template}: ${key} not in PERMISSIONS`);
    }
  });
});

describe("Contabilidad template · suppliers, received invoices, fixed assets and gestoría export (t6#10)", () => {
  const ERP_KEYS: PermissionKey[] = ["procurement.read", "procurement.manage", "assets.read", "assets.manage", "analytics.export"];

  it("the accountant template holds the ERP keys and passes every payables / asset-register / gestoría gate", () => {
    for (const key of ERP_KEYS) assert.ok(ROLE_PERMISSION_MAP.accountant.includes(key), `accountant holds ${key}`);
    for (const route of ACCOUNTANT_ERP_ROUTES) {
      const entry = findRoutePermission(route.method, route.path);
      assert.ok(entry, `${route.method} ${route.path} has no manifest entry`);
      assert.doesNotThrow(() => assertPermissions(ROLE_PERMISSION_MAP.accountant, entry.permissions), `accountant → ${route.method} ${route.path}`);
    }
  });

  it("the ERP write keys stay out of reception and compliance (the finanzas sister only reads)", () => {
    for (const template of ["receptionist", "compliance", "housekeeper", "maintenance", "fnb"] as RoleKey[]) {
      for (const key of ["procurement.manage", "assets.manage"] as PermissionKey[]) {
        assert.equal(ROLE_PERMISSION_MAP[template].includes(key), false, `${template} must not hold ${key}`);
      }
    }
  });
});

describe("payroll and commissions gates are unchanged by the fix (t6#6 / t6#11 are handler-level)", () => {
  it("GET lists keep payroll.read / commissions.read and the writers keep payroll.manage / accounting.journal.post", () => {
    assert.deepEqual(findRoutePermission("GET", "/payroll/contracts")?.permissions, ["payroll.read"]);
    assert.deepEqual(findRoutePermission("GET", "/payroll/periods")?.permissions, ["payroll.read"]);
    assert.deepEqual(findRoutePermission("POST", "/payroll/contracts")?.permissions, ["payroll.manage"]);
    assert.deepEqual(findRoutePermission("GET", "/commissions/rules")?.permissions, ["commissions.read"]);
    assert.deepEqual(findRoutePermission("POST", "/commissions/rules")?.permissions, ["accounting.journal.post"]);
  });
});
