/**
 * Carga el `.env` de la raíz ANTES de que una suite fije `process.env.DATABASE_URL ??= …/hotelos`
 * (Tanda T9 · corrector R3): sin esto, una suite lanzada sin `--env-file-if-exists=../../.env`
 * (o desde otro worktree) cae en la BD PRINCIPAL `hotelos` con sus tenants de prueba. Mismo
 * comportamiento que `node --env-file`: una variable ya definida en el proceso nunca se pisa.
 *
 *   import "./helpers/load-env.mts";   // primera línea de imports de la suite
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

if (existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // Un .env ilegible no debe tumbar la suite: quedan los valores por defecto de cada fichero.
  }
}

export const LOADED_ENV_FILE: string | null = existsSync(ENV_FILE) ? ENV_FILE : null;
