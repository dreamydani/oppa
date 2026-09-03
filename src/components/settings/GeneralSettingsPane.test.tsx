import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GeneralSettingsPane } from "./GeneralSettingsPane";
import { MANUAL_UPDATE_CHECK_EVENT } from "../UpdateBanner";
import { useTerminalStore } from "../../store/terminalStore";
import { DEFAULT_APP_SETTINGS } from "../../lib/settings/types";

describe("GeneralSettingsPane", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      settings: JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)),
      isSettingsOpen: true,
      activeSettingsTab: "general",
    });
  });

  it("renders all 5 main sections and descriptive headers", () => {
    render(<GeneralSettingsPane />);

    expect(screen.getByRole("heading", { name: /^general$/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /workspace & startup/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /navigation & confirmations/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /code editor/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /web browser/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^updates$/i, level: 3 })).toBeInTheDocument();
  });

  describe("Workspace & Startup", () => {
    it("renders default CWD mode options and updates store on selection", () => {
      render(<GeneralSettingsPane />);

      const homeBtn = screen.getByRole("button", { name: /home \(~\)/i });
      const lastActiveBtn = screen.getByRole("button", { name: /last active/i });
      const customPathBtn = screen.getByRole("button", { name: /custom path/i });

      expect(homeBtn).toHaveClass("active");
      expect(lastActiveBtn).not.toHaveClass("active");
      expect(customPathBtn).not.toHaveClass("active");

      // Select Last Active
      fireEvent.click(lastActiveBtn);
      expect(useTerminalStore.getState().settings.general.defaultCwdMode).toBe("last_active");

      // Select Custom Path
      fireEvent.click(customPathBtn);
      expect(useTerminalStore.getState().settings.general.defaultCwdMode).toBe("custom");

      // Custom path input should now be visible
      const customInput = screen.getByPlaceholderText("/path/to/projects");
      expect(customInput).toBeInTheDocument();

      fireEvent.change(customInput, { target: { value: "/home/user/workspace" } });
      expect(useTerminalStore.getState().settings.general.customDefaultCwd).toBe("/home/user/workspace");

      // Switch back to Home
      fireEvent.click(homeBtn);
      expect(useTerminalStore.getState().settings.general.defaultCwdMode).toBe("home");
    });

    it("renders startup behavior options and updates store on selection", () => {
      render(<GeneralSettingsPane />);

      const restoreBtn = screen.getByRole("button", { name: /restore session/i });
      const launcherBtn = screen.getByRole("button", { name: /setup wizard/i });
      const freshBtn = screen.getByRole("button", { name: /fresh terminal/i });

      expect(restoreBtn).toHaveClass("active");

      fireEvent.click(launcherBtn);
      expect(useTerminalStore.getState().settings.general.startupBehavior).toBe("workspace_launcher");

      fireEvent.click(freshBtn);
      expect(useTerminalStore.getState().settings.general.startupBehavior).toBe("fresh_terminal");

      fireEvent.click(restoreBtn);
      expect(useTerminalStore.getState().settings.general.startupBehavior).toBe("restore_previous");
    });
  });

  describe("Navigation & Confirmations", () => {
    it("renders tab switching mode options and updates store", () => {
      render(<GeneralSettingsPane />);

      const sequentialBtn = screen.getByRole("button", { name: /sequential/i });
      const mruBtn = screen.getByRole("button", { name: /mru/i });

      expect(sequentialBtn).toHaveClass("active");

      fireEvent.click(mruBtn);
      expect(useTerminalStore.getState().settings.general.tabSwitchMode).toBe("mru");

      fireEvent.click(sequentialBtn);
      expect(useTerminalStore.getState().settings.general.tabSwitchMode).toBe("sequential");
    });

    it("toggles safety confirmation switches", () => {
      render(<GeneralSettingsPane />);

      const multiPaneSwitch = screen.getByRole("switch", { name: /confirm before closing multi-pane workspaces/i });
      const quitProcessSwitch = screen.getByRole("switch", { name: /confirm quit with running processes/i });

      expect(multiPaneSwitch).toBeChecked();
      expect(quitProcessSwitch).toBeChecked();

      fireEvent.click(multiPaneSwitch);
      expect(useTerminalStore.getState().settings.general.confirmCloseTabWithMultiplePanes).toBe(false);

      fireEvent.click(multiPaneSwitch);
      expect(useTerminalStore.getState().settings.general.confirmCloseTabWithMultiplePanes).toBe(true);

      fireEvent.click(quitProcessSwitch);
      expect(useTerminalStore.getState().settings.general.confirmQuitWithRunningProcesses).toBe(false);

      fireEvent.click(quitProcessSwitch);
      expect(useTerminalStore.getState().settings.general.confirmQuitWithRunningProcesses).toBe(true);
    });
  });

  describe("Code Editor", () => {
    it("toggles editor word wrap switch", () => {
      render(<GeneralSettingsPane />);

      const wordWrapSwitch = screen.getByRole("switch", { name: /editor word wrap/i });
      expect(wordWrapSwitch).toBeChecked();

      fireEvent.click(wordWrapSwitch);
      expect(useTerminalStore.getState().settings.general.editorWordWrap).toBe(false);

      fireEvent.click(wordWrapSwitch);
      expect(useTerminalStore.getState().settings.general.editorWordWrap).toBe(true);
    });

    it("updates auto-save delay through select dropdown", () => {
      render(<GeneralSettingsPane />);

      const autoSaveSelect = screen.getByRole("combobox", { name: /auto-save delay/i });
      expect(autoSaveSelect).toHaveValue("1000");

      fireEvent.change(autoSaveSelect, { target: { value: "3000" } });
      expect(useTerminalStore.getState().settings.general.editorAutoSaveDelay).toBe(3000);

      fireEvent.change(autoSaveSelect, { target: { value: "0" } });
      expect(useTerminalStore.getState().settings.general.editorAutoSaveDelay).toBe(0);
    });
  });

  describe("Web Browser", () => {
    it("updates default search engine dropdown", () => {
      render(<GeneralSettingsPane />);

      const searchEngineSelect = screen.getByRole("combobox", { name: /default search engine/i });
      expect(searchEngineSelect).toHaveValue("duckduckgo");

      fireEvent.change(searchEngineSelect, { target: { value: "google" } });
      expect(useTerminalStore.getState().settings.general.browserSearchEngine).toBe("google");

      fireEvent.change(searchEngineSelect, { target: { value: "bing" } });
      expect(useTerminalStore.getState().settings.general.browserSearchEngine).toBe("bing");
    });

    it("updates browser home page URL input", () => {
      render(<GeneralSettingsPane />);

      const homePageInput = screen.getByRole("textbox", { name: /home page url/i });
      expect(homePageInput).toHaveValue("https://duckduckgo.com");

      fireEvent.change(homePageInput, { target: { value: "https://news.ycombinator.com" } });
      expect(useTerminalStore.getState().settings.general.browserHomePage).toBe("https://news.ycombinator.com");
    });
  });

  describe("Updates", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("auto-check switch defaults on and flips autoCheckUpdates", () => {
      render(<GeneralSettingsPane />);

      const autoCheckSwitch = screen.getByRole("switch", {
        name: /automatically check for updates/i,
      });
      expect(autoCheckSwitch).toBeChecked();
      expect(
        useTerminalStore.getState().settings.general.autoCheckUpdates,
      ).toBe(true);

      fireEvent.click(autoCheckSwitch);
      expect(
        useTerminalStore.getState().settings.general.autoCheckUpdates,
      ).toBe(false);
      expect(autoCheckSwitch).not.toBeChecked();

      fireEvent.click(autoCheckSwitch);
      expect(
        useTerminalStore.getState().settings.general.autoCheckUpdates,
      ).toBe(true);
    });

    it("Check-now dispatches a manual update check for the card", () => {
      render(<GeneralSettingsPane />);
      const dispatchSpy = vi.spyOn(window, "dispatchEvent");

      fireEvent.click(screen.getByRole("button", { name: /check now/i }));

      const manualChecks = dispatchSpy.mock.calls.filter(
        ([event]) =>
          event instanceof CustomEvent && event.type === MANUAL_UPDATE_CHECK_EVENT,
      );
      expect(manualChecks).toHaveLength(1);
    });
  });
});
