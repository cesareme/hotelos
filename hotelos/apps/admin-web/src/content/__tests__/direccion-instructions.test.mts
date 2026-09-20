// Contrato de la ayuda contextual de dirección (Tanda UX-2 · lote D8 ·
// docs/design/UX-DIRECCION-FEEL.md §1 P7 «Honestidad»): las cuatro tarjetas de
// content/screen-instructions/direccion.ts solo enumeran acciones que EXISTEN.
//   · cada «acción» citada (texto entre comillas angulares) es un literal de la
//     pantalla que monta la tarjeta (o de sus helpers / content/actions.ts; la
//     de Cartera también del detalle de la propiedad, que es su sub-URL);
//   · cada comando citado en el paso de ⌘K es una etiqueta de los `commands`
//     que la pantalla registra en CocoaPage;
//   · las teclas de acceso citadas (A · E) están cableadas como `accessKey` en
//     la pantalla y no son letras reservadas por la navegación global;
//   · los atajos salen del registro (shortcutKeys), nunca escritos a mano
//     (0 «⌘» / «⌥» en la fuente), y no hay promesas de tiempo;
//   · cada pantalla monta su tarjeta con `dismissible persistKey="direccion-…"`
//     (una vez, descartable) y las claves son únicas.
// Desde apps/admin-web:
//   node --import ../api/node_modules/tsx/dist/loader.mjs --test src/content/__tests__/direccion-instructions.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  DIRECCION_ACCESS_KEYS,
  DIRECCION_CARTERA_INSTRUCTIONS,
  DIRECCION_INFORMES_INSTRUCTIONS,
  DIRECCION_INSTRUCTIONS,
  DIRECCION_PANEL_INSTRUCTIONS,
  DIRECCION_PENDIENTES_INSTRUCTIONS
} from "../screen-instructions/direccion.ts";
import { RESERVED_ACCESS_LETTERS, shortcutKeys } from "../shortcuts-registry.ts";

const SRC = new URL("../../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, SRC), "utf8");
/** Fuente sin comentarios: el contrato es sobre lo que la pantalla pinta, no sobre su historia. */
const stripComments = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const code = (rel: string) => stripComments(read(rel));

const ACTIONS = code("content/actions.ts");
const SCREENS = {
  GeneralManagerScreen: code("screens/operations/GeneralManagerScreen.tsx"),
  ApprovalsScreen: code("screens/approvals/ApprovalsScreen.tsx"),
  PortfolioDashboard: code("screens/operations/PortfolioDashboard.tsx"),
  PropertyDetailScreen: code("screens/operations/PropertyDetailScreen.tsx"),
  ReportingCenterScreen: code("screens/reports/ReportingCenterScreen.tsx")
};
const HELPERS = {
  approvals: code("screens/approvals/approvals-helpers.ts"),
  portfolio: code("screens/operations/portfolio-compare.ts"),
  reporting: code("screens/reports/reporting-center-rows.ts")
};

type Card = { title: string; description: string; steps: readonly string[]; tip?: string };

/** Por tarjeta: la pantalla que la monta, las fuentes donde deben existir sus acciones y las pantallas cuyos `commands` puede citar. */
const CARDS: ReadonlyArray<{ id: string; card: Card; screen: keyof typeof SCREENS; persistKey: string; sources: string[]; commandScreens: Array<keyof typeof SCREENS> }> = [
  { id: "panel", card: DIRECCION_PANEL_INSTRUCTIONS, screen: "GeneralManagerScreen", persistKey: "direccion-panel", sources: [SCREENS.GeneralManagerScreen, ACTIONS], commandScreens: ["GeneralManagerScreen"] },
  { id: "pendientes", card: DIRECCION_PENDIENTES_INSTRUCTIONS, screen: "ApprovalsScreen", persistKey: "direccion-pendientes", sources: [SCREENS.ApprovalsScreen, HELPERS.approvals, ACTIONS], commandScreens: ["ApprovalsScreen"] },
  { id: "cartera", card: DIRECCION_CARTERA_INSTRUCTIONS, screen: "PortfolioDashboard", persistKey: "direccion-cartera", sources: [SCREENS.PortfolioDashboard, SCREENS.PropertyDetailScreen, HELPERS.portfolio, ACTIONS], commandScreens: ["PortfolioDashboard", "PropertyDetailScreen"] },
  { id: "informes", card: DIRECCION_INFORMES_INSTRUCTIONS, screen: "ReportingCenterScreen", persistKey: "direccion-informes", sources: [SCREENS.ReportingCenterScreen, HELPERS.reporting, ACTIONS], commandScreens: ["ReportingCenterScreen"] }
];

/**
 * Ejemplos calculados en runtime que no existen como literal: el título nominal
 * del diálogo de aprobación («Aprobar reembolso de 60,00 €») sale de
 * decisionDialogTitle (verbo + sustantivo del tipo + importe). Cada entrada
 * declara la plantilla que debe seguir existiendo en el helper.
 */
const COMPUTED_EXAMPLES: Record<string, { source: string; template: RegExp }> = {
  "Aprobar reembolso de 60,00 €": { source: HELPERS.approvals, template: /`\$\{verb\} \$\{noun\} de \$\{money\(request\.amount, request\.currency\)\}`/ }
};

const PALETTE = shortcutKeys("global.palette");
const TIME_PROMISES = /\b\d+\s*(segundos?|minutos?|horas?|ms)\b|en segundos|al instante|inmediat|próximamente|proximamente|pronto|garantiz/i;

function quoted(text: string): string[] {
  return Array.from(text.matchAll(/«([^«»]+)»/g), (m) => m[1]);
}

function textsOf(card: Card): string[] {
  return [card.description, ...card.steps, ...(card.tip ? [card.tip] : [])];
}

/** Literales de cadena dentro del bloque `commands={[ … ]}` de una pantalla (corchetes emparejados). */
function commandLiterals(source: string): Set<string> {
  const at = source.indexOf("commands={[");
  assert.ok(at >= 0, "la pantalla no registra commands={[…]}");
  const open = source.indexOf("[", at);
  let depth = 0;
  let end = -1;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "[") depth += 1;
    else if (source[index] === "]") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  assert.ok(end > open, "commands={[ sin cierre");
  const block = source.slice(open, end + 1);
  return new Set(Array.from(block.matchAll(/"((?:[^"\\]|\\.)*)"/g), (m) => m[1]));
}

