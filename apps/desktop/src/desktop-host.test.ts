import { describe, expect, it, vi } from "vitest";
import {
  DesktopSecretStore,
  SecretDecryptionUnavailableError,
  type SafeStorage,
  type SecretStoreFiles,
} from "./desktop-secret-store";

function createHarness(initial = ""): {
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
        if (!contents) throw new Error("missing file");
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
    },
    setEncryptionAvailable(value) {
      encryptionAvailable = value;
    },
    contents: () => contents,
  };
}

describe("desktop secret store", () => {
  it("decodes each record by its storage tag when capability changes", async () => {
    const harness = createHarness();
    const store = new DesktopSecretStore(harness.files, harness.safeStorage);

    harness.setEncryptionAvailable(false);
    await store.set("plain", "plain-token");
    harness.setEncryptionAvailable(true);
    expect(await store.get("plain")).toBe("plain-token");
    expect(harness.safeStorage.decryptString).not.toHaveBeenCalled();

    await store.set("encrypted", "encrypted-token");
    expect(await store.get("encrypted")).toBe("encrypted-token");
    expect(JSON.parse(harness.contents())).toEqual({
      version: 1,
      secrets: {
        plain: { storage: "plaintext", value: "plain-token" },
        encrypted: {
          storage: "safeStorage",
          ciphertext: Buffer.from("encrypted:encrypted-token").toString(
            "base64",
          ),
        },
      },
    });
  });

  it("rejects encrypted reads when decryption is temporarily unavailable", async () => {
    const harness = createHarness();
    const store = new DesktopSecretStore(harness.files, harness.safeStorage);
    await store.set("token", "credential");

    harness.setEncryptionAvailable(false);
    await expect(store.get("token")).rejects.toBeInstanceOf(
      SecretDecryptionUnavailableError,
    );
    expect(harness.safeStorage.decryptString).not.toHaveBeenCalled();
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
});
