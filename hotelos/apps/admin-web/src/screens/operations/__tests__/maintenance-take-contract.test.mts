import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Source contract of FIX-1 · F9 (Mis averías › «Tomar»): the PATCH that moves a
// work order to in_progress also assigns it to the session user, so the card
// («Asignada a …», MaintenanceMobileScreen) and the desktop board («Asignada a»,
// MaintenanceDashboard) stop reading «Sin asignar» after a take.
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const source = stripComments(readFileSync(new URL("../MaintenanceMobileScreen.tsx", import.meta.url), "utf8"));
const setStatus = source.slice(source.indexOf("async function setStatus("), source.indexOf("function openNote("));

describe("Mis averías · «Tomar» asigna la orden al usuario (FIX-1 · F9)", () => {
  it("reads the session user through services/auth-storage getUser", () => {
    assert.match(source, /import \{ getUser \} from "\.\.\/\.\.\/services\/auth-storage";/);
    assert.match(setStatus, /const user = getUser\(\);/);
  });

  it("sends assignedTo (fullName, else email) only when the new status is in_progress", () => {
    assert.match(setStatus, /const assignedTo = status === "in_progress" \? user\?\.fullName \|\| user\?\.email \|\| undefined : undefined;/);
    assert.match(setStatus, /await mutate\(`\/work-orders\/\$\{item\.workOrderId\}`, "PATCH", assignedTo \? \{ status, assignedTo \} : \{ status \}\)/);
    assert.match(setStatus, /await mutate\(`\/work-orders\/\$\{item\.workOrderId\}\/resolve`, "POST", \{ releaseRoom: item\.blocksRoom \}\)/, "resolve keeps its dedicated endpoint");
  });

  it("the toast says «→ En curso · asignada a ti» after a take and keeps the plain form otherwise", () => {
    assert.match(setStatus, /\$\{label\}\$\{assignedTo \? " · asignada a ti" : ""\}/);
    assert.match(source, /in_progress: "En curso"/);
  });

  it("the card keeps painting «Asignada a …» from the API field", () => {
    assert.match(source, /item\.assignedTo \? <span style=\{captionStyle\}>Asignada a \{item\.assignedTo\}<\/span> : null/);
  });
});
