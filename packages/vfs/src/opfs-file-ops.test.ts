import { describe, expect, it, vi } from "vitest";
import { createOpfsFileOps, OpfsFailure } from "./opfs-file-ops";
import { stagedWriteName, isStagedWrite } from "./staged-write";
import { createMemoryOpfsRoot, type MemoryOpfsOptions } from "./test-support/memory-opfs";

const PROJECT = "project-v2-test";
const bytes = (...values: number[]) => new Uint8Array(values);
const failureOf = (promise: Promise<unknown>) => promise.then(
  () => { throw new Error("expected a failure"); },
  (error: unknown) => {
    expect(error).toBeInstanceOf(OpfsFailure);
    return error as OpfsFailure;
  },
);

async function setup(options: MemoryOpfsOptions = {}) {
  const lookups: string[] = [];
  const root = createMemoryOpfsRoot("", { ...options, onLookup: (kind, name) => lookups.push(`${kind}:${name}`) });
  const ops = createOpfsFileOps(async () => root);
  await ops.ensureProjectDir(PROJECT);
  /** Another tab sharing the origin's OPFS, with caches of its own. */
  const otherTab = () => createOpfsFileOps(async () => root);
  const folder = () => root.getDirectoryHandle(PROJECT);
  return { root, ops, lookups, otherTab, folder };
}

