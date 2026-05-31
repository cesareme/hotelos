// CocoaSearchableHelpModal — Embedded help center modal for HotelOS.
//
// An 800x600 modal that surfaces a searchable knowledge base directly in
// the product. Designed to keep operators in flow: rather than send them
// to an external help site, common articles are bundled and filterable
// here by free-text search, by category, and finally expandable inline
// to read the markdown body.
//
// Layout, left-to-right:
//   - Top bar: large CocoaSearchInput that filters by title, category,
//     and tags (case-insensitive substring match).
//   - Left rail (200px): list of categories derived from the articles.
//     Each category acts as a toggle filter; an "Todas" entry returns to
//     the unfiltered list. The active category is visually highlighted.
//   - Right pane (flex): list of articles matching the current
//     search + category. Each article row is expandable — clicking the
//     title reveals the rendered markdown body underneath. When nothing
//     matches, an empty state suggests writing to support@hotelos.app.
//   - Footer: link to the external help center for deeper topics.
//
// Markdown rendering is intentionally minimal and self-contained (no
// runtime dependency on a markdown library): paragraphs, headings (#, ##,
// ###), unordered lists (- / *), ordered lists (1.), inline code (`code`),
// bold (**text**), italics (*text*), and links ([text](url)) are all
// supported. Anything more elaborate is rendered as plain text so the
// modal never crashes on unexpected input.
//
// Visuals:
// - Backdrop: dimmed + blurred, fades in.
// - Container: var(--cocoa-radius-lg), var(--cocoa-shadow-modal), spring
//   scale + translate on entry.
// - Category rail: subtle separator on the right, control-background fill
//   on the active row.
// - Article rows: separator between items, expand chevron rotates 90deg
//   when open.
//
// A11y:
// - role="dialog" + aria-modal="true" + aria-labelledby on the title.
// - ESC closes; focus moves to the search input on open; focus is trapped
//   inside the dialog and restored on close.
// - Each article row is a button with aria-expanded that toggles its body.
// - Category list is a listbox with aria-selected on the active option.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

import CocoaSearchInput from "../cocoa/CocoaSearchInput";

export interface CocoaHelpArticle {
  id: string;
  title: string;
  category: string;
  tags: string[];
  bodyMd: string;
}

export interface CocoaSearchableHelpModalProps {
  open: boolean;
  onClose: () => void;
  articles: CocoaHelpArticle[];
  /** External help center URL surfaced in the footer. */
  externalHelpUrl?: string;
  /** Support email shown in the empty state. */
  supportEmail?: string;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  );
  return nodes.filter((node) => {
    if (node.hasAttribute("disabled")) return false;
    if (node.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return true;
  });
}

const ALL_CATEGORY_KEY = "__all__";
const DEFAULT_SUPPORT_EMAIL = "support@hotelos.app";
const DEFAULT_EXTERNAL_URL = "https://help.hotelos.app";

// --- Tiny inline markdown renderer ---------------------------------------
//
// Keeps the modal dependency-free. Supports the subset listed at the top of
// the file. Returns a ReactNode tree.

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  // Tokenize for `code`, **bold**, *italic*, and [text](url) — in that
  // order so code spans win over emphasis inside them.
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let nodeIndex = 0;
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }
    const token = match[0];
    const k = `${keyPrefix}-i-${nodeIndex++}`;
    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code
          key={k}
          style={{
            fontFamily: "var(--cocoa-font-mono, monospace)",
            background: "var(--cocoa-background-control)",
            padding: "1px 6px",
            borderRadius: 4,
            fontSize: "0.9em"
          }}
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={k}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(<em key={k}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("[")) {
      const closeBracket = token.indexOf("]");
      const label = token.slice(1, closeBracket);
      const url = token.slice(closeBracket + 2, -1);
      nodes.push(
        <a
          key={k}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--cocoa-accent)", textDecoration: "none" }}
        >
          {label}
        </a>
      );
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

