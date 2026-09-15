// Minimal markdown renderer for help articles (Tanda 5 · chrome).
//
// Dependency-free and deliberately small: headings (#, ##, ###), paragraphs,
// unordered (-, *) and ordered (1.) lists, pipe tables, and inline `code`,
// **bold** and *italic*. Anything else renders as plain text, so an article
// can never crash the help center.
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
      return (
        <code key={key} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.92em", padding: "1px 4px", borderRadius: 4, background: "var(--surface-sunken)" }}>
          {part.slice(1, -1)}
        </code>
      );
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
    <div className="guide-help-article" style={{ fontSize: 13, lineHeight: 1.5, color: "var(--ink)" }}>
      {body.map((block, index) => {
        const key = `b-${index}`;
        switch (block.kind) {
          case "heading": {
            const size = block.level === 1 ? 16 : block.level === 2 ? 14 : 13;
            return (
              <p key={key} style={{ margin: "12px 0 4px", fontSize: size, fontWeight: 700, color: "var(--ink)" }}>
                {renderInline(block.text, key)}
              </p>
            );
          }
          case "paragraph":
            return (
              <p key={key} style={{ margin: "6px 0" }}>
                {renderInline(block.text, key)}
              </p>
            );
          case "list": {
            const items = block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`} style={{ margin: "2px 0" }}>{renderInline(item, `${key}-${itemIndex}`)}</li>);
            return block.ordered ? (
              <ol key={key} style={{ margin: "6px 0", paddingLeft: 22 }}>
                {items}
              </ol>
            ) : (
              <ul key={key} style={{ margin: "6px 0", paddingLeft: 20 }}>
                {items}
              </ul>
            );
          }
          case "table": {
            const [head, ...rows] = block.rows;
            return (
              <div key={key} style={{ overflowX: "auto", margin: "8px 0" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      {head.map((cell, cellIndex) => (
                        <th key={`${key}-h-${cellIndex}`} style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--line)", color: "var(--ink-muted)", fontWeight: 600 }}>
                          {renderInline(cell, `${key}-h-${cellIndex}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, rowIndex) => (
                      <tr key={`${key}-r-${rowIndex}`}>
                        {row.map((cell, cellIndex) => (
                          <td key={`${key}-r-${rowIndex}-${cellIndex}`} style={{ padding: "4px 8px", borderBottom: "1px solid var(--line-soft, var(--line))", verticalAlign: "top" }}>
                            {renderInline(cell, `${key}-r-${rowIndex}-${cellIndex}`)}
                          </td>
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