describe("OPFS file operations", () => {
  it("reuses directory handles instead of walking from the root, but looks the project up for every write", async () => {
    const { ops, lookups } = await setup();
    await ops.writeBinary(PROJECT, "a/b/c.txt", bytes(1, 2, 3));
    lookups.length = 0;
    expect(await ops.readBinary(PROJECT, "a/b/c.txt")).toEqual(bytes(1, 2, 3));
    expect(await ops.stat(PROJECT, "a/b/c.txt")).toMatchObject({ isDir: false, size: 3 });
    expect((await ops.readdir(PROJECT, "a/b")).map((entry) => entry.name)).toEqual(["c.txt"]);
    expect(lookups).toEqual(["file:c.txt", "file:c.txt"]);
    lookups.length = 0;
    await ops.writeBinary(PROJECT, "a/b/c.txt", bytes(4));
    // A save never relies on a cached project folder, which another tab may have deleted.
    expect(lookups).toEqual([`directory:${PROJECT}`, "file:c.txt"]);
  });

  it("drops cached handles below a removed path and of a removed project", async () => {
    const { ops, lookups } = await setup();
    await ops.writeBinary(PROJECT, "a/b/c.txt", bytes(1));
    await ops.remove(PROJECT, "a");
    lookups.length = 0;
    // Recreated from the project folder, not tried first through the removed folder's handles.
    await ops.writeBinary(PROJECT, "a/b/d.txt", bytes(2));
    expect(lookups).toEqual([`directory:${PROJECT}`, "directory:a", "directory:b", "file:d.txt"]);
    expect((await failureOf(ops.readBinary(PROJECT, "a/b/c.txt"))).kind).toBe("not-found");
    expect(await ops.readdir(PROJECT, "a/b")).toEqual([expect.objectContaining({ name: "d.txt" })]);

    await ops.removeProjectDir(PROJECT);
    expect(await ops.exists(PROJECT, "")).toBe(false);
    await ops.ensureProjectDir(PROJECT);
    lookups.length = 0;
    expect(await ops.exists(PROJECT, "a/b/d.txt")).toBe(false);
    expect(lookups).not.toContain("file:d.txt");
    expect(await ops.readdir(PROJECT, "")).toEqual([]);
  });

  it("re-resolves from the root when another tab removed and recreated a cached directory", async () => {
    const { ops, otherTab } = await setup();
    await ops.writeBinary(PROJECT, "cache/old.bin", bytes(1));
    expect(await ops.readdir(PROJECT, "cache")).toHaveLength(1);
    const other = otherTab();
    await other.remove(PROJECT, "cache");
    await other.writeBinary(PROJECT, "cache/new.bin", bytes(7, 7));

    expect(await ops.readBinary(PROJECT, "cache/new.bin")).toEqual(bytes(7, 7));
    expect((await failureOf(ops.readBinary(PROJECT, "cache/old.bin"))).kind).toBe("not-found");
    expect(await ops.readdir(PROJECT, "cache")).toEqual([expect.objectContaining({ name: "new.bin", size: 2 })]);
    expect(await ops.exists(PROJECT, "cache/old.bin")).toBe(false);
    const range = await ops.readRange(PROJECT, "cache/new.bin", 1, 1, 0);
    expect(range.bytes).toEqual(bytes(7));
  });

  it("never recreates a project folder another tab deleted, even with warm caches", async () => {
    const { ops, otherTab, root } = await setup();
    await ops.writeBinary(PROJECT, "scenes/main.json", bytes(1));
    expect(await ops.readBinary(PROJECT, "scenes/main.json")).toEqual(bytes(1));
    await otherTab().removeProjectDir(PROJECT);

    for (const attempt of [
      ops.writeBinary(PROJECT, "scenes/main.json", bytes(2)),
      ops.writeBinary(PROJECT, "scenes/other/new.json", bytes(2)),
      ops.mkdir(PROJECT, "scenes/sub", true),
    ]) {
      expect(await failureOf(attempt)).toMatchObject({ kind: "not-found", project: true });
    }
    await expect(root.getDirectoryHandle(PROJECT)).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("lists entries in directory order with size and mtime, leaving out swap and staged files", async () => {
    const { ops, folder } = await setup();
    const staged = stagedWriteName();
    for (const name of ["z.bin", staged, "a.bin.crswap", "b.bin"]) await ops.writeBinary(PROJECT, name, bytes(1, 2));
    await ops.mkdir(PROJECT, "m", true);
    await ops.mkdir(PROJECT, "dir.crswap", true);
    await ops.writeBinary(PROJECT, "b.bin", bytes(1, 2, 3));
    // The first file's metadata arrives last; the listing keeps the directory's order.
    const first = await (await folder()).getFileHandle("z.bin");
    const getFile = first.getFile.bind(first);
    vi.spyOn(first, "getFile").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return getFile();
    });

    expect(isStagedWrite(staged)).toBe(true);
    expect(await ops.readdir(PROJECT, "")).toEqual([
      { name: "z.bin", isDir: false, size: 2, mtime: 1 },
      { name: "b.bin", isDir: false, size: 3, mtime: 2 },
      { name: "m", isDir: true, size: null, mtime: null },
      { name: "dir.crswap", isDir: true, size: null, mtime: null },
    ]);
  });

  it("reads file metadata for a listing in parallel, at most 16 at a time", async () => {
    const { ops, folder } = await setup();
    const project = await folder();
    let active = 0;
    let peak = 0;
    for (let index = 0; index < 40; index++) {
      const name = `f${index}.bin`;
      await ops.writeBinary(PROJECT, name, bytes(index));
      const handle = await project.getFileHandle(name);
      const getFile = handle.getFile.bind(handle);
      vi.spyOn(handle, "getFile").mockImplementation(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return getFile();
      });
    }
    const listed = await ops.readdir(PROJECT, "");
    expect(listed.map((entry) => entry.name)).toEqual(Array.from({ length: 40 }, (_, index) => `f${index}.bin`));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
  });

  it("answers exists from handle lookups alone", async () => {
    const { ops, folder } = await setup();
    await ops.writeBinary(PROJECT, "dir/file.bin", bytes(1));
    const file = await (await (await folder()).getDirectoryHandle("dir")).getFileHandle("file.bin");
    const getFile = vi.spyOn(file, "getFile");

    expect(await ops.exists(PROJECT, "dir/file.bin")).toBe(true);
    expect(await ops.exists(PROJECT, "dir")).toBe(true);
    expect(await ops.exists(PROJECT, "")).toBe(true);
    expect(await ops.exists(PROJECT, "dir/missing.bin")).toBe(false);
    expect(await ops.exists(PROJECT, "missing/file.bin")).toBe(false);
    // A file where a parent directory would be cannot contain the path.
    expect(await ops.exists(PROJECT, "dir/file.bin/child")).toBe(false);
    expect(getFile).not.toHaveBeenCalled();

    const directory = await (await folder()).getDirectoryHandle("dir");
    vi.spyOn(directory, "getFileHandle").mockRejectedValue(new DOMException("Handle state changed", "InvalidStateError"));
    expect(await failureOf(ops.exists(PROJECT, "dir/file.bin"))).toMatchObject({
      kind: "failed",
      message: "Could not stat dir/file.bin: InvalidStateError: Handle state changed",
      cause: { name: "InvalidStateError", message: "Handle state changed" },
    });
  });
});

