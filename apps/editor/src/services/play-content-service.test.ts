import { describe, expect, it, vi } from "vitest";
import type { DocumentRef, SerializedGraph } from "@babylonslate/core";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
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

type Asset = { guid: string; type: string; name: string; path: string; content: unknown };

/** A project with the given saved assets and an editor that can open them in tabs. */
function createPlayContent(assets: readonly Asset[]) {
  const documents = new DocumentService();
  const files = new Map(assets.map((asset) => [asset.path, asset.content]));
  const indexed = assets.map((asset) => ({
    path: asset.path,
    header: { guid: asset.guid, type: asset.type, name: asset.name, payload: {} },
  }));
  const project = {
    guid: "project-guid",
    plugins: [],
    registry: { list: () => indexed, getRoot: () => undefined },
    loadDocument: vi.fn(async (_kind: string, path: string) => fromDisk(files.get(path))),
    guidForPath: (path: string) => assets.find((asset) => asset.path === path)?.guid ?? null,
  } as unknown as ProjectService;
  const compiled: Array<{ signature: string; bundles: ScriptBundleEntry[] }> = [];
  const playContent = createPlayContentService({
    documents,
    project,
    readAssetChunk: async () => null,
    projectDocument: () => null,
    onPreviewScriptsCompiled: (signature, bundles) => compiled.push({ signature, bundles }),
  });
  const open = (ref: DocumentRef) => documents.openDocument(project, ref, null, true);
  return { documents, project, playContent, compiled, open };
}

describe("createPlayContentService", () => {
  it("records a whole-project compile under the open graphs' signature until a Class changes", async () => {
    const { documents, playContent, compiled, open } = createPlayContent([
      { guid: "hero", type: "Class", name: "Hero", path: "Hero.babasset", content: logGraph("saved") },
    ]);
    const id = await open({ kind: "graph", path: "Hero.babasset", label: "Hero" });

    await playContent.collectPlayPreviewScripts(new Set(["hero"]));
    expect(compiled).toEqual([]);

    const { bundles } = await playContent.collectPlayPreviewScripts();
    expect(bundles.map((bundle) => bundle.classId)).toContain("Hero");
    expect(compiled).toEqual([{ signature: playContent.graphSignature(undefined), bundles }]);

    documents.updateGraph(id, logGraph("edited"));
    expect(playContent.graphSignature(undefined)).not.toBe(compiled[0]!.signature);
  });

  it("collects only requested Play assets and prefers an unsaved open tab over the saved file", async () => {
    const { documents, project, playContent, open } = createPlayContent([
      { guid: "lake", type: "Water", name: "Lake", path: "Lake.babasset", content: { opacity: 0.25 } },
      { guid: "sea", type: "Water", name: "Sea", path: "Sea.babasset", content: { opacity: 0.5 } },
    ]);
    const id = await open({ kind: "water", path: "Lake.babasset", label: "Lake" });
    documents.updateAssetDocument(id, { opacity: 0.75 });
    vi.mocked(project.loadDocument).mockClear();

    const waters = await playContent.collectPlayWaterContent(new Set(["lake"]));

    expect([...waters.keys()]).toEqual(["lake"]);
    expect(waters.get("lake")?.opacity).toBe(0.75);
    expect(project.loadDocument).not.toHaveBeenCalled();
  });
});
