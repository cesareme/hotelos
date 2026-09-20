// Unit tests · FIX-1 · F11 — directorio de terceros importados (`ledger-third-parties.service.ts`)
// sin base de datos: el `where` puro de la lista (organización, rol, búsqueda por código / NIF /
// cuenta / nombre), la clave y la condición keyset del cursor (rol, código, id) con sus 400,
// la regla de nombres (465 / 460 / 555 y «EMPLEADO nnnn» → null) y el lote más reciente por
// tercero a partir de entradas inventadas. Ninguna fila real: nombres de sociedades ficticias.
// Desde apps/api:
//   node --import tsx --test src/modules/accounting/import/__tests__/ledger-third-parties.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../../../../lib/http-error.js";
import { encodeCursor } from "../../../../lib/pagination.js";
import {
  buildThirdPartyWhere,
  isLegalEntityTaxId,
  latestLotByThirdParty,
  parseThirdPartyCursorKey,
  thirdPartyCursorKey,
  thirdPartyCursorWhere,
  thirdPartyDisplayName,
  type ThirdPartyLotEntry
} from "../ledger-third-parties.service.js";

const ORG = "org_f11_test";

describe("F11 · buildThirdPartyWhere", () => {
  it("sin filtros: solo la organización", () => {
    assert.deepEqual(buildThirdPartyWhere({ organizationId: ORG }), { organizationId: ORG });
    assert.deepEqual(buildThirdPartyWhere({ organizationId: ORG, q: "   ", role: null }), { organizationId: ORG });
  });

  it("rol y búsqueda: OR por código (sin mayúsculas), NIF (contiene, en mayúsculas), cuenta (empieza por) y nombre (sin mayúsculas)", () => {
    assert.deepEqual(buildThirdPartyWhere({ organizationId: ORG, role: "supplier", q: " a123 " }), {
      organizationId: ORG,
      role: "supplier",
      OR: [
        { sourceCode: { contains: "a123", mode: "insensitive" } },
        { taxId: { contains: "A123" } },
        { sourceAccount: { startsWith: "a123" } },
        { name: { contains: "a123", mode: "insensitive" } }
      ]
    });
    assert.deepEqual(buildThirdPartyWhere({ organizationId: ORG, role: "customer" }), { organizationId: ORG, role: "customer" });
  });
});

describe("F11 · cursor keyset (rol, código, id)", () => {
  it("la clave es <rol>|<código> y se descompone en el primer separador (el código puede llevar «|»)", () => {
    assert.equal(thirdPartyCursorKey({ role: "supplier", sourceCode: "42" }), "supplier|42");
    assert.deepEqual(parseThirdPartyCursorKey("customer|A|B"), { role: "customer", sourceCode: "A|B" });
  });

  it("una clave sin separador, con rol fuera del catálogo o sin código → 400 «El cursor de paginación no es válido.»", () => {
    for (const key of ["supplier", "|42", "proveedor|42", "supplier|", ""]) {
      assert.throws(
        () => parseThirdPartyCursorKey(key),
        (error: unknown) => error instanceof HttpError && error.statusCode === 400 && /cursor de paginación no es válido/.test(error.message),
        key
      );
    }
  });

  it("la condición «después del cursor» compara rol, luego código y por último id", () => {
    const cursor = encodeCursor({ k: "customer|C0010", id: "tp_10" });
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { k: string; id: string };
    assert.deepEqual(thirdPartyCursorWhere(decoded), {
      OR: [{ role: { gt: "customer" } }, { role: "customer", sourceCode: { gt: "C0010" } }, { role: "customer", sourceCode: "C0010", id: { gt: "tp_10" } }]
    });
  });
});

