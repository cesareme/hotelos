// Router = menú (Tanda 8a · RBAC · L4, design §5.2).
//
// Run: cd apps/api && TSX_TSCONFIG_PATH=../admin-web/tsconfig.json \
//   node --import tsx --test ../admin-web/src/routes/__tests__/*.test.mts
//
// For every URL of allUrls() × every token: `resolveLocation(...).kind === "screen"`
// ⇔ `canSee(entry, [token], every module)` — the router opens exactly what the
// menu paints. Without tokens the Tanda 5 behaviour stays; dev-only URLs stay
// `dev-locked`; a module-gated URL answers `forbidden` (module) only once the
// module list is known, and `locked` (the user may enable modules) still opens.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NAV_TREE, allUrls, findByUrl, gatingModuleCodes } from "../../navigation/nav-tree";
import { ROLE_TOKENS, canSee, type RoleToken } from "../../navigation/role-tokens";
import { accessScopeOf, forbiddenReasonOf, resolveLocation, routeAccessDecision, type RouteGuardInput } from "../backoffice.routes";

const ALL_MODULES = gatingModuleCodes();
const TOKENS = ROLE_TOKENS.filter((token): token is Exclude<RoleToken, "publico"> => token !== "publico");
const sample = (url: string) => url.replace(/:[A-Za-z0-9_]+/g, "abc");
const guardFor = (token: RoleToken, extra: Partial<RouteGuardInput> = {}): RouteGuardInput => ({ tokens: [token], modules: ALL_MODULES, modulesKnown: true, ...extra });

