import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS } from "@babylonslate/core";
import { FakeLockProvider } from "@babylonslate/source-control";
import { MemorySecretStore } from "@babylonslate/vfs";
import { SourceControlService } from "../services/source-control-service";
import { createTextureAlignmentGuard } from "./texture-alignment-guard";

const enabled = {
  ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS,
  enabled: true,
  repositoryUrl: "https://github.com/org/repo",
};

const PATHS: Record<string, string> = {
  theirs: "assets/theirs.babasset",
  mine: "assets/mine.babasset",
  free: "assets/free.babasset",
  plugin: "assets/plugin.babasset",
};

/** A fake whose first lock refresh waits until `release()`. */
function gatedFake(): { fake: FakeLockProvider; release: () => void } {
  const fake = new FakeLockProvider({ selfName: "Ada" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const verify = fake.verify.bind(fake);
  vi.spyOn(fake, "verify").mockImplementationOnce(async () => {
    await gate;
    return verify();
  });
  return { fake, release };
}

describe("texture alignment write guard", () => {
  it("never rewrites a Texture another user has locked, even in a tab opened before the locks were known", async () => {
    const sourceControl = new SourceControlService();
    const config = {
      settings: enabled,
      projectGuid: "proj",
      platform: "electron",
      testMode: true,
      secretStore: new MemorySecretStore(),
      nativeHttp: null,
    };
    const first = gatedFake();
    first.fake.addTheirs(PATHS.theirs!, "Bob");
    await first.fake.create(PATHS.mine!);
    try {
      await sourceControl.configure({ ...config, fake: first.fake });
      sourceControl.pausePolling();
      // A tab opened (or restored) before the first lock refresh never becomes read-only.
      sourceControl.onOpenDocument(PATHS.theirs!);
      const { canWrite } = createTextureAlignmentGuard({
        sourceControl,
        projectGuid: "proj",
        pathFor: (guid) => PATHS[guid],
        // The editor's user-facing rule: an open tab is blocked only in read-only mode.
        blockedReason: (guid) =>
          guid === "plugin" ? "The Texture is read-only."
          : sourceControl.isDocumentReadOnly(PATHS[guid]!) ? "The Texture is locked."
          : null,
      });
      const writable = () => Object.keys(PATHS).filter((guid) => canWrite(guid));

      // Nothing is written while the locks are unknown.
      expect(writable()).toEqual([]);
      first.release();
      await vi.waitFor(() => expect(sourceControl.lockStateForPath(PATHS.theirs!)).toBe("theirs"));
      expect(sourceControl.isDocumentReadOnly(PATHS.theirs!)).toBe(false);
      expect(writable()).toEqual(["mine", "free"]);

      // Asked per Texture: another repository's locks are unknown until it refreshes.
      const other = gatedFake();
      await sourceControl.configure({
        ...config,
        settings: { ...enabled, repositoryUrl: "https://github.com/org/other" },
        fake: other.fake,
      });
      expect(writable()).toEqual([]);
      other.release();
      await vi.waitFor(() => expect(writable()).toEqual(["theirs", "mine", "free"]));
    } finally {
      sourceControl.dispose();
    }
  });

  it("takes a Texture's lock before the pass rewrites it, without an edit's banner, and not one a teammate took since", async () => {
    const sourceControl = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    const config = {
      settings: enabled,
      projectGuid: "proj",
      platform: "electron",
      testMode: true,
      secretStore: new MemorySecretStore(),
      nativeHttp: null,
      fake,
    };
    try {
      await sourceControl.configure(config);
      sourceControl.pausePolling();
      await sourceControl.refresh();
      const guard = createTextureAlignmentGuard({
        sourceControl,
        projectGuid: "proj",
        pathFor: (guid) => PATHS[guid],
        blockedReason: () => null,
      });
      // A teammate locks it after the last refresh.
      fake.addTheirs(PATHS.theirs!, "Bob");

      expect(await guard.claim!("free")).toBe(true);
      expect(fake.snapshot()).toContainEqual(expect.objectContaining({ path: PATHS.free, ours: true }));
      expect(sourceControl.bannerFor(PATHS.free!)).toBeNull();
      expect(await guard.claim!("theirs")).toBe(false);
      expect(guard.canWrite("theirs")).toBe(false);
      expect(sourceControl.bannerFor(PATHS.theirs!)).toBeNull();

      // With auto-lock off, rewrites take no lock, as edits take none.
      await sourceControl.configure({ ...config, settings: { ...enabled, autoLockOnEdit: false } });
      expect(await guard.claim!("mine")).toBe(true);
      expect(fake.snapshot().map((lock) => lock.path)).not.toContain(PATHS.mine);
    } finally {
      sourceControl.dispose();
    }
  });
});
