import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NAV_TREE } from "../../../navigation/nav-tree.ts";
import {
  ROLE_STARTER_TOUR,
  WELCOME_TOUR_ID,
  getTourById,
  narratedScreenKeys,
  taskGuides,
  tourStepsFor,
  tours,
  toursForAudience
} from "../guideContent.ts";

const KEEP_KEYS = new Set(NAV_TREE.categories.flatMap((category) => category.items.map((item) => item.screenKey)));
const JARGON = /sandbox|stub|\bmock|\bdemo\b|\bQ[34]\b|pendiente de implementaci|próximamente|proximamente/i;
const TODO_MARK = /\bTODO\b/;
const FAKE_SHORTCUTS = /⌘[1-9]|Cmd\+[1-9NFEDRHMBLAPGW]\b|Ctrl\+[1-9N]\b/;

describe("guideContent · tours generated from the navigation tree", () => {
  it("ships the welcome tour plus one tour per category, in menu order", () => {
    assert.equal(tours[0].id, WELCOME_TOUR_ID);
    assert.deepEqual(
      tours.slice(1).map((tour) => tour.id),
      NAV_TREE.categories.map((category) => category.key)
    );
    assert.equal(tours.length, 10);
  });

  it("narrates every keep item and only keep items (no retired or merged screens)", () => {
    for (const key of narratedScreenKeys()) assert.ok(KEEP_KEYS.has(key), `${key} is not a keep item of the tree`);
    for (const key of KEEP_KEYS) assert.ok(narratedScreenKeys().includes(key), `${key} has no narration`);
    for (const tour of tours) {
      for (const step of tour.steps) {
        if (step.navigateTo) assert.ok(KEEP_KEYS.has(step.navigateTo), `${tour.id}: ${step.navigateTo} is not navigable`);
      }
    }
  });

  it("anchors the welcome tour to the Cocoa shell chrome only", () => {
    const welcome = getTourById(WELCOME_TOUR_ID);
    const selectors = welcome.steps.map((step) => step.selector).filter(Boolean);
    assert.deepEqual(selectors, [
      "[data-tour='property']",
      "[data-tour='search']",
      "[data-tour='sidebar']",
      "[data-tour='notifications']",
      "[data-tour='help']"
    ]);
    assert.ok(welcome.steps.every((step) => !step.navigateTo));
  });

  it("keeps the copy free of jargon and of shortcuts that do not exist", () => {
    for (const tour of tours) {
      for (const step of tour.steps) {
        assert.doesNotMatch(step.body, JARGON, `${tour.id}/${step.title}`);
        assert.doesNotMatch(step.body, TODO_MARK, `${tour.id}/${step.title}`);
        assert.doesNotMatch(step.body, FAKE_SHORTCUTS, `${tour.id}/${step.title}`);
        assert.ok(step.body.length <= 400, `${tour.id}/${step.title} is too long`);
      }
    }
    for (const guide of taskGuides) {
      for (const line of guide.steps) {
        assert.doesNotMatch(line, JARGON);
        assert.doesNotMatch(line, FAKE_SHORTCUTS);
      }
      if (guide.screen) assert.ok(KEEP_KEYS.has(guide.screen), `${guide.id}: ${guide.screen}`);
    }
  });

  it("filters steps by role: housekeeping sees only its items, dirección sees everything", () => {
    const operaciones = getTourById("operaciones");
    const pisos = tourStepsFor(operaciones, { roleTokens: ["pisos"] });
    assert.deepEqual(
      pisos.filter((step) => step.navigateTo).map((step) => step.navigateTo),
      ["HousekeepingDashboard", "WorkforceDashboard", "DocumentCaptureScreen"] // Tanda T9: Operaciones › Digitalizar (pisos captures too)
    );
    const direccion = tourStepsFor(operaciones, { roleTokens: ["direccion"] });
    assert.equal(direccion.length, operaciones.steps.length);
    // Unknown audience → everything (never hide help).
    assert.equal(tourStepsFor(operaciones, { roleTokens: [] }).length, operaciones.steps.length);
  });

  it("hides tours with no visible step for the audience and applies module gates when known", () => {
    const pisosTours = toursForAudience({ roleTokens: ["pisos"] }).map((tour) => tour.id);
    assert.deepEqual(pisosTours, ["hoy", "recepcion", "operaciones"]);
    const comercial = getTourById("comercial");
    const withoutModules = tourStepsFor(comercial, { roleTokens: ["comercial"], enabledModules: [] });
    assert.deepEqual(
      withoutModules.filter((step) => step.navigateTo).map((step) => step.navigateTo),
      ["UpsellsDashboard", "SalesPipelineDashboard"]
    );
  });

  it("maps every role token to a starter tour that exists", () => {
    for (const tourId of Object.values(ROLE_STARTER_TOUR)) assert.ok(tours.some((tour) => tour.id === tourId), tourId);
  });
});
