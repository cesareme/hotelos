// Unit tests · Tanda CIERRE-1 · lote C1b — GET /dashboards/procurement acotado
// por organización (T9 deuda 17e: `supplier.findMany({ active: true })` leía los
// proveedores de TODOS los tenants). Prisma falso inyectado por `deps.db` (sin
// base de datos, sin red), mismo estilo que front-desk-checkin.test.mts:
// fixtures ficticias, resultados esperados a mano. Desde apps/api:
//   node --import tsx --test src/modules/dashboards/__tests__/procurement-org-scope.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildProcurementDashboard, type ProcurementDashboardDeps } from "../procurement.service.js";

const PROPERTY = "prop_cierre_a";
const ORG_A = "org_cierre_a";
const ORG_B = "org_cierre_b";
const OTHER_TENANT_SUPPLIER_NAME = "Proveedor Ajeno B SL";
const NOW = new Date();

// ---------------------------------------------------------------- fixtures (ficticias)

type PurchaseOrderRow = {
  id: string;
  propertyId: string;
  supplierId: string | null;
  status: string;
  total: number;
  createdAt: Date;
  receivedAt: Date | null;
  promisedDate: Date | null;
  receivedDate: Date | null;
};
type SupplierRow = { id: string; organizationId: string; name: string; active: boolean };
type PropertyRow = { id: string; organizationId: string };

const po = (id: string, supplierId: string | null, status: string, total: number): PurchaseOrderRow => ({
  id,
  propertyId: PROPERTY,
  supplierId,
  status,
  total,
  createdAt: NOW,
  receivedAt: null,
  promisedDate: null,
  receivedDate: null
});

// Two ACTIVE suppliers, one per organisation, both referenced by POs of the property.
const suppliers: SupplierRow[] = [
  { id: "sup_a", organizationId: ORG_A, name: "Lavandería Ficticia A SL", active: true },
  { id: "sup_b", organizationId: ORG_B, name: OTHER_TENANT_SUPPLIER_NAME, active: true }
];
const properties: PropertyRow[] = [{ id: PROPERTY, organizationId: ORG_A }];
const purchaseOrders: PurchaseOrderRow[] = [po("po_1", "sup_a", "approved", 120), po("po_2", "sup_b", "ordered", 80), po("po_3", "sup_a", "draft", 10)];

type SupplierWhere = { active: boolean; organizationId?: string };
type PropertyFindUniqueArgs = { where: { id: string }; select?: Record<string, boolean> };

function fakeDb(): { deps: ProcurementDashboardDeps; calls: { supplierWhere: SupplierWhere[]; propertyFindUnique: PropertyFindUniqueArgs[] } } {
  const calls = { supplierWhere: [] as SupplierWhere[], propertyFindUnique: [] as PropertyFindUniqueArgs[] };
  const db = {
    purchaseOrder: {
      findMany: async (args: { where: { propertyId: string; createdAt?: { gte: Date; lte: Date } } }): Promise<PurchaseOrderRow[]> =>
        purchaseOrders.filter(
          (row) =>
            row.propertyId === args.where.propertyId &&
            (!args.where.createdAt || (row.createdAt >= args.where.createdAt.gte && row.createdAt <= args.where.createdAt.lte))
        )
    },
    supplier: {
      // Models the former leak on purpose: without `organizationId` in the where it returns every tenant's suppliers.
      findMany: async (args: { where: SupplierWhere }): Promise<SupplierRow[]> => {
        calls.supplierWhere.push(args.where);
        return suppliers.filter((row) => row.active === args.where.active && (args.where.organizationId === undefined || row.organizationId === args.where.organizationId));
      }
    },
    property: {
      findUnique: async (args: PropertyFindUniqueArgs): Promise<{ organizationId: string } | null> => {
        calls.propertyFindUnique.push(args);
        const row = properties.find((property) => property.id === args.where.id);
        return row ? { organizationId: row.organizationId } : null;
      }
    }
  };
  return { deps: { db: db as unknown as ProcurementDashboardDeps["db"] }, calls };
}

// ---------------------------------------------------------------- tests

describe("Tanda CIERRE-1 · /dashboards/procurement acotado por organización (T9 deuda 17e)", () => {
  it("CIERRE-1 · supplier.findMany recibe { active: true, organizationId } y solo cuenta proveedores de la organización", async () => {
    const { deps, calls } = fakeDb();
    const dashboard = await buildProcurementDashboard({ propertyId: PROPERTY, organizationId: ORG_A }, deps);
    assert.deepEqual(calls.supplierWhere, [{ active: true, organizationId: ORG_A }]);
    assert.equal(calls.propertyFindUnique.length, 0, "with an explicit organizationId the property is not re-read");
    // sup_a and sup_b are both referenced by POs, but only sup_a belongs to the organisation.
    assert.equal(dashboard.kpis.supplierCount, 1);
    assert.equal(dashboard.kpis.openPOs, 3);
    assert.equal(dashboard.kpis.committedValueEur, 200);
    // Corrector CIERRE-1 (FUN-05): the other tenant's supplier id (already in this property's PO row) is OMITTED from
    // topSuppliers — neither its NAME nor an English «Unknown supplier» placeholder reaches the payload of the Spanish screen.
    assert.deepEqual(dashboard.topSuppliers.map((supplier) => supplier.id), ["sup_a"]);
    assert.equal(dashboard.topSuppliers[0]?.name, "Lavandería Ficticia A SL");
    assert.equal(dashboard.topSuppliers[0]?.committedEur, 120);
    assert.equal(dashboard.recentPOs.find((row) => row.id === "po_2")?.supplierName, undefined);
    const serialised = JSON.stringify(dashboard);
    assert.ok(!serialised.includes(OTHER_TENANT_SUPPLIER_NAME), "the other organisation's supplier name leaks nowhere");
    assert.ok(!serialised.includes("Unknown supplier"), "no English placeholder row for an unresolved supplier (FUN-05)");
    assert.ok(!serialised.includes("sup_b"), "the unresolved supplier id is not listed either");
  });

  it("sin organizationId en la entrada la resuelve por property.findUnique; sin propiedad → 0 proveedores", async () => {
    const byProperty = fakeDb();
    const dashboard = await buildProcurementDashboard({ propertyId: PROPERTY }, byProperty.deps);
    assert.deepEqual(byProperty.calls.propertyFindUnique, [{ where: { id: PROPERTY }, select: { organizationId: true } }]);
    assert.deepEqual(byProperty.calls.supplierWhere, [{ active: true, organizationId: ORG_A }]);
    assert.equal(dashboard.kpis.supplierCount, 1);
    assert.ok(!JSON.stringify(dashboard).includes(OTHER_TENANT_SUPPLIER_NAME));

    const orphan = fakeDb();
    const empty = await buildProcurementDashboard({ propertyId: "prop_cierre_missing" }, orphan.deps);
    assert.equal(orphan.calls.propertyFindUnique.length, 1);
    assert.equal(orphan.calls.supplierWhere.length, 0, "no organisation → no supplier query at all (never an unfiltered findMany)");
    assert.equal(empty.kpis.supplierCount, 0);
    assert.deepEqual(empty.topSuppliers, []);
    assert.deepEqual(empty.recentPOs, []);
    assert.deepEqual(empty.posByStatus, []);
  });
});
