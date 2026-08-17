import { useState, type ReactElement, type ReactNode } from "react";

export interface MarkdownViewerProps {
  content: string;
  className?: string;
}

interface CodeBlockProps {
  code: string;
  language: string;
}

function CodeBlock({ code, language }: CodeBlockProps): ReactElement {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      // Ignore clipboard error in unsupported environments
    }
  };

  return (
    <div className="md-code-block-wrapper">
      <div className="md-code-block-header">
        <span className="md-code-lang">{language || "text"}</span>
        <button
          type="button"
          className="md-code-copy-btn"
          aria-label="Copy code to clipboard"
          onClick={handleCopy}
        >
          {copied ? "✓ Copied!" : "Copy"}
        </button>
      </div>
      <pre className="md-code-block">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderInline(text: string): ReactNode[] {
  // Regex to match markdown links, inline code, bold, italics, strikethrough
  const inlineRegex =
    /(\[.*?\]\(.*?\)|\`.*?\`|\*\*.*?\*\*|__.*?__|(?:\*|_).*?(?:\*|_)|~~.*?~~)/g;
  const parts = text.split(inlineRegex);

  return parts.map((part, index) => {
    if (!part) return null;

    // Link: [text](url)
    const linkMatch = /^\[(.*?)\]\((.*?)\)$/.exec(part);
    if (linkMatch) {
      return (
        <a
          key={index}
          href={linkMatch[2]}
          target="_blank"
          rel="noreferrer"
          className="md-link"
        >
          {renderInline(linkMatch[1])}
        </a>
      );
    }

    // Inline Code: `code`
    const codeMatch = /^`(.*?)`$/.exec(part);
    if (codeMatch) {
      return (
        <code key={index} className="md-inline-code">
          {codeMatch[1]}
        </code>
      );
    }

    // Bold: **text** or __text__
    const boldMatch = /^(?:\*\*|__)(.*?)(?:\*\*|__)$/.exec(part);
    if (boldMatch) {
      return <strong key={index}>{renderInline(boldMatch[1])}</strong>;
    }

    // Italic: *text* or _text_
    const italicMatch = /^(?:\*|_)(.*?)(?:\*|_)$/.exec(part);
    if (italicMatch) {
      return <em key={index}>{renderInline(italicMatch[1])}</em>;
    }

    // Strikethrough: ~~text~~
    const strikeMatch = /^~~(.*?)~~$/.exec(part);
    if (strikeMatch) {
      return <del key={index}>{renderInline(strikeMatch[1])}</del>;
    }

    return part;
  });
}

function parseMarkdownToNodes(markdown: string): ReactNode[] {
  const lines = markdown.split("\n");
  const nodes: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 1. Fenced Code Blocks: ```
    if (line.trim().startsWith("```")) {
      const language = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      nodes.push(
        <CodeBlock
          key={`code-${nodes.length}`}
          code={codeLines.join("\n")}
          language={language}
        />,
      );
      continue;
    }

    // 2. Table: lines starting and containing |
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        tableLines.push(lines[i].trim());
        i++;
      }

      if (tableLines.length >= 2) {
        const headerRow = tableLines[0]
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim());
        // Check if second line is separator like |---|---|
        const isSeparator = /^\|?(\s*:?-+:?\s*\|?)+$/.test(tableLines[1]);
        const dataRows = tableLines.slice(isSeparator ? 2 : 1).map((r) =>
          r
            .slice(1, -1)
            .split("|")
            .map((c) => c.trim()),
        );

        nodes.push(
          <div key={`table-wrapper-${nodes.length}`} className="md-table-wrapper">
            <table className="md-table">
              <thead>
                <tr>
                  {headerRow.map((col, idx) => (
                    <th key={idx}>{renderInline(col)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataRows.map((row, rIdx) => (
                  <tr key={rIdx}>
                    {row.map((cell, cIdx) => (
                      <td key={cIdx}>{renderInline(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        continue;
      }
    }

    // 3. Headings: # H1 to ###### H6
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const HeadingTag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      nodes.push(
        <HeadingTag key={`h-${nodes.length}`} className={`md-h${level}`}>
          {renderInline(text)}
        </HeadingTag>,
      );
      i++;
      continue;
    }

    // 4. Horizontal Rule: --- or ***
    if (/^(?:---|\*\*\*|___)\s*$/.test(line.trim())) {
      nodes.push(<hr key={`hr-${nodes.length}`} className="md-hr" />);
      i++;
      continue;
    }

    // 5. Blockquote: > text
    if (line.trim().startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      nodes.push(
        <blockquote key={`quote-${nodes.length}`} className="md-blockquote">
          {quoteLines.map((ql, qIdx) => (
            <p key={qIdx}>{renderInline(ql)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    // 6. Task List & Unordered/Ordered List items
    const taskMatch = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (taskMatch) {
      const checked = taskMatch[1].toLowerCase() === "x";
      const text = taskMatch[2];
      nodes.push(
        <div key={`task-${nodes.length}`} className="md-task-item">
          <input
            type="checkbox"
            checked={checked}
            readOnly
            className="md-task-checkbox"
          />
          <span className={checked ? "md-task-done" : ""}>{renderInline(text)}</span>
        </div>,
      );
      i++;
      continue;
    }

    const bulletMatch = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bulletMatch) {
      nodes.push(
        <li key={`li-${nodes.length}`} className="md-list-item">
          {renderInline(bulletMatch[1])}
        </li>,
      );
      i++;
      continue;
    }

    // 7. Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // 8. Paragraph
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith("#") &&
      !lines[i].trim().startsWith("```") &&
      !lines[i].trim().startsWith(">") &&
      !lines[i].trim().startsWith("- ") &&
      !lines[i].trim().startsWith("* ") &&
      !lines[i].trim().startsWith("|")
    ) {
      paraLines.push(lines[i]);
      i++;
    }

    nodes.push(
      <p key={`p-${nodes.length}`} className="md-paragraph">
        {paraLines.map((pl, pIdx) => (
          <span key={pIdx}>
            {pIdx > 0 && <br />}
            {renderInline(pl)}
          </span>
        ))}
      </p>,
    );
  }

  return nodes;
}

export function MarkdownViewer({
  content,
  className = "",
}: MarkdownViewerProps): ReactElement {
  const renderedNodes = parseMarkdownToNodes(content);

  return (
    <div className={`markdown-viewer ${className}`} data-testid="markdown-viewer">
      <div className="markdown-content">{renderedNodes}</div>
    </div>
  );
}
