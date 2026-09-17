import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Tanda 6b · L7 (design §5.3 «Switcher operativo»): the property switcher of the
// shell groups the rows of GET /users/me/properties by sociedad and, inside it,
// «Hoteles» first and «Centros no alojativos» (oficina central, otros) after;
// while the active centre is not a hotel the shell paints a banner that says
// what does not exist there and offers Finanzas. BackOfficeLayout.tsx reaches
// api-client (import.meta.env) and cannot load under node --test: the grouping
// and the banner decision are pinned on the source, the pure functions are
// re-evaluated here from their own text.

const layout = readFileSync(new URL("../BackOfficeLayout.tsx", import.meta.url), "utf8");

/** Compiles one exported pure function of the layout (type annotations stripped) and returns it. */
function pureFunction<T>(name: string): T {
  const start = layout.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} not found in BackOfficeLayout.tsx`);
  let depth = 0;
  let end = -1;
  for (let i = layout.indexOf("{", start); i < layout.length; i++) {
    if (layout[i] === "{") depth += 1;
    if (layout[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const text = layout
    .slice(start, end)
    .replace(/^export /, "")
    // strip the TypeScript annotations this small helper carries
    .replace(/: readonly StructuredPropertyRow\[\]/g, "")
    .replace(/: string\)/g, ")")
    .replace(/\): SwitcherGroup\[\] \{/, ") {")
    .replace(/\): StructuredPropertyRow \| null \{/, ") {")
    .replace(/new Map<string, SwitcherGroup>\(\)/, "new Map()");
  return new Function(`${text}; return ${name};`)() as T;
}

type Row = { id: string; name: string; organizationId: string; organizationName?: string; kind?: string; code?: string | null; legalEntityId?: string | null; legalEntityName?: string | null };

const ROWS: Row[] = [
  { id: "oc", name: "Oficina central", organizationId: "org_far", organizationName: "Faranda", kind: "office", code: "OC", legalEntityId: "le_far", legalEntityName: "CELUISMA S.A." },
  { id: "ra", name: "Rías Altas", organizationId: "org_far", organizationName: "Faranda", kind: "hotel", code: "RA", legalEntityId: "le_far", legalEntityName: "CELUISMA S.A." },
  { id: "lt", name: "Los Tilos", organizationId: "org_far", organizationName: "Faranda", kind: "hotel", code: "LT", legalEntityId: "le_far", legalEntityName: "CELUISMA S.A." },
  { id: "prop_123", name: "Anfitorio Madrid Centro", organizationId: "org_123", organizationName: "HotelOS Demo Group", kind: "hotel", code: "AMC", legalEntityId: "le_hd", legalEntityName: "HotelOS Demo SL" },
  { id: "legacy", name: "Sin estructura", organizationId: "org_old", organizationName: "Antigua" }
];

describe("shell · switcher agrupado por sociedad (Tanda 6b · L7)", () => {
  const groupSwitchableProperties = pureFunction<(rows: Row[]) => Array<{ key: string; label: string; hotels: Row[]; nonOperational: Row[] }>>("groupSwitchableProperties");
  const isNonOperationalCentre = pureFunction<(rows: Row[], propertyId: string) => Row | null>("isNonOperationalCentre");

  it("groups by sociedad in order of appearance, hotels first and the oficina central under «Centros no alojativos»", () => {
    const groups = groupSwitchableProperties(ROWS);
    assert.deepEqual(groups.map((g) => g.label), ["CELUISMA S.A.", "HotelOS Demo SL", "Antigua"]);
    assert.deepEqual(groups[0].hotels.map((r) => r.code), ["RA", "LT"]);
    assert.deepEqual(groups[0].nonOperational.map((r) => r.code), ["OC"]);
    assert.deepEqual(groups[1].nonOperational, []);
    assert.equal(groups[2].key, "org_old", "a row without sociedad groups by organization");
    assert.equal(groups[2].hotels.length, 1, "no kind → hotel (pre-6b rows)");
  });

  it("decides the office banner only for a non-hotel active centre", () => {
    assert.equal(isNonOperationalCentre(ROWS, "oc")?.code, "OC");
    assert.equal(isNonOperationalCentre(ROWS, "ra"), null);
    assert.equal(isNonOperationalCentre(ROWS, "legacy"), null, "rows without kind never trigger it");
    assert.equal(isNonOperationalCentre(ROWS, "missing"), null);
  });

  it("paints the group headings, the kind of a non-hotel row and the office banner with tokens only", () => {
    assert.match(layout, /groupSwitchableProperties\(properties as StructuredPropertyRow\[\]\)/);
    assert.match(layout, /heading: "Hoteles"/);
    assert.match(layout, /heading: "Centros no alojativos"/);
    assert.match(layout, /PROPERTY_KIND_LABELS\[kind\]/);
    assert.match(layout, /function OfficeCentreBanner\(/);
    assert.match(layout, /aria-label="Centro no alojativo activo"/);
    assert.match(layout, /Aquí trabajan Finanzas y Cumplimiento\./);
    assert.match(layout, /<OfficeCentreBanner onOpenFinance=\{\(\) => selectAndClose\("FinancePositionDashboard"\)\} \/>/);
    assert.equal((layout.match(/<OfficeCentreBanner /g) ?? []).length, 1, "mounted once, in the Cocoa shell (the legacy chrome was retired in wave 11)");
  });
});
