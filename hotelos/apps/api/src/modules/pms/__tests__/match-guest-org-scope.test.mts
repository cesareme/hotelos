// Tanda CHK (lote W1-C · R4): `matchGuestToReservation` delimita la búsqueda de
// huésped a la organización de la propiedad y, opcionalmente, acepta acompañantes.
// Sin base de datos: contrato por lectura de la fuente. El módulo usa el cliente
// `prisma` global (sin inyección de dependencias), así que no cabe un doble de
// Prisma sin tocar la firma del servicio; la verificación funcional se hace en
// runtime contra la BD del carril (informe del lote).
//
//   node --import tsx --test src/modules/pms/__tests__/match-guest-org-scope.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(new URL("../pms.service.ts", import.meta.url), "utf8");

function functionBlock(name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} no encontrada en pms.service.ts`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("matchGuestToReservation · alcance de organización (R4)", () => {
  const block = functionBlock("matchGuestToReservation");

  it("carga la propiedad (solo organizationId) y responde 404 si no existe", () => {
    assert.match(block, /const property = await prisma\.property\.findUnique\(\{\s*where:\s*\{\s*id:\s*input\.propertyId\s*\},\s*select:\s*\{\s*organizationId:\s*true\s*\}\s*\}\);/);
    assert.match(block, /if \(!property\) \{\s*throw new NotFoundError\("Propiedad no encontrada\."\);\s*\}/);
    // La propiedad se resuelve ANTES de buscar al huésped.
    assert.ok(block.indexOf("prisma.property.findUnique") < block.indexOf("prisma.guest.findFirst"));
  });

  it("el findFirst de guest lleva organizationId de la propiedad junto al OR de documento/nombre", () => {
    const finds = block.match(/prisma\.guest\.findFirst\(/g) ?? [];
    assert.equal(finds.length, 1, "una única búsqueda de huésped");
    assert.match(block, /prisma\.guest\.findFirst\(\{\s*where:\s*\{\s*organizationId:\s*property\.organizationId,\s*OR:\s*orClauses\s*\}\s*\}\)/);
    assert.doesNotMatch(block, /prisma\.guest\.findFirst\(\{\s*where:\s*\{\s*OR:\s*orClauses\s*\}\s*\}\)/, "no queda la búsqueda sin organización");
  });

  it("includeCompanions (opcional, por defecto false) omite el filtro isPrimary de los vínculos", () => {
    assert.match(block, /includeCompanions\?: boolean;/);
    assert.match(
      block,
      /prisma\.reservationGuest\.findMany\(\{\s*where:\s*input\.includeCompanions\s*\?\s*\{\s*guestId:\s*guestRow\.id\s*\}\s*:\s*\{\s*guestId:\s*guestRow\.id,\s*isPrimary:\s*true\s*\}\s*\}\)/
    );
  });

  it("la reserva sigue acotada a la propiedad pedida y a estados abiertos", () => {
    assert.match(block, /propertyId:\s*input\.propertyId,\s*status:\s*\{\s*in:\s*\["confirmed",\s*"draft"\]\s*\}/);
  });
});
