import { describe, expect, it } from "vitest";
import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS } from "@babylonslate/core";
import { FakeLockProvider } from "@babylonslate/source-control";
import { MemorySecretStore } from "@babylonslate/vfs";
import {
  formatLockAge,
  SourceControlService,
} from "./source-control-service";

const enabled = {
  ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS,
  enabled: true,
  repositoryUrl: "https://github.com/org/repo",
};

describe("formatLockAge", () => {
  it("formats relative age in Title Case", () => {
    const now = Date.parse("2026-08-15T12:00:00Z");
    expect(formatLockAge("2026-08-15T12:00:00Z", now)).toBe("Just Now");
    expect(formatLockAge("2026-08-15T11:50:00Z", now)).toBe("10 Min Ago");
    expect(formatLockAge("2026-08-15T09:00:00Z", now)).toBe("3 Hr Ago");
    expect(formatLockAge("2026-08-14T12:00:00Z", now)).toBe("1 Day Ago");
  });
});

describe("SourceControlService", () => {
  it("does nothing when source control is disabled", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    await service.configure({
      settings: DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS,
      projectGuid: "proj",
      platform: "electron",
      testMode: true,
      secretStore: new MemorySecretStore(),
      nativeHttp: null,
      fake,
    });
    expect(service.enabled).toBe(false);
    expect(service.lockStateForPath("assets/a.babasset")).toBeNull();
    await service.autoLock("assets/a.babasset");
    expect(fake.snapshot()).toHaveLength(0);
  });

  it("auto-locks on first edit and skips a second attempt", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    await service.configure({
      settings: enabled,
      projectGuid: "proj",
      platform: "web",
      testMode: true,
      secretStore: new MemorySecretStore(),
      nativeHttp: null,
      fake,
    });
    await service.autoLock("assets/hero.scene.babasset");
    await service.autoLock("assets/hero.scene.babasset");
    expect(service.lockForPath("assets/hero.scene.babasset")?.ours).toBe(true);
    expect(fake.snapshot()).toHaveLength(1);
    expect(service.lockStateForPath("assets/hero.scene.babasset")).toBe("mine");
  });

  it("opens theirs read-only until Edit Anyway", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    fake.addTheirs("assets/hero.scene.babasset", "Bob");
    await service.configure({
      settings: enabled,
      projectGuid: "proj",
      platform: "electron",
      testMode: true,
      secretStore: new MemorySecretStore(),
      nativeHttp: null,
      fake,
    });
    await service.refresh();
    service.onOpenDocument("assets/hero.scene.babasset");
    expect(service.isDocumentReadOnly("assets/hero.scene.babasset")).toBe(true);
    expect(service.bannerFor("assets/hero.scene.babasset")?.kind).toBe("theirs");
    service.setEditAnyway("assets/hero.scene.babasset");
    expect(service.isDocumentReadOnly("assets/hero.scene.babasset")).toBe(false);
  });

  it("never blocks an edit when create conflicts or is offline", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    fake.addTheirs("assets/a.babasset", "Bob");
    await service.configure({
      settings: enabled,
      projectGuid: "proj",
      platform: "electron",
      testMode: true,
      secretStore: new MemorySecretStore(),
      nativeHttp: null,
      fake,
    });
    await service.autoLock("assets/a.babasset");
    expect(service.isDocumentReadOnly("assets/a.babasset")).toBe(false);
    expect(service.bannerFor("assets/a.babasset")?.kind).toBe("unlocked");
  });

  it("refuses moving someone else's lock and transfers ours", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    fake.addTheirs("assets/theirs.babasset", "Bob");
    await service.configure({
      settings: enabled,
      projectGuid: "proj",
      platform: "electron",
      testMode: true,
      secretStore: new MemorySecretStore(),
      nativeHttp: null,
      fake,
    });
    await service.refresh();
    expect(service.refuseIfTheirs("assets/theirs.babasset")).toMatch(/Bob/);
    await service.autoLock("assets/mine.babasset");
    await service.transferLock(
      "assets/mine.babasset",
      "assets/renamed.babasset",
    );
    expect(service.lockForPath("assets/mine.babasset")).toBeUndefined();
    expect(service.lockForPath("assets/renamed.babasset")?.ours).toBe(true);
  });

  it("stores the token outside project settings", async () => {
    const service = new SourceControlService();
    const secrets = new MemorySecretStore();
    await service.configure({
      settings: enabled,
      projectGuid: "proj-1",
      platform: "electron",
      testMode: true,
      secretStore: secrets,
      nativeHttp: null,
      fake: new FakeLockProvider(),
    });
    await service.saveToken("ghp_secret");
    expect(service.hasToken).toBe(true);
    expect(await secrets.get("source-control:proj-1")).toBe("ghp_secret");
    await service.clearToken();
    expect(service.hasToken).toBe(false);
    expect(await secrets.get("source-control:proj-1")).toBeNull();
  });

  it("keeps held locks when only auto-lock settings change", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    const secrets = new MemorySecretStore();
    await service.configure({
      settings: enabled,
      projectGuid: "proj",
      platform: "electron",
      testMode: true,
      secretStore: secrets,
      nativeHttp: null,
      fake,
    });
    await service.autoLock("assets/a.babasset");
    await service.configure({
      settings: { ...enabled, autoLockOnEdit: false },
      projectGuid: "proj",
      platform: "electron",
      testMode: true,
      secretStore: secrets,
      nativeHttp: null,
      fake,
    });
    expect(service.lockForPath("assets/a.babasset")?.ours).toBe(true);
    expect(service.autoLockOnEdit).toBe(false);
  });

  it("skips create when verify already holds the path as ours", async () => {
    const fake = new FakeLockProvider({ selfName: "Ada" });
    const first = new SourceControlService();
    await first.configure({
      settings: enabled,
      projectGuid: "proj",
      platform: "electron",
      testMode: true,
      secretStore: new MemorySecretStore(),
      nativeHttp: null,
      fake,
    });
    await first.autoLock("assets/a.babasset");
    fake.createCount = 0;

    const second = new SourceControlService();
    await second.configure({
      settings: enabled,
      projectGuid: "proj",
      platform: "electron",
      testMode: true,
      secretStore: new MemorySecretStore(),
      nativeHttp: null,
      fake,
    });
    await second.refresh();
    await second.autoLock("assets/a.babasset");
    expect(fake.createCount).toBe(0);
    expect(second.lockForPath("assets/a.babasset")?.ours).toBe(true);
    expect(second.bannerFor("assets/a.babasset")).toBeNull();
  });

  it("releases our lock for a deleted path and keeps theirs", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    fake.addTheirs("assets/theirs.babasset", "Bob");
    await service.configure({
      settings: enabled,
      projectGuid: "proj",
      platform: "electron",
      testMode: true,
      secretStore: new MemorySecretStore(),
      nativeHttp: null,
      fake,
    });
    await service.autoLock("assets/mine.babasset");
    await service.refresh();
    await service.releasePath("assets/mine.babasset");
    await service.releasePath("assets/theirs.babasset");
    expect(service.lockForPath("assets/mine.babasset")).toBeUndefined();
    expect(service.lockForPath("assets/theirs.babasset")?.ours).toBe(false);
  });

  it("releases all of our locks", async () => {
    const service = new SourceControlService();
    const fake = new FakeLockProvider();
    await service.configure({
      settings: enabled,
      projectGuid: "proj",
      platform: "electron",
      testMode: true,
      secretStore: new MemorySecretStore(),
      nativeHttp: null,
      fake,
    });
    await service.autoLock("assets/a.babasset");
    await service.autoLock("assets/b.babasset");
    expect(service.heldCount).toBe(2);
    await service.releaseAllMine();
    expect(service.heldCount).toBe(0);
    expect(fake.snapshot()).toHaveLength(0);
  });
});
