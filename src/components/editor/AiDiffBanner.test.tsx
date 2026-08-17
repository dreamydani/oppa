import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useTerminalStore } from "../../store/terminalStore";
import { AiDiffBanner } from "./AiDiffBanner";

describe("AiDiffBanner", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      pendingAiDiff: {
        path: "src/components/TitleBar.tsx",
        original: "export const x = 1;",
        modified: "export const x = 2;\nexport const y = 3;",
        summary: "Refactor TitleBar constants and export y",
      },
    });
  });

  it("renders nothing if pendingAiDiff is null", () => {
    useTerminalStore.setState({ pendingAiDiff: null });
    const { container } = render(<AiDiffBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders AI diff banner with title and summary", () => {
    render(<AiDiffBanner />);
    expect(screen.getByText(/AI Proposed Changes/i)).toBeInTheDocument();
    expect(
      screen.getByText("Refactor TitleBar constants and export y"),
    ).toBeInTheDocument();
  });

  it("calls acceptAiDiff when clicking Accept & Apply button", async () => {
    const acceptSpy = vi.spyOn(useTerminalStore.getState(), "acceptAiDiff");
    render(<AiDiffBanner />);

    const acceptBtn = screen.getByRole("button", { name: /accept/i });
    fireEvent.click(acceptBtn);

    expect(acceptSpy).toHaveBeenCalled();
  });

  it("calls rejectAiDiff when clicking Reject / Discard button", () => {
    const rejectSpy = vi.spyOn(useTerminalStore.getState(), "rejectAiDiff");
    render(<AiDiffBanner />);

    const rejectBtn = screen.getByRole("button", { name: /reject|discard/i });
    fireEvent.click(rejectBtn);

    expect(rejectSpy).toHaveBeenCalled();
  });

  it("allows toggling between Inline Diff and Side-by-Side Split views", () => {
    const onToggleInline = vi.fn();
    render(<AiDiffBanner isInline={false} onToggleInline={onToggleInline} />);

    const inlineBtn = screen.getByRole("button", { name: /inline/i });
    fireEvent.click(inlineBtn);

    expect(onToggleInline).toHaveBeenCalledWith(true);
  });
});
