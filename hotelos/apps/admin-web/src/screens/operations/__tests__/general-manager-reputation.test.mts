// Contract test · Tanda T8 · lote T8-G — fila del índice de reputación en
// Mi día › Dirección (screens/operations/GeneralManagerScreen.tsx), estático
// sobre el fuente (la pantalla carga api-client con `import.meta.env`):
//   · el tipo Data gana `reputationIndex?: GmReputationIndex`;
//   · DEGRADED_LABEL gana `reputation` (index30 + sources) y `nps` (nps30);
//   · la sección «Reviews score» pasa a «Índice de reputación (30 d)» dentro de
//     DegradedCard con ReputationFigure (CocoaStat + CocoaBadge) y ReviewsScore
//     desaparece (sus 2 style={ también: 12 → 10);
//   · NPS 30d lee reputationIndex.npsLast30 con «N reseñas» como meta;
//   · los rótulos pasan al español («Peticiones de servicio», «VIP alojados»);
//   · las acciones de la figura respetan los permisos (reputation.read para
//     «Configurar», modules.enable para «Activar módulo»);
//   · el skeleton de 7 filas sigue intacto.
// Desde apps/api:
//   TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test ../admin-web/src/screens/operations/__tests__/general-manager-reputation.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const src = readFileSync(new URL("../GeneralManagerScreen.tsx", import.meta.url), "utf8");
const STYLE_CEILING = 10;

describe("Mi día › Dirección · índice de reputación (T8-G)", () => {
  it("el tipo Data lleva reputationIndex tipado con GmReputationIndex del contrato compartido", () => {
    assert.match(src, /import type \{ GmReputationIndex \} from "\.\.\/\.\.\/services\/reputation-contracts"/);
    assert.match(src, /reputationIndex\?: GmReputationIndex;/);
    assert.match(src, /reputation\?: \{ avgScore\?: number; reviewsLast30: number; npsLast30\?: number \};/, "el bloque heredado `reputation` se conserva (contrato aditivo)");
  });

  it("DEGRADED_LABEL gana reputation (index30 + sources) y nps (nps30)", () => {
    assert.match(src, /reputation: \["reputation\.index30", "reputation\.sources"\]/);
    assert.match(src, /nps: "reputation\.nps30"/);
    assert.match(src, /<DegradedCard label=\{DEGRADED_LABEL\.reputation\} degraded=\{degraded\} title="Índice de reputación \(30 d\)">/);
    assert.match(src, /<DegradedCard label=\{DEGRADED_LABEL\.nps\} degraded=\{degraded\} title="NPS 30d">/);
  });

  it("la fila 5 pinta «Índice de reputación (30 d)» con ReputationFigure y retira ReviewsScore y «Reviews score»", () => {
    assert.match(src, /<CocoaSection title="Índice de reputación \(30 d\)"/);
    assert.match(src, /<ReputationFigure/);
    assert.match(src, /function ReputationFigure\(/);
    assert.doesNotMatch(src, /ReviewsScore/);
    assert.doesNotMatch(src, /Reviews score/);
    assert.doesNotMatch(src, /avgScore\.toFixed/);
    // La figura se construye con las primitivas, no con estilos locales.
    const figure = src.slice(src.indexOf("function ReputationFigure("), src.indexOf("interface ServiceRequestsListProps"));
    assert.ok(figure.length > 0, "ReputationFigure precede a ServiceRequestsList");
    assert.match(figure, /<CocoaStat /);
    assert.match(figure, /<CocoaBadge /);
    assert.doesNotMatch(figure, /\bstyle=\{/, "ReputationFigure no pinta style={");
    assert.match(figure, /reputationFigureModel\(/);
    assert.match(figure, /reputationFigureActionLabel\(/);
    assert.match(figure, /navigateTo\("ReputationDashboard"\)/);
    assert.match(figure, /navigateTo\("ModuleManager", "modulo=reputation_quality"\)/);
    // T8F-01: «Configurar» solo para quien puede escribir fuentes (reputation.respond), no para un lector.
    assert.match(figure, /canConfigure: canRespond\(gate\.grantedPermissions\)/);
    assert.doesNotMatch(figure, /canReadReputation\(/);
    assert.match(figure, /canEnableModules: gate\.canEnableModules/);
  });

  it("los estados honestos del índice se pasan a la figura (status · index30 · trendDelta · reviewCount30 · sourcesConnected · staleDays)", () => {
    for (const prop of ["status=", "index30=", "trendDelta=", "reviewCount30=", "sourcesConnected=", "staleDays="]) {
      assert.ok(src.includes(prop), `falta la prop ${prop} en <ReputationFigure>`);
    }
    assert.match(src, /reputationIndex\?\.status \?\? \(k\.reputation \? "insufficient" : "no_sources"\)/);
  });

  it("NPS 30d usa reputationIndex.npsLast30 (con el bloque heredado como respaldo) y «N reseñas» como meta", () => {
    assert.match(src, /const nps = reputationIndex\?\.npsLast30 \?\? k\.reputation\?\.npsLast30;/);
    assert.match(src, /const reviewsLast30 = reputationIndex\?\.reviewCount30 \?\? k\.reputation\?\.reviewsLast30 \?\? 0;/);
    assert.match(src, /meta=\{plural\(reviewsLast30, "reseña", "reseñas"\)\}/);
    assert.doesNotMatch(src, /\$\{reviewsLast30\} reviews/);
  });

  it("rótulos en español: «Peticiones de servicio» y «VIP alojados»; ninguno inglés", () => {
    assert.match(src, /title="Peticiones de servicio"/);
    assert.match(src, /VIP alojados/);
    assert.doesNotMatch(src, /Service requests|VIPs in-house/);
  });

  it(`style={ baja de 12 a ≤ ${STYLE_CEILING} y el skeleton de 7 filas sigue intacto`, () => {
    const n = (src.match(/\bstyle=\{/g) ?? []).length;
    assert.ok(n <= STYLE_CEILING, `GeneralManagerScreen tiene ${n} style={ (techo ${STYLE_CEILING})`);
    assert.match(src, /<CocoaSkeleton\.Strip count=\{11\} label="Cargando indicadores de hoy…" \/>/);
    assert.match(src, /<CocoaSkeleton\.Grid rows=\{\[\[8, 2, 2\], \[4, 4, 2, 2\]\]\} label="Cargando pace y mix…" \/>/);
    assert.match(src, /<CocoaSkeleton\.Strip count=\{5\} min=\{200\} label="Cargando salud operativa…" \/>/);
    assert.match(src, /<CocoaSkeleton\.Grid rows=\{\[\[3, 3, 3, 3\], \[3, 3, 3, 3\]\]\} height=\{110\} label="Cargando experiencia y cumplimiento…" \/>/);
    assert.match(src, /<CocoaSkeleton\.Grid rows=\{\[\[5, 4, 3\]\]\} label="Cargando insights…" \/>/);
  });
});