describe("direccion.ts · forma de las cuatro tarjetas", () => {
  it("exporta Dirección · Pendientes · Cartera · Informes con description, ≥ 3 pasos distintos y tip", () => {
    assert.equal(CARDS.length, 4);
    assert.deepEqual(DIRECCION_INSTRUCTIONS.map((entry) => entry.persistKey), CARDS.map((entry) => entry.persistKey));
    for (const { id, card } of CARDS) {
      assert.ok(card.title.length >= 8, `${id}: título`);
      assert.ok(card.description.length >= 40, `${id}: description`);
      assert.ok(card.steps.length >= 3, `${id}: ${card.steps.length} pasos`);
      assert.equal(new Set(card.steps.map((step) => step.trim())).size, card.steps.length, `${id}: paso repetido`);
      assert.ok(card.tip && card.tip.length >= 40, `${id}: tip`);
      for (const step of card.steps) assert.doesNotMatch(step, /^\s*\d+[.)]\s/, `${id}: el paso no lleva ordinal a mano («${step.slice(0, 30)}…»)`);
    }
  });

  it("no promete tiempos ni flujos futuros", () => {
    for (const { id, card } of CARDS) {
      for (const text of textsOf(card)) assert.doesNotMatch(text, TIME_PROMISES, `${id}: «${text.slice(0, 60)}…»`);
    }
  });
});

describe("direccion.ts · cada «acción» citada existe en la pantalla (P7)", () => {
  for (const { id, card, sources } of CARDS) {
    it(`${id}: todos los literales entre «» están en la pantalla, sus helpers o content/actions.ts`, () => {
      const missing: string[] = [];
      for (const text of textsOf(card)) {
        for (const token of quoted(text)) {
          const example = COMPUTED_EXAMPLES[token];
          if (example) {
            assert.match(example.source, example.template, `${id}: el ejemplo «${token}» ya no sigue la plantilla del helper`);
            continue;
          }
          if (!sources.some((source) => source.includes(token))) missing.push(token);
        }
      }
      assert.deepEqual(missing, [], `${id}: acciones citadas que no existen en la pantalla`);
    });
  }
});

describe("direccion.ts · los comandos ⌘K citados están registrados en `commands`", () => {
  for (const { id, card, commandScreens } of CARDS) {
    it(`${id}: cada «comando» del paso de ${PALETTE} es una etiqueta de commands={[…]}`, () => {
      const registered = new Set<string>();
      for (const screen of commandScreens) for (const literal of commandLiterals(SCREENS[screen])) registered.add(literal);
      const paletteSteps = card.steps.filter((step) => step.includes(PALETTE));
      assert.ok(paletteSteps.length >= 1, `${id}: ninguna paso cita ${PALETTE}`);
      const cited = paletteSteps.flatMap((step) => quoted(step));
      // Pendientes registra dos comandos de tarea (aprobar · rechazar); el resto, tres o más.
      assert.ok(cited.length >= 2, `${id}: el paso de ${PALETTE} cita ${cited.length} comandos`);
      const unknown = cited.filter((label) => !registered.has(label));
      assert.deepEqual(unknown, [], `${id}: comandos citados que la pantalla no registra`);
    });
  }

  it("cita las tareas de dirección como comandos: pendientes, cierre, cartera, exportar, comparar, PyG", () => {
    const all = CARDS.flatMap(({ card }) => card.steps.flatMap((step) => (step.includes(PALETTE) ? quoted(step) : [])));
    for (const label of ["Ir a los pendientes de aprobación", "Revisar el cierre del día", "Abrir la cartera de hoteles", "Exportar un informe", "Aprobar la solicitud seleccionada", "Comparar hoteles", "PyG del hotel", "Generar exportación de informe"]) {
      assert.ok(all.includes(label), `falta el comando «${label}»`);
    }
  });
});

