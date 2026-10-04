import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeStorageAdapter } from "./node-adapter";

describe("node storage adapter", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("defaults pickProjectFolder to MyGame", async () => {
    dir = await mkdtemp(join(tmpdir(), "babylonslate-node-"));
    const storage = new NodeStorageAdapter(dir);
    expect((await storage.pickProjectFolder()).name).toBe("MyGame");
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
