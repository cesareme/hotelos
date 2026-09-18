// Contrato · cadena de auditoría de los CLI de RBAC (Tanda 8a · integrador).
//
// El 2026-09-18, `rbac:migrate-assignments --apply` sobre Faranda creó 3
// asignaciones pero solo persistió 1 de los 3 ROLE_ASSIGNED: recordAuditEvent
// encola la escritura (queueAuditPersist) y el CLI llamaba a prisma.$disconnect()
// sin vaciar la cola («Engine is not yet connected»). Además ningún CLI de
// RBAC hidrataba la punta de la cadena hash antes de escribir (el primer
// evento del proceso enlazaba con el génesis). Este contrato pina la
// disciplina compartida (apps/api/src/lib/audit-chain-cli.ts): los tres CLI
// que auditan pasan por withAuditChain, que hidrata antes de escribir y vacía
// la cola antes de devolver (el llamador desconecta después).
//
// Ejecutar desde hotelos/: node --test tests/rbac-cli-audit-contract.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const helper = read("../apps/api/src/lib/audit-chain-cli.ts");

const CLIS = {
  "rbac-migrate-assignments.ts": { source: read("../apps/api/src/scripts/rbac-migrate-assignments.ts"), runner: "runMigration", writes: "flags.apply" },
  "reseed-property-roles.ts": { source: read("../apps/api/src/scripts/reseed-property-roles.ts"), runner: "runReseed", writes: "flags.apply" },
  "rbac-sync.ts": { source: read("../apps/api/src/scripts/rbac-sync.ts"), runner: "runRbacSync", writes: "!flags.dryRun" }
};

describe("audit-chain-cli.ts: hidratar antes de escribir, vaciar antes de desconectar", () => {
  it("usa hydrateAuditChainFromPostgres y flushAuditQueues del servicio de auditoría (nunca reimplementa la cadena)", () => {
    assert.match(helper, /import \{ flushAuditQueues, hydrateAuditChainFromPostgres \} from "\.\.\/modules\/audit\/audit\.service\.js";/);
    assert.match(helper, /hydrate: hydrateAuditChainFromPostgres/);
    assert.match(helper, /flush: flushAuditQueues/);
    assert.match(helper, /export async function withAuditChain</);
    // Hidrata solo cuando hay escrituras; vacía siempre (también tras un fallo de run).
    assert.match(helper, /if \(writes\) await chain\.hydrate\(\);/);
    assert.match(helper, /await chain\.flush\(\)\.catch\(\(\) => undefined\);\n\s+throw error;/);
  });
});

describe("los tres CLI de RBAC que auditan pasan por withAuditChain", () => {
  for (const [file, { source, runner, writes }] of Object.entries(CLIS)) {
    it(`${file}: ${runner} envuelve la ejecución con withAuditChain(…, ${writes}, …) y no llama a recordAuditEvent fuera de esa envoltura`, () => {
      assert.match(source, /import \{ defaultAuditChainCli, withAuditChain, type AuditChainCli \} from "\.\.\/lib\/audit-chain-cli\.js";/);
      const call = new RegExp(`return withAuditChain\\([^;]*${writes.replace(/[.!]/g, (c) => `\\${c}`)}[^;]*\\);`);
      assert.match(source, call, `${file}: ${runner} debe delegar en withAuditChain con writes = ${writes}`);
      // El runner exportado es la envoltura: la implementación queda en una función no exportada.
      assert.match(source, new RegExp(`export async function ${runner}\\(`));
      assert.doesNotMatch(source, /\$disconnect\(\)[\s\S]*flushAuditQueues\(/, "el flush nunca va después del $disconnect");
    });
  }

  it("el entrypoint de cada CLI desconecta prisma DESPUÉS del runner (el flush ya ocurrió dentro del runner)", () => {
    assert.match(CLIS["rbac-migrate-assignments.ts"].source, /const result = await runMigration\(flags\);[\s\S]*finally \{\n\s+await prisma\.\$disconnect\(\)/);
    assert.match(CLIS["reseed-property-roles.ts"].source, /await runReseed\(flags\)[\s\S]*finally \{\n\s+await prisma\.\$disconnect\(\)/);
    assert.match(CLIS["rbac-sync.ts"].source, /runRbacSync\(flags\)\n\s+\.then\(\(summary\) => \{[\s\S]*return prisma\.\$disconnect\(\);/);
  });
});
