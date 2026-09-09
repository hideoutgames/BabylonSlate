import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { installMinimalProject } from "../../../../packages/assets/src/test-support/minimal-project";
import { ProjectService } from "./project-service";

describe("default input assets", () => {
  it("loads authored controls and never recreates deleted inputs on project load", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Inputs.babproject");
    await installMinimalProject(storage);
    const service = new ProjectService(storage);
    await service.loadCurrentProject();
    const inputs = service
      .registry!.list()
      .filter((asset) =>
        ["InputAction", "InputAxis"].includes(asset.header.type),
      );
    expect(inputs.map((asset) => asset.header.name).sort()).toEqual([
      "Confirm",
      "Jump",
      "Look",
      "Move",
    ]);
    const move = inputs.find((asset) => asset.header.name === "Move")!;
    expect(await service.loadDocument("input-axis", move.path)).toMatchObject({
      valueType: "2d",
      bindings: expect.arrayContaining([
        expect.objectContaining({ code: "KeyW" }),
      ]),
    });
    for (const input of inputs) await storage.remove(input.path);
    const reopened = new ProjectService(storage);
    await reopened.loadCurrentProject();
    expect(
      reopened
        .registry!.list()
        .filter((asset) =>
          ["InputAction", "InputAxis"].includes(asset.header.type),
        ),
    ).toEqual([]);
  });
});
