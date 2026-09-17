// Cocoa 22 · ola 11 · lote api-datos: «Desconectar» on an email connection that
// was never authorised deletes the row instead of leaving a «Gmail ·
// desconectado» ghost (QA residue cmu4783rt004wfyztsms5lmme of Rías Altas).
// Pure core only (disconnectOutcome): no database. Run from apps/api with
//   node --import tsx --test src/modules/integrations/email/__tests__/email-connections.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { disconnectOutcome } from "../email-reservation.service.js";

describe("disconnectOutcome — delete a never-authorised connection, disconnect the rest", () => {
  it("pending_auth without a refresh token was never authorised: delete", () => {
    assert.equal(disconnectOutcome({ status: "pending_auth", oauthRefreshToken: null }), "delete");
    assert.equal(disconnectOutcome({ status: "pending_auth", oauthRefreshToken: undefined }), "delete");
    assert.equal(disconnectOutcome({ status: "pending_auth", oauthRefreshToken: "" }), "delete");
  });

  it("anything that ever held credentials is kept as disconnected", () => {
    assert.equal(disconnectOutcome({ status: "pending_auth", oauthRefreshToken: "refresh-token" }), "disconnect");
    assert.equal(disconnectOutcome({ status: "connected", oauthRefreshToken: "refresh-token" }), "disconnect");
    assert.equal(disconnectOutcome({ status: "connected", oauthRefreshToken: null }), "disconnect", "IMAP and manual connections have no OAuth token");
    assert.equal(disconnectOutcome({ status: "error", oauthRefreshToken: null }), "disconnect");
    assert.equal(disconnectOutcome({ status: "disconnected", oauthRefreshToken: null }), "disconnect", "disconnecting twice stays idempotent");
  });
});
