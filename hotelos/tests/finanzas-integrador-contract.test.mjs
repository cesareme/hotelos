// Finanzas · lote fix:integrador (2026-09-16) — contrato de texto de las
// correcciones t6#6 / t6#9 / t6#10 / t6#11 (sin BD; `corepack pnpm test`):
//   · t6#6  ninguna ruta de server.ts toma `query.organizationId` (ni
//           `body.organizationId`) a pelo con `?? request.userContext.organizationId`;
//           los dos listados de nóminas pasan por resolveOrganizationScope.
//   · t6#9  `accounting.reports.read` existe en PERMISSIONS y en PermissionKey;
//           la plantilla receptionist NO la lleva (conserva accounting.read =
//           calendario); manager / accountant / compliance sí; el manifiesto
//           principal no gatea ningún /accounting/reports/* con analytics.read y
//           los partials de finanzas se remapean en el compositor; la base
//           demo (demo-store) también lleva la clave.
//   · t6#10 la plantilla accountant lleva procurement.read/manage,
//           assets.read/manage y analytics.export.
//   · t6#11 POST /payroll/contracts y POST /commissions/rules parsean su
//           esquema zod .strict() (schemas/payroll-commissions.schemas.ts) y
//           el contrato comprueba que existe el perfil de empleado.
// El comportamiento HTTP real se prueba en
// tests/integration/integrador-fixes.test.mts (Postgres).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const serverSource = read("../apps/api/src/server.ts");
const manifestSource = read("../apps/api/src/security/route-permissions.ts");
const permissionsSource = read("../packages/shared/src/permissions.ts");
const typesSource = read("../packages/shared/src/types.ts");
const demoStoreSource = read("../apps/api/src/lib/demo-store.ts");
const schemasSource = read("../apps/api/src/schemas/payroll-commissions.schemas.ts");
const schemasIndexSource = read("../apps/api/src/schemas/index.ts");

/** Source of `app.<method>("<path>", async (request) => { … })` up to the next route registration. */
function handlerSource(method, path) {
  const start = serverSource.indexOf(`app.${method}("${path}", async (request)`);
  assert.ok(start >= 0, `${method.toUpperCase()} ${path} handler not found in server.ts`);
  const next = serverSource.indexOf("\n  app.", start + 1);
  return serverSource.slice(start, next < 0 ? undefined : next);
}

/** Body of a template in ROLE_PERMISSION_MAP (`  <key>: [ … ],`). */
function templateBlock(key) {
  const start = permissionsSource.indexOf(`\n  ${key}: [`);
  assert.ok(start >= 0, `template ${key} not found`);
  const end = permissionsSource.indexOf("\n  ],", start);
  return permissionsSource.slice(start, end);
}

function stripLineComments(source) {
  return source.replace(/^\s*\/\/.*$/gm, "");
}

describe("t6#6 · organizationId de la query nunca se toma a pelo", () => {
  it("server.ts no contiene `query.organizationId ?? request.userContext.organizationId` ni la variante de body", () => {
    assert.doesNotMatch(serverSource, /(query|q|body)\.organizationId \?\? request\.userContext\.organizationId/);
  });

  it("GET /payroll/contracts y GET /payroll/periods resuelven el ámbito con resolveOrganizationScope y validan la query con PayrollListQuerySchema", () => {
    for (const path of ["/payroll/contracts", "/payroll/periods"]) {
      const source = handlerSource("get", path);
      assert.match(source, /resolveOrganizationScope\(request, query\.organizationId\)/, path);
      assert.match(source, /parse\(PayrollListQuerySchema, request\.query \?\? \{\}, "query"\)/, path);
    }
  });
});

