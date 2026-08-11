import { beforeEach, describe, expect, it } from "vitest";
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
});
