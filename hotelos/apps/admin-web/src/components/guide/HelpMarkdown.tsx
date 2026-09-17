// Minimal markdown renderer for help articles (Tanda 5 · chrome).
//
// Dependency-free and deliberately small: headings (#, ##, ###), paragraphs,
// unordered (-, *) and ordered (1.) lists, pipe tables, and inline `code`,
// **bold** and *italic*. Anything else renders as plain text, so an article
// can never crash the help center.
//
// Skin: styles/cocoa-22-guide.css (`c22-guide-help-article` and its parts) —
// no inline styles here, so the article follows the Cocoa tokens in both
// appearances.
import { Fragment, type ReactNode } from "react";

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; rows: string[][] };

export function parseMarkdownBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let table: string[][] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
      list = null;
    }
  };
  const flushTable = () => {
    if (table) {
      blocks.push({ kind: "table", rows: table });
      table = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed === "") {
      flushParagraph();
      flushList();
      flushTable();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      flushTable();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    if (trimmed.startsWith("|")) {
      flushParagraph();
      flushList();
      const cells = trimmed
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());
      // Alignment rows (| --- | --- |) carry no content.
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
      (table ??= []).push(cells);
      continue;
    }
    flushTable();
    // Indented continuation of a list item («   - *Por porcentaje*: …»).
    if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${trimmed}`;
      continue;
    }
    const unordered = /^[-*]\s+(.*)$/.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const text = (ordered ?? unordered)![1];
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push(text);
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  flushTable();
  return blocks;
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;

export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const parts = text.split(INLINE);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return <em key={key}>{part.slice(1, -1)}</em>;
    return <Fragment key={key}>{part}</Fragment>;
  });
}

export function HelpMarkdown({ markdown, hideTitle = false }: { markdown: string; hideTitle?: boolean }) {
  const blocks = parseMarkdownBlocks(markdown);
  const body = hideTitle ? blocks.filter((block, index) => !(index === 0 && block.kind === "heading" && block.level === 1)) : blocks;
  return (
    <div className="c22-guide-help-article">
      {body.map((block, index) => {
        const key = `b-${index}`;
        switch (block.kind) {
          case "heading":
            return (
              <p key={key} className="c22-guide-help-heading" data-level={block.level}>
                {renderInline(block.text, key)}
              </p>
            );
          case "paragraph":
            return (
              <p key={key} className="c22-guide-help-p">
                {renderInline(block.text, key)}
              </p>
            );
          case "list": {
            const items = block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>);
            return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
          }
          case "table": {
            const [head, ...rows] = block.rows;
            return (
              <div key={key} className="c22-guide-help-table-wrap">
                <table>
                  <thead>
                    <tr>
                      {head.map((cell, cellIndex) => (
                        <th key={`${key}-h-${cellIndex}`}>{renderInline(cell, `${key}-h-${cellIndex}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, rowIndex) => (
                      <tr key={`${key}-r-${rowIndex}`}>
                        {row.map((cell, cellIndex) => (
                          <td key={`${key}-r-${rowIndex}-${cellIndex}`}>{renderInline(cell, `${key}-r-${rowIndex}-${cellIndex}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          default:
            return null;
        }
      })}
    </div>
  );
}

export default HelpMarkdown;
