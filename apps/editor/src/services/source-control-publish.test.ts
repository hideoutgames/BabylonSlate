import { describe, expect, it } from "vitest";
import { GITATTRIBUTES_LFS_RULE } from "@haptic/source-control";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { summarizeProject, writePublishFiles } from "./source-control-publish";

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
