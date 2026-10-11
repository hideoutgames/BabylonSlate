import { mkdir, mkdtemp, readFile, rm, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isStorageNotFound } from "@babylonslate/core";
import { NodeStorageAdapter } from "./node-adapter";

// Root ignores permission bits, so permission failures are injected at the fs boundary.
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile), rename: vi.fn(fs.rename), stat: vi.fn(fs.stat) };
});

describe("node storage adapter", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("round-trips binary files on disk", async () => {
    dir = await mkdtemp(join(tmpdir(), "babylonslate-node-"));
    const storage = new NodeStorageAdapter(dir);
    await storage.openDocumentsProject("Game.babproject");
    const bytes = new Uint8Array([9, 8, 7]);
    await storage.writeBinary("assets/.blobs/abc", bytes);
    expect(await storage.readBinary("assets/.blobs/abc")).toEqual(bytes);
    expect((await storage.listProjects())[0]?.name).toBe("Game.babproject");
  });

  it("reads only the requested bytes and rejects a replaced source revision", async () => {
    dir = await mkdtemp(join(tmpdir(), "babylonslate-range-"));
    const storage = new NodeStorageAdapter(dir);
    await storage.openDocumentsProject("Game");
    const bytes = new Uint8Array(1024 * 1024);
    bytes.set([4, 5, 6], 32);
    await storage.writeBinary("large.babasset", bytes);
    const prefix = await storage.readBinaryRange("large.babasset", 32, 3);
    expect(prefix.bytes).toEqual(new Uint8Array([4, 5, 6]));
    expect(prefix.totalSize).toBe(1024 * 1024);
    expect(storage.getReadMetrics()).toMatchObject({ actualBytesRead: 3, fullReads: 0 });
    await writeFile(join(dir, "Game", "replacement"), bytes);
    await rename(join(dir, "Game", "replacement"), join(dir, "Game", "large.babasset"));
    await expect(storage.readBinaryRange("large.babasset", 32, 3, prefix.revision)).rejects.toThrow(/revision/i);
    await expect(storage.readBinaryRange("large.babasset", bytes.length, 1)).rejects.toThrow(/range/i);
    await expect(storage.readBinaryRange("large.babasset", -1, 1)).rejects.toThrow(/range/i);
    expect(storage.getReadMetrics().actualBytesRead).toBe(3);
  });

  it("reports only a missing path as absent and keeps permission and confinement failures", async () => {
    dir = await mkdtemp(join(tmpdir(), "babylonslate-node-"));
    const storage = new NodeStorageAdapter(dir);
    await storage.openDocumentsProject("Game");
    await storage.writeText("project.json", "{}");
    expect(await storage.exists("missing.json")).toBe(false);
    expect(await storage.exists("project.json/child")).toBe(false);
    for (const missing of [storage.readText("missing.json"), storage.stat("missing.json"), storage.remove("missing.json"), storage.readdir("missing")]) {
      const error = await missing.catch((caught: unknown) => caught);
      expect(isStorageNotFound(error)).toBe(true);
    }
    await expect(storage.readText("missing.json")).rejects.toThrow("File not found: missing.json");

    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    vi.mocked(stat).mockRejectedValueOnce(denied);
    await expect(storage.exists("project.json")).rejects.toBe(denied);
    vi.mocked(readFile).mockRejectedValueOnce(denied);
    const read = await storage.readText("project.json").catch((caught: unknown) => caught);
    expect(read).toBe(denied);
    expect(isStorageNotFound(read)).toBe(false);
    await expect(storage.exists("../Game-copy/project.json")).rejects.toThrow(/escapes project root/);
  });

  it("opens an absolute folder outside the documents base", async () => {
    dir = await mkdtemp(join(tmpdir(), "babylonslate-node-"));
    const storage = new NodeStorageAdapter(dir);
    const external = await mkdtemp(join(tmpdir(), "babylonslate-ext-"));
    const handle = await storage.openAbsoluteFolder(external, "Picked");
    expect(handle.tier).toBe("external");
    await storage.writeText("project.json", "{}");
    expect(await storage.readText("project.json")).toBe("{}");
    await rm(external, { recursive: true, force: true });
  });

  it("keeps the previous file when a staged write cannot replace it", async () => {
    dir = await mkdtemp(join(tmpdir(), "babylonslate-node-"));
    const storage = new NodeStorageAdapter(dir);
    await storage.openDocumentsProject("Game");
    await storage.writeText("project.json", "saved");
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
    await expect(storage.writeText("project.json", "torn")).rejects.toThrow("EIO");
    expect(await storage.readText("project.json")).toBe("saved");
    expect((await storage.readdir(".")).map((entry) => entry.name)).toEqual(["project.json"]);
  });

  it("refuses symbolic links that leave the project and lists links inside it", async () => {
    dir = await mkdtemp(join(tmpdir(), "babylonslate-node-"));
    const outside = join(dir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    const storage = new NodeStorageAdapter(dir);
    await storage.openDocumentsProject("Game");
    await storage.writeText("assets/hero.babasset", "hero");
    const project = join(dir, "Game");
    await symlink(outside, join(project, "out"));
    await symlink(join(outside, "secret.txt"), join(project, "secret.json"));
    await symlink(join(outside, "missing.json"), join(project, "dangling.json"));
    await symlink(join(project, "assets"), join(project, "shared"));
    await expect(storage.readText("secret.json")).rejects.toThrow(/escapes project root/);
    await expect(storage.writeText("secret.json", "overwritten")).rejects.toThrow(/escapes project root/);
    await expect(storage.writeText("out/new.txt", "created")).rejects.toThrow(/escapes project root/);
    await expect(storage.writeText("dangling.json", "created")).rejects.toThrow(/escapes project root/);
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret");
    await expect(stat(join(outside, "missing.json"))).rejects.toThrow();
    expect((await storage.readdir(".")).map(({ name, isDir }) => [name, isDir]).sort()).toEqual([
      ["assets", true],
      ["shared", true],
    ]);
    await storage.writeText("shared/hero.babasset", "linked");
    expect(await storage.readText("assets/hero.babasset")).toBe("linked");
    await storage.remove("out");
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("reopens an existing Documents project by id only", async () => {
    dir = await mkdtemp(join(tmpdir(), "babylonslate-node-"));
    const storage = new NodeStorageAdapter(dir);
    await storage.openDocumentsProject("Game");
    await storage.writeText("project.json", "game");
    const [listed] = await storage.listProjects();
    await storage.releaseFolder();
    await storage.openKnownFolder(listed!);
    expect(await storage.readText("project.json")).toBe("game");
    await expect(storage.openKnownFolder({ id: "opfs:Game", name: "Game", tier: "documents" })).rejects.toThrow(/cannot open/);
    const missing = await storage.openKnownFolder({ id: `node:${join(dir, "Missing")}`, name: "Missing", tier: "documents" })
      .catch((error: unknown) => error);
    expect(isStorageNotFound(missing)).toBe(true);
    await expect(stat(join(dir, "Missing"))).rejects.toThrow();
  });

  it("confines direct reads, writes and removals even when a sibling shares the project prefix", async () => {
    dir = await mkdtemp(join(tmpdir(), "babylonslate-node-"));
    const storage = new NodeStorageAdapter(dir);
    await storage.openDocumentsProject("Game-copy");
    await storage.writeText("notes.txt", "private sibling");
    await storage.openDocumentsProject("Game");
    await storage.writeText("project.json", "project");
    const outside = "../Game-copy/notes.txt";
    await expect(storage.readText(outside)).rejects.toThrow();
    await expect(storage.writeText(outside, "overwritten")).rejects.toThrow();
    await expect(storage.remove(outside)).rejects.toThrow();
    await expect(storage.openDocumentsProject("../outside")).rejects.toThrow();
    expect((await storage.readdir(".")).map((entry) => entry.name)).toEqual(["project.json"]);
    await storage.openDocumentsProject("Game-copy");
    expect(await storage.readText("notes.txt")).toBe("private sibling");
  });
});
