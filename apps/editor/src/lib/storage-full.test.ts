import { describe, expect, it } from "vitest";
import { isStorageFull, storageFullError } from "./storage-full";

describe("isStorageFull", () => {
  it.each([
    ["a browser quota", new DOMException("The quota has been exceeded.", "QuotaExceededError"), true],
    ["a Node or Electron ENOSPC", Object.assign(new Error("write failed"), { code: "ENOSPC" }), true],
    ["an Electron IPC failure naming ENOSPC", new Error("Error invoking remote method 'project:writeBinary': Error: ENOSPC: no space left on device, write"), true],
    ["an Android IOException", new Error("ENOSPC (No space left on device)"), true],
    ["an iOS Foundation write", new Error("The file “a.hasset” couldn’t be saved because there isn’t enough space."), true],
    ["a wrapped quota", new Error("Save failed", { cause: new DOMException("", "QuotaExceededError") }), true],
    ["a missing file", Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }), false],
    ["a permission failure", new DOMException("Not allowed", "NotAllowedError"), false],
    ["a non-error", "full", false],
  ])("classifies %s", (_name, error, full) => {
    expect(isStorageFull(error)).toBe(full);
  });

  it("names the condition and keeps the original failure as its cause", () => {
    const cause = new DOMException("", "QuotaExceededError");
    const error = storageFullError(cause)!;
    expect(error.message).toMatch(/not enough storage space/i);
    expect(error.cause).toBe(cause);
    expect(storageFullError(new Error("Storage unavailable"))).toBeNull();
  });
});
