import { describe, expect, it, vi } from "vitest";
import { DesktopAccountSecretStore } from "./desktop-account-secrets";

function harness(available = true, backend = "gnome_libsecret") {
  let contents = "";
  const files = {
    read: vi.fn(async () => contents),
    write: vi.fn(async (next: string) => {
      contents = next;
    }),
  };
  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => available),
    getSelectedStorageBackend: () => backend,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) =>
      value.toString().replace(/^encrypted:/, ""),
  };
  return { files, safeStorage, contents: () => contents };
}

describe("desktop account credentials", () => {
  it("persists encrypted credentials across restarts and removes signed-out accounts", async () => {
    const h = harness();
    const store = new DesktopAccountSecretStore(h.files, h.safeStorage);
    await store.set("clerk", "client-token-secret");
    expect(h.contents()).not.toContain("client-token-secret");
    const restored = new DesktopAccountSecretStore(h.files, h.safeStorage);
    expect(await restored.get("clerk")).toBe("client-token-secret");
    await restored.delete("clerk");
    expect(
      await new DesktopAccountSecretStore(h.files, h.safeStorage).get("clerk"),
    ).toBeNull();
  });

  it.each([
    [false, "unknown"],
    [true, "basic_text"],
  ])(
    "uses only memory when secure encryption is unavailable (%s, %s)",
    async (available, backend) => {
      const h = harness(available, backend);
      const store = new DesktopAccountSecretStore(h.files, h.safeStorage);
      await store.set("clerk", "client-token-secret");
      expect(await store.get("clerk")).toBe("client-token-secret");
      expect(h.files.write).not.toHaveBeenCalled();
      expect(h.files.read).not.toHaveBeenCalled();
      expect(
        await new DesktopAccountSecretStore(h.files, h.safeStorage).get(
          "clerk",
        ),
      ).toBeNull();
      await store.delete("clerk");
      expect(await store.get("clerk")).toBeNull();
    },
  );

  it("never downgrades an encrypted store when the OS key becomes unavailable", async () => {
    const h = harness();
    const store = new DesktopAccountSecretStore(h.files, h.safeStorage);
    await store.set("clerk", "old-token");
    h.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    await expect(store.set("clerk", "new-token")).rejects.toThrow(
      "Account credentials are temporarily unavailable",
    );
    expect(h.files.write).toHaveBeenCalledTimes(1);
    h.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    expect(await store.get("clerk")).toBe("old-token");
  });

  it("does not resurrect an older encrypted sign-in after signing out from memory fallback", async () => {
    const h = harness();
    await new DesktopAccountSecretStore(h.files, h.safeStorage).set(
      "clerk",
      "old-token",
    );
    h.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const memory = new DesktopAccountSecretStore(h.files, h.safeStorage);
    await memory.set("clerk", "new-token");
    await memory.delete("clerk");
    h.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    expect(
      await new DesktopAccountSecretStore(h.files, h.safeStorage).get("clerk"),
    ).toBeNull();
  });
});
