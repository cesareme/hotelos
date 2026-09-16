import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SYSTEM_ACTOR_LABELS, actorHint, actorLabel, isSystemActor } from "../actor-label.ts";

// qa#10 (Cocoa 22 · Tanda 6 · lote 6-C): the entry drawer painted
// «por usr_system_accounting_replay» — the SYSTEM_USER_ID of the replay CLI —
// under «Contabilizado». Actor ids are never shown to a person: system actors
// are named by their process, the session by its own name, anybody else as
// «otro usuario».

const API_SCRIPTS_DIR = fileURLToPath(new URL("../../../../../api/src/scripts/", import.meta.url));
const JOURNAL_SCREEN = fileURLToPath(new URL("../JournalScreen.tsx", import.meta.url));

/** Every `export const SYSTEM_USER_ID = "usr_system_…"` declared by the API CLIs. */
function systemUserIdsOfTheApi(): string[] {
  const ids = new Set<string>();
  for (const file of readdirSync(API_SCRIPTS_DIR)) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(`${API_SCRIPTS_DIR}${file}`, "utf8");
    for (const match of source.matchAll(/export const SYSTEM_USER_ID = "(usr_system_[a-z0-9_]+)"/g)) ids.add(match[1]);
  }
  return [...ids].sort();
}

describe("Contabilidad · actor de un asiento (createdBy)", () => {
  it("names every system actor of the API CLIs by its process, never by its id", () => {
    const ids = systemUserIdsOfTheApi();
    assert.ok(ids.length >= 5, `se esperaban los SYSTEM_USER_ID de apps/api/src/scripts (hay ${ids.length})`);
    for (const id of ids) {
      assert.ok(isSystemActor(id), `${id} debe reconocerse como actor de sistema`);
      const label = SYSTEM_ACTOR_LABELS[id];
      assert.ok(label, `${id}: falta su nombre en SYSTEM_ACTOR_LABELS (screens/accounting/actor-label.ts)`);
      const hint = actorHint(id);
      assert.equal(hint, `Sistema · ${label}`);
      assert.doesNotMatch(hint ?? "", /usr_|_/, `${id}: la etiqueta no puede dejar ver el id`);
    }
  });

  it("falls back to «Sistema» for a system actor it does not know", () => {
    assert.deepEqual(actorLabel("usr_system_future_job"), { kind: "system", label: "Sistema" });
    assert.equal(actorHint("usr_system_future_job"), "Sistema");
  });

  it("names the current session by its own name and keeps the raw id out", () => {
    const session = { userId: "cmrhw9jyb0005fyvb4ykaumyc", fullName: "Carmen Ferreiro" };
    assert.deepEqual(actorLabel(session.userId, session), { kind: "self", label: "Carmen Ferreiro" });
    assert.equal(actorHint(session.userId, session), "por Carmen Ferreiro");
    assert.equal(actorHint(session.userId, { userId: session.userId, fullName: "  " }), "por ti");
  });

  it("calls anybody else «otro usuario» unless a directory resolves the name", () => {
    const session = { userId: "cmrhw9jyb0005fyvb4ykaumyc", fullName: "Carmen Ferreiro" };
    assert.equal(actorHint("usr_123", session), "por otro usuario");
    assert.equal(actorHint("usr_123", null), "por otro usuario");
    assert.equal(actorHint("usr_123", session, { usr_123: "Recepción Rías Altas" }), "por Recepción Rías Altas");
    assert.doesNotMatch(actorHint("cmu1mifcp0000fyo1wzvq7txo", session) ?? "", /cmu1/);
  });

  it("returns nothing when no actor was recorded", () => {
    assert.equal(actorLabel(null), null);
    assert.equal(actorLabel(undefined), null);
    assert.equal(actorLabel("   "), null);
    assert.equal(actorHint(null), undefined);
  });

  it("is what the Diario drawer paints under «Contabilizado»", () => {
    const source = readFileSync(JOURNAL_SCREEN, "utf8");
    assert.doesNotMatch(source, /por \$\{selected\.createdBy\}/, "el drawer no puede interpolar createdBy en crudo");
    assert.match(source, /hint=\{actorHint\(selected\.createdBy, session\)\}/);
  });
});