describe("F11 · regla de nombres", () => {
  const CIF = "B12345674";
  it("devuelve el nombre de las sociedades acreditadas por CIF (cuentas 400 / 410 / 430) y null en 465 / 460 / 555 y en los nombres con la palabra EMPLEADO", () => {
    assert.equal(thirdPartyDisplayName({ sourceAccount: "4000000042", name: "Suministros Ficticios del Norte SL", taxId: CIF }), "Suministros Ficticios del Norte SL");
    assert.equal(thirdPartyDisplayName({ sourceAccount: "4300000123", name: "Agencia Inventada SA", taxId: "A23456783" }), "Agencia Inventada SA");
    assert.equal(thirdPartyDisplayName({ sourceAccount: null, name: "Sociedad sin cuenta SL", taxId: "ESB12345674" }), "Sociedad sin cuenta SL", "CIF con prefijo ES");
    assert.equal(thirdPartyDisplayName({ sourceAccount: "4650040312", name: "Cualquier Nombre Inventado", taxId: CIF }), null, "465: remuneraciones pendientes");
    assert.equal(thirdPartyDisplayName({ sourceAccount: "4600000001", name: "Otro Nombre Inventado", taxId: CIF }), null, "460: anticipos");
    assert.equal(thirdPartyDisplayName({ sourceAccount: "5550000009", name: "Tercer Nombre Inventado", taxId: CIF }), null, "555: partidas pendientes");
    assert.equal(thirdPartyDisplayName({ sourceAccount: "4100000007", name: "EMPLEADO 0040312", taxId: CIF }), null, "nombre enmascarado");
    assert.equal(thirdPartyDisplayName({ sourceAccount: "4100000007", name: "empleado 0040312", taxId: CIF }), null, "sin distinguir mayúsculas");
    assert.equal(thirdPartyDisplayName({ sourceAccount: "4100000007", name: "   ", taxId: CIF }), null, "nombre vacío");
    assert.equal(thirdPartyDisplayName({ sourceAccount: null, name: "Resto EMPLEADO 0040312", taxId: CIF }), null, "la palabra EMPLEADO en cualquier posición (libros: «<palabra> EMPLEADO nnnn»)");
    assert.equal(thirdPartyDisplayName({ sourceAccount: null, name: "Asociación de Empleados Inventada", taxId: "G12345674" }), "Asociación de Empleados Inventada", "EMPLEADOS (otra palabra) se conserva");
    assert.equal(thirdPartyDisplayName({ sourceAccount: null, name: "Preempleado SL", taxId: CIF }), "Preempleado SL", "no casa dentro de otra palabra");
  });

  it("corrector FIX-1: DNI / NIE / pasaporte / identificador numérico / sin NIF → null (persona física o desconocido), aunque la subcuenta sea 400 / 410 / 430 o no haya cuenta", () => {
    for (const [taxId, why] of [
      ["12345678Z", "DNI"],
      ["X1234567L", "NIE"],
      ["Y1234567X", "NIE"],
      ["PA1234567", "pasaporte con dos letras que no son país con NIF-IVA"],
      ["YC1234567", "otro pasaporte"],
      ["1234567890J", "identificador numérico con letra"],
      ["12345678901", "identificador numérico"],
      ["K1234567L", "K: persona física española"],
      ["ES12345678Z", "DNI con prefijo ES"],
      [null, "sin NIF"],
      ["", "NIF vacío"]
    ] as const) {
      assert.equal(thirdPartyDisplayName({ sourceAccount: "4300000123", name: "Nombre Apellido Inventado", taxId }), null, why);
      assert.equal(thirdPartyDisplayName({ sourceAccount: null, name: "Nombre Apellido Inventado", taxId }), null, `${why} (sin cuenta)`);
      assert.equal(isLegalEntityTaxId(taxId), false, why);
    }
  });

  it("isLegalEntityTaxId: CIF de persona jurídica (con o sin ES) y NIF-IVA extranjero con prefijo de país reconocido; el resto no", () => {
    for (const taxId of ["B12345674", "A23456783", "W1234567A", "N1234567B", "esb12345674", "DE123456789", "PT123456789", "NL123456789B01", "GB123456789", "CHE123456789", "FR 12 345 678 901"]) assert.ok(isLegalEntityTaxId(taxId), taxId);
    for (const taxId of ["DE1234", "US12345678", "CO9001234567", "12345678Z", "X1234567L", "B1234567", "ESX1234567L"]) assert.equal(isLegalEntityTaxId(taxId), false, taxId);
    assert.equal(thirdPartyDisplayName({ sourceAccount: "4000000099", name: "Lieferant Nord GmbH", taxId: "DE123456789" }), "Lieferant Nord GmbH", "proveedor extranjero con NIF-IVA");
  });
});

describe("F11 · lote por tercero", () => {
  const lot = (id: string, createdAt: string, fileName: string | null = `${id}.csv`) => ({ id, fileName, createdAt: new Date(createdAt) });
  it("elige la entrada más reciente por (rol, código); empate por fecha → id mayor; los códigos sin entrada no aparecen", () => {
    const entries: ThirdPartyLotEntry[] = [
      { sourcePeriod: "supplier", sourceEntryNumber: "42", import: lot("imp_a", "2026-09-01T10:00:00.000Z") },
      { sourcePeriod: "supplier", sourceEntryNumber: "42", import: lot("imp_b", "2026-09-18T10:00:00.000Z", "terceros-2026-09.csv") },
      { sourcePeriod: "customer", sourceEntryNumber: "42", import: lot("imp_c", "2026-09-05T10:00:00.000Z") },
      { sourcePeriod: "customer", sourceEntryNumber: "7", import: lot("imp_d", "2026-09-05T10:00:00.000Z", null) },
      { sourcePeriod: "customer", sourceEntryNumber: "7", import: lot("imp_e", "2026-09-05T10:00:00.000Z") }
    ];
    const lots = latestLotByThirdParty(entries);
    assert.deepEqual(lots.get("supplier|42"), { importId: "imp_b", fileName: "terceros-2026-09.csv", createdAt: "2026-09-18T10:00:00.000Z" });
    assert.deepEqual(lots.get("customer|42"), { importId: "imp_c", fileName: "imp_c.csv", createdAt: "2026-09-05T10:00:00.000Z" });
    assert.deepEqual(lots.get("customer|7"), { importId: "imp_e", fileName: "imp_e.csv", createdAt: "2026-09-05T10:00:00.000Z" });
    assert.equal(lots.get("supplier|7"), undefined);
    assert.equal(latestLotByThirdParty([]).size, 0);
  });
});
