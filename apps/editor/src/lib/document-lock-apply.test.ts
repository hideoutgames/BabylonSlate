import { describe, expect, it } from "vitest";
import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS } from "@babylonslate/core";
import { FakeLockProvider } from "@babylonslate/source-control";
import { MemorySecretStore } from "@babylonslate/vfs";
import { SourceControlService } from "../services/source-control-service";
import {
  afterMutatingApply,
  isMutatingApplyBlocked,
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
    fake.addTheirs("assets/hero.scene.babasset", "Bob");
    const service = await readyService(fake);
    await service.refresh();
    service.onOpenDocument("assets/hero.scene.babasset");
    expect(
      isMutatingApplyBlocked(service, "assets/hero.scene.babasset", false),
    ).toBe(true);
    service.setEditAnyway("assets/hero.scene.babasset");
    expect(
      isMutatingApplyBlocked(service, "assets/hero.scene.babasset", false),
    ).toBe(false);
  });

  it("blocks plugin-owned documents even when unlocked", async () => {
    const service = await readyService(new FakeLockProvider());
    expect(
      isMutatingApplyBlocked(service, "assets/a.babasset", true),
    ).toBe(true);
  });

  it("auto-locks after a successful apply", async () => {
    const fake = new FakeLockProvider();
    const service = await readyService(fake);
    await afterMutatingApply(service, "assets/main.scene.babasset");
    expect(service.lockStateForPath("assets/main.scene.babasset")).toBe("mine");
  });
});
