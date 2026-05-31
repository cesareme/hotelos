import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const server = readFileSync(new URL("../demo/server.mjs", import.meta.url), "utf8");
const html = readFileSync(new URL("../demo/public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../demo/public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../demo/public/styles.css", import.meta.url), "utf8");

describe("Demo preview contract", () => {
  it("has a dependency-free preview script", () => {
    assert.equal(packageJson.scripts["preview:demo"], "node demo/server.mjs");
    assert.match(server, /createServer/);
    assert.match(server, /makeLobbyImage/);
    assert.match(server, /HotelOS demo preview/);
  });

  it("renders the flagship check-in journey", () => {
    for (const marker of [
      "Check in this customer in room 432",
      "ID_IMAGE_DISCARDED",
      "Confirm check-in",
      "SES.HOSPEDAJES",
      "Audit trail",
      "Maria Lopez Garcia"
    ]) {
      assert.match(html + script, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("contains operational screens beyond the demo flow", () => {
    for (const marker of ["Compliance inbox", "Owner mode", "Room inventory", "Maintenance", "Housekeeping", "Guest inbox"]) {
      assert.match(html, new RegExp(marker));
    }
  });

  it("previews Back Office go-live and property mapping controls", () => {
    for (const marker of [
      "HotelOS Aurora Back Office",
      "Prepare HotelOS Madrid Centro for go-live",
      "Continue setup checklist",
      "Will create",
      "Will update",
      "Duplicate room numbers",
      "Module health and recent audit"
    ]) {
      assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(styles, /bo-preview-hero/);
    assert.match(styles, /setup-progress-grid/);
    assert.match(styles, /import-preview-grid/);
  });

  it("previews Guest Portal self-service flows", () => {
    for (const marker of [
      "Open guest portal",
      "HotelOS Guest Portal",
      "Start online check-in",
      "GuestFolio",
      "MobileCheckout",
      "UpsellStore",
      "ConciergeChat",
      "AI disclosed"
    ]) {
      assert.match(html + script, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(styles, /guest-preview-hero/);
    assert.match(styles, /guest-offer-grid/);
  });

  it("previews Revenue Management and Channel Manager flows", () => {
    for (const marker of [
      "Open Revenue",
      "Revenue & Profit Engine",
      "Occupancy forecast",
      "GOPPAR",
      "Net RevPAR",
      "Increase Double Standard Flexible BAR",
      "Rate grid snapshot",
      "Channel Manager",
      "Rate shopper and parity",
      "Scenario simulator and automation safety"
    ]) {
      assert.match(html + script, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("previews chat media controls", () => {
    for (const marker of ["Attach photo", "Camera", "Attach file", "Voice note", "sendChatMessage", "Message sent with audited attachment metadata"]) {
      assert.match(html + script, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("keeps the preview responsive and app-like", () => {
    assert.match(styles, /@media \(max-width: 900px\)/);
    assert.match(styles, /grid-template-columns/);
    assert.match(styles, /border-radius: 18px/);
    assert.match(styles, /--command-shadow/);
  });
});
