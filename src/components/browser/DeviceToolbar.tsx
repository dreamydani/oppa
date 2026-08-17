import type { ReactElement } from "react";
import { useTerminalStore, type DevicePreset } from "../../store/terminalStore";

interface DevicePresetConfig {
  id: DevicePreset;
  label: string;
  dimensions: string;
  width?: number;
  height?: number;
}

export const DEVICE_PRESETS: DevicePresetConfig[] = [
  {
    id: "responsive",
    label: "Responsive",
    dimensions: "100%",
  },
  {
    id: "iphone",
    label: "iPhone 15 Pro",
    dimensions: "393 × 852",
    width: 393,
    height: 852,
  },
  {
    id: "ipad",
    label: "iPad Air",
    dimensions: "820 × 1180",
    width: 820,
    height: 1180,
  },
  {
    id: "desktop",
    label: "Desktop",
    dimensions: "1280 × 800",
    width: 1280,
    height: 800,
  },
];

export function DeviceToolbar(): ReactElement {
  const devicePreset = useTerminalStore((s) => s.devicePreset);
  const setDevicePreset = useTerminalStore((s) => s.setDevicePreset);

  return (
    <div className="device-toolbar">
      <div className="device-presets-group" role="radiogroup" aria-label="Device view presets">
        {DEVICE_PRESETS.map((preset) => {
          const isActive = devicePreset === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              className={`device-preset-btn ${isActive ? "active" : ""}`}
              aria-pressed={isActive}
              onClick={() => setDevicePreset(preset.id)}
              title={`${preset.label} (${preset.dimensions})`}
            >
              <span className="preset-label">{preset.label}</span>
              <span className="preset-dimension-tag">{preset.dimensions}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
