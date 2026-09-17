// Cocoa 22 · ola 11 · lote api-datos: «Desconectar» on an email connection that
// was never authorised deletes the row instead of leaving a «Gmail ·
// desconectado» ghost (QA residue cmu4783rt004wfyztsms5lmme of Rías Altas).
// Tanda 7b · L3: propósito `pms_shadow` del buzón (purposeOf) y filtro puro de
// adjuntos (extensión csv | txt | xml | xlsx y tamaño ≤ 5 MiB), asunto y remitente.
// Pure core only: no database. Run from apps/api with
//   node --import tsx --test src/modules/integrations/email/__tests__/email-connections.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PMS_SHADOW_MAX_FILE_BYTES } from "@hotelos/shared";
import { disconnectOutcome, isPmsShadowAttachment, matchesFromDomain, matchesSubjectFilter, purposeOf } from "../email-reservation.service.js";

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

describe("purposeOf — configJson.purpose ?? reservation_ai (Tanda 7b)", () => {
  it("pms_shadow solo cuando lo dice configJson; cualquier otra cosa es el flujo IA → revisión humana", () => {
    assert.equal(purposeOf({ configJson: { purpose: "pms_shadow" } }), "pms_shadow");
    assert.equal(purposeOf({ configJson: { purpose: "pms_shadow", host: "imap.example.com" } }), "pms_shadow");
    assert.equal(purposeOf({ configJson: { purpose: "reservation_ai" } }), "reservation_ai");
    assert.equal(purposeOf({ configJson: {} }), "reservation_ai", "conexiones anteriores a la Tanda 7b");
    assert.equal(purposeOf({ configJson: { host: "imap.example.com", port: 993 } }), "reservation_ai");
    assert.equal(purposeOf({ configJson: null }), "reservation_ai");
    assert.equal(purposeOf({}), "reservation_ai");
    assert.equal(purposeOf({ configJson: { purpose: "otro" } }), "reservation_ai", "valor desconocido → por defecto");
    assert.equal(purposeOf({ configJson: ["pms_shadow"] }), "reservation_ai", "un array no es configuración");
  });
});

describe("isPmsShadowAttachment — extensión csv | txt | xml | xlsx y tamaño ≤ 5 MiB", () => {
  it("acepta los formatos de OPERA sin distinguir mayúsculas y hasta el límite exacto", () => {
    assert.equal(isPmsShadowAttachment({ fileName: "RESPONSYS_RESV_AUTO.csv", size: 1024 }), true);
    assert.equal(isPmsShadowAttachment({ fileName: "departure_all.TXT", size: 10 }), true);
    assert.equal(isPmsShadowAttachment({ fileName: "GEN_XMLBO_REVENUE.xml", size: PMS_SHADOW_MAX_FILE_BYTES }), true, "límite exacto incluido");
    assert.equal(isPmsShadowAttachment({ fileName: "manager_report.Xlsx", size: 0 }), true, "tamaño desconocido (0) pasa y se acota al descargar");
  });

  it("rechaza PDF, sin extensión, extensiones parecidas y ficheros por encima del límite", () => {
    assert.equal(isPmsShadowAttachment({ fileName: "manager_report.pdf", size: 10 }), false);
    assert.equal(isPmsShadowAttachment({ fileName: "informe", size: 10 }), false);
    assert.equal(isPmsShadowAttachment({ fileName: "datos.xls", size: 10 }), false);
    assert.equal(isPmsShadowAttachment({ fileName: "datos.csv.zip", size: 10 }), false);
    assert.equal(isPmsShadowAttachment({ fileName: "grande.csv", size: PMS_SHADOW_MAX_FILE_BYTES + 1 }), false);
    assert.equal(isPmsShadowAttachment({ fileName: "", size: 10 }), false);
  });
});

describe("matchesSubjectFilter / matchesFromDomain — filtros del buzón (sin filtro todo pasa)", () => {
  it("asunto: sin mayúsculas ni espacios sobrantes", () => {
    assert.equal(matchesSubjectFilter("Scheduled report: Departures", null), true);
    assert.equal(matchesSubjectFilter("Scheduled report: Departures", "  "), true);
    assert.equal(matchesSubjectFilter("Scheduled report: Departures", "departures"), true);
    assert.equal(matchesSubjectFilter("Scheduled report: Departures", " DEPARTURES "), true);
    assert.equal(matchesSubjectFilter("Scheduled report: Departures", "arrivals"), false);
    assert.equal(matchesSubjectFilter(null, "arrivals"), false);
  });

  it("remitente: dominio o subdominio del From, con o sin nombre para mostrar", () => {
    assert.equal(matchesFromDomain("scheduler@oracle.com", null), true);
    assert.equal(matchesFromDomain("OPERA Cloud <no-reply@mail.oracle.com>", "oracle.com"), true);
    assert.equal(matchesFromDomain("no-reply@oracle.com", "@oracle.com"), true, "arroba inicial tolerada");
    assert.equal(matchesFromDomain("no-reply@ORACLE.COM", "oracle.com"), true);
    assert.equal(matchesFromDomain("alguien@notoracle.com", "oracle.com"), false, "sufijo parecido no cuenta");
    assert.equal(matchesFromDomain("alguien@example.com", "oracle.com"), false);
    assert.equal(matchesFromDomain(null, "oracle.com"), false);
  });
});
