import { describe, expect, it } from "vitest";
import {
  createDefaultScene,
  MAIN_GRAPH_FILE,
  MAIN_SCENE_FILE,
  PROJECT_FILE,
  type SerializedScene,
} from "@babylonslate/core";
import {
  decodeBabasset,
  encodeBabasset,
  readAssetDocumentHeader,
} from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { ProjectService } from "./project-service";
import { createDefaultLogicGraphSerialized } from "./graph-validation";

async function scaffolded() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Assets.babproject");
  const service = new ProjectService(storage);
  const loaded = await service.loadCurrentProject();
  return { storage, service, loaded };
}

describe("project documents as .babasset", () => {
  it("scaffolds scene and graph assets under assets/", async () => {
    const { storage, loaded } = await scaffolded();
    expect(loaded.document.scenes).toEqual([MAIN_SCENE_FILE]);
    expect(await storage.exists(MAIN_SCENE_FILE)).toBe(true);
    expect(await storage.exists(MAIN_GRAPH_FILE)).toBe(true);
    expect(await storage.exists("assets/.blobs")).toBe(true);
    expect(await storage.exists(PROJECT_FILE)).toBe(true);
  });

  it("writes headers the registry can read without decoding payloads", async () => {
    const { storage } = await scaffolded();
    const header = readAssetDocumentHeader(
      await storage.readBinary(MAIN_SCENE_FILE),
    );
    expect(header.type).toBe("Scene");
    expect(header.version).toBe(2);
    expect(header.guid).toBeTruthy();
    expect(header.chunks[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips scene and graph content through the codec", async () => {
    const { service } = await scaffolded();
    const scene = await service.loadDocument("scene", MAIN_SCENE_FILE);
    const graph = await service.loadDocument("graph", MAIN_GRAPH_FILE);
    expect(scene).toEqual(createDefaultScene());
    expect(graph).toEqual(createDefaultLogicGraphSerialized());
  });

  it("keeps an asset guid stable across saves", async () => {
    const { storage, service } = await scaffolded();
    const before = readAssetDocumentHeader(
      await storage.readBinary(MAIN_SCENE_FILE),
    ).guid;

    const scene = (await service.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;
    await service.saveDocument("scene", MAIN_SCENE_FILE, {
      ...scene,
      name: "Renamed",
    });

    const after = readAssetDocumentHeader(
      await storage.readBinary(MAIN_SCENE_FILE),
    ).guid;
    expect(after).toBe(before);
    expect(
      ((await service.loadDocument("scene", MAIN_SCENE_FILE)) as SerializedScene)
        .name,
    ).toBe("Renamed");
  });

  it("still reads projects whose documents are legacy JSON", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Legacy.babproject");
    await storage.mkdir("scenes", true);
    await storage.writeText(
      "scenes/main.scene.json",
      JSON.stringify({ name: "Legacy", meshes: [], version: 1 }),
    );
    const service = new ProjectService(storage);

    const scene = (await service.loadDocument(
      "scene",
      "scenes/main.scene.json",
    )) as SerializedScene;
    expect(scene.name).toBe("Legacy");

    // The legacy payload is a schema version behind, so saving it back needs
    // the same explicit migrate-on-save approval as any other stale asset.
    service.approveMigrateOnSave();
    await service.saveDocument("scene", "scenes/main.scene.json", scene);
    expect(
      JSON.parse(await storage.readText("scenes/main.scene.json")).version,
    ).toBe(2);
  });

  it("rebuilds a search index that finds the default Cube actor", async () => {
    const { service } = await scaffolded();
    expect(service.searchIndex).toBeTruthy();
    const hits = service.searchIndex!.query("cube");
    expect(hits.some((hit) => hit.kind === "actor" && hit.label === "Cube")).toBe(
      true,
    );
  });

  it("updates search hits after saving a renamed actor", async () => {
    const { service } = await scaffolded();
    const scene = (await service.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;
    await service.saveDocument("scene", MAIN_SCENE_FILE, {
      ...scene,
      actors: scene.actors.map((actor) =>
        actor.id === "actor-1" ? { ...actor, name: "RenamedHero" } : actor,
      ),
    });
    expect(service.searchIndex!.query("cube")).toEqual([]);
    expect(
      service.searchIndex!.query("renamedhero").some((hit) => hit.kind === "actor"),
    ).toBe(true);
  });

  it("opens an imported Font (header payload, no document chunk) and keeps source bytes on save", async () => {
    const { storage, service } = await scaffolded();
    const source = new Uint8Array([10, 11, 12, 13]);
    const path = "assets/Ui.babasset";
    await storage.writeBinary(
      path,
      await encodeBabasset({
        header: {
          guid: "font-guid",
          type: "Font",
          name: "Ui",
          engineVersion: "0.0.0",
          version: 1,
          mode: "thin",
          dependencies: [],
          parentClass: null,
          payload: { family: "Ui", weight: 400, style: "normal" },
        },
        chunks: [
          { id: "source", kind: "font", mime: "font/woff2", data: source },
        ],
      }),
    );

    const payload = (await service.loadDocument("font", path)) as Record<
      string,
      unknown
    >;
    expect(payload.family).toBe("Ui");
    expect(await service.readAssetChunk(path, "source")).toEqual(source);

    await service.saveDocument("font", path, { ...payload, family: "Ui Display" });
    const saved = await decodeBabasset(await storage.readBinary(path));
    expect(saved.chunks.get("source")).toEqual(source);
    const reloaded = (await service.loadDocument("font", path)) as Record<
      string,
      unknown
    >;
    expect(reloaded.family).toBe("Ui Display");
  });
});
