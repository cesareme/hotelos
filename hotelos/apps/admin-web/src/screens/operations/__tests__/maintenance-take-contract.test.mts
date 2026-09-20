import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MANT_TOASTS } from "../../../content/pisos-actions.ts";

// Source contract of FIX-1 · F9 (Mis averías › «Tomar»), actualizado en la Tanda
// UX-3 · P3 (diseño §4.4, D7): the PATCH that moves a work order to in_progress
// also assigns it to the session user, so the card («Asignada a …»,
// MaintenanceMobileScreen) and the desktop board («Asignada a»,
// MaintenanceDashboard) stop reading «Sin asignar» after a take. The take is
// optimistic (useApiData.mutate) and the toast offers «Deshacer», whose inverse
// PATCH leaves the order open and unassigned. «Resuelta» keeps its dedicated
// endpoint (deferred 8 s, see maintenance-feel.test.mts).
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const source = stripComments(readFileSync(new URL("../MaintenanceMobileScreen.tsx", import.meta.url), "utf8"));
const between = (from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `bloque «${from}» … «${to}» no encontrado`);
  return source.slice(start, end);
};
const take = between("async function take(", "async function untake(");
const untake = between("async function untake(", "function resolve(");
const resolve = between("function resolve(", "function openNote(");

describe("Mis averías · «Tomar» asigna la orden al usuario (FIX-1 · F9 · UX-3 · P3)", () => {
  it("reads the session user through services/auth-storage getUser (once per render)", () => {
    assert.match(source, /import \{ getUser \} from "\.\.\/\.\.\/services\/auth-storage";/);
    assert.match(source, /const user = getUser\(\);/);
    assert.match(take, /const assignedTo = user\?\.fullName \|\| user\?\.email \|\| undefined;/);
  });

  it("the take is optimistic (mutate) and the PATCH sends in_progress + assignedTo (fullName, else email)", () => {
    assert.match(take, /await mutate\(/);
    assert.match(take, /withItem\(prev, id, \{ status: "in_progress", assignedTo \}\)/, "la tarjeta pasa a en curso y asignada antes de la respuesta");
    assert.match(
      take,
      /await request<unknown>\(`\/work-orders\/\$\{id\}`, \{ method: "PATCH", body: assignedTo \? \{ status: "in_progress", assignedTo \} : \{ status: "in_progress" \} \}\)/
    );
    assert.doesNotMatch(take, /refresh\(\)/, "sin refresh() completo tras la acción (F1)");
  });

  it("the toast is MANT_TOASTS.taken («→ En curso · asignado a ti») with a «Deshacer» action", () => {
    assert.match(take, /MANT_TOASTS\.taken\(ref\)/);
    assert.match(take, /action: \{ label: MANT_ACTIONS\.undo, onAction: \(\) => untake\(item\) \}/);
    assert.equal(MANT_TOASTS.taken("a1c3n"), "Parte a1c3n → En curso · asignado a ti");
  });

  it("«Deshacer» sends the inverse PATCH { status: open, assignedTo: null } (D7) and restores the card optimistically", () => {
    assert.match(untake, /withItem\(prev, id, \{ status: "open", assignedTo: undefined \}\)/);
    assert.match(untake, /await request<unknown>\(`\/work-orders\/\$\{id\}`, \{ method: "PATCH", body: \{ status: "open", assignedTo: null \} \}\)/);
    assert.match(untake, /MANT_TOASTS\.undone\(ref\)/);
  });

  it("«Resuelta» keeps its dedicated endpoint (POST /resolve with releaseRoom) and never a PATCH to resolved", () => {
    assert.match(resolve, /await request<unknown>\(`\/work-orders\/\$\{id\}\/resolve`, \{\s*method: "POST",\s*body: \{ releaseRoom: item\.blocksRoom \},/);
    assert.doesNotMatch(source, /status: "resolved"/, "resolved solo se alcanza por POST /resolve (terminal en el API)");
  });

  it("the card keeps painting «Asignada a …» from the API field and the status through the shared dictionary", () => {
    assert.match(source, /item\.assignedTo \? <span style=\{captionStyle\}>Asignada a \{item\.assignedTo\}<\/span> : null/);
    assert.match(source, /import \{ priorityLabel, woStatusLabel \} from "\.\/operations-director-labels";/);
    assert.match(source, /woStatusLabel\(item\.status\)/);
    assert.doesNotMatch(source, /const STATUS_LABEL\b/, "sin mapa local de estados (F2, P6)");
    assert.doesNotMatch(source, /const PRIORITY_LABEL\b/, "sin mapa local de prioridades (F2, P6)");
  });
});
