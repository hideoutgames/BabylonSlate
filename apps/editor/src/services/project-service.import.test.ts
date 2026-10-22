import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { ProjectService } from "./project-service";

const picker = vi.hoisted(() => ({ files: [] as Array<{ name: string; bytes: Uint8Array }> }));
vi.mock("@haptic/vfs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@haptic/vfs")>()),
  pickImportFiles: async () => picker.files,
}));

describe("ProjectService web import", () => {
  it("removes the folder of a failed import, so the next import keeps the name", async () => {
    const storage = new MemoryStorageAdapter("documents");
    const service = new ProjectService(storage);
    const encode = (text: string) => new TextEncoder().encode(text);
    picker.files = [
      { name: "Imported/project.json", bytes: encode(JSON.stringify({ metadata: { name: "Imported" } })) },
      { name: "Imported/assets/notes.txt", bytes: encode("notes") },
    ];
    const write = storage.writeBinary.bind(storage);
    const failing = vi.spyOn(storage, "writeBinary").mockImplementation(async (path, bytes) => {
      if (path === "assets/notes.txt") throw new Error("Disk full");
      return write(path, bytes);
    });
    await expect(service.openProject("folder")).rejects.toThrow("Disk full");
    expect(await service.listProjects()).toEqual([]);

    failing.mockRestore();
    await service.openProject("folder");
    expect(storage.getCurrentFolder()?.name).toBe("Imported");
    expect(await storage.readText("assets/notes.txt")).toBe("notes");
  });
});