function renderMarkdown(md: string): ReactNode {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    // Skip blank lines between blocks.
    if (line === "") {
      i += 1;
      continue;
    }

    // Headings.
    if (line.startsWith("### ")) {
      blocks.push(
        <h4
          key={`h-${blockKey++}`}
          style={{
            margin: "12px 0 4px",
            fontSize: "var(--cocoa-fs-subheadline)",
            fontWeight: 600,
            color: "var(--cocoa-label)"
          }}
        >
          {renderInline(line.slice(4), `h-${blockKey}`)}
        </h4>
      );
      i += 1;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push(
        <h3
          key={`h-${blockKey++}`}
          style={{
            margin: "14px 0 4px",
            fontSize: "var(--cocoa-fs-headline)",
            fontWeight: 600,
            color: "var(--cocoa-label)"
          }}
        >
          {renderInline(line.slice(3), `h-${blockKey}`)}
        </h3>
      );
      i += 1;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push(
        <h2
          key={`h-${blockKey++}`}
          style={{
            margin: "16px 0 6px",
            fontSize: "var(--cocoa-fs-title-3)",
            fontWeight: 600,
            color: "var(--cocoa-label)"
          }}
        >
          {renderInline(line.slice(2), `h-${blockKey}`)}
        </h2>
      );
      i += 1;
      continue;
    }

    // Unordered list.
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i += 1;
      }
      const ulKey = `ul-${blockKey++}`;
      blocks.push(
        <ul
          key={ulKey}
          style={{
            margin: "6px 0",
            paddingLeft: 20,
            color: "var(--cocoa-label)"
          }}
        >
          {items.map((item, idx) => (
            <li key={`${ulKey}-${idx}`} style={{ marginBottom: 4 }}>
              {renderInline(item, `${ulKey}-${idx}`)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list.
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      const olKey = `ol-${blockKey++}`;
      blocks.push(
        <ol
          key={olKey}
          style={{
            margin: "6px 0",
            paddingLeft: 22,
            color: "var(--cocoa-label)"
          }}
        >
          {items.map((item, idx) => (
            <li key={`${olKey}-${idx}`} style={{ marginBottom: 4 }}>
              {renderInline(item, `${olKey}-${idx}`)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // Default — paragraph. Consume contiguous non-empty lines.
    const paragraphLines: string[] = [raw];
    i += 1;
    while (i < lines.length && lines[i].trim() !== "") {
      paragraphLines.push(lines[i]);
      i += 1;
    }
    const pKey = `p-${blockKey++}`;
    blocks.push(
      <p
        key={pKey}
        style={{
          margin: "6px 0",
          color: "var(--cocoa-label)",
          lineHeight: 1.5
        }}
      >
        {renderInline(paragraphLines.join(" "), pKey)}
      </p>
    );
  }

  return <>{blocks}</>;
}

// --- Component -----------------------------------------------------------

export function CocoaSearchableHelpModal({
  open,
  onClose,
  articles,
  externalHelpUrl,
  supportEmail
}: CocoaSearchableHelpModalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [isMounted, setIsMounted] = useState<boolean>(open);
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const [query, setQuery] = useState<string>("");
  const [activeCategory, setActiveCategory] = useState<string>(ALL_CATEGORY_KEY);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const titleId = useId();

  // Manage mount/unmount with motion enter/exit.
  useEffect(() => {
    if (open) {
      setIsMounted(true);
      const raf = window.requestAnimationFrame(() => {
        setIsVisible(true);
      });
      return () => window.cancelAnimationFrame(raf);
    }

    setIsVisible(false);
    if (!isMounted) return undefined;
    const timeout = window.setTimeout(() => {
      setIsMounted(false);
    }, 400);
    return () => window.clearTimeout(timeout);
  }, [open, isMounted]);

  // Reset interactive state each time the modal opens so the user lands on
  // a clean slate.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveCategory(ALL_CATEGORY_KEY);
      setExpandedId(null);
    }
  }, [open]);

  // Focus the search input on open; restore the previous focus on close.
  useEffect(() => {
    if (!isMounted) return undefined;
    previouslyFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? null;

    const raf = window.requestAnimationFrame(() => {
      const root = searchInputRef.current;
      const input = root?.querySelector<HTMLInputElement>("input[type='search']");
      if (input) {
        input.focus({ preventScroll: true });
        return;
      }
      const focusables = getFocusableElements(containerRef.current);
      const first = focusables[0] ?? containerRef.current;
      first?.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(raf);
      const previous = previouslyFocusedRef.current;
      if (previous && typeof previous.focus === "function") {
        previous.focus({ preventScroll: true });
      }
    };
  }, [isMounted]);

  // Esc + body scroll lock.
  useEffect(() => {
    if (!isMounted) return undefined;

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isMounted, onClose]);

  const handleBackdropClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const handleContainerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Tab") return;
      const root = containerRef.current;
      if (!root) return;

      const focusables = getFocusableElements(root);
      if (focusables.length === 0) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || !root.contains(active)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    },
    []
  );

  // Derived: ordered, de-duplicated list of categories.
  const categories = useMemo<string[]>(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of articles) {
      if (!seen.has(a.category)) {
        seen.add(a.category);
        out.push(a.category);
      }
    }
    return out;
  }, [articles]);

  // Derived: filtered article list.
  const filtered = useMemo<CocoaHelpArticle[]>(() => {
    const q = query.trim().toLowerCase();
    return articles.filter((a) => {
      if (activeCategory !== ALL_CATEGORY_KEY && a.category !== activeCategory) {
        return false;
      }
      if (q.length === 0) return true;
      if (a.title.toLowerCase().includes(q)) return true;
      if (a.category.toLowerCase().includes(q)) return true;
      for (const t of a.tags) {
        if (t.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [articles, query, activeCategory]);

  const toggleArticle = useCallback((id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  }, []);

  const handleCategoryClick = useCallback((key: string) => {
    setActiveCategory(key);
    setExpandedId(null);
  }, []);

  // ---- Styles -----------------------------------------------------------

  const backdropStyle = useMemo<CSSProperties>(
    () => ({
      position: "fixed",
      inset: 0,
      zIndex: 1100,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
      background: "rgba(0, 0, 0, 0.32)",
      backdropFilter: "blur(8px) saturate(180%)",
      WebkitBackdropFilter: "blur(8px) saturate(180%)",
      opacity: isVisible ? 1 : 0,
      transition: "opacity var(--cocoa-duration-base) var(--cocoa-ease-out)",
      pointerEvents: isVisible ? "auto" : "none"
    }),
    [isVisible]
  );

  const containerStyle = useMemo<CSSProperties>(
    () => ({
      position: "relative",
      width: 800,
      height: 600,
      maxWidth: "100%",
      maxHeight: "100%",
      display: "flex",
      flexDirection: "column",
      background: "var(--cocoa-background-content)",
      borderRadius: "var(--cocoa-radius-lg)",
      boxShadow: "var(--cocoa-shadow-modal)",
      transform: isVisible
        ? "scale(1) translateY(0)"
        : "scale(0.96) translateY(-6px)",
      opacity: isVisible ? 1 : 0,
      transition:
        "transform var(--cocoa-duration-slow) var(--cocoa-ease-spring), opacity var(--cocoa-duration-base) var(--cocoa-ease-out)",
      outline: "none",
      fontFamily: "var(--cocoa-font)",
      color: "var(--cocoa-label)",
      boxSizing: "border-box",
      overflow: "hidden"
    }),
    [isVisible]
  );

  const headerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "16px 20px",
    borderBottom: "1px solid var(--cocoa-separator)",
    flexShrink: 0
  };

  const titleStyle: CSSProperties = {
    margin: 0,
    fontSize: "var(--cocoa-fs-title-3)",
    fontWeight: 600,
    color: "var(--cocoa-label)",
    flexShrink: 0
  };

  const searchWrapStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    fontSize: "var(--cocoa-fs-body)"
  };

  const closeButtonStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderRadius: "var(--cocoa-radius-md)",
    background: "transparent",
    border: "1px solid transparent",
    color: "var(--cocoa-label-secondary)",
    cursor: "pointer",
    flexShrink: 0,
    padding: 0
  };

  const bodyStyle: CSSProperties = {
    flex: 1,
    minHeight: 0,
    display: "flex"
  };

  const sidebarStyle: CSSProperties = {
    width: 200,
    flexShrink: 0,
    borderRight: "1px solid var(--cocoa-separator)",
    overflowY: "auto",
    padding: "12px 8px",
    background: "var(--cocoa-background-grouped, transparent)"
  };

  const categoryButtonStyle = (active: boolean): CSSProperties => ({
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "8px 12px",
    margin: 0,
    marginBottom: 2,
    background: active ? "var(--cocoa-background-control)" : "transparent",
    border: "1px solid transparent",
    borderRadius: "var(--cocoa-radius-sm)",
    color: active ? "var(--cocoa-label)" : "var(--cocoa-label-secondary)",
    fontSize: "var(--cocoa-fs-body)",
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    fontFamily: "inherit"
  });

  const articleListStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    overflowY: "auto",
    padding: "8px 16px"
  };

  const articleRowStyle: CSSProperties = {
    borderBottom: "1px solid var(--cocoa-separator)",
    padding: "12px 0"
  };

  const articleHeaderStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    background: "transparent",
    border: "none",
    padding: 0,
    cursor: "pointer",
    color: "var(--cocoa-label)",
    fontFamily: "inherit",
    fontSize: "var(--cocoa-fs-body)",
    textAlign: "left"
  };

  const chevronStyle = (open: boolean): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 16,
    height: 16,
    color: "var(--cocoa-label-tertiary)",
    transform: open ? "rotate(90deg)" : "rotate(0deg)",
    transition: "transform var(--cocoa-duration-fast) var(--cocoa-ease-out)",
    flexShrink: 0
  });

  const articleTitleStyle: CSSProperties = {
    margin: 0,
    fontSize: "var(--cocoa-fs-body)",
    fontWeight: 600,
    color: "var(--cocoa-label)",
    flex: 1,
    minWidth: 0
  };

  const articleMetaStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-footnote)",
    color: "var(--cocoa-label-tertiary)",
    flexShrink: 0
  };

  const articleBodyStyle: CSSProperties = {
    padding: "8px 24px 4px",
    fontSize: "var(--cocoa-fs-body)",
    color: "var(--cocoa-label)"
  };

  const emptyStateStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    padding: 24,
    textAlign: "center",
    color: "var(--cocoa-label-secondary)"
  };

  const footerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    padding: "12px 20px",
    borderTop: "1px solid var(--cocoa-separator)",
    flexShrink: 0,
    fontSize: "var(--cocoa-fs-footnote)"
  };

  const footerLinkStyle: CSSProperties = {
    color: "var(--cocoa-accent)",
    textDecoration: "none"
  };

  if (!isMounted) return null;
  if (typeof document === "undefined") return null;

  const resolvedSupportEmail = supportEmail ?? DEFAULT_SUPPORT_EMAIL;
  const resolvedExternalUrl = externalHelpUrl ?? DEFAULT_EXTERNAL_URL;

  const handleCloseHover = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.background = "var(--cocoa-background-control)";
    event.currentTarget.style.color = "var(--cocoa-label)";
  };

  const handleCloseLeave = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.background = "transparent";
    event.currentTarget.style.color = "var(--cocoa-label-secondary)";
  };

  const node = (
    <div
      style={backdropStyle}
      onMouseDown={handleBackdropClick}
      aria-hidden={!isVisible}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={containerStyle}
        onKeyDown={handleContainerKeyDown}
      >
        {/* Header */}
        <div style={headerStyle}>
          <h2 id={titleId} style={titleStyle}>
            Ayuda
          </h2>
          <div ref={searchInputRef} style={searchWrapStyle}>
            <CocoaSearchInput
              value={query}
              onChange={setQuery}
              placeholder="Buscar articulos, categorias o etiquetas"
              debounceMs={120}
            />
          </div>
          <button
            type="button"
            aria-label="Cerrar centro de ayuda"
            onClick={onClose}
            onMouseEnter={handleCloseHover}
            onMouseLeave={handleCloseLeave}
            style={closeButtonStyle}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M1 1L13 13M13 1L1 13"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {/* Left rail: categories */}
          <div
            style={sidebarStyle}
            role="listbox"
            aria-label="Categorias de ayuda"
          >
            <button
              type="button"
              role="option"
              aria-selected={activeCategory === ALL_CATEGORY_KEY}
              onClick={() => handleCategoryClick(ALL_CATEGORY_KEY)}
              style={categoryButtonStyle(activeCategory === ALL_CATEGORY_KEY)}
            >
              Todas
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                role="option"
                aria-selected={activeCategory === cat}
                onClick={() => handleCategoryClick(cat)}
                style={categoryButtonStyle(activeCategory === cat)}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Right pane: articles */}
          <div style={articleListStyle}>
            {filtered.length === 0 ? (
              <div style={emptyStateStyle}>
                <p style={{ margin: 0, marginBottom: 8 }}>
                  Sin resultados para tu busqueda.
                </p>
                <p style={{ margin: 0 }}>
                  Contacta{" "}
                  <a
                    href={`mailto:${resolvedSupportEmail}`}
                    style={{
                      color: "var(--cocoa-accent)",
                      textDecoration: "none"
                    }}
                  >
                    {resolvedSupportEmail}
                  </a>
                </p>
              </div>
            ) : (
              filtered.map((article) => {
                const isOpen = expandedId === article.id;
                return (
                  <div key={article.id} style={articleRowStyle}>
                    <button
                      type="button"
                      onClick={() => toggleArticle(article.id)}
                      aria-expanded={isOpen}
                      aria-controls={`article-body-${article.id}`}
                      style={articleHeaderStyle}
                    >
                      <span style={chevronStyle(isOpen)} aria-hidden="true">
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 10 10"
                          focusable="false"
                        >
                          <path
                            d="M3 1L7 5L3 9"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            fill="none"
                          />
                        </svg>
                      </span>
                      <h3 style={articleTitleStyle}>{article.title}</h3>
                      <span style={articleMetaStyle}>{article.category}</span>
                    </button>
                    {isOpen ? (
                      <div
                        id={`article-body-${article.id}`}
                        style={articleBodyStyle}
                      >
                        {renderMarkdown(article.bodyMd)}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          <a
            href={resolvedExternalUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={footerLinkStyle}
          >
            Abrir centro de ayuda completo
          </a>
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

export default CocoaSearchableHelpModal;
