import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NAV_TREE } from "../../navigation/nav-tree.ts";
import { HELP_ARTICLES, HELP_CATEGORIES, KEYBOARD_SHORTCUTS, normalizeSearchText, searchHelpArticles } from "../help-articles/index.ts";
import { PERSONA_GUIDES, personaGuidesFor } from "../persona-guides/index.ts";
import { ROLE_TOKENS } from "../../navigation/role-tokens.ts";
import { SHORTCUTS } from "../shortcuts-registry.ts";

const KEEP_KEYS = new Set(NAV_TREE.categories.flatMap((category) => category.items.map((item) => item.screenKey)));
const JARGON = /sandbox|\bstub\b|\bmock|\bdemo\b|\bQ[34]\b|pendiente de implementaci|próximamente|proximamente|pagerduty|devtools|#soporte/i;
// Combinations no screen implements (plan §2.3). Since UX-1 · U5 the wired set is the
// registry content/shortcuts-registry.ts (tests/shortcuts-catalog-contract.test.mjs proves
// every entry is wired in code and gen-shortcuts.mjs renders the catalog from it): the
// help may only announce those keys (⌥H/⌥R/⌥N/⌥T/⌥B/⌥F/⌥W, ⌥1-3, ⌘⇧T/⌘⇧E included).
const FAKE_SHORTCUTS = /⌘[1-9A-JL-Z]|Cmd\+[1-9A-JL-Z]\b|Ctrl\+[1-9A-JL-Z]\b|\bJ\/K\b/;
const ALLOWED_KEYS = new Set(SHORTCUTS.map((entry) => entry.keys));

describe("help-articles · unified knowledge base", () => {
  it("has unique ids, non-empty bodies and a category for every article", () => {
    const ids = new Set<string>();
    for (const article of HELP_ARTICLES) {
      assert.ok(article.id && !ids.has(article.id), `duplicate id ${article.id}`);
      ids.add(article.id);
      assert.ok(article.title.length >= 3, article.id);
      assert.ok(article.bodyMd.length > 40, article.id);
      assert.ok(HELP_CATEGORIES.includes(article.category));
    }
    assert.ok(HELP_ARTICLES.length >= 40, `only ${HELP_ARTICLES.length} articles`);
  });

  it("announces only shortcuts that exist in code", () => {
    for (const category of KEYBOARD_SHORTCUTS) {
      for (const shortcut of category.shortcuts) assert.ok(ALLOWED_KEYS.has(shortcut.keys), shortcut.keys);
    }
    for (const article of HELP_ARTICLES) {
      assert.doesNotMatch(article.bodyMd, FAKE_SHORTCUTS, article.id);
      assert.doesNotMatch(article.title, JARGON, article.id);
    }
  });

  it("keeps operator-facing copy free of engineering jargon", () => {
    for (const article of HELP_ARTICLES) {
      if (article.category === "Glosario") continue;
      assert.doesNotMatch(article.bodyMd, JARGON, article.id);
    }
  });

  it("searches accent- and case-insensitively, title hits first", () => {
    assert.equal(normalizeSearchText("  Qué es VeriFactu "), "que es verifactu");
    const hits = searchHelpArticles("verifactu");
    assert.ok(hits.length >= 2);
    assert.match(hits[0].article.title.toLowerCase(), /verifactu/);
    assert.ok(hits.every((hit, index) => index === 0 || hits[index - 1].score >= hit.score));
    assert.deepEqual(searchHelpArticles(""), []);
    assert.deepEqual(searchHelpArticles("zzzz-no-such-word"), []);
    // Every term must match: "check-in grupos" matches nothing that only mentions one of them in the title.
    const both = searchHelpArticles("factura rectificativa");
    assert.ok(both.every((hit) => /rectificativa/i.test(hit.article.bodyMd) && /factura/i.test(hit.article.bodyMd)));
  });
});

describe("persona-guides · one guide per job over the nine categories", () => {
  it("points only to keep screens of the tree and to known role tokens", () => {
    for (const guide of PERSONA_GUIDES) {
      for (const key of guide.relatedScreens) assert.ok(KEEP_KEYS.has(key), `${guide.id}: ${key}`);
      for (const token of guide.roleTokens) assert.ok(ROLE_TOKENS.includes(token), `${guide.id}: ${token}`);
      assert.ok(guide.dailyFlow.length >= 4 && guide.tips.length >= 2, guide.id);
      for (const line of [...guide.dailyFlow, ...guide.tips]) {
        assert.doesNotMatch(line, JARGON, guide.id);
        assert.doesNotMatch(line, FAKE_SHORTCUTS, guide.id);
      }
    }
  });

  it("filters by token and never returns an empty list", () => {
    assert.deepEqual(personaGuidesFor(["pisos"]).map((guide) => guide.id), ["pisos"]);
    assert.ok(personaGuidesFor(["direccion"]).length >= 2);
    assert.equal(personaGuidesFor([]).length, PERSONA_GUIDES.length);
    assert.equal(personaGuidesFor(["publico"]).length, PERSONA_GUIDES.length);
  });
});
