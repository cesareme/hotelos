import { randomBytes } from "node:crypto";

// Ids con prefijo + 16 hex (64 bits aleatorios completos). Hasta la fusión T8
// (E1) eran 8 hex (32 bits): con ~184.000 filas en audit_events/event_stream,
// la carga OPERA del 2026-09-19 produjo 4 colisiones reales (P2002) y esos
// eventos se perdieron. Se amplían TODOS los prefijos (ninguna columna del
// esquema Prisma limita la longitud). randomBytes en vez de un prefijo de UUID
// v4: un UUID fija 6 bits (versión y variante) y aquí se quieren los 64 enteros.
export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
