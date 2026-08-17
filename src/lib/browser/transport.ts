import { invoke } from "@tauri-apps/api/core";

// Type alias so it satisfies InvokeArgs' index signature.
export type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export async function browserOpen(url: string, bounds: BrowserBounds): Promise<void> {
  try {
    await invoke("browser_open", { url, ...bounds });
  } catch {
    // Non-Tauri fallback
  }
}

export async function browserNavigate(url: string): Promise<void> {
  try {
    await invoke("browser_navigate", { url });
  } catch {}
}

export async function browserSetBounds(bounds: BrowserBounds): Promise<void> {
  try {
    await invoke("browser_set_bounds", { ...bounds });
  } catch {}
}

export async function browserHide(): Promise<void> {
  try {
    await invoke("browser_hide");
  } catch {}
}

export async function browserShow(): Promise<void> {
  try {
    await invoke("browser_show");
  } catch {}
}

export async function browserGoBack(): Promise<void> {
  try {
    await invoke("browser_go_back");
  } catch {}
}

export async function browserGoForward(): Promise<void> {
  try {
    await invoke("browser_go_forward");
  } catch {}
}

export async function browserReload(): Promise<void> {
  try {
    await invoke("browser_reload");
  } catch {}
}

export async function browserOpenDevTools(): Promise<void> {
  try {
    await invoke("browser_open_devtools");
  } catch {}
}
