import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MarkdownViewer } from "./MarkdownViewer";

describe("MarkdownViewer", () => {
  it("renders headings properly", () => {
    const md = "# Title 1\n## Section 2\n### Sub-section 3";
    render(<MarkdownViewer content={md} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Title 1");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Section 2");
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Sub-section 3");
  });

  it("renders task lists with checkboxes", () => {
    const md = "- [x] Completed task\n- [ ] Pending task";
    render(<MarkdownViewer content={md} />);

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.length).toBe(2);
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[1].checked).toBe(false);
  });

  it("renders code blocks with a copy button", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: writeTextMock,
      },
      configurable: true,
      writable: true,
    });

    const md = "```typescript\nconst greeting: string = 'Hello OPPA';\n```";
    render(<MarkdownViewer content={md} />);

    expect(screen.getByText(/const greeting: string = 'Hello OPPA';/)).toBeInTheDocument();
    const copyBtn = screen.getByRole("button", { name: /copy/i });
    expect(copyBtn).toBeInTheDocument();

    fireEvent.click(copyBtn);
    expect(writeTextMock).toHaveBeenCalledWith("const greeting: string = 'Hello OPPA';");
  });

  it("renders blockquotes, bold, italics, inline code, and links", () => {
    const md = "> This is a quote\n\n**Bold text** and *Italic text* and `inlineCode` and [Link Text](https://example.com)";
    render(<MarkdownViewer content={md} />);

    expect(screen.getByText("This is a quote")).toBeInTheDocument();
    expect(screen.getByText("Bold text")).toBeInTheDocument();
    expect(screen.getByText("Italic text")).toBeInTheDocument();
    expect(screen.getByText("inlineCode")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "Link Text" });
    expect(link).toHaveAttribute("href", "https://example.com");
  });

  it("renders tables properly", () => {
    const md = `| Command | Description |
| --- | --- |
| \`pnpm dev\` | Start dev server |
| \`pnpm test\` | Run vitest suite |`;

    render(<MarkdownViewer content={md} />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Command")).toBeInTheDocument();
    expect(screen.getByText("Start dev server")).toBeInTheDocument();
    expect(screen.getByText("Run vitest suite")).toBeInTheDocument();
  });
});
