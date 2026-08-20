import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "./memory-adapter";
import { createReadOnlyProjectStorage } from "./read-only-storage";

describe("createReadOnlyProjectStorage", () => {
  it("allows reads and throws on writes", async () => {
    const inner = new MemoryStorageAdapter("opfs");
    await inner.openDocumentsProject("engine-plugins");
    await inner.writeText("starter/note.txt", "ok");
    const storage = createReadOnlyProjectStorage(inner);

    expect(await storage.readText("starter/note.txt")).toBe("ok");
    expect(await storage.exists("starter/note.txt")).toBe(true);
    await expect(storage.writeText("starter/note.txt", "no")).rejects.toThrow(
      /read-only/i,
    );
    await expect(
      storage.writeBinary("starter/note.bin", new Uint8Array([1])),
    ).rejects.toThrow(/read-only/i);
    await expect(storage.mkdir("starter/extra", true)).rejects.toThrow(
      /read-only/i,
    );
    await expect(storage.remove("starter/note.txt")).rejects.toThrow(
      /read-only/i,
    );
    await expect(storage.deleteProject!(inner.getCurrentFolder()!)).rejects.toThrow(
      /read-only/i,
    );
    expect(await storage.readText("starter/note.txt")).toBe("ok");
  });
});
