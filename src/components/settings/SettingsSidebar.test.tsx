import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsSidebar } from "./SettingsSidebar";
import { useTerminalStore } from "../../store/terminalStore";

describe("SettingsSidebar", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      isSettingsOpen: true,
      activeSettingsTab: "general",
    });
  });

  it("renders back button with Esc badge and category buttons", () => {
    render(<SettingsSidebar />);

    const backBtn = screen.getByRole("button", { name: /back/i });
    expect(backBtn).toBeInTheDocument();
    expect(screen.getByText("Esc")).toBeInTheDocument();

    const generalBtn = screen.getByRole("button", { name: /general/i });
    const appearanceBtn = screen.getByRole("button", { name: /appearance/i });
    const terminalBtn = screen.getByRole("button", { name: /terminal/i });
    const shortcutsBtn = screen.getByRole("button", { name: /shortcuts/i });

    expect(generalBtn).toBeInTheDocument();
    expect(appearanceBtn).toBeInTheDocument();
    expect(terminalBtn).toBeInTheDocument();
    expect(shortcutsBtn).toBeInTheDocument();
  });

  it("highlights the currently active category tab", () => {
    const { rerender } = render(<SettingsSidebar />);
    const generalBtn = screen.getByRole("button", { name: /general/i });
    expect(generalBtn.className).toContain("active");

    useTerminalStore.setState({ activeSettingsTab: "shortcuts" });
    rerender(<SettingsSidebar />);

    const shortcutsBtn = screen.getByRole("button", { name: /shortcuts/i });
    expect(shortcutsBtn.className).toContain("active");
    expect(generalBtn.className).not.toContain("active");
  });

  it("switches category tab when an enabled category is clicked", () => {
    render(<SettingsSidebar />);

    const appearanceBtn = screen.getByRole("button", { name: /appearance/i });
    fireEvent.click(appearanceBtn);
    expect(useTerminalStore.getState().activeSettingsTab).toBe("appearance");

    const shortcutsBtn = screen.getByRole("button", { name: /shortcuts/i });
    fireEvent.click(shortcutsBtn);
    expect(useTerminalStore.getState().activeSettingsTab).toBe("shortcuts");
  });

  it("closes settings when the back button is clicked", () => {
    render(<SettingsSidebar />);

    const backBtn = screen.getByRole("button", { name: /back/i });
    fireEvent.click(backBtn);

    expect(useTerminalStore.getState().isSettingsOpen).toBe(false);
  });

  it("renders disabled state and Coming Soon badge for inactive categories", () => {
    render(<SettingsSidebar />);

    const appearanceBtn = screen.getByRole("button", { name: /appearance/i });
    const terminalBtn = screen.getByRole("button", { name: /terminal/i });

    expect(appearanceBtn).not.toBeDisabled();
    expect(terminalBtn).toBeDisabled();

    const badges = screen.getAllByText("Coming Soon");
    expect(badges.length).toBe(1);
  });
});