describe("resolveLocation · role gate ⇔ canSee for every URL × every token", () => {
  const urls = allUrls();
  const menuUrls = urls.filter((url) => {
    const match = findByUrl(url);
    return match !== null && (match.kind === "item" || match.kind === "tab");
  });

  it(`covers the ${urls.length} URLs of the tree (${menuUrls.length} menu entries, 21 dev-only, 2 public)`, () => {
    assert.equal(urls.length, NAV_TREE.meta.counts.items + NAV_TREE.meta.counts.tabs + NAV_TREE.meta.counts.devOnly + NAV_TREE.meta.counts.publicScreens);
    assert.equal(urls.length - menuUrls.length, NAV_TREE.devOnly.length + NAV_TREE.publicScreens.length);
  });

  for (const token of TOKENS) {
    it(`${token}: screen ⇔ canSee (items and tabs, every module on)`, () => {
      let opened = 0;
      for (const url of menuUrls) {
        const match = findByUrl(url);
        assert.ok(match && (match.kind === "item" || match.kind === "tab"));
        const entry = match.kind === "item" ? match.item : match.tab;
        // A tab opens only when its item does; the tree keeps tab roles ⊆ item roles, so canSee(tab) already implies canSee(item) for roles.
        const expected = canSee(entry, [token], ALL_MODULES) && canSee(match.item, [token], ALL_MODULES);
        const resolution = resolveLocation({ pathname: sample(url) }, guardFor(token));
        assert.equal(resolution.kind === "screen", expected, `${token} × ${url}: ${resolution.kind}`);
        if (!expected) {
          assert.equal(resolution.kind, "forbidden", `${token} × ${url} must be forbidden`);
          if (resolution.kind === "forbidden") assert.equal(resolution.reason, "role");
        } else opened += 1;
      }
      assert.ok(opened > 0, `${token} opens at least one URL`);
    });
  }

  it("without tokens the router behaves as in Tanda 5 (never forbidden)", () => {
    for (const url of menuUrls) {
      const resolution = resolveLocation({ pathname: sample(url) });
      assert.equal(resolution.kind, "screen", url);
    }
    assert.equal(routeAccessDecision("/hoy", {}), null);
    assert.equal(accessScopeOf({}), null);
  });

  it("dev-only URLs stay dev-locked whatever the tokens; the platform admin with dev mode opens them", () => {
    for (const screen of NAV_TREE.devOnly) {
      assert.deepEqual(resolveLocation({ pathname: screen.url }, guardFor("admin")), { kind: "dev-locked", pathname: screen.url });
      assert.deepEqual(resolveLocation({ pathname: screen.url }, guardFor("direccion")), { kind: "dev-locked", pathname: screen.url });
      const allowed = resolveLocation({ pathname: screen.url }, guardFor("admin", { search: "?dev=1", isPlatformAdmin: true }));
      assert.equal(allowed.kind, "screen", screen.url);
    }
  });

  it("public URLs resolve to their public route for every token", () => {
    for (const screen of NAV_TREE.publicScreens) {
      for (const token of TOKENS) {
        const resolution = resolveLocation({ pathname: screen.url }, guardFor(token));
        assert.equal(resolution.kind, "screen");
        if (resolution.kind === "screen") assert.equal(resolution.route.public, true);
      }
    }
  });

  it("module gate: forbidden (module) with an empty KNOWN list, screen while the list is unknown, screen (locked) for who may enable modules", () => {
    const gated = NAV_TREE.categories.flatMap((category) => category.items).find((item) => item.modulesAny.length > 0 && item.roles.includes("direccion"));
    assert.ok(gated, "a module-gated item for direccion");
    assert.deepEqual(resolveLocation({ pathname: gated.url }, guardFor("direccion", { modules: [], modulesKnown: true })), { kind: "forbidden", pathname: gated.url, reason: "module" });
    assert.equal(resolveLocation({ pathname: gated.url }, guardFor("direccion", { modules: [], modulesKnown: false })).kind, "screen");
    assert.equal(resolveLocation({ pathname: gated.url }, guardFor("direccion", { modules: [], modulesKnown: true, canEnableModules: true })).kind, "screen");
    assert.equal(routeAccessDecision(gated.url, guardFor("direccion", { modules: [], modulesKnown: true, canEnableModules: true })), "locked");
    assert.equal(forbiddenReasonOf("locked", { modulesKnown: true }), null);
    assert.equal(forbiddenReasonOf("hidden-module", { modulesKnown: false }), null);
    assert.equal(forbiddenReasonOf("hidden-module", { modulesKnown: true }), "module");
    assert.equal(forbiddenReasonOf("hidden-role", { modulesKnown: false }), "role");
    assert.equal(forbiddenReasonOf(null, { modulesKnown: true }), null);
  });

  it("a legacy /backoffice/* path is gated on its NEW URL (forbidden carries the redirect target)", () => {
    const legacy = resolveLocation({ pathname: "/backoffice/finance/payroll" }, guardFor("pisos"));
    assert.deepEqual(legacy, { kind: "forbidden", pathname: "/finanzas/nominas", reason: "role" });
    const allowed = resolveLocation({ pathname: "/backoffice/finance/payroll" }, guardFor("rrhh"));
    assert.equal(allowed.kind, "screen");
    if (allowed.kind === "screen") assert.equal(allowed.redirect, "/finanzas/nominas");
  });

  it("the six Tanda 8a tokens land on a URL they can open", () => {
    const homes: Array<[RoleToken, string]> = [
      ["administracion", "/finanzas/facturacion"],
      ["rrhh", "/finanzas/nominas"],
      ["propiedad", "/hoy/propietario"],
      ["activos", "/finanzas/activo-inmobiliario"], // Tanda ACT · F4
      ["auditoria", "/configuracion/sistema"],
      ["sistemas", "/configuracion/usuarios"]
    ];
    for (const [token, home] of homes) assert.equal(resolveLocation({ pathname: home }, guardFor(token)).kind, "screen", `${token} → ${home}`);
    assert.deepEqual(resolveLocation({ pathname: "/hoy" }, guardFor("rrhh")), { kind: "forbidden", pathname: "/hoy", reason: "role" });
    assert.deepEqual(resolveLocation({ pathname: "/configuracion/usuarios" }, guardFor("recepcion")), { kind: "forbidden", pathname: "/configuracion/usuarios", reason: "role" });
    assert.equal(resolveLocation({ pathname: "/hoy/pendientes" }, guardFor("recepcion")).kind, "screen");
    assert.equal(resolveLocation({ pathname: "/hoy/pendientes" }, guardFor("sistemas")).kind, "forbidden");
  });
});
