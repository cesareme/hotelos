// Contrato del diccionario de estados (Tanda UX-1 · lote U2; UX-RECEPCION-FEEL
// §1.1 P6, §4 «Diccionario de estados con icono», §10 D5 y R6).
//
// Un solo sitio para etiqueta + tono + icono de los estados de reserva y de
// habitación: content/status-dictionary.ts. Aquí se comprueba, leyendo la
// fuente (sin comentarios), que:
//   1 · ninguna pantalla ni componente del cronograma declara un mapa local
//       `Record<…, CocoaTone>` (o `{ tone: CocoaTone … }`) con claves de estado
//       de reserva u habitación (confirmed, checked_in, checked_out, no_show,
//       clean, dirty, inspected);
//   2 · tampoco un mapa local de etiquetas `Record<string, string>` con dos o
//       más de esas claves;
//   3 · ningún badge de reserva o habitación cae al enum crudo (`X[…] ?? status`,
//       `?? row.status`, `?? tile.housekeepingStatus`) cuando X es un mapa de
//       estados declarado en el fichero;
//   4 · las pantallas migradas en U2 no conservan el vocabulario retirado
//       («En casa», «Salida realizada», «Alojada/Alojado», «No presentado»);
//   5 · el diccionario, el badge, los iconos, frontdesk-labels y el motor del
//       cronograma están cableados como dice el diseño.
// Lista de excepciones explícita y VACÍA: si un fichero necesita salirse de
// la regla, se añade aquí con su motivo y se documenta en el lote.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const adminSrc = fileURLToPath(new URL("../apps/admin-web/src/", import.meta.url));
const DICTIONARY = "content/status-dictionary.ts";
const SCAN_DIRS = ["screens", "components/timeline"];

/** fichero (relativo a apps/admin-web/src) → motivo. Vacía a propósito. */
const EXCEPTIONS = new Map([]);

/** Claves del enum de reserva y de habitación que solo puede etiquetar el diccionario. */
const STATUS_KEYS = ["confirmed", "checked_in", "checked_out", "no_show", "clean", "dirty", "inspected"];
const STATUS_KEY_RE = new RegExp(`^\\s*(?:${STATUS_KEYS.join("|")})\\s*:`, "gm");

/** Pantallas y módulos migrados en U2: no conservan el vocabulario retirado. */
const MIGRATED = [
  "screens/operations/FrontDeskDashboard.tsx",
  "screens/reservations/ReservationsListScreen.tsx",
  "screens/reservations/ReservationWorkspaceScreen.tsx",
  "screens/operations/PropertyDetailScreen.tsx",
  "screens/guests/GuestProfileScreen.tsx",
  "screens/guests/GuestTimelineScreen.tsx",
  "screens/guestJourney/GuestJourneyWorkspace.tsx",
  "screens/operations/RoomRackScreen.tsx",
  "screens/operations/GroupsPickupCard.tsx",
  "screens/operations/HousekeepingDashboard.tsx",
  "screens/operations/HousekeepingMobileScreen.tsx",
  "screens/operations/frontdesk-labels.ts",
  "screens/timeline/timeline-engine.ts",
  "components/timeline/timeline-presentation.ts"
];
const RETIRED_VOCABULARY = [/«?\bEn casa\b/, /\bSalida realizada\b/, /\bAlojad[ao]\b/, /\bNo presentado\b/];

const posix = (file) => relative(adminSrc, file).split(sep).join("/");
const stripComments = (source) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__tests__") walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((dir) => walk(join(adminSrc, dir))).map((full) => [posix(full), stripComments(readFileSync(full, "utf8"))]);
const read = (rel) => stripComments(readFileSync(join(adminSrc, rel), "utf8"));
const lineOf = (src, index) => src.slice(0, index).split("\n").length;

/** Literal `{ … }` con llaves emparejadas a partir de la llave de apertura en `start`. */
function objectLiteral(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

/** Declaraciones `const NAME: <tipo> = { … }` con su literal. */
function declaredMaps(src) {
  const maps = [];
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*:\s*([^=\n]*?)\s*=\s*\{/g)) {
    const literal = objectLiteral(src, m.index + m[0].length - 1);
    maps.push({ name: m[1], type: m[2], literal, line: lineOf(src, m.index) });
  }
  return maps;
}
const statusKeysOf = (literal) => new Set([...literal.matchAll(STATUS_KEY_RE)].map((m) => m[0].trim().replace(/\s*:$/, "")));

