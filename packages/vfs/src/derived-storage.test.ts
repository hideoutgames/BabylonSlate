import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ platform: "ios" as "ios" | "android" }));

vi.mock("@capacitor/core", async (original) => ({
  ...await original<typeof import("@capacitor/core")>(),
  Capacitor: { getPlatform: () => host.platform, isNativePlatform: () => true },
}));
vi.mock("@capacitor/filesystem", async () => {
  const { createFakeDocumentsFs } = await import("./test-support/fake-documents-fs");
  const fake = createFakeDocumentsFs();
  const Filesystem = { ...fake, mkdir: vi.fn((options: Parameters<typeof fake.mkdir>[0]) => fake.mkdir(options)) };
  return { Directory: { Documents: "DOCUMENTS", Data: "DATA", Library: "LIBRARY" }, Filesystem };
});
vi.mock("./capacitor-scoped-storage", async (original) => ({
  ...await original<typeof import("./capacitor-scoped-storage")>(),
  BabylonSlateScopedStorage: { readDocumentsRange: vi.fn() },
}));

const { Filesystem } = await import("@capacitor/filesystem");
const { createDerivedStorage } = await import("./derived-storage");
const { createTemplateStorage } = await import("./template-storage");

describe("mobile derived data", () => {
  beforeEach(() => {
    vi.mocked(Filesystem.mkdir).mockClear();
  });

  it.each([
    ["ios", "Application Support/Haptic/__haptic_derived__"],
    ["android", "Haptic/__haptic_derived__"],
  ] as const)("lives in the app's Library location on %s, not beside projects", async (platform, path) => {
    host.platform = platform;
    await createDerivedStorage();
    expect(Filesystem.mkdir).toHaveBeenCalledWith({ path, directory: "LIBRARY", recursive: true });
  });

  it("leaves user libraries in the projects tier", async () => {
    host.platform = "ios";
    await createTemplateStorage("__haptic_templates__");
    expect(Filesystem.mkdir).toHaveBeenCalledWith({ path: "BabylonSlate/projects/__haptic_templates__", directory: "DOCUMENTS", recursive: true });
  });
});
