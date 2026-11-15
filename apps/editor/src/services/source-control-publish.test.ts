import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, type SourceControlMode, type SourceControlProjectSettings } from "@haptic/core";
import { GITATTRIBUTES_LFS_RULE, GITHUB_ORIGIN, SyncError, type SyncPort } from "@haptic/source-control";
import { FakeGitHost } from "@haptic/source-control/fake-host";
import { FakeRemote, FakeSync } from "@haptic/source-control/fake-sync";
import { hostApiFor } from "@haptic/source-control/host-api";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { TEST_GITHUB_CREDENTIAL } from "../testing/source-control-hosts";
import { publishToNewRepository, summarizeProject, writePublishFiles, type NewRepositoryRequest } from "./source-control-publish";
import { SourceControlSyncService, type SyncConfigureInput, type SyncPortFactory } from "./source-control-sync";

async function project() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Game");
  return storage;
}

describe("Publish files", () => {
  it("counts the assets and bytes the first push sends, and the share through Git LFS", async () => {
    const storage = await project();
    await storage.writeBinary("project.json", new Uint8Array(10));
    await storage.writeBinary("assets/Forest.scene.hasset", new Uint8Array(100));
    await storage.writeBinary("assets/Levels/Rock.texture.hasset", new Uint8Array(200));
    await storage.writeBinary(`assets/.blobs/${"a".repeat(64)}`, new Uint8Array(1000));
    // Left out: Git's own folder, one person's layout and storage's temporary files.
    await storage.writeBinary(".git/HEAD", new Uint8Array(5000));
    await storage.writeBinary("layout.json", new Uint8Array(5000));
    await storage.writeBinary("assets/.haptic-1234.tmp", new Uint8Array(5000));
    expect(await summarizeProject(storage)).toEqual({ assets: 2, bytes: 1310, lfsBytes: 1000 });
  });

  it("adds the LFS rule and the ignore entries, keeping what the files already say", async () => {
    const storage = await project();
    await storage.writeText(".gitignore", "build/");
    await writePublishFiles(storage);
    expect(await storage.readText(".gitattributes")).toBe(`${GITATTRIBUTES_LFS_RULE}\n`);
    expect(await storage.readText(".gitignore")).toBe("build/\nlayout.json\n.haptic-*.tmp\n.haptic-move-*\n");
    // Running again changes nothing.
    await writePublishFiles(storage);
    expect(await storage.readText(".gitattributes")).toBe(`${GITATTRIBUTES_LFS_RULE}\n`);
  });
});

const REPOSITORY_URL = "https://github.com/test-user/forest-run.git";
const OFF_PROJECT = JSON.stringify({ settings: { sourceControl: { mode: "off" } } });

/**
 * A new project as it opens (Off, in app storage) with the real sync service
 * over `FakeSync`, publishing to test mode's fake GitHub.
 */
async function newProject(mode: SourceControlMode = "off", options: { pushFails?: Error } = {}) {
  const host = new FakeGitHost();
  const api = hostApiFor(TEST_GITHUB_CREDENTIAL, host.http)!;
  const remote = new FakeRemote();
  const storage = new MemoryStorageAdapter("documents");
  const folder = await storage.openDocumentsProject("Forest Run");
  await storage.writeText("project.json", OFF_PROJECT);
  await storage.writeText("assets/Forest.scene.hasset", "F");
  const factory: SyncPortFactory = {
    open: vi.fn(async (): Promise<SyncPort> => { throw new Error("Publish keeps the client it started."); }),
    init: vi.fn(async (): Promise<SyncPort> => {
      const copy = FakeSync.init({ storage, remote, branch: "main" });
      // The network is the boundary that fails; the commit before it is real.
      if (options.pushFails) vi.spyOn(copy, "push").mockRejectedValue(options.pushFails);
      return copy;
    }),
    author: async () => ({ name: "ada", email: "" }),
    readAdoption: async () => false,
    setAdoption: async () => {},
  };
  const sync = new SourceControlSyncService();
  const input = (settings: SourceControlProjectSettings): SyncConfigureInput => ({
    settings,
    folder,
    storage,
    platform: "web",
    testMode: true,
    lookup: () => null,
    locks: { theirs: async () => [], releaseOwn: async () => {} },
    factory,
  });
  const saved: SourceControlProjectSettings[] = [];
  // As the editor saves the project, after which its settings effect configures the sync again.
  const saveSettings = vi.fn(async (settings: SourceControlProjectSettings) => {
    saved.push(settings);
    await storage.writeText("project.json", JSON.stringify({ settings: { sourceControl: settings } }));
    await sync.configure(input(settings));
  });
  const owners = await api.owners();
  if (!owners.ok) throw new Error(owners.error.message);
  const repository: NewRepositoryRequest = { origin: GITHUB_ORIGIN, owner: owners.value[0]!, name: "forest-run", private: true };
  const publish = (overrides: { api?: typeof api | null } = {}) => publishToNewRepository({
    api: overrides.api === undefined ? api : overrides.api,
    repository,
    sync,
    input: input({ ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, mode }),
    saveSettings,
  });
  return { host, remote, storage, factory, sync, saved, saveSettings, publish };
}

