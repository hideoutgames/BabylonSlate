import { describe, expect, it, vi } from "vitest";
import {
  DesktopSecretStore,
  SecretDecryptionUnavailableError,
  type SafeStorage,
  type SecretStoreFiles,
} from "./desktop-secret-store";

function createHarness(initial = "", backend?: string): {
  files: SecretStoreFiles;
  safeStorage: SafeStorage;
  setEncryptionAvailable(value: boolean): void;
  contents(): string;
} {
  let contents = initial;
  let encryptionAvailable = true;
  return {
    files: {
      read: vi.fn(async () => {
        await Promise.resolve();
        if (!contents) throw Object.assign(new Error("missing file"), { code: "ENOENT" });
        return contents;
      }),
      write: vi.fn(async (next) => {
        await Promise.resolve();
        contents = next;
      }),
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => encryptionAvailable),
      encryptString: vi.fn((value) => Buffer.from(`encrypted:${value}`)),
      decryptString: vi.fn((value) =>
        value.toString().replace(/^encrypted:/, ""),
      ),
      ...(backend ? { getSelectedStorageBackend: () => backend } : {}),
    },
    setEncryptionAvailable(value) {
      encryptionAvailable = value;
    },
    contents: () => contents,
  };
}

const ciphertext = (value: string) => Buffer.from(`encrypted:${value}`).toString("base64");

describe("desktop secret store", () => {
  it("stores only safeStorage ciphertext", async () => {
    const harness = createHarness("", "gnome_libsecret");
    const store = new DesktopSecretStore(harness.files, harness.safeStorage);
    expect(store.persistent).toBe(true);
    await store.set("token", "credential");
    expect(await store.get("token")).toBe("credential");
    expect(JSON.parse(harness.contents())).toEqual({ version: 1, secrets: { token: ciphertext("credential") } });
    expect(harness.contents()).not.toContain("credential\"");
  });

  it("keeps secrets in memory and writes nothing without secure OS encryption", async () => {
    for (const harness of [createHarness("", "basic_text"), createHarness("", "unknown"), (() => {
      const unavailable = createHarness();
      unavailable.setEncryptionAvailable(false);
      return unavailable;
    })()]) {
      const store = new DesktopSecretStore(harness.files, harness.safeStorage);
      expect(store.persistent).toBe(false);
      await store.set("token", "credential");
      expect(await store.get("token")).toBe("credential");
      await store.delete("token");
      expect(await store.get("token")).toBeNull();
      expect(harness.files.write).not.toHaveBeenCalled();
      expect(harness.safeStorage.encryptString).not.toHaveBeenCalled();
    }
  });

  it("never reads a plaintext record back as a secret, and drops it on the next write", async () => {
    const harness = createHarness(JSON.stringify({ version: 1, secrets: {
      old: { storage: "plaintext", value: "leaked-token" },
      tagged: { storage: "safeStorage", ciphertext: ciphertext("tagged") },
    } }));
    const store = new DesktopSecretStore(harness.files, harness.safeStorage);
    expect(await store.get("old")).toBeNull();
    expect(await store.get("tagged")).toBeNull();
    await store.set("token", "new");
    expect(JSON.parse(harness.contents())).toEqual({ version: 1, secrets: { token: ciphertext("new") } });
    expect(harness.contents()).not.toContain("leaked-token");
  });

  it("rejects encrypted reads when decryption is temporarily unavailable", async () => {
    const harness = createHarness();
    const store = new DesktopSecretStore(harness.files, harness.safeStorage);
    await store.set("token", "credential");

    harness.setEncryptionAvailable(false);
    await expect(store.get("token")).rejects.toBeInstanceOf(
      SecretDecryptionUnavailableError,
    );
    await expect(store.set("token", "other")).rejects.toBeInstanceOf(SecretDecryptionUnavailableError);
    expect(harness.safeStorage.decryptString).not.toHaveBeenCalled();
    expect(JSON.parse(harness.contents()).secrets.token).toBe(ciphertext("credential"));
  });

  it("serializes concurrent sets and deletes without losing updates", async () => {
    const harness = createHarness();
    const store = new DesktopSecretStore(harness.files, harness.safeStorage);
    await store.set("remove", "old");

    await Promise.all([
      store.set("first", "one"),
      store.set("second", "two"),
      store.delete("remove"),
    ]);

    expect(await store.get("first")).toBe("one");
    expect(await store.get("second")).toBe("two");
    expect(await store.get("remove")).toBeNull();
  });

  it("keeps every stored secret when the file cannot be read", async () => {
    const harness = createHarness();
    const store = new DesktopSecretStore(harness.files, harness.safeStorage);
    await store.set("first", "one");
    vi.mocked(harness.files.read).mockRejectedValueOnce(
      Object.assign(new Error("busy"), { code: "EBUSY" }),
    );

    await expect(store.set("second", "two")).rejects.toThrow("busy");
    expect(await store.get("first")).toBe("one");
    expect(await store.get("second")).toBeNull();
  });
});
