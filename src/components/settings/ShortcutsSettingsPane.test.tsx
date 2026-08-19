import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ShortcutsSettingsPane } from "./ShortcutsSettingsPane";

describe("ShortcutsSettingsPane", () => {
  it("renders header, description, and search input", () => {
    render(<ShortcutsSettingsPane />);

    expect(
      screen.getByRole("heading", { name: /keyboard shortcuts/i, level: 2 })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/quick reference of all navigation, terminal, layout, and mode keybindings/i)
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/search shortcuts\.\.\./i)
    ).toBeInTheDocument();
  });

  it("renders all 4 shortcut categories and essential shortcut items", () => {
    render(<ShortcutsSettingsPane />);

    expect(
      screen.getByRole("heading", { name: /tabs & workspaces/i, level: 3 })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /split panes/i, level: 3 })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /sidebars & app modes/i, level: 3 })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /settings & help/i, level: 3 })
    ).toBeInTheDocument();

    // Check specific shortcut labels
    expect(screen.getByText("New Tab")).toBeInTheDocument();
    expect(screen.getByText("Close Tab / Pane")).toBeInTheDocument();
    expect(screen.getByText("Cycle Next Tab")).toBeInTheDocument();
    expect(screen.getByText("Cycle Previous Tab")).toBeInTheDocument();
    expect(screen.getByText("Direct Tab Jump")).toBeInTheDocument();
    expect(screen.getByText("Workspace Launcher")).toBeInTheDocument();

    expect(screen.getByText("Split Horizontal")).toBeInTheDocument();
    expect(screen.getByText("Split Vertical")).toBeInTheDocument();
    expect(screen.getByText("Move Focus to Pane")).toBeInTheDocument();
    expect(screen.getByText("Swap Focused Pane")).toBeInTheDocument();

    expect(screen.getByText("Toggle Left Sidebar")).toBeInTheDocument();
    expect(screen.getByText("Toggle Right Sidebar")).toBeInTheDocument();
    expect(screen.getByText("Browser Mode")).toBeInTheDocument();
    expect(screen.getByText("Terminal Mode")).toBeInTheDocument();
    expect(screen.getByText("Editor Mode")).toBeInTheDocument();

    expect(screen.getByText("Open Settings")).toBeInTheDocument();
    expect(screen.getByText("Close Modal / Back")).toBeInTheDocument();
    expect(screen.getByText("Terminal Find")).toBeInTheDocument();
  });

  it("filters shortcuts by action name", () => {
    render(<ShortcutsSettingsPane />);

    const searchInput = screen.getByPlaceholderText(/search shortcuts\.\.\./i);
    fireEvent.change(searchInput, { target: { value: "split" } });

    expect(screen.getByText("Split Horizontal")).toBeInTheDocument();
    expect(screen.getByText("Split Vertical")).toBeInTheDocument();
    expect(screen.queryByText("New Tab")).not.toBeInTheDocument();
    expect(screen.queryByText("Browser Mode")).not.toBeInTheDocument();
  });

  it("filters shortcuts by key badge", () => {
    render(<ShortcutsSettingsPane />);

    const searchInput = screen.getByPlaceholderText(/search shortcuts\.\.\./i);
    fireEvent.change(searchInput, { target: { value: "Esc" } });

    expect(screen.getByText("Close Modal / Back")).toBeInTheDocument();
    expect(screen.queryByText("New Tab")).not.toBeInTheDocument();
    expect(screen.queryByText("Split Horizontal")).not.toBeInTheDocument();
  });

  it("filters shortcuts by category name", () => {
    render(<ShortcutsSettingsPane />);

    const searchInput = screen.getByPlaceholderText(/search shortcuts\.\.\./i);
    fireEvent.change(searchInput, { target: { value: "Sidebars" } });

    expect(screen.getByText("Toggle Left Sidebar")).toBeInTheDocument();
    expect(screen.getByText("Toggle Right Sidebar")).toBeInTheDocument();
    expect(screen.queryByText("Split Horizontal")).not.toBeInTheDocument();
  });

  it("shows empty state when no shortcuts match query", () => {
    render(<ShortcutsSettingsPane />);

    const searchInput = screen.getByPlaceholderText(/search shortcuts\.\.\./i);
    fireEvent.change(searchInput, { target: { value: "xyznonexistentshortcut123" } });

    expect(screen.getByText(/no shortcuts found/i)).toBeInTheDocument();
    expect(screen.queryByText("New Tab")).not.toBeInTheDocument();
    expect(screen.queryByText("Split Horizontal")).not.toBeInTheDocument();
  });

  it("clears search input when clicking clear button", () => {
    render(<ShortcutsSettingsPane />);

    const searchInput = screen.getByPlaceholderText(/search shortcuts\.\.\./i);
    fireEvent.change(searchInput, { target: { value: "split" } });
    expect(screen.queryByText("New Tab")).not.toBeInTheDocument();

    const clearButton = screen.getByRole("button", { name: /clear search/i });
    fireEvent.click(clearButton);

    expect(searchInput).toHaveValue("");
    expect(screen.getByText("New Tab")).toBeInTheDocument();
    expect(screen.getByText("Split Horizontal")).toBeInTheDocument();
  });
});