describe("t6#9 · accounting.reports.read separa los informes con importes del calendario fiscal", () => {
  it("la clave existe en PERMISSIONS y en PermissionKey; accounting.read sigue describiendo solo el calendario", () => {
    assert.match(permissionsSource, /"accounting\.reports\.read":\s*\n?\s*"Read the accounting books and reports with amounts/);
    assert.match(typesSource, /\| "accounting\.reports\.read"/);
    assert.match(permissionsSource, /"accounting\.read": "Read fiscal years, fiscal periods and exchange rates"/);
  });

  it("plantillas: receptionist conserva accounting.read y NO lleva accounting.reports.read; manager, accountant y compliance sí", () => {
    const reception = stripLineComments(templateBlock("receptionist"));
    assert.match(reception, /"accounting\.read"/);
    assert.doesNotMatch(reception, /"accounting\.reports\.read"/);
    for (const template of ["manager", "accountant", "compliance"]) {
      const block = stripLineComments(templateBlock(template));
      assert.match(block, /"accounting\.reports\.read"/, template);
      assert.match(block, /"accounting\.read"/, `${template} keeps the calendar key`);
    }
    for (const template of ["housekeeper", "maintenance", "revenue", "sales", "fnb"]) {
      assert.doesNotMatch(stripLineComments(templateBlock(template)), /"accounting\.reports\.read"/, template);
    }
  });

  it("el manifiesto principal no gatea ningún GET /accounting/reports/* con analytics.read ni accounting.read", () => {
    const loose = [...stripLineComments(manifestSource).matchAll(/path: "(\/accounting\/reports\/[^"]+)", permissions: \[([^\]]*)\]/g)]
      .filter((m) => /analytics\.read|"accounting\.read"/.test(m[2]))
      .map((m) => m[1]);
    assert.deepEqual(loose, []);
    for (const path of ["/accounting/reports/modelo-303", "/accounting/reports/modelo-390", "/accounting/reports/trial-balance", "/accounting/reports/pnl"]) {
      assert.match(manifestSource, new RegExp(`path: "${path.replace(/\//g, "\\/")}", permissions: \\["accounting\\.reports\\.read"\\]`), path);
    }
    // The calendar keeps its key.
    for (const path of ["/accounting/fiscal-periods", "/accounting/fiscal-years", "/finance/exchange-rates"]) {
      assert.match(manifestSource, new RegExp(`path: "${path.replace(/\//g, "\\/")}", permissions: \\["accounting\\.read"\\]`), path);
    }
  });

  it("los partials de finanzas se remapean en el compositor (requireAccountingReportsKey) y los spreads siguen intactos para los parsers", () => {
    for (const name of ["ledgerRoutePermissions", "fiscalRoutePermissions", "payablesRoutePermissions", "fixedAssetsRoutePermissions", "FINANCIAL_STATEMENTS_ROUTE_PERMISSIONS"]) {
      assert.match(manifestSource, new RegExp(`const ${name} = requireAccountingReportsKey\\(${name}(AsWritten|_AS_WRITTEN)\\);`), name);
      assert.match(manifestSource, new RegExp(`^\\s*\\.\\.\\.${name},`, "m"), `spread of ${name}`);
    }
    assert.match(manifestSource, /export function requireAccountingReportsKey\(/);
  });

  it("la base de permisos demo (demo-store) lleva la clave junto a las demás claves de lectura", () => {
    assert.match(demoStoreSource, /"accounting\.read",\s*\n(\s*\/\/.*\n)*\s*"accounting\.reports\.read",/);
  });
});

describe("t6#10 · la plantilla Contabilidad puede registrar proveedores, facturas recibidas e inmovilizado y exportar a la gestoría", () => {
  it("accountant lleva procurement.read, procurement.manage, assets.read, assets.manage y analytics.export", () => {
    const block = stripLineComments(templateBlock("accountant"));
    for (const key of ["procurement.read", "procurement.manage", "assets.read", "assets.manage", "analytics.export"]) {
      assert.match(block, new RegExp(`"${key.replace(".", "\\.")}"`), key);
    }
  });
});

describe("t6#11 · cuerpos zod estrictos en los escritores heredados de nóminas y comisiones", () => {
  it("las schemas viven en schemas/payroll-commissions.schemas.ts (strict, mensajes en español) y se reexportan desde el hub", () => {
    assert.match(schemasIndexSource, /export \* from "\.\/payroll-commissions\.schemas\.js";/);
    for (const name of ["CreatePayrollContractSchema", "CreateCommissionRuleSchema", "PayrollListQuerySchema"]) assert.match(schemasSource, new RegExp(`export const ${name} = z`), name);
    assert.match(schemasSource, /\.strict\(STRICT_BODY\)/);
    assert.match(schemasSource, /Campo no admitido en el cuerpo de la petición\./);
    assert.match(schemasSource, /Indica channelId o channelCode\./);
  });

  it("POST /payroll/contracts parsea el cuerpo, exige que exista el perfil de empleado (404 opaco) y comprueba su propiedad", () => {
    const source = handlerSource("post", "/payroll/contracts");
    assert.match(source, /parse\(CreatePayrollContractSchema, requireObjectBody\(request\.body \?\? \{\}\), "body"\)/);
    assert.match(source, /prisma\.staffProfile\.findUnique\(/);
    assert.match(source, /throw new NotFoundError\(STAFF_PROFILE_NOT_FOUND\)/);
    assert.match(source, /grantPropertyAccess\(request, staffProfile\.propertyId, STAFF_PROFILE_NOT_FOUND\)/);
    assert.match(source, /STAFF_PROFILE_PROPERTY_MISMATCH/);
    assert.match(source, /grossSalary: decimalInputToNumber\(body\.grossSalary\)/);
    assert.doesNotMatch(source, /\bNumber\(body\.grossSalary\)/);
  });

  it("POST /commissions/rules parsea el cuerpo y un channelId ajeno a la propiedad es un 404 opaco", () => {
    const source = handlerSource("post", "/commissions/rules");
    assert.match(source, /parse\(CreateCommissionRuleSchema, requireObjectBody\(request\.body \?\? \{\}\), "body"\)/);
    assert.match(source, /channel\.propertyId !== body\.propertyId\) throw new NotFoundError\("Canal no encontrado\."\)/);
    assert.doesNotMatch(source, /request\.body as \{/);
  });
});
