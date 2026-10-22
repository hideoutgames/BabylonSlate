import { describe, expect, it, vi } from "vitest";
import { createDefaultAnimGraph } from "@haptic/anim-graph";
import { createActor, createDefaultScene, type DocumentRef, type SerializedGraph } from "@haptic/core";
import type { ScriptBundleEntry } from "@haptic/bridge";
import { DocumentService } from "./document-service";
import { createPlayContentService } from "./play-content-service";
import type { ProjectService } from "./project-service";

/** A loaded document, as read back from its JSON file. */
function fromDisk<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function logGraph(message: string): SerializedGraph {
  return {
    nodes: [
      { id: "tick", type: "flow.event.tick", position: { x: 0, y: 0 }, data: {} },
      { id: "log", type: "debug.log", position: { x: 200, y: 0 }, data: { message } },
    ],
    edges: [{ id: "e1", source: "tick", target: "log", sourceHandle: "execOut", targetHandle: "execIn" }],
  };
}

type Asset = { guid: string; type: string; name: string; path: string; content: unknown; header?: Record<string, unknown> };

/** A project with the given saved assets and an editor that can open them in tabs. */
function createPlayContent(assets: readonly Asset[], readAssetChunk: (path: string, chunkId: string) => Promise<Uint8Array | null> = async () => null) {
  const documents = new DocumentService();
  const files = new Map(assets.map((asset) => [asset.path, asset.content]));
  const indexed = assets.map((asset) => ({
    path: asset.path,
    header: { guid: asset.guid, type: asset.type, name: asset.name, payload: asset.header ?? {} },
  }));
  const project = {
    guid: "project-guid",
    plugins: [],
    registry: { generation: 0, list: () => indexed, getRoot: () => undefined },
    loadDocument: vi.fn(async (_kind: string, path: string) => fromDisk(files.get(path))),
    guidForPath: (path: string) => assets.find((asset) => asset.path === path)?.guid ?? null,
  } as unknown as ProjectService;
  const compiled: Array<{ signature: string; bundles: ScriptBundleEntry[] }> = [];
  const playContent = createPlayContentService({
    documents,
    project,
    readAssetChunk,
    projectDocument: () => null,
    onPreviewScriptsCompiled: (signature, bundles) => compiled.push({ signature, bundles }),
  });
  const open = (ref: DocumentRef) => documents.openDocument(project, ref, null, true);
  return { documents, project, playContent, compiled, open };
}

describe("createPlayContentService", () => {
  it("records a whole-project compile under the open graphs' signature until a Class changes", async () => {
    const { documents, playContent, compiled, open } = createPlayContent([
      { guid: "hero", type: "Class", name: "Hero", path: "Hero.hasset", content: logGraph("saved") },
    ]);
    const id = await open({ kind: "graph", path: "Hero.hasset", label: "Hero" });

    await playContent.collectPlayPreviewScripts(new Set(["hero"]));
    expect(compiled).toEqual([]);

    const { bundles } = await playContent.collectPlayPreviewScripts();
    expect(bundles.map((bundle) => bundle.classId)).toContain("Hero");
    expect(compiled).toEqual([{ signature: playContent.graphSignature(undefined), bundles }]);

    documents.updateGraph(id, logGraph("edited"));
    expect(playContent.graphSignature(undefined)).not.toBe(compiled[0]!.signature);
  });

  it("makes the compiled signature stale when an open Animation Graph's compiled graph changes", async () => {
    const graph = createDefaultAnimGraph();
    const { documents, playContent, open } = createPlayContent([
      { guid: "locomotion", type: "AnimationGraph", name: "Locomotion", path: "Locomotion.hasset", content: graph },
    ]);
    const id = await open({ kind: "anim-graph", path: "Locomotion.hasset", label: "Locomotion" });
    const compiledSignature = playContent.compileOpenGraphs(undefined);
    expect(playContent.graphSignature(undefined)).toBe(compiledSignature);

    documents.updateAssetDocument(id, {
      ...graph,
      animationObject: { ...graph.animationObject, nodes: [...graph.animationObject.nodes, ...logGraph("tick").nodes] },
    });
    expect(playContent.graphSignature(undefined)).not.toBe(compiledSignature);
  });

  it("fails a Play compile on an unreadable required Class and skips it in a whole-project compile", async () => {
    const { project, playContent } = createPlayContent([
      { guid: "hero", type: "Class", name: "Hero", path: "Hero.hasset", content: logGraph("saved") },
    ]);
    vi.mocked(project.loadDocument).mockRejectedValue(new Error("disk read failed"));

    await expect(playContent.collectPlayPreviewScripts(new Set(["hero"]))).rejects.toThrow(
      "Could not load Class Hero.hasset: disk read failed",
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(playContent.collectPlayPreviewScripts()).resolves.toMatchObject({ bundles: [] });
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it("collects only requested Play assets and prefers an unsaved open tab over the saved file", async () => {
    const { documents, project, playContent, open } = createPlayContent([
      { guid: "lake", type: "Water", name: "Lake", path: "Lake.hasset", content: { opacity: 0.25 } },
      { guid: "sea", type: "Water", name: "Sea", path: "Sea.hasset", content: { opacity: 0.5 } },
    ]);
    const id = await open({ kind: "water", path: "Lake.hasset", label: "Lake" });
    documents.updateAssetDocument(id, { opacity: 0.75 });
    vi.mocked(project.loadDocument).mockClear();

    const waters = await playContent.collectPlayWaterContent(new Set(["lake"]));

    expect([...waters.keys()]).toEqual(["lake"]);
    expect(waters.get("lake")?.opacity).toBe(0.75);
    expect(project.loadDocument).not.toHaveBeenCalled();
  });

  it("collects viewport Font fallbacks and families from an unsaved open tab, as Play does", async () => {
    const saved = { family: "Saved Title", fallbackGuids: [] };
    const { documents, playContent, open } = createPlayContent([
      { guid: "title", type: "Font", name: "Title", path: "Title.hasset", content: saved, header: saved },
      { guid: "symbols", type: "Font", name: "Symbols", path: "Symbols.hasset", content: {}, header: { family: "Symbols" } },
    ], async () => new Uint8Array([1]));
    const id = await open({ kind: "font", path: "Title.hasset", label: "Title" });
    documents.updateAssetDocument(id, { family: "Edited Title", fallbackGuids: ["symbols"] });
    const scene = { ...createDefaultScene(), actors: [createActor("label", "Label", {
      components: [{ id: "text", classId: "Text3DComponent", properties: { fontAssetGuid: "title" } }],
    })] };

    expect([...(await playContent.collectPlayFontFacetypeBytes(scene)).keys()]).toEqual(["title", "symbols"]);
    expect(playContent.collectPlayFontCssStacks().fontCssStackByGuid.get("title")).toContain("Edited Title");
  });
});
