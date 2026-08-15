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
});
