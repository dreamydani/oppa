import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppearanceSettingsPane } from "./AppearanceSettingsPane";
import { useTerminalStore } from "../../store/terminalStore";
import { DEFAULT_APP_SETTINGS } from "../../lib/settings/types";
import { getAllTerminalThemes } from "../../lib/theme/terminalThemes";

describe("AppearanceSettingsPane", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      settings: JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)),
      isSettingsOpen: true,
      activeSettingsTab: "appearance",
    });
  });

  it("renders header, App & Workbench section, section divider, and Terminal section", () => {
    render(<AppearanceSettingsPane />);

    expect(screen.getByRole("region", { name: /appearance settings/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^appearance$/i, level: 2 })).toBeInTheDocument();
    expect(
      screen.getByText(/application theme, ui scale, workbench layout, and terminal visual options/i)
    ).toBeInTheDocument();

    // App & Workbench Section
    expect(screen.getByText("App & Workbench")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /app theme & scaling/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /sidebar & chrome/i, level: 3 })).toBeInTheDocument();

    // Section Divider
    expect(screen.getByTestId("appearance-section-divider")).toBeInTheDocument();

    // Terminal Appearance Section
    expect(screen.getByText("Terminal Appearance")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-preview-box")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /terminal theme/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /typography & layout/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /cursor & window/i, level: 3 })).toBeInTheDocument();
  });

  describe("App Theme & Scaling Bento Card", () => {
    it("updates appTheme when clicking Dark, Light, System segmented buttons", () => {
      render(<AppearanceSettingsPane />);

      const darkBtn = screen.getByRole("button", { name: /dark 🌙/i });
      const lightBtn = screen.getByRole("button", { name: /light ☀️/i });
      const systemBtn = screen.getByRole("button", { name: /system 💻/i });

      expect(darkBtn).toHaveClass("active");
      expect(lightBtn).not.toHaveClass("active");
      expect(systemBtn).not.toHaveClass("active");

      // Switch to Light
      fireEvent.click(lightBtn);
      expect(useTerminalStore.getState().settings.appearance.appTheme).toBe("light");
      expect(lightBtn).toHaveClass("active");

      // Switch to System
      fireEvent.click(systemBtn);
      expect(useTerminalStore.getState().settings.appearance.appTheme).toBe("system");
      expect(systemBtn).toHaveClass("active");

      // Switch to Dark
      fireEvent.click(darkBtn);
      expect(useTerminalStore.getState().settings.appearance.appTheme).toBe("dark");
      expect(darkBtn).toHaveClass("active");
    });

    it("updates uiZoom when clicking preset scale buttons", () => {
      render(<AppearanceSettingsPane />);

      const zoom80Btn = screen.getByRole("button", { name: /^80%$/i });
      const zoom90Btn = screen.getByRole("button", { name: /^90%$/i });
      const zoom100Btn = screen.getByRole("button", { name: /^100%$/i });
      const zoom110Btn = screen.getByRole("button", { name: /^110%$/i });
      const zoom125Btn = screen.getByRole("button", { name: /^125%$/i });

      expect(zoom100Btn).toHaveClass("active");

      fireEvent.click(zoom80Btn);
      expect(useTerminalStore.getState().settings.appearance.uiZoom).toBe(0.8);
      expect(zoom80Btn).toHaveClass("active");

      fireEvent.click(zoom110Btn);
      expect(useTerminalStore.getState().settings.appearance.uiZoom).toBe(1.1);
      expect(zoom110Btn).toHaveClass("active");

      fireEvent.click(zoom125Btn);
      expect(useTerminalStore.getState().settings.appearance.uiZoom).toBe(1.25);
      expect(zoom125Btn).toHaveClass("active");

      fireEvent.click(zoom90Btn);
      expect(useTerminalStore.getState().settings.appearance.uiZoom).toBe(0.9);
      expect(zoom90Btn).toHaveClass("active");
    });

    it("updates app UI font family via preset select and custom input", () => {
      render(<AppearanceSettingsPane />);

      const appFontSelect = screen.getByRole("combobox", { name: /app font family preset/i });
      expect(appFontSelect).toBeInTheDocument();

      fireEvent.change(appFontSelect, {
        target: { value: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" },
      });
      expect(useTerminalStore.getState().settings.appearance.appFontFamily).toBe(
        "'Inter', -apple-system, BlinkMacSystemFont, sans-serif"
      );

      const customInput = screen.getByRole("textbox", { name: /custom app font family/i });
      expect(customInput).toBeInTheDocument();

      fireEvent.change(customInput, { target: { value: "Fira Sans, sans-serif" } });
      expect(useTerminalStore.getState().settings.appearance.appFontFamily).toBe(
        "Fira Sans, sans-serif"
      );
    });
  });

  describe("Sidebar & Chrome Bento Card", () => {
    it("updates sidebarOnLaunch via segmented control", () => {
      render(<AppearanceSettingsPane />);

      const openBtn = screen.getByRole("button", { name: /^open$/i });
      const collapsedBtn = screen.getByRole("button", { name: /^collapsed$/i });

      expect(openBtn).toHaveClass("active");
      expect(collapsedBtn).not.toHaveClass("active");

      fireEvent.click(collapsedBtn);
      expect(useTerminalStore.getState().settings.appearance.sidebarOnLaunch).toBe("collapsed");
      expect(collapsedBtn).toHaveClass("active");

      fireEvent.click(openBtn);
      expect(useTerminalStore.getState().settings.appearance.sidebarOnLaunch).toBe("open");
      expect(openBtn).toHaveClass("active");
    });

    it("toggles showStatusBar switch", () => {
      render(<AppearanceSettingsPane />);

      const statusBarSwitch = screen.getByRole("switch", { name: /show status bar/i });
      expect(statusBarSwitch).toBeChecked();

      fireEvent.click(statusBarSwitch);
      expect(useTerminalStore.getState().settings.appearance.showStatusBar).toBe(false);

      fireEvent.click(statusBarSwitch);
      expect(useTerminalStore.getState().settings.appearance.showStatusBar).toBe(true);
    });

    it("toggles showTitlebarLogo switch", () => {
      render(<AppearanceSettingsPane />);

      const logoSwitch = screen.getByRole("switch", { name: /show "oppa" logo/i });
      expect(logoSwitch).toBeChecked();

      fireEvent.click(logoSwitch);
      expect(useTerminalStore.getState().settings.appearance.showTitlebarLogo).toBe(false);

      fireEvent.click(logoSwitch);
      expect(useTerminalStore.getState().settings.appearance.showTitlebarLogo).toBe(true);
    });
  });

  describe("Terminal Theme Bento Card", () => {
    it("renders all 11 themes from catalog with names, badges, and swatches", () => {
      render(<AppearanceSettingsPane />);

      const themes = getAllTerminalThemes();
      expect(themes.length).toBe(11);

      for (const theme of themes) {
        expect(screen.getByText(theme.name)).toBeInTheDocument();
        const themeBtn = screen.getByRole("button", {
          name: new RegExp(`select ${theme.name} theme`, "i"),
        });
        expect(themeBtn).toBeInTheDocument();
      }
    });

    it("highlights the currently active theme with check icon and active class", () => {
      render(<AppearanceSettingsPane />);

      const oppaBtn = screen.getByRole("button", { name: /select oppa dark theme/i });
      expect(oppaBtn).toHaveClass("active");
      expect(oppaBtn).toHaveAttribute("aria-pressed", "true");
    });

    it("selects a theme when clicking a theme card and updates store and preview", () => {
      render(<AppearanceSettingsPane />);

      const tokyoNightBtn = screen.getByRole("button", { name: /select tokyo night theme/i });
      fireEvent.click(tokyoNightBtn);

      expect(useTerminalStore.getState().settings.appearance.themeName).toBe("tokyo_night");
      expect(tokyoNightBtn).toHaveClass("active");
      expect(tokyoNightBtn).toHaveAttribute("aria-pressed", "true");

      const draculaBtn = screen.getByRole("button", { name: /select dracula theme/i });
      fireEvent.click(draculaBtn);
      expect(useTerminalStore.getState().settings.appearance.themeName).toBe("dracula");
    });
  });

  describe("Typography & Layout Bento Card", () => {
    it("updates font family when selecting from preset dropdown", () => {
      render(<AppearanceSettingsPane />);

      const presetSelect = screen.getByRole("combobox", { name: /terminal font family preset/i });
      expect(presetSelect).toBeInTheDocument();

      fireEvent.change(presetSelect, { target: { value: "'JetBrains Mono', Consolas, monospace" } });
      expect(useTerminalStore.getState().settings.appearance.fontFamily).toBe(
        "'JetBrains Mono', Consolas, monospace"
      );
    });

    it("updates font family when typing into custom font family text input", () => {
      render(<AppearanceSettingsPane />);

      const fontInput = screen.getByRole("textbox", { name: /custom terminal font family/i });
      expect(fontInput).toBeInTheDocument();

      fireEvent.change(fontInput, { target: { value: "Hack, monospace" } });
      expect(useTerminalStore.getState().settings.appearance.fontFamily).toBe("Hack, monospace");
    });

    it("adjusts font size using stepper buttons and clamps between 10 and 24", () => {
      render(<AppearanceSettingsPane />);

      const increaseBtn = screen.getByRole("button", { name: /increase font size/i });
      const decreaseBtn = screen.getByRole("button", { name: /decrease font size/i });

      // Default is 14
      expect(screen.getByText("14px")).toBeInTheDocument();

      // Increase to 15
      fireEvent.click(increaseBtn);
      expect(useTerminalStore.getState().settings.appearance.fontSize).toBe(15);
      expect(screen.getByText("15px")).toBeInTheDocument();

      // Decrease to 14
      fireEvent.click(decreaseBtn);
      expect(useTerminalStore.getState().settings.appearance.fontSize).toBe(14);
      expect(screen.getByText("14px")).toBeInTheDocument();

      // Set to max 24 and verify clamp
      useTerminalStore.getState().updateAppearanceSettings({ fontSize: 24 });
      render(<AppearanceSettingsPane />);
      const maxIncreaseBtn = screen.getAllByRole("button", { name: /increase font size/i })[0];
      fireEvent.click(maxIncreaseBtn);
      expect(useTerminalStore.getState().settings.appearance.fontSize).toBe(24);

      // Set to min 10 and verify clamp
      useTerminalStore.getState().updateAppearanceSettings({ fontSize: 10 });
      render(<AppearanceSettingsPane />);
      const minDecreaseBtn = screen.getAllByRole("button", { name: /decrease font size/i })[0];
      fireEvent.click(minDecreaseBtn);
      expect(useTerminalStore.getState().settings.appearance.fontSize).toBe(10);
    });

    it("adjusts font size using range slider", () => {
      render(<AppearanceSettingsPane />);

      const sizeSlider = screen.getByRole("slider", { name: /font size slider/i });
      expect(sizeSlider).toHaveValue("14");

      fireEvent.change(sizeSlider, { target: { value: "18" } });
      expect(useTerminalStore.getState().settings.appearance.fontSize).toBe(18);
    });

    it("adjusts line height using range slider and displays formatted value", () => {
      render(<AppearanceSettingsPane />);

      const lineHeightSlider = screen.getByRole("slider", { name: /line height slider/i });
      expect(lineHeightSlider).toHaveValue("1.2");
      expect(screen.getByText("1.20")).toBeInTheDocument();

      fireEvent.change(lineHeightSlider, { target: { value: "1.45" } });
      expect(useTerminalStore.getState().settings.appearance.lineHeight).toBe(1.45);
      expect(screen.getByText("1.45")).toBeInTheDocument();
    });
  });

  describe("Cursor & Window Bento Card", () => {
    it("updates cursor style via segmented control", () => {
      render(<AppearanceSettingsPane />);

      const blockBtn = screen.getByRole("button", { name: /^block/i });
      const beamBtn = screen.getByRole("button", { name: /^beam/i });
      const underlineBtn = screen.getByRole("button", { name: /^underline/i });

      expect(blockBtn).toHaveClass("active");
      expect(beamBtn).not.toHaveClass("active");
      expect(underlineBtn).not.toHaveClass("active");

      // Switch to Beam (bar)
      fireEvent.click(beamBtn);
      expect(useTerminalStore.getState().settings.appearance.cursorStyle).toBe("bar");
      expect(beamBtn).toHaveClass("active");

      // Switch to Underline
      fireEvent.click(underlineBtn);
      expect(useTerminalStore.getState().settings.appearance.cursorStyle).toBe("underline");
      expect(underlineBtn).toHaveClass("active");

      // Switch back to Block
      fireEvent.click(blockBtn);
      expect(useTerminalStore.getState().settings.appearance.cursorStyle).toBe("block");
      expect(blockBtn).toHaveClass("active");
    });

    it("toggles blinking cursor switch", () => {
      render(<AppearanceSettingsPane />);

      const blinkSwitch = screen.getByRole("switch", { name: /blinking cursor/i });
      expect(blinkSwitch).toBeChecked();

      fireEvent.click(blinkSwitch);
      expect(useTerminalStore.getState().settings.appearance.cursorBlink).toBe(false);

      fireEvent.click(blinkSwitch);
      expect(useTerminalStore.getState().settings.appearance.cursorBlink).toBe(true);
    });

    it("toggles dim inactive panes switch", () => {
      render(<AppearanceSettingsPane />);

      const dimSwitch = screen.getByRole("switch", { name: /dim inactive panes/i });
      expect(dimSwitch).toBeChecked();

      fireEvent.click(dimSwitch);
      expect(useTerminalStore.getState().settings.appearance.dimInactivePanes).toBe(false);

      fireEvent.click(dimSwitch);
      expect(useTerminalStore.getState().settings.appearance.dimInactivePanes).toBe(true);
    });
  });
});
