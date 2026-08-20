import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { SettingsView } from "./SettingsView";
import { useTerminalStore } from "../../store/terminalStore";

describe("SettingsView", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      isSettingsOpen: true,
      activeSettingsTab: "general",
    });
  });

  it("renders active pane based on activeSettingsTab", () => {
    const { rerender } = render(<SettingsView />);
    expect(screen.getByRole("region", { name: /general settings/i })).toBeInTheDocument();
    expect(screen.getByText(/workspace & startup/i)).toBeInTheDocument();

    useTerminalStore.setState({ activeSettingsTab: "appearance" });
    rerender(<SettingsView />);
    expect(screen.getByRole("region", { name: /appearance settings/i })).toBeInTheDocument();
    expect(screen.getByText(/live preview/i)).toBeInTheDocument();

    useTerminalStore.setState({ activeSettingsTab: "shortcuts" });
    rerender(<SettingsView />);
    expect(screen.getByRole("region", { name: /keyboard shortcuts/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search shortcuts/i)).toBeInTheDocument();
  });

  it("navigates between categories using sidebar buttons", () => {
    render(<SettingsView />);
    expect(screen.getByRole("region", { name: /general settings/i })).toBeInTheDocument();

    const appearanceTab = screen.getByRole("button", { name: /appearance/i });
    fireEvent.click(appearanceTab);
    expect(useTerminalStore.getState().activeSettingsTab).toBe("appearance");
    expect(screen.getByRole("region", { name: /appearance settings/i })).toBeInTheDocument();

    const shortcutsTab = screen.getByRole("button", { name: /shortcuts/i });
    fireEvent.click(shortcutsTab);
    expect(useTerminalStore.getState().activeSettingsTab).toBe("shortcuts");
    expect(screen.getByRole("region", { name: /keyboard shortcuts/i })).toBeInTheDocument();

    const generalTab = screen.getByRole("button", { name: /general/i });
    fireEvent.click(generalTab);
    expect(useTerminalStore.getState().activeSettingsTab).toBe("general");
    expect(screen.getByRole("region", { name: /general settings/i })).toBeInTheDocument();
  });

  it("renders placeholder pane for terminal tab", () => {
    useTerminalStore.setState({ activeSettingsTab: "terminal" });
    render(<SettingsView />);
    expect(screen.getByText(/terminal settings coming soon/i)).toBeInTheDocument();
  });

  it("closes settings view when back button in sidebar is clicked", () => {
    render(<SettingsView />);
    const backBtn = screen.getByRole("button", { name: /back/i });
    fireEvent.click(backBtn);
    expect(useTerminalStore.getState().isSettingsOpen).toBe(false);
  });
});