const decode = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : null);

describe("Publish to a new repository", () => {
  it("creates the repository, writes the Git files, saves Integrated mode and pushes the whole project", async () => {
    const { host, remote, storage, sync, saved, publish } = await newProject();
    expect(await publish()).toEqual({ status: "published", repositoryUrl: REPOSITORY_URL });
    expect(host.repositories[0]).toBe("test-user/forest-run");
    expect(host.publicRepositories.has("test-user/forest-run")).toBe(false);
    expect(await storage.readText(".gitattributes")).toBe(`${GITATTRIBUTES_LFS_RULE}\n`);
    expect(saved).toEqual([{ ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, mode: "integrated", repositoryUrl: REPOSITORY_URL, branch: "main" }]);
    const head = remote.get(remote.branches.get("main")!);
    expect(JSON.parse(decode(head.files.get("project.json"))!)).toMatchObject({ settings: { sourceControl: { mode: "integrated", repositoryUrl: REPOSITORY_URL } } });
    expect([...head.files.keys()].sort()).toEqual([".gitattributes", ".gitignore", "assets/Forest.scene.hasset", "project.json"]);
    expect(sync.getSnapshot()).toMatchObject({ active: true, ahead: 0, rows: [], problem: null });
  });

  it("leaves the project Local, with no file written, when the host will not create the repository", async () => {
    const { host, storage, factory, saveSettings, publish } = await newProject();
    // Taken by a repository that holds work: never published into.
    host.repositories.unshift("test-user/forest-run");
    expect(await publish()).toEqual({ status: "local", message: "test-user/forest-run already exists and is not empty. Choose another repository name." });
    expect(factory.init).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
    expect(await storage.exists(".gitattributes")).toBe(false);
    expect(await storage.readText("project.json")).toBe(OFF_PROJECT);
  });

  it("publishes again into the empty repository an attempt that stopped before its push created", async () => {
    const { host, factory, remote, publish } = await newProject();
    vi.mocked(factory.init).mockRejectedValueOnce(new Error("The project closed while publishing."));
    expect(await publish()).toEqual({ status: "local", message: "The project closed while publishing." });
    expect(remote.branches.has("main")).toBe(false);
    expect(await publish()).toEqual({ status: "published", repositoryUrl: REPOSITORY_URL });
    expect(host.repositories.filter((name) => name === "test-user/forest-run")).toHaveLength(1);
  });

  it("creates nothing without a signed-in account, or for a project that already uses source control", async () => {
    const signedOut = await newProject();
    expect(await signedOut.publish({ api: null })).toEqual({ status: "local", message: "Sign in to github.com to create the repository." });
    const manual = await newProject("manual");
    expect(await manual.publish()).toEqual({ status: "local", message: "This project already uses source control." });
    for (const { host, factory } of [signedOut, manual]) {
      expect(host.repositories).not.toContain("test-user/forest-run");
      expect(factory.init).not.toHaveBeenCalled();
    }
  });

  it("keeps Integrated mode and the unpushed commit for Push when the first push fails", async () => {
    const { remote, sync, saved, publish } = await newProject("off", { pushFails: new SyncError("network", "github.com could not be reached.") });
    expect(await publish()).toEqual({ status: "integrated", message: "github.com could not be reached." });
    expect(saved.map((settings) => settings.mode)).toEqual(["integrated"]);
    expect(remote.branches.has("main")).toBe(false);
    expect(sync.getSnapshot()).toMatchObject({ active: true, ahead: 1, problem: { title: "Could Not Publish", message: "github.com could not be reached." } });
  });
});
