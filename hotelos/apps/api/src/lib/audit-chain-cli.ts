// Cadena de auditoría para los CLI que escriben eventos (Tanda 8a · integrador).
//
// Los CLI de RBAC (rbac:migrate-assignments, reseed-property-roles y
// rbac:sync --upgrade-templates) auditan ROLE_ASSIGNED, ROLE_CREATED_FROM_TEMPLATE
// y ROLE_TEMPLATE_UPGRADED con recordAuditEvent, que encola la persistencia
// (queueAuditPersist, fire-and-forget) y enlaza cada evento con la punta EN
// MEMORIA de la cadena hash. Un proceso de CLI que no la hidrata enlaza su
// primer evento con el génesis (bifurca la cadena) y, si llama a
// prisma.$disconnect() sin vaciar la cola, pierde los eventos aún encolados
// («Engine is not yet connected»: ocurrió el 2026-09-18 con 2 de los 3
// ROLE_ASSIGNED del backfill de Faranda). Mismo patrón que import-sage200.ts y
// backfill-legal-structure.ts: hidratar ANTES de escribir, vaciar ANTES de
// desconectar. `withAuditChain` lo hace en un solo sitio para los tres CLI.
import { flushAuditQueues, hydrateAuditChainFromPostgres } from "../modules/audit/audit.service.js";

export type AuditChainCli = {
  /** Lee la punta de la cadena (audit_events / event_stream) desde Postgres antes de la primera escritura. */
  hydrate: () => Promise<unknown>;
  /** Espera a que la cola de persistencia de auditoría quede vacía. */
  flush: () => Promise<void>;
};

export const defaultAuditChainCli: AuditChainCli = {
  hydrate: hydrateAuditChainFromPostgres,
  flush: flushAuditQueues
};

/**
 * Ejecuta `run` dentro de la disciplina de la cadena: hidrata solo cuando el
 * CLI va a escribir (`writes`; un dry-run no toca la cadena) y vacía la cola
 * SIEMPRE al terminar, también cuando `run` falla (los eventos ya encolados de
 * una ejecución parcial deben persistirse antes del $disconnect del llamador).
 * Un fallo del flush solo se propaga si `run` terminó bien: el error original
 * nunca queda enmascarado.
 */
export async function withAuditChain<T>(chain: AuditChainCli, writes: boolean, run: () => Promise<T>): Promise<T> {
  if (writes) await chain.hydrate();
  let result: T;
  try {
    result = await run();
  } catch (error) {
    await chain.flush().catch(() => undefined);
    throw error;
  }
  await chain.flush();
  return result;
}