function offenders(rule) {
  const hits = [];
  for (const [rel, src] of files) {
    if (rel === DICTIONARY || EXCEPTIONS.has(rel)) continue;
    for (const hit of rule(rel, src)) hits.push(`${rel}: ${hit}`);
  }
  return hits;
}

describe("status-dictionary · contrato (UX-1 · U2)", () => {
  it("0 · la lista de excepciones está vacía", () => {
    assert.equal(EXCEPTIONS.size, 0);
  });

  it("1 · 0 mapas locales Record<…, CocoaTone> con claves de estado de reserva u habitación fuera del diccionario", () => {
    assert.deepEqual(
      offenders((rel, src) =>
        declaredMaps(src)
          .filter((map) => /CocoaTone|\btone\s*:/.test(map.type))
          .filter((map) => statusKeysOf(map.literal).size > 0)
          .map((map) => `${map.line} ${map.name}: ${map.type} con claves ${[...statusKeysOf(map.literal)].join(", ")}`)
      ),
      []
    );
  });

  it("2 · 0 mapas locales de etiquetas Record<string, string> con claves de estado de reserva u habitación", () => {
    assert.deepEqual(
      offenders((rel, src) =>
        declaredMaps(src)
          .filter((map) => /Record<\s*string\s*,\s*string\s*>/.test(map.type))
          .filter((map) => statusKeysOf(map.literal).size >= 2)
          .map((map) => `${map.line} ${map.name}: claves ${[...statusKeysOf(map.literal)].join(", ")}`)
      ),
      []
    );
  });

  it("3 · 0 `?? status` / `?? row.status` / `?? x.housekeepingStatus` crudos en badges de reserva o habitación", () => {
    // Un «mapa de estados» es un literal con dos o más claves del enum de reserva
    // u habitación (así EVENT_LABEL con solo `no_show` o los estados de otros
    // dominios —GDPR, nóminas, módulos— no cuentan). Caer a `UNKNOWN_STATUS` o a
    // un literal en español no es caer al enum.
    assert.deepEqual(
      offenders((rel, src) => {
        const hits = [];
        const statusMaps = declaredMaps(src).filter((map) => statusKeysOf(map.literal).size >= 2);
        for (const map of statusMaps) {
          const re = new RegExp(`\\b${map.name}\\[[^\\]]*\\]\\s*\\?\\?\\s*([\\w.]+)`, "g");
          for (const m of src.matchAll(re)) {
            if (m[1] === "UNKNOWN_STATUS") continue;
            hits.push(`${lineOf(src, m.index)} ${m[0].trim()}`);
          }
        }
        for (const m of src.matchAll(/\?\?\s*(?:[\w.]+\.)?housekeepingStatus\b/g)) hits.push(`${lineOf(src, m.index)} ${m[0].trim()}`);
        for (const m of src.matchAll(/<Cocoa(?:Status)?Badge\b[\s\S]*?(?:\/>|<\/Cocoa(?:Status)?Badge>)/g)) {
          const badge = m[0];
          if (!statusMaps.some((map) => badge.includes(`${map.name}[`))) continue;
          for (const raw of badge.matchAll(/\?\?\s*(?:[\w.]+\.)?(?:status|housekeepingStatus)\b/g)) {
            hits.push(`${lineOf(src, m.index)} badge con enum crudo: ${raw[0].trim()}`);
          }
        }
        return hits;
      }),
      []
    );
  });

  it("4 · las pantallas migradas no conservan «En casa», «Salida realizada», «Alojada/Alojado» ni «No presentado»", () => {
    const hits = [];
    for (const rel of MIGRATED) {
      const src = read(rel);
      for (const re of RETIRED_VOCABULARY) {
        for (const m of src.matchAll(new RegExp(re.source, "g"))) hits.push(`${rel}:${lineOf(src, m.index)} «${m[0]}»`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it("5 · diccionario, badge, iconos, frontdesk-labels y motor del cronograma cableados", () => {
    const dictionary = read(DICTIONARY);
    for (const name of ["RESERVATION_STATUS", "ROOM_STATUS", "BAR_KIND", "UNKNOWN_STATUS"]) assert.match(dictionary, new RegExp(`export const ${name}\\b`), `${DICTIONARY} exporta ${name}`);
    for (const fn of ["reservationStatus", "roomStatus", "statusLabels", "statusTones"]) assert.match(dictionary, new RegExp(`export function ${fn}\\b`), `${DICTIONARY} exporta ${fn}()`);
    assert.match(dictionary, /export \{ STATUS_LABELS \}/, "STATUS_LABELS se reexporta de content/actions, no se duplica");
    assert.match(dictionary, /import \{ STATUS_LABELS \} from "\.\/actions"/);
    assert.doesNotMatch(dictionary, /from "react"|from "\.\.\/components\/cocoa"(?!\/cocoa-tones)/, "el diccionario no arrastra React ni el barrel Cocoa");
    for (const label of ["En el hotel", "Salida hecha", "No-show", "Cancelada", "Confirmada", "Borrador", "Limpia", "Inspeccionada", "Sucia", "Ocupada", "Bloqueada", "Fuera de servicio", "Llega hoy", "Sale hoy"]) {
      assert.ok(dictionary.includes(`"${label}"`) || (label === "Borrador" && dictionary.includes("STATUS_LABELS.draft")), `vocabulario D5: «${label}»`);
    }

    const badge = read("components/cocoa/CocoaStatusBadge.tsx");
    assert.match(badge, /uppercase=\{false\}/, "CocoaStatusBadge pinta en minúsculas");
    assert.match(badge, /export function CocoaStatusBadge\(/);
    assert.match(badge, /dense/, "prop dense para los tiles del tablero");
    assert.doesNotMatch(badge, /\bstyle=\{/, "CocoaStatusBadge sin style= inline");
    assert.match(read("components/cocoa/index.ts"), /export \* from "\.\/CocoaStatusBadge";/);

    const icons = read("components/cocoa-icons/StatusIcons.tsx");
    for (const icon of ["KeyIcon", "BroomIcon", "EuroIcon", "ArrowInIcon", "ArrowOutIcon", "UserSlashIcon", "MoonIcon"]) {
      assert.match(icons, new RegExp(`export function ${icon}\\(props: CocoaIconProps\\)`), `${icon} con el contrato de cocoa-icons`);
      assert.ok(badge.includes(icon), `CocoaStatusBadge resuelve ${icon}`);
    }

    const labels = read("screens/operations/frontdesk-labels.ts");
    assert.match(labels, /from "\.\.\/\.\.\/content\/status-dictionary"/, "frontdesk-labels reexporta del diccionario");
    assert.equal(declaredMaps(labels).filter((map) => statusKeysOf(map.literal).size > 0).length, 0, "frontdesk-labels sin mapas literales de estado");
    for (const fn of ["reservationStatusLabel", "housekeepingStatusLabel", "roomOptionLabel"]) assert.match(labels, new RegExp(`export function ${fn}\\(`));

    const engine = read("screens/timeline/timeline-engine.ts");
    assert.match(engine, /from "\.\.\/\.\.\/content\/status-dictionary"/);
    assert.match(engine, /export const BAR_KIND_TONE: Record<BarKind, CocoaTone> = statusTones\(BAR_KIND\);/);
    assert.match(engine, /export const BAR_KIND_LABEL: Record<BarKind, string> = statusLabels\(BAR_KIND\);/);
    assert.match(engine, /export const RES_STATUS_LABEL: Record<string, string> = statusLabels\(RESERVATION_STATUS\);/);
    assert.match(engine, /export const ROOM_STATUS_LABEL: Record<RoomStatusKey, string> = /);
    assert.match(engine, /export const ROOM_STATUS_TONE: Record<RoomStatusKey, CocoaTone> = /);

    for (const rel of MIGRATED.filter((f) => f.endsWith(".tsx") && f !== "screens/operations/frontdesk-labels.ts")) {
      assert.match(read(rel), /CocoaStatusBadge/, `${rel} pinta el estado con CocoaStatusBadge`);
    }
    assert.ok(existsSync(join(adminSrc, "content/__tests__/status-dictionary.test.mts")), "test unitario del diccionario");
  });
});
