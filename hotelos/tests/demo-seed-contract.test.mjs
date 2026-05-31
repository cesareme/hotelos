import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const databasePackage = JSON.parse(readFileSync(new URL("../packages/database/package.json", import.meta.url), "utf8"));
const seed = readFileSync(new URL("../packages/database/prisma/seed.ts", import.meta.url), "utf8");
const smoke = readFileSync(new URL("../scripts/smoke-demo.mjs", import.meta.url), "utf8");
const docs = readFileSync(new URL("../docs/deployment.md", import.meta.url), "utf8");

describe("Flagship demo seed contract", () => {
  it("adds seed and smoke scripts", () => {
    assert.equal(rootPackage.scripts["smoke:demo"], "node scripts/smoke-demo.mjs");
    assert.equal(databasePackage.scripts["db:seed"], "prisma db seed");
    assert.equal(databasePackage.prisma.seed, "tsx prisma/seed.ts");
  });

  it("seeds the room 432 check-in scenario", () => {
    for (const marker of ["org_123", "prop_123", "guest_maria", "RES-18392", "room_432", "folio_18392"]) {
      assert.match(seed, new RegExp(marker));
    }
  });

  it("seeds the blocked-room contrast and owner dashboard context", () => {
    assert.match(seed, /room_108/);
    assert.match(seed, /wo_108_leak/);
    assert.match(seed, /asset_hvac_432/);
  });

  it("records that the demo seed does not store ID document images", () => {
    assert.match(seed, /idDocumentImagesStored: false/);
    assert.match(seed, /DEMO_SEED_READY/);
  });

  it("has a dependency-free smoke contract for the flagship path", () => {
    assert.match(smoke, /Demo smoke contract ok/);
    assert.match(smoke, /ID_IMAGE_DISCARDED/);
    assert.match(smoke, /queueSesHospedajesSubmission/);
  });

  it("documents seed and smoke order", () => {
    assert.match(docs, /db:seed/);
    assert.match(docs, /smoke:demo/);
  });
});
