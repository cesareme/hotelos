// Corrector L5 (CS-08) · puerta raíz para los tests unitarios de @hotelos/compliance.
//
// El script `test` de packages/compliance (node --experimental-strip-types con el
// loader de TS de verifactu/__tests__) no forma parte de ninguna puerta (raíz,
// unit API, front, worker, integración): el test del validador del parte de
// viajeros (estado ready_to_sign / missing_data, menores · Tanda L5 · L5-B1) se
// quedaba fuera. Este contrato lanza esa suite tal como la ejecuta el paquete y
// falla si algún test falla o si el fichero desaparece.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const packageDir = fileURLToPath(new URL("../packages/compliance/", import.meta.url));
const loader = "./src/spain/verifactu/__tests__/register-ts-loader.mjs";
// Tanda CHK · CHK-W1-B: el parser MRZ (ICAO 9303 TD1/TD2/TD3, dígitos de control 7-3-1) entra en la misma puerta.
const suites = ["src/spain/__tests__/guest-register-validator.test.mjs", "src/spain/__tests__/indirect-tax.test.mjs", "src/spain/__tests__/invoice-totals.test.mjs", "src/spain/__tests__/mrz.test.mjs"];

describe("@hotelos/compliance · tests unitarios del paquete dentro de la puerta raíz (corrector L5 · CS-08)", () => {
  it("los ficheros existen (validador del parte de viajeros y parser MRZ incluidos)", () => {
    for (const suite of suites) assert.ok(existsSync(new URL(suite, `file://${packageDir}`)), `${suite} debe existir`);
  });

  it("la suite del paquete pasa con el loader de TS del propio paquete (0 fallos)", () => {
    // Sin NODE_TEST_CONTEXT: un `--test` hijo de otro runner escribe su informe por el canal del padre, no por stdout.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "--import", loader, "--test", ...suites], { cwd: packageDir, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    // Reporter `spec` («ℹ pass N») o `tap` («# pass N»), según el runner de Node.
    assert.match(output, /^(?:# |ℹ )pass [1-9]\d*$/m, output.slice(-800));
    assert.match(output, /^(?:# |ℹ )fail 0$/m, output.slice(-800));
    // La suite MRZ se ejecutó de verdad (oráculo del Apéndice A de ICAO 9303 P3), no solo existe en disco.
    assert.match(output, /mrzCheckDigit — ICAO 9303 P3 Appendix A/, output.slice(-800));
  });
});
