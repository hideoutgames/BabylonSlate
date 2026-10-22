import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS } from "@haptic/core";
import { FakeLockProvider } from "@haptic/source-control";
import { MemorySecretStore } from "@haptic/vfs";
import { SourceControlService } from "../services/source-control-service";
import {
  afterMutatingApply,
  isMutatingApplyBlocked,
  requeueWithEditLock,
} from "./document-lock-apply";

const enabled = {
  ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS,
  enabled: true,
  repositoryUrl: "https://github.com/org/repo",
};

async function readyService(fake: FakeLockProvider): Promise<SourceControlService> {
  const service = new SourceControlService();
  await service.configure({
    settings: enabled,
    projectGuid: "proj",
    platform: "electron",
    testMode: true,
    secretStore: new MemorySecretStore(),
    nativeHttp: null,
    fake,
  });
  return service;
}

describe("document lock apply gate", () => {
  it("blocks apply when the document is theirs and not Edit Anyway", async () => {
    const fake = new FakeLockProvider({ selfName: "Ada" });
    fake.addTheirs("assets/hero.scene.hasset", "Bob");
    const service = await readyService(fake);
    await service.refresh();
    service.onOpenDocument("assets/hero.scene.hasset");
    expect(
      isMutatingApplyBlocked(service, "assets/hero.scene.hasset", false),
    ).toBe(true);
    service.setEditAnyway("assets/hero.scene.hasset");
    expect(
      isMutatingApplyBlocked(service, "assets/hero.scene.hasset", false),
    ).toBe(false);
  });

  it("blocks plugin-owned documents even when unlocked", async () => {
    const service = await readyService(new FakeLockProvider());
    expect(
      isMutatingApplyBlocked(service, "assets/a.hasset", true),
    ).toBe(true);
  });

  it("keeps a session authoring lock effective after choosing Edit Anyway", async () => {
    const fake = new FakeLockProvider({ selfName: "Ada" });
    const path = "assets/hero.scene.hasset";
    fake.addTheirs(path, "Bob");
    const service = await readyService(fake);
    await service.refresh();
    service.onOpenDocument(path);
    service.setEditAnyway(path);
    expect(isMutatingApplyBlocked(service, path, false, true)).toBe(true);
    expect(isMutatingApplyBlocked(service, path, false, false)).toBe(false);
  });

  it("auto-locks after a successful apply", async () => {
    const fake = new FakeLockProvider();
    const service = await readyService(fake);
    await afterMutatingApply(service, "assets/main.scene.hasset");
    expect(service.lockStateForPath("assets/main.scene.hasset")).toBe("mine");
  });

  it("locks a Texture when its re-encode is queued, not when the requeue is refused", async () => {
    const service = await readyService(new FakeLockProvider());
    expect(await requeueWithEditLock(service, "assets/refused.hasset", async () => false)).toBe(false);
    expect(await requeueWithEditLock(service, "assets/odd.hasset", async () => true)).toBe(true);
    await vi.waitFor(() => expect(service.lockStateForPath("assets/odd.hasset")).toBe("mine"));
    expect(service.lockStateForPath("assets/refused.hasset")).toBeNull();
  });
});
