// help-articles — the searchable knowledge base of the help center («?»).
//
// One shape for every article (`CocoaHelpArticle`: id, title, category, tags,
// bodyMd) so the help center can search and render them uniformly. Sources:
//   - getting-started.ts   «Primeros pasos»
//   - troubleshooting.ts   «Qué hago si…»
//   - spanish-compliance.ts «Cumplimiento»
//   - keyboard-shortcuts.ts «Atajos de teclado» (the only shortcut catalog)
//   - glossary.ts          «Glosario» (one article per term)
//   - ../persona-guides    «Guía por puesto» (one article per job)
import type { CocoaHelpArticle } from "../../components/cocoa-guidance/CocoaSearchableHelpModal";
import { PERSONA_GUIDES, personaGuideMarkdown } from "../persona-guides";
import { GETTING_STARTED_ARTICLES } from "./getting-started";
import { GLOSSARY, GLOSSARY_CATEGORY, glossaryArticles } from "./glossary";
import { KEYBOARD_SHORTCUTS, KEYBOARD_SHORTCUTS_ARTICLE } from "./keyboard-shortcuts";
import { SPANISH_COMPLIANCE_ARTICLES } from "./spanish-compliance";
import { TROUBLESHOOTING_ARTICLES } from "./troubleshooting";

export type HelpArticle = CocoaHelpArticle;

export const PERSONA_GUIDE_CATEGORY = "Guía por puesto";

export function personaGuideArticles(): HelpArticle[] {
  return PERSONA_GUIDES.map((guide) => ({
    id: `guia-${guide.id}`,
    title: guide.title,
    category: PERSONA_GUIDE_CATEGORY,
    tags: [guide.id, ...guide.roleTokens, "guía", "puesto", "rol"],
    bodyMd: personaGuideMarkdown(guide)
  }));
}

function clone(article: CocoaHelpArticle): HelpArticle {
  return { ...article, tags: [...article.tags] };
}

/** Every article, in the order the help center lists categories. */
export const HELP_ARTICLES: readonly HelpArticle[] = [
  ...GETTING_STARTED_ARTICLES.map(clone),
  ...personaGuideArticles(),
  ...TROUBLESHOOTING_ARTICLES.map(clone),
  ...SPANISH_COMPLIANCE_ARTICLES.map(clone),
  clone(KEYBOARD_SHORTCUTS_ARTICLE),
  ...glossaryArticles()
];

export const HELP_CATEGORIES: readonly string[] = Array.from(new Set(HELP_ARTICLES.map((article) => article.category)));

/** Accent- and case-insensitive text for matching («Qué» matches «que»). */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export type HelpArticleMatch = { article: HelpArticle; score: number };

/**
 * Ranks articles for a free-text query: title hits first, then tags, then
 * category and body. Every whitespace-separated term must match somewhere;
 * an empty query returns nothing (the help center shows its sections instead).
 */
export function searchHelpArticles(query: string, articles: readonly HelpArticle[] = HELP_ARTICLES, limit = 12): HelpArticleMatch[] {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const matches: HelpArticleMatch[] = [];
  for (const article of articles) {
    const title = normalizeSearchText(article.title);
    const tags = normalizeSearchText(article.tags.join(" "));
    const category = normalizeSearchText(article.category);
    const body = normalizeSearchText(article.bodyMd);
    let score = 0;
    let everyTerm = true;
    for (const term of terms) {
      if (title.includes(term)) score += 10;
      else if (tags.includes(term)) score += 6;
      else if (category.includes(term)) score += 3;
      else if (body.includes(term)) score += 1;
      else {
        everyTerm = false;
        break;
      }
    }
    if (everyTerm) matches.push({ article, score });
  }
  return matches.sort((a, b) => b.score - a.score || a.article.title.localeCompare(b.article.title, "es")).slice(0, limit);
}

export { GETTING_STARTED_ARTICLES, TROUBLESHOOTING_ARTICLES, SPANISH_COMPLIANCE_ARTICLES, KEYBOARD_SHORTCUTS, KEYBOARD_SHORTCUTS_ARTICLE, GLOSSARY, GLOSSARY_CATEGORY };
