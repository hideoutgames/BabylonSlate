import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectStorage } from "@haptic/core";
import { DocumentsStorageAdapter } from "@haptic/vfs";
import { createFakeDocumentsFs } from "@haptic/vfs/fake-documents-fs";
import { NodeStorageAdapter } from "@haptic/vfs/node";
import * as git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lfsPointerText } from "../lfs-pointer";
import { isSyncError } from "../sync-port";
import { StorageFs } from "./storage-fs";

const OID = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const BLOB = `assets/.blobs/${OID}`;
const encode = (value: string) => new TextEncoder().encode(value);

let root: string;
let storage: ProjectStorage;
let calls: string[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "haptic-fs-"));
  const adapter = new NodeStorageAdapter(root);
  await adapter.openDocumentsProject("project");
  calls = [];
  storage = new Proxy(adapter, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(`${String(property)} ${String(args[0])}`);
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("StorageFs", () => {
  it("answers a .blobs file with its pointer from the stat and never reads its bytes", async () => {
    await storage.writeBinary(BLOB, encode("abc"));
    const fs = new StorageFs(storage);
    calls.length = 0;
    expect(new TextDecoder().decode((await fs.promises.readFile(`/${BLOB}`)) as Uint8Array)).toBe(lfsPointerText(OID, 3));
    expect(calls.filter((call) => call.startsWith("readBinary"))).toEqual([]);
    expect(fs.counters).toMatchObject({ pointerReads: 1, workingReads: 0 });
  });

  it("keeps an object's file when Git writes its pointer, and refuses a pointer to a missing or different object", async () => {
    const fs = new StorageFs(storage);
    const pointer = (oid: string, size: number) => fs.promises.writeFile(`/${BLOB}`, lfsPointerText(oid, size));
    const missing = await pointer(OID, 3).then(() => null, (error: unknown) => error);
    expect(isSyncError(missing) && missing.code).toBe("lfs-object-missing");
    await storage.writeBinary(BLOB, encode("abc"));
    await pointer(OID, 3);
    expect(new TextDecoder().decode(await storage.readBinary(BLOB))).toBe("abc");
    expect(fs.counters.smudgedPointers).toBe(1);
    const other = await pointer("0".repeat(64), 3).then(() => null, (error: unknown) => error);
    expect(isSyncError(other) && other.code).toBe("lfs-object-corrupt");
    // A repository that stored the bytes themselves: written as they are.
    await fs.promises.writeFile(`/${BLOB}`, encode("xyz"));
    expect(new TextDecoder().decode(await storage.readBinary(BLOB))).toBe("xyz");
  });

  it("answers stats from the directory listing, so a walk costs one storage call per directory", async () => {
    await storage.writeBinary("assets/a.hasset", encode("A"));
    await storage.writeBinary("assets/b.hasset", encode("BB"));
    const fs = new StorageFs(storage);
    calls.length = 0;
    expect((await fs.promises.readdir("/assets")).sort()).toEqual(["a.hasset", "b.hasset"]);
    const stats = await fs.promises.lstat("/assets/b.hasset");
    expect([stats.isFile(), stats.size, stats.mode]).toEqual([true, 2, 0o100644]);
    await fs.promises.lstat("/assets/a.hasset");
    expect(calls).toEqual(["readdir assets"]);
    // A write is seen at once.
    await fs.promises.writeFile("/assets/a.hasset", "AAA");
    expect((await fs.promises.lstat("/assets/a.hasset")).size).toBe(3);
  });

  it("removes only an empty directory and maps missing paths to ENOENT", async () => {
    await storage.writeBinary("assets/untracked.hasset", encode("U"));
    const fs = new StorageFs(storage);
    await expect(fs.promises.rmdir("/assets")).rejects.toMatchObject({ code: "ENOTEMPTY" });
    expect(await storage.exists("assets/untracked.hasset")).toBe(true);
    await storage.mkdir("empty", true);
    await fs.promises.rmdir("/empty");
    expect(await storage.exists("empty")).toBe(false);
    await expect(fs.promises.readFile("/missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.promises.lstat("/missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.promises.unlink("/missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.promises.readdir("/missing")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// A native transfer the system ends (the app killed in the background) can leave its staged file beside the object.
describe("StorageFs on the mobile Documents tier", () => {
  it("leaves a staged transfer file out of the working copy Git reads for status", async () => {
    const documents = new DocumentsStorageAdapter({ fs: createFakeDocumentsFs() });
    await documents.openDocumentsProject("project");
    const fs = new StorageFs(documents);
    await git.init({ fs, dir: "/", defaultBranch: "main" });
    await documents.writeBinary("assets/a.hasset", encode("A"));
    await documents.writeBinary(BLOB, encode("abc"));
    await documents.writeBinary("assets/.blobs/.haptic-0f8b9c1e-3d2a-4c5b-9e7f-1a2b3c4d5e6f.tmp", encode("partial"));

    const rows = await git.statusMatrix({ fs, dir: "/" });
    expect(rows.map(([path]) => path)).toEqual(["assets/.blobs/" + OID, "assets/a.hasset"]);
  });
});
