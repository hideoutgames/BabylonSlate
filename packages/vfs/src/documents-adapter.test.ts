import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentsStorageAdapter } from "./documents-adapter";
import {
  createFakeDocumentsFs,
  type FakeDocumentsFs,
} from "./test-support/fake-documents-fs";

describe("DocumentsStorageAdapter", () => {
  let fs: FakeDocumentsFs;
  let storage: DocumentsStorageAdapter;

  beforeEach(() => {
    fs = createFakeDocumentsFs();
    storage = new DocumentsStorageAdapter(fs);
  });

  it("does not recreate a deleted project when opening a recent handle", async () => {
    const missing = { id: "documents:Deleted", name: "Deleted", tier: "documents" as const };
    await expect(storage.openKnownFolder(missing)).rejects.toBeDefined();
    expect(fs.tree.has("BabylonSlate/projects/Deleted")).toBe(false);
    expect(storage.getCurrentFolder()).toBeNull();
  });

  it("creates and lists documents projects without a picker", async () => {
    await storage.openDocumentsProject("Demo.babproject");
    await storage.writeText("project.json", '{"ok":true}');
    expect(await storage.readText("project.json")).toBe('{"ok":true}');

    const listed = await storage.listProjects();
    expect(listed).toEqual([
      {
        id: "documents:Demo.babproject",
        name: "Demo.babproject",
        tier: "documents",
      },
    ]);
  });

  it("reopens a known documents folder without prompting", async () => {
    await storage.openDocumentsProject("A.babproject");
    await storage.writeBinary("blob.bin", new Uint8Array([1, 2, 3]));
    await storage.releaseFolder();

    const reopened = new DocumentsStorageAdapter(fs);
    await reopened.openKnownFolder({
      id: "documents:A.babproject",
      name: "A.babproject",
      tier: "documents",
    });
    expect(await reopened.readBinary("blob.bin")).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("rejects pickProjectFolder", async () => {
    await expect(storage.pickProjectFolder()).rejects.toThrow(/no picker/i);
  });

  it("uses one bridge write per asset and preserves each payload", async () => {
    await storage.openDocumentsProject("Writes.babproject");
    await storage.mkdir("assets", true);
    const write = vi.spyOn(fs, "writeFile");
    for (const value of [1, 2, 3]) {
      await storage.writeBinary(`assets/${value}.bin`, new Uint8Array([value]));
      expect(await storage.readBinary(`assets/${value}.bin`)).toEqual(
        new Uint8Array([value]),
      );
    }
    expect(write).toHaveBeenCalledTimes(3);
  });

  it.each(["../Other", "", ".", "..", "/Other", "Game/Other", "Game\\Other"])("rejects unsafe project folder names: %s", async (name) => {
    await expect(storage.openDocumentsProject(name)).rejects.toThrow(/project/i);
    expect(fs.tree.size).toBe(1);
  });

  it.each(["../Other/song.wav", "/song.wav", "audio/../../song.wav", "audio\\song.wav", "audio//song.wav"])("confines file operations to the selected project: %s", async (path) => {
    await storage.openDocumentsProject("Game");
    const before = new Map(fs.tree);
    await expect(storage.writeBinary(path, new Uint8Array([1]))).rejects.toThrow(/path/i);
    await expect(storage.remove(path)).rejects.toThrow(/path/i);
    expect(fs.tree).toEqual(before);
  });

  it("allows root inspection but rejects removing or overwriting the project root", async () => {
    await storage.openDocumentsProject("Game");
    await storage.writeText("project.json", "saved");
    expect(await storage.exists("")).toBe(true);
    expect((await storage.stat("")).isDir).toBe(true);
    expect((await storage.readdir("")).map((entry) => entry.name)).toEqual(["project.json"]);
    await expect(storage.remove("")).rejects.toThrow(/root/i);
    await expect(storage.writeText("", "overwrite")).rejects.toThrow(/root/i);
    expect(await storage.readText("project.json")).toBe("saved");
  });

  it("reopens by stable id after a recent project is given a display name", async () => {
    const original = await storage.openDocumentsProject("Game");
    await storage.writeText("project.json", "original");
    await storage.releaseFolder();
    await storage.openKnownFolder({ ...original, name: "Pretty Name" });
    expect(await storage.readText("project.json")).toBe("original");
  });

  it("lists and reopens existing native directories even when mkdir reports already exists", async () => {
    const mkdir = fs.mkdir.bind(fs);
    fs.mkdir = async (options) => {
      if (fs.tree.has(options.path)) throw { code: "OS-PLUG-FILE-0010" };
      await mkdir(options);
    };
    await storage.openDocumentsProject("Game");
    await storage.writeText("project.json", "saved");
    await storage.releaseFolder();
    const [handle] = await storage.listProjects();
    expect(handle?.id).toBe("documents:Game");
    await storage.openKnownFolder(handle!);
    expect(await storage.readText("project.json")).toBe("saved");
  });

  it("propagates unavailable storage instead of reporting an empty destination", async () => {
    await storage.openDocumentsProject("Game");
    const denied = new Error("Device storage unavailable");
    fs.stat = async () => { throw denied; };
    fs.readdir = async () => { throw denied; };
    await expect(storage.exists("project.json")).rejects.toBe(denied);
    await expect(storage.stat("project.json")).rejects.toBe(denied);
    await expect(storage.listProjects()).rejects.toBe(denied);
  });
});
