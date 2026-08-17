import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  readDir,
  readFile,
  writeFile,
  createFile,
  FileEntry,
} from "./transport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe("fs transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("readDir", () => {
    it("invokes fs_read_dir with path and returns entries", async () => {
      const mockEntries: FileEntry[] = [
        { name: "src", path: "/test/src", is_dir: true, size: 0 },
        { name: "index.ts", path: "/test/index.ts", is_dir: false, size: 100 },
      ];
      invokeMock.mockResolvedValue(mockEntries);

      const result = await readDir("/test");
      expect(invokeMock).toHaveBeenCalledWith("fs_read_dir", { path: "/test" });
      expect(result).toEqual(mockEntries);
    });

    it("safely catches errors and returns empty array on failure", async () => {
      invokeMock.mockRejectedValue(new Error("IPC not available"));
      const result = await readDir("/nonexistent");
      expect(result).toEqual([]);
    });
  });

  describe("readFile", () => {
    it("invokes fs_read_file with path and returns content", async () => {
      invokeMock.mockResolvedValue("hello world content");
      const content = await readFile("/test/file.txt");
      expect(invokeMock).toHaveBeenCalledWith("fs_read_file", { path: "/test/file.txt" });
      expect(content).toBe("hello world content");
    });

    it("safely catches errors and returns empty string on failure", async () => {
      invokeMock.mockRejectedValue(new Error("File not found"));
      const content = await readFile("/test/missing.txt");
      expect(content).toBe("");
    });
  });

  describe("writeFile", () => {
    it("invokes fs_write_file with path and content", async () => {
      invokeMock.mockResolvedValue(undefined);
      await writeFile("/test/file.txt", "updated text");
      expect(invokeMock).toHaveBeenCalledWith("fs_write_file", {
        path: "/test/file.txt",
        content: "updated text",
      });
    });

    it("safely catches errors on failure", async () => {
      invokeMock.mockRejectedValue(new Error("Disk error"));
      await expect(writeFile("/test/file.txt", "content")).resolves.toBeUndefined();
    });
  });

  describe("createFile", () => {
    it("invokes fs_create_file with path", async () => {
      invokeMock.mockResolvedValue(undefined);
      await createFile("/test/new_file.txt");
      expect(invokeMock).toHaveBeenCalledWith("fs_create_file", {
        path: "/test/new_file.txt",
      });
    });

    it("safely catches errors on failure", async () => {
      invokeMock.mockRejectedValue(new Error("Permission denied"));
      await expect(createFile("/test/new_file.txt")).resolves.toBeUndefined();
    });
  });
});
