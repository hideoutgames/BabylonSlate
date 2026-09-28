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
      const canWrite = createTextureAlignmentGuard({
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
});
