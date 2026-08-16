import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElectronSecretStore } from "./electron-secret-store";
import { createSecretStore } from "./create-secret-store";
import { MemorySecretStore, UnavailableSecretStore } from "./secret-store";
import { CapacitorSecretStore } from "./capacitor-secret-store";

describe("SecretStore", () => {
  beforeEach(() => {
    delete (globalThis as { babylonslate?: unknown }).babylonslate;
  });

  it("round-trips values in memory", async () => {
    const store = new MemorySecretStore();
    expect(store.available).toBe(true);
    expect(await store.get("source-control:proj")).toBeNull();
    await store.set("source-control:proj", "ghp_secret");
    expect(await store.get("source-control:proj")).toBe("ghp_secret");
    await store.delete("source-control:proj");
    expect(await store.get("source-control:proj")).toBeNull();
  });

  it("is unavailable on web", () => {
    const store = createSecretStore();
    expect(store).toBeInstanceOf(UnavailableSecretStore);
    expect(store.available).toBe(false);
  });

  it("uses the Electron secrets bridge when present", async () => {
    const values = new Map<string, string>();
    const bridge = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    };
    const store = new ElectronSecretStore(bridge);
    expect(store.available).toBe(true);
    await store.set("source-control:p", "tok");
    expect(await store.get("source-control:p")).toBe("tok");
    await store.delete("source-control:p");
    expect(await store.get("source-control:p")).toBeNull();
  });

  it("wraps the Capacitor Keychain plugin", async () => {
    const values = new Map<string, string>();
    const plugin = {
      get: vi.fn(async ({ key }: { key: string }) => ({
        value: values.get(key) ?? null,
      })),
      set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
        values.set(key, value);
      }),
      remove: vi.fn(async ({ key }: { key: string }) => {
        values.delete(key);
      }),
    };
    const store = new CapacitorSecretStore(plugin);
    await store.set("k", "v");
    expect(await store.get("k")).toBe("v");
    await store.delete("k");
    expect(await store.get("k")).toBeNull();
  });
});
