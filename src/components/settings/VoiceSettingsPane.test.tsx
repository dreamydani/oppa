import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VoiceSettingsPane, STUB_VOICE_CATALOG } from "./VoiceSettingsPane";
import { useTerminalStore } from "../../store/terminalStore";
import { DEFAULT_APP_SETTINGS } from "../../lib/settings/types";

describe("VoiceSettingsPane", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      settings: JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)),
      isSettingsOpen: true,
      activeSettingsTab: "voice",
    });
  });

  it("renders dictation, microphone, model, and OpenAI sections", () => {
    render(<VoiceSettingsPane />);

    expect(screen.getByRole("heading", { name: /^voice$/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /voice dictation/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^microphone$/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /speech model/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /openai transcription/i, level: 3 })).toBeInTheDocument();
  });

  it("lists all stub catalog models with badges", () => {
    render(<VoiceSettingsPane />);

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(STUB_VOICE_CATALOG.length);
    expect(screen.getByRole("radio", { name: /parakeet tdt v3/i })).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.getAllByText("Streaming").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Offline").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not downloaded")).toHaveLength(STUB_VOICE_CATALOG.length);
  });

  it("toggles dictation enabled and gates mic/mode controls", () => {
    render(<VoiceSettingsPane />);

    const toggle = screen.getByRole("switch", { name: /enable voice dictation/i });
    const micSelect = screen.getByLabelText("Input device");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(micSelect).toBeDisabled();

    fireEvent.click(toggle);
    expect(useTerminalStore.getState().settings.voice.enabled).toBe(true);
    expect(screen.getByRole("switch", { name: /enable voice dictation/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByLabelText("Input device")).not.toBeDisabled();

    // Sibling settings untouched by the toggle.
    expect(useTerminalStore.getState().settings.general.defaultCwdMode).toBe("home");
  });

  it("switches dictation mode and persists the choice", () => {
    useTerminalStore.setState({
      settings: {
        ...JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)),
        voice: { ...DEFAULT_APP_SETTINGS.voice, enabled: true },
      },
    });
    render(<VoiceSettingsPane />);

    const holdBtn = screen.getByRole("button", { name: /^hold$/i });
    fireEvent.click(holdBtn);
    expect(useTerminalStore.getState().settings.voice.dictationMode).toBe("hold");

    fireEvent.click(screen.getByRole("button", { name: /^toggle$/i }));
    expect(useTerminalStore.getState().settings.voice.dictationMode).toBe("toggle");
  });

  it("selects a model and persists sttModel", () => {
    render(<VoiceSettingsPane />);

    fireEvent.click(screen.getByRole("radio", { name: /parakeet tdt v3/i }));
    const state = useTerminalStore.getState();
    expect(state.settings.voice.sttModel).toBe("parakeet-tdt-0.6b-v3-int8");
    expect(screen.getByRole("radio", { name: /parakeet tdt v3/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("keeps System default mic and resets device id/label", () => {
    useTerminalStore.setState({
      settings: {
        ...JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)),
        voice: {
          ...DEFAULT_APP_SETTINGS.voice,
          enabled: true,
          microphoneDeviceId: "mic-1",
          microphoneDeviceLabel: "USB Mic",
        },
      },
    });
    render(<VoiceSettingsPane />);

    const micSelect = screen.getByLabelText("Input device") as HTMLSelectElement;
    fireEvent.change(micSelect, { target: { value: "" } });
    const voice = useTerminalStore.getState().settings.voice;
    expect(voice.microphoneDeviceId).toBeNull();
    expect(voice.microphoneDeviceLabel).toBeNull();
  });

  it("shows the OpenAI row as not configured with a disabled Configure button", () => {
    render(<VoiceSettingsPane />);

    expect(screen.getByText(/no openai api key configured/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /configure/i })).toBeDisabled();
  });
});
