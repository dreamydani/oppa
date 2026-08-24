import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FileContextMenu, FileContextMenuState } from "./FileContextMenu";
import type { FileEntry } from "../../lib/fs/transport";

const fileEntry: FileEntry = {
  name: "app.ts",
  path: "/mock/workspace/app.ts",
  is_dir: false,
  size: 10,
};

function renderMenu(state: FileContextMenuState | null): HTMLElement {
  return render(
    <FileContextMenu
      state={state}
      rootPath="/mock/workspace"
      editors={[{ name: "VS Code", command: "code" }]}
      onClose={() => {}}
      onNewFile={() => {}}
      onNewFolder={() => {}}
      onOpenInEditor={() => {}}
      onOpenWith={() => {}}
      onCopyPath={() => {}}
    />,
  ).container;
}

// Captured before any spying so stacked stubs can fall back without recursion
const nativeGetRect = Element.prototype.getBoundingClientRect;

function stubRect(selector: string, width: number, height: number): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    if (this.classList.contains(selector.replace(/^\./, ""))) {
      return {
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return nativeGetRect.call(this);
  });
}

describe("FileContextMenu bounds positioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.innerWidth = 1200;
    window.innerHeight = 800;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("positions the menu inside the window on a right-edge click", async () => {
    stubRect(".file-context-menu", 210, 120);
    renderMenu({ x: 1150, y: 200, entry: fileEntry });

    await waitFor(() => {
      const menu = document.querySelector(".file-context-menu") as HTMLElement;
      expect(menu.style.visibility).toBe("visible");
      expect(Number(menu.style.left.replace("px", ""))).toBe(1200 - 210 - 8);
    });
  });

  it("measures the real menu instead of using hardcoded estimates", async () => {
    stubRect(".file-context-menu", 210, 300);
    // Click low on screen: with real 300px height the menu must flip up
    renderMenu({ x: 300, y: 700, entry: fileEntry });

    await waitFor(() => {
      const menu = document.querySelector(".file-context-menu") as HTMLElement;
      expect(Number(menu.style.top.replace("px", ""))).toBe(800 - 300 - 8);
    });
  });

  it("flips the submenu to the left when the menu sits at the right edge", async () => {
    stubRect(".file-context-menu", 210, 120);
    stubRect(".file-context-submenu", 170, 100);
    renderMenu({ x: 1000, y: 200, entry: fileEntry });

    fireEvent.click(screen.getByText("Open via"));

    await waitFor(() => {
      const submenu = document.querySelector(".file-context-submenu") as HTMLElement;
      expect(submenu.className).toContain("file-context-submenu--left");
    });
  });

  it("keeps the default right-side submenu class when there is room", async () => {
    stubRect(".file-context-menu", 210, 120);
    stubRect(".file-context-submenu", 170, 100);
    renderMenu({ x: 300, y: 200, entry: fileEntry });

    fireEvent.click(screen.getByText("Open via"));

    await waitFor(() => {
      const submenu = document.querySelector(".file-context-submenu") as HTMLElement;
      expect(submenu.className).not.toContain("file-context-submenu--left");
    });
  });

  it("closes on window resize", async () => {
    const onClose = vi.fn();
    render(
      <FileContextMenu
        state={{ x: 300, y: 200, entry: fileEntry }}
        rootPath="/mock/workspace"
        editors={[]}
        onClose={onClose}
        onNewFile={() => {}}
        onNewFolder={() => {}}
        onOpenInEditor={() => {}}
        onOpenWith={() => {}}
        onCopyPath={() => {}}
      />,
    );

    fireEvent.resize(window);
    expect(onClose).toHaveBeenCalled();
  });
});
