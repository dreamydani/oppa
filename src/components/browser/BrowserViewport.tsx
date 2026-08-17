import { useEffect, useRef, type ReactElement } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import { BrowserOmnibox } from "./BrowserOmnibox";
import { DeviceToolbar, DEVICE_PRESETS } from "./DeviceToolbar";
import { BrowserHub } from "./BrowserHub";
import * as browserTransport from "../../lib/browser/transport";
import "./BrowserViewport.css";

export function BrowserViewport(): ReactElement {
  const browserUrl = useTerminalStore((s) => s.browserUrl);
  const devicePreset = useTerminalStore((s) => s.devicePreset);
  const containerRef = useRef<HTMLDivElement>(null);
  const webviewTargetRef = useRef<HTMLDivElement>(null);

  // Synchronize browser bounds for Tauri native webview / preview overlay
  useEffect(() => {
    const target = webviewTargetRef.current || containerRef.current;
    if (!target) return;

    const updateBounds = () => {
      const el = webviewTargetRef.current || containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      void browserTransport.browserSetBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };

    updateBounds();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const rect = entry.target.getBoundingClientRect();
          void browserTransport.browserSetBounds({
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
        }
      });

      observer.observe(target);
      return () => observer.disconnect();
    }
  }, [browserUrl, devicePreset]);

  const activePresetConfig = DEVICE_PRESETS.find((p) => p.id === devicePreset) ?? DEVICE_PRESETS[0];

  return (
    <div className="browser-viewport" ref={containerRef}>
      <BrowserOmnibox />
      <DeviceToolbar />

      <div className={`browser-content-container preset-${devicePreset}`}>
        {!browserUrl ? (
          <BrowserHub />
        ) : devicePreset === "responsive" ? (
          <div className="browser-responsive-wrapper" ref={webviewTargetRef}>
            <iframe
              src={browserUrl}
              title="Browser Preview"
              className="browser-iframe"
              allow="fullscreen; cross-origin-isolated; camera; microphone; geolocation"
            />
          </div>
        ) : (
          <div className="browser-device-stage">
            <div
              className="device-mockup-frame"
              style={{
                width: activePresetConfig.width,
              }}
            >
              <div className="device-mockup-header">
                <span className="device-title">{activePresetConfig.label}</span>
                <span className="device-dimensions">{activePresetConfig.dimensions}px</span>
              </div>
              <div
                className="device-mockup-body"
                ref={webviewTargetRef}
                style={{
                  width: activePresetConfig.width,
                  height: activePresetConfig.height,
                }}
              >
                <iframe
                  src={browserUrl}
                  title="Browser Preview"
                  className="browser-iframe"
                  allow="fullscreen; cross-origin-isolated; camera; microphone; geolocation"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