describe("OPFS writes without createWritable", () => {
  const syncOnly = { withoutWritable: true, syncAccess: true };

  /** Wrap the SyncAccessHandle of the next staged file written in `dir`. */
  function interceptStaged(
    project: FileSystemDirectoryHandle,
    wrap: (handle: FileSystemFileHandle & Record<string, unknown>) => void,
  ) {
    const getFileHandle = project.getFileHandle.bind(project);
    vi.spyOn(project, "getFileHandle").mockImplementation(async (name, options) => {
      const handle = await getFileHandle(name, options);
      if (isStagedWrite(name)) wrap(handle as FileSystemFileHandle & Record<string, unknown>);
      return handle;
    });
  }

  async function entryNames(project: FileSystemDirectoryHandle) {
    const names: string[] = [];
    for await (const [name] of (project as unknown as { entries(): AsyncIterable<[string]> }).entries()) names.push(name);
    return names;
  }

  it("stages the bytes in a sibling file and moves it over the target", async () => {
    const { ops, folder } = await setup(syncOnly);
    await ops.writeBinary(PROJECT, "asset.bin", bytes(1, 2, 3));
    const project = await folder();
    const target = await project.getFileHandle("asset.bin") as FileSystemFileHandle & { createSyncAccessHandle(): Promise<unknown> };
    const targetAccess = vi.spyOn(target, "createSyncAccessHandle");
    // Accept at most three bytes per call, as a partial write would.
    interceptStaged(project, (handle) => {
      const open = handle.createSyncAccessHandle as () => Promise<{ write(data: Uint8Array, at: { at: number }): number }>;
      handle.createSyncAccessHandle = async () => {
        const access = await open();
        const write = access.write.bind(access);
        access.write = (data, at) => write(data.subarray(0, 3), at);
        return access;
      };
    });

    await ops.writeBinary(PROJECT, "asset.bin", bytes(9, 8, 7, 6, 5, 4, 3));
    expect(await ops.readBinary(PROJECT, "asset.bin")).toEqual(bytes(9, 8, 7, 6, 5, 4, 3));
    expect(targetAccess).not.toHaveBeenCalled();
    expect(await entryNames(project)).toEqual(["asset.bin"]);
  });

  it.each([
    ["the staged write runs out of space", "write"],
    ["the move fails", "move"],
  ])("leaves the target intact and removes the staged file when %s", async (_case, failing) => {
    const { ops, folder } = await setup(syncOnly);
    await ops.writeBinary(PROJECT, "asset.bin", bytes(1, 2, 3));
    const project = await folder();
    let closed = 0;
    interceptStaged(project, (handle) => {
      const open = handle.createSyncAccessHandle as () => Promise<{ write(data: Uint8Array, at: { at: number }): number; close(): void }>;
      handle.createSyncAccessHandle = async () => {
        const access = await open();
        const write = access.write.bind(access);
        const close = access.close.bind(access);
        let calls = 0;
        if (failing === "write") {
          access.write = (data, at) => {
            if (++calls > 1) throw new DOMException("Storage is full", "QuotaExceededError");
            return write(data.subarray(0, 2), at);
          };
        }
        access.close = () => { closed++; close(); };
        return access;
      };
      if (failing === "move") handle.move = async () => { throw new DOMException("Move refused", "InvalidModificationError"); };
    });

    const failure = await failureOf(ops.writeBinary(PROJECT, "asset.bin", bytes(9, 9, 9, 9)));
    expect(failure.kind).toBe("error");
    expect(failure.cause?.name).toBe(failing === "write" ? "QuotaExceededError" : "InvalidModificationError");
    expect(closed).toBe(1);
    expect(await ops.readBinary(PROJECT, "asset.bin")).toEqual(bytes(1, 2, 3));
    expect(await entryNames(project)).toEqual(["asset.bin"]);
  });

  it("refuses to write where neither createWritable nor a staged SyncAccessHandle write is possible", async () => {
    const { ops } = await setup({ withoutWritable: true });
    const failure = await failureOf(ops.writeBinary(PROJECT, "asset.bin", bytes(1)));
    expect(failure).toMatchObject({ kind: "failed", message: "Could not write asset.bin: this browser cannot replace files safely" });
  });
});