describe("direccion.ts · atajos y teclas de acceso", () => {
  const source = stripComments(read("content/screen-instructions/direccion.ts"));

  it("los atajos salen del registro: 0 «⌘» / «⌥» escritos a mano y shortcutKeys de la paleta y de ⌥", () => {
    assert.doesNotMatch(source, /[⌘⌥]/, "atajo escrito a mano");
    assert.match(source, /shortcutKeys\("global\.palette"\)/);
    assert.match(source, /shortcutKeys\("access\.reveal"\)/);
    assert.match(source, /shortcutKeys\("global\.enter"\)/);
    for (const { card } of CARDS) assert.ok(card.steps.some((step) => step.includes(PALETTE)), `${card.title}: ninguna paso muestra ${PALETTE}`);
    const pendientes = DIRECCION_PENDIENTES_INSTRUCTIONS.steps.join("\n");
    assert.ok(pendientes.includes(shortcutKeys("global.enter")), "Pendientes cita Intro desde el registro");
    assert.ok(pendientes.includes("mantén ⌥ y pulsa A"), "Pendientes explica ⌥ + A desde el registro");
    assert.ok(DIRECCION_INFORMES_INSTRUCTIONS.steps.join("\n").includes("mantener ⌥ y pulsar E"), "Informes explica ⌥ + E desde el registro");
  });

  it("A = «Aprobar» de la fila seleccionada (ApprovalsScreen) y E = «Generar exportación» (ReportingCenterScreen), fuera de las letras reservadas", () => {
    assert.equal(DIRECCION_ACCESS_KEYS.aprobar, "A");
    assert.equal(DIRECCION_ACCESS_KEYS.exportar, "E");
    assert.match(SCREENS.ApprovalsScreen, /accessKey=\{keyed \? "A" : undefined\}/);
    assert.match(SCREENS.ReportingCenterScreen, /accessKey="E"/);
    for (const letter of Object.values(DIRECCION_ACCESS_KEYS)) assert.ok(!RESERVED_ACCESS_LETTERS.includes(letter), `${letter} está reservada por la navegación global`);
  });
});

describe("montaje · cada pantalla pinta su tarjeta una vez, descartable y con clave propia", () => {
  const CONSTANT: Record<string, string> = {
    panel: "DIRECCION_PANEL_INSTRUCTIONS",
    pendientes: "DIRECCION_PENDIENTES_INSTRUCTIONS",
    cartera: "DIRECCION_CARTERA_INSTRUCTIONS",
    informes: "DIRECCION_INFORMES_INSTRUCTIONS"
  };

  for (const { id, screen, persistKey } of CARDS) {
    it(`${screen} monta <CocoaScreenInstructionsCard {...${CONSTANT[id]}} dismissible persistKey="${persistKey}" /> al final de la página`, () => {
      const source = SCREENS[screen];
      assert.match(source, /import \{ CocoaScreenInstructionsCard \} from "\.\.\/\.\.\/components\/cocoa-guidance\/CocoaScreenInstructionsCard";/);
      assert.ok(source.includes(`import { ${CONSTANT[id]} } from "../../content/screen-instructions/direccion";`), `${screen}: importa ${CONSTANT[id]}`);
      const mounts = source.match(/<CocoaScreenInstructionsCard\b/g) ?? [];
      assert.equal(mounts.length, 1, `${screen}: ${mounts.length} tarjetas`);
      assert.ok(source.includes(`<CocoaScreenInstructionsCard {...${CONSTANT[id]}} dismissible persistKey="${persistKey}" />`), `${screen}: montaje con dismissible + persistKey`);
      const mountAt = source.indexOf("<CocoaScreenInstructionsCard");
      const pageClose = source.indexOf("</CocoaPage>", mountAt);
      assert.ok(pageClose > mountAt, `${screen}: la tarjeta va dentro de CocoaPage`);
      assert.ok(!source.slice(mountAt, pageClose).includes("<CocoaSection"), `${screen}: la tarjeta va tras la última sección de la página`);
    });
  }

  it("las cuatro persistKey son distintas y llevan el prefijo direccion-", () => {
    const keys = CARDS.map((entry) => entry.persistKey);
    assert.equal(new Set(keys).size, keys.length);
    for (const key of keys) assert.match(key, /^direccion-[a-z]+$/);
  });
});
