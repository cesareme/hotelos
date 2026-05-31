import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("AI Gateway contract", () => {
  it("exposes text command execution without direct DB access", () => {
    const server = readFileSync(new URL("../apps/ai-gateway/src/server.ts", import.meta.url), "utf8");
    assert.match(server, /"\/ai\/commands\/text"/);
    assert.match(server, /api\.get/);
    assert.match(server, /api\.post/);
    assert.doesNotMatch(server, /@hotelos\/database|@prisma\/client|PrismaClient/);
  });

  it("routes low-risk maintenance commands through the backend work-order tool", () => {
    const server = readFileSync(new URL("../apps/ai-gateway/src/server.ts", import.meta.url), "utf8");
    assert.match(server, /CREATE_MAINTENANCE_WORK_ORDER/);
    assert.match(server, /"\/work-orders"/);
    assert.match(server, /blocksRoom: false/);
  });

  it("keeps assign-room commands confirmation gated", () => {
    const server = readFileSync(new URL("../apps/ai-gateway/src/server.ts", import.meta.url), "utf8");
    assert.match(server, /ASSIGN_ROOM/);
    assert.match(server, /confirmation_required/);
    assert.doesNotMatch(server, /\/reservations\/\$\{.*assign-room/);
  });
});

