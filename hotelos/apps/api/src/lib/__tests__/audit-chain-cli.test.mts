// withAuditChain (Tanda 8a · integrador): hidratar antes de escribir, vaciar
// la cola siempre, nunca enmascarar el error de la ejecución. Run from apps/api:
//   node --import tsx --test src/lib/__tests__/audit-chain-cli.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultAuditChainCli, withAuditChain, type AuditChainCli } from "../audit-chain-cli.js";

function spyChain(options: { flushError?: Error } = {}): { chain: AuditChainCli; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    chain: {
      hydrate: async () => {
        calls.push("hydrate");
        return { auditTail: "tip" };
      },
      flush: async () => {
        calls.push("flush");
        if (options.flushError) throw options.flushError;
      }
    }
  };
}

describe("withAuditChain", () => {
  it("con escrituras: hydrate → run → flush, en ese orden, y devuelve el resultado de run", async () => {
    const { chain, calls } = spyChain();
    const result = await withAuditChain(chain, true, async () => {
      calls.push("run");
      return 42;
    });
    assert.equal(result, 42);
    assert.deepEqual(calls, ["hydrate", "run", "flush"]);
  });

  it("dry-run (sin escrituras): no hidrata, pero vacía la cola igualmente", async () => {
    const { chain, calls } = spyChain();
    await withAuditChain(chain, false, async () => {
      calls.push("run");
      return null;
    });
    assert.deepEqual(calls, ["run", "flush"]);
  });

  it("si run falla, vacía la cola y propaga el error original (un fallo del flush no lo enmascara)", async () => {
    const { chain, calls } = spyChain({ flushError: new Error("flush roto") });
    await assert.rejects(
      withAuditChain(chain, true, async () => {
        calls.push("run");
        throw new Error("run roto");
      }),
      /run roto/
    );
    assert.deepEqual(calls, ["hydrate", "run", "flush"]);
  });

  it("si run termina bien y el flush falla, el fallo del flush se propaga (los eventos no se dan por persistidos)", async () => {
    const { chain } = spyChain({ flushError: new Error("flush roto") });
    await assert.rejects(withAuditChain(chain, true, async () => "ok"), /flush roto/);
  });

  it("la cadena por defecto usa hydrateAuditChainFromPostgres y flushAuditQueues del servicio de auditoría", () => {
    assert.equal(typeof defaultAuditChainCli.hydrate, "function");
    assert.equal(typeof defaultAuditChainCli.flush, "function");
    assert.equal(defaultAuditChainCli.hydrate.name, "hydrateAuditChainFromPostgres");
    assert.equal(defaultAuditChainCli.flush.name, "flushAuditQueues");
  });
});
