import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceRevisionChangedError } from "@haptic/core";
import { DocumentsStorageAdapter } from "./documents-adapter";
import { DERIVED_STORAGE_ROOT, LIBRARY_FOLDERS } from "./library-folders";
import { createMountedProjectStorage } from "./mounted-storage";
import type { NativeBinaryBridge } from "./native-binary-bridge";
import {
  createFakeDocumentsFs,
  type FakeDocumentsFs,
} from "./test-support/fake-documents-fs";

describe("DocumentsStorageAdapter", () => {
  let fs: FakeDocumentsFs;
  let storage: DocumentsStorageAdapter;

  beforeEach(() => {
    fs = createFakeDocumentsFs();
    storage = new DocumentsStorageAdapter({ fs });
  });

  it("does not recreate a deleted project when opening a recent handle", async () => {
    const missing = { id: "documents:Deleted", name: "Deleted", tier: "documents" as const };
    await expect(storage.openKnownFolder(missing)).rejects.toBeDefined();
    expect(fs.tree.has("Projects/Deleted")).toBe(false);
    expect(storage.getCurrentFolder()).toBeNull();
  });

  it("creates and lists documents projects without a picker", async () => {
    await storage.openDocumentsProject("Demo.hproject");
    await storage.writeText("project.json", '{"ok":true}');
    expect(await storage.readText("project.json")).toBe('{"ok":true}');
    expect(await storage.exists(".")).toBe(true);
    expect((await storage.stat(".")).isDir).toBe(true);

    const listed = await storage.listProjects();
    expect(listed).toEqual([
      {
        id: "documents:Demo.hproject",
        name: "Demo.hproject",
        tier: "documents",
      },
    ]);
  });

  it("reopens a known documents folder without prompting", async () => {
    await storage.openDocumentsProject("A.hproject");
    await storage.writeBinary("blob.bin", new Uint8Array([1, 2, 3]));
    await storage.releaseFolder();

    const reopened = new DocumentsStorageAdapter({ fs });
    await reopened.openKnownFolder({
      id: "documents:A.hproject",
      name: "A.hproject",
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
    await storage.openDocumentsProject("Writes.hproject");
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

  it.each([
    ["the staged write fails", "writeFile"],
    ["the move into place fails", "rename"],
  ] as const)("keeps the previous file and leaves no staged file when %s", async (_case, step) => {
    await storage.openDocumentsProject("Game");
    await storage.writeText("project.json", "saved");
    await storage.writeBinary("asset.bin", new Uint8Array([1, 2]));
    const failure = new Error("Device storage full");
    const original = fs[step].bind(fs) as (options: never) => Promise<unknown>;
    fs[step] = vi.fn(async (options: never) => {
      // A partial staged file exists when the native write fails part-way.
      if (step === "writeFile") await original(options);
      throw failure;
    }) as never;

    await expect(storage.writeText("project.json", "half")).rejects.toBe(failure);
    await expect(storage.writeBinary("asset.bin", new Uint8Array([9]))).rejects.toBe(failure);

    expect(await storage.readText("project.json")).toBe("saved");
    expect(await storage.readBinary("asset.bin")).toEqual(new Uint8Array([1, 2]));
    expect([...fs.tree.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
  });

  describe("a replace a killed app left half done", () => {
    const text = (value: string) => new TextEncoder().encode(value);
    const decode = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : null);

    /**
     * Without the binary transport, on Capacitor's iOS `rename` (which removes
     * an existing destination, then moves the file: two steps), the app is
     * killed just before the write's `kill`-th file step (writeFile, a
     * destination removal, a move, deleteFile): that step and everything after
     * never happen. The project is then opened again by a new launch.
     */
    async function killedWrite(path: string, kill: number | null) {
      await storage.openDocumentsProject("Killed");
      await storage.mkdir("assets", true);
      await storage.writeText(path, "old");
      let steps = 0;
      const step = () => {
        if (++steps >= (kill ?? Infinity)) throw new Error("The app was killed.");
      };
      const ios = {
        ...fs,
        writeFile: async (options: Parameters<typeof fs.writeFile>[0]) => { step(); return fs.writeFile(options); },
        deleteFile: async (options: Parameters<typeof fs.deleteFile>[0]) => { step(); return fs.deleteFile(options); },
        rename: async (options: Parameters<typeof fs.rename>[0]) => {
          if (fs.tree.has(options.to)) {
            step();
            await fs.deleteFile({ path: options.to });
          }
          step();
          return fs.rename(options);
        },
      } as FakeDocumentsFs;
      const doomed = new DocumentsStorageAdapter({ fs: ios });
      await doomed.openKnownFolder({ id: "documents:Killed", name: "Killed", tier: "documents" });
      // What the killed launch's write reported never reaches anyone.
      await doomed.writeText(path, "new").catch(() => {});
      const relaunched = new DocumentsStorageAdapter({ fs });
      await relaunched.openKnownFolder({ id: "documents:Killed", name: "Killed", tier: "documents" });
      return relaunched;
    }

    // The replace's steps: the staged bytes are written (1), the file is set aside (2), the staged file moves in (3), the aside copy goes (4).
    const steps = [
      ["before its bytes are staged", 1, "old"],
      ["before the file is set aside", 2, "old"],
      ["after the file is set aside", 3, "old"],
      ["after the new file moved in", 4, "new"],
      ["after the aside copy went", null, "new"],
    ] as const;

    it.each(steps)("leaves an asset whole when killed %s", async (_step, kill, expected) => {
      const relaunched = await killedWrite("assets/Rock.texture.hasset", kill);
      // The listing a scan makes settles the folder before anything reads the file.
      expect((await relaunched.readdir("assets")).map((entry) => entry.name)).toEqual(["Rock.texture.hasset"]);
      expect(await relaunched.readText("assets/Rock.texture.hasset")).toBe(expected);
      // Only a staged file a kill before the move left stays, hidden, for the leftover sweep.
      expect([...fs.tree.keys()].filter((key) => key.startsWith("Projects/Killed/assets/.haptic-aside-"))).toEqual([]);
    });

    it.each(steps)("leaves project.json whole when killed %s, settled by the open alone", async (_step, kill, expected) => {
      const relaunched = await killedWrite("project.json", kill);
      expect(await relaunched.readText("project.json")).toBe(expected);
      expect([...fs.tree.keys()].filter((key) => key.startsWith("Projects/Killed/.haptic-aside-"))).toEqual([]);
    });

    it("leaves a running write's aside copy to it, and hides staged and aside names", async () => {
      await storage.openDocumentsProject("Busy");
      await storage.writeText("a.txt", "old");
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const rename = fs.rename.bind(fs);
      let renames = 0;
      fs.rename = vi.fn(async (options: Parameters<typeof fs.rename>[0]) => {
        await rename(options);
        // Hold the write right after it set the old file aside.
        if (++renames === 1) await held;
      }) as typeof fs.rename;
      const writing = storage.writeText("a.txt", "new");
      await vi.waitFor(() => expect(renames).toBe(1));
      // A listing meanwhile neither restores nor removes the copy the write still owns.
      expect((await storage.readdir("")).map((entry) => entry.name)).toEqual([]);
      expect([...fs.tree.keys()].some((key) => /\/\.haptic-aside-[0-9a-f]{8}-a\.txt\.tmp$/.test(key))).toBe(true);
      release();
      await writing;
      expect(await storage.readText("a.txt")).toBe("new");
      expect([...fs.tree.keys()].filter((key) => key.startsWith("Projects/Busy/"))).toEqual(["Projects/Busy/a.txt"]);
    });

    it("needs no aside for a new file, and leaves only the file behind a write that finishes", async () => {
      await storage.openDocumentsProject("Clean");
      await storage.writeText("project.json", "first");
      await storage.writeText("project.json", "saved");
      expect(decode(fs.tree.get("Projects/Clean/project.json")?.data)).toBe("saved");
      expect([...fs.tree.keys()].filter((key) => key.startsWith("Projects/Clean/"))).toEqual(["Projects/Clean/project.json"]);
      expect(text("saved")).toEqual(await storage.readBinary("project.json"));
    });

    it("refuses, by name, to replace a file whose name leaves no room for its aside copy, and keeps it", async () => {
      await storage.openDocumentsProject("Long");
      const longest = `${"a".repeat(221)}.hasset`; // 228 bytes
      const tooLong = `${"b".repeat(222)}.hasset`; // 229 bytes
      // A new file needs no aside copy, whatever its name.
      await storage.writeText(tooLong, "first");
      await storage.writeText(longest, "first");
      await expect(storage.writeText(tooLong, "second")).rejects.toThrow(`The file name "${tooLong}" is too long to save on this device. Use a name of at most 228 bytes.`);
      expect(await storage.readText(tooLong)).toBe("first");
      await storage.writeText(longest, "second");
      expect(await storage.readText(longest)).toBe("second");
      expect([...fs.tree.keys()].filter((key) => key.startsWith("Projects/Long/")).sort()).toEqual([`Projects/Long/${longest}`, `Projects/Long/${tooLong}`]);
    });

    it("sets nothing aside through the binary transport, whose native commit is one rename with no gap", async () => {
      const bridgeWrite = vi.fn(async () => true);
      const bridged = new DocumentsStorageAdapter({ fs, bridge: { write: bridgeWrite } as unknown as NativeBinaryBridge });
      await bridged.openDocumentsProject("Bridged");
      const rename = vi.spyOn(fs, "rename");
      const write = vi.spyOn(fs, "writeFile");
      await bridged.writeText("project.json", "saved");
      expect(bridgeWrite).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
    });
  });

  it("round-trips a payload larger than one base64 encoding chunk", async () => {
    await storage.openDocumentsProject("Large.hproject");
    const bytes = Uint8Array.from({ length: 70_001 }, (_, index) => (index * 31) % 256);
    await storage.writeBinary("large.bin", bytes);
    expect(await storage.readBinary("large.bin")).toEqual(bytes);
  });

  it("uses native bounded reads and rejects unsupported hosts without reading the file", async () => {
    await storage.openDocumentsProject("Game");
    await storage.writeBinary("large.hasset", new Uint8Array([1, 2, 3, 4]));
    const fullRead = vi.spyOn(fs, "readFile");
    const selected = await storage.readBinaryRange("large.hasset", 1, 2);
    expect(selected.bytes).toEqual(new Uint8Array([2, 3]));
    expect(storage.getReadMetrics()).toMatchObject({ actualBytesRead: 2, fullReads: 0 });
    await storage.writeBinary("large.hasset", new Uint8Array([9, 8, 7, 6]));
    await expect(storage.readBinaryRange("large.hasset", 1, 2, selected.revision)).rejects.toThrow(/revision/i);
    fs.readFileRange = vi.fn().mockRejectedValue(Object.assign(new Error("Source changed during read"), { data: { actualBytesRead: 1 } }));
    await expect(storage.readBinaryRange("large.hasset", 1, 2)).rejects.toThrow(/changed/i);
    expect(storage.getReadMetrics().actualBytesRead).toBe(3);
    delete fs.readFileRange;
    await expect(storage.readBinaryRange("large.hasset", 1, 2)).rejects.toThrow(/bounded reads/i);
    expect(fullRead).not.toHaveBeenCalled();
  });

  it("translates only native revision codes and preserves failed-read accounting", async () => {
    await storage.openDocumentsProject("Game");
    fs.readFileRange = vi.fn().mockRejectedValue({ code: "REVISION_CHANGED", data: { actualBytesRead: 2 } });
    await expect(storage.readBinaryRange("asset.hasset", 0, 4)).rejects.toBeInstanceOf(SourceRevisionChangedError);
    const unrelated = Object.assign(new Error("Source revision changed"), { code: "UNREACHABLE" });
    vi.mocked(fs.readFileRange).mockRejectedValue(unrelated);
    await expect(storage.readBinaryRange("asset.hasset", 0, 4)).rejects.toBe(unrelated);
    expect(storage.getReadMetrics()).toMatchObject({ rangeReads: 2, actualBytesRead: 2, fullReads: 0 });
  });

  it("preserves discarded bytes through mounted views when native decoding or validation fails", async () => {
    await storage.openDocumentsProject("Game");
    const mounted = createMountedProjectStorage([{ path: "plugin", storage, sourcePath: "" }]);
    fs.readFileRange = vi.fn().mockResolvedValue({ data: "!", totalSize: 10, revision: "new", actualBytesRead: 2 });
    await expect(mounted.readBinaryRange("plugin/asset", 0, 2)).rejects.toThrow();
    vi.mocked(fs.readFileRange).mockResolvedValue({ data: btoa("ab"), totalSize: 10, revision: "new", actualBytesRead: 2 });
    await expect(mounted.readBinaryRange("plugin/asset", 0, 2, "old")).rejects.toBeInstanceOf(SourceRevisionChangedError);
    expect(storage.getReadMetrics()).toMatchObject({ actualBytesRead: 4, rangeReads: 2 });
    expect(mounted.getReadMetrics!()).toMatchObject({ actualBytesRead: 4, rangeReads: 2 });
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

  it("deletes a project folder and refuses app folders, chosen folders and the projects root", async () => {
    await storage.openDocumentsProject("__haptic_derived__");
    await storage.writeText("thumb.bin", "derived");
    await storage.openDocumentsProject("Gone");
    await storage.writeText("assets/a.bin", "gone");
    await storage.openDocumentsProject("Keep");
    await storage.writeText("project.json", "keep");
    const gone = { id: "documents:Gone", name: "Gone", tier: "documents" as const };

    await storage.deleteProject(gone);
    expect([...fs.tree.keys()].filter((path) => path.includes("/Gone"))).toEqual([]);
    expect(storage.getCurrentFolder()?.id).toBe("documents:Keep");
    await expect(storage.deleteProject(gone)).resolves.toBeUndefined();

    for (const folder of [...LIBRARY_FOLDERS, DERIVED_STORAGE_ROOT]) await storage.openDocumentsProject(folder);
    await storage.openDocumentsProject("Keep");
    for (const handle of [
      ...[...LIBRARY_FOLDERS, DERIVED_STORAGE_ROOT].map((folder) => ({ id: `documents:${folder}`, name: folder, tier: "documents" as const })),
      { id: "documents:", name: "Projects", tier: "documents" as const },
      { id: "documents:..", name: "Parent", tier: "documents" as const },
      { id: "documents:Keep/assets", name: "Assets", tier: "documents" as const },
      { id: "documents:Keep", name: "Keep", tier: "external" as const },
      { id: "external:Keep", name: "Keep", tier: "documents" as const },
    ]) await expect(storage.deleteProject(handle), handle.id).rejects.toThrow();
    expect(fs.tree.has("Projects/Keep/project.json")).toBe(true);
    expect(fs.tree.has("Projects/__haptic_derived__/thumb.bin")).toBe(true);
    for (const folder of LIBRARY_FOLDERS) expect(fs.tree.has(`Projects/${folder}`), folder).toBe(true);

    await storage.deleteProject({ id: "documents:Keep", name: "Keep", tier: "documents" });
    expect(fs.tree.has("Projects/Keep")).toBe(false);
    expect(storage.getCurrentFolder()).toBeNull();
  });
});
